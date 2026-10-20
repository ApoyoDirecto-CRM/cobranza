/**
 * Que secciones del portal ve un cliente.
 *
 * El admin decide, cliente por cliente, que puede ver el titular. La fuente de
 * verdad es una sola columna JSONB (`clients.portal_view`): agregar una seccion
 * nueva no requiere una migracion, solo anadir la clave aqui y usarla.
 *
 * Las claves AUSENTES se interpretan como VISIBLES. Asi una fila antigua (o un
 * `{}` a medio construir) no oculta nada por accidente: el modo inseguro es
 * tener que escribir `false` a proposito.
 */

import { ValidationError } from './identity.js';

export const PORTAL_SECTIONS = [
    'summary',
    'plans',
    'installments',
    'payments',
    'paymentInstructions',
    'card',
] as const;

export type PortalSection = (typeof PORTAL_SECTIONS)[number];

export type PortalView = Record<PortalSection, boolean>;

/** Etiquetas para el panel administrativo. */
export const PORTAL_SECTION_LABELS: Record<PortalSection, string> = {
    summary: 'Resumen de saldos',
    plans: 'Mis creditos (planes)',
    installments: 'Calendario de cuotas',
    payments: 'Historial de pagos',
    paymentInstructions: 'Ficha de pago (SPEI/CLABE)',
    card: 'Pago con tarjeta',
};

export const PORTAL_VIEW_DEFAULTS: PortalView = {
    summary: true,
    plans: true,
    installments: true,
    payments: true,
    paymentInstructions: true,
    card: true,
};

export function isPortalSection(key: string): key is PortalSection {
    return (PORTAL_SECTIONS as readonly string[]).includes(key);
}

/**
 * Convierte lo que haya en la base (o `null`) en un `PortalView` completo.
 * Nunca lanza: una columna corrupta debe degradar a "todo visible", no romper
 * el portal.
 */
export function normalizePortalView(raw: unknown): PortalView {
    const view: PortalView = { ...PORTAL_VIEW_DEFAULTS };
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return view;
        }
    }
    if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        for (const key of PORTAL_SECTIONS) {
            const value = record[key];
            if (typeof value === 'boolean') view[key] = value;
        }
    }
    return view;
}

/**
 * Valida un parche parcial que llega del panel. Rechaza claves desconocidas y
 * valores que no sean boolean: es una frontera de la API, no se adivina.
 */
export function parsePortalViewPatch(input: unknown): Partial<PortalView> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ValidationError('portalView', 'La vista del portal debe ser un objeto');
    }
    const patch: Partial<PortalView> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!isPortalSection(key)) {
            throw new ValidationError('portalView', `Seccion de portal desconocida: "${key}"`);
        }
        if (typeof value !== 'boolean') {
            throw new ValidationError('portalView', `"${key}" debe ser verdadero o falso`);
        }
        patch[key] = value;
    }
    return patch;
}

/** Aplica un parche sobre la vista actual y devuelve la vista resultante. */
export function applyPortalViewPatch(current: unknown, patch: Partial<PortalView>): PortalView {
    return { ...normalizePortalView(current), ...patch };
}
