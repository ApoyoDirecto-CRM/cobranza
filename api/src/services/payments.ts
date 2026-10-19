import type { Queryable } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { planAllocation, type OpenInstallment } from '../domain/allocation.js';
import { centsToNumeric, numericToCents, parseAmountToCents } from '../shared/money.js';
import { AppError, badRequest } from '../shared/errors.js';

export type PaymentMethod = 'spei' | 'tarjeta' | 'efectivo' | 'transferencia' | 'manual';
export type PaymentOrigin = 'portal' | 'pasarela' | 'admin' | 'webhook';
export type PaymentState = 'pendiente' | 'aprobado' | 'rechazado' | 'reembolsado';

export interface RecordPaymentInput {
    clientId: number;
    amount: string | number;
    method: PaymentMethod;
    origin: PaymentOrigin;
    status?: PaymentState;
    paidAt: string;
    concept?: string;
    reference?: string;
    provider?: string;
    providerPaymentId?: string;
    webhookEventId?: number;
    methodLast4?: string;
    recordedBy?: number;
    receiptKey?: string;
    /** Restringe la imputacion a un plan concreto. */
    planId?: number;
}

export interface RecordPaymentResult {
    id: number;
    folio: string;
    amountCents: number;
    appliedCents: number;
    unappliedCents: number;
    allocations: { installmentId: number; amountCents: number }[];
}

/** Cuotas todavia saldables de un cliente, vencidas primero. */
async function loadOpenInstallments(
    tx: Queryable,
    clientId: number,
    planId?: number
): Promise<OpenInstallment[]> {
    const result = await tx.query<{
        id: string; seq: number; due_date: string; amount: string;
    }>(
        `SELECT i.id, i.seq, i.due_date, i.amount
           FROM installments i
           JOIN plans p ON p.id = i.plan_id
          WHERE p.client_id = $1
            AND p.status = 'activo'
            AND p.deleted_at IS NULL
            AND i.status = 'pendiente'
            AND ($2::bigint IS NULL OR p.id = $2)
          ORDER BY i.due_date, i.seq
          FOR UPDATE OF i`,
        [clientId, planId ?? null]
    );

    return result.rows.map((row) => ({
        id: Number(row.id),
        seq: row.seq,
        dueDate: row.due_date,
        amountCents: parseAmountToCents(row.amount),
    }));
}

/**
 * Registra un pago y lo imputa a las cuotas mas antiguas.
 *
 * Todo ocurre en UNA transaccion: los triggers diferidos del esquema solo
 * consolidan en el COMMIT, y sin transaccion explicita un fallo de integridad
 * llegaria tarde, cuando el pago ya quedo escrito.
 *
 * Idempotencia del proveedor: si llega un (provider, providerPaymentId) que ya
 * existe, se devuelve el pago original en lugar de duplicar el movimiento. Es
 * lo que permite que la pasarela reintente el webhook sin dano.
 */
export async function recordPayment(
    db: Queryable,
    input: RecordPaymentInput
): Promise<RecordPaymentResult> {
    const amountCents = parseAmountToCents(input.amount);
    if (amountCents <= 0) {
        throw badRequest('El monto del pago debe ser mayor a cero');
    }

    const status = input.status ?? 'aprobado';
    const approvedAt = status === 'aprobado' ? new Date().toISOString() : null;

    return withTransaction(db, async (tx) => {
        // 1. Reintento del proveedor: devolver el pago existente.
        if (input.provider && input.providerPaymentId) {
            const existing = await tx.query<{
                id: string; folio: string; amount: string; applied_amount: string;
            }>(
                `SELECT id, folio, amount, applied_amount
                   FROM payments
                  WHERE provider = $1 AND provider_payment_id = $2
                    AND deleted_at IS NULL`,
                [input.provider, input.providerPaymentId]
            );
            const prior = existing.rows[0];
            if (prior) {
                const total = parseAmountToCents(prior.amount);
                const applied = parseAmountToCents(prior.applied_amount);
                return {
                    id: Number(prior.id),
                    folio: prior.folio,
                    amountCents: total,
                    appliedCents: applied,
                    unappliedCents: total - applied,
                    allocations: [],
                    idempotentReplay: true,
                } as RecordPaymentResult & { idempotentReplay: boolean };
            }
        }

        // 2. Alta del pago.
        const inserted = await tx.query<{ id: string; folio: string }>(
            `INSERT INTO payments
               (client_id, amount, method, origin, status, paid_at, approved_at,
                concept, reference, provider, provider_payment_id, webhook_event_id,
                method_last4, recorded_by, receipt_key)
             VALUES ($1,$2,$3::payment_method,$4::payment_origin,$5::payment_status,
                     $6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id, folio`,
            [
                input.clientId,
                centsToNumeric(amountCents),
                input.method,
                input.origin,
                status,
                input.paidAt,
                approvedAt,
                input.concept ?? null,
                input.reference ?? null,
                input.provider ?? null,
                input.providerPaymentId ?? null,
                input.webhookEventId ?? null,
                input.methodLast4 ?? null,
                input.recordedBy ?? null,
                input.receiptKey ?? null,
            ]
        );
        const payment = inserted.rows[0];
        if (!payment) throw new AppError('INTERNAL_ERROR', 'No se pudo registrar el pago');
        const paymentId = Number(payment.id);

        // 3. Imputacion FIFO. Solo tiene sentido sobre pagos aprobados.
        if (status !== 'aprobado') {
            return {
                id: paymentId,
                folio: payment.folio,
                amountCents,
                appliedCents: 0,
                unappliedCents: amountCents,
                allocations: [],
            };
        }

        const open = await loadOpenInstallments(tx, input.clientId, input.planId);
        const plan = planAllocation(open, amountCents);

        for (const allocation of plan.allocations) {
            await tx.query(
                `INSERT INTO payment_allocations (payment_id, installment_id, amount)
                 VALUES ($1, $2, $3)`,
                [paymentId, allocation.installmentId, centsToNumeric(allocation.amountCents)]
            );
        }

        return {
            id: paymentId,
            folio: payment.folio,
            amountCents,
            appliedCents: plan.appliedCents,
            unappliedCents: plan.unappliedCents,
            allocations: plan.allocations,
        };
    });
}

/**
 * Aprueba un pago que estaba en estado 'pendiente' y lo imputa con la misma
 * politica FIFO.
 *
 * Aprobacion y distribucion ocurren en la MISMA transaccion: si la distribucion
 * fallara, el pago no quedaria aprobado con dinero sin aplicar.
 */
export async function approvePayment(
    db: Queryable,
    paymentId: number,
    actorId?: number
): Promise<{ appliedCents: number; unappliedCents: number; allocations: number }> {
    return withTransaction(db, async (tx) => {
        const found = await tx.query<{
            client_id: string; amount: string; status: PaymentState; method: string;
            paid_at: string; plan_id: string | null;
        }>(
            `SELECT p.client_id, p.amount, p.status, p.method, p.paid_at,
                    (SELECT a.installment_id FROM payment_allocations a
                      WHERE a.payment_id = p.id ORDER BY a.created_at LIMIT 1) AS plan_id
               FROM payments p
              WHERE p.id = $1 AND p.deleted_at IS NULL
              FOR UPDATE`,
            [paymentId]
        );
        const row = found.rows[0];
        if (!row) throw badRequest('El pago no existe');
        if (row.status === 'aprobado') {
            const current = await tx.query<{ applied: string }>(
                'SELECT applied_amount AS applied FROM payments WHERE id = $1', [paymentId]
            );
            const appliedCents = numericToCents(current.rows[0]?.applied);
            const total = parseAmountToCents(row.amount);
            return { appliedCents, unappliedCents: total - appliedCents, allocations: 0 };
        }
        if (row.status !== 'pendiente') {
            throw badRequest(`No se puede aprobar un pago en estado "${row.status}"`);
        }

        const totalCents = parseAmountToCents(row.amount);
        const open = await loadOpenInstallments(
            tx, Number(row.client_id), row.plan_id ? Number(row.plan_id) : undefined
        );
        const plan = planAllocation(open, totalCents);

        for (const allocation of plan.allocations) {
            await tx.query(
                `INSERT INTO payment_allocations (payment_id, installment_id, amount)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (payment_id, installment_id) DO UPDATE SET amount = EXCLUDED.amount`,
                [paymentId, allocation.installmentId, centsToNumeric(allocation.amountCents)]
            );
        }

        await tx.query(
            `UPDATE payments SET status = 'aprobado', approved_at = now() WHERE id = $1`,
            [paymentId]
        );

        if (actorId !== undefined) {
            await writeAudit(tx, {
                actorId,
                action: 'payment.approve',
                entityType: 'payment',
                entityId: String(paymentId),
                after: { status: 'aprobado', applied: centsToNumeric(plan.appliedCents) },
            });
        }

        return {
            appliedCents: plan.appliedCents,
            unappliedCents: plan.unappliedCents,
            allocations: plan.allocations.length,
        };
    });
}

/**
 * Revierte la imputacion de un pago (rechazo, devolucion o error de captura).
 *
 * Primero se borran las aplicaciones y luego se cambia el estatus: el trigger
 * `payments_reject_guard` prohibe justamente lo contrario.
 */
export async function reversePayment(
    db: Queryable,
    paymentId: number,
    reason: string,
    actorId?: number
): Promise<void> {
    await withTransaction(db, async (tx) => {
        const payment = await tx.query<{ status: PaymentState; client_id: string }>(
            'SELECT status, client_id FROM payments WHERE id = $1 FOR UPDATE',
            [paymentId]
        );
        const row = payment.rows[0];
        if (!row) throw badRequest('El pago no existe');
        if (row.status === 'rechazado') return;

        await tx.query('DELETE FROM payment_allocations WHERE payment_id = $1', [paymentId]);
        await tx.query(
            `UPDATE payments
                SET status = 'rechazado', rejected_reason = $2, approved_at = NULL
              WHERE id = $1`,
            [paymentId, reason]
        );

        await writeAudit(tx, {
            actorId,
            action: 'payment.reject',
            entityType: 'payment',
            entityId: String(paymentId),
            after: { status: 'rechazado', reason },
        });
    });
}

export async function writeAudit(
    db: Queryable,
    entry: {
        actorId?: number | null;
        actorType?: 'admin' | 'client';
        action: string;
        entityType: string;
        entityId: string;
        before?: unknown;
        after?: unknown;
        ip?: string | null;
    }
): Promise<void> {
    await db.query(
        `INSERT INTO audit_log
           (actor_type, actor_id, action, entity_type, entity_id, before_data, after_data, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
            entry.actorType ?? 'admin',
            entry.actorId ?? null,
            entry.action,
            entry.entityType,
            entry.entityId,
            entry.before === undefined ? null : JSON.stringify(entry.before),
            entry.after === undefined ? null : JSON.stringify(entry.after),
            entry.ip ?? null,
        ]
    );
}
