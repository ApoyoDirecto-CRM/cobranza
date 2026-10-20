-- ===========================================================================
-- COBRANZA - Datos iniciales
--
-- Ejecutar despues de db/schema.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed.sql
--
-- Es idempotente: se puede volver a ejecutar sin duplicar nada.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pepper del indice ciego de identidad
--    El migrador lo fija via `SET cobranza.identity_pepper` antes de este
--    archivo (ver api/src/db/migrator.ts). Al ejecutar a mano con psql hay que
--    fijarlo primero: SET cobranza.identity_pepper = '...';
--    Debe coincidir exactamente con IDENTITY_PEPPER del servidor.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF current_setting('cobranza.identity_pepper', TRUE) IS NULL THEN
        RAISE EXCEPTION 'Falta cobranza.identity_pepper: fijalo con SET antes de seed.sql';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Usuario administrador
--    La contrasena se define con SEED_ADMIN_PASSWORD o, si no esta, una de
--    desarrollo. En produicion DEBES cambiarla en el primer acceso.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    admin_email    TEXT := COALESCE(current_setting('cobranza.seed_email', TRUE),
                                   'admin@cobranza.local');
    admin_password TEXT := COALESCE(NULLIF(current_setting('cobranza.seed_password', TRUE), ''),
                                   'CambiarEstePassword1!');
    admin_id       BIGINT;
BEGIN
    SELECT id INTO admin_id FROM admin_users WHERE email = admin_email;

    IF admin_id IS NULL THEN
        INSERT INTO admin_users (email, full_name, password_hash, role, password_changed_at)
        VALUES (admin_email, 'Administrador del sistema',
                crypt(admin_password, gen_salt('bf', 12)), 'admin', now());
        RAISE NOTICE 'Admin creado: %', admin_email;
    ELSE
        -- El hash SIEMPRE se regenera en el seed: es un entorno de desarrollo,
        -- y una contrasena conocida es preferible a una desconocida.
        UPDATE admin_users
           SET password_hash = crypt(admin_password, gen_salt('bf', 12)),
               failed_attempts = 0, locked_until = NULL
         WHERE id = admin_id;
        RAISE NOTICE 'Admin actualizado: %', admin_email;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Cuentas receptoras (CLABE)
--    Reemplaza estos datos por los reales de tu cuenta antes de producción.
-- ---------------------------------------------------------------------------
INSERT INTO payment_accounts (label, bank_name, clabe, holder, reference_tmpl)
VALUES
    ('Cuenta principal', 'BBVA Bancomer', '012180001234567899',
     'COBRANZA PRESTAMOS SA DE CV', 'FOLIO-{FOLIO}')
ON CONFLICT (clabe) DO UPDATE
    SET bank_name = EXCLUDED.bank_name,
        holder = EXCLUDED.holder,
        active = TRUE;

-- ---------------------------------------------------------------------------
-- 3. Clientes de demostracion
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    -- Prefijo v_ obligatorio: dentro de un bloque DO, un nombre sin prefijos
    -- como plan_id colisiona con la columna y PostgreSQL lanza "ambiguous".
    v_principal  BIGINT;
    v_maria_id   BIGINT;
    v_pedro_id   BIGINT;
    v_ana_id     BIGINT;
    v_plan_id    BIGINT;
    v_inst_id    BIGINT;
    v_payment_id BIGINT;
BEGIN
    SELECT id INTO v_principal FROM payment_accounts
     WHERE clabe = '012180001234567899' LIMIT 1;

    -- Saldar una cuenta demo con un plan vigente, para que el portal muestre
    -- movimiento real y no solo ceros.
    SELECT id INTO v_maria_id FROM clients WHERE folio = 'CLI-0001';
    IF v_maria_id IS NULL THEN
        INSERT INTO clients (folio, full_name, phone, identity_type, identity_hash,
                             identity_masked, identity_fingerprint, email, payment_account_id)
        VALUES ('CLI-0001', 'Maria Lopez Ruiz', '5512345678', 'curp',
                '$2b$10$aSaKh4/OZPIwxtdBS5TWD.4qN0L4z6SSvXkPY0Aa/xXyLQ.3BT1gG',
                'GODE**********RN09',
                encode(sha256(convert_to(
                    current_setting('cobranza.identity_pepper') || 'GODE561231GRERRN09', 'UTF8')), 'hex'),
                'maria.lopez@example.com', v_principal)
        RETURNING id INTO v_maria_id;
    END IF;

    -- Cliente con cuotas vencidas: alimenta el reporte de antiguedad.
    -- Sin CLABE asignada a proposito: cubre el caso "aun no le hemos dado
    -- cuenta para transferir" del portal.
    SELECT id INTO v_pedro_id FROM clients WHERE folio = 'CLI-0002';
    IF v_pedro_id IS NULL THEN
        INSERT INTO clients (folio, full_name, phone, identity_type, identity_hash,
                             identity_masked, identity_fingerprint, email, payment_account_id)
        VALUES ('CLI-0002', 'Pedro Gomez Diaz', '5599999999', 'dni',
                '$2b$10$RN5U3qKy8WR/ORAceTvEu.DinRXZvi98wOj8P7sl2ke6xNsigjEAK',
                '1234*****0123',
                encode(sha256(convert_to(
                    current_setting('cobranza.identity_pepper') || '1234567890123', 'UTF8')), 'hex'),
                'pedro.gomez@example.com', NULL)
        RETURNING id INTO v_pedro_id;
    END IF;

    -- Cliente con plan ya liquidado.
    SELECT id INTO v_ana_id FROM clients WHERE folio = 'CLI-0003';
    IF v_ana_id IS NULL THEN
        INSERT INTO clients (folio, full_name, phone, identity_type, identity_hash,
                             identity_masked, identity_fingerprint, email, payment_account_id)
        VALUES ('CLI-0003', 'Ana Torres Vega', '5544556677', 'curp',
                '$2b$10$r6CKM0qyyXEaHrF68M1g3.wQd9wvbgg1dqnz0dwy4cqbW1z3hK58q',
                'PEMG**********NS03',
                encode(sha256(convert_to(
                    current_setting('cobranza.identity_pepper') || 'PEMG900215HDFRNS03', 'UTF8')), 'hex'),
                'ana.torres@example.com', NULL)
        RETURNING id INTO v_ana_id;
    END IF;

    -- ---------------- Plan de Maria: 12 mensualidades de 250.00 -------------
    SELECT id INTO v_plan_id FROM plans WHERE reference = 'PLAN-DEMO-0001';
    IF v_plan_id IS NULL THEN
        INSERT INTO plans (client_id, reference, product_name, total_amount,
                           installment_count, frequency, installment_amount,
                           start_date, end_date)
        VALUES (v_maria_id, 'PLAN-DEMO-0001', 'Credito personal', 3000.00, 12,
                'mensual', 250.00, DATE '2026-01-15', DATE '2026-12-15')
        RETURNING id INTO v_plan_id;

        INSERT INTO installments (plan_id, seq, due_date, amount)
        SELECT v_plan_id, g,
               (DATE '2026-01-15' + (g - 1) * INTERVAL '1 month')::date,
               250.00
          FROM generate_series(1, 12) g;

        -- Las tres primeras ya liquidadas: el historial del portal no arranca vacio.
        INSERT INTO payments (client_id, amount, method, origin, status, paid_at,
                              concept, reference, approved_at)
        VALUES (v_maria_id, 750.00, 'spei', 'portal', 'aprobado', DATE '2026-01-15',
                'Abono trimestral', 'CLI-0001-ABC123', now())
        RETURNING id INTO v_payment_id;

        INSERT INTO payment_allocations (payment_id, installment_id, amount)
        SELECT v_payment_id, i.id, i.amount
          FROM installments i
         WHERE i.plan_id = v_plan_id AND i.seq <= 3;

        INSERT INTO payments (client_id, amount, method, origin, status, paid_at,
                              concept, approved_at)
        VALUES (v_maria_id, 250.00, 'tarjeta', 'pasarela', 'aprobado', DATE '2026-02-15',
                'Cuota 4 - pago con tarjeta', now())
        RETURNING id INTO v_payment_id;

        SELECT id INTO v_inst_id FROM installments
         WHERE plan_id = v_plan_id AND seq = 4;

        INSERT INTO payment_allocations (payment_id, installment_id, amount)
        VALUES (v_payment_id, v_inst_id, 250.00);
    END IF;

    -- ---------------- Plan de Pedro: 6 quincenales, con atraso --------------
    SELECT id INTO v_plan_id FROM plans WHERE reference = 'PLAN-DEMO-0002';
    IF v_plan_id IS NULL THEN
        INSERT INTO plans (client_id, reference, product_name, total_amount,
                           installment_count, frequency, installment_amount,
                           start_date, end_date)
        VALUES (v_pedro_id, 'PLAN-DEMO-0002', 'Credito personal', 1800.00, 6,
                'quincenal', 300.00, DATE '2026-02-01', DATE '2026-04-16')
        RETURNING id INTO v_plan_id;

        INSERT INTO installments (plan_id, seq, due_date, amount)
        SELECT v_plan_id, g,
               (DATE '2026-02-01' + (g - 1) * INTERVAL '14 days')::date,
               300.00
          FROM generate_series(1, 6) g;

        -- Solo se paga la primera: las cinco siguientes quedan vencidas o proximas.
        INSERT INTO payments (client_id, amount, method, origin, status, paid_at,
                              concept, reference, approved_at)
        VALUES (v_pedro_id, 300.00, 'manual', 'admin', 'aprobado', DATE '2026-02-01',
                'Pago en efectivo - sucursal', NULL, now())
        RETURNING id INTO v_payment_id;

        SELECT id INTO v_inst_id FROM installments
         WHERE plan_id = v_plan_id AND seq = 1;

        INSERT INTO payment_allocations (payment_id, installment_id, amount)
        VALUES (v_payment_id, v_inst_id, 300.00);
    END IF;

    -- ---------------- Plan de Ana: liquidado por completo -------------------
    SELECT id INTO v_plan_id FROM plans WHERE reference = 'PLAN-DEMO-0003';
    IF v_plan_id IS NULL THEN
        INSERT INTO plans (client_id, reference, product_name, total_amount,
                           installment_count, frequency, installment_amount,
                           start_date, end_date)
        VALUES (v_ana_id, 'PLAN-DEMO-0003', 'Credito personal', 1200.00, 4,
                'mensual', 300.00, DATE '2025-12-15', DATE '2026-03-15')
        RETURNING id INTO v_plan_id;

        INSERT INTO installments (plan_id, seq, due_date, amount)
        SELECT v_plan_id, g,
               (DATE '2025-12-15' + (g - 1) * INTERVAL '1 month')::date,
               300.00
          FROM generate_series(1, 4) g;

        INSERT INTO payments (client_id, amount, method, origin, status, paid_at,
                              concept, reference, approved_at)
        VALUES (v_ana_id, 1200.00, 'transferencia', 'admin', 'aprobado', DATE '2026-03-15',
                'Liquidacion total del plan', 'CLI-0003-XYZ789', now())
        RETURNING id INTO v_payment_id;

        INSERT INTO payment_allocations (payment_id, installment_id, amount)
        SELECT v_payment_id, i.id, i.amount
          FROM installments i
         WHERE i.plan_id = v_plan_id;
    END IF;

    -- ---------------- Un pago pendiente de conciliacion ---------------------
    IF NOT EXISTS (SELECT 1 FROM payments
                    WHERE client_id = v_maria_id AND status = 'pendiente') THEN
        INSERT INTO payments (client_id, amount, method, origin, status, paid_at,
                              concept, reference)
        VALUES (v_maria_id, 250.00, 'spei', 'portal', 'pendiente', DATE '2026-03-15',
                'Transferencia SPEI en proceso', 'CLI-0001-DEF456');
    END IF;

    RAISE NOTICE 'Datos de demostracion listos.';
    RAISE NOTICE 'Portal  -> telefono 5512345678 / CURP GODE561231GRERRN09';
    RAISE NOTICE 'Admin   -> admin@cobranza.local / CambiarEstePassword1!';
    RAISE WARNING 'La contrasena del administrador es de DESARROLLO: cambiala antes de usar esto en produccion.';
END;
$$;

COMMIT;
