/**
 * Punto unico de acceso a la base de datos.
 *
 * Elige el driver segun `DB_DRIVER` y devuelve siempre el mismo contrato
 * `Queryable`, de modo que ni las rutas ni el SQL de negocio saben -- ni deben
 * saber -- que motor hay debajo:
 *
 *   postgres -> `pg` contra DATABASE_URL (produccion)
 *   pglite   -> PostgreSQL WASM en proceso (pruebas en local, sin Docker)
 *
 * Antes de esto, `server.ts` y `migrate.ts` importaban `db/pool.ts` directamente,
 * lo que ataba la aplicacion a `pg` y hacia imposible arrancar sin un servidor.
 */
import { config } from '../config/env.js';
import type { Queryable } from './client.js';
import { initPostgresDb, checkPostgres, closePostgres } from './pool.js';
import { initLocalDb, checkLocal, closeLocal } from './local.js';

let db: Queryable | null = null;

const isLocal = (): boolean => config.database.driver === 'pglite';

/**
 * Crea (una sola vez) la conexion. Es asincrona porque PGlite necesita
 * construirse; con `postgres` simplemente crea el pool, que no conecta hasta la
 * primera consulta.
 */
export async function initDb(): Promise<Queryable> {
    if (db) return db;
    db = isLocal() ? await initLocalDb(config.database.pgliteDataDir) : initPostgresDb();
    return db;
}

/** Sonda para /health y para el bucle de reintentos del arranque. */
export async function checkDatabase(): Promise<boolean> {
    return isLocal() ? checkLocal() : checkPostgres();
}

export async function closeDb(): Promise<void> {
    db = null;
    if (isLocal()) await closeLocal();
    else await closePostgres();
}
