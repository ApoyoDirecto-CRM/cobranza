import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { Summary } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { Alert, ProgressBar, SkeletonCard, Badge, EmptyState } from '../components/ui';
import { formatDate, relativeDue, FREQUENCY_LABEL } from '../lib/format';

export function PortalDashboardPage() {
    const { portalUser } = useAuth();
    const [summary, setSummary] = useState<Summary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setSummary(await api.get<Summary>('/portal/summary'));
        } catch (err) {
            setError(
                err instanceof ApiError
                    ? err.message
                    : 'No pudimos cargar tu informacion. Revisa tu conexion.'
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    if (loading) {
        return (
            <div className="container page">
                <SkeletonCard />
                <div style={{ height: 16 }} />
                <SkeletonCard />
            </div>
        );
    }

    if (error || !summary) {
        return <ErrorState error={error ?? new Error('Sin datos')} onRetry={() => void load()} />;
    }

    const { client, totals, plans } = summary;
    const view = portalUser?.view;
    const payVisible = Boolean(view && (view.paymentInstructions || view.card));

    return (
        <div className="container page">
            <header className="page-header">
                <div>
                    <h1>Hola, {client.fullName.split(' ')[0]}</h1>
                    <p className="small muted">
                        Folio {client.folio} · {client.identity}
                    </p>
                </div>
            </header>

            {totals ? (
                <>
                    {/* Tarjeta principal: total, pagado y saldo pendiente. */}
                    <section className="card balance-card" aria-labelledby="saldo-title">
                        <span className="label" id="saldo-title">Saldo pendiente</span>
                        <div className="amount">{totals.pending.formatted}</div>

                        <ProgressBar
                            percent={totals.percent}
                            label={`${totals.paidInstallments} de ${totals.installmentCount} cuotas pagadas`}
                        />

                        <dl className="balance-grid">
                            <div>
                                <dt>Monto total del plan</dt>
                                <dd>{totals.total.formatted}</dd>
                            </div>
                            <div>
                                <dt>Total acumulado pagado</dt>
                                <dd>{totals.paid.formatted}</dd>
                            </div>
                            <div>
                                <dt>Cuotas pendientes</dt>
                                <dd>{totals.pendingInstallments}</dd>
                            </div>
                            <div>
                                <dt>Proximo vencimiento</dt>
                                <dd>{totals.nextDueDate ? formatDate(totals.nextDueDate) : '—'}</dd>
                            </div>
                        </dl>
                    </section>

                    {totals.hasOverdue ? (
                        <div style={{ marginTop: 16 }}>
                            <Alert tone="error">
                                Tienes {totals.overdue.formatted} vencido
                                {totals.overdueInstallments === 1 ? '' : 's'} en{' '}
                                {totals.overdueInstallments}{' '}
                                {totals.overdueInstallments === 1 ? 'cuota' : 'cuotas'}. Regulariza tu pago
                                para actualizar tu historial.
                            </Alert>
                        </div>
                    ) : null}

                    {totals.isLiquidated ? (
                        <div style={{ marginTop: 16 }}>
                            <Alert tone="ok">
                                Tu credito esta liquidado. Gracias por cumplir.
                            </Alert>
                        </div>
                    ) : payVisible ? (
                        <div className="row" style={{ marginTop: 16, gap: 12 }}>
                            <Link to="/portal/pagar" className="btn btn-success btn-block">
                                Pagar ahora
                            </Link>
                        </div>
                    ) : null}
                </>
            ) : null}

            {/* Detalle por plan. */}
            {view?.plans ? (
                <section className="card" style={{ marginTop: 24 }} aria-labelledby="planes-title">
                    <div className="card-title">
                        <h2 id="planes-title">Mis creditos</h2>
                        <Badge tone="info">{plans.length} {plans.length === 1 ? 'plan' : 'planes'}</Badge>
                    </div>

                    {plans.length === 0 ? (
                        <EmptyState icon="📄" title="Aun no tienes creditos">
                            Cuando se registre un plan a tu nombre aparecera aqui.
                        </EmptyState>
                    ) : (
                        <ul className="list">
                            {plans.map((plan) => (
                                <li key={plan.id} className="list-item">
                                    <div className="grow">
                                        <div className="title">{plan.productName}</div>
                                        <div className="subtitle">
                                            {plan.reference} · {FREQUENCY_LABEL[plan.frequency] ?? plan.frequency}
                                            {' · '}Cuota {plan.installmentAmount.formatted}
                                        </div>
                                        <div className="subtitle" style={{ marginTop: 4 }}>
                                            {plan.isLiquidated
                                                ? 'Liquidado'
                                                : `${relativeDue(plan.nextDueDate)} · ${formatDate(plan.nextDueDate)}`}
                                        </div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div className="amount">
                                            {plan.isLiquidated ? '✓' : plan.pending.formatted}
                                        </div>
                                        <div className="subtitle">{plan.percent.toFixed(0)}% pagado</div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ) : null}

            <p className="small muted center" style={{ marginTop: 24 }}>
                ¿Necesitas ayuda? Contacta a tu asesor.
            </p>
        </div>
    );
}
