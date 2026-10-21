-- Migracion 003: vista configurable del portal por cliente.
-- Agrega clients.portal_view (JSONB). Una clave ausente = seccion visible.
--
-- Corre automaticamente al arrancar (registrada en db/migrator.ts). Es segura
-- sobre una base nueva (schema.sql ya creo la columna) y sobre una que ya tenia
-- 001 aplicada (aqui se anade). El script manual queda para psql:
--   \i db/migrations/003-clients-portal-view.sql

BEGIN;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_view JSONB NOT NULL DEFAULT
    '{"summary":true,"plans":true,"installments":true,"payments":true,"paymentInstructions":true,"card":true}'::jsonb;

-- DROP + ADD en vez de ADD a secas: si el script ya se corrio a mano (sin
-- registrarse) o se reejecuta, no falla por constraint duplicado.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_portal_view_ck;
ALTER TABLE clients ADD CONSTRAINT clients_portal_view_ck
    CHECK (jsonb_typeof(portal_view) = 'object');

-- La vista consolidada de la cartera expone la configuracion al panel.
CREATE OR REPLACE VIEW v_client_portfolio AS
SELECT
    c.id                            AS client_id,
    c.folio,
    c.full_name,
    c.phone,
    c.identity_type,
    c.identity_masked,
    c.email,
    c.status,
    c.portal_enabled,
    c.portal_view,
    c.registered_at,
    a.clabe                         AS spei_clabe,
    a.bank_name                     AS spei_bank,
    COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'activo')    AS active_plans,
    COUNT(DISTINCT p.id)                                        AS total_plans,
    COALESCE(SUM(pp.total_amount) FILTER (
        WHERE pp.status = 'activo'), 0)                  AS financed_amount,
    COALESCE(SUM(pp.paid_amount)   FILTER (
        WHERE pp.status = 'activo'), 0)                  AS paid_amount,
    COALESCE(SUM(pp.pending_amount) FILTER (
        WHERE pp.status = 'activo'), 0)                  AS pending_amount,
    COALESCE(SUM(pp.overdue_amount) FILTER (
        WHERE pp.status = 'activo'), 0)                  AS overdue_amount,
    COALESCE(SUM(pp.overdue_count) FILTER (
        WHERE pp.status = 'activo'), 0)                  AS overdue_installments,
    MAX(pp.max_days_overdue) FILTER (
        WHERE pp.status = 'activo')                      AS max_days_overdue,
    MAX(pp.last_paid_at)                                 AS last_paid_at,
    MIN(pp.next_due_date) FILTER (
        WHERE pp.status = 'activo' AND pp.pending_count > 0) AS next_due_date
FROM clients c
LEFT JOIN plans p
       ON p.client_id = c.id AND p.deleted_at IS NULL
LEFT JOIN v_plan_progress pp ON pp.plan_id = p.id
LEFT JOIN payment_accounts a ON a.id = c.payment_account_id
WHERE c.deleted_at IS NULL
GROUP BY c.id, a.clabe, a.bank_name;

COMMIT;
