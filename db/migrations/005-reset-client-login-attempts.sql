-- Migracion 005: limpia intentos fallidos de cliente contaminados.
--
-- El codigo anterior registraba un fallo ANTES de verificar la credencial, de
-- modo que incluso los logins correctos sumaban al contador. Esas cuentas
-- quedaron bloqueadas sin haber fallado nunca de verdad. Se limpian solo los
-- intentos de cliente (el panel administrativo tiene su propio flujo).

BEGIN;

DELETE FROM login_attempts WHERE subject_type = 'client';

COMMIT;
