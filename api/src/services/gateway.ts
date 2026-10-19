import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { AppError } from '../shared/errors.js';
import type { CardSessionInput, CardSessionResult } from '../routes/portal.js';

/**
 * Adaptador de la pasarela de tarjeta.
 *
 * Decisiones de seguridad:
 *   - El PAN, CVV y fecha de expiracion NUNCA pasan por este servidor. El
 *     navegador tokeniza directamente contra la pasarela usando la clave publica
 *     que devuelve createCardSession.
 *   - Esta API solo genera la sesion de cobro y recibe el resultado por webhook
 *     firmado. Por eso el webhook es la unica via que puede crear un pago con
 *     tarjeta: una respuesta del navegador no es evidencia suficiente.
 *
 * Para integrar una pasarela real (Stripe, Conekta, Clip, OpenPay...) se
 * implementa `chargeCard` y se inyecta en app.ts. Aqui queda una version de
 * desarrollo que falla de forma explicita en lugar de simular un cobro, para
 * que nadie confunda un mock con un pago real.
 */
export interface CardGateway {
    createCardSession(input: CardSessionInput): Promise<CardSessionResult>;
}

export class UnconfiguredCardGateway implements CardGateway {
    async createCardSession(): Promise<CardSessionResult> {
        throw new AppError(
            'PAYMENT_ERROR',
            'El pago con tarjeta no esta habilitado: falta configurar GATEWAY_MERCHANT_ID ' +
                'y GATEWAY_API_BASE. Usa la transferencia SPEI mientras tanto.'
        );
    }
}

/** Implementacion contra la API HTTP de la pasarela. */
export class HttpCardGateway implements CardGateway {
    constructor(
        private readonly options: {
            baseUrl: string;
            merchantId: string;
            publicKey: string;
            fetchImpl?: typeof fetch;
        }
    ) {}

    async createCardSession(input: CardSessionInput): Promise<CardSessionResult> {
        const doFetch = this.options.fetchImpl ?? fetch;

        const response = await doFetch(`${this.options.baseUrl}/card/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': input.idempotencyKey,
                Authorization: `Bearer ${this.options.merchantId}`,
            },
            body: JSON.stringify({
                amount: input.amountCents,
                currency: 'MXN',
                reference: `cliente-${input.clientId}`,
                metadata: {
                    clientId: input.clientId,
                    installmentId: input.installmentId ?? null,
                },
            }),
        });

        if (!response.ok) {
            throw new AppError(
                'PAYMENT_ERROR',
                `La pasarela rechazo la sesion de cobro (HTTP ${response.status})`
            );
        }

        const data = (await response.json()) as {
            id: string; expires_at?: string; public_key?: string;
        };

        return {
            sessionId: data.id,
            publicKey: data.public_key ?? this.options.publicKey,
            expiresAt: data.expires_at ?? new Date(Date.now() + 30 * 60_000).toISOString(),
        };
    }
}

/** Resuelve la pasarela segun lo que haya configurado el entorno. */
export function createCardGateway(): CardGateway {
    if (config.gateway.apiBase && config.gateway.merchantId) {
        return new HttpCardGateway({
            baseUrl: config.gateway.apiBase,
            merchantId: config.gateway.merchantId,
            publicKey: config.gateway.publicKey,
        });
    }
    return new UnconfiguredCardGateway();
}

/**
 * Genera una referencia de pago legible, util cuando el cliente paga por SPEI y
 * hay que conciliar despues sin consultar la base.
 */
export function buildPaymentReference(folio: string, nonce = randomUUID().slice(0, 6)): string {
    return `${folio}-${nonce}`.toUpperCase();
}
