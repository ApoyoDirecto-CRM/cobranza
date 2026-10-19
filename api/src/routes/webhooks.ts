import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/env.js';
import type { Queryable } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { badRequest, unauthorized } from '../shared/errors.js';
import { recordPayment, writeAudit } from '../services/payments.js';

/**
 * Firma del webhook segun el esquema mas habitual de las pasarelas:
 *
 *   firma = HMAC-SHA256(secret, timestamp + "." + cuerpoCrudo)
 *
 * Se compara en tiempo constante y se valida la ventana de tiempo: sin el
 * chequeo de timestamp, un webhook capturado se podria reenviar dias despues y
 * el unico freno seria la idempotencia por evento.
 */
export function signWebhook(
    secret: string,
    timestamp: number,
    rawBody: string
): string {
    return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhookSignature(args: {
    secret: string;
    header: string | undefined;
    rawBody: string;
    toleranceSeconds: number;
    now?: number;
}): void {
    const { secret, header, rawBody, toleranceSeconds, now = Date.now() } = args;
    if (!header) throw unauthorized('Falta la firma del webhook');

    // Formato aceptado: "t=1750000000,v1=<hex>" (estilo Stripe).
    const parts = Object.fromEntries(
        header.split(',').map((chunk) => {
            const index = chunk.indexOf('=');
            return index === -1
                ? [chunk.trim(), '']
                : [chunk.slice(0, index).trim(), chunk.slice(index + 1).trim()];
        })
    ) as { t?: string; v1?: string };

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) throw unauthorized('Firma de webhook mal formada');

    const driftSeconds = Math.abs(now / 1000 - timestamp);
    if (driftSeconds > toleranceSeconds) {
        throw unauthorized('La firma del webhook expiro');
    }

    const expected = signWebhook(secret, timestamp, rawBody);
    const provided = parts.v1 ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');

    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
        throw unauthorized('Firma de webhook invalida');
    }
}

/** Cuerpo minimo que la pasarela debe enviar. */
interface GatewayWebhookBody {
    id?: string;
    type?: string;
    created?: number;
    data?: {
        transactionId?: string;
        reference?: string;
        clientFolio?: string;
        amount?: string | number;
        cardLast4?: string;
        paidAt?: string;
        status?: string;
    };
}

export interface WebhookDeps {
    db: Queryable;
    /** Resuelve el cliente a partir de los datos del webhook. */
    resolveClientId: (body: GatewayWebhookBody) => Promise<number | null>;
}

export async function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDeps): Promise<void> {
    const { db, resolveClientId } = deps;

    app.post<{ Body: GatewayWebhookBody }>(
        '/webhooks/pasarela',
        {
            schema: {
                tags: ['Webhooks'],
                summary: 'Notificaciones de la pasarela de pago',
                description:
                    'Endpoint publico. La seguridad no depende del secreto de la URL sino de ' +
                    'la firma HMAC del cuerpo. Es idempotente por (provider, event id): ' +
                    'reenviar el mismo evento no duplica el pago.',
                body: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        type: { type: 'string' },
                        created: { type: 'integer' },
                        data: { type: 'object', additionalProperties: true },
                    },
                },
            },
        },
        async (request, reply) => {
            // El cuerpo CRUDO es lo que se firma: usar el objeto ya parseado
            // invalidaria la firma en cuanto cambie el orden de las claves.
            const rawBody = request.rawBody ?? JSON.stringify(request.body ?? {});

            verifyWebhookSignature({
                secret: config.webhook.secret,
                header: request.headers['x-webhook-signature'] as string | undefined,
                rawBody,
                toleranceSeconds: config.webhook.toleranceSeconds,
            });

            const body = request.body ?? {};
            const externalEventId = body.id;
            if (!externalEventId || !body.type) {
                throw badRequest('El evento debe traer id y type');
            }

            // Respuesta rapida para la pasarela; el procesamiento va aparte.
            const accepted = await withTransaction(db, async (tx) => {
                const inserted = await tx.query<{ id: string }>(
                    `INSERT INTO webhook_events
                       (provider, external_event_id, event_type, payload, signature, status)
                     VALUES ('pasarela', $1, $2, $3::jsonb, $4, 'recibido')
                     ON CONFLICT (provider, external_event_id) DO NOTHING
                     RETURNING id`,
                    [externalEventId, body.type, JSON.stringify(body), request.headers['x-webhook-signature'] ?? null]
                );
                return inserted.rows[0];
            });

            if (!accepted) {
                // Duplicado: se responde 200 para que la pasarela deje de reintentar.
                return reply.code(200).send({ received: true, duplicate: true });
            }

            const eventId = Number(accepted.id);

            try {
                if (body.type !== 'payment.succeeded') {
                    await db.query(
                        `UPDATE webhook_events SET status = 'procesado', processed_at = now(),
                                error_message = $2 WHERE id = $1`,
                        [eventId, `Evento ignorado: ${body.type}`]
                    );
                    return reply.code(202).send({ received: true, ignored: true });
                }

                const data = body.data ?? {};
                const clientId = await resolveClientId(body);

                if (!clientId) {
                    await db.query(
                        `UPDATE webhook_events SET status = 'fallido', processed_at = now(),
                                error_message = 'No se pudo resolver el cliente' WHERE id = $1`,
                        [eventId]
                    );
                    throw badRequest('No se pudo asociar el evento a un cliente');
                }

                const payment = await recordPayment(db, {
                    clientId,
                    amount: data.amount ?? 0,
                    method: 'tarjeta',
                    origin: 'webhook',
                    status: 'aprobado',
                    paidAt: data.paidAt ?? new Date().toISOString().slice(0, 10),
                    concept: `Cobro con tarjeta ${data.transactionId ?? ''}`.trim(),
                    reference: data.reference,
                    provider: 'pasarela',
                    providerPaymentId: data.transactionId,
                    webhookEventId: eventId,
                    methodLast4: data.cardLast4,
                });

                await db.query(
                    `UPDATE webhook_events SET status = 'procesado', processed_at = now(),
                            payment_id = $2 WHERE id = $1`,
                    [eventId, payment.id]
                );

                await writeAudit(db, {
                    actorType: 'admin',
                    actorId: null,
                    action: 'webhook.payment_succeeded',
                    entityType: 'payment',
                    entityId: payment.folio,
                    after: { eventId: externalEventId, clientId },
                });

                return reply.code(201).send({
                    received: true,
                    paymentId: payment.id,
                    folio: payment.folio,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Error desconocido';
                await db.query(
                    `UPDATE webhook_events
                        SET status = 'fallido', processed_at = now(), error_message = $2,
                            attempts = attempts + 1
                      WHERE id = $1`,
                    [eventId, message.slice(0, 1000)]
                );
                throw error;
            }
        }
    );
}
