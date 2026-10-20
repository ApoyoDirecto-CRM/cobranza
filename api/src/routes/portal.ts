import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import type { Queryable } from '../db/client.js';
import { buildProgress, consolidateProgress, type PlanProgress } from '../domain/progress.js';
import { centsToNumber, formatCurrency, numericToCents, parseAmountToCents } from '../shared/money.js';
import { badRequest, notFound } from '../shared/errors.js';

export interface PortalDeps {
    db: Queryable;
    requireClient: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    createCardSession: (input: CardSessionInput) => Promise<CardSessionResult>;
}

export interface CardSessionInput {
    clientId: number;
    amountCents: number;
    installmentId?: number;
    idempotencyKey: string;
}

export interface CardSessionResult {
    sessionId: string;
    publicKey: string | null;
    expiresAt: string;
}

/** Fila de la vista v_plan_progress. */
interface PlanProgressRow {
    plan_id: string; reference: string; status: string; frequency: string;
    product_name: string | null; total_amount: string; installment_count: number;
    installment_amount: string; paid_amount: string; waived_amount: string;
    pending_amount: string; overdue_amount: string; paid_count: number;
    pending_count: number; overdue_count: number; next_due_date: string | null;
    last_paid_at: string | null; start_date: string; end_date: string;
}

const money = (cents: number) => ({
    amount: centsToNumber(cents),
    formatted: formatCurrency(cents),
});

const today = () => new Date().toISOString().slice(0, 10);

export async function registerPortalRoutes(app: FastifyInstance, deps: PortalDeps): Promise<void> {
    const { db, requireClient, createCardSession } = deps;

    // -------------------------------------------------------------------------
    // GET /api/v1/portal/summary
    // Tarjeta principal del dashboard: total, pagado, saldo y % de liquidacion.
    // -------------------------------------------------------------------------
    app.get(
        '/portal/summary',
        {
            preHandler: requireClient,
            schema: {
                tags: ['Portal'],
                summary: 'Resumen de saldos del cliente',
                description:
                    'Tarjeta de resumen del dashboard: monto total del plan, total acumulado ' +
                    'pagado, saldo pendiente y porcentaje de liquidacion.',
            },
        },
        async (request) => {
            const clientId = request.client!.id;

            const clientRow = await db.query<{
                folio: string; full_name: string; status: string; email: string | null;
                identity_hash: string; identity_masked: string; identity_type: string;
            }>(
                `SELECT folio, full_name, status, email, identity_hash, identity_masked, identity_type
                   FROM clients WHERE id = $1`,
                [clientId]
            );
            const client = clientRow.rows[0];
            if (!client) throw notFound('Cliente no encontrado');

            const rowsResult = await db.query<PlanProgressRow>(
                `SELECT * FROM v_plan_progress WHERE client_id = $1 ORDER BY start_date DESC`,
                [clientId]
            );

            const plans = rowsResult.rows.map((row) => ({
                row,
                progress: buildProgress({
                    totalCents: numericToCents(row.total_amount),
                    paidCents: numericToCents(row.paid_amount),
                    waivedCents: numericToCents(row.waived_amount),
                    pendingCents: numericToCents(row.pending_amount),
                    overdueCents: numericToCents(row.overdue_amount),
                    paidCount: Number(row.paid_count),
                    pendingCount: Number(row.pending_count),
                    overdueCount: Number(row.overdue_count),
                    installmentCount: Number(row.installment_count),
                    nextDueDate: row.next_due_date,
                    lastPaidAt: row.last_paid_at,
                    status: row.status,
                }),
            }));

            const consolidated = consolidateProgress(plans.map((p) => p.progress));

            const accountResult = await db.query<{
                clabe: string; bank_name: string; holder: string;
            } | null>(
                `SELECT a.clabe, a.bank_name, a.holder
                   FROM clients c JOIN payment_accounts a ON a.id = c.payment_account_id
                  WHERE c.id = $1 AND a.active`,
                [clientId]
            );

            return {
                client: {
                    folio: client.folio,
                    fullName: client.full_name,
                    email: client.email,
                    status: client.status,
                    identity: client.identity_masked,
                    identityType: client.identity_type,
                },
                totals: {
                    total: money(consolidated.total),
                    paid: money(consolidated.paid),
                    pending: money(consolidated.pending),
                    overdue: money(consolidated.overdue),
                    waived: money(consolidated.waived),
                    percent: consolidated.percent,
                    installmentCount: consolidated.installmentCount,
                    paidInstallments: consolidated.paidInstallments,
                    pendingInstallments: consolidated.pendingInstallments,
                    overdueInstallments: consolidated.overdueInstallments,
                    nextDueDate: consolidated.nextDueDate,
                    lastPaidAt: consolidated.lastPaidAt,
                    isLiquidated: consolidated.isLiquidated,
                    hasOverdue: consolidated.hasOverdue,
                },
                plans: plans.map(({ row, progress }) => ({
                    id: Number(row.plan_id),
                    reference: row.reference,
                    productName: row.product_name ?? 'Plan de cobranza',
                    frequency: row.frequency,
                    status: progress.status,
                    startDate: row.start_date,
                    endDate: row.end_date,
                    installmentAmount: money(numericToCents(row.installment_amount)),
                    total: money(progress.total),
                    paid: money(progress.paid),
                    pending: money(progress.pending),
                    overdue: money(progress.overdue),
                    waived: money(progress.waived),
                    percent: progress.percent,
                    installmentCount: progress.installmentCount,
                    paidInstallments: progress.paidInstallments,
                    pendingInstallments: progress.pendingInstallments,
                    overdueInstallments: progress.overdueInstallments,
                    nextDueDate: progress.nextDueDate,
                    lastPaidAt: progress.lastPaidAt,
                    isLiquidated: progress.isLiquidated,
                })),
                paymentAccount: accountResult.rows[0]
                    ? {
                        bank: accountResult.rows[0].bank_name,
                        clabe: accountResult.rows[0].clabe,
                        holder: accountResult.rows[0].holder,
                    }
                    : null,
            };
        }
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/portal/installments
    // Calendario de cuotas del cliente.
    // -------------------------------------------------------------------------
    app.get<{ Querystring: { status?: string; limit?: number; offset?: number } }>(
        '/portal/installments',
        {
            preHandler: requireClient,
            schema: {
                tags: ['Portal'],
                summary: 'Cuotas del cliente (pendientes, pagadas y vencidas)',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['pendiente', 'pagado', 'condonado', 'vencido', 'todos'],
                            default: 'todos',
                        },
                        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                        offset: { type: 'integer', minimum: 0, default: 0 },
                    },
                },
            },
        },
        async (request) => {
            const clientId = request.client!.id;
            const { status = 'todos', limit = 50, offset = 0 } = request.query;

            // "vencido" no existe en el ENUM: se filtra por estado + fecha.
            const filter =
                status === 'vencido'
                    ? `AND i.status = 'pendiente' AND i.due_date < CURRENT_DATE`
                    : status === 'todos'
                      ? ''
                      : `AND i.status = $2::installment_status`;

            const params: unknown[] = [clientId];
            if (filter.includes('$2')) params.push(status);
            params.push(limit, offset);

            const rows = await db.query<{
                id: string; plan_id: string; seq: number; due_date: string;
                amount: string; status: string; paid_at: string | null;
                reference: string; original_due_date: string | null;
            }>(
                `SELECT i.id, i.plan_id, i.seq, i.due_date, i.amount, i.status, i.paid_at,
                        i.original_due_date, p.reference
                   FROM installments i
                   JOIN plans p ON p.id = i.plan_id
                  WHERE p.client_id = $1 AND p.deleted_at IS NULL ${filter}
                  ORDER BY i.due_date DESC, i.seq DESC
                  LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            );

            return {
                items: rows.rows.map((row) => ({
                    id: Number(row.id),
                    planId: Number(row.plan_id),
                    reference: row.reference,
                    seq: row.seq,
                    dueDate: row.due_date,
                    originalDueDate: row.original_due_date,
                    amount: money(numericToCents(row.amount)),
                    // El vencimiento se deriva del estado real y la fecha, no de
                    // un campo almacenado que se desincroniza sin un batch diario.
                    state:
                        row.status === 'pendiente' && row.due_date < today()
                            ? 'vencido'
                            : row.status,
                    paidAt: row.paid_at,
                })),
                pagination: { limit, offset, returned: rows.rows.length },
            };
        }
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/portal/payments
    // Historial de pagos.
    // -------------------------------------------------------------------------
    app.get<{ Querystring: { status?: string; limit?: number; offset?: number } }>(
        '/portal/payments',
        {
            preHandler: requireClient,
            schema: {
                tags: ['Portal'],
                summary: 'Historial de pagos del cliente',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['pendiente', 'aprobado', 'rechazado', 'todos'],
                            default: 'todos',
                        },
                        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                        offset: { type: 'integer', minimum: 0, default: 0 },
                    },
                },
            },
        },
        async (request) => {
            const clientId = request.client!.id;
            const { status = 'todos', limit = 20, offset = 0 } = request.query;
            const filtered = status !== 'todos';

            const rows = await db.query<{
                id: string; folio: string; amount: string; applied_amount: string;
                method: string; status: string; concept: string | null;
                paid_at: string; approved_at: string | null; reference: string | null;
            }>(
                `SELECT p.id, p.folio, p.amount, p.applied_amount, p.method, p.status,
                        p.concept, p.paid_at, p.approved_at, p.reference
                   FROM payments p
                  WHERE p.client_id = $1
                    AND p.deleted_at IS NULL
                    ${filtered ? 'AND p.status = $2::payment_status' : ''}
                  ORDER BY p.paid_at DESC, p.id DESC
                  LIMIT $${filtered ? 3 : 2} OFFSET $${filtered ? 4 : 3}`,
                filtered ? [clientId, status, limit, offset] : [clientId, limit, offset]
            );

            const countResult = await db.query<{ total: number }>(
                `SELECT COUNT(*)::int AS total FROM payments p
                  WHERE p.client_id = $1 AND p.deleted_at IS NULL
                    ${filtered ? 'AND p.status = $2::payment_status' : ''}`,
                filtered ? [clientId, status] : [clientId]
            );
            const total = countResult.rows[0]?.total ?? 0;

            return {
                items: rows.rows.map((row) => ({
                    id: Number(row.id),
                    folio: row.folio,
                    amount: money(numericToCents(row.amount)),
                    appliedAmount: centsToNumber(numericToCents(row.applied_amount)),
                    method: row.method,
                    status: row.status,
                    concept: row.concept ?? 'Abono a plan',
                    reference: row.reference,
                    paidAt: row.paid_at,
                    approvedAt: row.approved_at,
                })),
                pagination: {
                    limit,
                    offset,
                    returned: rows.rows.length,
                    total,
                    hasMore: offset + rows.rows.length < total,
                },
            };
        }
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/portal/payment-instructions
    // Ficha de pago: CLABE + referencia para SPEI.
    // -------------------------------------------------------------------------
    app.get(
        '/portal/payment-instructions',
        {
            preHandler: requireClient,
            schema: { tags: ['Portal'], summary: 'Ficha de pago (SPEI y tarjeta)' },
        },
        async (request) => {
            const clientId = request.client!.id;

            const accountResult = await db.query<{
                clabe: string; bank_name: string; holder: string; reference_tmpl: string;
            } | null>(
                `SELECT a.clabe, a.bank_name, a.holder, a.reference_tmpl
                   FROM clients c JOIN payment_accounts a ON a.id = c.payment_account_id
                  WHERE c.id = $1 AND a.active`,
                [clientId]
            );
            const account = accountResult.rows[0];
            if (!account) {
                throw notFound(
                    'Tu credito aun no tiene una CLABE asignada. Contacta a tu asesor para recibirla.'
                );
            }

            const dueResult = await db.query<{
                pending_amount: string; overdue_amount: string; next_due_date: string | null;
                overdue_count: number; pending_count: number;
            }>(
                `SELECT COALESCE(SUM(pending_amount),0) AS pending_amount,
                        COALESCE(SUM(overdue_amount),0) AS overdue_amount,
                        MIN(next_due_date) AS next_due_date,
                        COALESCE(SUM(overdue_count),0)::int AS overdue_count,
                        COALESCE(SUM(pending_count),0)::int AS pending_count
                   FROM v_plan_progress WHERE client_id = $1 AND status = 'activo'`,
                [clientId]
            );
            const due = dueResult.rows[0];

            const creditResult = await db.query<{ credit: string }>(
                `SELECT COALESCE(SUM(unapplied_amount),0) AS credit
                   FROM payments
                  WHERE client_id = $1 AND status = 'aprobado' AND deleted_at IS NULL`,
                [clientId]
            );
            const creditCents = numericToCents(creditResult.rows[0]?.credit);
            const pendingCents = numericToCents(due?.pending_amount);

            const folio = request.client!.folio;
            const reference = account.reference_tmpl.replace('{FOLIO}', folio);

            return {
                pending: money(pendingCents),
                overdue: money(numericToCents(due?.overdue_amount)),
                credit: money(creditCents),
                nextDueDate: due?.next_due_date ?? null,
                overdueInstallments: due?.overdue_count ?? 0,
                pendingInstallments: due?.pending_count ?? 0,
                spei: {
                    bank: account.bank_name,
                    clabe: account.clabe,
                    holder: account.holder,
                    reference,
                    concept: `Pago de credito folio ${folio}`,
                    // Detecta un error de captura del numero antes de transferir.
                    clabeValid: isValidClabe(account.clabe),
                    instructions: [
                        'Abre tu banca en linea o la aplicacion de tu banco.',
                        'Elige "Transferencia" o "SPEI".',
                        `Captura la CLABE ${account.clabe}.`,
                        `Captura el monto exacto de ${formatCurrency(pendingCents)}.`,
                        `En concepto escribe: ${reference}`,
                        'Guarda el comprobante: queda registrado en tu historial.',
                    ],
                    deadlineHours: config.spei.deadlineHours,
                },
                card: {
                    available: true,
                    description:
                        'Pago con tarjeta. Se procesa al instante y el saldo se actualiza ' +
                        'en cuanto la pasarela confirme la operacion.',
                },
            };
        }
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/portal/payments/card-session
    // -------------------------------------------------------------------------
    app.post<{ Body: { amount?: string; installmentId?: number } }>(
        '/portal/payments/card-session',
        {
            preHandler: requireClient,
            schema: {
                tags: ['Portal'],
                summary: 'Crea una sesion de pago con tarjeta',
                description:
                    'Devuelve los datos para tokenizar la tarjeta en el navegador. ' +
                    'El numero de tarjeta nunca transita por esta API.',
                body: {
                    type: 'object',
                    properties: {
                        amount: {
                            type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$',
                            description: 'Opcional. Si se omite, se cobra el saldo pendiente.',
                        },
                        installmentId: { type: 'integer', description: 'Cuota concreta a pagar.' },
                    },
                },
            },
        },
        async (request) => {
            const clientId = request.client!.id;
            const body = request.body ?? {};

            let amountCents: number;
            if (body.amount !== undefined) {
                amountCents = parseAmountToCents(body.amount);
            } else {
                const row = await db.query<{ pending: string }>(
                    `SELECT COALESCE(SUM(pending_amount),0) AS pending
                       FROM v_plan_progress WHERE client_id = $1 AND status = 'activo'`,
                    [clientId]
                );
                amountCents = numericToCents(row.rows[0]?.pending);
            }

            if (amountCents <= 0) {
                throw badRequest('No tienes saldo pendiente por cobrar.');
            }

            // El idempotency key se deriva del id de la peticion para que un
            // doble toque en "Pagar" no genere dos cargos.
            const session = await createCardSession({
                clientId,
                amountCents,
                installmentId: body.installmentId,
                idempotencyKey: request.id,
            });

            return {
                sessionId: session.sessionId,
                publicKey: session.publicKey,
                expiresAt: session.expiresAt,
                amount: centsToNumber(amountCents),
                amountFormatted: formatCurrency(amountCents),
            };
        }
    );
}

/**
 * Digito de control de la CLABE: ponderacion 3,7,1 sobre los 17 primeros
 * digitos (3 de banco + 11 de cuenta + 3 de plaza).
 */
export function isValidClabe(clabe: string): boolean {
    if (!/^\d{18}$/.test(clabe)) return false;
    const weights = [3, 7, 1];
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        sum += Number(clabe[i]) * weights[i % 3]!;
    }
    return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}
