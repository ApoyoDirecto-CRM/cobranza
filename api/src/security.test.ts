import './testing/setup-env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signWebhook, verifyWebhookSignature } from './routes/webhooks.js';
import { planAllocation } from './domain/allocation.js';
import { parseAmountToCents } from './shared/money.js';
import { validateIdentity, normalizePhone, safeEqual, maskIdentity } from './shared/identity.js';
import { isValidClabe } from './routes/portal.js';
import { csvCell, toCsv } from './routes/export.js';
import { TEST_WEBHOOK_SECRET } from './testing/setup-env.js';

const NOW = 1_790_000_000_000;
const TS = Math.floor(NOW / 1000);

function header(payload: string, secret = TEST_WEBHOOK_SECRET, timestamp = TS): string {
    return `t=${timestamp},v1=${signWebhook(secret, timestamp, payload)}`;
}

describe('Firma del webhook', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' });

    it('acepta una firma valida', () => {
        assert.doesNotThrow(() =>
            verifyWebhookSignature({
                secret: TEST_WEBHOOK_SECRET,
                header: header(body),
                rawBody: body,
                toleranceSeconds: 300,
                now: NOW,
            })
        );
    });

    it('rechaza un cuerpo manipulado', () => {
        const firma = header(body);
        assert.throws(
            () => verifyWebhookSignature({
                secret: TEST_WEBHOOK_SECRET,
                header: firma,
                rawBody: JSON.stringify({ id: 'evt_1', type: 'payment.refunded' }),
                toleranceSeconds: 300,
                now: NOW,
            }),
            /invalida/
        );
    });

    it('rechaza un secreto distinto', () => {
        assert.throws(
            () => verifyWebhookSignature({
                secret: TEST_WEBHOOK_SECRET,
                header: header(body, 'otro-secreto-de-prueba-32-caracteres-x'),
                rawBody: body,
                toleranceSeconds: 300,
                now: NOW,
            }),
            /invalida/
        );
    });

    it('rechaza una firma reenviada fuera de la ventana de tiempo', () => {
        const antigua = Math.floor(NOW / 1000) - 3600;
        assert.throws(
            () => verifyWebhookSignature({
                secret: TEST_WEBHOOK_SECRET,
                header: header(body, TEST_WEBHOOK_SECRET, antigua),
                rawBody: body,
                toleranceSeconds: 300,
                now: NOW,
            }),
            /expiro/
        );
    });

    it('tolera un desfase pequeno de reloj', () => {
        assert.doesNotThrow(() =>
            verifyWebhookSignature({
                secret: TEST_WEBHOOK_SECRET,
                header: header(body, TEST_WEBHOOK_SECRET, TS - 120),
                rawBody: body,
                toleranceSeconds: 300,
                now: NOW,
            })
        );
    });

    it('rechaza firmas mal formadas', () => {
        for (const malo of [undefined, '', 'basura', 'v1=abc', `t=${TS}`]) {
            assert.throws(
                () => verifyWebhookSignature({
                    secret: TEST_WEBHOOK_SECRET,
                    header: malo,
                    rawBody: body,
                    toleranceSeconds: 300,
                    now: NOW,
                }),
                /firma/i,
                `deberia rechazar "${malo}"`
            );
        }
    });
});

describe('Imputacion FIFO de pagos', () => {
    const abiertas = [
        { id: 3, seq: 3, dueDate: '2026-03-15', amountCents: 250_00 },
        { id: 1, seq: 1, dueDate: '2026-01-15', amountCents: 250_00 },
        { id: 2, seq: 2, dueDate: '2026-02-15', amountCents: 250_00 },
    ];

    it('cubre primero la cuota mas antigua aunque llegue desordenada', () => {
        const plan = planAllocation(abiertas, 250_00);
        assert.deepEqual(plan.allocations, [{ installmentId: 1, amountCents: 250_00 }]);
        assert.equal(plan.unappliedCents, 0);
    });

    it('encadena varias cuotas hasta agotar el monto', () => {
        const plan = planAllocation(abiertas, 600_00);
        assert.deepEqual(plan.allocations, [
            { installmentId: 1, amountCents: 250_00 },
            { installmentId: 2, amountCents: 250_00 },
            { installmentId: 3, amountCents: 100_00 },
        ]);
        assert.equal(plan.appliedCents, 600_00);
        assert.equal(plan.unappliedCents, 0);
    });

    it('el excedente queda como saldo a favor, no se reparte de mas', () => {
        const plan = planAllocation(abiertas, 1000_00);
        assert.equal(plan.appliedCents, 750_00);
        assert.equal(plan.unappliedCents, 250_00);
        const suma = plan.allocations.reduce((a, x) => a + x.amountCents, 0);
        assert.equal(suma, 750_00, 'nunca supera el total de las cuotas abiertas');
    });

    it('un pago sin cuotas abiertas queda integro como credito', () => {
        const plan = planAllocation([], 500_00);
        assert.deepEqual(plan.allocations, []);
        assert.equal(plan.unappliedCents, 500_00);
    });

    it('desempata por numero de cuota cuando hay igual vencimiento', () => {
        const plan = planAllocation(
            [
                { id: 9, seq: 2, dueDate: '2026-01-15', amountCents: 100 },
                { id: 8, seq: 1, dueDate: '2026-01-15', amountCents: 100 },
            ],
            150
        );
        assert.deepEqual(plan.allocations, [
            { installmentId: 8, amountCents: 100 },
            { installmentId: 9, amountCents: 50 },
        ]);
    });

    it('no muta la lista recibida', () => {
        const original = [...abiertas];
        planAllocation(abiertas, 300_00);
        assert.deepEqual(abiertas, original);
    });

    it('rechaza importes negativos o no enteros', () => {
        assert.throws(() => planAllocation(abiertas, -1), />= 0/);
        assert.throws(() => planAllocation(abiertas, 10.5), /entero/);
    });
});

describe('Validacion de identidad', () => {
    it('acepta CURP valida y detecta el tipo solo', () => {
        assert.equal(validateIdentity('GODE561231GRERRN09').type, 'curp');
        assert.equal(validateIdentity('1234567890123').type, 'dni');
    });

    it('rechaza una fecha imposible dentro de la CURP', () => {
        assert.throws(() => validateIdentity('GODE561331GRERRN09'), /fecha/);
        assert.throws(() => validateIdentity('GODE000231GRERRN09'), /fecha/);
    });

    it('acepta el 29 de febrero en ano bisiesto y lo rechaza si no', () => {
        assert.doesNotThrow(() => validateIdentity('AAAA000229AAAAAA00'));
        assert.throws(() => validateIdentity('AAAA190229AAAAAA00'), /fecha/);
    });

    it('normaliza el telefono en todos los formatos aceptados', () => {
        for (const entrada of ['5512345678', '+52 55 1234 5678', '52 1 55 1234 5678', '(55) 1234-5678']) {
            assert.equal(normalizePhone(entrada), '5512345678', `fallo con "${entrada}"`);
        }
    });

    it('rechaza telefonos imposibles', () => {
        assert.throws(() => normalizePhone('551234567'), /10 digitos/);
        assert.throws(() => normalizePhone('1111111111'), /no parece valido/);
        assert.throws(() => normalizePhone('abcdefghij'), /10 digitos/);
    });

    it('compara el documento en tiempo constante', () => {
        assert.equal(safeEqual('GODE561231GRERRN09', 'GODE561231GRERRN09'), true);
        assert.equal(safeEqual('GODE561231GRERRN09', 'GODE561231GRERRN08'), false);
        assert.equal(safeEqual('corto', 'mucholargoooo'), false);
    });

    it('la mascara no revela el documento completo', () => {
        const masked = maskIdentity('GODE561231GRERRN09');
        assert.equal(masked.length, 18);
        assert.ok(!masked.includes('5612'));
        assert.ok(masked.includes('*'));
    });
});

describe('Digito de control de la CLABE', () => {
    it('acepta la CLABE de ejemplo del seed y rechaza una alterada', () => {
        assert.equal(isValidClabe('012180001234567899'), true);
        assert.equal(isValidClabe('012180001234567890'), false);
        assert.equal(isValidClabe('01218'), false);
        assert.equal(isValidClabe('01218000123456789X'), false);
    });
});

describe('Exportacion CSV', () => {
    it('protege contra inyeccion de formulas', () => {
        // Sin neutralizar, Excel ejecutaria esto al abrir el archivo.
        assert.equal(csvCell('=1+1'), "'=1+1");
        assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
        assert.equal(csvCell('+CMD'), "'+CMD");
        assert.equal(csvCell('-2+3'), "'-2+3");
    });

    it('escapa comas, comillas y saltos de linea', () => {
        assert.equal(csvCell('a,b'), '"a,b"');
        assert.equal(csvCell('say "hi"'), '"say ""hi"""');
        assert.equal(csvCell('linea1\nlinea2'), '"linea1\nlinea2"');
    });

    it('deja intactos los valores sin riesgo', () => {
        assert.equal(csvCell('Maria Lopez'), 'Maria Lopez');
        assert.equal(csvCell(42), '42');
        assert.equal(csvCell(null), '');
        assert.equal(csvCell(undefined), '');
    });

    it('emite BOM y CRLF', () => {
        const csv = toCsv(['A', 'B'], [['1', '2']]);
        assert.ok(csv.startsWith('\uFEFF'));
        assert.ok(csv.includes('\r\n'));
        // Sin trim(): el BOM es un caracter de espacio y trim() lo elimina.
        assert.equal(csv.replace(/\r\n$/, ''), '\uFEFFA,B\r\n1,2');
    });

    it('las fechas del reporte no se exportan como Date.toString()', () => {
        // Un TIMESTAMPTZ crudo salia como "Fri Oct 16 2026 15:42:02 GMT-0600
        // (hora estandar central)", inutilizable en Excel.
        const csv = toCsv(['Fecha'], [['2026-10-16 21:39:51']]);
        const valor = csv.split('\r\n')[1] ?? '';
        assert.equal(valor, '2026-10-16 21:39:51');
        assert.ok(!valor.includes('GMT'));
        assert.ok(!valor.includes('(hora'));
    });
});

describe('Parseo de importes', () => {
    it('acepta hasta dos decimales y rechaza el resto', () => {
        assert.equal(parseAmountToCents('100'), 10_000);
        assert.equal(parseAmountToCents('100.5'), 10_050);
        assert.throws(() => parseAmountToCents('100.555'), /invalido/);
    });
});
