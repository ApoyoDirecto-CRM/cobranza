import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import ExcelJS from 'exceljs';
import type { Queryable } from '../db/client.js';
import { centsToNumber, numericToCents } from '../shared/money.js';
import type { AdminRole } from '../auth/guards.js';

export interface ExportDeps {
    db: Queryable;
    requireAdmin: (minimum?: AdminRole) =>
        (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Escapa un valor CSV.
 *
 * El motivo de la complejidad: un valor que empiece con =, +, - o @ lo
 * interpretab Excel/Sheets como FORMULA. Sin este prefijo, un nombre de cliente
 * como "=HYPERLINK(...)" ejecutaria codigo al abrir el archivo. Se antepone
 * un apostrofo, que Excel interpreta como "esto es texto".
 */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';

    let text = String(value);

    // Formula injection: Excel y Google Sheets interpretan como formula todo lo
    // que empieza por =, +, - o @. Un nombre de cliente con esa forma se
    // ejecutaria al abrir el archivo.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

    // Entrecomillado obligatorio si el valor contiene el separador, una
    // comilla o un salto de linea. Sin esto, "Gomez, Maria" se partie en dos
    // columnas y desplaza todas las siguientes.
    if (/[",;\t\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;

    return text;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Formatea un TIMESTAMPTZ para el reporte.
 *
 * `String(fecha)` produciria "Fri Oct 16 2026 15:42:02 GMT-0600 (hora estandar
 * central)": ilegible, dependiente del locale e imposible de ordenar o usar
 * como eje en una tabla dinamica de Excel.
 *
 * Se emite en hora LOCAL de la oficina, que es donde se concilia, no en UTC:
 * un pago hecho a las 14:00 en Mexico Central debe leerse como 14:00.
 */
function reportDate(value: unknown): string {
    if (value === null || value === undefined || value === '') return '';
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return String(value);

    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

export function toCsv(headers: string[], rows: unknown[][]): string {
    const lines = [headers.map(csvCell).join(',')];
    for (const row of rows) lines.push(row.map(csvCell).join(','));
    // BOM: sin el, Excel en Windows abre los acentos como caracteres raros.
    return `\uFEFF${lines.join('\r\n')}\r\n`;
}

interface PortfolioRow {
    folio: string; full_name: string; phone: string; status: string;
    spei_clabe: string | null; active_plans: number; total_plans: number;
    financed_amount: string; paid_amount: string; pending_amount: string;
    overdue_amount: string; overdue_installments: number;
    max_days_overdue: number | null; next_due_date: string | null;
    last_paid_at: string | null; registered_at: string;
}

const PORTFOLIO_HEADERS = [
    'Folio', 'Nombre', 'Telefono', 'Estatus', 'CLABE SPEI', 'Planes activos',
    'Monto financiado', 'Total pagado', 'Saldo pendiente', 'Saldo vencido',
    'Cuotas vencidas', 'Dias de atraso', 'Proximo vencimiento', 'Ultimo pago',
    'Alta',
];

function portfolioRow(row: PortfolioRow): unknown[] {
    return [
        row.folio,
        row.full_name,
        row.phone,
        row.status,
        row.spei_clabe ?? '',
        Number(row.active_plans),
        centsToNumber(numericToCents(row.financed_amount)),
        centsToNumber(numericToCents(row.paid_amount)),
        centsToNumber(numericToCents(row.pending_amount)),
        centsToNumber(numericToCents(row.overdue_amount)),
        Number(row.overdue_installments),
        row.max_days_overdue === null ? '' : Number(row.max_days_overdue),
        row.next_due_date ?? '',
        reportDate(row.last_paid_at),
        reportDate(row.registered_at),
    ];
}

export async function registerExportRoutes(app: FastifyInstance, deps: ExportDeps): Promise<void> {
    const { db, requireAdmin } = deps;

    const queryPortfolio = async (status?: string): Promise<PortfolioRow[]> => {
        const params: unknown[] = [];
        let where = '';
        if (status && status !== 'todos') {
            params.push(status);
            where = `WHERE status = $1::client_status`;
        }
        const result = await db.query<PortfolioRow>(
            `SELECT folio, full_name, phone, status, spei_clabe, active_plans, total_plans,
                    financed_amount, paid_amount, pending_amount, overdue_amount,
                    overdue_installments, max_days_overdue, next_due_date, last_paid_at,
                    registered_at
               FROM v_client_portfolio ${where}
              ORDER BY overdue_amount DESC NULLS LAST, full_name`,
            params
        );
        return result.rows;
    };

    // -------------------------------------------------------------------------
    // GET /api/v1/admin/export/cartera.csv
    // -------------------------------------------------------------------------
    app.get<{ Querystring: { status?: string; format?: string } }>(
        '/admin/export/cartera.csv',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Reportes'],
                summary: 'Exporta el estado de cartera en CSV',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['activo', 'suspendido', 'liquidado', 'baja', 'todos'],
                        },
                        format: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' },
                    },
                },
            },
        },
        async (request, reply) => {
            const rows = await queryPortfolio(request.query.status);
            const fecha = new Date().toISOString().slice(0, 10);
            const filename = `cartera-${fecha}.csv`;

            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', `attachment; filename="${filename}"`);
            reply.header('Cache-Control', 'no-store');

            return toCsv(
                PORTFOLIO_HEADERS,
                rows.map((row) => portfolioRow(row))
            );
        }
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/admin/export/cartera.xlsx
    // -------------------------------------------------------------------------
    app.get<{ Querystring: { status?: string } }>(
        '/admin/export/cartera.xlsx',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Reportes'],
                summary: 'Exporta el estado de cartera en Excel',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['activo', 'suspendido', 'liquidado', 'baja', 'todos'],
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const rows = await queryPortfolio(request.query.status);
            const fecha = new Date().toISOString().slice(0, 10);

            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Cobranza';
            workbook.created = new Date();

            const sheet = workbook.addWorksheet('Cartera', {
                views: [{ state: 'frozen', ySplit: 1 }],
            });

            sheet.columns = [
                { header: 'Folio', key: 'folio', width: 14 },
                { header: 'Nombre', key: 'nombre', width: 30 },
                { header: 'Telefono', key: 'telefono', width: 15 },
                { header: 'Estatus', key: 'estatus', width: 12 },
                { header: 'CLABE SPEI', key: 'clabe', width: 22 },
                { header: 'Planes activos', key: 'planes', width: 14 },
                { header: 'Monto financiado', key: 'financiado', width: 18 },
                { header: 'Total pagado', key: 'pagado', width: 16 },
                { header: 'Saldo pendiente', key: 'pendiente', width: 18 },
                { header: 'Saldo vencido', key: 'vencido', width: 16 },
                { header: 'Cuotas vencidas', key: 'cuotasVencidas', width: 15 },
                { header: 'Dias de atraso', key: 'atraso', width: 14 },
                { header: 'Proximo vencimiento', key: 'proximo', width: 20 },
                { header: 'Ultimo pago', key: 'ultimoPago', width: 20 },
            ];

            for (const row of rows) {
                sheet.addRow({
                    folio: row.folio,
                    nombre: row.full_name,
                    telefono: row.phone,
                    estatus: row.status,
                    clabe: row.spei_clabe ?? '',
                    planes: Number(row.active_plans),
                    financiado: Number(row.financed_amount),
                    pagado: Number(row.paid_amount),
                    pendiente: Number(row.pending_amount),
                    vencido: Number(row.overdue_amount),
                    cuotasVencidas: Number(row.overdue_installments),
                    atraso: row.max_days_overdue === null ? '' : Number(row.max_days_overdue),
                    proximo: row.next_due_date ?? '',
                    ultimoPago: reportDate(row.last_paid_at),
                });
            }

            // Formato de moneda en las columnas de importes.
            const moneyColumns = ['financiado', 'pagado', 'pendiente', 'vencido'];
            for (const key of moneyColumns) {
                const column = sheet.getColumn(key);
                column.numFmt = '"$"#,##0.00';
            }

            const headerRow = sheet.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF1E3A8A' },
            };
            headerRow.alignment = { vertical: 'middle' };
            headerRow.height = 22;

            sheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: PORTFOLIO_HEADERS.length },
            };

            const totals = sheet.addRow({
                folio: 'TOTAL',
                financed: rows.reduce((a, r) => a + Number(r.financed_amount), 0),
                pagado: rows.reduce((a, r) => a + Number(r.paid_amount), 0),
                pendiente: rows.reduce((a, r) => a + Number(r.pending_amount), 0),
                vencido: rows.reduce((a, r) => a + Number(r.overdue_amount), 0),
            });
            totals.font = { bold: true };
            for (const key of moneyColumns) totals.getCell(key).numFmt = '"$"#,##0.00';

            // Hoja de antiguedado: el dato que ordena la llamada de cobranza.
            const agingSheet = workbook.addWorksheet('Antiguedad');
            agingSheet.columns = [
                { header: 'Cliente', key: 'nombre', width: 30 },
                { header: 'Folio', key: 'folio', width: 14 },
                { header: 'Dias de atraso', key: 'dias', width: 15 },
                { header: 'Saldo vencido', key: 'monto', width: 18 },
                { header: 'Cuotas vencidas', key: 'cuotas', width: 15 },
            ];
            const vencidos = rows
                .filter((r) => Number(r.overdue_amount) > 0)
                .sort((a, b) => (b.max_days_overdue ?? 0) - (a.max_days_overdue ?? 0));
            for (const row of vencidos) {
                agingSheet.addRow({
                    nombre: row.full_name,
                    folio: row.folio,
                    dias: row.max_days_overdue ?? 0,
                    monto: Number(row.overdue_amount),
                    cuotas: Number(row.overdue_installments),
                });
            }
            agingSheet.getColumn('monto').numFmt = '"$"#,##0.00';
            const agingHeader = agingSheet.getRow(1);
            agingHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            agingHeader.fill = {
                type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF991B1B' },
            };

            const buffer = await workbook.xlsx.writeBuffer();
            const filename = `cartera-${fecha}.xlsx`;

            reply.header('Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            reply.header('Content-Disposition', `attachment; filename="${filename}"`);
            reply.header('Content-Length', String(buffer.byteLength));

            return reply.send(Buffer.from(buffer));
        }
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/admin/export/payments.csv
    // -------------------------------------------------------------------------
    app.get<{ Querystring: { from?: string; to?: string; status?: string } }>(
        '/admin/export/payments.csv',
        {
            preHandler: requireAdmin('lectura'),
            schema: {
                tags: ['Admin - Reportes'],
                summary: 'Exporta el detalle de pagos en CSV',
                querystring: {
                    type: 'object',
                    properties: {
                        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                        status: {
                            type: 'string',
                            enum: ['pendiente', 'aprobado', 'rechazado', 'reembolsado', 'todos'],
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const { from, to, status } = request.query;
            const filters: string[] = ['p.deleted_at IS NULL'];
            const params: unknown[] = [];

            if (from) { params.push(from); filters.push(`p.paid_at >= $${params.length}::date`); }
            if (to) { params.push(to); filters.push(`p.paid_at <= $${params.length}::date`); }
            if (status && status !== 'todos') {
                params.push(status);
                filters.push(`p.status = $${params.length}::payment_status`);
            }

            const rows = await db.query<{
                folio: string; full_name: string; phone: string; amount: string;
                applied_amount: string; method: string; status: string; concept: string | null;
                reference: string | null; paid_at: string; approved_at: string | null;
                provider_payment_id: string | null;
            }>(
                `SELECT p.folio, c.full_name, c.phone, p.amount, p.applied_amount, p.method,
                        p.status, p.concept, p.reference, p.paid_at, p.approved_at,
                        p.provider_payment_id
                   FROM payments p JOIN clients c ON c.id = p.client_id
                  WHERE ${filters.join(' AND ')}
                  ORDER BY p.paid_at DESC`,
                params
            );

            const fecha = new Date().toISOString().slice(0, 10);
            reply.header('Content-Type', 'text/csv; charset=utf-8');
            reply.header('Content-Disposition', `attachment; filename="pagos-${fecha}.csv"`);
            reply.header('Cache-Control', 'no-store');

            return toCsv(
                ['Folio pago', 'Cliente', 'Telefono', 'Monto', 'Aplicado a cuotas',
                    'Metodo', 'Estatus', 'Concepto', 'Referencia', 'Fecha de pago',
                    'Aprobado', 'ID pasarela'],
                rows.rows.map((row) => [
                    row.folio,
                    row.full_name,
                    row.phone,
                    centsToNumber(numericToCents(row.amount)),
                    centsToNumber(numericToCents(row.applied_amount)),
                    row.method,
                    row.status,
                    row.concept ?? '',
                    row.reference ?? '',
                    reportDate(row.paid_at),
                    reportDate(row.approved_at),
                    row.provider_payment_id ?? '',
                ])
            );
        }
    );
}
