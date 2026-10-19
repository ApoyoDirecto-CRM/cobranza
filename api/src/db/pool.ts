/**
 * Driver de produccion: PostgreSQL por red con `pg`.
 *
 * El contrato lo consume `db/index.ts`; el resto de la aplicacion nunca importa
 * este modulo directamente, para que el motor sea intercambiable (ver
 * db/local.ts).
 */
import pg from 'pg';
import { config } from '../config/env.js';
import type { Queryable } from './client.js';

/**
 * `pg` devuelve los enteros de BIGINT como cadena para no perder precision.
 * Los conteos de cartera caben holgadamente en Number, asi que se convierten
 * al vuelo; los importes siguen siendo cadenas y los maneja shared/money.ts.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => value);
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
    if (pool) return pool;

    pool = new pg.Pool({
        connectionString: config.database.url,
        max: config.database.poolMax,
        idleTimeoutMillis: config.database.idleTimeoutMs,
        connectionTimeoutMillis: config.database.connectTimeoutMs,
        ssl: config.database.ssl,
        application_name: 'cobranza-api',
    });

    // Un error en una conexion ociosa no debe tumbar el proceso: la siguiente
    // peticion tomara una conexion nueva.
    pool.on('error', (error) => {
        console.error('[db] error en conexion ociosa:', error.message);
    });

    return pool;
}

/**
 * El pool cumple el contrato `Queryable`.
 *
 * Se envuelve en un objeto con `query` y `exec` enlazados: `exec` no existe en
 * `pg`, pero es necesario para aplicar archivos .sql con varias sentencias
 * (pg usa el protocolo simple cuando no hay parametros, que es lo unico que
 * admite multi-sentencia).
 */
let dbAdapter: Queryable | null = null;

export function initPostgresDb(): Queryable {
    if (dbAdapter) return dbAdapter;

    const pool = getPool();
    const adapter: Queryable = {
        query: async <R>(text: string, params?: readonly unknown[]) => {
            const result = await pool.query(text, params as unknown[]);
            return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
        },
        exec: async (sql: string) => {
            await pool.query(sql);
        },
    };

    dbAdapter = adapter;
    return adapter;
}

export async function closePostgres(): Promise<void> {
    dbAdapter = null;
    if (pool) {
        await pool.end();
        pool = null;
    }
}

/** Sonda de disponibilidad usada por /health. */
export async function checkPostgres(): Promise<boolean> {
    try {
        const result = await getPool().query('SELECT 1 AS ok');
        return result.rows[0]?.ok === 1;
    } catch {
        return false;
    }
}
