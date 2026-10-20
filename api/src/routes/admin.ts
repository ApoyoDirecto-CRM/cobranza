import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import type { Queryable } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { buildSchedule } from '../domain/schedule.js';
import { centsToNumeric, centsToNumber, formatCurrency, numericToCents, parseAmountToCents } from '../shared/money.js';
import { fingerprintIdentity, hashIdentity, maskIdentity, normalizeEmail, normalizePhone, normalizeReference, validateIdentity, ValidationError } from '../shared/identity.js';
import { applyPortalViewPatch, normalizePortalView, parsePortalViewPatch } from '../shared/portalView.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { isPgUniqueViolation } from '../shared/errors.js';
import { recordPayment, reversePayment, writeAudit, approvePayment, type PaymentMethod } from '../services/payments.js';
import { verifyAdminPassword, hashPassword } from '../auth/password.js';
import { generateRefreshToken, persistRefreshToken, signAccessToken } from '../auth/tokens.js';
import type { AdminRole } from '../auth/guards.js';

export interface AdminDeps {
    db: Queryable;
    requireAdmin: (minimum?: AdminRole) =>
        (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const money = (cents: number) => ({
    amount: centsToNumber(cents),
    formatted: formatCurrency(cents),
});

/** Traduce los errores de validacion de la capa de normalizacion. */
function rethrowValidation(error: unknown): never {
    if (error instanceof ValidationError) {
        throw badRequest(error.message, { field: error.field });
    }
    throw error;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
    const { db, requireAdmin } = deps;

    // =========================================================================
    // Autenticacion del panel administrativo
    // =========================================================================
    app.post<{ Body: { email: string; password: string } }>(
        '/admin/auth/login',
        {
            config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
            schema: {
                tags: ['Admin - Autenticacion'],
                summary: 'Acceso del personal administrativo',
                body: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email' },
                        password: { type: 'string', minLength: 1, maxLength: 200 },
                    },
                },
            },
        },
        async (request) => {
            const { email, password } = request.body;
            const normalizedEmail = String(email).trim().toLowerCase();

            const result = await db.query<{
                id: string; email: string; password_hash: string; role: AdminRole;
                status: string; locked_until: string | null; full_name: string;
            }>(
                `SELECT id, email, password_hash, role, status, locked_until, full_name
                   FROM admin_users WHERE email = $1`,
                [normalizedEmail]
            );
            const admin = result.rows[0];

            // Mismo mensaje exista o no el usuario: no enumeramos cuentas.
            const invalid = () => {
                throw badRequest('Correo o contrasena incorrectos');
            };

            if (!admin) {
                // Se ejecuta un hash mas para que el tiempo de respuesta no
                // distinga "usuario inexistente" de "contrasena incorrecta".
                await verifyAdminPassword(db, 0, password, 'scrypt$65536$8$1$AAAA$AAAA');
                throw badRequest('Correo o contrasena incorrectos');
            }

            if (admin.locked_until && new Date(admin.locked_until).getTime() > Date.now()) {
                throw forbidden(
                    `Cuenta bloqueada temporalmente. Intenta de nuevo despues de ` +
                    `${admin.locked_until}.`
                );
            }
            if (admin.status !== 'activo') {
                throw forbidden('Tu usuario esta suspendido. Contacta al administrador.');
            }

            const valid = await verifyAdminPassword(
                db, Number(admin.id), password, admin.password_hash
            );
            if (!valid) {
                await db.query(
                    `UPDATE admin_users
                        SET failed_attempts = failed_attempts + 1,
                            locked_until = CASE WHEN failed_attempts + 1 >= 5
                                                THEN now() + interval '15 minutes'
                                                ELSE locked_until END
                      WHERE id = $1`,
                    [admin.id]
                );
                await db.query(
                    `INSERT INTO login_attempts (subject_type, ip_address, success, failure_reason)
                     VALUES ('admin', $1, FALSE, 'credencial')`,
                    [request.ip]
                );
                invalid();
            }

            await db.query(
                `UPDATE admin_users
                    SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
                  WHERE id = $1`,
                [admin.id]
            );

            const adminId = Number(admin.id);
            const refreshToken = generateRefreshToken();
            await persistRefreshToken(db, 'admin', adminId, refreshToken, {
                userAgent: request.headers['user-agent'] as string | undefined,
                ip: request.ip,
            });

            return {
                accessToken: signAccessToken(app, adminId, 'admin', admin.role),
                refreshToken,
                expiresIn: config.auth.accessTtl,
                tokenType: 'Bearer',
                admin: { id: adminId, email: admin.email, fullName: admin.full_name, role: admin.role },
            };
        }
    );

    // =========================================================================
    // Dashboard
    // =========================================================================
    app.get(
        '/admin/dashboard',
        {
            preHandler: requireAdmin('lectura'),
            schema: { tags: ['Admin'], summary: 'Indicadores de la cartera' },
        },
        async () => {
            const totals = await db.query<{
                clients: number; active_clients: number;
                financed: string; collected: string; pending: string; overdue: string;
            }>(
                `SELECT COUNT(*)::int AS clients,
                        COUNT(*) FILTER (WHERE status = 'activo')::int AS active_clients,
                        COALESCE(SUM(financed_amount),0) AS financed,
                        COALESCE(SUM(paid_amount),0) AS collected,
                        COALESCE(SUM(pending_amount),0) AS pending,
                        COALESCE(SUM(overdue_amount),0) AS overdue
                   FROM v_client_portfolio`
            );
            const t = totals.rows[0];

            // Envejecimiento de la cartera vencida: clave para priorizar gestion.
            const aging = await db.query<{ bucket: string; amount: string; clients: number }>(
                `SELECT bucket,
                        COALESCE(SUM(amount),0) AS amount,
                        COUNT(*)::int AS clients
                   FROM (
                        SELECT c.id,
                            CASE
                                WHEN CURRENT_DATE - i.due_date <= 30 THEN '1-30'
                                WHEN CURRENT_DATE - i.due_date <= 60 THEN '31-60'
                                WHEN CURRENT_DATE - i.due_date <= 90 THEN '61-90'
                                ELSE '90+'
                            END AS bucket,
                            i.amount AS amount
                          FROM installments i
                          JOIN plans p ON p.id = i.plan_id
                          JOIN clients c ON c.id = p.client_id
                         WHERE i.status = 'pendiente'
                           AND i.due_date < CURRENT_DATE
                           AND p.status = 'activo'
                           AND c.deleted_at IS NULL
                   ) aged
                  GROUP BY bucket
                  ORDER BY bucket`
            );

            const todayPayments = await db.query<{ count: number; amount: string }>(
                `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS amount
                   FROM payments
                  WHERE status = 'aprobado' AND paid_at = CURRENT_DATE AND deleted_at IS NULL`
            );

            const pendingReconcile = await db.query<{ count: number }>(
                `SELECT COUNT(*)::int AS count FROM payments
                  WHERE status = 'pendiente' AND deleted_at IS NULL`
            );

            return {
                totals: {
                    clients: t?.clients ?? 0,
                    activeClients: t?.active_clients ?? 0,
                    financed: money(numericToCents(t?.financed)),
                    collected: money(numericToCents(t?.collected)),
                    pending: money(numericToCents(t?.pending)),
                    overdue: money(numericToCents(t?.overdue)),
                },
                today: {
                    payments: todayPayments.rows[0]?.count ?? 0,
                    amount: money(numericToCents(todayPayments.rows[0]?.amount)),
                },
                pendingReconcile: pendingReconcile.rows[0]?.count ?? 0,
                aging: aging.rows.map((row) => ({
                    bucket: row.bucket,
                    amount: money(numericToCents(row.amount)),
                    clients: row.clients,
                })),
            };
        }
    );

    // =========================================================================
    // Clientes
    // =========================================================================

    app.get<{ Querystring: { q?: string; status?: string; limit?: number; offset?: number } }>(
        '/admin/clients',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Clientes'],
                summary: 'Lista clientes de la cartera',
                querystring: {
                    type: 'object',
                    properties: {
                        q: { type: 'string', description: 'Busqueda por nombre, folio o telefono' },
                        status: {
                            type: 'string',
                            enum: ['activo', 'suspendido', 'liquidado', 'baja', 'todos'],
                        },
                        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                        offset: { type: 'integer', minimum: 0, default: 0 },
                    },
                },
            },
        },
        async (request) => {
            const { q, status, limit = 50, offset = 0 } = request.query;
            const filters: string[] = [];
            const params: unknown[] = [];

            if (q) {
                params.push(`%${q.trim()}%`);
                filters.push(`(full_name ILIKE $${params.length} OR folio ILIKE $${params.length}
                               OR phone LIKE $${params.length})`);
            }
            if (status && status !== 'todos') {
                params.push(status);
                filters.push(`status = $${params.length}::client_status`);
            }

            const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
            params.push(limit, offset);

            const rows = await db.query<{
                client_id: string; folio: string; full_name: string; phone: string;
                status: string; active_plans: number; financed_amount: string;
                paid_amount: string; pending_amount: string; overdue_amount: string;
                max_days_overdue: number | null; next_due_date: string | null;
                last_paid_at: string | null; spei_clabe: string | null;
                portal_enabled: boolean; portal_view: unknown;
            }>(
                `SELECT client_id, folio, full_name, phone, status, active_plans,
                        financed_amount, paid_amount, pending_amount, overdue_amount,
                        max_days_overdue, next_due_date, last_paid_at, spei_clabe,
                        portal_enabled, portal_view
                   FROM v_client_portfolio
                   ${where}
                  ORDER BY overdue_amount DESC NULLS LAST, full_name
                  LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            );

            const countResult = await db.query<{ total: number }>(
                `SELECT COUNT(*)::int AS total FROM v_client_portfolio ${where}`,
                params.slice(0, params.length - 2)
            );

            return {
                items: rows.rows.map((row) => ({
                    id: Number(row.client_id),
                    folio: row.folio,
                    fullName: row.full_name,
                    phone: row.phone,
                    status: row.status,
                    speiClabe: row.spei_clabe,
                    activePlans: Number(row.active_plans),
                    financed: money(numericToCents(row.financed_amount)),
                    paid: money(numericToCents(row.paid_amount)),
                    pending: money(numericToCents(row.pending_amount)),
                    overdue: money(numericToCents(row.overdue_amount)),
                    maxDaysOverdue: row.max_days_overdue === null ? null : Number(row.max_days_overdue),
                    nextDueDate: row.next_due_date,
                    lastPaidAt: row.last_paid_at,
                    portalEnabled: row.portal_enabled,
                    portalView: normalizePortalView(row.portal_view),
                })),
                pagination: {
                    limit,
                    offset,
                    returned: rows.rows.length,
                    total: countResult.rows[0]?.total ?? 0,
                },
            };
        }
    );

    app.get<{ Params: { id: string } }>(
        '/admin/clients/:id',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Clientes'],
                summary: 'Ficha completa del cliente',
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'integer' } },
                },
            },
        },
        async (request) => {
            const id = Number(request.params.id);

            const client = await db.query<{
                id: string; folio: string; full_name: string; phone: string; phone_alt: string | null;
                email: string | null; identity_type: string; identity_masked: string;
                address_line: string | null; notes: string | null; status: string;
                portal_enabled: boolean; portal_view: unknown; registered_at: string;
                clabe: string | null; bank_name: string | null;
            }>(
                `SELECT c.id, c.folio, c.full_name, c.phone, c.phone_alt, c.email,
                        c.identity_type, c.identity_masked, c.address_line, c.notes, c.status,
                        c.portal_enabled, c.portal_view, c.registered_at, a.clabe, a.bank_name
                   FROM clients c
                   LEFT JOIN payment_accounts a ON a.id = c.payment_account_id
                  WHERE c.id = $1 AND c.deleted_at IS NULL`,
                [id]
            );
            const row = client.rows[0];
            if (!row) throw notFound('Cliente no encontrado');

            const plans = await db.query<Record<string, unknown>>(
                `SELECT * FROM v_plan_progress WHERE client_id = $1 ORDER BY start_date DESC`,
                [id]
            );

            const payments = await db.query<{
                id: string; folio: string; amount: string; method: string; status: string;
                concept: string | null; paid_at: string; approved_at: string | null;
            }>(
                `SELECT id, folio, amount, method, status, concept, paid_at, approved_at
                   FROM payments WHERE client_id = $1 AND deleted_at IS NULL
                  ORDER BY paid_at DESC LIMIT 50`,
                [id]
            );

            return {
                client: {
                    id: Number(row.id),
                    folio: row.folio,
                    fullName: row.full_name,
                    phone: row.phone,
                    phoneAlt: row.phone_alt,
                    email: row.email,
                    identityType: row.identity_type,
                    identityMasked: row.identity_masked,
                    address: row.address_line,
                    notes: row.notes,
                    status: row.status,
                    portalEnabled: row.portal_enabled,
                    portalView: normalizePortalView(row.portal_view),
                    registeredAt: row.registered_at,
                    speiClabe: row.clabe,
                    speiBank: row.bank_name,
                },
                plans: plans.rows.map((p) => ({
                    id: Number(p.plan_id as string),
                    reference: p.reference,
                    status: p.status,
                    frequency: p.frequency,
                    total: money(numericToCents(p.total_amount as string)),
                    installmentAmount: money(numericToCents(p.installment_amount as string)),
                    paid: money(numericToCents(p.paid_amount as string)),
                    pending: money(numericToCents(p.pending_amount as string)),
                    overdue: money(numericToCents(p.overdue_amount as string)),
                    percent: Number(p.paid_count as number) + Number(p.pending_count as number) > 0
                        ? Math.round(
                            (Number(p.paid_amount as string) / Number(p.total_amount as string)) * 1000
                        ) / 10
                        : 0,
                    installmentCount: Number(p.installment_count as number),
                    paidInstallments: Number(p.paid_count as number),
                    pendingInstallments: Number(p.pending_count as number),
                    overdueInstallments: Number(p.overdue_count as number),
                    startDate: p.start_date,
                    endDate: p.end_date,
                })),
                payments: payments.rows.map((p) => ({
                    id: Number(p.id),
                    folio: p.folio,
                    amount: money(numericToCents(p.amount)),
                    method: p.method,
                    status: p.status,
                    concept: p.concept,
                    paidAt: p.paid_at,
                    approvedAt: p.approved_at,
                })),
            };
        }
    );

    app.post<{
        Body: {
            fullName: string; phone: string; identityId: string; email?: string;
            phoneAlt?: string; address?: string; notes?: string; folio?: string;
            paymentAccountId?: number;
        };
    }>(
        '/admin/clients',
        {
            preHandler: requireAdmin('operador'),
            schema: {
                tags: ['Admin - Clientes'],
                summary: 'Alta de cliente',
                body: {
                    type: 'object',
                    required: ['fullName', 'phone', 'identityId'],
                    properties: {
                        fullName: { type: 'string', minLength: 3, maxLength: 120 },
                        phone: { type: 'string', minLength: 10, maxLength: 20 },
                        identityId: { type: 'string', minLength: 13, maxLength: 18 },
                        email: { type: 'string', maxLength: 120 },
                        phoneAlt: { type: 'string', minLength: 10, maxLength: 20 },
                        address: { type: 'string', maxLength: 300 },
                        notes: { type: 'string', maxLength: 2000 },
                        folio: { type: 'string', maxLength: 40 },
                        paymentAccountId: { type: 'integer' },
                    },
                },
            },
        },
        async (request, reply) => {
            const body = request.body;
            const adminId = request.admin!.id;

            let phone: string;
            let identity: { type: 'curp' | 'dni'; value: string };
            let email: string | null = null;
            let phoneAlt: string | null = null;
            try {
                phone = normalizePhone(body.phone);
                identity = validateIdentity(body.identityId);
                if (body.email) email = normalizeEmail(body.email);
                if (body.phoneAlt) phoneAlt = normalizePhone(body.phoneAlt);
            } catch (error) {
                rethrowValidation(error);
            }

            try {
                const identityHash = await hashIdentity(identity.value);
                const created = await db.query<{ id: string; folio: string }>(
                    `INSERT INTO clients
                       (folio, full_name, phone, phone_alt, email, identity_type,
                        identity_hash, identity_masked, identity_fingerprint,
                        address_line, notes, payment_account_id)
                     VALUES ($1,$2,$3,$4,$5,$6::identity_type,$7,$8,$9,$10,$11,$12)
                     RETURNING id, folio`,
                    [
                        body.folio?.trim() || `CLI-${Date.now().toString(36).toUpperCase()}`,
                        body.fullName.trim(),
                        phone,
                        phoneAlt,
                        email,
                        identity.type,
                        identityHash,
                        maskIdentity(identity.value),
                        fingerprintIdentity(identity.value),
                        body.address?.trim() ?? null,
                        body.notes?.trim() ?? null,
                        body.paymentAccountId ?? null,
                    ]
                );
                const row = created.rows[0]!;

                await writeAudit(db, {
                    actorId: adminId,
                    action: 'client.create',
                    entityType: 'client',
                    entityId: row.folio,
                    after: { fullName: body.fullName, phone },
                    ip: request.ip,
                });

                return reply.code(201).send({ id: Number(row.id), folio: row.folio });
            } catch (error) {
                if (isPgUniqueViolation(error)) {
                    if (error.constraint === 'clients_phone_key') {
                        throw conflict('Ya existe un cliente registrado con ese telefono');
                    }
                    if (error.constraint === 'clients_identity_fingerprint_key') {
                        throw conflict('Ya existe un cliente registrado con ese documento');
                    }
                    throw conflict('El folio ya esta en uso');
                }
                throw error;
            }
        }
    );

    app.patch<{
        Params: { id: string };
        Body: {
            status?: string; portalEnabled?: boolean; email?: string; notes?: string;
            paymentAccountId?: number; portalView?: Record<string, boolean>;
        };
    }>(
        '/admin/clients/:id',
        {
            preHandler: requireAdmin('operador'),
            schema: {
                tags: ['Admin - Clientes'],
                summary: 'Actualiza el estado o los datos de contacto del cliente',
                body: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', enum: ['activo', 'suspendido', 'liquidado', 'baja'] },
                        portalEnabled: { type: 'boolean' },
                        email: { type: 'string', maxLength: 120 },
                        notes: { type: 'string', maxLength: 2000 },
                        paymentAccountId: { type: 'integer' },
                        portalView: {
                            type: 'object',
                            additionalProperties: { type: 'boolean' },
                            description:
                                'Secciones del portal que ve el cliente. Claves: ' +
                                'summary, plans, installments, payments, ' +
                                'paymentInstructions, card. Se fusiona con lo actual.',
                        },
                    },
                },
            },
        },
        async (request) => {
            const id = Number(request.params.id);
            const body = request.body;
            const sets: string[] = [];
            const params: unknown[] = [id];

            if (body.status !== undefined) {
                params.push(body.status);
                sets.push(`status = $${params.length}::client_status`);
            }
            if (body.portalEnabled !== undefined) {
                params.push(body.portalEnabled);
                sets.push(`portal_enabled = $${params.length}`);
            }
            if (body.email !== undefined) {
                try {
                    params.push(normalizeEmail(body.email));
                } catch (error) {
                    rethrowValidation(error);
                }
                sets.push(`email = $${params.length}`);
            }
            if (body.notes !== undefined) {
                params.push(body.notes);
                sets.push(`notes = $${params.length}`);
            }
            if (body.paymentAccountId !== undefined) {
                params.push(body.paymentAccountId);
                sets.push(`payment_account_id = $${params.length}`);
            }

            let nextView: ReturnType<typeof normalizePortalView> | null = null;
            if (body.portalView !== undefined) {
                let patch;
                try {
                    patch = parsePortalViewPatch(body.portalView);
                } catch (error) {
                    rethrowValidation(error);
                }
                const current = await db.query<{ portal_view: unknown }>(
                    `SELECT portal_view FROM clients WHERE id = $1 AND deleted_at IS NULL`,
                    [id]
                );
                if (!current.rows[0]) throw notFound('Cliente no encontrado');
                nextView = applyPortalViewPatch(current.rows[0].portal_view, patch);
                params.push(JSON.stringify(nextView));
                sets.push(`portal_view = $${params.length}::jsonb`);
            }

            if (sets.length === 0) throw badRequest('No enviaste ningun campo a actualizar');

            const result = await db.query<{ id: string; portal_view: unknown }>(
                `UPDATE clients SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL
                 RETURNING id, portal_view`,
                params
            );
            if (!result.rows[0]) throw notFound('Cliente no encontrado');

            await writeAudit(db, {
                actorId: request.admin!.id,
                action: 'client.update',
                entityType: 'client',
                entityId: String(id),
                after: body,
                ip: request.ip,
            });

            return {
                id,
                updated: true,
                portalView: normalizePortalView(result.rows[0].portal_view),
            };
        }
    );

    // =========================================================================
    // Planes
    // =========================================================================

    app.post<{
        Params: { id: string };
        Body: {
            totalAmount: string; installmentCount: number;
            frequency: 'semanal' | 'quincenal' | 'mensual'; startDate: string;
            reference?: string; productName?: string; graceDays?: number;
            skipWeekends?: boolean;
        };
    }>(
        '/admin/clients/:id/plans',
        {
            preHandler: requireAdmin('operador'),
            schema: {
                tags: ['Admin - Planes'],
                summary: 'Asigna un plan y genera su calendario de cuotas',
                description:
                    'El monto total y el numero de cuotas se fijan al alta. La ultima cuota ' +
                    'absorbe el centavo de redondeo para que la suma sea exacta.',
                params: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'integer' } },
                },
                body: {
                    type: 'object',
                    required: ['totalAmount', 'installmentCount', 'frequency', 'startDate'],
                    properties: {
                        totalAmount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
                        installmentCount: { type: 'integer', minimum: 1, maximum: 520 },
                        frequency: { type: 'string', enum: ['semanal', 'quincenal', 'mensual'] },
                        startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                        reference: { type: 'string', maxLength: 40 },
                        productName: { type: 'string', maxLength: 120 },
                        graceDays: { type: 'integer', minimum: 0, maximum: 90, default: 5 },
                        skipWeekends: { type: 'boolean', default: false },
                    },
                },
            },
        },
        async (request, reply) => {
            const clientId = Number(request.params.id);
            const body = request.body;
            const adminId = request.admin!.id;

            let totalCents: number;
            let reference: string;
            try {
                totalCents = parseAmountToCents(body.totalAmount);
                reference = normalizeReference(
                    body.reference ?? `PLAN-${clientId}-${Date.now().toString(36).toUpperCase()}`
                );
            } catch (error) {
                rethrowValidation(error);
            }

            let schedule;
            try {
                schedule = buildSchedule({
                    totalCents,
                    count: body.installmentCount,
                    frequency: body.frequency,
                    startDate: body.startDate,
                    skipWeekends: body.skipWeekends ?? false,
                });
            } catch (error) {
                throw badRequest(
                    error instanceof Error ? error.message : 'No se pudo generar el calendario'
                );
            }

            try {
                const created = await withTransaction(db, async (tx) => {
                    const plan = await tx.query<{ id: string }>(
                        `INSERT INTO plans
                           (client_id, reference, product_name, total_amount, installment_count,
                            frequency, installment_amount, start_date, end_date, grace_days,
                            created_by)
                         VALUES ($1,$2,$3,$4,$5,$6::payment_frequency,$7,$8,$9,$10,$11)
                         RETURNING id`,
                        [
                            clientId,
                            reference,
                            body.productName?.trim() ?? 'Plan de cobranza',
                            centsToNumeric(totalCents),
                            body.installmentCount,
                            body.frequency,
                            centsToNumeric(schedule.installmentAmountCents),
                            body.startDate,
                            schedule.endDate,
                            body.graceDays ?? 5,
                            adminId,
                        ]
                    );
                    const planId = Number(plan.rows[0]!.id);

                    for (const installment of schedule.installments) {
                        await tx.query(
                            `INSERT INTO installments (plan_id, seq, due_date, amount)
                             VALUES ($1,$2,$3,$4)`,
                            [planId, installment.seq, installment.dueDate,
                                centsToNumeric(installment.amountCents)]
                        );
                    }

                    await writeAudit(tx, {
                        actorId: adminId,
                        action: 'plan.create',
                        entityType: 'plan',
                        entityId: String(planId),
                        after: { reference, totalAmount: body.totalAmount, count: body.installmentCount },
                        ip: request.ip,
                    });

                    return planId;
                });

                return reply.code(201).send({
                    id: created,
                    reference,
                    total: money(totalCents),
                    installmentAmount: money(schedule.installmentAmountCents),
                    installmentCount: body.installmentCount,
                    endDate: schedule.endDate,
                    schedule: schedule.installments.map((i) => ({
                        seq: i.seq,
                        dueDate: i.dueDate,
                        amount: money(i.amountCents),
                    })),
                });
            } catch (error) {
                if (isPgUniqueViolation(error)) {
                    throw conflict(`La referencia "${reference}" ya existe`);
                }
                throw error;
            }
        }
    );

    app.get<{ Querystring: { clientId?: number; status?: string; limit?: number; offset?: number } }>(
        '/admin/plans',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Planes'],
                summary: 'Lista planes',
                querystring: {
                    type: 'object',
                    properties: {
                        clientId: { type: 'integer' },
                        status: { type: 'string', enum: ['activo', 'suspendido', 'liquidado', 'cancelado'] },
                        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                        offset: { type: 'integer', minimum: 0, default: 0 },
                    },
                },
            },
        },
        async (request) => {
            const { clientId, status, limit = 50, offset = 0 } = request.query;
            const filters = ['p.deleted_at IS NULL'];
            const params: unknown[] = [];

            if (clientId) {
                params.push(clientId);
                filters.push(`p.client_id = $${params.length}`);
            }
            if (status) {
                params.push(status);
                filters.push(`pp.status = $${params.length}::plan_status`);
            }
            params.push(limit, offset);

            const rows = await db.query<Record<string, unknown>>(
                `SELECT pp.*, c.full_name, c.folio, c.phone
                   FROM v_plan_progress pp
                   JOIN plans p ON p.id = pp.plan_id
                   JOIN clients c ON c.id = p.client_id
                  WHERE ${filters.join(' AND ')}
                  ORDER BY pp.overdue_amount DESC NULLS LAST, pp.plan_id DESC
                  LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            );

            return {
                items: rows.rows.map((p) => ({
                    id: Number(p.plan_id as string),
                    clientId: Number(p.client_id as string),
                    clientName: p.full_name,
                    folio: p.folio,
                    phone: p.phone,
                    reference: p.reference,
                    status: p.status,
                    frequency: p.frequency,
                    total: money(numericToCents(p.total_amount as string)),
                    installmentAmount: money(numericToCents(p.installment_amount as string)),
                    paid: money(numericToCents(p.paid_amount as string)),
                    pending: money(numericToCents(p.pending_amount as string)),
                    overdue: money(numericToCents(p.overdue_amount as string)),
                    installmentCount: Number(p.installment_count as number),
                    paidInstallments: Number(p.paid_count as number),
                    pendingInstallments: Number(p.pending_count as number),
                    overdueInstallments: Number(p.overdue_count as number),
                    maxDaysOverdue: p.max_days_overdue === null ? null : Number(p.max_days_overdue as number),
                    nextDueDate: p.next_due_date,
                    startDate: p.start_date,
                    endDate: p.end_date,
                })),
                pagination: { limit, offset, returned: rows.rows.length },
            };
        }
    );

    app.post<{ Params: { id: string }; Body: { reason?: string } }>(
        '/admin/plans/:id/cancel',
        {
            preHandler: requireAdmin('supervisor'),
            schema: {
                tags: ['Admin - Planes'],
                summary: 'Cancela un plan (perdida o Liquidacion anticipada)',
                description:
                    'Cancelar no borra historia: el plan queda en estado cancelado con su ' +
                    'motivo y deja de contar en el saldo del cliente.',
                params: {
                    type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
                },
                body: {
                    type: 'object',
                    properties: { reason: { type: 'string', maxLength: 500 } },
                },
            },
        },
        async (request) => {
            const id = Number(request.params.id);
            const result = await db.query<{ id: string }>(
                `UPDATE plans
                    SET status = 'cancelado',
                        cancellation_reason = $2
                  WHERE id = $1 AND deleted_at IS NULL AND status IN ('activo','suspendido')
                 RETURNING id`,
                [id, request.body?.reason ?? 'Sin motivo especificado']
            );
            if (!result.rows[0]) throw conflict('El plan no existe o ya no esta activo');

            await writeAudit(db, {
                actorId: request.admin!.id,
                action: 'plan.cancel',
                entityType: 'plan',
                entityId: String(id),
                after: { reason: request.body?.reason },
                ip: request.ip,
            });

            return { id, status: 'cancelado' };
        }
    );

    // =========================================================================
    // Pagos
    // =========================================================================

    app.post<{
        Body: {
            clientId: number; amount: string; method: PaymentMethod;
            paidAt: string; concept?: string; reference?: string; planId?: number;
            status?: 'pendiente' | 'aprobado';
        };
    }>(
        '/admin/payments',
        {
            preHandler: requireAdmin('operador'),
            schema: {
                tags: ['Admin - Pagos'],
                summary: 'Registra un pago manual (efectivo, transferencia o conciliacion SPEI)',
                description:
                    'El pago se imputa automaticamente a las cuotas mas antiguas (FIFO). ' +
                    'El excedente queda como saldo a favor del cliente.',
                body: {
                    type: 'object',
                    required: ['clientId', 'amount', 'method', 'paidAt'],
                    properties: {
                        clientId: { type: 'integer' },
                        amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
                        method: {
                            type: 'string',
                            enum: ['spei', 'tarjeta', 'efectivo', 'transferencia', 'manual'],
                        },
                        paidAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                        concept: { type: 'string', maxLength: 200 },
                        reference: { type: 'string', maxLength: 100 },
                        planId: { type: 'integer' },
                        status: { type: 'string', enum: ['pendiente', 'aprobado'], default: 'aprobado' },
                    },
                },
            },
        },
        async (request, reply) => {
            const body = request.body;
            const client = await db.query<{ id: string }>(
                'SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL',
                [body.clientId]
            );
            if (!client.rows[0]) throw notFound('Cliente no encontrado');

            const result = await recordPayment(db, {
                clientId: body.clientId,
                amount: body.amount,
                method: body.method,
                origin: 'admin',
                status: body.status ?? 'aprobado',
                paidAt: body.paidAt,
                concept: body.concept,
                reference: body.reference,
                planId: body.planId,
                recordedBy: request.admin!.id,
            });

            await writeAudit(db, {
                actorId: request.admin!.id,
                action: 'payment.create',
                entityType: 'payment',
                entityId: result.folio,
                after: {
                    amount: body.amount, method: body.method,
                    applied: centsToNumeric(result.appliedCents),
                },
                ip: request.ip,
            });

            return reply.code(201).send({
                id: result.id,
                folio: result.folio,
                amount: money(result.amountCents),
                applied: money(result.appliedCents),
                credit: money(result.unappliedCents),
                allocations: result.allocations.length,
            });
        }
    );

    app.get<{ Querystring: { status?: string; clientId?: number; limit?: number; offset?: number } }>(
        '/admin/payments',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Pagos'],
                summary: 'Lista pagos de la cartera',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['pendiente', 'aprobado', 'rechazado', 'reembolsado', 'todos'],
                        },
                        clientId: { type: 'integer' },
                        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                        offset: { type: 'integer', minimum: 0, default: 0 },
                    },
                },
            },
        },
        async (request) => {
            const { status, clientId, limit = 50, offset = 0 } = request.query;
            const filters = ['p.deleted_at IS NULL'];
            const params: unknown[] = [];

            if (status && status !== 'todos') {
                params.push(status);
                filters.push(`p.status = $${params.length}::payment_status`);
            }
            if (clientId) {
                params.push(clientId);
                filters.push(`p.client_id = $${params.length}`);
            }
            params.push(limit, offset);

            const rows = await db.query<{
                id: string; folio: string; amount: string; applied_amount: string;
                method: string; status: string; concept: string | null; reference: string | null;
                paid_at: string; client_name: string; client_folio: string;
            }>(
                `SELECT p.id, p.folio, p.amount, p.applied_amount, p.method, p.status,
                        p.concept, p.reference, p.paid_at,
                        c.full_name AS client_name, c.folio AS client_folio
                   FROM payments p JOIN clients c ON c.id = p.client_id
                  WHERE ${filters.join(' AND ')}
                  ORDER BY p.paid_at DESC, p.id DESC
                  LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            );

            return {
                items: rows.rows.map((row) => ({
                    id: Number(row.id),
                    folio: row.folio,
                    clientName: row.client_name,
                    clientFolio: row.client_folio,
                    amount: money(numericToCents(row.amount)),
                    applied: money(numericToCents(row.applied_amount)),
                    method: row.method,
                    status: row.status,
                    concept: row.concept,
                    reference: row.reference,
                    paidAt: row.paid_at,
                })),
                pagination: { limit, offset, returned: rows.rows.length },
            };
        }
    );

    app.post<{ Params: { id: string } }>(
        '/admin/payments/:id/approve',
        {
            preHandler: requireAdmin('operador'),
            schema: {
                tags: ['Admin - Pagos'],
                summary: 'Aprueba un pago pendiente y lo imputa a las cuotas',
                params: {
                    type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
                },
            },
        },
        async (request) => {
            const id = Number(request.params.id);
            const result = await approvePayment(db, id, request.admin!.id);
            return {
                id,
                status: 'aprobado',
                applied: money(result.appliedCents),
                credit: money(result.unappliedCents),
                allocations: result.allocations,
            };
        }
    );

    app.post<{ Params: { id: string }; Body: { reason?: string } }>(
        '/admin/payments/:id/reject',
        {
            preHandler: requireAdmin('supervisor'),
            schema: {
                tags: ['Admin - Pagos'],
                summary: 'Rechaza un pago y revierte su imputacion',
                description:
                    'Revertir la imputacion reabre las cuotas afectadas. Si el pago ya ' +
                    'distribuyo dinero, el sistema lo revierte antes de marcarlo rechazado.',
                params: {
                    type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
                },
                body: {
                    type: 'object',
                    properties: { reason: { type: 'string', maxLength: 300 } },
                },
            },
        },
        async (request) => {
            const id = Number(request.params.id);
            const reason = request.body?.reason?.trim() || 'Rechazado por el administrador';
            await reversePayment(db, id, reason, request.admin!.id);
            return { id, status: 'rechazado' };
        }
    );

    // =========================================================================
    // Cuentas receptoras
    // =========================================================================

    app.get(
        '/admin/payment-accounts',
        {
            preHandler: requireAdmin('lectura'),
            schema: { tags: ['Admin'], summary: 'Cuentas CLABE disponibles' },
        },
        async () => {
            const rows = await db.query<{
                id: string; label: string; bank_name: string; clabe: string;
                holder: string; reference_tmpl: string; active: boolean;
            }>('SELECT * FROM payment_accounts ORDER BY active DESC, label');
            return {
                items: rows.rows.map((row) => ({
                    id: Number(row.id),
                    label: row.label,
                    bank: row.bank_name,
                    clabe: row.clabe,
                    holder: row.holder,
                    referenceTemplate: row.reference_tmpl,
                    active: row.active,
                })),
            };
        }
    );

    // =========================================================================
    // Usuarios administradores (solo rol admin)
    // =========================================================================

    app.post<{ Body: { email: string; fullName: string; password: string; role?: AdminRole } }>(
        '/admin/users',
        {
            preHandler: requireAdmin('admin'),
            schema: {
                tags: ['Admin - Usuarios'],
                summary: 'Crea un usuario administrativo',
                body: {
                    type: 'object',
                    required: ['email', 'fullName', 'password'],
                    properties: {
                        email: { type: 'string', format: 'email' },
                        fullName: { type: 'string', minLength: 3, maxLength: 120 },
                        password: { type: 'string', minLength: 10, maxLength: 200 },
                        role: {
                            type: 'string',
                            enum: ['admin', 'supervisor', 'operador', 'lectura'],
                            default: 'operador',
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { email, fullName, password, role = 'operador' } = request.body;
            const passwordHash = await hashPassword(password);
            try {
                const result = await db.query<{ id: string }>(
                    `INSERT INTO admin_users (email, full_name, password_hash, role,
                                              password_changed_at)
                     VALUES ($1,$2,$3,$4::admin_role, now()) RETURNING id`,
                    [email.trim().toLowerCase(), fullName.trim(), passwordHash, role]
                );
                return reply.code(201).send({ id: Number(result.rows[0]!.id) });
            } catch (error) {
                if (isPgUniqueViolation(error)) throw conflict('Ese correo ya esta registrado');
                throw error;
            }
        }
    );
}
