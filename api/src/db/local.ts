/**
 * Driver local: PGlite, PostgreSQL 18 compilado a WebAssembly, dentro del
 * propio proceso de Node.
 *
 * Existe para levantar el sistema completo en local sin Docker ni un servidor
 * PostgreSQL, que es justo el entorno de esta maquina. No es una reimplementacion
 * ni un mock: PGlite ES PostgreSQL, asi que corren los mismos tipos, los mismos
 * CONSTRAINT TRIGGER diferidos y las mismas funciones (crypt, gen_salt, citext).
 * El SQL de negocio no cambia ni una linea.
 *
 * NO sirve para produccion: la base vive dentro del proceso. `config/env.ts`
 * aborta el arranque si se combina con NODE_ENV=production.
 */
import { mkdir } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import type { QueryResult, Queryable } from './client.js';

let instance: PGlite | null = null;
let dbAdapter: Queryable | null = null;

/**
 * `dataDir` vacio crea la base EN MEMORIA (nace vacia en cada arranque). Un
 * directorio la persiste entre reinicios.
 */
export async function initLocalDb(dataDir = ''): Promise<Queryable> {
    if (dbAdapter) return dbAdapter;

    // Import dinamico a proposito: PGlite es una devDependency. En produccion el
    // driver es `postgres` y el paquete ni siquiera esta instalado, asi que un
    // `import` estatico romperia `npm start` alli.
    const { PGlite: PGliteClass, types } = await import('@electric-sql/pglite');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');

    if (dataDir) {
        await mkdir(dataDir, { recursive: true });
    }

    const pglite = await PGliteClass.create({
        extensions: { pgcrypto, citext, pg_trgm },
        ...(dataDir ? { dataDir } : {}),
    });
    instance = pglite;

    const adapter: Queryable = {
        async query<R = Record<string, unknown>>(
            text: string,
            params: readonly unknown[] = []
        ): Promise<QueryResult<R>> {
            const result = await pglite.query<R>(text, params as unknown[], {
                // Debe replicar exactamente los type parsers de db/pool.ts. Si no,
                // local devolveria DATE como objeto Date y NUMERIC como numero, y
                // se probaria un camino que en produccion no existe.
                parsers: {
                    [types.DATE]: (value: string) => value,
                    [types.NUMERIC]: (value: string) => value,
                    [types.INT8]: (value: string) => Number.parseInt(value, 10),
                },
            });
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
        // `pglite.query` usa el protocolo extendido, que no admite varias
        // sentencias en un viaje. `exec` es el equivalente del protocolo simple
        // que `pg` usa cuando la sentencia no lleva parametros, y es lo que
        // necesitan los archivos .sql y los scripts BEGIN; ...; COMMIT;
        async exec(sql: string): Promise<void> {
            await pglite.exec(sql);
        },
    };

    dbAdapter = adapter;
    return adapter;
}

/** Sonda de disponibilidad usada por /health. */
export async function checkLocal(): Promise<boolean> {
    if (!instance) return false;
    try {
        const result = await instance.query<{ ok: number }>('SELECT 1 AS ok');
        return result.rows[0]?.ok === 1;
    } catch {
        return false;
    }
}

export async function closeLocal(): Promise<void> {
    dbAdapter = null;
    if (instance) {
        await instance.close();
        instance = null;
    }
}
