import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    addMonths,
    buildSchedule,
    daysOverdue,
    parseISODate,
    toISODate,
} from './schedule.js';
import { centsToNumeric, parseAmountToCents, splitIntoInstallments } from '../shared/money.js';

describe('splitIntoInstallments', () => {
    it('la suma de las cuotas es exactamente el total', () => {
        for (const [total, count] of [[10_000, 3], [9_999, 7], [1, 1], [123_456, 11]] as const) {
            const parts = splitIntoInstallments(total, count);
            assert.equal(parts.length, count);
            assert.equal(parts.reduce((a, b) => a + b, 0), total);
        }
    });

    it('absorbe el residuo en la ultima cuota y no en la primera', () => {
        const parts = splitIntoInstallments(10_000, 3);
        assert.deepEqual(parts, [3333, 3333, 3334]);
        const uneven = splitIntoInstallments(100, 3);
        assert.deepEqual(uneven, [33, 33, 34]);
    });

    it('rechaza repartos imposibles', () => {
        assert.throws(() => splitIntoInstallments(5, 10), /al menos un centimo/);
        assert.throws(() => splitIntoInstallments(0, 3), /positivo/);
        assert.throws(() => splitIntoInstallments(1000, 0), />= 1/);
    });
});

describe('parseISODate', () => {
    it('rechaza fechas que no existen en el calendario', () => {
        assert.throws(() => parseISODate('2026-02-31'), /inexistente/);
        assert.throws(() => parseISODate('2026-13-01'), /inexistente/);
        assert.throws(() => parseISODate('2026-2-1'), /invalida/);
        assert.throws(() => parseISODate('ayer'), /invalida/);
    });

    it('no sufre corrimiento de zona horaria', () => {
        // Un parser ingenuo con new Date('2026-01-01') puede devolver 31-dic en
        // husos negativos; el trabajo es en UTC y debe devolver 1-ene.
        assert.equal(toISODate(parseISODate('2026-01-01')), '2026-01-01');
        assert.equal(toISODate(parseISODate('2026-12-31')), '2026-12-31');
    });
});

describe('addMonths', () => {
    it('recorta al ultimo dia del mes destino', () => {
        assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
        assert.equal(addMonths('2028-01-31', 1), '2028-02-29'); // bisiesto
        assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
        assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
    });

    it('atraviesa el cambio de ano', () => {
        assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
        assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
    });

    it('acumula meses desde un fin de mes sin derrapar', () => {
        // El bug clasico: sumar 1 mes repetidamente sobre un recorte produce
        // 3-mar y luego 3-abr en lugar de mantener el dia 28.
        let date = '2026-01-31';
        const seen: string[] = [];
        for (let i = 0; i < 12; i++) {
            date = addMonths(date, 1);
            seen.push(date);
        }
        assert.deepEqual(seen.slice(0, 3), ['2026-02-28', '2026-03-28', '2026-04-28']);
    });
});

describe('buildSchedule', () => {
    it('reparte el total sin perder centimos', () => {
        const { installments } = buildSchedule({
            totalCents: 10_000,
            count: 3,
            frequency: 'mensual',
            startDate: '2026-01-15',
        });
        const sum = installments.reduce((acc, i) => acc + i.amountCents, 0);
        assert.equal(sum, 10_000);
        assert.deepEqual(installments.map((i) => i.amountCents), [3333, 3333, 3334]);
    });

    it('la primera cuota vence el dia de inicio', () => {
        const { installments } = buildSchedule({
            totalCents: 1000_00,
            count: 4,
            frequency: 'semanal',
            startDate: '2026-03-02',
        });
        assert.equal(installments[0]?.dueDate, '2026-03-02');
    });

    it('respeta la frecuencia semanal y quincenal', () => {
        const semanal = buildSchedule({
            totalCents: 4000, count: 4, frequency: 'semanal', startDate: '2026-01-05',
        });
        assert.deepEqual(
            semanal.installments.map((i) => i.dueDate),
            ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']
        );
        const quincenal = buildSchedule({
            totalCents: 4000, count: 3, frequency: 'quincenal', startDate: '2026-01-05',
        });
        assert.deepEqual(
            quincenal.installments.map((i) => i.dueDate),
            ['2026-01-05', '2026-01-19', '2026-02-02']
        );
    });

    it('nunca genera vencimientos decrecientes', () => {
        // Un plan mensual arrancado el dia 31 recorre febrero; el orden debe
        // seguir siendo estrictamente creciente.
        const { installments } = buildSchedule({
            totalCents: 12_00,
            count: 12,
            frequency: 'mensual',
            startDate: '2026-01-31',
        });
        for (let i = 1; i < installments.length; i++) {
            const prev = parseISODate(installments[i - 1]!.dueDate).getTime();
            const curr = parseISODate(installments[i]!.dueDate).getTime();
            assert.ok(curr > prev, `vencimiento ${i} no avanza: ${installments[i]!.dueDate}`);
        }
    });

    it('mueve a lunes las cuotas que caen en fin de semana', () => {
        // 2026-01-31 es sabado -> lunes 2026-02-02
        const { installments } = buildSchedule({
            totalCents: 1200, count: 4, frequency: 'mensual',
            startDate: '2026-01-31', skipWeekends: true,
        });
        const fechas = installments.map((i) => i.dueDate);
        for (const fecha of fechas) {
            const dow = parseISODate(fecha).getUTCDay();
            assert.ok(dow !== 0 && dow !== 6, `${fecha} sigue en fin de semana`);
        }
        assert.equal(fechas[0], '2026-02-02');
    });

    it('mantiene el orden tras desplazar fines de semana', () => {
        const { installments } = buildSchedule({
            totalCents: 7000, count: 6, frequency: 'semanal',
            startDate: '2026-01-02', skipWeekends: true,
        });
        const fechas = installments.map((i) => i.dueDate);
        for (let i = 1; i < fechas.length; i++) {
            assert.ok(fechas[i]! > fechas[i - 1]!, `${fechas[i]} <= ${fechas[i - 1]}`);
        }
    });

    it('expone el fin del periodo y la cuota nominal', () => {
        const s = buildSchedule({
            totalCents: 10_000, count: 3, frequency: 'mensual', startDate: '2026-01-15',
        });
        assert.equal(s.endDate, '2026-03-15');
        assert.equal(s.installmentAmountCents, 3333);
    });

    it('rechaza planes imposibles de cuadrar', () => {
        assert.throws(
            () => buildSchedule({ totalCents: 5, count: 10, frequency: 'mensual', startDate: '2026-01-01' }),
            /al menos un centimo/
        );
        assert.throws(
            () => buildSchedule({ totalCents: -100, count: 2, frequency: 'mensual', startDate: '2026-01-01' }),
            /positivo/
        );
        assert.throws(
            () => buildSchedule({ totalCents: 1000, count: 0, frequency: 'mensual', startDate: '2026-01-01' }),
            />= 1/
        );
    });

    it('acepta una sola cuota por el total completo', () => {
        const s = buildSchedule({
            totalCents: 12_500, count: 1, frequency: 'mensual', startDate: '2026-01-01',
        });
        assert.equal(s.installments.length, 1);
        assert.equal(s.installments[0]?.amountCents, 12_500);
    });
});

describe('daysOverdue', () => {
    it('cuenta dias calendario y nunca sale negativo', () => {
        assert.equal(daysOverdue('2026-01-01', '2026-01-11'), 10);
        assert.equal(daysOverdue('2026-01-11', '2026-01-01'), 0);
        assert.equal(daysOverdue('2026-01-11', '2026-01-11'), 0);
    });
});

describe('parseAmountToCents', () => {
    it('interpreta el formato de entrada del portal', () => {
        assert.equal(parseAmountToCents('1234.5'), 123_450);
        assert.equal(parseAmountToCents('1234.50'), 123_450);
        assert.equal(parseAmountToCents(1234.5), 123_450);
        assert.equal(parseAmountToCents('0.01'), 1);
    });

    it('rechaza mas de dos decimales en vez de perder precision', () => {
        assert.throws(() => parseAmountToCents('1234.567'), /invalido/);
        assert.throws(() => parseAmountToCents('1,234.50'), /invalido/);
        assert.throws(() => parseAmountToCents(''), /invalido/);
    });

    it('cambia centavos a decimal de forma exacta', () => {
        assert.equal(centsToNumeric(123_450), '1234.50');
        assert.equal(centsToNumeric(1), '0.01');
    });
});
