import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config/env.js';
import type { Queryable } from '../db/client.js';
import { withTransaction } from '../db/client.js';
import { AppError, unauthorized } from '../shared/errors.js';

/**
 * Discriminante de sujeto. Sin esto, un access token de cliente que se
 * colara en una ruta /admin passes el chequeo de firma: ambos firmadores son
 * del mismo servidor. `typ` separa los dos dominios de identidad.
 */
export type TokenType = 'client' | 'admin';

export interface AccessTokenClaims {
    sub: string;
    typ: TokenType;
    /** Rol del administrador; ausente en tokens de cliente. */
    role?: string;
    iat?: number;
    exp?: number;
}

export function signAccessToken(
    app: FastifyInstance,
    subjectId: number,
    typ: TokenType,
    role?: string
): string {
    return app.jwt.sign(
        { typ, ...(role ? { role } : {}) },
        { sub: String(subjectId), expiresIn: config.auth.accessTtl }
    );
}

/**
 * Solo se guarda el hash SHA-256 del refresh token. Una filtracion de la base
 * no permite suplantar sesiones activas, y permite buscar e invalidar por
 * token concreto.
 */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
}

export interface PersistedSession {
    id: number;
    subjectType: TokenType;
    subjectId: number;
}

export async function persistRefreshToken(
    db: Queryable,
    subjectType: TokenType,
    subjectId: number,
    token: string,
    meta: { userAgent?: string; ip?: string } = {}
): Promise<PersistedSession> {
    const expiresAt = new Date(
        Date.now() + config.auth.refreshTtlDays * 24 * 60 * 60 * 1000
    );
    const result = await db.query<{ id: string }>(
        `INSERT INTO refresh_tokens
           (subject_type, subject_id, token_hash, user_agent, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
            subjectType,
            subjectId,
            hashToken(token),
            meta.userAgent?.slice(0, 255) ?? null,
            meta.ip ?? null,
            expiresAt.toISOString(),
        ]
    );
    return {
        id: Number(result.rows[0]?.id),
        subjectType,
        subjectId,
    };
}

/**
 * Rota un refresh token: revoca el presented y emite uno nuevo.
 *
 * Deteccion de reutilizacion: si llega un token que ya estaba revocado, se
 * asume que fue robado y se revoca TODA la sesion del sujeto. Es la unica
 * defense util ante un token filtrado: invalida tanto al atacante como al
 * titular legitimo, que tendra que autenticarse de nuevo.
 */
export async function rotateRefreshToken(
    db: Queryable,
    token: string,
    meta: { userAgent?: string; ip?: string } = {}
): Promise<{ subjectType: TokenType; subjectId: number; refreshToken: string }> {
    // La deteccion de reutilizacion revoca sesiones dentro de la transaccion,
    // pero el error se lanza DESPUES del commit: si se lanzara dentro, el
    // rollback dejaria las sesiones revocadas sin confirmar.
    let reuseDetected = false;

    const result = await withTransaction(db, async (tx) => {
        const existing = await tx.query<{
            id: string; subject_type: TokenType; subject_id: string;
            expires_at: string; revoked_at: string | null;
        }>(
            `SELECT id, subject_type, subject_id, expires_at, revoked_at
               FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
            [hashToken(token)]
        );
        const row = existing.rows[0];

        if (!row) {
            throw unauthorized('Sesion no valida');
        }

        if (row.revoked_at) {
            await tx.query(
                `UPDATE refresh_tokens SET revoked_at = now()
                  WHERE subject_type = $1 AND subject_id = $2 AND revoked_at IS NULL`,
                [row.subject_type, row.subject_id]
            );
            reuseDetected = true;
            return null;
        }

        if (new Date(row.expires_at).getTime() <= Date.now()) {
            throw unauthorized('La sesion expiro');
        }

        const fresh = generateRefreshToken();
        const inserted = await tx.query<{ id: string }>(
            `INSERT INTO refresh_tokens
               (subject_type, subject_id, token_hash, user_agent, ip_address, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
             RETURNING id`,
            [
                row.subject_type,
                row.subject_id,
                hashToken(fresh),
                meta.userAgent?.slice(0, 255) ?? null,
                meta.ip ?? null,
                String(config.auth.refreshTtlDays),
            ]
        );

        await tx.query(
            `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
            [row.id, inserted.rows[0]?.id ?? null]
        );

        return {
            subjectType: row.subject_type,
            subjectId: Number(row.subject_id),
            refreshToken: fresh,
        };
    });

    if (reuseDetected || result === null) {
        throw unauthorized('Sesion invalidada por seguridad. Vuelve a iniciar sesion.');
    }
    return result;
}

/** Revoca una sesion concreta (logout). Idempotente. */
export async function revokeRefreshToken(db: Queryable, token: string): Promise<void> {
    await db.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
        [hashToken(token)]
    );
}

export async function revokeAllSessions(
    db: Queryable,
    subjectType: TokenType,
    subjectId: number
): Promise<void> {
    await db.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE subject_type = $1 AND subject_id = $2 AND revoked_at IS NULL`,
        [subjectType, subjectId]
    );
}

/**
 * Verifica el access token y confirma que es del tipo esperado.
 * El parametro `expect` es lo que impide que un token de cliente sirva para
 * llamar a la API administrativa.
 */
export function verifyAccessToken(
    app: FastifyInstance,
    token: string,
    expect: TokenType
): AccessTokenClaims {
    try {
        const claims = app.jwt.verify<AccessTokenClaims>(token);
        if (claims.typ !== expect) {
            throw unauthorized('Credencial de otro tipo');
        }
        if (!claims.sub) throw unauthorized('Credencial incompleta');
        return claims;
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw unauthorized('Sesion expirada o invalida');
    }
}

/** Limpieza periodica de sesiones caducadas. */
export async function purgeExpiredSessions(db: Queryable): Promise<number> {
    const result = await db.query(
        `DELETE FROM refresh_tokens
          WHERE expires_at < now() - interval '30 days'`
    );
    return result.rowCount;
}
