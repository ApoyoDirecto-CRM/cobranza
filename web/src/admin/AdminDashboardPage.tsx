import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, downloadReport } from '../api/client';
import type { Dashboard } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { SkeletonCard, Badge } from '../components/ui';

const AGING_LABEL: Record<string, string> = {
    '1-30': '1 a 30 dias',
    '31-60': '31 a 60 dias',
    '61-90': '61 a 90 dias',
    '90+': 'Mas de 90 dias',
};

export function AdminDashboardPage() {
    const [data, setData] = useState<Dashboard | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setData(await api.get<Dashboard>('/admin/dashboard'));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos cargar el dashboard.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const download = async (format: 'csv' | 'xlsx') => {
        setDownloading(format);
        try {
            await downloadReport(
                `/admin/export/cartera.${format}`,
                `cartera.${format}`
            );
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos generar el archivo.');
        } finally {
            setDownloading(null);
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

    const vencidoPct =
        data.totals.pending.amount > 0
            ? (data.totals.overdue.amount / data.totals.pending.amount) * 100
            : 0;

    return (
        <div className="container page">
            <header className="page-header">
                <h1>Cartera</h1>
                <div className="row" style={{ gap: 8 }}>
                    <button
                        className="btn btn-secondary btn-sm"
                        disabled={downloading === 'csv'}
                        onClick={() => void download('csv')}
                    >
                        {downloading === 'csv' ? 'Generando…' : 'Exportar CSV'}
                    </button>
                    <button
                        className="btn btn-secondary btn-sm"
                        disabled={downloading === 'xlsx'}
                        onClick={() => void download('xlsx')}
                    >
                        {downloading === 'xlsx' ? 'Generando…' : 'Exportar Excel'}
                    </button>
                </div>
            </header>

            <div className="grid grid-4">
                <div className="stat">
                    <div className="label">Clientes activos</div>
                    <div className="value">{data.totals.activeClients}</div>
                    <div className="small muted">de {data.totals.clients} registrados</div>
                </div>
                <div className="stat">
                    <div className="label">Cobrado</div>
                    <div className="value amount-positive">{data.totals.collected.formatted}</div>
                    <div className="small muted">acumulado historico</div>
                </div>
                <div className="stat">
                    <div className="label">Saldo pendiente</div>
                    <div className="value">{data.totals.pending.formatted}</div>
                    <div className="small muted">
                        de {data.totals.financed.formatted} financiados
                    </div>
                </div>
                <div className="stat">
                    <div className="label">Vencido</div>
                    <div className="value amount-negative">{data.totals.overdue.formatted}</div>
                    <div className="small muted">
                        {vencidoPct.toFixed(1)}% del saldo
                    </div>
                </div>
            </div>

            <section className="card" style={{ marginTop: 24 }} aria-labelledby="aging-title">
                <div className="card-title">
                    <h2 id="aging-title">Antiguedad de la cartera vencida</h2>
                    {data.pendingReconcile > 0 ? (
                        <Badge tone="warn">
                            {data.pendingReconcile} por conciliar
                        </Badge>
                    ) : null}
                </div>

                {data.aging.length === 0 ? (
                    <p className="muted small">No hay cuotas vencidas. Cartera al corriente.</p>
                ) : (
                    <div className="table-scroll">
                        <table className="data">
                            <thead>
                                <tr>
                                    <th>Rango</th>
                                    <th className="num">Clientes</th>
                                    <th className="num">Monto vencido</th>
                                    <th className="num">Participacion</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.aging.map((bucket) => {
                                    const share =
                                        data.totals.overdue.amount > 0
                                            ? (bucket.amount.amount / data.totals.overdue.amount) * 100
                                            : 0;
                                    return (
                                        <tr key={bucket.bucket}>
                                            <td>{AGING_LABEL[bucket.bucket] ?? bucket.bucket}</td>
                                            <td className="num">{bucket.clients}</td>
                                            <td className="num">{bucket.amount.formatted}</td>
                                            <td className="num">{share.toFixed(1)}%</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            <section className="card" style={{ marginTop: 16 }} aria-labelledby="hoy-title">
                <div className="card-title">
                    <h2 id="hoy-title">Cobros de hoy</h2>
                </div>
                <div className="grid grid-2">
                    <div className="stat">
                        <div className="label">Operaciones</div>
                        <div className="value">{data.today.payments}</div>
                    </div>
                    <div className="stat">
                        <div className="label">Monto</div>
                        <div className="value amount-positive">{data.today.amount.formatted}</div>
                    </div>
                </div>
            </section>

            <div className="row" style={{ marginTop: 24, gap: 12 }}>
                <Link to="/admin/clientes" className="btn btn-primary btn-block">
                    Gestionar clientes
                </Link>
                <Link to="/admin/pagos" className="btn btn-secondary btn-block">
                    Registrar y conciliar pagos
                </Link>
            </div>
        </div>
    );
}
