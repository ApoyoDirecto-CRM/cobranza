import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import type { Queryable } from '../db/client.js';
import { AppError, badRequest, unauthorized } from '../shared/errors.js';
import {
    normalizePhone,
    validateIdentity,
    verifyIdentity,
    ValidationError,
} from '../shared/identity.js';
import { normalizePortalView } from '../shared/portalView.js';
import {
    generateRefreshToken,
    persistRefreshToken,
    revokeRefreshToken,
    rotateRefreshToken,
    signAccessToken,
} from '../auth/tokens.js';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

/**
 * AVISO DE SEGURIDAD (leer antes de desplegar)
 *
 * El acceso del portal es (telefono + CURP/DNI). Eso no es autenticacion
 * criptografica: es una declaracion de identidad que el sistema acepta porque
 * el titular ya le es conocido a la institucion que le concedio el credito.
 *
 * Riesgo asumido: quien conozca el par puede ver saldos y registrar pagos.
 * Se asume que ese par no es publico y que el contacto se verifico al ubicar.
 *
 * Mitigaciones implementadas aqui:
 *   - Rate limit por IP sobre /auth/login.
 *   - Bloqueo temporal del telefono tras N fallos.
 *   - Comparacion del documento en tiempo constante.
 *   - Mensaje de error identico exista o no el telefono: no se filtra que
 *     numeros estan registrados ni que documento tienen.
 *
 * Upgrade recomendado: sustituir este paso por un OTP por SMS/WhatsApp. El
 * resto del flujo (tokens, sesiones, portal) no cambia; solo este endpoint.
 */

const REFRESH_COOKIE = 'cobranza_rt';

export interface AuthDeps {
    db: Queryable;
    requireClient: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    currentAdminRole: (adminId: number) => Promise<string | undefined>;
}

function requestMeta(request: FastifyRequest): { userAgent?: string; ip: string } {
    const ua = request.headers['user-agent'];
    return { userAgent: typeof ua === 'string' ? ua : undefined, ip: request.ip };
}

/**
 * Registra el intento fallido y devuelve cuantos lleva en la ventana actual.
 * Inserta primero y cuenta despues para que el bloqueo caiga exactamente en el
 * N-esimo fallo y no uno despues.
 */
async function countRecentFailures(db: Queryable, phone: string): Promise<number> {
    // Solo cuentan los fallos posteriores al ultimo login correcto: un acceso
    // exitoso reinicia el contador. Sin esto, un usuario que entra y sale
    // varias veces se autobloqueaba.
    const result = await db.query<{ failed: number }>(
        `SELECT COUNT(*)::int AS failed
           FROM login_attempts
          WHERE subject_type = 'client' AND phone = $1 AND success = FALSE
            AND created_at > now() - ($2 || ' minutes')::interval
            AND created_at > COALESCE((
                SELECT MAX(created_at) FROM login_attempts
                 WHERE subject_type = 'client' AND phone = $1 AND success = TRUE
            ), 'epoch'::timestamptz)`,
        [phone, String(config.auth.portalLockoutMinutes)]
    );
    return result.rows[0]?.failed ?? 0;
}

async function recordFailure(
    db: Queryable,
    phone: string,
    ip: string,
    reason: string
): Promise<void> {
    await db.query(
        `INSERT INTO login_attempts (subject_type, phone, ip_address, success, failure_reason)
         VALUES ('client', $1, $2, FALSE, $3)`,
        [phone, ip, reason]
    );
}

function readRefreshToken(request: FastifyRequest): string | null {
    const body = request.body as { refreshToken?: string } | undefined;
    if (body?.refreshToken) return body.refreshToken;
    const cookie = request.cookies?.[REFRESH_COOKIE];
    return cookie ? String(cookie) : null;
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(REFRESH_COOKIE, token, {
        path: '/api/v1',
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: config.auth.refreshTtlDays * 24 * 60 * 60,
    });
}

function clearRefreshCookie(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1' });
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
    const { db, requireClient, currentAdminRole } = deps;

    // -------------------------------------------------------------------------
    // POST /api/v1/auth/login  -  Portal del cliente
    // -------------------------------------------------------------------------
    app.post<{ Body: { phone: string; identityId: string } }>(
        '/auth/login',
        {
            config: {
                rateLimit: { max: config.auth.portalLoginRateLimit, timeWindow: '1 minute' },
            },
            schema: {
                tags: ['Portal - Autenticacion'],
                summary: 'Acceso del cliente con telefono y CURP/DNI',
                description:
                    `Bloquea el telefono tras ${config.auth.portalMaxFailedAttempts} intentos ` +
                    `fallidos en ${config.auth.portalLockoutMinutes} minutos.`,
                body: {
                    type: 'object',
                    required: ['phone', 'identityId'],
                    properties: {
                        phone: {
                            type: 'string', minLength: 10, maxLength: 20,
                            examples: ['5512345678'],
                            description: '10 digitos. Acepta +52, espacios y guiones.',
                        },
                        identityId: {
                            type: 'string', minLength: 13, maxLength: 18,
                            examples: ['GODE561231GRERRN09'],
                            description: 'CURP de 18 caracteres o DNI de 13 digitos.',
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { phone: rawPhone, identityId: rawIdentity } = request.body;

            let phone: string;
            let identity: { type: 'curp' | 'dni'; value: string };
            try {
                phone = normalizePhone(rawPhone);
                identity = validateIdentity(rawIdentity);
            } catch (error) {
                if (error instanceof ValidationError) {
                    throw badRequest(error.message, { field: error.field });
                }
                throw error;
            }

            // El bloqueo se comprueba ANTES de verificar, pero no se registra
            // un fallo por intentar: solo cuenta una credencial incorrecta.
            const recentFailures = await countRecentFailures(db, phone);
            if (recentFailures >= config.auth.portalMaxFailedAttempts) {
                throw new AppError(
                    'ACCOUNT_LOCKED',
                    `Demasiados intentos fallidos. Intenta de nuevo en ${config.auth.portalLockoutMinutes} minutos.`
                );
            }

            const found = await db.query<{
                id: string; folio: string; full_name: string;
                identity_hash: string; identity_masked: string; portal_view: unknown;
            }>(
                `SELECT id, folio, full_name, identity_hash, identity_masked, portal_view
                   FROM clients WHERE phone = $1 AND deleted_at IS NULL`,
                [phone]
            );
            const client = found.rows[0];

            if (!client || !(await verifyIdentity(identity.value, client.identity_hash))) {
                await recordFailure(db, phone, request.ip, 'credencial');
                throw unauthorized('Telefono o documento incorrecto');
            }

            const clientId = Number(client.id);

            if (!config.auth.otpEnabled) {
                // Sin OTP, el login ya es la autenticacion completa: aqui si se
                // registra el exito (y se reinicia el contador de fallos).
                await db.query(
                    `INSERT INTO login_attempts (subject_type, phone, ip_address, success)
                     VALUES ('client', $1, $2, TRUE)`,
                    [phone, request.ip]
                );
                const refreshToken = generateRefreshToken();
                await persistRefreshToken(db, 'client', clientId, refreshToken, requestMeta(request));
                setRefreshCookie(reply, refreshToken);
                return {
                    accessToken: signAccessToken(app, clientId, 'client'),
                    refreshToken,
                    expiresIn: config.auth.accessTtl,
                    tokenType: 'Bearer',
                    client: {
                        id: clientId,
                        folio: client.folio,
                        fullName: client.full_name,
                        view: normalizePortalView(client.portal_view),
                    },
                };
            }

            const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
            const codeHash = await bcrypt.hash(code, 10);
            const ttlSeconds = config.auth.otpTtlMinutes * 60;
            await db.query(
                `INSERT INTO otp_codes (client_id, code_hash, expires_at)
                 VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
                [clientId, codeHash, String(ttlSeconds)]
            );

            if (config.auth.otpProvider === 'twilio') {
                const { sendSms } = await import('../services/otp.js');
                await sendSms(phone, code);
            } else {
                // `app.log` se apaga en produccion (NODE_ENV=production), justo
                // donde corre Render. El proveedor `console` existe para poder
                // leer el OTP desde los logs del servicio, asi que se escribe
                // con la consola directa y no con el logger de Fastify.
                console.warn(`[OTP] codigo para ${phone}: ${code}`);
            }

            return {
                otpRequired: true,
                expiresIn: ttlSeconds,
            };
        }
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/auth/verify-otp
    // -------------------------------------------------------------------------
    app.post<{ Body: { phone: string; code: string } }>(
        '/auth/verify-otp',
        {
            config: {
                rateLimit: { max: config.auth.portalLoginRateLimit, timeWindow: '1 minute' },
            },
            schema: {
                tags: ['Portal - Autenticacion'],
                summary: 'Verifica el OTP y emite tokens',
                body: {
                    type: 'object',
                    required: ['phone', 'code'],
                    properties: {
                        phone: { type: 'string', minLength: 10, maxLength: 20 },
                        code: { type: 'string', minLength: 6, maxLength: 6 },
                    },
                },
            },
        },
        async (request, reply) => {
            const { phone: rawPhone, code } = request.body;

            let phone: string;
            try {
                phone = normalizePhone(rawPhone);
            } catch {
                throw badRequest('Telefono invalido', { field: 'phone' });
            }

            const recentFailures = await countRecentFailures(db, phone);
            if (recentFailures >= config.auth.portalMaxFailedAttempts) {
                throw new AppError(
                    'ACCOUNT_LOCKED',
                    `Demasiados intentos fallidos. Intenta de nuevo en ${config.auth.portalLockoutMinutes} minutos.`
                );
            }

            const found = await db.query<{ id: string; folio: string; full_name: string; portal_view: unknown }>(
                `SELECT id, folio, full_name, portal_view
                   FROM clients WHERE phone = $1 AND deleted_at IS NULL`,
                [phone]
            );
            const client = found.rows[0];
            if (!client) {
                await recordFailure(db, phone, request.ip, 'otp');
                throw unauthorized('Codigo incorrecto');
            }

            // El codigo se busca para ESE cliente: nunca "el ultimo OTP global".
            // Sin este filtro cualquier telefono validaria contra el OTP de otro.
            const row = await db.query<{ id: string; code_hash: string }>(
                `SELECT id, code_hash
                   FROM otp_codes
                  WHERE client_id = $1 AND consumed_at IS NULL AND expires_at > now()
                  ORDER BY created_at DESC LIMIT 1`,
                [client.id]
            );
            const record = row.rows[0];

            if (!record || !(await bcrypt.compare(code, record.code_hash))) {
                await recordFailure(db, phone, request.ip, 'otp');
                throw unauthorized('Codigo incorrecto');
            }

            await db.query(
                `UPDATE otp_codes SET consumed_at = now() WHERE id = $1`,
                [record.id]
            );

            // Exito tras completar el segundo factor: reinicia el contador.
            await db.query(
                `INSERT INTO login_attempts (subject_type, phone, ip_address, success)
                 VALUES ('client', $1, $2, TRUE)`,
                [phone, request.ip]
            );

            const clientId = Number(client.id);
            const refreshToken = generateRefreshToken();
            await persistRefreshToken(db, 'client', clientId, refreshToken, requestMeta(request));
            setRefreshCookie(reply, refreshToken);

            return {
                accessToken: signAccessToken(app, clientId, 'client'),
                refreshToken,
                expiresIn: config.auth.accessTtl,
                tokenType: 'Bearer',
                client: {
                    id: clientId,
                    folio: client.folio,
                    fullName: client.full_name,
                    view: normalizePortalView(client.portal_view),
                },
            };
        }
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/auth/refresh
    // -------------------------------------------------------------------------
    app.post<{ Body: { refreshToken?: string } }>(
        '/auth/refresh',
        {
            schema: {
                tags: ['Portal - Autenticacion'],
                summary: 'Renueva el access token rotando el refresh token',
                description:
                    'El refresh token es de un solo uso. Si llega uno ya rotado, ' +
                    'se revocan todas las sesiones del titular.',
            },
        },
        async (request, reply) => {
            const token = readRefreshToken(request);
            if (!token) throw unauthorized('Falta el refresh token');

            const rotated = await rotateRefreshToken(db, token, requestMeta(request));
            setRefreshCookie(reply, rotated.refreshToken);

            const role =
                rotated.subjectType === 'admin'
                    ? await currentAdminRole(rotated.subjectId)
                    : undefined;

            return {
                accessToken: signAccessToken(app, rotated.subjectId, rotated.subjectType, role),
                refreshToken: rotated.refreshToken,
                expiresIn: config.auth.accessTtl,
                tokenType: 'Bearer',
                subject: { type: rotated.subjectType, id: rotated.subjectId },
            };
        }
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/auth/logout
    // -------------------------------------------------------------------------
    app.post(
        '/auth/logout',
        { schema: { tags: ['Portal - Autenticacion'], summary: 'Cierra la sesion actual' } },
        async (request, reply) => {
            const token = readRefreshToken(request);
            if (token) await revokeRefreshToken(db, token);
            clearRefreshCookie(reply);
            return reply.code(204).send();
        }
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/auth/me
    // -------------------------------------------------------------------------
    app.get(
        '/auth/me',
        {
            preHandler: requireClient,
            schema: { tags: ['Portal - Autenticacion'], summary: 'Datos del cliente autenticado' },
        },
        async (request) => {
            const clientId = request.client!.id;
            const result = await db.query<{
                folio: string; full_name: string; phone: string; email: string | null;
            }>(
                `SELECT folio, full_name, phone, email FROM clients WHERE id = $1`,
                [clientId]
            );
            const row = result.rows[0];
            return {
                id: clientId,
                folio: row?.folio ?? '',
                fullName: row?.full_name ?? '',
                phone: row?.phone ?? '',
                email: row?.email ?? null,
                view: request.client!.view,
            };
        }
    );
}
