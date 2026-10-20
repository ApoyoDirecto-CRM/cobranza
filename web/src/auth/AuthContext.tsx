import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { api, setAccessToken, getAccessToken } from '../api/client';

export interface PortalUser {
    id: number;
    folio: string;
    fullName: string;
}

export interface AdminUser {
    id: number;
    email: string;
    fullName: string;
    role: 'admin' | 'supervisor' | 'operador' | 'lectura';
}

interface AuthState {
    portalUser: PortalUser | null;
    adminUser: AdminUser | null;
    loading: boolean;
    loginPortal: (phone: string, identityId: string) => Promise<{ otpRequired: boolean; challenge?: string }>;
    verifyOtp: (phone: string, code: string) => Promise<void>;
    loginAdmin: (email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * La sesion vive solo en memoria. Al recargar la pagina se revalida contra la
 * cookie httpOnly del refresh token: si sigue viva, el portal entra sin volver
 * a pedir la contraseña y sin guardar nada en localStorage.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
    const [portalUser, setPortalUser] = useState<PortalUser | null>(null);
    const [adminUser, setAdminUser] = useState<AdminUser | null>(null);
    const [loading, setLoading] = useState(true);

    const logout = useCallback(async () => {
        try {
            await api.post('/auth/logout');
        } catch {
            // Si la llamada falla, la sesion local se limpia igual: el usuario
            // nunca debe quedarse "dentro" por un error de red.
        }
        setAccessToken(null);
        setPortalUser(null);
        setAdminUser(null);
    }, []);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const me = await api.get<{ id: number; folio: string; fullName: string }>(
                    '/auth/me'
                );
                if (!cancelled) setPortalUser(me);
            } catch {
                // Sin sesion de portal: es el estado normal de arranque.
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    const loginPortal = useCallback(async (phone: string, identityId: string): Promise<{ otpRequired: boolean; challenge?: string }> => {
        const data = await api.post<{
            otpRequired: boolean;
            challenge?: string;
            accessToken?: string;
            client?: { id: number; folio: string; fullName: string };
        }>('/auth/login', { phone, identityId });

        if (!data.otpRequired && data.accessToken && data.client) {
            setAccessToken(data.accessToken);
            setPortalUser(data.client);
        }

        return { otpRequired: data.otpRequired, challenge: data.challenge };
    }, []);

    const verifyOtp = useCallback(async (phone: string, code: string): Promise<void> => {
        const data = await api.post<{
            accessToken: string;
            refreshToken: string;
            client: PortalUser;
        }>('/auth/verify-otp', { phone, code });

        setAccessToken(data.accessToken);
        // Sin esto, RequireAuth no ve sesion y devuelve al login justo despues
        // de un OTP correcto.
        setPortalUser(data.client);
    }, []);

    const loginAdmin = useCallback(async (email: string, password: string) => {
        const data = await api.post<{
            accessToken: string;
            admin: AdminUser;
        }>('/admin/auth/login', { email, password });

        setAccessToken(data.accessToken);
        setAdminUser(data.admin);
    }, []);

    const value = useMemo<AuthState>(
        () => ({ portalUser, adminUser, loading, loginPortal, verifyOtp, loginAdmin, logout }),
        [portalUser, adminUser, loading, loginPortal, verifyOtp, loginAdmin, logout]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
    return context;
}

/** Token en memoria, para las descargas de reportes. */
export { getAccessToken };
