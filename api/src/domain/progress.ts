import { progressPercent } from '../shared/money.js';

export interface PlanProgressInput {
    totalCents: number;
    paidCents: number;
    waivedCents: number;
    pendingCents: number;
    overdueCents: number;
    paidCount: number;
    pendingCount: number;
    overdueCount: number;
    installmentCount: number;
    nextDueDate: string | null;
    lastPaidAt: string | null;
    status: string;
}

export interface PlanProgress {
    total: number;
    paid: number;
    waived: number;
    pending: number;
    overdue: number;
    /** % de liquidacion del plan, acotado a 100. */
    percent: number;
    paidInstallments: number;
    pendingInstallments: number;
    overdueInstallments: number;
    installmentCount: number;
    nextDueDate: string | null;
    lastPaidAt: string | null;
    status: string;
    isLiquidated: boolean;
    hasOverdue: boolean;
}

/**
 * Vista de progreso de un plan, ya en centimos.
 *
 * `percent` usa solo lo pagado contra el total, de modo que una cuota condonada
 * no infla el avance: el condonado se reporta aparte. Si se quisiera contar el
 * condonado como avance, habria que dejar de distinguir "liquidado" de
 * "pagado", que es justo la informacion que el cliente necesita ver.
 */
export function buildProgress(input: PlanProgressInput): PlanProgress {
    const percent = progressPercent(input.paidCents, input.totalCents);

    return {
        total: input.totalCents,
        paid: input.paidCents,
        waived: input.waivedCents,
        pending: input.pendingCents,
        overdue: input.overdueCents,
        percent,
        paidInstallments: input.paidCount,
        pendingInstallments: input.pendingCount,
        overdueInstallments: input.overdueCount,
        installmentCount: input.installmentCount,
        nextDueDate: input.nextDueDate,
        lastPaidAt: input.lastPaidAt,
        status: input.status,
        isLiquidated: input.status === 'liquidado' || input.pendingCents === 0,
        hasOverdue: input.overdueCents > 0 || input.overdueCount > 0,
    };
}

/**
 * Consolida varios planes en la vista de tarjeta del portal.
 *
 * El "saldo pendiente" del cliente es la suma de lo que falta por pagar en
 * planes vivos. Un plan cancelado no resta ni suma: si no, un forgive dejaria
 * un saldo fantasma en la tarjeta.
 */
export function consolidateProgress(plans: PlanProgress[]): PlanProgress {
    const total = plans.reduce((acc, p) => acc + p.total, 0);
    const paid = plans.reduce((acc, p) => acc + p.paid, 0);
    const waived = plans.reduce((acc, p) => acc + p.waived, 0);
    const overdue = plans.reduce((acc, p) => acc + p.overdue, 0);

    const pending = plans
        .filter((p) => p.status !== 'cancelado')
        .reduce((acc, p) => acc + p.pending, 0);

    const installmentCount = plans.reduce((acc, p) => acc + p.installmentCount, 0);
    const paidInstallments = plans.reduce((acc, p) => acc + p.paidInstallments, 0);
    const pendingInstallments = plans.reduce((acc, p) => acc + p.pendingInstallments, 0);
    const overdueInstallments = plans.reduce((acc, p) => acc + p.overdueInstallments, 0);

    const nextDueDates = plans
        .filter((p) => p.status !== 'cancelado' && p.nextDueDate)
        .map((p) => p.nextDueDate as string)
        .sort();
    const paidDates = plans.map((p) => p.lastPaidAt).filter((v): v is string => Boolean(v)).sort();

    return {
        total,
        paid,
        waived,
        pending,
        overdue,
        percent: progressPercent(paid, total),
        paidInstallments,
        pendingInstallments,
        overdueInstallments,
        installmentCount,
        nextDueDate: nextDueDates[0] ?? null,
        lastPaidAt: paidDates[paidDates.length - 1] ?? null,
        status: plans.length === 0
            ? 'sin_plan'
            : plans.every((p) => p.status === 'liquidado')
              ? 'liquidado'
              : 'activo',
        isLiquidated: plans.length > 0 && plans.every((p) => p.isLiquidated),
        hasOverdue: overdue > 0,
    };
}
