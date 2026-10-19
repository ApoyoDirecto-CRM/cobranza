import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { Alert } from '../components/ui';

export function AdminLoginPage() {
    const navigate = useNavigate();
    const { loginAdmin } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const onSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            await loginAdmin(email, password);
            navigate('/admin', { replace: true });
        } catch (err) {
            // El backend devuelve el mismo mensaje para usuario inexistente y
            // contrasena incorrecta; se muestra tal cual, sin pistas.
            setError(
                err instanceof ApiError
                    ? err.message
                    : 'No pudimos iniciar sesion. Intenta de nuevo.'
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="auth-screen">
            <div className="auth-card">
                <div className="auth-brand">
                    <div className="logo" aria-hidden="true">▤</div>
                    <h1>Panel administrativo</h1>
                    <p>Gestion de cartera y cobranza</p>
                </div>

                {error ? <div style={{ marginBottom: 16 }}><Alert tone="error">{error}</Alert></div> : null}

                <form onSubmit={onSubmit} noValidate>
                    <div className="field">
                        <label htmlFor="email">Correo</label>
                        <input
                            id="email"
                            type="email"
                            autoComplete="username"
                            placeholder="admin@cobranza.local"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>

                    <div className="field">
                        <label htmlFor="password">Contrasena</label>
                        <input
                            id="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>

                    <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
                        {submitting ? <span className="spinner" aria-hidden="true" /> : null}
                        {submitting ? 'Entrando' : 'Entrar'}
                    </button>
                </form>
            </div>
        </main>
    );
}
