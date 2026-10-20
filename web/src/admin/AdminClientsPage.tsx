import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import {
    PORTAL_SECTIONS,
    PORTAL_SECTION_LABELS,
    type Paginated,
    type PortalView,
    type PortfolioClient,
} from '../api/types';
import { Alert, Badge, EmptyState, SkeletonCard } from '../components/ui';
import { formatDate, formatPhone } from '../lib/format';

interface Account {
    id: number;
    label: string;
    bank: string;
    clabe: string;
    holder: string;
    active: boolean;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
    activo: 'ok',
    suspendido: 'warn',
    liquidado: 'neutral',
    baja: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
    activo: 'Activo',
    suspendido: 'Suspendido',
    liquidado: 'Liquidado',
    baja: 'Baja',
};

const FREQUENCY_LABEL: Record<string, string> = {
    semanal: 'Semanal',
    quincenal: 'Quincenal',
    mensual: 'Mensual',
};

interface FormState {
    fullName: string;
    phone: string;
    identityId: string;
    email: string;
    address: string;
    paymentAccountId: number | null;
    totalAmount: string;
    installmentCount: string;
    frequency: string;
    startDate: string;
}

const EMPTY_FORM: FormState = {
    fullName: '',
    phone: '',
    identityId: '',
    email: '',
    address: '',
    paymentAccountId: null,
    totalAmount: '',
    installmentCount: '12',
    frequency: 'mensual',
    startDate: new Date().toISOString().slice(0, 10),
};

export function AdminClientsPage() {
    const [clients, setClients] = useState<PortfolioClient[]>([]);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [created, setCreated] = useState<{ id: number; folio: string } | null>(null);
    const [viewFor, setViewFor] = useState<number | null>(null);
    const [viewDraft, setViewDraft] = useState<PortalView | null>(null);
    const [viewSaving, setViewSaving] = useState(false);

    const load = useCallback(async (search: string) => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: '100' });
            if (search.trim()) params.set('q', search.trim());
            const data = await api.get<Paginated<PortfolioClient>>(`/admin/clients?${params}`);
            setClients(data.items);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos cargar los clientes.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load('');
        void api.get<{ items: Account[] }>('/admin/payment-accounts')
            .then((data) => setAccounts(data.items.filter((a) => a.active)))
            .catch(() => setAccounts([]));
    }, [load]);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        setNotice(null);

        try {
            // Alta del cliente y asignacion del plan en dos pasos: el backend
            // expone ambos por separado, y el plan necesita un cliente que ya
            // exista para poder anadir cuotas atomicamente.
            const client = await api.post<{ id: number; folio: string }>('/admin/clients', {
                fullName: form.fullName.trim(),
                phone: form.phone.trim(),
                identityId: form.identityId.trim(),
                email: form.email.trim() || undefined,
                address: form.address.trim() || undefined,
                paymentAccountId: form.paymentAccountId ?? undefined,
            });

            const total = Number(form.totalAmount);
            const count = Number(form.installmentCount);
            if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count < 1) {
                setNotice(`Cliente ${client.folio} creado, pero el plan no se registro: revisa monto y cuotas.`);
                setCreated(client);
                setShowForm(false);
                setForm(EMPTY_FORM);
                void load(query);
                return;
            }

            const plan = await api.post<{ schedule: unknown[] }>(`/admin/clients/${client.id}/plans`, {
                totalAmount: form.totalAmount.trim(),
                installmentCount: count,
                frequency: form.frequency,
                startDate: form.startDate,
            });

            setNotice(
                `Cliente ${client.folio} creado con ${plan.schedule.length} cuotas. ` +
                'Ya puede acceder al portal.'
            );
            setCreated(client);
            setShowForm(false);
            setForm(EMPTY_FORM);
            void load(query);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos guardar el cliente.');
        } finally {
            setSaving(false);
        }
    };

    const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
        setForm((prev) => ({ ...prev, [key]: value }));

    const openView = (client: PortfolioClient) => {
        setViewFor((current) => (current === client.id ? null : client.id));
        setViewDraft({ ...client.portalView });
    };

    const saveView = async (client: PortfolioClient) => {
        if (!viewDraft) return;
        setViewSaving(true);
        setError(null);
        try {
            const result = await api.patch<{ portalView: PortalView }>(
                `/admin/clients/${client.id}`,
                { portalView: viewDraft }
            );
            setClients((prev) =>
                prev.map((item) =>
                    item.id === client.id ? { ...item, portalView: result.portalView } : item
                )
            );
            setViewFor(null);
            setViewDraft(null);
            setNotice(`Vista del portal actualizada para ${client.fullName}.`);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'No pudimos guardar la vista del portal.');
        } finally {
            setViewSaving(false);
        }
    };

    return (
        <div className="container page">
            <header className="page-header">
                <h1>Clientes</h1>
                <button className="btn btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>
                    {showForm ? 'Cancelar' : '+ Nuevo cliente'}
                </button>
            </header>

            {notice ? <div style={{ marginBottom: 16 }}><Alert tone="ok">{notice}</Alert></div> : null}
            {error ? <div style={{ marginBottom: 16 }}><Alert tone="error">{error}</Alert></div> : null}

            {showForm ? (
                <form className="card" onSubmit={submit} style={{ marginBottom: 24 }}>
                    <h2 style={{ marginBottom: 16 }}>Alta de cliente y plan</h2>

                    <div className="grid grid-2">
                        <div className="field">
                            <label htmlFor="fullName">Nombre completo *</label>
                            <input id="fullName" value={form.fullName} required
                                onChange={(e) => set('fullName', e.target.value)} />
                        </div>
                        <div className="field">
                            <label htmlFor="phone">Telefono (10 digitos) *</label>
                            <input id="phone" inputMode="numeric" value={form.phone} required
                                onChange={(e) => set('phone', e.target.value)} />
                        </div>
                        <div className="field">
                            <label htmlFor="identityId">CURP o DNI *</label>
                            <input id="identityId" value={form.identityId} required
                                onChange={(e) => set('identityId', e.target.value.toUpperCase())} />
                        </div>
                        <div className="field">
                            <label htmlFor="email">Correo</label>
                            <input id="email" type="email" value={form.email}
                                onChange={(e) => set('email', e.target.value)} />
                        </div>
                    </div>

                    <div className="field">
                        <label htmlFor="account">CLABE para pagos SPEI</label>
                        <select id="account" value={form.paymentAccountId ?? ''}
                            onChange={(e) => set('paymentAccountId', e.target.value ? Number(e.target.value) : null)}>
                            <option value="">Sin asignar</option>
                            {accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                    {account.label} · {account.bank} · {account.clabe}
                                </option>
                            ))}
                        </select>
                        <p className="field-hint">
                            Sin CLABE el cliente podra ver su saldo, pero no tendra como pagar por
                            transferencia.
                        </p>
                    </div>

                    <fieldset style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 16 }}>
                        <legend style={{ fontWeight: 700, padding: '0 8px' }}>Plan de cobro</legend>

                        <div className="grid grid-2">
                            <div className="field">
                                <label htmlFor="totalAmount">Monto total *</label>
                                <input id="totalAmount" inputMode="decimal" placeholder="6000.00"
                                    value={form.totalAmount} required
                                    onChange={(e) => set('totalAmount', e.target.value)} />
                            </div>
                            <div className="field">
                                <label htmlFor="installmentCount">Numero de cuotas *</label>
                                <input id="installmentCount" type="number" min="1" max="520"
                                    value={form.installmentCount} required
                                    onChange={(e) => set('installmentCount', e.target.value)} />
                            </div>
                            <div className="field">
                                <label htmlFor="frequency">Frecuencia *</label>
                                <select id="frequency" value={form.frequency}
                                    onChange={(e) => set('frequency', e.target.value)}>
                                    <option value="mensual">Mensual</option>
                                    <option value="quincenal">Quincenal</option>
                                    <option value="semanal">Semanal</option>
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor="startDate">Primer vencimiento *</label>
                                <input id="startDate" type="date" value={form.startDate} required
                                    onChange={(e) => set('startDate', e.target.value)} />
                            </div>
                        </div>
                    </fieldset>

                    <div className="row" style={{ gap: 12 }}>
                        <button type="submit" className="btn btn-primary" disabled={saving}>
                            {saving ? 'Guardando…' : 'Crear cliente y plan'}
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                            Cancelar
                        </button>
                    </div>
                </form>
            ) : null}

            <div className="field">
                <label htmlFor="search">Buscar</label>
                <input id="search" type="search" placeholder="Nombre, folio o telefono"
                    value={query} onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void load(query); }} />
                <p className="field-hint">Pulsa Enter para buscar.</p>
            </div>

            {loading ? (
                <SkeletonCard />
            ) : clients.length === 0 ? (
                <div className="card">
                    <EmptyState icon="👥" title="Sin resultados" />
                </div>
            ) : (
                <div className="card">
                    {/* En movil cada cliente es una tarjeta apilada: una tabla con
                        9 columnas seria ilegible sin scroll horizontal. */}
                    <ul className="list">
                        {clients.map((client) => (
                            <li key={client.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                                <div className="grow">
                                    <div className="row" style={{ gap: 8 }}>
                                        <span className="title">{client.fullName}</span>
                                        <Badge tone={STATUS_TONE[client.status] ?? 'neutral'}>
                                            {STATUS_LABEL[client.status] ?? client.status}
                                        </Badge>
                                    </div>
                                    <div className="subtitle">
                                        {client.folio} · {formatPhone(client.phone)}
                                        {client.speiClabe ? ` · CLABE ${client.speiClabe}` : ' · sin CLABE'}
                                    </div>
                                    <div className="row small" style={{ gap: 12, marginTop: 6 }}>
                                        <span>
                                            <span className="muted">Pagado:</span>{' '}
                                            <strong>{client.paid.formatted}</strong>
                                        </span>
                                        <span>
                                            <span className="muted">Pendiente:</span>{' '}
                                            <strong>{client.pending.formatted}</strong>
                                        </span>
                                        {client.overdue.amount > 0 ? (
                                            <span className="amount-negative">
                                                <strong>Vencido:</strong> {client.overdue.formatted}
                                                {client.maxDaysOverdue
                                                    ? ` (${client.maxDaysOverdue}d)`
                                                    : ''}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="subtitle" style={{ marginTop: 4 }}>
                                        {client.nextDueDate
                                            ? `Proximo vencimiento: ${formatDate(client.nextDueDate)}`
                                            : 'Sin vencimiento proximo'}
                                        {' · '}
                                        {client.activePlans}{' '}
                                        {client.activePlans === 1 ? 'plan activo' : 'planes activos'}
                                    </div>
                                </div>
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => openView(client)}
                                >
                                    {viewFor === client.id ? 'Cerrar' : 'Vista del portal'}
                                </button>
                                {viewFor === client.id && viewDraft ? (
                                    <div
                                        className="grow"
                                        style={{
                                            flexBasis: '100%',
                                            marginTop: 12,
                                            borderTop: '1px solid var(--border)',
                                            paddingTop: 12,
                                        }}
                                    >
                                        <p className="small muted" style={{ marginBottom: 8 }}>
                                            Elige que secciones ve {client.fullName.split(' ')[0]} en su portal.
                                        </p>
                                        <div className="grid grid-2">
                                            {PORTAL_SECTIONS.map((section) => (
                                                <label
                                                    key={section}
                                                    className="row"
                                                    style={{ gap: 8, alignItems: 'center' }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={viewDraft[section]}
                                                        onChange={(e) =>
                                                            setViewDraft((prev) => prev
                                                                ? { ...prev, [section]: e.target.checked }
                                                                : prev)
                                                        }
                                                    />
                                                    {PORTAL_SECTION_LABELS[section]}
                                                </label>
                                            ))}
                                        </div>
                                        <div className="row" style={{ gap: 8, marginTop: 12 }}>
                                            <button
                                                className="btn btn-primary btn-sm"
                                                disabled={viewSaving}
                                                onClick={() => void saveView(client)}
                                            >
                                                {viewSaving ? 'Guardando…' : 'Guardar vista'}
                                            </button>
                                            <button
                                                className="btn btn-secondary btn-sm"
                                                onClick={() => { setViewFor(null); setViewDraft(null); }}
                                            >
                                                Cancelar
                                            </button>
                                        </div>
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {created ? (
                <p className="small muted center" style={{ marginTop: 16 }}>
                    Folio generado: <span className="mono">{created.folio}</span>
                </p>
            ) : null}
        </div>
    );
}

export { FREQUENCY_LABEL };
