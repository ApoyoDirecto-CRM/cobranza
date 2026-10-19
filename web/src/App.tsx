import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Loading } from './components/ui';
import { PortalLoginPage } from './portal/PortalLoginPage';
import { PortalDashboardPage } from './portal/PortalDashboardPage';
import { PortalPaymentsPage } from './portal/PortalPaymentsPage';
import { PortalInstallmentsPage } from './portal/PortalInstallmentsPage';
import { PortalPayPage } from './portal/PortalPayPage';
import { AdminLoginPage } from './admin/AdminLoginPage';
import { AdminDashboardPage } from './admin/AdminDashboardPage';
import { AdminClientsPage } from './admin/AdminClientsPage';
import { AdminPaymentsPage } from './admin/AdminPaymentsPage';

/** Restringe una rama del arbol a usuarios con sesion del tipo correcto. */
function RequireAuth({
    kind,
    children,
}: {
    kind: 'client' | 'admin';
    children: ReactNode;
}) {
    const { portalUser, adminUser, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="container page">
                <Loading label="Verificando sesion" />
            </div>
        );
    }

    const authenticated = kind === 'client' ? portalUser : adminUser;
    if (!authenticated) {
        // Se recuerda la ruta para volver a ella tras el login.
        return <Navigate to={kind === 'client' ? '/portal/login' : '/admin/login'} replace
            state={{ from: location.pathname }} />;
    }

    return <>{children}</>;
}

const TABS = [
    { to: '/portal', label: 'Inicio', icon: '🏠', end: true },
    { to: '/portal/cuotas', label: 'Cuotas', icon: '🗓', end: false },
    { to: '/portal/pagos', label: 'Pagos', icon: '🧾', end: false },
    { to: '/portal/pagar', label: 'Pagar', icon: '💳', end: false },
];

const ADMIN_TABS = [
    { to: '/admin', label: 'Cartera', icon: '📊', end: true },
    { to: '/admin/clientes', label: 'Clientes', icon: '👥', end: false },
    { to: '/admin/pagos', label: 'Pagos', icon: '🧾', end: false },
];

/**
 * Navegacion del portal. En movil es una barra inferior (patron de app
 * bancaria); en escritorio el mismo elemento se convierte en cabecera.
 */
function PortalLayout({ children }: { children: ReactNode }) {
    const { portalUser, logout } = useAuth();

    return (
        <div className="app-shell">
            <div
                className="container row-between"
                style={{ paddingBlock: 12, paddingInline: 16 }}
            >
                <strong style={{ fontSize: '0.95rem' }}>Cobranza</strong>
                <div className="row" style={{ gap: 12 }}>
                    <span className="small muted">{portalUser?.folio}</span>
                    <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                            void logout();
                        }}
                    >
                        Salir
                    </button>
                </div>
            </div>

            <main className="page">{children}</main>

            <nav className="tabbar" aria-label="Navegacion principal">
                {TABS.map((tab) => (
                    <NavLink key={tab.to} to={tab.to} end={tab.end}>
                        <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
                        {tab.label}
                    </NavLink>
                ))}
            </nav>
        </div>
    );
}

function AdminLayout({ children }: { children: ReactNode }) {
    const { adminUser, logout } = useAuth();

    useEffect(() => {
        document.title = 'Panel administrativo · Cobranza';
        return () => {
            document.title = 'Cobranza';
        };
    }, []);

    return (
        <div className="app-shell">
            <div className="container row-between" style={{ paddingBlock: 12, paddingInline: 16 }}>
                <strong style={{ fontSize: '0.95rem' }}>Panel · Cobranza</strong>
                <div className="row" style={{ gap: 12 }}>
                    <span className="small muted">
                        {adminUser?.fullName} · {adminUser?.role}
                    </span>
                    <button className="btn btn-secondary btn-sm" onClick={() => void logout()}>
                        Salir
                    </button>
                </div>
            </div>

            <main className="page">{children}</main>

            <nav className="tabbar" aria-label="Navegacion administrativa">
                {ADMIN_TABS.map((tab) => (
                    <NavLink key={tab.to} to={tab.to} end={tab.end}>
                        <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
                        {tab.label}
                    </NavLink>
                ))}
            </nav>
        </div>
    );
}

export default function App() {
    const { loading } = useAuth();

    if (loading) {
        return (
            <div className="container page">
                <Loading label="Cargando" />
            </div>
        );
    }

    return (
        <Routes>
            {/* Raiz: cada superficie conserva su propia sesion. */}
            <Route path="/" element={<Navigate to="/portal" replace />} />

            <Route path="/portal/login" element={<PortalLoginPage />} />
            <Route
                path="/portal"
                element={
                    <RequireAuth kind="client">
                        <PortalLayout>
                            <PortalDashboardPage />
                        </PortalLayout>
                    </RequireAuth>
                }
            />
            <Route
                path="/portal/cuotas"
                element={
                    <RequireAuth kind="client">
                        <PortalLayout>
                            <PortalInstallmentsPage />
                        </PortalLayout>
                    </RequireAuth>
                }
            />
            <Route
                path="/portal/pagos"
                element={
                    <RequireAuth kind="client">
                        <PortalLayout>
                            <PortalPaymentsPage />
                        </PortalLayout>
                    </RequireAuth>
                }
            />
            <Route
                path="/portal/pagar"
                element={
                    <RequireAuth kind="client">
                        <PortalLayout>
                            <PortalPayPage />
                        </PortalLayout>
                    </RequireAuth>
                }
            />

            <Route path="/admin/login" element={<AdminLoginPage />} />
            <Route
                path="/admin"
                element={
                    <RequireAuth kind="admin">
                        <AdminLayout>
                            <AdminDashboardPage />
                        </AdminLayout>
                    </RequireAuth>
                }
            />
            <Route
                path="/admin/clientes"
                element={
                    <RequireAuth kind="admin">
                        <AdminLayout>
                            <AdminClientsPage />
                        </AdminLayout>
                    </RequireAuth>
                }
            />
            <Route
                path="/admin/pagos"
                element={
                    <RequireAuth kind="admin">
                        <AdminLayout>
                            <AdminPaymentsPage />
                        </AdminLayout>
                    </RequireAuth>
                }
            />

            <Route path="*" element={<NotFound />} />
        </Routes>
    );
}

function NotFound() {
    return (
        <div className="container page">
            <div className="card empty-state">
                <div className="icon" aria-hidden="true">🔍</div>
                <h1>Pagina no encontrada</h1>
                <p>La direccion que buscas no existe.</p>
                <Link to="/" className="btn btn-primary" style={{ marginTop: 16 }}>
                    Volver al inicio
                </Link>
            </div>
        </div>
    );
}
