-- Migracion 002: CURP/DNI hasheado
-- Reemplaza identity_id (texto plano, PII) por identity_hash (bcrypt) +
-- identity_masked (version enmascarada) + identity_fingerprint (indice ciego
-- para detectar duplicados). El documento en texto plano deja de existir.
--
-- Ejecutar a mano sobre una base con el esquema viejo, fijando ANTES el pepper
-- (debe coincidir con IDENTITY_PEPPER del servidor):
--   SET cobranza.identity_pepper = '...';
--   \i db/migrations/002-clients-identity-hash.sql
-- Requiere pgcrypto (crypt) y sha256() de PostgreSQL.

BEGIN;

ALTER TABLE clients ADD COLUMN identity_hash TEXT;
ALTER TABLE clients ADD COLUMN identity_masked TEXT;
ALTER TABLE clients ADD COLUMN identity_fingerprint CHAR(64);

-- Backfill: hashea el documento existente con pgcrypto (bcrypt, cost 10).
-- Se usa un salt fijo de migracion: es un backfill unico sobre PII ya expuesta
-- en texto plano; el hash resultante sigue siendo bcrypt (lento por hash) y se
-- verifica con bcryptjs.compare en Node. pgcrypto emite $2a$; bcryptjs lo
-- verifica sin problema.
UPDATE clients
   SET identity_hash   = crypt(identity_id, '$2a$10$3x7Kq9vN2mZ8pL5wR6tY1C'),
       identity_masked = left(identity_id, 4)
                         || repeat('*', greatest(length(identity_id) - 8, 0))
                         || right(identity_id, 4),
       identity_fingerprint = encode(sha256(convert_to(
                         current_setting('cobranza.identity_pepper') || identity_id, 'UTF8')), 'hex')
 WHERE identity_hash IS NULL;

ALTER TABLE clients ALTER COLUMN identity_hash   SET NOT NULL;
ALTER TABLE clients ALTER COLUMN identity_masked SET NOT NULL;
ALTER TABLE clients ALTER COLUMN identity_fingerprint SET NOT NULL;
ALTER TABLE clients ADD CONSTRAINT clients_identity_fingerprint_key UNIQUE (identity_fingerprint);

ALTER TABLE clients DROP CONSTRAINT clients_identity_ck;
ALTER TABLE clients DROP CONSTRAINT clients_identity_id_key;
ALTER TABLE clients DROP COLUMN identity_id;

COMMIT;
