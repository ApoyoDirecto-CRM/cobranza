/**
 * Contrato minimo de acceso a datos.
 *
 * Lo cumple tanto `pg.Pool` (produccion) como PGlite (pruebas). Gracias a esta
 * interfaz las pruebas de integracion corren contra PostgreSQL real sin
 * levantar un servidor, sin duplicar una sola linea de SQL.
 */
export interface QueryResult<R> {
    rows: R[];
    rowCount: number;
}

export interface Queryable {
    query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
    /**
     * Ejecuta un SCRIPT de varias sentencias (`BEGIN; ...; COMMIT;`).
     *
     * Va separado de `query` a proposito: `pg` usa el protocolo simple cuando
     * la sentencia no lleva parametros, y ese es el unico modo que admite
     * varias sentencias en un solo viaje. Por eso los archivos .sql se aplican
     * con `exec` y no con `query`.
     *
     * Implementadores: `pg` (protocolo simple) y PGlite (`pglite.exec`).
     */
    exec(sql: string): Promise<void>;
}

export type Row = Record<string, unknown>;

/**
 * Toda operacion que mueva dinero debe correr dentro de una transaccion
 * explicita: los CONSTRAINT TRIGGER del esquema son diferidos a proposito y
 * solo consolidan en el COMMIT. Fuera de una transaccion, PostgreSQL abre una
 * implicita por sentencia y el error de integridad llegaria tarde y sin que
 * pudiéramos revertir el trabajo previo.
 */
export async function withTransaction<T>(
    db: Queryable,
    fn: (tx: Queryable) => Promise<T>
): Promise<T> {
    await db.query('BEGIN');
    try {
        const result = await fn(db);
        await db.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await db.query('ROLLBACK');
        } catch {
            // Si la transaccion ya estaba abortada, el ROLLBACK tambien falla:
            // el error original es el que importa.
        }
        throw error;
    }
}

/** Primera fila o `undefined`. Evita el `[0]` disperso por el codigo. */
export async function queryOne<R extends Row>(
    db: Queryable,
    text: string,
    params?: readonly unknown[]
): Promise<R | undefined> {
    const result = await db.query<R>(text, params);
    return result.rows[0];
}

/** Primera fila o error 404. */
export async function queryOneOrFail<R extends Row>(
    db: Queryable,
    text: string,
    params: readonly unknown[],
    message = 'Recurso no encontrado'
): Promise<R> {
    const row = await queryOne<R>(db, text, params);
    if (!row) throw new Error(message);
    return row;
}
