-- ===========================================================================
-- COBRANZA - Esquema de base de datos (PostgreSQL 14+)
-- Gestion de cobranza + Portal de clientes
--
-- Convenciones
--   * Importes monetarios: NUMERIC(14,2). Nunca float (error de redondeo).
--   * Fechas de negocio (vencimiento, pago) en DATE; marcas de auditoria en
--     TIMESTAMPTZ con la zona horaria del servidor.
--   * Estados controlados por ENUM: evita estados "inventados" desde el codigo.
--   * Baja logica en toda tabla financiera: no se ejecuta DELETE sobre ella.
--
-- Ejecutar con:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Extensiones
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), hashing bcrypt
CREATE EXTENSION IF NOT EXISTS citext;     -- emails sin distincion de caja
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- busqueda difusa de clientes

-- ---------------------------------------------------------------------------
-- 1. Tipos enumerados
-- ---------------------------------------------------------------------------

-- Estado operativo del cliente dentro de la cartera.
CREATE TYPE client_status AS ENUM (
    'activo',        -- opera con normalidad
    'suspendido',    -- temporalmente fuera de gestion (conflicto, Alta fraude)
    'liquidado',     -- salio de cartera, sin saldo pendiente
    'baja'           -- fuera de cartera de forma definitiva
);

-- Documento usado para autenticarse en el portal del cliente.
CREATE TYPE identity_type AS ENUM ('curp', 'dni');

CREATE TYPE payment_frequency AS ENUM ('semanal', 'quincenal', 'mensual');

CREATE TYPE plan_status AS ENUM (
    'activo',
    'suspendido',
    'liquidado',     -- todas las cuotas saldadas
    'cancelado'      -- se forego o se dio por perdido
);

-- Estado de liquidacion de una cuota.
-- El "vencido" NO se almacena: se deriva (pendiente + due_date < hoy) para no
-- depender de un proceso batch que actualice el detalle.
CREATE TYPE installment_status AS ENUM (
    'pendiente',
    'pagado',
    'condonado'      -- escritura de cargo / diferimiento de capital
);

CREATE TYPE payment_status AS ENUM (
    'pendiente',     -- capturado, requiere conciliacion (SPEI sin confirmar)
    'aprobado',      -- aplicado a cuotas: ya descuenta saldo
    'rechazado',
    'reembolsado'
);

CREATE TYPE payment_method AS ENUM (
    'spei',
    'tarjeta',
    'efectivo',
    'transferencia',
    'manual'         -- registro directo por un asesor
);

-- Quien origino el movimiento (trazabilidad y auditoria).
CREATE TYPE payment_origin AS ENUM ('portal', 'pasarela', 'admin', 'webhook');

CREATE TYPE admin_role AS ENUM ('admin', 'supervisor', 'operador', 'lectura');

CREATE TYPE webhook_status AS ENUM ('recibido', 'procesado', 'duplicado', 'fallido');

-- ---------------------------------------------------------------------------
-- 2. Utilidades
-- ---------------------------------------------------------------------------

-- Mantiene updated_at al modificar una fila.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- Folio consecutivo legible para recibos de pago.
CREATE SEQUENCE payment_folio_seq START WITH 100001 INCREMENT BY 1;

-- ---------------------------------------------------------------------------
-- 3. Usuarios administrativos
--    Catalogo separado del cliente: los permisos nunca se mezclan.
-- ---------------------------------------------------------------------------

CREATE TABLE admin_users (
    id                  BIGSERIAL PRIMARY KEY,
    email               CITEXT NOT NULL UNIQUE,
    full_name           TEXT NOT NULL CHECK (length(trim(full_name)) >= 3),
    -- pgcrypto: crypt(password, gen_salt('bf', 12))
    password_hash       TEXT NOT NULL,
    role                admin_role NOT NULL DEFAULT 'operador',
    status              TEXT NOT NULL DEFAULT 'activo'
                        CHECK (status IN ('activo', 'suspendido')),
    failed_attempts     SMALLINT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until        TIMESTAMPTZ,
    last_login_at       TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER admin_users_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Cuentas receptoras (CLABE) para transferencia SPEI
-- ---------------------------------------------------------------------------

CREATE TABLE payment_accounts (
    id              BIGSERIAL PRIMARY KEY,
    label           TEXT NOT NULL,
    bank_name       TEXT NOT NULL,
    clabe           CHAR(18) NOT NULL UNIQUE CHECK (clabe ~ '^[0-9]{18}$'),
    holder          TEXT NOT NULL,
    -- Concepto que se imprime al generar la referencia del cliente.
    reference_tmpl  TEXT NOT NULL DEFAULT 'FOLIO-{FOLIO}',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payment_accounts_reference_tmpl_ck
        CHECK (reference_tmpl LIKE '%{FOLIO}%')
);

CREATE TRIGGER payment_accounts_updated_at
    BEFORE UPDATE ON payment_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Clientes
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
    id                  BIGSERIAL PRIMARY KEY,
    folio               TEXT NOT NULL UNIQUE,   -- folio comercial del cliente
    full_name           TEXT NOT NULL CHECK (length(trim(full_name)) >= 3),
    -- 10 digitos, sin clave de pais ni formato. Se normaliza a solo digitos.
    phone               CHAR(10) NOT NULL UNIQUE CHECK (phone ~ '^[0-9]{10}$'),
    identity_type       identity_type NOT NULL,
    -- CURP (18) o DNI (13) hasheada con bcrypt (cost 10). Nunca se guarda el
    -- documento en texto plano: es PII sensible (LFPDPPP). El login compara
    -- en Node con bcrypt.compare, no en SQL, para no filtrar por tiempos.
    identity_hash       TEXT NOT NULL,
    -- Version enmascarada para mostrar en el portal/admin: 4 primeros + 8
    -- asteriscos + 4 ultimos caracteres. Ej: GODE**********RN09.
    identity_masked     TEXT NOT NULL,
    -- Indice ciego SHA-256(pepper + documento): permite un UNIQUE para
    -- rechazar documentos duplicados sin guardar el documento ni comparar
    -- bcrypt en SQL. El pepper es un secreto del servidor (IDENTITY_PEPPER).
    identity_fingerprint CHAR(64) NOT NULL UNIQUE
                            CHECK (identity_fingerprint ~ '^[0-9a-f]{64}$'),
    email               CITEXT CHECK (email IS NULL OR
                            email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    phone_alt           CHAR(10) CHECK (phone_alt IS NULL OR phone_alt ~ '^[0-9]{10}$'),
    address_line        TEXT,
    notes               TEXT,

    status              client_status NOT NULL DEFAULT 'activo',
    -- Bloquea el acceso al portal sin afectar la gestion interna.
    portal_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    -- Que secciones ve el cliente en el portal. El admin lo edita por cliente;
    -- una clave ausente se interpreta como visible (ver api/src/shared/portalView.ts).
    -- El CHECK lo anade la migracion 003 (misma columna en ambas rutas).
    portal_view         JSONB NOT NULL DEFAULT
                        '{"summary":true,"plans":true,"installments":true,"payments":true,"paymentInstructions":true,"card":true}'::jsonb,

    -- Cuenta SPEI asignada (CLABE que el cliente debe usar).
    payment_account_id  BIGINT REFERENCES payment_accounts(id)
                        ON DELETE RESTRICT ON UPDATE CASCADE,

    registered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ           -- baja logica
);

CREATE TRIGGER clients_updated_at
    BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Busqueda difusa desde el panel administrativo. El telefono no lleva indice
-- trigram: `clients_phone_key` (UNIQUE) ya resuelve la busqueda exacta.
CREATE INDEX clients_full_name_trgm_idx ON clients USING gin (full_name gin_trgm_ops);
CREATE INDEX clients_status_idx        ON clients (status) WHERE deleted_at IS NULL;
CREATE INDEX clients_account_idx       ON clients (payment_account_id)
                                       WHERE payment_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Planes (financiamientos)
--    El monto total y el numero de cuotas se fijan al alta. El plan no se
--    edita en montos una vez que tiene pagos aplicados: se cancela y se crea
--    uno nuevo, conservando la trazabilidad.
-- ---------------------------------------------------------------------------

-- Codigos OTP del portal. Se guarda solo el hash bcrypt del codigo; nunca el
-- codigo en texto plano. Un codigo es de un solo uso y expira en minutos.
CREATE TABLE otp_codes (
    id          BIGSERIAL PRIMARY KEY,
    client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_client_idx ON otp_codes(client_id)
    WHERE consumed_at IS NULL;

CREATE TABLE plans (
    id                  BIGSERIAL PRIMARY KEY,
    client_id           BIGINT NOT NULL REFERENCES clients(id)
                        ON DELETE RESTRICT ON UPDATE CASCADE,
    reference           TEXT NOT NULL UNIQUE,   -- contrato / folio del plan

    product_name        TEXT NOT NULL DEFAULT 'Plan de cobranza',
    total_amount        NUMERIC(14,2) NOT NULL CHECK (total_amount > 0),
    installment_count   INTEGER NOT NULL CHECK (installment_count BETWEEN 1 AND 520),
    frequency           payment_frequency NOT NULL DEFAULT 'mensual',

    -- Importe nominal de la cuota. La ultima cuota absorbe el centavo de
    -- redondeo; el resto se materializan exactamente en `installments`.
    installment_amount  NUMERIC(14,2) NOT NULL CHECK (installment_amount > 0),

    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,         -- vencimiento de la ultima cuota
    grace_days          SMALLINT NOT NULL DEFAULT 5 CHECK (grace_days >= 0),

    status              plan_status NOT NULL DEFAULT 'activo',
    -- Pausa de cobros sin cancelar el plan (acuerdo comercial).
    paused_until        DATE,
    cancellation_reason TEXT,

    created_by          BIGINT REFERENCES admin_users(id)
                        ON DELETE SET NULL ON UPDATE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,

    CONSTRAINT plans_dates_ck CHECK (end_date >= start_date),
    -- El total no puede exceder lo que Andes a cobrar en el periodo.
    CONSTRAINT plans_amount_ck CHECK (
        total_amount <= installment_amount::NUMERIC * installment_count + 0.01
    )
);

CREATE TRIGGER plans_updated_at
    BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX plans_client_idx       ON plans (client_id);
CREATE INDEX plans_client_status_idx ON plans (client_id, status)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7. Cuotas (installments)
--    Se materializan al crear el plan. Dan historial exacto, habilitan el
--    match de pagos y permiten calcular antiguedad sin recalcular en caliente.
-- ---------------------------------------------------------------------------

CREATE TABLE installments (
    id                BIGSERIAL PRIMARY KEY,
    plan_id           BIGINT NOT NULL REFERENCES plans(id)
                      ON DELETE CASCADE ON UPDATE CASCADE,
    seq               INTEGER NOT NULL CHECK (seq >= 1),
    due_date          DATE NOT NULL,
    amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    status            installment_status NOT NULL DEFAULT 'pendiente',
    -- Fecha original cuando la cuota se reprogramo; conserva la trazabilidad
    -- del diferimiento.
    original_due_date DATE,
    paid_at           TIMESTAMPTZ,
    waived_reason     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT installments_plan_seq_uniq UNIQUE (plan_id, seq),
    CONSTRAINT installments_paid_ck CHECK (
        (status <> 'pagado') OR (paid_at IS NOT NULL)
    ),
    CONSTRAINT installments_waived_ck CHECK (
        (status <> 'condonado') OR (waived_reason IS NOT NULL)
    )
);

CREATE TRIGGER installments_updated_at
    BEFORE UPDATE ON installments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX installments_plan_due_idx ON installments (plan_id, due_date);
-- Indice parcial que alimenta el reporte de antiguedad (cartera vencida).
CREATE INDEX installments_overdue_idx ON installments (due_date)
    WHERE status = 'pendiente';

-- ---------------------------------------------------------------------------
-- 8. Pagos
--    Un pago es un movimiento de dinero; su reparto entre cuotas vive en
--    payment_allocations. Asi se soportan pagos parciales, pagos que cubren
--    varias cuotas y abonos a futuro (adelantos).
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
    id                  BIGSERIAL PRIMARY KEY,
    folio               TEXT NOT NULL UNIQUE
                        DEFAULT 'P' || to_char(now(), 'YYYYMMDD') || '-' ||
                                lpad(nextval('payment_folio_seq')::TEXT, 8, '0'),
    client_id           BIGINT NOT NULL REFERENCES clients(id)
                        ON DELETE RESTRICT ON UPDATE CASCADE,

    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    -- Dinero ya aplicado a cuotas. Solo se mueve con status 'aprobado'.
    applied_amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (applied_amount >= 0),
    -- Efectivo recibido sin asignar (sobrante o abono a futuro).
    unapplied_amount    NUMERIC(14,2) GENERATED ALWAYS AS
                        (amount - applied_amount) STORED,

    method              payment_method NOT NULL,
    origin              payment_origin NOT NULL DEFAULT 'admin',
    status              payment_status NOT NULL DEFAULT 'pendiente',

    -- Identidad del proveedor: sirve como clave de idempotencia.
    provider            TEXT,
    provider_payment_id TEXT,
    -- Evento de webhook que origino el movimiento (cadena de custodia).
    webhook_event_id    BIGINT,

    reference           TEXT,          -- referencia/folio que ve el cliente
    concept             TEXT,
    paid_at             TIMESTAMPTZ NOT NULL,   -- fecha de pago declarada
    confirmed_at        TIMESTAMPTZ,            -- fecha de conciliacion
    approved_at         TIMESTAMPTZ,
    rejected_reason     TEXT,
    receipt_key         TEXT,          -- clave de almacenamiento del comprobante
    method_last4        CHAR(4),       -- ultimos 4 digitos, nunca el PAN

    recorded_by         BIGINT REFERENCES admin_users(id)
                        ON DELETE SET NULL ON UPDATE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,

    CONSTRAINT payments_applied_ck  CHECK (applied_amount <= amount),
    CONSTRAINT payments_approved_ck CHECK (
        (status <> 'aprobado') OR (approved_at IS NOT NULL)
    ),
    -- NULL no entra en conflicto: los pagos internos (sin proveedor) conviven.
    CONSTRAINT payments_provider_id_uniq UNIQUE (provider, provider_payment_id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX payments_client_paid_idx ON payments (client_id, paid_at DESC);
CREATE INDEX payments_status_idx      ON payments (status);
CREATE INDEX payments_pending_idx     ON payments (created_at)
    WHERE status = 'pendiente';
CREATE INDEX payments_folio_trgm_idx  ON payments USING gin (folio gin_trgm_ops);
CREATE INDEX payments_receipt_ref_idx ON payments (reference)
    WHERE reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 9. Aplicaciones pago -> cuota
--    Aqui vive la integridad del dinero: no se puede sobre-aplicar.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_allocations (
    payment_id     BIGINT NOT NULL REFERENCES payments(id)
                   ON DELETE CASCADE ON UPDATE CASCADE,
    installment_id BIGINT NOT NULL REFERENCES installments(id)
                   ON DELETE RESTRICT ON UPDATE CASCADE,
    amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (payment_id, installment_id)
);

CREATE INDEX payment_allocations_installment_idx
    ON payment_allocations (installment_id);

-- --- Reglas que un trigger BEFORE debe cumplir en cada fila -----------------
--   1. El pago y la cuota existen.
--   2. Ambos pertenecen al mismo cliente.
--   3. Solo se reparte dinero de pagos APROBADOS (un pago pendiente no
--      descuenta saldo ni marca una cuota como pagada).
CREATE OR REPLACE FUNCTION allocations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pay_client  BIGINT;
    inst_client BIGINT;
    inst_status installment_status;
    pay_status  payment_status;
BEGIN
    SELECT client_id, status INTO pay_client, pay_status
      FROM payments WHERE id = NEW.payment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'El pago % no existe', NEW.payment_id USING ERRCODE = '23503';
    END IF;

    SELECT p.client_id, i.status INTO inst_client, inst_status
      FROM installments i
      JOIN plans p ON p.id = i.plan_id
     WHERE i.id = NEW.installment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La cuota % no existe', NEW.installment_id USING ERRCODE = '23503';
    END IF;

    IF pay_client <> inst_client THEN
        RAISE EXCEPTION 'Pago % (cliente %) no puede aplicarse a la cuota % (cliente %)',
            NEW.payment_id, pay_client, NEW.installment_id, inst_client
            USING ERRCODE = '23514';
    END IF;

    IF pay_status <> 'aprobado' THEN
        RAISE EXCEPTION 'Solo se reparte dinero de pagos aprobados (pago % esta en %)',
            NEW.payment_id, pay_status
            USING ERRCODE = '23514';
    END IF;

    -- Una cuota condonada esta cerrada al cobro. Aceptar el dinero en silencio
    -- lo perderia: se obliga a aplicarlo a una cuota pendiente o a devolverlo.
    IF inst_status = 'condonado' THEN
        RAISE EXCEPTION 'La cuota % esta condonada y no admite pagos', NEW.installment_id
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER payment_allocations_guard
    BEFORE INSERT OR UPDATE ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION allocations_guard();

-- Un pago que deja de estar aprobado no debe conservar repartos vivos.
CREATE OR REPLACE FUNCTION payments_reject_with_allocations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'aprobado' AND NEW.status <> 'aprobado'
       AND EXISTS (SELECT 1 FROM payment_allocations WHERE payment_id = NEW.id) THEN
        RAISE EXCEPTION
            'No se puede pasar el pago % a %: primero revierte sus aplicaciones a cuotas',
            NEW.id, NEW.status
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER payments_reject_guard
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_reject_with_allocations();

-- Importe ya distribuido de un pago.
CREATE OR REPLACE FUNCTION payment_applied_amount(p_payment BIGINT)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(pa.amount), 0)
      FROM payment_allocations pa
     WHERE pa.payment_id = p_payment;
$$;

-- Importe cubierto de una cuota (solo cuenta dinero aprobado).
CREATE OR REPLACE FUNCTION installment_covered_amount(p_installment BIGINT)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(pa.amount), 0)
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
     WHERE pa.installment_id = p_installment
       AND p.status = 'aprobado'
       AND p.deleted_at IS NULL;
$$;

-- Cierre del reparto. Es un CONSTRAINT TRIGGER diferido: los agregados ven la
-- txn completa, de modo que un pago que cubre varias cuotas se valida como un
-- todo y no fila por fila.
--
-- Que garantiza:
--   * applied_amount = suma real de repartos (columna derivada, no confiada al
--     codigo de aplicacion; el CHECK payments_applied_ck pasa a ser real).
--   * Ningun pago reparte mas de lo recibido.
--   * Ninguna cuota recibe mas de lo que vale.
--   * Cuota y plan reflejan el estado real del dinero.
CREATE OR REPLACE FUNCTION payment_allocations_settle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    pay_id     BIGINT := COALESCE(NEW.payment_id, OLD.payment_id);
    pay_amount NUMERIC(14,2);
    applied    NUMERIC(14,2);
    inst_ids   BIGINT[] := ARRAY[]::BIGINT[];
    plan_ids   BIGINT[] := ARRAY[]::BIGINT[];
    i_id       BIGINT;
    i_amount   NUMERIC(14,2);
    i_status   installment_status;
    i_plan     BIGINT;
    covered    NUMERIC(14,2);
BEGIN
    SELECT amount INTO pay_amount FROM payments WHERE id = pay_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    applied := payment_applied_amount(pay_id);

    IF applied > pay_amount THEN
        RAISE EXCEPTION
            'El pago % no puede repartir % : solo se recibieron %',
            pay_id, applied, pay_amount
            USING ERRCODE = '23514';
    END IF;

    UPDATE payments SET applied_amount = applied WHERE id = pay_id;

    IF TG_OP <> 'INSERT' THEN inst_ids := array_append(inst_ids, OLD.installment_id); END IF;
    IF TG_OP <> 'DELETE' THEN inst_ids := array_append(inst_ids, NEW.installment_id); END IF;

    FOREACH i_id IN ARRAY inst_ids LOOP
        SELECT i.amount, i.status, i.plan_id
          INTO i_amount, i_status, i_plan
          FROM installments i
         WHERE i.id = i_id
         FOR UPDATE;

        -- Una cuota condonada queda congelada: no se revive ni se sobreaplica.
        CONTINUE WHEN NOT FOUND OR i_status = 'condonado';

        covered := installment_covered_amount(i_id);

        IF covered > i_amount THEN
            RAISE EXCEPTION
                'La cuota % esta cubierta con % pero vale %',
                i_id, covered, i_amount
                USING ERRCODE = '23514';
        END IF;

        UPDATE installments
           SET status  = CASE WHEN covered >= i_amount
                              THEN 'pagado'::installment_status
                              ELSE 'pendiente'::installment_status END,
               paid_at = CASE WHEN covered >= i_amount
                              THEN COALESCE(paid_at, now())
                              ELSE NULL END
         WHERE id = i_id;

        plan_ids := array_append(plan_ids, i_plan);
    END LOOP;

    -- El plan se liquida cuando no queda ninguna cuota pendiente. Solo se mueve
    -- entre 'activo' <-> 'liquidado': una suspension o cancelacion manual
    -- nunca se sobreescribe desde aqui.
    FOREACH i_id IN ARRAY plan_ids LOOP
        IF EXISTS (SELECT 1 FROM installments
                    WHERE plan_id = i_id AND status = 'pendiente') THEN
            UPDATE plans SET status = 'activo'
             WHERE id = i_id AND status = 'liquidado';
        ELSE
            UPDATE plans SET status = 'liquidado'
             WHERE id = i_id AND status = 'activo';
        END IF;
    END LOOP;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_allocations_settle
    AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION payment_allocations_settle();

-- ---------------------------------------------------------------------------
-- 10. Eventos de webhook (idempotencia)
--     La clave unica (provider, external_event_id) garantiza que reintentar
--     un webhook nunca duplique un pago.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
    id                BIGSERIAL PRIMARY KEY,
    provider          TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    event_type        TEXT NOT NULL,
    -- Cuerpo crudo tal como llego: evidencia forense.
    payload           JSONB NOT NULL,
    signature         TEXT,
    status            webhook_status NOT NULL DEFAULT 'recibido',
    attempts          SMALLINT NOT NULL DEFAULT 1 CHECK (attempts >= 0),
    error_message     TEXT,
    payment_id        BIGINT REFERENCES payments(id)
                      ON DELETE SET NULL ON UPDATE CASCADE,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at      TIMESTAMPTZ,

    CONSTRAINT webhook_events_uniq UNIQUE (provider, external_event_id)
);

CREATE INDEX webhook_events_status_idx ON webhook_events (status, received_at DESC);

-- ---------------------------------------------------------------------------
-- 11. Sesiones (refresh tokens rotativos)
--     Se almacena el hash, nunca el token: permite revocar por dispositivo y
--     detecta reutilizacion de un token ya rotado.
-- ---------------------------------------------------------------------------

CREATE TABLE refresh_tokens (
    id           BIGSERIAL PRIMARY KEY,
    -- 'admin' (admin_users.id) o 'client' (clients.id).
    subject_type TEXT NOT NULL CHECK (subject_type IN ('admin', 'client')),
    subject_id   BIGINT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    user_agent   TEXT,
    ip_address   INET,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    replaced_by  BIGINT REFERENCES refresh_tokens(id)
                 ON DELETE SET NULL ON UPDATE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_subject_idx
    ON refresh_tokens (subject_type, subject_id, expires_at DESC)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 12. Intentos de acceso (anti-fuerza bruta)
-- ---------------------------------------------------------------------------

CREATE TABLE login_attempts (
    id             BIGSERIAL PRIMARY KEY,
    subject_type   TEXT NOT NULL CHECK (subject_type IN ('admin', 'client')),
    phone          CHAR(10),
    ip_address     INET,
    success        BOOLEAN NOT NULL,
    failure_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_phone_idx ON login_attempts (phone, created_at DESC);
CREATE INDEX login_attempts_ip_idx   ON login_attempts (ip_address, created_at DESC);

-- ---------------------------------------------------------------------------
-- 13. Auditoria de acciones administrativas
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_type  TEXT NOT NULL DEFAULT 'admin',
    actor_id    BIGINT,
    action      TEXT NOT NULL,     -- 'payment.approve', 'client.create'...
    entity_type TEXT NOT NULL,
    entity_id   TEXT,
    before_data JSONB,
    after_data  JSONB,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 14. Vistas de lectura
-- ---------------------------------------------------------------------------

-- Progreso por plan: base de la barra de progreso del portal y del dashboard.
CREATE VIEW v_plan_progress AS
SELECT
    p.id                                    AS plan_id,
    p.client_id,
    p.reference,
    p.status,
    p.frequency,
    p.start_date,
    p.end_date,
    p.grace_days,
    p.total_amount,
    p.installment_count,
    p.installment_amount,
    COALESCE(SUM(i.amount), 0)                                     AS scheduled_amount,
    COALESCE(SUM(i.amount) FILTER (WHERE i.status = 'pagado'), 0)   AS paid_amount,
    COALESCE(SUM(i.amount) FILTER (WHERE i.status = 'condonado'), 0) AS waived_amount,
    COALESCE(SUM(i.amount) FILTER (
        WHERE i.status = 'pendiente'), 0)                           AS pending_amount,
    COALESCE(SUM(i.amount) FILTER (
        WHERE i.status = 'pendiente'
          AND i.due_date < CURRENT_DATE), 0)                        AS overdue_amount,
    COUNT(*) FILTER (WHERE i.status = 'pagado')                     AS paid_count,
    COUNT(*) FILTER (WHERE i.status = 'pendiente')                   AS pending_count,
    COUNT(*) FILTER (
        WHERE i.status = 'pendiente'
          AND i.due_date < CURRENT_DATE)                            AS overdue_count,
    -- MAX(CURRENT_DATE - due_date) equivale a CURRENT_DATE - MIN(due_date):
    -- se elige el atraso maximo sin anidar agregados (prohibido en SQL).
    MAX(CURRENT_DATE - i.due_date) FILTER (
        WHERE i.status = 'pendiente' AND i.due_date < CURRENT_DATE) AS max_days_overdue,
    MIN(i.due_date) FILTER (WHERE i.status = 'pendiente')            AS next_due_date,
    MAX(i.due_date)                                                 AS last_due_date,
    MAX(i.paid_at)                                                  AS last_paid_at
FROM plans p
JOIN installments i ON i.plan_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id;

-- Cartera consolidada: una fila por cliente. Es la fuente del dashboard
-- administrativo y de las exportaciones CSV/XLSX.
CREATE VIEW v_client_portfolio AS
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
