import { initDb, closeDb } from './index.js';
import { runMigrations } from './migrator.js';

/**
 * CLI de migraciones para uso local: `npm run db:migrate`.
 *
 * En Render NO se usa: el plan gratuito no tiene `preDeployCommand`, asi que
 * las migraciones corren al arrancar el servidor (ver server.ts).
 *
 * El .env se carga solo al importar `config/env.js` (a traves de ./index.js).
 */
async function main(): Promise<void> {
    const command = process.argv[2] ?? 'up';
    const db = await initDb();

    if (command === 'reset') {
        console.log('  borrando el esquema public...');
        await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        const applied = await runMigrations(db, { seed: true });
        console.log(
            applied.seeded
                ? `Base reinicializada (migraciones: ${applied.applied.join(', ')}) con datos de demostracion.`
                : `Base reinicializada (migraciones: ${applied.applied.join(', ')}).`
        );
        return;
    }

    const result = await runMigrations(db, { seed: command === 'seed' || command === 'up' });

    if (result.applied.length > 0) {
        console.log(`  migraciones aplicadas: ${result.applied.join(', ')}`);
    } else {
        console.log(`  esquema al dia (omitidas: ${result.skipped.join(', ')})`);
    }
    console.log(result.seeded ? '  datos de demostracion insertados' : '  listo');
    await closeDb();
}

main().catch(async (error: unknown) => {
    console.error('\n[ERROR]', error instanceof Error ? error.message : error);
    if (error instanceof Error && 'code' in error) {
        const detail = error as { detail?: string; hint?: string };
        if (detail.detail) console.error('Detalle:', detail.detail);
        if (detail.hint) console.error('Sugerencia:', detail.hint);
    }
    console.error('\nRevisa que DATABASE_URL apunte a una base PostgreSQL existente.');
    await closeDb();
    process.exit(1);
});
