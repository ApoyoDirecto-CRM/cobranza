import type { ReactNode } from 'react';

export function Badge({
    children,
    tone = 'neutral',
}: {
    children: ReactNode;
    tone?: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
}) {
    return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * Estado de un pago. El color nunca va solo: cada tono lleva su icono y su
 * texto, para que el significado no dependa de la percepcion del color.
 */
export function PaymentStatusBadge({ status }: { status: string }) {
    const map: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; icon: string; label: string }> = {
        aprobado: { tone: 'ok', icon: '✓', label: 'Aprobado' },
        pendiente: { tone: 'warn', icon: '⏳', label: 'Pendiente' },
        rechazado: { tone: 'danger', icon: '✕', label: 'Rechazado' },
        reembolsado: { tone: 'neutral', icon: '↩', label: 'Reembolsado' },
    };
    const info = map[status] ?? { tone: 'neutral' as const, icon: '•', label: status };

    return (
        <Badge tone={info.tone}>
            <span aria-hidden="true">{info.icon}</span>
            {info.label}
        </Badge>
    );
}

export function InstallmentStateBadge({ state }: { state: string }) {
    const map: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral'; icon: string; label: string }> = {
        pagado: { tone: 'ok', icon: '✓', label: 'Pagada' },
        pendiente: { tone: 'info', icon: '•', label: 'Pendiente' },
        vencido: { tone: 'danger', icon: '!', label: 'Vencida' },
        condonado: { tone: 'neutral', icon: '—', label: 'Condonada' },
    };
    const info = map[state] ?? { tone: 'neutral' as const, icon: '•', label: state };

    return (
        <Badge tone={info.tone}>
            <span aria-hidden="true">{info.icon}</span>
            {info.label}
        </Badge>
    );
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
    // El ancho se acota: un 120% romperia la barra y sugeriria un avance falso.
    const width = Math.min(100, Math.max(0, percent));

    return (
        <div>
            <div
                className="progress"
                role="progressbar"
                aria-valuenow={Math.round(width)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={label ?? 'Avance de liquidacion'}
            >
                <div className="progress-fill" style={{ width: `${width}%` }} />
            </div>
            <div className="progress-meta">
                <span>{label ?? 'Liquidacion del plan'}</span>
                <span>{percent.toFixed(1)}%</span>
            </div>
        </div>
    );
}

export function Alert({
    tone = 'info',
    children,
}: {
    tone?: 'error' | 'ok' | 'warn' | 'info';
    children: ReactNode;
}) {
    const icons: Record<string, string> = { error: '⚠', ok: '✓', warn: '⚠', info: 'ℹ' };

    return (
        <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
            <span aria-hidden="true">{icons[tone]}</span>
            <span>{children}</span>
        </div>
    );
}

export function EmptyState({ icon = '📄', title, children }: { icon?: string; title: string; children?: ReactNode }) {
    return (
        <div className="empty-state">
            <div className="icon" aria-hidden="true">{icon}</div>
            <strong>{title}</strong>
            {children ? <p className="small">{children}</p> : null}
        </div>
    );
}

export function Loading({ label = 'Cargando' }: { label?: string }) {
    return (
        <div className="empty-state" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <p className="small">{label}…</p>
        </div>
    );
}

export function SkeletonCard() {
    return (
        <div className="card" aria-hidden="true">
            <div className="skeleton" style={{ height: 20, width: '40%', marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 44, marginBottom: 12 }} />
            <div className="skeleton" style={{ height: 12 }} />
        </div>
    );
}
