import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { PaymentInstructions } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { Alert, SkeletonCard, EmptyState } from '../components/ui';
import { formatDate } from '../lib/format';

type Tab = 'spei' | 'tarjeta';

/** Copia al portapapeles con fallback para navegadores sin APIClipboard. */
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // ctx bloqueado o permiso denegado: se intenta el metodo antiguo.
    }

    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch {
        return false;
    }
}

export function PortalPayPage() {
    const [data, setData] = useState<PaymentInstructions | null>(null);
    const [tab, setTab] = useState<Tab>('spei');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [cardAmount, setCardAmount] = useState('');
    const [cardBusy, setCardBusy] = useState(false);
    const [cardError, setCardError] = useState<string | null>(null);
    const navigate = useNavigate();

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await api.get<PaymentInstructions>('/portal/payment-instructions');
            setData(result);
            setCardAmount(result.pending.amount.toFixed(2));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos cargar la ficha de pago.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const handleCopy = async (value: string, label: string) => {
        const ok = await copyToClipboard(value);
        setCopied(ok ? label : null);
        if (ok) setTimeout(() => setCopied(null), 2200);
    };

    const startCardPayment = async () => {
        setCardBusy(true);
        setCardError(null);
        try {
            const session = await api.post<{ sessionId: string }>('/portal/payments/card-session', {
                amount: cardAmount,
            });
            // Aqui se montaria el formulario tokenizado de la pasarela usando
            // session.publicKey. El PAN nunca pasa por nuestra API.
            void session.sessionId;
            setCardError(
                'El pago con tarjeta se habilita al conectar la pasarela. ' +
                'Por ahora usa la transferencia SPEI.'
            );
        } catch (err) {
            setCardError(err instanceof ApiError ? err.message : 'No pudimos iniciar el cobro.');
        } finally {
            setCardBusy(false);
        }
    };

    if (loading) {
        return (
            <div className="container page">
                <SkeletonCard />
                <div style={{ height: 16 }} />
                <SkeletonCard />
            </div>
        );
    }

    if (error || !data) {
        return <ErrorState error={error ?? new Error('Sin datos')} onRetry={() => void load()} />;
    }

    const sinSaldo = data.pending.amount <= 0;

    return (
        <div className="container page">
            <header className="page-header">
                <h1>Realizar un pago</h1>
            </header>

            {sinSaldo ? (
                <div className="card">
                    <EmptyState icon="🎉" title="No tienes saldo pendiente">
                        Tu credito esta al corriente. No hay nada que pagar por ahora.
                    </EmptyState>
                    <button
                        className="btn btn-secondary btn-block"
                        onClick={() => navigate('/portal')}
                    >
                        Volver al inicio
                    </button>
                </div>
            ) : (
                <>
                    <section className="card" aria-label="Resumen del adeudo">
                        <div className="row-between">
                            <div>
                                <div className="small muted">Total a pagar</div>
                                <div style={{ fontSize: '1.75rem', fontWeight: 800 }}>
                                    {data.pending.formatted}
                                </div>
                            </div>
                            {data.overdue.amount > 0 ? (
                                <div style={{ textAlign: 'right' }}>
                                    <div className="small muted">Vencido</div>
                                    <div className="amount amount-negative" style={{ fontSize: '1.1rem' }}>
                                        {data.overdue.formatted}
                                    </div>
                                </div>
                            ) : null}
                        </div>

                        {data.credit.amount > 0 ? (
                            <div style={{ marginTop: 12 }}>
                                <Alert tone="info">
                                    Tienes {data.credit.formatted} a favor. Se aplicara automaticamente
                                    a tu proximo pago.
                                </Alert>
                            </div>
                        ) : null}

                        {data.nextDueDate ? (
                            <p className="small muted" style={{ marginTop: 12 }}>
                                Proximo vencimiento: {formatDate(data.nextDueDate)}
                            </p>
                        ) : null}
                    </section>

                    {/* Selector de metodo: dos pestañas grandes, pensadas para el dedo. */}
                    <div
                        role="tablist"
                        aria-label="Metodo de pago"
                        className="row"
                        style={{ gap: 8, margin: '16px 0' }}
                    >
                        <button
                            role="tab"
                            aria-selected={tab === 'spei'}
                            className={`btn btn-block ${tab === 'spei' ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setTab('spei')}
                        >
                            🏦 Transferencia SPEI
                        </button>
                        <button
                            role="tab"
                            aria-selected={tab === 'tarjeta'}
                            className={`btn btn-block ${tab === 'tarjeta' ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setTab('tarjeta')}
                        >
                            💳 Tarjeta
                        </button>
                    </div>

                    {tab === 'spei' ? (
                        <section className="card" role="tabpanel" aria-label="Pago por transferencia">
                            <h2 style={{ marginBottom: 12 }}>Datos para tu transferencia</h2>

                            <div className="field">
                                <label htmlFor="clabe">CLABE</label>
                                <div className="clabe-box" id="clabe">{data.spei.clabe}</div>
                                {!data.spei.clabeValid ? (
                                    <p className="field-error">
                                        Ojo: esta CLABE no supera la validacion del digito de control.
                                        Contacta a tu asesor antes de transferir.
                                    </p>
                                ) : null}
                                <button
                                    className="btn btn-secondary btn-sm btn-block"
                                    style={{ marginTop: 8 }}
                                    onClick={() => void handleCopy(data.spei.clabe, 'CLABE')}
                                >
                                    {copied === 'CLABE' ? '✓ Copiada' : 'Copiar CLABE'}
                                </button>
                            </div>

                            <div className="field">
                                <label htmlFor="beneficiario">Beneficiario</label>
                                <input id="beneficiario" value={data.spei.holder} readOnly />
                            </div>

                            <div className="field">
                                <label htmlFor="banco">Banco</label>
                                <input id="banco" value={data.spei.bank} readOnly />
                            </div>

                            <div className="field">
                                <label htmlFor="concepto">Concepto (importante)</label>
                                <div className="row" style={{ gap: 8 }}>
                                    <input
                                        id="concepto"
                                        value={data.spei.reference}
                                        readOnly
                                        className="mono"
                                        style={{ flex: 1, minWidth: 0 }}
                                    />
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => void handleCopy(data.spei.reference, 'Concepto')}
                                    >
                                        {copied === 'Concepto' ? '✓' : 'Copiar'}
                                    </button>
                                </div>
                                <p className="field-hint">
                                    Sin este concepto no podemos identificar tu pago y tendras que
                                    esperar la conciliacion bancaria.
                                </p>
                            </div>

                            <h3 style={{ margin: '20px 0 12px' }}>Como hacerlo</h3>
                            <ol className="steps">
                                {data.spei.instructions.map((step) => (
                                    <li key={step}>{step}</li>
                                ))}
                            </ol>

                            <Alert tone="warn">
                                El pago se refleja en tu historial en cuanto se concilie, normalmente
                                el mismo dia habil. Conserva tu comprobante.
                            </Alert>
                        </section>
                    ) : (
                        <section className="card" role="tabpanel" aria-label="Pago con tarjeta">
                            <h2 style={{ marginBottom: 12 }}>Pago con tarjeta</h2>
                            <p className="small muted" style={{ marginBottom: 16 }}>
                                {data.card.description}
                            </p>

                            {cardError ? (
                                <div style={{ marginBottom: 12 }}>
                                    <Alert tone="warn">{cardError}</Alert>
                                </div>
                            ) : null}

                            <div className="field">
                                <label htmlFor="card-amount">Monto a pagar</label>
                                <input
                                    id="card-amount"
                                    type="number"
                                    inputMode="decimal"
                                    step="0.01"
                                    min="1"
                                    value={cardAmount}
                                    onChange={(e) => setCardAmount(e.target.value)}
                                />
                                <p className="field-hint">
                                    Puedes pagar menos de tu saldo total; el excedente queda a tu
                                    favor.
                                </p>
                            </div>

                            <button
                                className="btn btn-success btn-block"
                                disabled={cardBusy || !cardAmount}
                                onClick={() => void startCardPayment()}
                            >
                                {cardBusy ? <span className="spinner" aria-hidden="true" /> : null}
                                {cardBusy ? 'Preparando' : `Pagar ${cardAmount ? `$${cardAmount}` : ''}`}
                            </button>

                            <p className="small muted" style={{ marginTop: 16 }}>
                                🔒 Tu tarjeta se procesa directamente con la pasarela. Este sistema nunca
                                almacena el numero de tu tarjeta.
                            </p>
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
