/**
 * Variables de entorno para las pruebas.
 *
 * Debe importarse PRIMERO en cualquier archivo de prueba: en ESM las
 * importaciones se evaluan en orden, asi que este modulo fija el entorno antes
 * de que `config/env.ts` lo lea.
 *
 * Los secretos son de prueba y publicos a proposito: no sirven para nada fuera
 * del proceso de test.
 */
const defaults: Record<string, string> = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_ACCESS_SECRET: 'test_access_secret_de_32_caracteres_minimo_000',
    JWT_REFRESH_SECRET: 'test_refresh_secret_de_32_caracteres_minimo_00',
    WEBHOOK_SECRET: 'test_webhook_secret_de_32_caracteres_minimo_0000',
    ACCESS_TOKEN_TTL: '15m',
    CORS_ORIGINS: 'http://localhost:5173',
    PORTAL_MAX_FAILED_ATTEMPTS: '3',
    PORTAL_LOCKOUT_MINUTES: '15',
    // El limitador por IP tiene su propia suite; aqui se sube el techo para que
    // el resto del archivo no se bloquee a si mismo al repetir logins.
    PORTAL_LOGIN_RATE_LIMIT: '1000',
    // El seed debe honrar esta variable (ver db/migrator.ts). Se fija aqui para
    // que la prueba pueda comprobar que NO queda la contrasena de desarrollo.
    SEED_ADMIN_PASSWORD: 'ClaveDePruebaAdmin123!',
};

for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) process.env[key] = value;
}

export const TEST_WEBHOOK_SECRET = defaults.WEBHOOK_SECRET as string;
export const TEST_ADMIN_PASSWORD = defaults.SEED_ADMIN_PASSWORD as string;
