import { useEffect, useState, type ReactNode } from 'react';
import { ColdStartError } from '../api/client';
import { Alert } from '../components/ui';

interface Props {
    /** Error lanzado por la carga de datos. */
    error: unknown;
    onRetry: () => void | Promise<void>;
    /** Etiqueta del boton de reintento. */
    label?: string;
    children?: ReactNode;
}

/**
 * Pantalla de error con manejo del arranque en frio.
 *
 * En instancias gratuitas el servidor se duerme a los 15 minutos. Si el
 * usuario vuelve a la aplicacion justo entonces, la primera peticion falla por
 * red. En vez de mostrarle un error definitivo, se le explica que el servidor
 * se esta activando y se reintenta solo: para cuando despierta, la carga
 * funciona y el usuario no tuvo que hacer nada.
 */
export function ErrorState({ error, onRetry, label = 'Reintentar', children }: Props) {
    const coldStart = error instanceof ColdStartError;
    const message =
        coldStart
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Ocurrio un error inesperado.';

    const [seconds, setSeconds] = useState(30);
    const [autoRetry, setAutoRetry] = useState(false);

    useEffect(() => {
        if (!coldStart) return;

        setAutoRetry(true);
        setSeconds(30);

        // Cuenta regresiva visible: el usuario sabe que no esta colgado.
        const timer = setInterval(() => {
            setSeconds((s) => Math.max(0, s - 1));
        }, 1000);

        const retry = setTimeout(() => {
            void onRetry();
        }, 30_000);

        return () => {
            clearInterval(timer);
            clearTimeout(retry);
        };
    }, [coldStart, onRetry]);

    return (
        <div className="container page">
            <div className="card">
                {coldStart ? (
                    <div className="center" style={{ paddingBlock: '8px 16px' }}>
                        <span
                            className="spinner"
                            style={{ width: 28, height: 28, margin: '0 auto 16px' }}
                            aria-hidden="true"
                        />
                        <p className="small muted">
                            Reintentando automaticamente en {seconds} s
                        </p>
                    </div>
                ) : null}

                <Alert tone={coldStart ? 'info' : 'error'}>{message}</Alert>

                {!autoRetry || !coldStart ? (
                    <button
                        className="btn btn-primary btn-block"
                        style={{ marginTop: 16 }}
                        onClick={() => {
                            setAutoRetry(false);
                            void onRetry();
                        }}
                    >
                        {label}
                    </button>
                ) : null}

                <button
                    className="btn btn-secondary btn-block"
                    style={{ marginTop: 8 }}
                    onClick={() => window.location.reload()}
                >
                    Recargar la pagina
                </button>

                {children}
            </div>
        </div>
    );
}
