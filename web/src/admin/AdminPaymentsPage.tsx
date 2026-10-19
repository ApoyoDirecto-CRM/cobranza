import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, downloadReport } from '../api/client';
import type { Money, Paginated, PortfolioClient } from '../api/types';
import { Alert, EmptyState, PaymentStatusBadge, SkeletonCard } from '../components/ui';
import { formatDate } from '../lib/format';

interface AdminPayment {
    id: number;
    folio: string;
    clientName: string;
    clientFolio: string;
    amount: { amount: number; formatted: string };
    applied: { amount: number; formatted: string };
    method: string;
    status: string;
    concept: string | null;
    reference: string | null;
    paidAt: string;
}

const METHOD_OPTIONS = [
    { value: 'efectivo', label: 'Efectivo' },
    { value: 'spei', label: 'SPEI (conciliado)' },
    { value: 'transferencia', label: 'Transferencia' },
    { value: 'tarjeta', label: 'Tarjeta' },
    { value: 'manual', label: 'Otro manual' },
];

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral' | 'danger'> = {
    activo: 'ok',
    suspendido: 'warn',
    liquidado: 'neutral',
    baja: 'danger',
};

export function AdminPaymentsPage() {
    const [payments, setPayments] = useState<AdminPayment[]>([]);
    const [clients, setClients] = useState<PortfolioClient[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [filter, setFilter] = useState<'todos' | 'pendiente' | 'aprobado'>('pendiente');

    const [clientId, setClientId] = useState('');
    const [amount, setAmount] = useState('');
    const [method, setMethod] = useState('efectivo');
    const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
    const [concept, setConcept] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(async (nextFilter: typeof filter) => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: '100' });
            if (nextFilter !== 'todos') params.set('status', nextFilter);
            const data = await api.get<Paginated<AdminPayment>>(`/admin/payments?${params}`);
            setPayments(data.items);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos cargar los pagos.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(filter);
        void api
            .get<Paginated<PortfolioClient>>('/admin/clients?limit=200')
            .then((data) => setClients(data.items))
            .catch(() => setClients([]));
    }, [load, filter]);

    const register = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        setNotice(null);

        try {
            const result = await api.post<{
                folio: string;
                applied: Money;
                credit: Money;
            }>('/admin/payments', {
                clientId: Number(clientId),
                amount,
                method,
                paidAt,
                concept: concept.trim() || undefined,
            });

            setNotice(
                result.credit.amount > 0
                    ? `Pago ${result.folio} registrado. Se aplico ${result.applied.formatted} ` +
                      `y ${result.credit.formatted} quedo como saldo a favor.`
                    : `Pago ${result.folio} registrado y aplicado a las cuotas mas antiguas.`
            );
            setAmount('');
            setConcept('');
            void load(filter);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos registrar el pago.');
        } finally {
            setSaving(false);
        }
    };

    const approve = async (id: number) => {
        setError(null);
        try {
            const result = await api.post<{ folio?: string; applied: { formatted: string } }>(
                `/admin/payments/${id}/approve`
            );
            setNotice(`Pago aprobado. Aplicado: ${result.applied.formatted}`);
            void load(filter);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos aprobar el pago.');
        }
    };

    return (
        <div className="container page">
            <header className="page-header">
                <h1>Pagos</h1>
                <button
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                        void downloadReport('/admin/export/payments.csv', 'pagos.csv').catch(() =>
                            setError('No pudimos exportar los pagos.')
                        )
                    }
                >
                    Exportar CSV
                </button>
            </header>

            {notice ? <div style={{ marginBottom: 16 }}><Alert tone="ok">{notice}</Alert></div> : null}
            {error ? <div style={{ marginBottom: 16 }}><Alert tone="error">{error}</Alert></div> : null}

            <form className="card" onSubmit={register} style={{ marginBottom: 24 }}>
                <h2 style={{ marginBottom: 16 }}>Registrar pago manual</h2>

                <div className="grid grid-2">
                    <div className="field">
                        <label htmlFor="client">Cliente *</label>
                        <select id="client" value={clientId} required
                            onChange={(e) => setClientId(e.target.value)}>
                            <option value="">Selecciona un cliente</option>
                            {clients.map((client) => (
                                <option key={client.id} value={client.id}>
                                    {client.fullName} · {client.folio} · debe{' '}
                                    {client.pending.formatted}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="field">
                        <label htmlFor="amount">Monto *</label>
                        <input id="amount" inputMode="decimal" placeholder="1500.00" value={amount}
                            required onChange={(e) => setAmount(e.target.value)} />
                    </div>

                    <div className="field">
                        <label htmlFor="method">Metodo *</label>
                        <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
                            {METHOD_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="field">
                        <label htmlFor="paidAt">Fecha de pago *</label>
                        <input id="paidAt" type="date" value={paidAt} required
                            onChange={(e) => setPaidAt(e.target.value)} />
                    </div>
                </div>

                <div className="field">
                    <label htmlFor="concept">Concepto</label>
                    <input id="concept" placeholder="Pago en efectivo - sucursal Centro"
                        value={concept} onChange={(e) => setConcept(e.target.value)} />
                </div>

                <button type="submit" className="btn btn-primary" disabled={saving || !clientId}>
                    {saving ? 'Registrando…' : 'Registrar pago'}
                </button>
                <p className="field-hint">
                    El pago se imputa automaticamente a las cuotas mas antiguas. Lo que sobre queda
                    como saldo a favor del cliente.
                </p>
            </form>

            <div role="group" aria-label="Filtrar pagos" className="row" style={{ gap: 8, marginBottom: 16 }}>
                {(['pendiente', 'aprobado', 'todos'] as const).map((value) => (
                    <button
                        key={value}
                        className={`btn btn-sm ${filter === value ? 'btn-primary' : 'btn-secondary'}`}
                        aria-pressed={filter === value}
                        onClick={() => setFilter(value)}
                    >
                        {value === 'pendiente' ? 'Por conciliar' : value === 'aprobado' ? 'Aprobados' : 'Todos'}
                    </button>
                ))}
            </div>

            {loading ? (
                <SkeletonCard />
            ) : payments.length === 0 ? (
                <div className="card">
                    <EmptyState icon="🧾" title="Sin pagos en este filtro" />
                </div>
            ) : (
                <div className="card">
                    <ul className="list">
                        {payments.map((payment) => (
                            <li key={payment.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                                <div className="grow">
                                    <div className="title">{payment.clientName}</div>
                                    <div className="subtitle">
                                        {payment.folio} · {formatDate(payment.paidAt)} ·{' '}
                                        {payment.clientFolio}
                                    </div>
                                    <div className="subtitle">{payment.concept ?? 'Abono'}</div>
                                    {payment.applied.amount !== payment.amount.amount ? (
                                        <div className="subtitle">
                                            Aplicado {payment.applied.formatted} · excedente{' '}
                                            {(payment.amount.amount - payment.applied.amount).toFixed(2)}
                                        </div>
                                    ) : null}
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div className="amount">{payment.amount.formatted}</div>
                                    <div style={{ marginTop: 4 }}>
                                        <PaymentStatusBadge status={payment.status} />
                                    </div>
                                    {payment.status === 'pendiente' ? (
                                        <button
                                            className="btn btn-primary btn-sm"
                                            style={{ marginTop: 8 }}
                                            onClick={() => void approve(payment.id)}
                                        >
                                            Aprobar
                                        </button>
                                    ) : null}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {clients.some((c) => c.status === 'activo' && c.pending.amount > 0) ? (
                <p className="small muted center" style={{ marginTop: 24 }}>
                    {clients.filter((c) => c.status === 'activo' && c.pending.amount > 0).length}{' '}
                    clientes tienen saldo pendiente.
                </p>
            ) : null}
        </div>
    );
}

export { STATUS_TONE };
