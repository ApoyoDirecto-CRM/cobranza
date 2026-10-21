-- Migracion 004: tabla de codigos OTP del portal.
--
-- Las bases creadas antes de activar el OTP no la tienen. Con
-- CREATE TABLE IF NOT EXISTS es no-op en una base nueva (schema.sql ya la crea)
-- y en una que ya la tenga.

BEGIN;

CREATE TABLE IF NOT EXISTS otp_codes (
    id          BIGSERIAL PRIMARY KEY,
    client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS otp_codes_client_idx ON otp_codes(client_id)
    WHERE consumed_at IS NULL;

COMMIT;
