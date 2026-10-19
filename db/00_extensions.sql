-- Extensiones base requeridas por el esquema.
-- `pgcrypto` aporta gen_random_uuid() y crypt()/gen_salt() para hashing.
-- En PostgreSQL 13+ gen_random_uuid() ya es nativo, pero mantenemos la
-- extension para no depender de la version del servidor.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
