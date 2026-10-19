/**
 * Contratos de la API, replicados como tipos.
 *
 * Se mantienen a mano (y no generados) para no anadir OpenAPI al arranque. El
 * formateo de dinero viaja ya hecho desde el servidor (`formatted`), de modo
 * que el frontend nunca decide el formato monetario.
 */

export interface Money {
    /** Decimal exacto, apto para calculos simples en la vista. */
    amount: number;
    /** Cadena ya formateada es-MX, lista para pintar. */
    formatted: string;
}

export interface PlanView {
    id: number;
    reference: string;
    productName: string;
    frequency: 'semanal' | 'quincenal' | 'mensual';
    status: string;
    startDate: string;
    endDate: string;
    installmentAmount: Money;
    total: Money;
    paid: Money;
    pending: Money;
    overdue: Money;
    waived: Money;
    percent: number;
    installmentCount: number;
    paidInstallments: number;
    pendingInstallments: number;
    overdueInstallments: number;
    nextDueDate: string | null;
    lastPaidAt: string | null;
    isLiquidated: boolean;
}

export interface Summary {
    client: {
        folio: string;
        fullName: string;
        email: string | null;
        status: string;
        identity: string;
        identityType: string;
    };
    totals: {
        total: Money;
        paid: Money;
        pending: Money;
        overdue: Money;
        waived: Money;
        percent: number;
        installmentCount: number;
        paidInstallments: number;
        pendingInstallments: number;
        overdueInstallments: number;
        nextDueDate: string | null;
        lastPaidAt: string | null;
        isLiquidated: boolean;
        hasOverdue: boolean;
    };
    plans: PlanView[];
    paymentAccount: { bank: string; clabe: string; holder: string } | null;
}

export type PaymentStatus = 'pendiente' | 'aprobado' | 'rechazado' | 'reembolsado';
export type InstallmentState = 'pendiente' | 'pagado' | 'condonado' | 'vencido';

export interface PaymentItem {
    id: number;
    folio: string;
    amount: Money;
    appliedAmount: number;
    method: string;
    status: PaymentStatus;
    concept: string;
    reference: string | null;
    paidAt: string;
    approvedAt: string | null;
}

export interface InstallmentItem {
    id: number;
    planId: number;
    reference: string;
    seq: number;
    dueDate: string;
    originalDueDate: string | null;
    amount: Money;
    state: InstallmentState;
    paidAt: string | null;
}

export interface Paginated<T> {
    items: T[];
    pagination: {
        limit: number;
        offset: number;
        returned: number;
        total?: number;
        hasMore?: boolean;
    };
}

export interface PaymentInstructions {
    pending: Money;
    overdue: Money;
    credit: Money;
    nextDueDate: string | null;
    overdueInstallments: number;
    pendingInstallments: number;
    spei: {
        bank: string;
        clabe: string;
        holder: string;
        reference: string;
        concept: string;
        clabeValid: boolean;
        instructions: string[];
        deadlineHours: number;
    };
    card: { available: boolean; description: string };
}

export interface Dashboard {
    totals: {
        clients: number;
        activeClients: number;
        financed: Money;
        collected: Money;
        pending: Money;
        overdue: Money;
    };
    today: { payments: number; amount: Money };
    pendingReconcile: number;
    aging: { bucket: string; amount: Money; clients: number }[];
}

export interface PortfolioClient {
    id: number;
    folio: string;
    fullName: string;
    phone: string;
    status: string;
    speiClabe: string | null;
    activePlans: number;
    financed: Money;
    paid: Money;
    pending: Money;
    overdue: Money;
    maxDaysOverdue: number | null;
    nextDueDate: string | null;
    lastPaidAt: string | null;
}
