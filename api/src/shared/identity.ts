/**
 * Normalizacion y validacion de identidad.
 *
 * El portal autentica con (telefono, DNI/CURP). Antes de tocar la base de
 * datos TODO pasa por aqui: la columna CHAR(10) y el CHECK de CURP solo son
 * la ultima linea de defensa, no la primera.
 */

export type IdentityType = 'curp' | 'dni';

export class ValidationError extends Error {
    readonly field: string;
    constructor(field: string, message: string) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
    }
}

/**
 * Telefono mexicano de 10 digitos. Acepta lo que la gente realmente escribe:
 * espacios, guiones, parentesis y el prefijo +52.
 */
export function normalizePhone(input: string): string {
    if (typeof input !== 'string') throw new ValidationError('phone', 'El telefono es obligatorio');

    let digits = input.replace(/\D/g, '');

    // +52 1XXXXXXXXXX (12-13 digitos) -> se descarta pais y movil de 13.
    if (digits.length === 13 && digits.startsWith('521')) digits = digits.slice(3);
    else if (digits.length === 12 && digits.startsWith('52')) digits = digits.slice(2);

    if (digits.length !== 10) {
        throw new ValidationError(
            'phone',
            'El telefono debe tener 10 digitos (aceptamos +52 o formato con guiones)'
        );
    }
    if (/^(\d)\1{9}$/.test(digits)) {
        throw new ValidationError('phone', 'El telefono no parece valido');
    }
    return digits;
}

/** Formato de agrupacion para mostrar: 55 1234 5678 */
export function formatPhone(digits: string): string {
    return `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
}

/**
 * CURP: 4 letras + 6 digitos de fecha + 8 alfanumericos (RENAPO).
 * Se valida que la fecha exista: detecta el error de tecleo mas comun
 * (confundir el formato YYMMDD con DDMMYY) sin rechazar CURPs reales por
 * variaciones de homoclave.
 */
const CURP_RE = /^[A-Z]{4}[0-9]{6}[A-Z0-9]{8}$/;
const DNI_RE = /^[0-9]{13}$/;

export function normalizeIdentity(input: string): string {
    if (typeof input !== 'string') {
        throw new ValidationError('identityId', 'El CURP o DNI es obligatorio');
    }
    const value = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (value.length !== 18 && value.length !== 13) {
        throw new ValidationError(
            'identityId',
            'El documento debe tener 18 caracteres (CURP) o 13 digitos (DNI)'
        );
    }
    return value;
}

/** Deduce el tipo a partir del formato, sin adivinar. */
export function detectIdentityType(value: string): IdentityType {
    return value.length === 18 ? 'curp' : 'dni';
}

/** Valida la coherencia interna del documento. */
export function validateIdentity(input: string): { type: IdentityType; value: string } {
    const value = normalizeIdentity(input);
    const type = detectIdentityType(value);

    if (type === 'dni') {
        if (!DNI_RE.test(value)) {
            throw new ValidationError('identityId', 'El DNI debe tener 13 digitos');
        }
        return { type, value };
    }

    if (!CURP_RE.test(value)) {
        throw new ValidationError(
            'identityId',
            'La CURP debe tener 18 caracteres: 4 letras, 6 de fecha y 8 alfanumericos'
        );
    }

    const yy = Number(value.slice(4, 6));
    const mm = Number(value.slice(6, 8));
    const dd = Number(value.slice(8, 10));
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
        throw new ValidationError('identityId', 'La fecha de la CURP no es valida');
    }
    // Dias por mes con febrero como caso limite.
    const daysInMonth = [31, (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0 ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (dd > daysInMonth[mm - 1]!) {
        throw new ValidationError('identityId', 'La fecha de la CURP no es valida');
    }
    return { type, value };
}

/** Comparacion en tiempo constante para no filtrar el documento por tiempos. */
export function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** CURP parcialmente enmascarada para mostrar en el portal. */
export function maskIdentity(value: string): string {
    if (value.length <= 6) return value;
    return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

export function normalizeEmail(input: string): string {
    const value = input.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        throw new ValidationError('email', 'El correo no tiene un formato valido');
    }
    return value;
}

/** Referencia de contrato: solo alfanumericos y guiones, en mayusculas. */
export function normalizeReference(input: string): string {
    const value = input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (value.length < 3 || value.length > 40) {
        throw new ValidationError('reference', 'La referencia debe tener entre 3 y 40 caracteres');
    }
    return value;
}
