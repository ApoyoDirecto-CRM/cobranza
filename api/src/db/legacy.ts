/**
 * Migracion 002 (lado Node): convierte una base creada con el esquema inicial
 * al modelo de identidad hasheada.
 *
 * El esquema original guardaba el documento en `clients.identity_id` en texto
 * plano. El actual usa tres columnas:
 *   - identity_hash         bcrypt del documento
 *   - identity_masked       version enmascarada para mostrar
 *   - identity_fingerprint  SHA-256(pepper + documento), UNIQUE
 *
 * No se puede hacer en SQL puro: PGlite no soporta `crypt()`/`gen_salt()` y el
 * backfill necesita el mismo bcrypt y el mismo pepper que usa la aplicacion.
 * Por eso el migrador ejecuta esta funcion en Node.
 *
 * Es idempotente: si `identity_id` no existe (base nueva o ya migrada) no hace
 * nada. La vista `v_client_portfolio` se elimina aqui porque la version vieja
 * referencia `identity_id`; la 003 la vuelve a crear con las columnas nuevas.
 */

import type { Queryable } from './client.js';
import { fingerprintIdentity, hashIdentity, maskIdentity } from '../shared/identity.js';

async function columnExists(db: Queryable, column: string): Promise<boolean> {
    const result = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = $1`,
        [column]
    );
    return result.rows.length > 0;
}

async function constraintExists(db: Queryable, name: string): Promise<boolean> {
    const result = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`,
        [name]
    );
    return result.rows.length > 0;
}

export async function upgradeLegacyIdentity(db: Queryable): Promise<void> {
    if (!(await columnExists(db, 'identity_id'))) return;

    // La vista vieja depende de identity_id; se recrea en la 003.
    await db.exec('DROP VIEW IF EXISTS v_client_portfolio;');

    await db.exec(`
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS identity_hash TEXT;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS identity_masked TEXT;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS identity_fingerprint CHAR(64);
    `);

    const clients = await db.query<{ id: number; identity_id: string }>(
        `SELECT id, identity_id FROM clients`
    );

    for (const client of clients.rows) {
        const value = client.identity_id;
        await db.query(
            `UPDATE clients
                SET identity_hash = $1,
                    identity_masked = $2,
                    identity_fingerprint = $3
              WHERE id = $4`,
            [await hashIdentity(value), maskIdentity(value), fingerprintIdentity(value), client.id]
        );
    }

    // DROP COLUMN ... CASCADE retira el UNIQUE y el CHECK que colgaban de la
    // columna vieja (clients_identity_id_key y clients_identity_ck).
    await db.exec(`
        ALTER TABLE clients DROP COLUMN IF EXISTS identity_id CASCADE;
        ALTER TABLE clients ALTER COLUMN identity_hash SET NOT NULL;
        ALTER TABLE clients ALTER COLUMN identity_masked SET NOT NULL;
        ALTER TABLE clients ALTER COLUMN identity_fingerprint SET NOT NULL;
    `);

    // Mismos nombres que schema.sql: el codigo mapea el UNIQUE a un 409.
    if (!(await constraintExists(db, 'clients_identity_fingerprint_key'))) {
        await db.exec(`
            ALTER TABLE clients
                ADD CONSTRAINT clients_identity_fingerprint_key UNIQUE (identity_fingerprint);
        `);
    }
    if (!(await constraintExists(db, 'clients_identity_fingerprint_ck'))) {
        await db.exec(`
            ALTER TABLE clients
                ADD CONSTRAINT clients_identity_fingerprint_ck
                CHECK (identity_fingerprint ~ '^[0-9a-f]{64}$');
        `);
    }
}
