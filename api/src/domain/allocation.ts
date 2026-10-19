/**
 * Imputacion de un pago sobre las cuotas abiertas de un cliente.
 *
 * Politica: FIFO por vencimiento y, a igualdad, por numero de cuota. Es la
 * politica estandar en cobranza: el pago mas antiguo es el que primero deja de
 * generar atraso.
 *
 * El excedente NO se reparte entre cuotas ya saldadas: se queda como saldo a
 * favor (`payments.unapplied_amount`) para aplicarlo a las proximas. Inventar
 * un "abono" invisible solo complica la conciliacion.
 */

export interface OpenInstallment {
    id: number;
    seq: number;
    dueDate: string;
    amountCents: number;
}

export interface Allocation {
    installmentId: number;
    amountCents: number;
}

export interface AllocationPlan {
    allocations: Allocation[];
    /** Importe cubierto por las cuotas. */
    appliedCents: number;
    /** Sobrante que queda a favor del cliente. */
    unappliedCents: number;
}

/**
 * Reparte `amountCents` sobre las cuotas abiertas, de la mas antigua a la mas
 * reciente. No devuelve asignaciones de importe cero ni supera el saldo.
 *
 * Devolver solo el plan (sin tocar la base) permite probar la politica de
 * imputacion sin transacciones y reutilizarla tanto en el portal como en el
 * panel administrativo.
 */
export function planAllocation(
    openInstallments: readonly OpenInstallment[],
    amountCents: number
): AllocationPlan {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
        throw new RangeError('El importe del pago debe ser un entero de centimos >= 0');
    }

    const ordered = [...openInstallments].sort(
        (a, b) => a.dueDate.localeCompare(b.dueDate) || a.seq - b.seq
    );

    const allocations: Allocation[] = [];
    let remaining = amountCents;

    for (const installment of ordered) {
        if (remaining <= 0) break;
        const applied = Math.min(installment.amountCents, remaining);
        if (applied <= 0) continue;

        allocations.push({ installmentId: installment.id, amountCents: applied });
        remaining -= applied;
    }

    const appliedCents = amountCents - remaining;
    return { allocations, appliedCents, unappliedCents: remaining };
}
