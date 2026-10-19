const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: unknown;

    constructor(status: number, code: string, message: string, details?: unknown) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }

    /** El backend explica siempre en campo: "Telefono o documento incorrecto". */
    get fieldMessage(): string | null {
        if (this.details && typeof this.details === 'object' && 'field' in this.details) {
            return (this.details as { field: string }).field;
        }
        return null;
    }
}

/**
 * El servicio puede estar despertandose.
 *
 * En un hosting con instancias gratuitas el proceso se apaga tras 15 minutos
 * sin trafico y tarda hasta un minuto en volver. Un fetch en ese instante falla
 * por red aunque todo este bien: distinguirlo de un fallo real evita que el
 * usuario vea "error inesperado" y piense que la aplicacion esta caida.
 */
export class ColdStartError extends Error {
    constructor() {
        super(
            'El servidor se esta activando. Esto puede tardar hasta un minuto; ' +
                'esta pagina se recargara sola en unos segundos.'
        );
        this.name = 'ColdStartError';
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reintenta ante fallos de red, no ante errores de la API.
 *
 * Un 401, un 409 o un 400 son respuestas definitivas: reintentarlos solo
 * duplicaria efectos (por ejemplo, registrar dos veces el mismo pago). Solo se
 * reintenta cuando la peticion ni siquiera llego a obtener respuesta.
 */
async function withColdStartRetry<T>(
    operation: () => Promise<T>,
    attempts = 4
): Promise<T> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            // Un ApiError significa que hubo respuesta: no se reintenta.
            if (error instanceof ApiError) throw error;
            // El navegador no distingue "sin red" de "conexion rechazada"
            // durante el apagado: cualquier fallo de red es candidato.

            if (attempt === attempts) break;

            // Espera creciente: 1s, 2s, 4s.
            await sleep(1000 * 2 ** (attempt - 1));
        }
    }

    throw new ColdStartError();
}

/**
 * El access token vive en memoria (no en localStorage): un XSS no puede leerlo
 * de ahi. El refresh token viaja en una cookie httpOnly que el navegador envia
 * solo y que JavaScript no puede leer. La renovacion ocurre de forma
 * transparente al recibir un 401.
 */
let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
    return accessToken;
}

export function setAccessToken(token: string | null): void {
    accessToken = token;
    for (const listener of listeners) listener(token);
}

export function onTokenChange(listener: (token: string | null) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
    body?: unknown;
    /** Rotacion manual desactivada en las llamadas de refresh. */
    skipRefresh?: boolean;
}

async function parseError(response: Response): Promise<ApiError> {
    let code = 'INTERNAL_ERROR';
    let message = `Error ${response.status}`;
    let details: unknown;

    try {
        const body = (await response.json()) as {
            error?: { code?: string; message?: string; details?: unknown };
        };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
        details = body.error?.details;
    } catch {
        // Respuesta sin JSON (proxy, 502, cutoff): se deja el mensaje generico.
    }

    return new ApiError(response.status, code, message, details);
}

/** Renueva la sesion. Las llamadas concurrentes comparten una sola promesa. */
async function refreshSession(): Promise<string | null> {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        try {
            const response = await fetch(`${BASE}/auth/refresh`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!response.ok) {
                setAccessToken(null);
                return null;
            }
            const data = (await response.json()) as { accessToken: string };
            setAccessToken(data.accessToken);
            return data.accessToken;
        } catch {
            setAccessToken(null);
            return null;
        } finally {
            refreshPromise = null;
        }
    })();

    return refreshPromise;
}

export async function apiRequest<T>(
    path: string,
    options: RequestOptions = {}
): Promise<T> {
    return withColdStartRetry(async () => {
        const { body, skipRefresh, headers, ...rest } = options;

        const send = async (token: string | null): Promise<Response> => {
            const finalHeaders = new Headers(headers);
            if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');
            if (token) finalHeaders.set('Authorization', `Bearer ${token}`);

            return fetch(`${BASE}${path}`, {
                ...rest,
                headers: finalHeaders,
                credentials: 'include',
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        };

        let response = await send(accessToken);

        // Un 401 con token presente casi siempre es caducidad: se rota y se
        // reintenta UNA vez. Nunca en bucle.
        if (response.status === 401 && accessToken && !skipRefresh) {
            const renewed = await refreshSession();
            if (renewed) response = await send(renewed);
        }

        if (!response.ok) throw await parseError(response);
        if (response.status === 204) return undefined as T;

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) return (await response.json()) as T;
        return (await response.text()) as T;
    });
}

export const api = {
    get: <T>(path: string) => apiRequest<T>(path),
    post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
    patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
};

/** Descarga un reporte binario (CSV/XLSX) disparando la descarga del navegador. */
export async function downloadReport(path: string, fallbackName: string): Promise<void> {
    const response = await fetch(`${BASE}${path}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        credentials: 'include',
    });

    if (!response.ok) throw await parseError(response);

    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = match?.[1] ?? fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

export { refreshSession };
