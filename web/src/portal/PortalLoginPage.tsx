import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { Alert } from '../components/ui';

type FieldErrors = Partial<Record<'phone' | 'identityId', string>>;

export function PortalLoginPage() {
    const navigate = useNavigate();
    const { loginPortal, verifyOtp } = useAuth();
    const [phone, setPhone] = useState('');
    const [identityId, setIdentityId] = useState('');
    const [otp, setOtp] = useState('');
    const [step, setStep] = useState<'credentials' | 'otp'>('credentials');
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
    const [submitting, setSubmitting] = useState(false);

    // Validacion de cliente solo para dar feedback inmediato. La regla que
    // manda es la del servidor: aqui nunca se decide si la credencial es valida.
    const validate = (): boolean => {
        const errors: FieldErrors = {};
        const digits = phone.replace(/\D/g, '');
        if (digits.length !== 10 && digits.length !== 12 && digits.length !== 13) {
            errors.phone = 'Ingresa 10 digitos (puedes incluir +52).';
        }
        const doc = identityId.replace(/[^A-Za-z0-9]/g, '');
        if (doc.length !== 18 && doc.length !== 13) {
            errors.identityId = 'Debe tener 18 caracteres (CURP) o 13 digitos (DNI).';
        }
        setFieldErrors(errors);
        return Object.keys(errors).length === 0;
    };

    const submitCredentials = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);

        if (!validate()) return;

        setSubmitting(true);
        try {
            const { otpRequired } = await loginPortal(phone, identityId);
            if (otpRequired) {
                setStep('otp');
            } else {
                navigate('/portal', { replace: true });
            }
        } catch (err) {
            if (err instanceof ApiError) {
                setError(err.message);
                const field = err.fieldMessage;
                if (field === 'phone') setFieldErrors({ phone: err.message });
                if (field === 'identityId') setFieldErrors({ identityId: err.message });
            } else {
                setError('No pudimos conectar. Revisa tu red e intenta de nuevo.');
            }
        } finally {
            setSubmitting(false);
        }
    };

    const submitOtp = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        setSubmitting(true);
        try {
            await verifyOtp(phone, otp);
            navigate('/portal', { replace: true });
        } catch (err) {
            if (err instanceof ApiError) {
                setError(err.message);
            } else {
                setError('No pudimos conectar. Revisa tu red e intenta de nuevo.');
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="auth-screen">
            <div className="auth-card">
                <div className="auth-brand">
                    <div className="logo" aria-hidden="true">₿</div>
                    <h1>Portal de clientes</h1>
                    <p>Consulta tu saldo y paga tu credito</p>
                </div>

                {error ? <div style={{ marginBottom: 16 }}><Alert tone="error">{error}</Alert></div> : null}

                <form onSubmit={step === 'credentials' ? submitCredentials : submitOtp} noValidate>
                    {step === 'credentials' ? (
                        <>
                            <div className="field">
                                <label htmlFor="phone">Telefono</label>
                                <input
                                    id="phone"
                                    name="phone"
                                    type="tel"
                                    inputMode="numeric"
                                    autoComplete="tel"
                                    placeholder="5512345678"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    aria-invalid={Boolean(fieldErrors.phone)}
                                    aria-describedby={fieldErrors.phone ? 'phone-error' : undefined}
                                    required
                                />
                                {fieldErrors.phone ? (
                                    <p className="field-error" id="phone-error">{fieldErrors.phone}</p>
                                ) : null}
                            </div>

                            <div className="field">
                                <label htmlFor="identityId">CURP o DNI</label>
                                <input
                                    id="identityId"
                                    name="identityId"
                                    type="text"
                                    autoComplete="off"
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                    placeholder="GODE561231GRERRN09"
                                    value={identityId}
                                    onChange={(e) => setIdentityId(e.target.value.toUpperCase())}
                                    aria-invalid={Boolean(fieldErrors.identityId)}
                                    aria-describedby={
                                        fieldErrors.identityId ? 'identity-error' : 'identity-hint'
                                    }
                                    required
                                />
                                {fieldErrors.identityId ? (
                                    <p className="field-error" id="identity-error">
                                        {fieldErrors.identityId}
                                    </p>
                                ) : (
                                    <p className="field-hint" id="identity-hint">
                                        El que aparece en tu identificacion oficial.
                                    </p>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="field">
                            <label htmlFor="otp">Codigo de verificacion</label>
                            <input
                                id="otp"
                                name="otp"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="6 digitos"
                                value={otp}
                                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                required
                            />
                            <p className="field-hint">Recibiras el codigo por SMS (en pruebas, aparece en el log del servidor).</p>
                        </div>
                    )}

                    <button
                        type="submit"
                        className="btn btn-primary btn-block"
                        disabled={submitting}
                    >
                        {submitting ? <span className="spinner" aria-hidden="true" /> : null}
                        {submitting ? 'Entrando' : step === 'credentials' ? 'Entrar' : 'Verificar'}
                    </button>
                    {step === 'otp' && !submitting && (
                        <button
                            type="button"
                            className="btn btn-secondary btn-block"
                            style={{ marginTop: 8 }}
                            onClick={() => { setStep('credentials'); setOtp(''); setError(null); }}
                        >
                            Volver
                        </button>
                    )}
                </form>

                <p className="small muted center" style={{ marginTop: 20 }}>
                    Si no puedes entrar, contacta a tu asesor.
                </p>
            </div>
        </main>
    );
}
