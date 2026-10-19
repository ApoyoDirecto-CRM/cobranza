import { splitIntoInstallments } from '../shared/money.js';

export type Frequency = 'semanal' | 'quincenal' | 'mensual';

export interface ScheduleInput {
    /** Monto total del plan en centimos. */
    totalCents: number;
    /** Numero de cuotas. */
    count: number;
    frequency: Frequency;
    /** Primera cuota, formato YYYY-MM-DD. */
    startDate: string;
    /**
     * Mueve al siguiente dia habil las cuotas que caen sabado o domingo.
     * En cobranza importa: nadie liquida un sabado, y una cuota que vence en
     * fin de semana se reporta como vencida de forma injusta.
     */
    skipWeekends?: boolean;
}

export interface ScheduledInstallment {
    seq: number;
    /** Vencimiento, formato YYYY-MM-DD. */
    dueDate: string;
    amountCents: number;
}

export interface Schedule {
    installments: ScheduledInstallment[];
    /** Cuota nominal (la de las n-1 primeras). */
    installmentAmountCents: number;
    /** Vencimiento de la ultima cuota. */
    endDate: string;
}

const MS_PER_DAY = 86_400_000;

const DAY_STEPS: Record<Frequency, number> = {
    semanal: 7,
    quincenal: 14,
    mensual: 0, // se resuelve con aritmetica de meses
};

/** Convierte una fecha UTC a YYYY-MM-DD sin pasar por la zona horaria local. */
export function toISODate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Parseo a medianoche UTC. Rechaza fechas ambiguas como 2026-02-31. */
export function parseISODate(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new RangeError(`Fecha invalida: "${value}" (se espera AAAA-MM-DD)`);
    }
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        throw new RangeError(`Fecha inexistente en el calendario: "${value}"`);
    }
    return date;
}

export function addDays(isoDate: string, days: number): string {
    const date = parseISODate(isoDate);
    return toISODate(new Date(date.getTime() + days * MS_PER_DAY));
}

/**
 * Suma meses recortando al ultimo dia del mes destino: 31-ene + 1 mes = 28/29
 * de febrero, no 3 de marzo. Sin este recorte, un plan mensual arrancado a
 * fin de mes se desalinea respecto al calendario real de cobra.
 */
export function addMonths(isoDate: string, months: number): string {
    const date = parseISODate(isoDate);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();

    const targetMonthStart = new Date(Date.UTC(year, month + months, 1));
    const targetYear = targetMonthStart.getUTCFullYear();
    const targetMonth = targetMonthStart.getUTCMonth();
    const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    return toISODate(new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDayOfTargetMonth))));
}

/** Sabado = 6, domingo = 0. */
function isWeekend(isoDate: string): boolean {
    const day = parseISODate(isoDate).getUTCDay();
    return day === 0 || day === 6;
}

/** Sabado y domingo -> lunes siguiente. */
function nextBusinessDay(isoDate: string): string {
    const day = parseISODate(isoDate).getUTCDay();
    if (day === 6) return addDays(isoDate, 2);
    if (day === 0) return addDays(isoDate, 1);
    return isoDate;
}

/**
 * Genera el calendario de cuotas de un plan.
 *
 * Decision de redondeo: la ultima cuota absorbe la diferencia para que la
 * suma sea exactamente el total. Si n-1 cuotas valen `base`, la ultima vale
 * `base + residuo`. Es la unica fuente de verdad del calendario; el alta del
 * plan y el calculo del portal usan esta misma funcion.
 */
export function buildSchedule(input: ScheduleInput): Schedule {
    const { totalCents, count, frequency, startDate, skipWeekends = false } = input;

    // Valida el formato de la fecha antes de calcular nada.
    parseISODate(startDate);

    const amounts = splitIntoInstallments(totalCents, count);
    const step = DAY_STEPS[frequency];

    const installments: ScheduledInstallment[] = [];
    let dueDate = startDate;

    for (let i = 0; i < count; i++) {
        const rawDate = i === 0 ? startDate : advance(dueDate, frequency, step);
        dueDate = skipWeekends ? nextBusinessDay(rawDate) : rawDate;
        installments.push({
            seq: i + 1,
            dueDate,
            amountCents: amounts[i] as number,
        });
    }

    const last = installments[installments.length - 1] as ScheduledInstallment;

    return {
        installments,
        installmentAmountCents: amounts[0] as number,
        endDate: last.dueDate,
    };
}

/**
 * Avanza desde la fecha ya emitida. Se usa el vencimiento real como base (y no
 * `startDate + n*step`) para que el desplazamiento por fines de semana no se
 * acumule ni se pierda.
 */
function advance(previousDueDate: string, frequency: Frequency, dayStep: number): string {
    return frequency === 'mensual'
        ? addMonths(previousDueDate, 1)
        : addDays(previousDueDate, dayStep);
}

/** Dias de atraso de una cuota a una fecha dada (0 si aun no vence). */
export function daysOverdue(dueDate: string, today: string): number {
    const diff = parseISODate(today).getTime() - parseISODate(dueDate).getTime();
    return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}
