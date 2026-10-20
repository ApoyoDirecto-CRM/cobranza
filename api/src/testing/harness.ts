import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Queryable, QueryResult } from '../db/client.js';
import { config } from '../config/env.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DB_DIR = resolve(here, '../../../db');

/**
 * Base de datos de pruebas.
 *
 * PGlite es PostgreSQL compilado a WebAssembly: el MISMO motor, los mismos
 * tipos, los mismos triggers y las mismas reglas que en produccion. Gracias a
 * eso las pruebas ejercen el SQL real -- en concreto los CONSTRAINT TRIGGER
 * diferidos del esquema, que son la parte que mas se rompe en silencio.
 *
 * `pg` (produccion) y PGlite (pruebas) se adaptan al contrato `Queryable`, de
 * modo que no existe una segunda copia del SQL de negocio.
 */
export interface TestDb {
    db: Queryable;
    pglite: PGlite;
    /** Vacia el esquema y vuelve a aplicar schema.sql + seed.sql. */
    reset(): Promise<void>;
    /** Aplica unicamente el esquema, sin datos. */
    migrate(): Promise<void>;
    close(): Promise<void>;
}

export interface TestDbOptions {
    /** Aplica seed.sql ademas del esquema. Default: true. */
    seed?: boolean;
    /**
     * Aplica schema.sql al crear la base. Default: true.
     *
     * `false` deja la base VACIA, que es lo que necesitan las pruebas de
     * migraciones: si el esquema ya esta aplicado, no se puede comprobar que
     * la migracion lo crea desde cero.
     */
    migrate?: boolean;
}

export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
    const pglite = await PGlite.create({
        extensions: { pgcrypto, citext, pg_trgm },
    });

    const db: Queryable = {
        async query<R = Record<string, unknown>>(
            text: string,
            params: readonly unknown[] = []
        ): Promise<QueryResult<R>> {
            const result = await pglite.query<R>(text, params as unknown[], {
                // Debe replicar exactamente los type parsers de db/pool.ts.
                // Si no, PGlite devolveria DATE como objeto Date y NUMERIC
                // como numero, y las pruebas pasarian por un camino que en
                // produccion no existe.
                parsers: {
                    [types.DATE]: (value: string) => value,
                    [types.NUMERIC]: (value: string) => value,
                    [types.INT8]: (value: string) => Number.parseInt(value, 10),
                },
            });
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
        // `pglite.query` usa el protocolo extendido, que no admite varias
        // sentencias en un viaje. `exec` es su equivalente del protocolo simple
        // que usa `pg` cuando la sentencia no lleva parametros.
        async exec(sql: string): Promise<void> {
            await pglite.exec(sql);
        },
    };

    const execFile = async (file: string): Promise<void> => {
        const sql = await readFile(resolve(DB_DIR, file), 'utf8');
        await pglite.exec(sql);
    };

    // En produccion el migrador fija estos GUCs antes del seed; aqui se hace
    // lo mismo para que seed.sql no dependa de valores implicitos.
    const execSeed = async (): Promise<void> => {
        const sql = await readFile(resolve(DB_DIR, 'seed.sql'), 'utf8');
        const literal = config.auth.identityPepper.replace(/'/g, "''");
        await pglite.exec(`SET cobranza.identity_pepper = '${literal}';\n${sql}`);
    };

    const harness: TestDb = {
        db,
        pglite,
        async migrate() {
            await pglite.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
            await execFile('schema.sql');
        },
        async reset() {
            await pglite.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
            await execFile('schema.sql');
            if (options.seed !== false) await execSeed();
        },
        async close() {
            await pglite.close();
        },
    };

    if (options.migrate !== false) {
        await harness.migrate();
        if (options.seed !== false) await harness.reset();
    } else if (options.seed === true) {
        await execFile('schema.sql');
        await execSeed();
    }
    return harness;
}

/** PGlite devuelve una sesion con auth por defecto; el admin se crea con SQL. */
export async function seedAdmin(
    db: Queryable,
    email = 'admin@test.local',
    password = 'TestPassword123!'
): Promise<number> {
    const created = await db.query<{ id: string }>(
        `INSERT INTO admin_users (email, full_name, password_hash, role, password_changed_at)
         VALUES ($1, 'Admin de prueba', crypt($2, gen_salt('bf', 12)), 'admin', now())
         RETURNING id`,
        [email, password]
    );
    return Number(created.rows[0]?.id);
}
