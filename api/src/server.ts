import { config } from './config/env.js';
import { buildApp } from './app.js';
import { initDb, closeDb, checkDatabase } from './db/index.js';
import { runMigrations } from './db/migrator.js';

async function main(): Promise<void> {
    const db = await initDb();

    // Fallar pronto y con un mensaje util es mejor que aceptar trafico y fallar
    // en cada consulta.
    //
    // En Render el arranque puede tardar hasta un minuto (cold start), asi que
    // el reintento no es un lujo: la base gratuita tambien se reinicia por
    // mantenimiento y un unico fallo dejaria el servicio caido hasta el
    // siguiente despliegue.
    let dbReady = false;
    for (let attempt = 1; attempt <= 10 && !dbReady; attempt++) {
        dbReady = await checkDatabase();
        if (!dbReady) {
            console.log(`Base de datos no disponible, reintento ${attempt}/10 en 3s...`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }

    if (!dbReady) {
        console.error(
            '\n[ERROR] No se pudo conectar a PostgreSQL tras 10 intentos.\n' +
            `        DATABASE_URL=${maskUrl(config.database.url)}\n` +
            '        Si esto es Render, revisa que la base este activa y no haya expirado.\n'
        );
        process.exit(1);
    }

    // En Render gratuito no hay `preDeployCommand`, asi que las migraciones
    // corren aqui. Son idempotentes: el servicio se reinicia muchas veces al
    // dia por el cold start.
    if (config.deploy.autoMigrate) {
        const started = Date.now();
        const result = await runMigrations(db, { seed: config.deploy.seedOnDeploy });
        const ms = Date.now() - started;

        if (result.applied.length > 0) {
            console.log(`[migraciones] aplicadas ${result.applied.join(', ')} en ${ms}ms`);
        } else {
            console.log(`[migraciones] esquema al dia (omitidas ${result.skipped.join(', ')})`);
        }
        if (result.seeded) console.log('[migraciones] datos de demostracion insertados');
    }

    const app = await buildApp({ db });

    const shutdown = async (signal: string): Promise<void> => {
        app.log.info(`${signal} recibido, cerrando...`);
        try {
            // Cierra el servidor antes que la conexion: si no, una peticion en
            // vuelo pierde su conexion y el cliente ve un 502 en el despliegue.
            await app.close();
            await closeDb();
            process.exit(0);
        } catch (error) {
            app.log.error({ err: error }, 'error durante el cierre');
            process.exit(1);
        }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // Render envia SIGTERM y espera hasta 120s: el pool debe cerrarse limpio.
    await app.listen({ host: config.host, port: config.port });

    const name = config.deploy.serviceName || 'cobranza';
    console.log(`\n  ${name} escuchando en http://localhost:${config.port}`);
    console.log(`  Portal:   http://localhost:${config.port}/portal`);
    console.log(`  Panel:    http://localhost:${config.port}/admin`);
    console.log(`  OpenAPI:  http://localhost:${config.port}/docs\n`);
}

function maskUrl(url: string): string {
    return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@');
}

main().catch((error) => {
    console.error('Fallo al arrancar la API:', error);
    void closeDb();
    process.exit(1);
});
