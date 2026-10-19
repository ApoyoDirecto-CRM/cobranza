import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/client.js';
import { forbidden, unauthorized } from '../shared/errors.js';
import { verifyAccessToken, type TokenType } from './tokens.js';

export type AdminRole = 'admin' | 'supervisor' | 'operador' | 'lectura';

export interface ClientPrincipal {
    id: number;
    folio: string;
    fullName: string;
}

export interface AdminPrincipal {
    id: number;
    email: string;
    role: AdminRole;
}

declare module 'fastify' {
    interface FastifyRequest {
        client?: ClientPrincipal;
        admin?: AdminPrincipal;
    }
}

/** Extrae el Bearer token. Acepta tambien cookie para el modo navegador. */
function readBearer(request: FastifyRequest): string | null {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = request.cookies?.['cobranza_rt'];
    return cookie?.toString() ?? null;
}

/**
 * Exige una sesion de CLIENTE y ancla el id del cliente a la peticion.
 *
 * Recargar el cliente desde la base en cada peticion (en vez de confiar solo en
 * el token) es deliberado: si un cliente se suspende o se le cierra el portal,
 * el cambio surte efecto de inmediato y no cuando caduque el JWT. Un token de
 * 15 minutos con permisos cacheados daria una ventana de acceso indebido.
 */
export function requireClient(db: Queryable) {
    return async function clientGuard(
        request: FastifyRequest,
        _reply: FastifyReply
    ): Promise<void> {
        const token = readBearer(request);
        if (!token) throw unauthorized('Inicia sesion para continuar');

        const claims = verifyAccessToken(request.server, token, 'client');
        const clientId = Number(claims.sub);

        const result = await db.query<{
            id: string; folio: string; full_name: string;
            status: string; portal_enabled: boolean; deleted_at: string | null;
        }>(
            `SELECT id, folio, full_name, status, portal_enabled, deleted_at
               FROM clients WHERE id = $1`,
            [clientId]
        );
        const client = result.rows[0];

        if (!client || client.deleted_at) throw unauthorized('Sesion no valida');
        if (!client.portal_enabled) {
            throw forbidden('Tu acceso al portal esta suspendido. Contacta a tu asesor.');
        }
        if (client.status === 'baja') {
            throw forbidden('Tu cuenta ya no esta activa. Contacta a tu asesor.');
        }

        request.client = {
            id: Number(client.id),
            folio: client.folio,
            fullName: client.full_name,
        };
    };
}

/**
 * Devuelve una FABRICA de guards: `requireAdmin(db)('operador')`.
 *
 * El argumento es el ROL MINIMO exigido, no una lista de roles exactos. La
 * jerarquia es lectura < operador < supervisor < admin, de modo que un admin
 * puede hacer todo lo que hace un operador. Comparar contra una lista de roles
 * exactos seria un fallo de permisos esperando a ocurrir: el rol mas alto
 * seria el unico que no podria hacer casi nada.
 *
 * Se separa del guard en si para que cada ruta declare sus propias
 * credenciales (`preHandler: requireAdmin(db)('operador')`) en lugar de que el
 * permiso se deduzca de un closure capturado en la aplicacion.
 */
export function requireAdmin(db: Queryable) {
    return (minimum: AdminRole = 'lectura') =>
        async function adminGuard(
            request: FastifyRequest,
            _reply: FastifyReply
        ): Promise<void> {
            const token = readBearer(request);
            if (!token) throw unauthorized('Inicia sesion para continuar');

            const claims = verifyAccessToken(request.server, token, 'admin');
            const adminId = Number(claims.sub);

            const result = await db.query<{
                id: string; email: string; role: AdminRole; status: string;
            }>('SELECT id, email, role, status FROM admin_users WHERE id = $1', [adminId]);
            const admin = result.rows[0];

            if (!admin) throw unauthorized('Sesion no valida');
            if (admin.status !== 'activo') throw forbidden('Tu usuario esta suspendido');

            if (!hasRole(admin.role, minimum)) {
                throw forbidden(
                    `Esta accion requiere el rol "${minimum}" o superior. ` +
                    `Tu rol es "${admin.role}".`
                );
            }

            request.admin = {
                id: Number(admin.id),
                email: admin.email,
                role: admin.role,
            };
        };
}

/** Jerarquia de permisos del panel administrativo. */
export const ROLES: Record<AdminRole, number> = {
    lectura: 1,
    operador: 2,
    supervisor: 3,
    admin: 4,
};

export function hasRole(role: AdminRole, minimum: AdminRole): boolean {
    return ROLES[role] >= ROLES[minimum];
}

export type { TokenType };
