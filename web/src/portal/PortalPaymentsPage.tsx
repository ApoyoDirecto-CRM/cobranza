import { useCallback, useEffect, useState } from 'react';
import { api, ColdStartError } from '../api/client';
import type { Paginated, PaymentItem } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { errorMessage } from '../lib/errors';
import { Alert, EmptyState, PaymentStatusBadge, SkeletonCard } from '../components/ui';
import { formatDateTime } from '../lib/format';

const PAGE_SIZE = 20;

const METHOD_LABEL: Record<string, string> = {
    spei: 'Transferencia SPEI',
    tarjeta: 'Tarjeta',
    efectivo: 'Efectivo',
    transferencia: 'Transferencia',
    manual: 'Registro manual',
};

export function PortalPaymentsPage() {
    const [items, setItems] = useState<PaymentItem[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [status, setStatus] = useState<'todos' | 'aprobado' | 'pendiente'>('todos');
    const [loading, setLoading] = useState(true);
    // Se guarda el ERROR ORIGINAL, no su mensaje: hace falta distinguir
    // el arranque en frio (que se reintenta solo) de un fallo de la API.
    const [error, setError] = useState<unknown>(null);

    const load = useCallback(async (nextOffset: number, filter: typeof status) => {
        setLoading(true);
        setError(null);
        try {
            const query = new URLSearchParams({
                limit: String(PAGE_SIZE),
                offset: String(nextOffset),
            });
            if (filter !== 'todos') query.set('status', filter);

            const data = await api.get<Paginated<PaymentItem>>(`/portal/payments?${query}`);
            setItems(data.items);
            setTotal(data.pagination.total ?? data.items.length);
            setOffset(nextOffset);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(0, status);
    }, [load, status]);

    const changeFilter = (next: typeof status) => setStatus(next);

    // Un arranque en frio merece la pantalla completa con reintento
    // automatico; el resto de errores se muestran en su sitio.
    if (error instanceof ColdStartError) {
        return (
            <ErrorState
                error={error}
                onRetry={() => load(offset, status)}
                label="Volver a intentar"
            />
        );
    }

    return (
        <div className="container page">
            <header className="page-header">
                <h1>Historial de pagos</h1>
                {total > 0 ? <span className="small muted">{total} movimientos</span> : null}
            </header>

            {/* Filtros: se agrupan en segmentos en vez de un <select>, porque en
                movil un desplegable de 4 opciones cuesta dos toques. */}
            <div
                role="group"
                aria-label="Filtrar por estatus"
                className="row"
                style={{ gap: 8, marginBottom: 16 }}
            >
                {(['todos', 'aprobado', 'pendiente'] as const).map((value) => (
                    <button
                        key={value}
                        className={`btn btn-sm ${status === value ? 'btn-primary' : 'btn-secondary'}`}
                        aria-pressed={status === value}
                        onClick={() => changeFilter(value)}
                    >
                        {value === 'todos' ? 'Todos' : value === 'aprobado' ? 'Aprobados' : 'Pendientes'}
                    </button>
                ))}
            </div>

            {error ? <Alert tone="error">{errorMessage(error)}</Alert> : null}

            {loading ? (
                <SkeletonCard />
            ) : items.length === 0 ? (
                <div className="card">
                    <EmptyState icon="🧾" title="Sin movimientos">
                        Cuando registres un pago aparecera aqui con su comprobante.
                    </EmptyState>
                </div>
            ) : (
                <div className="card">
                    <ul className="list">
                        {items.map((payment) => (
                            <li key={payment.id} className="list-item">
                                <div className="grow">
                                    <div className="title">{payment.concept}</div>
                                    <div className="subtitle">
                                        {formatDateTime(payment.paidAt)} ·{' '}
                                        {METHOD_LABEL[payment.method] ?? payment.method}
                                    </div>
                                    <div className="subtitle mono" style={{ marginTop: 2 }}>
                                        {payment.folio}
                                    </div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div className="amount">{payment.amount.formatted}</div>
                                    <div style={{ marginTop: 4 }}>
                                        <PaymentStatusBadge status={payment.status} />
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Paginacion simple: el historial crece con el tiempo y la API
                devuelve total + hasMore, asi que no hace falta scroll infinito. */}
            {!loading && total > PAGE_SIZE ? (
                <nav
                    className="row-between"
                    style={{ marginTop: 16 }}
                    aria-label="Paginacion del historial"
                >
                    <button
                        className="btn btn-secondary btn-sm"
                        disabled={offset === 0}
                        onClick={() => void load(Math.max(0, offset - PAGE_SIZE), status)}
                    >
                        ‹ Anteriores
                    </button>
                    <span className="small muted">
                        {offset + 1}–{offset + items.length} de {total}
                    </span>
                    <button
                        className="btn btn-secondary btn-sm"
                        disabled={offset + items.length >= total}
                        onClick={() => void load(offset + PAGE_SIZE, status)}
                    >
                        Siguientes ›
                    </button>
                </nav>
            ) : null}
        </div>
    );
}
