import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga el .env sin dependencias externas. Node 20.6+ expone
 * `process.loadEnvFile`.
 *
 * Dos detalles que importan:
 *
 *  - `npm` ejecuta los scripts de workspace con cwd = `api/`, pero el .env vive
 *    en la raiz del monorepo. Se mira el cwd y, si no hay, el directorio padre.
 *  - `process.loadEnvFile` NO sobrescribe variables ya definidas, asi que
 *    cargar cwd -> padre equivale a "el .env mas cercano gana".
 */
export function loadEnvFile(file = '.env'): void {
    const candidates = [resolve(process.cwd(), file), resolve(process.cwd(), '..', file)];
    for (const path of candidates) {
        if (!existsSync(path)) continue;
        try {
            process.loadEnvFile(path);
        } catch {
            // Un .env mal formado no debe impedir arrancar: las variables de
            // entorno del sistema tienen prioridad.
        }
    }
}

// Se ejecuta al IMPORTAR este modulo, es decir antes de calcular `config`.
//
// Antes se llamaba desde server.ts y migrate.ts despues de importar `config`;
// como `config` se congela al evaluarse el modulo, el .env nunca llegaba a
// aplicarse y el arranque solo funcionaba con variables de entorno reales.
//
// En las pruebas se omite: el entorno lo fija testing/setup-env.ts, que se
// importa primero.
if (process.env.NODE_ENV !== 'test') loadEnvFile();

class ConfigError extends Error {}

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
        throw new ConfigError(
            `Falta la variable de entorno ${name}. Copia .env.example a .env y completala.`
        );
    }
    return value;
}

function str(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value.trim() === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        throw new ConfigError(`${name} debe ser un numero entero (recibido: "${raw}")`);
    }
    return parsed;
}

function list(name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

export type DatabaseDriver = 'postgres' | 'pglite';

/**
 * Motor de base de datos.
 *
 * `postgres` es produccion: `pg` contra DATABASE_URL.
 *
 * `pglite` levanta el MISMO motor (PostgreSQL 18 compilado a WebAssembly)
 * dentro del proceso de Node. Existe para poder probar el sistema completo en
 * local sin Docker ni un servidor PostgreSQL; NO es apto para produccion, y por
 * eso se rechaza explicitamente con NODE_ENV=production.
 */
const driverRaw = str('DB_DRIVER', 'postgres');
if (driverRaw !== 'postgres' && driverRaw !== 'pglite') {
    throw new ConfigError(`DB_DRIVER debe ser "postgres" o "pglite" (recibido: "${driverRaw}").`);
}
const driver = driverRaw as DatabaseDriver;
const isLocalDb = driver === 'pglite';

if (isLocalDb && isProduction) {
    throw new ConfigError(
        'DB_DRIVER=pglite no puede combinarse con NODE_ENV=production: la base vive ' +
            'dentro del proceso y se pierde en cada reinicio. En produccion usa PostgreSQL.'
    );
}

// En produccion los secretos por defecto son un fallo de seguridad, no una
// inconvenience: se aborta el arranque en lugar de emitir JWT firmables por
// cualquiera que conozca el codigo.
const PLACEHOLDERS = new Set([
    'cambiame_en_produccion_secret_acceso_min_32_chars',
    'cambiame_en_produccion_secret_refresh_min_32_chars',
    'cambiame_en_produccion_webhook_secret',
]);

for (const name of [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'WEBHOOK_SECRET',
]) {
    const value = required(name);
    if (value.length < 32) {
        throw new ConfigError(`${name} debe tener al menos 32 caracteres.`);
    }
    if (isProduction && PLACEHOLDERS.has(value)) {
        throw new ConfigError(`${name} sigue con el valor de ejemplo: cambialo antes de produccion.`);
    }
}

const identityPepper = str('IDENTITY_PEPPER', 'dev_identity_pepper_cambiar_en_produccion');
if (isProduction && (identityPepper.length < 32 ||
    identityPepper === 'dev_identity_pepper_cambiar_en_produccion' ||
    identityPepper.startsWith('cambiame'))) {
    throw new ConfigError(
        'IDENTITY_PEPPER debe ser un secreto propio de al menos 32 caracteres en produccion.'
    );
}

const accessSecret = required('JWT_ACCESS_SECRET');
const refreshSecret = required('JWT_REFRESH_SECRET');
if (accessSecret === refreshSecret) {
    throw new ConfigError(
        'JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser distintos: compartir firma ' +
            'permite usar un refresh token como access token.'
    );
}

export const config = {
    nodeEnv,
    isProduction,
    host: str('API_HOST', '0.0.0.0'),
    // Render inyecta PORT y es lo que espera usar. API_PORT manda si esta
    // definido; PORT es el respaldo para despliegues que solo den PORT.
    port: int('API_PORT', int('PORT', 3000)),
    /**
     * Origenes permitidos. Una lista VACIA significa "despliegue de un solo
     * origen": se rechaza todo lo cross-origin, que es lo correcto cuando el
     * portal y la API comparten dominio.
     */
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173']),

    web: {
        /**
         * Sirve el build del frontend desde el MISMO proceso que la API.
         *
         * En Render gratuito esto importa mucho: cada servicio duerme a los 15
         * minutos y tarda ~1 minuto en despertar. Con dos servicios serian dos
         * esperas, y ademas habria que fijar la URL de la API en tiempo de
         * build del frontend. Con uno solo, mismo origen, sin CORS y sin
         * segunda espera en el arranque en frio.
         */
        serveStatic: str('SERVE_WEB', 'true') !== 'false',
        distPath: str('WEB_DIST_PATH', 'web/dist'),
        /** Prefijos que NUNCA deben devolver el index.html del SPA. */
        apiPrefix: '/api',
    },

    deploy: {
        /**
         * Corre las migraciones al arrancar.
         *
         * Necesario en Render gratuito: `preDeployCommand` es de pago, y el
         * servicio se reinicia muchas veces al dia por el cold start.
         *
         * Por defecto se activa SOLO en modo local, donde la base nace vacia en
         * cada proceso. En produccion el valor por defecto sigue siendo `false`.
         */
        autoMigrate: str('AUTO_MIGRATE', isLocalDb ? 'true' : 'false') === 'true',
        /**
         * Inserta datos de demostracion si la base esta vacia.
         *
         * Por defecto se activa SOLO en modo local: asi `DB_DRIVER=pglite` deja
         * una base con cartera de ejemplo en la que hacer clic. En produccion el
         * valor por defecto sigue siendo `false`.
         */
        seedOnDeploy: str('SEED_ON_DEPLOY', isLocalDb ? 'true' : 'false') === 'true',
        /** Render inyecta esto; se usa para detectar si corre alli. */
        serviceName: str('RENDER_SERVICE_NAME', ''),
        externalUrl: str('RENDER_EXTERNAL_URL', ''),
    },

    database: {
        driver,
        /**
         * Con el driver `postgres` es obligatoria. En modo local no hay servidor
         * al que conectarse, asi que dejarla vacia es legitimo.
         */
        url: isLocalDb ? str('DATABASE_URL', '') : required('DATABASE_URL'),
        /**
         * Directorio donde PGlite guarda la base.
         *
         * Vacio = base EN MEMORIA: nace vacia en cada arranque, que es
         * exactamente lo que hace el primer despliegue en Render (esquema por
         * migracion + datos de demostracion por seed). Con un directorio, los
         * datos sobreviven a los reinicios.
         */
        pgliteDataDir: str('PGLITE_DATA_DIR', ''),
        poolMax: int('PGPOOL_MAX', 10),
        idleTimeoutMs: int('PG_IDLE_TIMEOUT_MS', 30_000),
        connectTimeoutMs: int('PG_CONNECT_TIMEOUT_MS', 8_000),
        // sslmode=require en la URL activa TLS.
        ssl: str('DATABASE_URL', '').includes('sslmode=require')
            ? { rejectUnauthorized: true }
            : undefined,
    },

    auth: {
        accessSecret,
        refreshSecret,
        accessTtl: str('ACCESS_TOKEN_TTL', '15m'),
        refreshTtl: str('REFRESH_TOKEN_TTL', '30d'),
        refreshTtlDays: int('REFRESH_TOKEN_DAYS', 30),
        portalMaxFailedAttempts: int('PORTAL_MAX_FAILED_ATTEMPTS', 5),
        portalLockoutMinutes: int('PORTAL_LOCKOUT_MINUTES', 15),
        portalLoginRateLimit: int('PORTAL_LOGIN_RATE_LIMIT', 10),
        seedAdminEmail: str('SEED_ADMIN_EMAIL', 'admin@cobranza.local'),
        seedAdminPassword: str('SEED_ADMIN_PASSWORD', ''),
        /**
         * Pepper del indice ciego de identidad. El documento se guarda hasheado
         * con bcrypt (lento, para login) y ademas con SHA-256(pepper + doc)
         * para detectar duplicados con un UNIQUE. Sin el pepper, un dump de la
         * base permitiria enumerar CURPs conocidas por SHA-256 en milisegundos.
         * En produccion debe ser un valor propio y secreto.
         */
        identityPepper,
        otpEnabled: str('PORTAL_OTP_ENABLED', 'true') === 'true',
        otpProvider: str('PORTAL_OTP_PROVIDER', 'console'),
        otpTtlMinutes: int('PORTAL_OTP_TTL_MINUTES', 5),
    },

    webhook: {
        secret: required('WEBHOOK_SECRET'),
        toleranceSeconds: int('WEBHOOK_TOLERANCE_SECONDS', 300),
    },

    spei: {
        bank: str('SPEI_BANCO', ''),
        clabe: str('SPEI_CLABE', ''),
        holder: str('SPEI_TITULAR', ''),
        conceptTemplate: str('SPEI_CONCEPTO_REF', 'FOLIO-{FOLIO}'),
        deadlineHours: int('SPEI_TIEMPO_LIMITE_HORAS', 72),
    },

    gateway: {
        merchantId: str('GATEWAY_MERCHANT_ID', ''),
        apiBase: str('GATEWAY_API_BASE', ''),
        publicKey: str('GATEWAY_PUBLIC_KEY', ''),
    },

    /** URL del frontend para los enlaces de los correos. */
    publicWebUrl: str('PUBLIC_WEB_URL', 'http://localhost:5173'),
} as const;

export { ConfigError };
