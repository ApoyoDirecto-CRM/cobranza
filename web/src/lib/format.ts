/** Formateo de fechas en es-MX, sin dependencias. */

const MONTHS = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** 'YYYY-MM-DD' -> '15 de marzo de 2026' */
export function formatDate(value: string | null): string {
    if (!value) return '—';
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return value;

    const [, year, month, day] = match as unknown as [string, string, string, string];
    return `${Number(day)} de ${MONTHS[Number(month) - 1]} de ${year}`;
}

/** 'YYYY-MM-DD' -> '15 mar' */
export function formatDateShort(value: string | null): string {
    if (!value) return '—';
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return value;

    const [, , month, day] = match as unknown as [string, string, string, string];
    return `${Number(day)} ${MONTHS[Number(month) - 1]?.slice(0, 3)}`;
}

/** Timestamp ISO -> '15 mar 2026, 14:30' */
export function formatDateTime(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;

    return date.toLocaleDateString('es-MX', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    }) + ', ' + date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

/** Telefono de 10 digitos -> '55 1234 5678' */
export function formatPhone(digits: string | null): string {
    if (!digits) return '—';
    const clean = digits.replace(/\D/g, '');
    if (clean.length !== 10) return digits;
    return `${clean.slice(0, 2)} ${clean.slice(2, 6)} ${clean.slice(6)}`;
}

/** Dias que faltan para un vencimiento; negativo si ya vencio. */
export function daysUntil(value: string | null): number | null {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) return null;

    const [, year, month, day] = match as unknown as [string, string, string, string];
    const target = Date.UTC(Number(year), Number(month) - 1, Number(day));
    const today = new Date();
    const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    return Math.round((target - now) / 86_400_000);
}

/** 'vence en 5 dias' / 'vencio hace 12 dias' */
export function relativeDue(value: string | null): string {
    const days = daysUntil(value);
    if (days === null) return '—';
    if (days === 0) return 'Vence hoy';
    if (days === 1) return 'Vence manana';
    if (days > 1) return `Vence en ${days} dias`;
    if (days === -1) return 'Vencio ayer';
    return `Vencio hace ${Math.abs(days)} dias`;
}

export const FREQUENCY_LABEL: Record<string, string> = {
    semanal: 'Semanal',
    quincenal: 'Quincenal',
    mensual: 'Mensual',
};
