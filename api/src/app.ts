import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { config } from './config/env.js';
import type { Queryable } from './db/client.js';
import {
    AppError,
    isPgCheckViolation,
    isPgForeignKeyViolation,
    isPgUniqueViolation,
} from './shared/errors.js';
import { requireAdmin, requireClient } from './auth/guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerExportRoutes } from './routes/export.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { createCardGateway, type CardGateway } from './services/gateway.js';

declare module 'fastify' {
    interface FastifyRequest {
        /** Cuerpo crudo tal como llego por el cable. Necesario para validar firmas. */
        rawBody?: string;
    }
}

export const API_PREFIX = '/api/v1';

export interface BuildAppOptions {
    db: Queryable;
    /** Se inyecta para poder sustituir la pasarela en pruebas. */
    gateway?: CardGateway;
    logger?: boolean;
    /** Fuerza el directorio del build del frontend (pruebas). */
    staticRoot?: string | null;
}

/**
 * Rutas que pertenecen a la API o a la documentacion y, por tanto, nunca deben
 * recibir el index.html del SPA. Devolver el portal en un 404 de la API
 * devolveria 200 HTML donde el cliente espera JSON.
 */
function isSpaRoute(url: string): boolean {
    const path = url.split('?')[0] ?? '';
    if (path.startsWith(`${config.web.apiPrefix}/`) || path === config.web.apiPrefix) return false;
    if (path === '/health' || path === '/docs' || path.startsWith('/docs/')) return false;
    // Un archivo con extension es un recurso real: si no existe, 404 de verdad.
    if (/\.[a-zA-Z0-9]{2,5}$/.test(path)) return false;
    return true;
}

/**
 * Monta el build del frontend, si existe.
 *
 * Devuelve la raiz montada o `null` para que el 404 siga siendo JSON. En
 * desarrollo el build no existe todavia y Vite hace ese trabajo.
 */
async function registerStatic(app: FastifyInstance, forcedRoot?: string | null): Promise<string | null> {
    if (forcedRoot === null) return null;
    if (!config.web.serveStatic) return null;

    /*
     * Se resuelve desde la UBICACION DEL MODULO, no desde process.cwd().
     *
     * npm ejecuta los scripts de un workspace con cwd = <workspace>. Con
     * `npm start -w api`, el proceso corre en `api/`, y `web/dist` relativo al
     * cwd apuntaria a `api/web/dist` (no existe). Resolviendo desde el propio
     * archivo funciona igual en desarrollo (src/) y en produccion (dist/),
     * sin depender de donde se invoque.
     */
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const root = forcedRoot
        ?? (isAbsolute(config.web.distPath)
            ? config.web.distPath
            : resolve(moduleDir, '..', '..', config.web.distPath));

    if (!existsSync(join(root, 'index.html'))) {
        // No es un error: en desarrollo el frontend lo sirve Vite.
        app.log.info(`No se encontro ${join(root, 'index.html')}; se sirve solo la API.`);
        return null;
    }

    await app.register(fastifyStatic, {
        root,
        index: ['index.html'],
        // list: false desactiva el listado de directorios.
        list: false,
        // Redirect de /ruta a /ruta/ en directorios.
        redirect: true,
        maxAge: 0,
        setHeaders(reply: FastifyReply, path: string) {
            // Los assets llevan hash en el nombre: se pueden cachear para
            // siempre. El HTML no, o un despliegue nuevo quedaria invisible
            // para quien tenga la pestana abierta.
            if (path.includes(`${sep}assets${sep}`)) {
                reply.header('Cache-Control', 'public, max-age=31536000, immutable');
            }
        },
    });

    app.log.info(`Frontend servido desde ${root}`);
    return root;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
    const { db } = options;
    const useLogger = options.logger ?? !config.isProduction;

    const app = Fastify({
        logger: useLogger
            ? { level: config.isProduction ? 'info' : 'debug' }
            : false,
        // Limite defensivo: ni el portal ni el panel necesitan cuerpos grandes.
        // El comprobante de pago se sube por un canal aparte.
        bodyLimit: 256 * 1024,
        trustProxy: true,
        genReqId: () => randomUUID(),
    });

    // -------------------------------------------------------------------------
    // Plugins
    // -------------------------------------------------------------------------
    await app.register(cookie);

    await app.register(cors, {
        origin: (origin, cb) => {
            // Sin cabecera Origin no hay peticion cross-origin: es el caso del
            // propio portal servido desde este proceso, de curl y de
            // server-to-server. Se permite.
            if (!origin) return cb(null, true);

            // Lista vacia = despliegue de un solo origen (API + portal en el
            // mismo dominio). Se rechaza todo lo cross-origin, que es lo
            // correcto: no hace falta permitir nada.
            if (config.corsOrigins.length === 0) return cb(null, false);

            cb(null, config.corsOrigins.includes(origin));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    });

    await app.register(helmet, {
        // La API no sirve HTML propio: una CSP restrictiva solo complica las
        // descargas de reportes.
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
    });

    await app.register(rateLimit, {
        // Limite global laxo por IP; los endpoints sensibles llevan el suyo.
        global: false,
        max: 300,
        timeWindow: '1 minute',
    });

    await app.register(jwt, {
        secret: config.auth.accessSecret,
        // La extraccion por defecto ya es "Authorization: Bearer <token>".
        sign: { expiresIn: config.auth.accessTtl },
    });

    await app.register(swagger, {
        openapi: {
            info: {
                title: 'API de Cobranza',
                description:
                    'API REST de gestion de cobranza y portal de clientes. Dos superficies ' +
                    'separadas: /portal (clientes) y /admin (personal). Cada una exige su ' +
                    'propio tipo de token; un token de cliente no sirve para la API admin.',
                version: '1.0.0',
            },
            servers: [{ url: API_PREFIX }],
            tags: [
                { name: 'Portal', description: 'Portal del cliente' },
                { name: 'Portal - Autenticacion', description: 'Acceso del cliente' },
                { name: 'Admin', description: 'Panel administrativo' },
                { name: 'Admin - Clientes' },
                { name: 'Admin - Planes' },
                { name: 'Admin - Pagos' },
                { name: 'Admin - Reportes' },
                { name: 'Admin - Autenticacion' },
                { name: 'Admin - Usuarios' },
                { name: 'Webhooks' },
            ],
            components: {
                securitySchemes: {
                    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                },
            },
        },
    });

    await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });

    /**
     * Se guarda el cuerpo CRUDO antes de parsearlo.
     *
     * Es obligatorio para el webhook: la firma se calcula sobre los bytes
     * exactos que envio la pasarela. Reconstruir el JSON a partir del objeto ya
     * parseado cambiaria el orden de las claves y la firma no coincidiria.
     */
    app.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (request, payload: string, done) => {
            request.rawBody = payload;
            try {
                done(null, payload === '' ? {} : JSON.parse(payload));
            } catch (error) {
                const err = error as Error & { statusCode?: number };
                err.statusCode = 400;
                done(err, undefined);
            }
        }
    );

    // -------------------------------------------------------------------------
    // Errores: un unico formato para toda la API
    // -------------------------------------------------------------------------
    app.setErrorHandler((error: FastifyError, request, reply) => {
        if (error instanceof AppError) {
            return reply.code(error.statusCode).send({
                error: {
                    code: error.code,
                    message: error.message,
                    ...(error.details !== undefined ? { details: error.details } : {}),
                },
            });
        }

        // Errores de validacion de Fastify (JSON Schema de body/querystring).
        if (error.validation) {
            return reply.code(400).send({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'La peticion no es valida.',
                    details: error.validation.map((issue) => ({
                        field: issue.instancePath.replace(/^\//, ''),
                        problem: issue.message,
                    })),
                },
            });
        }

        if (isPgUniqueViolation(error)) {
            return reply.code(409).send({
                error: {
                    code: 'CONFLICT',
                    message: 'El registro ya existe.',
                    details: { constraint: error.constraint },
                },
            });
        }
        if (isPgCheckViolation(error)) {
            return reply.code(400).send({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Los datos no cumplen las reglas del negocio.',
                    details: { constraint: error.constraint },
                },
            });
        }
        if (isPgForeignKeyViolation(error)) {
            return reply.code(400).send({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'La referencia indicada no existe.',
                },
            });
        }

        const status = error.statusCode ?? 500;
        if (status === 401) {
            return reply.code(401).send({
                error: { code: 'UNAUTHORIZED', message: 'Credencial ausente o invalida.' },
            });
        }
        if (status === 429) {
            return reply.code(429).send({
                error: {
                    code: 'RATE_LIMITED',
                    message: 'Demasiadas peticiones. Intenta de nuevo en unos instantes.',
                },
            });
        }

        // Cualquier otra cosa es un fallo nuestro: se registra entero y se
        // responde generico, sin filtrar detalle interno al cliente.
        request.log.error({ err: error }, 'error no manejado');
        return reply.code(status >= 500 ? 500 : status).send({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Ocurrio un error inesperado. Intenta de nuevo.',
            },
        });
    });

    app.setNotFoundHandler((request, reply) => {
        // Si el frontend se sirve desde este mismo proceso, cualquier ruta que
        // no sea de la API debe devolver el index.html del SPA. Sin esto,
        // recargar en /admin/prospectos daria 404: el enrutado del lado del
        // cliente nunca llega al servidor.
        if (staticRoot && isSpaRoute(request.url)) {
            return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
        }

        return reply.code(404).send({
            error: {
                code: 'NOT_FOUND',
                message: `Ruta no encontrada: ${request.method} ${request.url}`,
            },
        });
    });

    // -------------------------------------------------------------------------
    // Frontend (opcional)
    //    En desarrollo Vite sirve el portal y hace de proxy hacia aqui; en
    //    produccion este proceso sirve tambien el build.
    // -------------------------------------------------------------------------
    const staticRoot = await registerStatic(app, options.staticRoot);

    // -------------------------------------------------------------------------
    // Salud
    // -------------------------------------------------------------------------
    app.get('/health', { schema: { summary: 'Estado del servicio' } }, async (_request, reply) => {
        try {
            const started = await db.query('SELECT now() AS now');
            return {
                status: 'ok',
                database: 'up',
                service: config.deploy.serviceName || 'cobranza',
                serverTime: started.rows[0]?.now,
            };
        } catch {
            return reply.code(503).send({
                status: 'degraded',
                database: 'down',
                timestamp: new Date().toISOString(),
            });
        }
    });

    // -------------------------------------------------------------------------
    // Rutas, todas bajo /api/v1
    // -------------------------------------------------------------------------
    const gateway = options.gateway ?? createCardGateway();

    await app.register(
        async (api) => {
            await registerAuthRoutes(api, {
                db,
                requireClient: requireClient(db),
                currentAdminRole: async (adminId) => {
                    const result = await db.query<{ role: string }>(
                        'SELECT role FROM admin_users WHERE id = $1', [adminId]
                    );
                    return result.rows[0]?.role;
                },
            });

            await registerPortalRoutes(api, {
                db,
                requireClient: requireClient(db),
                createCardSession: (input) => gateway.createCardSession(input),
            });

            await registerAdminRoutes(api, { db, requireAdmin: requireAdmin(db) });
            await registerExportRoutes(api, { db, requireAdmin: requireAdmin(db) });

            await registerWebhookRoutes(api, {
                db,
                // La pasarela manda el folio del cliente. Sin referencia el
                // evento esta mal formado y no se puede imputar el dinero.
                resolveClientId: async (body) => {
                    const data = body.data ?? {};
                    const folio = data.clientFolio ?? data.reference;
                    if (!folio) return null;
                    const result = await db.query<{ id: string }>(
                        'SELECT id FROM clients WHERE folio = $1 AND deleted_at IS NULL',
                        [String(folio).toUpperCase()]
                    );
                    return result.rows[0] ? Number(result.rows[0].id) : null;
                },
            });
        },
        { prefix: API_PREFIX }
    );

    return app;
}
