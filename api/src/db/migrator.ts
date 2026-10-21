import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';
import type { Queryable } from './client.js';
import { upgradeLegacyIdentity } from './legacy.js';

const here = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(here, '../../../db');

/**
 * Migraciones.
 *
 * En Render el plan gratuito NO ofrece `preDeployCommand`, asi que no hay forma
 * de correr migraciones antes de arrancar: se ejecutan al inicio del proceso.
 * Un servicio gratuito se duerme a los 15 minutos y despierta muchas veces al
 * dia, de modo que el arranque debe poder repetirse sin romper nada.
 *
 * De ahi las dos garantias:
 *   1. `schema_migrations` registra que se aplico cada archivo; las ya
 *      aplicadas se saltan.
 *   2. Un advisory lock de sesion serializa el arranque: si dos waking a la
 *      vez (despliegue + health check), el segundo espera.
 *
 * `schema.sql` conserva su propio BEGIN/COMMIT a proposito: asi sigue
 * funcionando el flujo manual `psql -f db/schema.sql` documentado en el README.
 */
interface Migration {
    version: string;
    /** Archivo .sql relativo a db/. */
    file?: string;
    /** Migracion de datos en Node (no cabe en SQL puro). */
    run?: (db: Queryable) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
    { version: '001', file: 'schema.sql' },
    // 002 convierte bases con `identity_id` en texto plano al modelo hasheado.
    // Necesita bcrypt + pepper, que PGlite no ofrece en SQL, por eso va en Node.
    // No-op si la base ya es nueva.
    { version: '002', run: upgradeLegacyIdentity },
    // 003 anade `clients.portal_view` a bases que ya tenian 001 aplicada (en
    // schema.sql la columna ya existe, asi que alli es no-op). Es SQL plano
    // compatible con PGlite, por eso si corre en el arranque.
    { version: '003', file: 'migrations/003-clients-portal-view.sql' },
    // 004 crea `otp_codes` en bases anteriores al OTP.
    { version: '004', file: 'migrations/004-otp-codes.sql' },
    // 005 repara los bloqueos falsos que dejo el login viejo (contaba como
    // fallo incluso un acceso correcto).
    { version: '005', file: 'migrations/005-reset-client-login-attempts.sql' },
];

/**
 * Clave del advisory lock. Es arbitraria pero fija: serializa a todos los
 * procesos que apliquen el mismo esquema.
 */
const MIGRATION_LOCK_KEY = 873_221;

export interface MigrationResult {
    applied: string[];
    skipped: string[];
    seeded: boolean;
}

async function ensureRegistry(db: Queryable): Promise<void> {
    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     TEXT PRIMARY KEY,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

/**
 * `seed.sql` toma el correo y la contrasena del administrador de dos GUCs de
 * sesion (`cobranza.seed_email` y `cobranza.seed_password`).
 *
 * Se fijan aqui, ANTES del BEGIN del propio archivo y en el MISMO `exec`. No es
 * un detalle cosmetico: en un pool, `query` y `exec` no garantizan caer en la
 * misma conexion, y un GUC de sesion fijado en una conexion distinta no tendria
 * efecto. Sin esto, `SEED_ADMIN_PASSWORD` se pedia en Render y se ignoraba en
 * silencio, dejando el administrador con la contrasena de desarrollo en una URL
 * publica.
 *
 * Si la variable esta vacia se omite el SET y el seed usa su valor por defecto.
 */
function seedPrelude(): string {
    const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    const settings = [`SET cobranza.seed_email = ${literal(config.auth.seedAdminEmail)};`];
    settings.push(`SET cobranza.identity_pepper = ${literal(config.auth.identityPepper)};`);
    if (config.auth.seedAdminPassword !== '') {
        settings.push(`SET cobranza.seed_password = ${literal(config.auth.seedAdminPassword)};`);
    }
    return settings.join('\n') + '\n';
}

export async function runMigrations(
    db: Queryable,
    options: { seed?: boolean } = {}
): Promise<MigrationResult> {
    const result: MigrationResult = { applied: [], skipped: [], seeded: false };

    await ensureRegistry(db);

    // Lock de SESION (no de transaccion): sobrevive entre sentencias y se
    // libera sola si el proceso muere, a diferencia de un lock persistente.
    let locked = false;
    try {
        await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        locked = true;
    } catch {
        // Si el motor no soporta advisory locks (no deberia en PostgreSQL),
        // se sigue sin lock: es degradar concurrencia, no romper el arranque.
    }

    try {
        const current = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
        const done = new Set(current.rows.map((row) => row.version));

        for (const migration of MIGRATIONS) {
            if (done.has(migration.version)) {
                result.skipped.push(migration.version);
                continue;
            }

            const path = migration.file ? resolve(DB_DIR, migration.file) : null;
            if (path && !existsSync(path)) {
                throw new Error(`No se encontro el archivo de migracion: ${path}`);
            }

            // El archivo lleva su propio BEGIN/COMMIT, asi que va por `exec`
            // (script de varias sentencias) y no por `query`.
            // La version se registra DESPUES, no antes: si el DDL falla a
            // mitad, no debe quedar marcado como aplicado.
            if (path) {
                const sql = await readFile(path, 'utf8');
                await db.exec(sql);
            } else if (migration.run) {
                await migration.run(db);
            } else {
                throw new Error(`La migracion ${migration.version} no tiene archivo ni funcion`);
            }
            await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
            result.applied.push(migration.version);
        }

        if (options.seed) {
            const seeded = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM clients`
            );
            if ((seeded.rows[0]?.n ?? 0) === 0) {
                const seedSql = await readFile(resolve(DB_DIR, 'seed.sql'), 'utf8');
                await db.exec(seedPrelude() + seedSql);
                result.seeded = true;
            }
        }
    } finally {
        if (locked) {
            await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
        }
    }

    return result;
}

export { DB_DIR, MIGRATIONS };
