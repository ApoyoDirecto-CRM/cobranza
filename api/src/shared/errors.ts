import { ValidationError } from './identity.js';

/** Codigos de error estables: el frontend decide comportamiento, no el texto. */
export type ErrorCode =
    | 'VALIDATION_ERROR'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'ACCOUNT_LOCKED'
    | 'PAYMENT_ERROR'
    | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
    VALIDATION_ERROR: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    ACCOUNT_LOCKED: 423,
    PAYMENT_ERROR: 422,
    INTERNAL_ERROR: 500,
};

export class AppError extends Error {
    readonly code: ErrorCode;
    readonly statusCode: number;
    readonly details?: unknown;

    constructor(code: ErrorCode, message: string, details?: unknown) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.statusCode = STATUS_BY_CODE[code];
        if (details !== undefined) this.details = details;
    }
}

export const badRequest = (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, details);

export const unauthorized = (message = 'Credenciales invalidas') =>
    new AppError('UNAUTHORIZED', message);

export const forbidden = (message = 'No tienes permiso para esta accion') =>
    new AppError('FORBIDDEN', message);

export const notFound = (message = 'Recurso no encontrado') =>
    new AppError('NOT_FOUND', message);

export const conflict = (message: string) => new AppError('CONFLICT', message);

/** Traduce errores de PostgreSQL a mensajes de dominio. */
export function isPgUniqueViolation(error: unknown): error is { code: '23505'; constraint: string } {
    return (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === '23505'
    );
}

export function isPgCheckViolation(error: unknown): error is { code: '23514'; constraint: string } {
    return (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === '23514'
    );
}

export function isPgForeignKeyViolation(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null &&
        (error as { code?: string }).code === '23503'
    );
}

/** Atajo: convierte un ValidationError de la capa de normalizacion. */
export function fromValidationError(error: unknown): AppError | null {
    if (error instanceof ValidationError) {
        return new AppError('VALIDATION_ERROR', error.message, { field: error.field });
    }
    return null;
}
