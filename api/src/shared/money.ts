/**
 * Todo el dinero se maneja en CENTIMOS como entero.
 *
 * Motivo: PostgreSQL devuelve NUMERIC como cadena, y convertir a float
 * introduciria error de redondeo en saldos de cartera. El entero de
 * centimos hace que toda la aritmetica sea exacta y que el redondeo sea una
 * decision explicita (un solo punto: el reparto de la cuota final).
 */

/** Centimos -> numero decimal exacto para el JSON de la API. */
export function centsToNumber(cents: number): number {
    if (!Number.isSafeInteger(cents)) {
        throw new RangeError(`Importe fuera de rango seguro: ${cents}`);
    }
    return cents / 100;
}

/** Cadena decimal ("1234.50") -> centimos enteros. */
export function parseAmountToCents(value: string | number): number {
    const raw = typeof value === 'number' ? value.toString() : value.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
        throw new RangeError(`Importe invalido: "${value}" (se espera hasta 2 decimales)`);
    }
    const negative = raw.startsWith('-');
    const [whole = '0', decimals = ''] = raw.replace('-', '').split('.');
    const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
    return negative ? -cents : cents;
}

/** Salida de PostgreSQL (NUMERIC) -> centimos enteros. */
export function numericToCents(value: string | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    return parseAmountToCents(value);
}

/** Centimos -> cadena decimal para persistir. */
export function centsToNumeric(cents: number): string {
    const negative = cents < 0;
    const abs = Math.abs(cents);
    const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
    return negative ? `-${text}` : text;
}

/** Presentacion para el cliente: $1,234.50 */
export function formatCurrency(cents: number, locale = 'es-MX'): string {
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 2,
    }).format(centsToNumber(cents));
}

/** Redondeo half-up (no banker's rounding) para reparto de centimos. */
export function roundHalfUp(value: number): number {
    return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Reparte un total en n cuotas sin perder ni inventar centimos.
 * Las primeras n-1 cuotas son `base` y la ultima absorbe el residuo.
 * Es el unico lugar donde se decide el redondeo de un plan.
 */
export function splitIntoInstallments(totalCents: number, count: number): number[] {
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
        throw new RangeError('El total debe ser un entero de centimos positivo');
    }
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new RangeError('El numero de cuotas debe ser un entero >= 1');
    }
    if (totalCents < count) {
        throw new RangeError(
            `Un total de ${centsToNumeric(totalCents)} no se puede dividir en ${count} cuotas ` +
                'de al menos un centimo'
        );
    }
    const base = Math.floor(totalCents / count);
    const remainder = totalCents - base * count;
    const parts = new Array<number>(count).fill(base);
    parts[count - 1] = base + remainder;
    return parts;
}

/**
 * Porcentaje de liquidacion, acotado a 100 y con una decimada.
 * Se usa solo para mostrar: el saldo real siempre es la resta de importes.
 */
export function progressPercent(paidCents: number, totalCents: number): number {
    if (totalCents <= 0) return 0;
    const pct = (paidCents / totalCents) * 100;
    return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}
