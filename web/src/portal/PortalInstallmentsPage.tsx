import { useCallback, useEffect, useState } from 'react';
import { api, ColdStartError } from '../api/client';
import type { InstallmentItem } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { errorMessage } from '../lib/errors';
import { Alert, EmptyState, InstallmentStateBadge, SkeletonCard } from '../components/ui';
import { formatDate, relativeDue } from '../lib/format';

type Filter = 'todos' | 'pendiente' | 'vencido' | 'pagado';

const FILTERS: { value: Filter; label: string }[] = [
    { value: 'todos', label: 'Todas' },
    { value: 'pendiente', label: 'Pendientes' },
    { value: 'vencido', label: 'Vencidas' },
    { value: 'pagado', label: 'Pagadas' },
];

export function PortalInstallmentsPage() {
    const [items, setItems] = useState<InstallmentItem[]>([]);
    const [filter, setFilter] = useState<Filter>('todos');
    const [loading, setLoading] = useState(true);
    // Se guarda el ERROR ORIGINAL, no su mensaje: hace falta distinguir
    // el arranque en frio (que se reintenta solo) de un fallo de la API.
    const [error, setError] = useState<unknown>(null);

    const load = useCallback(async (nextFilter: Filter) => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.get<{ items: InstallmentItem[] }>(
                `/portal/installments?status=${nextFilter}&limit=100`
            );
            setItems(data.items);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(filter);
    }, [load, filter]);

    // Igual que en el historial: el arranque en frio ocupa la pantalla
    // completa porque conviene reintentar solo.
    if (error instanceof ColdStartError) {
        return (
            <ErrorState
                error={error}
                onRetry={() => load(filter)}
                label="Volver a intentar"
            />
        );
    }

    return (
        <div className="container page">
            <header className="page-header">
                <h1>Mis cuotas</h1>
            </header>

            <div role="group" aria-label="Filtrar cuotas" className="row" style={{ gap: 8, marginBottom: 16 }}>
                {FILTERS.map((option) => (
                    <button
                        key={option.value}
                        className={`btn btn-sm ${filter === option.value ? 'btn-primary' : 'btn-secondary'}`}
                        aria-pressed={filter === option.value}
                        onClick={() => setFilter(option.value)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>

            {error ? <Alert tone="error">{errorMessage(error)}</Alert> : null}

            {loading ? (
                <SkeletonCard />
            ) : items.length === 0 ? (
                <div className="card">
                    <EmptyState icon="🗓" title="Sin cuotas en este filtro" />
                </div>
            ) : (
                <div className="card">
                    {/* Tabla en escritorio, lista en movil: el mismo dato sin
                        exigir scroll horizontal en pantallas pequenas. */}
                    <ul className="list">
                        {items.map((item) => (
                            <li key={item.id} className="list-item">
                                <div
                                    className="grow"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 12,
                                    }}
                                >
                                    <span
                                        aria-hidden="true"
                                        style={{
                                            minWidth: 34,
                                            height: 34,
                                            borderRadius: '50%',
                                            display: 'grid',
                                            placeItems: 'center',
                                            background: 'var(--surface-2)',
                                            border: '1px solid var(--border)',
                                            fontWeight: 700,
                                            fontSize: '0.8rem',
                                        }}
                                    >
                                        {item.seq}
                                    </span>
                                    <div style={{ minWidth: 0 }}>
                                        <div className="title">{item.amount.formatted}</div>
                                        <div className="subtitle">
                                            {formatDate(item.dueDate)}
                                            {item.state === 'pendiente' ? ` · ${relativeDue(item.dueDate)}` : ''}
                                        </div>
                                    </div>
                                </div>
                                <InstallmentStateBadge state={item.state} />
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {items.some((i) => i.originalDueDate && i.originalDueDate !== i.dueDate) ? (
                <div style={{ marginTop: 16 }}>
                    <Alert tone="info">
                        Algunas cuotas fueron reprogramadas por acuerdo. La fecha original se
                        conserva en tu historial.
                    </Alert>
                </div>
            ) : null}
        </div>
    );
}
