import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Queryable } from '../db/client.js';

const scryptAsync = promisify(scrypt) as (
    password: string | Buffer,
    salt: string | Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * Hash de contrasenas con scrypt (node:crypto), sin dependencias nativas.
 *
 * Parametros acordes a OWASP para scrypt: N=2^16, r=8, p=1 con una clave de
 * 64 bytes. `maxmem` se sube porque el valor por defecto de Node (32 MB) es
 * insuficiente para N=65536 y el hash fallaria en tiempo de ejecucion.
 *
 * Formato almacenado: scrypt$N$r$p$saltBase64$hashBase64
 * Including the parametros permite subirlos de coste mas adelante sin
 * invalidar los hashes existentes.
 */
const N = 2 ** 16;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password: string): Promise<string> {
    if (password.length < 10) {
        throw new RangeError('La contrasena debe tener al menos 10 caracteres');
    }
    const salt = randomBytes(16);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, {
        N, r: R, p: P, maxmem: MAXMEM,
    });
    return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
        string, string, string, string, string, string,
    ];
    const cost = Number(nRaw);
    const blockSize = Number(rRaw);
    const parallel = Number(pRaw);
    if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallel)) {
        return false;
    }

    const expected = Buffer.from(hashB64, 'base64');
    let derived: Buffer;
    try {
        derived = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'),
            expected.length, { N: cost, r: blockSize, p: parallel, maxmem: 128 * cost * blockSize * 2 });
    } catch {
        return false;
    }

    return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Compara una contrasena contra el hash de PostgreSQL
 * (pgcrypto: crypt($1, gen_salt('bf'))), que es lo que usa db/seed.sql, para
 * que el admin sembrado por SQL y los creados por la API convivan en la misma
 * columna.
 *
 * La comparacion se evalua en la base y sobre la fila del usuario concreto, no
 * en el proceso: asi el hash nunca sale de PostgreSQL y no queda expuesta una
 * ventana de timing en Node.
 */
export async function verifyPgCryptoHash(
    db: Queryable,
    adminId: number,
    password: string,
    stored: string
): Promise<boolean> {
    if (!stored.startsWith('$2')) return false;

    const result = await db.query<{ ok: boolean }>(
        'SELECT (password_hash = crypt($1, password_hash)) AS ok FROM admin_users WHERE id = $2',
        [password, adminId]
    );
    return result.rows[0]?.ok === true;
}

/**
 * Verifica la contrasena de un admin contra su hash, sea scrypt (creado por la
 * API) o bcrypt/pgcrypto (sembrado por SQL).
 */
export async function verifyAdminPassword(
    db: Queryable,
    adminId: number,
    password: string,
    stored: string
): Promise<boolean> {
    if (stored.startsWith('$2')) {
        return verifyPgCryptoHash(db, adminId, password, stored);
    }
    return verifyPassword(password, stored);
}
