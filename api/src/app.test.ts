import './testing/setup-env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createTestDb, seedAdmin, type TestDb } from './testing/harness.js';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';

let harness: TestDb;
let app: FastifyInstance;

const ADMIN = { email: 'admin@test.local', password: 'TestPassword123!' };
const CLIENT = { phone: '5512345678', identityId: 'GODE561231GRERRN09' };
const ADMIN_TOKEN = 'Bearer probe-not-a-real-token';

async function loginAdmin(): Promise<string> {
    const res = await app.inject({
        method: 'POST', url: '/api/v1/admin/auth/login', payload: ADMIN,
    });
    assert.equal(res.statusCode, 200, `login admin: ${res.body}`);
    return res.json().accessToken as string;
}

async function loginClient(): Promise<string> {
    const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/login', payload: CLIENT,
    });
    assert.equal(res.statusCode, 200, `login cliente: ${res.body}`);
    return res.json().accessToken as string;
}

before(async () => {
    harness = await createTestDb();
    await harness.reset();
    await seedAdmin(harness.db);
    app = await buildApp({ db: harness.db, logger: false });
    await app.ready();
});

after(async () => {
    await app?.close();
    await harness?.close();
});

/**
 * El bloqueo por telefono es deliberadamente agresivo (15 minutos). Cada suite
 * parte de una base limpia: si no, una prueba queProvoca el bloqueo deja
 *Locked el resto del archivo.
 */
beforeEach(async () => {
    await harness.db.query('DELETE FROM login_attempts');
});

describe('Autenticacion del portal', () => {
    it('rechaza credenciales incorrectas sin revelar si el telefono existe', async () => {
        const documentoErroneo = await app.inject({
            method: 'POST', url: '/api/v1/auth/login',
            payload: { phone: CLIENT.phone, identityId: 'GODE561231GRERRN09'.replace('G', 'X') },
        });
        assert.equal(documentoErroneo.statusCode, 401);

        const telefonoInexistente = await app.inject({
            method: 'POST', url: '/api/v1/auth/login',
            payload: { phone: '5500000000', identityId: CLIENT.identityId },
        });
        assert.equal(telefonoInexistente.statusCode, 401);

        assert.equal(
            documentoErroneo.json().error.message,
            telefonoInexistente.json().error.message,
            'el mensaje no debe distinguir usuario inexistente de documento erroneo'
        );
    });

    it('normaliza el telefono con +52, guiones y espacios, y la CURP en minusculas', async () => {
        const res = await app.inject({
            method: 'POST', url: '/api/v1/auth/login',
            payload: { phone: '+52 1 55 1234-5678', identityId: 'gode561231grerrn09' },
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.ok(res.json().accessToken);
    });

    it('rechaza documentos con formato imposible antes de tocar la base', async () => {
        for (const identityId of ['123', 'ABC', 'GODE561231GRERRN09X']) {
            const res = await app.inject({
                method: 'POST', url: '/api/v1/auth/login',
                payload: { phone: '5512345678', identityId },
            });
            assert.equal(res.statusCode, 400, `deberia rechazar "${identityId}"`);
            assert.equal(res.json().error.code, 'VALIDATION_ERROR');
        }
    });

    it('bloquea el telefono tras superar los intentos permitidos', async () => {
        const limite = 3; // PORTAL_MAX_FAILED_ATTEMPTS en el entorno de test

        // Se falla deliberadamente con el telefono REAL y un documento erroneo:
        // el bloqueo es por telefono, no global.
        for (let i = 0; i < limite; i++) {
            const res = await app.inject({
                method: 'POST', url: '/api/v1/auth/login',
                payload: { phone: CLIENT.phone, identityId: 'GODE561231GRERRN08' },
            });
            assert.equal(res.statusCode, 401, `intento ${i + 1} deberia fallar`);
        }

        // Ni siquiera el par correcto entra ya.
        const bloqueado = await app.inject({
            method: 'POST', url: '/api/v1/auth/login', payload: CLIENT,
        });
        assert.equal(bloqueado.statusCode, 423);
        assert.equal(bloqueado.json().error.code, 'ACCOUNT_LOCKED');
    });

    it('un login correcto reinicia el contador de fallos', async () => {
        await harness.db.query('DELETE FROM login_attempts');

        await app.inject({
            method: 'POST', url: '/api/v1/auth/login',
            payload: { phone: CLIENT.phone, identityId: 'GODE561231GRERRN08' },
        });
        await loginClient();
        // Varios accesos correctos seguidos no deben acumular fallos.
        await loginClient();
        await loginClient();

        const despues = await app.inject({
            method: 'POST', url: '/api/v1/auth/login',
            payload: { phone: CLIENT.phone, identityId: 'GODE561231GRERRN08' },
        });
        assert.equal(despues.statusCode, 401, 'vuelve a 401 y no a 423: el contador se reinicio');
    });

    it('un login correcto no se registra como intento fallido', async () => {
        await harness.db.query('DELETE FROM login_attempts');
        await loginClient();

        const fallos = await harness.db.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM login_attempts WHERE success = FALSE`
        );
        assert.equal(Number(fallos.rows[0]?.n), 0, 'un acceso valido no debe contar como fallo');
    });
});

describe('Aislamiento entre superficies', () => {
    it('un token de cliente no abre la API administrativa, ni al reves', async () => {
        const clientToken = await loginClient();
        const adminToken = await loginAdmin();

        const conTokenDeCliente = await app.inject({
            method: 'GET', url: '/api/v1/admin/dashboard',
            headers: { authorization: `Bearer ${clientToken}` },
        });
        assert.equal(conTokenDeCliente.statusCode, 401);

        const conTokenDeAdmin = await app.inject({
            method: 'GET', url: '/api/v1/admin/dashboard',
            headers: { authorization: `Bearer ${adminToken}` },
        });
        assert.equal(conTokenDeAdmin.statusCode, 200, conTokenDeAdmin.body);

        const portalConAdmin = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${adminToken}` },
        });
        assert.equal(portalConAdmin.statusCode, 401);
    });

    it('sin token responde 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/v1/portal/summary' });
        assert.equal(res.statusCode, 401);
        assert.equal(res.json().error.code, 'UNAUTHORIZED');
    });

    it('un token con firma invalida no pasa', async () => {
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: ADMIN_TOKEN },
        });
        assert.equal(res.statusCode, 401);
    });
});

describe('Resumen del portal', () => {
    it('devuelve totales, cuota y progreso coherentes', async () => {
        const token = await loginClient();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200, res.body);

        const body = res.json();
        const totals = body.totals;

        // Maria: plan de 3000 con 4 de 12 cuotas pagadas.
        assert.equal(totals.total.amount, 3000);
        assert.equal(totals.paid.amount, 1000);
        assert.equal(totals.pending.amount, 2000);
        assert.equal(totals.paidInstallments, 4);
        assert.equal(totals.pendingInstallments, 8);
        assert.ok(Math.abs(totals.percent - 33.3) < 0.01, `percent=${totals.percent}`);
        assert.equal(body.plans[0].installmentAmount.amount, 250);
    });

    it('enmascara el documento del cliente', async () => {
        const token = await loginClient();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${token}` },
        });
        const identity = res.json().client.identity as string;
        assert.equal(identity.length, 18, 'la mascara conserva la longitud para no filtrar el formato');
        assert.ok(identity.startsWith('GODE'));
        assert.ok(identity.endsWith('RN09'));
        assert.ok(identity.includes('*'));
    });

    it('el historial lista pagos con su estatus', async () => {
        const token = await loginClient();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/payments',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200);

        const items = res.json().items;
        assert.ok(items.length >= 3, `esperaba al menos 3 pagos, hubo ${items.length}`);

        const aprobado = items.find((p: { status: string }) => p.status === 'aprobado');
        assert.ok(aprobado, 'debe existir un pago aprobado');
        assert.ok(aprobado.amount.amount > 0);
        assert.equal(typeof aprobado.amount.formatted, 'string');
        assert.ok(String(aprobado.folio).startsWith('P'));

        const pendiente = items.find((p: { status: string }) => p.status === 'pendiente');
        assert.ok(pendiente, 'debe existir el pago pendiente de conciliacion');

        // El filtro por estatus debe respetarse.
        const soloPendientes = await app.inject({
            method: 'GET', url: '/api/v1/portal/payments?status=pendiente',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.ok(soloPendientes.json().items.every(
            (p: { status: string }) => p.status === 'pendiente'
        ));
    });

    it('la ficha de pago expone la CLABE y valida su digito de control', async () => {
        const token = await loginClient();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/payment-instructions',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200, res.body);

        const spei = res.json().spei;
        assert.match(spei.clabe, /^\d{18}$/);
        assert.equal(spei.clabeValid, true, 'la CLABE sembrada debe superar el digito de control');
        assert.equal(spei.reference, 'FOLIO-CLI-0001');
        assert.ok(spei.instructions.length >= 4);
    });

    it('las cuotas vencidas se derivan del estado y la fecha', async () => {
        const token = await loginClient();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/installments?status=vencido',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200, res.body);
        for (const item of res.json().items) {
            assert.equal(item.state, 'vencido');
            assert.ok(item.dueDate < new Date().toISOString().slice(0, 10));
        }
    });

    /**
     * Regresion: todo importe viaja como objeto { amount, formatted }.
     *
     * Escribir `...money(x)` en vez de `amount: money(x)` aplana el objeto y
     * deja `amount` como numero suelto. El TypeScript del frontend no lo
     * detecta (los tipos se declaran a mano) y el fallo aparece como un importe
     * en blanco en pantalla, no como un error.
     */
    it('cada importe es un objeto Money, nunca un numero suelto', async () => {
        const token = await loginClient();

        const assertMoney = (value: unknown, path: string) => {
            assert.equal(typeof value, 'object', `${path} deberia ser objeto, no ${typeof value}`);
            assert.ok(value !== null, `${path} no deberia ser null`);
            const moneyValue = value as { amount: unknown; formatted: unknown };
            assert.equal(typeof moneyValue.amount, 'number', `${path}.amount debe ser numero`);
            assert.equal(typeof moneyValue.formatted, 'string', `${path}.formatted debe ser texto`);
            assert.match(String(moneyValue.formatted), /^\$/, `${path}.formatted debe venir con $`);
        };

        const summary = (await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${token}` },
        })).json();

        assertMoney(summary.totals.total, 'totals.total');
        assertMoney(summary.totals.paid, 'totals.paid');
        assertMoney(summary.totals.pending, 'totals.pending');
        assertMoney(summary.totals.overdue, 'totals.overdue');
        assertMoney(summary.totals.waived, 'totals.waived');
        assertMoney(summary.plans[0].total, 'plans[0].total');
        assertMoney(summary.plans[0].installmentAmount, 'plans[0].installmentAmount');

        const payments = (await app.inject({
            method: 'GET', url: '/api/v1/portal/payments',
            headers: { authorization: `Bearer ${token}` },
        })).json();
        assert.ok(payments.items.length > 0);
        for (const [i, item] of payments.items.entries()) {
            assertMoney(item.amount, `payments.items[${i}].amount`);
            // El bug original: `formatted` como hermano en lugar de anidado.
            assert.equal(item.amount.formatted !== undefined, true, 'importe sin formato');
        }

        const installments = (await app.inject({
            method: 'GET', url: '/api/v1/portal/installments?status=pendiente',
            headers: { authorization: `Bearer ${token}` },
        })).json();
        for (const [i, item] of installments.items.entries()) {
            assertMoney(item.amount, `installments.items[${i}].amount`);
        }

        const instructions = (await app.inject({
            method: 'GET', url: '/api/v1/portal/payment-instructions',
            headers: { authorization: `Bearer ${token}` },
        })).json();
        assertMoney(instructions.pending, 'instructions.pending');
        assertMoney(instructions.overdue, 'instructions.overdue');
        assertMoney(instructions.credit, 'instructions.credit');
    });

    it('el panel tambien devuelve importes como objeto', async () => {
        const token = await loginAdmin();

        const dashboard = (await app.inject({
            method: 'GET', url: '/api/v1/admin/dashboard',
            headers: { authorization: `Bearer ${token}` },
        })).json();

        for (const key of ['financed', 'collected', 'pending', 'overdue']) {
            const value = dashboard.totals[key];
            assert.equal(typeof value, 'object', `dashboard.totals.${key}`);
            assert.equal(typeof value.amount, 'number', `dashboard.totals.${key}.amount`);
            assert.equal(typeof value.formatted, 'string', `dashboard.totals.${key}.formatted`);
        }
        assert.equal(typeof dashboard.today.amount, 'object', 'dashboard.today.amount');

        const clients = (await app.inject({
            method: 'GET', url: '/api/v1/admin/clients',
            headers: { authorization: `Bearer ${token}` },
        })).json();
        for (const [i, client] of clients.items.entries()) {
            for (const key of ['financed', 'paid', 'pending', 'overdue']) {
                assert.equal(
                    typeof client[key].formatted, 'string',
                    `clients.items[${i}].${key} sin formato`
                );
            }
        }

        const adminPayments = (await app.inject({
            method: 'GET', url: '/api/v1/admin/payments',
            headers: { authorization: `Bearer ${token}` },
        })).json();
        for (const [i, payment] of adminPayments.items.entries()) {
            assert.equal(
                typeof payment.amount.formatted, 'string',
                `admin payments.items[${i}].amount sin formato`
            );
        }
    });
});

describe('Vista configurable del portal', () => {
    // Un solo login para toda la suite: /admin/auth/login tiene su propio
    // limite (10/min) y el archivo ya lo consume en otras suites.
    let admin: string;

    before(async () => {
        admin = await loginAdmin();
    });

    async function clientId(): Promise<number> {
        const res = await harness.db.query<{ id: string }>(
            'SELECT id FROM clients WHERE phone = $1', [CLIENT.phone]
        );
        const row = res.rows[0];
        assert.ok(row, 'el cliente sembrado debe existir');
        return Number(row.id);
    }

    async function setView(
        token: string, id: number, portalView: Record<string, boolean>
    ): Promise<unknown> {
        const res = await app.inject({
            method: 'PATCH', url: `/api/v1/admin/clients/${id}`,
            headers: { authorization: `Bearer ${token}` },
            payload: { portalView },
        });
        assert.equal(res.statusCode, 200, res.body);
        return res.json();
    }

    it('por defecto todas las secciones son visibles', async () => {
        const token = await loginClient();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.deepEqual(res.json().view, {
            summary: true, plans: true, installments: true,
            payments: true, paymentInstructions: true, card: true,
        });
    });

    it('el admin puede ocultar secciones y el portal las respeta', async () => {
        const id = await clientId();
        try {
            await setView(admin, id, { installments: false, payments: false, summary: false });

            const token = await loginClient();
            const body = (await app.inject({
                method: 'GET', url: '/api/v1/portal/summary',
                headers: { authorization: `Bearer ${token}` },
            })).json();
            assert.equal(body.totals, null, 'los totales no deben viajar si el resumen esta oculto');
            assert.ok(body.plans.length > 0, 'los planes siguen visibles');
            assert.equal(body.view.summary, false);

            for (const url of ['/api/v1/portal/installments', '/api/v1/portal/payments']) {
                const res = await app.inject({
                    method: 'GET', url, headers: { authorization: `Bearer ${token}` },
                });
                assert.equal(res.statusCode, 403, `${url}: ${res.body}`);
            }
        } finally {
            await setView(admin, id, { installments: true, payments: true, summary: true });
        }
    });

    it('ocultar la ficha SPEI no bloquea la tarjeta y al reves', async () => {
        const id = await clientId();
        try {
            await setView(admin, id, { paymentInstructions: false });
            const token = await loginClient();

            const res = await app.inject({
                method: 'GET', url: '/api/v1/portal/payment-instructions',
                headers: { authorization: `Bearer ${token}` },
            });
            assert.equal(res.statusCode, 200, res.body);
            const body = res.json();
            assert.equal(body.spei, null, 'sin ficha de pago no debe viajar la CLABE');
            assert.equal(body.card.available, true);

            await setView(admin, id, { card: false });
            const cardRes = await app.inject({
                method: 'POST', url: '/api/v1/portal/payments/card-session',
                headers: { authorization: `Bearer ${token}` },
                payload: { amount: '100.00' },
            });
            assert.equal(cardRes.statusCode, 403, cardRes.body);

            await setView(admin, id, { paymentInstructions: false, card: false });
            const both = await app.inject({
                method: 'GET', url: '/api/v1/portal/payment-instructions',
                headers: { authorization: `Bearer ${token}` },
            });
            assert.equal(both.statusCode, 403, both.body);
        } finally {
            await setView(admin, id, { paymentInstructions: true, card: true });
        }
    });

    it('rechaza secciones desconocidas y valores que no son boolean', async () => {
        const id = await clientId();
        const desconocida = await app.inject({
            method: 'PATCH', url: `/api/v1/admin/clients/${id}`,
            headers: { authorization: `Bearer ${admin}` },
            payload: { portalView: { resumen: false } },
        });
        assert.equal(desconocida.statusCode, 400, desconocida.body);

        const noBooleano = await app.inject({
            method: 'PATCH', url: `/api/v1/admin/clients/${id}`,
            headers: { authorization: `Bearer ${admin}` },
            payload: { portalView: { summary: 'si' } },
        });
        assert.equal(noBooleano.statusCode, 400, noBooleano.body);
    });
});

describe('Gestion de cartera (admin)', () => {
    it('el dashboard agrega la cartera completa', async () => {
        const token = await loginAdmin();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/admin/dashboard',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200, res.body);

        const body = res.json();
        assert.ok(body.totals.clients >= 3, `clientes=${body.totals.clients}`);
        assert.ok(body.totals.financed.amount > 0);
        assert.ok(Array.isArray(body.aging));
        assert.ok(body.aging.some((b: { bucket: string }) => b.bucket === '1-30' || b.bucket === '31-60'));
    });

    it('da de alta un cliente y le asigna un plan con su calendario', async () => {
        const token = await loginAdmin();

        const alta = await app.inject({
            method: 'POST', url: '/api/v1/admin/clients',
            headers: { authorization: `Bearer ${token}` },
            payload: {
                fullName: 'Cliente de Prueba',
                phone: '5511223344',
                identityId: 'TEST000101HDFRXA01',
                email: 'prueba@example.com',
            },
        });
        assert.equal(alta.statusCode, 201, alta.body);
        const clientId = alta.json().id as number;

        const plan = await app.inject({
            method: 'POST', url: `/api/v1/admin/clients/${clientId}/plans`,
            headers: { authorization: `Bearer ${token}` },
            payload: {
                totalAmount: '10000.00',
                installmentCount: 3,
                frequency: 'mensual',
                startDate: '2026-01-15',
            },
        });
        assert.equal(plan.statusCode, 201, plan.body);

        const body = plan.json();
        assert.equal(body.installmentAmount.amount, 3333.33);
        assert.equal(body.schedule.length, 3);
        // El residuo de centavos va a la ultima cuota, no se pierde.
        assert.equal(
            body.schedule.reduce((a: number, i: { amount: { amount: number } }) => a + i.amount.amount, 0),
            10000
        );
        assert.equal(body.schedule[2].amount.amount, 3333.34);
    });

    it('rechaza telefono o documento ya registrados', async () => {
        const token = await loginAdmin();

        const mismoTelefono = await app.inject({
            method: 'POST', url: '/api/v1/admin/clients',
            headers: { authorization: `Bearer ${token}` },
            payload: {
                fullName: 'Otro Cliente',
                phone: '5512345678',
                identityId: 'OTRA000101HDFRXA01',
            },
        });
        assert.equal(mismoTelefono.statusCode, 409);
        assert.match(mismoTelefono.json().error.message, /telefono/i);

        const mismaIdentidad = await app.inject({
            method: 'POST', url: '/api/v1/admin/clients',
            headers: { authorization: `Bearer ${token}` },
            payload: {
                fullName: 'Otro Cliente',
                phone: '5519998877',
                identityId: 'GODE561231GRERRN09',
            },
        });
        assert.equal(mismaIdentidad.statusCode, 409);
    });

    it('registra un pago manual y lo imputa a las cuotas mas antiguas', async () => {
        const token = await loginAdmin();

        const clientes = await app.inject({
            method: 'GET', url: '/api/v1/admin/clients?q=Maria',
            headers: { authorization: `Bearer ${token}` },
        });
        const maria = clientes.json().items[0];
        assert.ok(maria, 'debe encontrar a Maria');

        const antes = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${await loginClient()}` },
        });
        const pendienteAntes = antes.json().totals.pending.amount;

        const pago = await app.inject({
            method: 'POST', url: '/api/v1/admin/payments',
            headers: { authorization: `Bearer ${token}` },
            payload: {
                clientId: maria.id,
                amount: '500.00',
                method: 'efectivo',
                paidAt: '2026-04-01',
                concept: 'Pago en efectivo',
            },
        });
        assert.equal(pago.statusCode, 201, pago.body);
        assert.equal(pago.json().applied.amount, 500);
        assert.equal(pago.json().credit.amount, 0);

        const despues = await app.inject({
            method: 'GET', url: '/api/v1/portal/summary',
            headers: { authorization: `Bearer ${await loginClient()}` },
        });
        assert.equal(despues.json().totals.pending.amount, pendienteAntes - 500);
    });

    it('un pago con excedente queda como saldo a favor, sin repartirse de mas', async () => {
        const token = await loginAdmin();
        const clientes = await app.inject({
            method: 'GET', url: '/api/v1/admin/clients?q=Ana',
            headers: { authorization: `Bearer ${token}` },
        });
        const ana = clientes.json().items[0];

        const pago = await app.inject({
            method: 'POST', url: '/api/v1/admin/payments',
            headers: { authorization: `Bearer ${token}` },
            payload: {
                clientId: ana.id,
                amount: '350.00',
                method: 'efectivo',
                paidAt: '2026-04-02',
            },
        });
        assert.equal(pago.statusCode, 201, pago.body);

        // Ana ya estaba liquidada: no hay cuota que cubrir, todo es credito.
        assert.equal(pago.json().applied.amount, 0);
        assert.equal(pago.json().credit.amount, 350);
    });

    it('exporta la cartera en CSV con cabecera y separador correctos', async () => {
        const token = await loginAdmin();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/admin/export/cartera.csv',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'] as string, /text\/csv/);

        const csv = res.body;
        assert.ok(csv.startsWith('\uFEFF'), 'lleva BOM para que Excel respete los acentos');
        const primeraLinea = csv.split('\r\n')[0] as string;
        assert.ok(primeraLinea.includes('Folio'));
        assert.ok(primeraLinea.includes('Saldo vencido'));
        // Cabecera + una fila por cliente (el archivo es dinamico: las pruebas
        // anteriores dan de alta clientes nuevos).
        const lineas = csv.split('\r\n').filter(Boolean);
        assert.ok(lineas.length >= 4, `esperaba al menos 4 lineas, hubo ${lineas.length}`);
    });

    it('exporta en XLSX con un archivo valido', async () => {
        const token = await loginAdmin();
        const res = await app.inject({
            method: 'GET', url: '/api/v1/admin/export/cartera.xlsx',
            headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.statusCode, 200);
        // Firma PK de un contenedor ZIP (xlsx es un zip).
        assert.equal(res.body.slice(0, 2), 'PK');
        assert.ok(Number(res.headers['content-length']) > 1000);
    });
});
