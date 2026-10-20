import './testing/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestDb, seedAdmin, type TestDb } from './testing/harness.js';
import { TEST_ADMIN_PASSWORD } from './testing/setup-env.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrator.js';
import type { FastifyInstance } from 'fastify';

let harness: TestDb;
let app: FastifyInstance;

before(async () => {
    harness = await createTestDb();
    app = await buildApp({ db: harness.db, logger: false, staticRoot: null });
    await app.ready();
});

after(async () => {
    await app?.close();
    await harness?.close();
});

/**
 * Cada prueba de migraciones usa una base NUEVA.
 *
 * Intentar reutilizarla con `DROP SCHEMA public CASCADE` no es fiable: los
 * ENUM sobreviven al drop en PGlite y la siguiente aplicacion falla con
 * "type already exists". Instancia nueva por prueba: mas lenta, pero cada
 * caso arranca exactamente como arrancaria un servicio recien desplegado.
 */
async function withFreshDb(fn: (db: TestDb['db']) => Promise<void>): Promise<void> {
    const fresh = await createTestDb({ migrate: false });
    try {
        await fn(fresh.db);
    } finally {
        await fresh.close();
    }
}

describe('Migraciones en el arranque', () => {
    it('aplica el esquema la primera vez', async () => {
        await withFreshDb(async (db) => {
            const result = await runMigrations(db);

            assert.deepEqual(result.applied, ['001', '003']);
            assert.deepEqual(result.skipped, []);
            assert.equal(result.seeded, false, 'sin seed=true no debe sembrar');

            const clientes = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM clients`
            );
            assert.equal(Number(clientes.rows[0]?.n), 0, 'la tabla clients existe y esta vacia');

            const columna = await db.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'clients' AND column_name = 'portal_view'`
            );
            assert.equal(columna.rows.length, 1, 'portal_view debe existir tras migrar');
        });
    });

    /**
     * Regresion: la columna portal_view se anadio a schema.sql una vez que la
     * base de desarrollo ya tenia 001 aplicada. Sin registrarla como migracion,
     * esas bases se quedan sin la columna y el login del portal responde 500.
     */
    it('003 anade portal_view a una base que ya tenia 001 aplicada', async () => {
        await withFreshDb(async (db) => {
            await runMigrations(db);

            // Se simula el esquema viejo: la columna no existia (habia que
            // quitar la vista antes, porque depende de ella) y 003 no constaba.
            await db.exec(
                `DROP VIEW v_client_portfolio;
                 ALTER TABLE clients DROP COLUMN portal_view;
                 DELETE FROM schema_migrations WHERE version = '003';`
            );

            const result = await runMigrations(db);
            assert.ok(result.applied.includes('003'), 'debe aplicar 003');

            const columna = await db.query(
                `SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'clients' AND column_name = 'portal_view'`
            );
            assert.equal(columna.rows.length, 1, 'portal_view debe reaparecer');

            const vista = await db.query(
                `SELECT 1 FROM information_schema.views
                  WHERE table_name = 'v_client_portfolio'`
            );
            assert.equal(vista.rows.length, 1, 'la vista debe recrearse');
        });
    });

    it('es idempotente: el segundo arranque no vuelve a aplicar nada', async () => {
        await withFreshDb(async (db) => {
            await runMigrations(db);
            const segunda = await runMigrations(db);

            assert.deepEqual(segunda.applied, [], 'no debe reaplicar migraciones ya aplicadas');
            assert.deepEqual(segunda.skipped, ['001', '003']);
        });
    });

    it('sobrevive a reinicios repetidos, como el cold start de Render', async () => {
        await withFreshDb(async (db) => {
            // El primer arranque crea el esquema; a partir de ahi debe ser un
            // no-op. El servicio gratuito se duerme a los 15 min y despierta
            // muchas veces al dia: repetir el arranque tiene que ser seguro.
            const primera = await runMigrations(db);
            assert.deepEqual(primera.applied, ['001', '003'], 'el primer arranque crea el esquema');

            for (let reinicio = 1; reinicio <= 5; reinicio++) {
                const result = await runMigrations(db);
                assert.deepEqual(
                    result.applied, [],
                    `reinicio ${reinicio} reaplico el esquema`
                );
                assert.deepEqual(result.skipped, ['001', '003']);
            }

            const applied = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = '001'`
            );
            assert.equal(Number(applied.rows[0]?.n), 1, 'no debe duplicar el registro');
        });
    });

    it('toma y libera el lock de sesion en cada arranque', async () => {
        await withFreshDb(async (db) => {
            // El lock serializa despliegues concurrentes en Render. No puede
            // quedar retenido: si se colgara, el siguiente arranque esperaria
            // para siempre y el servicio se quedaria caido.
            await runMigrations(db);

            const locks = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`
            );
            assert.equal(Number(locks.rows[0]?.n), 0, 'el lock debe quedar liberado');

            // Y debe poder tomarse otra vez sin quedarse esperando.
            await db.query('SELECT pg_advisory_lock($1)', [873_221]);
            const tomado = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`
            );
            assert.equal(Number(tomado.rows[0]?.n), 1, 'el lock se puede volver a tomar');
            await db.query('SELECT pg_advisory_unlock($1)', [873_221]);
        });
    });

    /**
     * LIMITACION DE ESTE ARNES, no del diseno.
     *
     * La serializacion entre dos procesos NO se puede probar aqui: PGlite tiene
     * una unica sesion y los advisory locks de PostgreSQL son REENTRANTES
     * dentro de la misma sesion, asi que dos llamadas concurrentes sobre ella
     * nunca se bloquean entre si.
     *
     * En produccion cada proceso usa su propia conexion del pool, luego cada
     * llamada es una sesion distinta y el lock si serializa. Lo que si se
     * verifica arriba es que el lock se toma y se suelta correctamente.
     */
    it('el lock es efectivo dentro de una sesion', async () => {
        await withFreshDb(async (db) => {
            // Reentrante en la misma sesion: la segunda toma no debe fallar,
            // y el contador de unlocks debe cuadrar.
            await db.query('SELECT pg_advisory_lock($1)', [873_221]);
            await db.query('SELECT pg_advisory_lock($1)', [873_221]);
            await db.query('SELECT pg_advisory_unlock($1)', [873_221]);

            // Queda una toma pendiente: sigue bloqueado.
            const pendiente = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`
            );
            assert.equal(Number(pendiente.rows[0]?.n), 1, 'la segunda toma sigue viva');

            await db.query('SELECT pg_advisory_unlock($1)', [873_221]);
        });
    });

    it('con seed siembra la base solo si esta vacia', async () => {
        await withFreshDb(async (db) => {
            await runMigrations(db, { seed: true });
            const segunda = await runMigrations(db, { seed: true });

            assert.equal(segunda.seeded, false, 'una base con datos no se vuelve a sembrar');

            const clientes = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM clients`
            );
            assert.ok(Number(clientes.rows[0]?.n) > 0, 'el seed dejo clientes');

            const admins = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM admin_users`
            );
            assert.equal(Number(admins.rows[0]?.n), 1, 'un solo admin, sin duplicar por reintento');
        });
    });

    it('siembra el administrador con la contrasena de SEED_ADMIN_PASSWORD', async () => {
        await withFreshDb(async (db) => {
            await runMigrations(db, { seed: true });

            // db/seed.sql lee la contrasena de un GUC de sesion que fija el
            // migrador. Sin eso, el administrador quedaba con la clave de
            // desarrollo y SEED_ADMIN_PASSWORD se ignoraba en silencio: una
            // credencial conocida en una URL publica.
            const conVariable = await db.query<{ ok: boolean }>(
                `SELECT (password_hash = crypt($1, password_hash)) AS ok FROM admin_users`,
                [TEST_ADMIN_PASSWORD]
            );
            assert.equal(conVariable.rows[0]?.ok, true, 'debe usar SEED_ADMIN_PASSWORD');

            const conDefecto = await db.query<{ ok: boolean }>(
                `SELECT (password_hash = crypt('CambiarEstePassword1!', password_hash)) AS ok FROM admin_users`
            );
            assert.equal(conDefecto.rows[0]?.ok, false, 'no debe quedar la clave de desarrollo');
        });
    });

    it('no siembra si la base ya tiene datos aunque se pida', async () => {
        await withFreshDb(async (db) => {
            await runMigrations(db, { seed: true });
            const antes = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM clients`
            );

            // Segundo arranque con seed=true: no debe duplicar la cartera.
            await runMigrations(db, { seed: true });
            const despues = await db.query<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM clients`
            );

            assert.equal(Number(despues.rows[0]?.n), Number(antes.rows[0]?.n));
        });
    });
});

describe('Sirviendo API y portal desde un mismo proceso', () => {
    before(async () => {
        await app.close();
        harness = await createTestDb();
        await harness.reset();
        await seedAdmin(harness.db);
        // staticRoot null: aqui se prueba que sin build la API responde JSON.
        app = await buildApp({ db: harness.db, logger: false, staticRoot: null });
        await app.ready();
    });

    it('sin build del frontend, las rutas de API responden JSON', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/portal/summary' });
        assert.equal(res.statusCode, 401);
        assert.equal(res.headers['content-type']?.includes('application/json'), true);
    });

    it('sin build, una ruta desconocida da 404 JSON (no HTML)', async () => {
        const res = await app.inject({ method: 'GET', url: '/ruta/que/no/existe' });
        assert.equal(res.statusCode, 404);
        assert.equal(res.headers['content-type']?.includes('application/json'), true);
        assert.equal(res.json().error.code, 'NOT_FOUND');
    });

    it('/health responde con el estado de la base', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.database, 'up');
        assert.ok(body.serverTime, 'debe reportar la hora del servidor');
    });
});
