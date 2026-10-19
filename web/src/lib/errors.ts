import { ApiError } from '../api/client';

/**
 * Mensaje de error apto para mostrar.
 *
 * El backend ya explica los errores de dominio con precision ("Telefono o
 * documento incorrecto"), asi que se respeta su texto. Para lo demas se
 * distingue: una falla de red en un hosting con instancias gratuitas suele
 * significar "el servidor se esta despertando", no "la aplicacion esta rota".
 */
export function errorMessage(error: unknown, fallback = 'Ocurrio un error inesperado.'): string {
    if (error instanceof ApiError) return error.message;
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim() !== '') return error;
    return fallback;
}
