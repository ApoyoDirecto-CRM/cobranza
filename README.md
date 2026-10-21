# Cobranza — Gestión de Cobranza y Portal de Clientes

Sistema independiente (standalone) con dos módulos:

1. **Portal del cliente** — mobile-first, estilo app bancaria. El cliente ve su
   saldo, su avance de liquidación, su historial de pagos y paga por SPEI o
   tarjeta.
2. **Panel administrativo** — alta de clientes, asignación de planes,
   conciliación de pagos y exportación de la cartera.

---

## Índice

- [Stack](#stack)
- [Arquitectura](#arquitectura)
- [Arranque rápido](#arranque-rápido)
- [Probar en local sin Docker](#probar-en-local-sin-docker-pglite)
- [Modelo de datos](#modelo-de-datos)
- [Decisiones de diseño](#decisiones-de-diseño)
- [API](#api)
- [Seguridad](#seguridad)
- [Pruebas](#pruebas)
- [Despliegue en Render](#despliegue-en-render-plan-gratuito-solo-pruebas)
- [Puesta en producción](#puesta-en-producción)

---

## Stack

| Capa | Tecnología | Motivo |
|------|-----------|--------|
| Base de datos | **PostgreSQL 16+** | `NUMERIC` para dinero, constraints y triggers que garantizan la integridad del saldo en la propia base |
| API | **Node 22+ / TypeScript / Fastify 5** | Validación por JSON Schema, OpenAPI generado, arranque rápido |
| Frontend | **React 19 / Vite 8 / TypeScript** | Sin framework de UI: CSS propio con design tokens, bundle de 94 KB gzip |
| Moneda | Centavos enteros (`number`) | Ninguna aritmética monetaria pasa por punto flotante |
| Pruebas | `node:test` + **PGlite** (PostgreSQL 18 en WASM) | Las pruebas de integración corren contra PostgreSQL real, sin servidor |

> Se eligió PostgreSQL frente a MySQL por el uso de `NUMERIC` exacto, triggers
> diferidos y vistas materializadas de cartera. Frente a MongoDB, porque el
> dominio es altamente relacional y la integridad contable debe residir en el
> motor, no en la aplicación.

---

## Arquitectura

```
cobranza/
├── db/
│   ├── 00_extensions.sql   Extensiones (solo la primera vez que se crea el volumen)
│   ├── schema.sql          Esquema completo: tablas, índices, triggers, vistas
│   └── seed.sql            Datos de demostración (idempotente)
├── api/
│   └── src/
│       ├── config/env.ts       Configuración validada al arranque
│       ├── db/                 Pool, transacciones, migrador
│       ├── domain/             Lógica pura: calendario, progreso, imputación FIFO
│       ├── auth/               Tokens, guardas, hashing
│       ├── routes/             Portal, admin, reportes, webhooks
│       ├── services/           Pagos, pasarela de tarjetas
│       └── testing/            Arnés de pruebas sobre PostgreSQL real
└── web/
    └── src/
        ├── api/                Cliente HTTP con refresco transparente
        ├── portal/             Portal del cliente
        ├── admin/              Panel administrativo
        └── styles/             Design tokens + componentes
```

**Regla de dependencia:** `routes → services → domain`. El dominio no importa
nada de infraestructura, por lo que se prueba sin base de datos ni red.

---

## Arranque rápido

### Requisitos

- Node.js 22 o superior
- Docker (o una instancia PostgreSQL 14+ existente) — **opcional**: también se
  puede probar todo con PGlite, sin nada más ([ver abajo](#probar-en-local-sin-docker-pglite))

### 1. Configurar

```bash
git clone <repo> && cd cobranza
npm install
cp .env.example .env
```

Genera secretos reales y reemplaza los de ejemplo:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 2. Levantar la base y aplicar el esquema

```bash
npm run db:up        # docker compose up -d
npm run db:migrate   # aplica schema.sql + seed.sql
```

### 3. Arrancar

```bash
npm run dev          # API en :3000 y web en :5173
```

| Superficie | URL |
|-----------|-----|
| Portal del cliente | http://localhost:5173/portal |
| Panel administrativo | http://localhost:5173/admin |
| Documentación OpenAPI | http://localhost:3000/docs |

### Credenciales de demostración

| Rol | Acceso |
|-----|--------|
| Cliente | Teléfono `5512345678` · CURP `GODE561231GRERRN09` |
| Cliente con cuotas vencidas | `5599999999` · DNI `1234567890123` |
| Administrador | `admin@cobranza.local` · `CambiarEstePassword1!` |

El seed crea tres clientes: uno al corriente, uno con atraso y uno liquidado,
para que los reportes tengan datos con los que trabajar desde el primer minuto.

> Con `PORTAL_OTP_ENABLED=true` (por defecto) el portal pide además un código de
> 6 dígitos. En desarrollo (`PORTAL_OTP_PROVIDER=console`) aparece en la consola
> del servidor como `[OTP] codigo para 5512345678: 123456`. Para probar sin ese
> paso, pon `PORTAL_OTP_ENABLED=false` en `.env`.

---

## Probar en local sin Docker (PGlite)

Si no hay Docker ni un servidor PostgreSQL a mano, cambia en `.env`:

```bash
DB_DRIVER=pglite
```

y arranca igual que siempre (`npm run dev` o `npm run build && npm start`).
PGlite levanta **el mismo PostgreSQL** (18, compilado a WebAssembly) dentro del
proceso de Node: mismos tipos, mismos `CONSTRAINT TRIGGER` diferidos, mismas
extensiones. El SQL de negocio no cambia ni una línea, y no hay un segundo
motor de pruebas que se desvíe del real.

| Detalle | Comportamiento |
|---------|----------------|
| Datos | En memoria: la base nace limpia en cada arranque. Con `PGLITE_DATA_DIR=pgdata` sobrevive a reinicios |
| Migraciones y seed | `AUTO_MIGRATE` y `SEED_ON_DEPLOY` vienen **activados** con este driver, así que la cartera de demo queda lista sin tocar nada |
| Producción | Bloqueado: el arranque **aborta** si `DB_DRIVER=pglite` junto a `NODE_ENV=production` |

La opción existe para poder desarrollar y verificar el sistema completo en una
máquina sin Docker; no sustituye a PostgreSQL en despliegue real.

---

## Modelo de datos

### Las seis ideas que sostienen todo el sistema
**1. El dinero es un entero de centavos.**
`NUMERIC(14,2)` en la base, centavos enteros en la aplicación. El punto de
redondeo está declarado en un único lugar (`splitIntoInstallments`): la última
cuota de un plan absorbe el residuo, de modo que la suma de las cuotas es
*exactamente* el total, siempre.

**2. Las cuotas existen como filas, no se calculan al vuelo.**
Al dar de alta un plan se materializa su calendario en `installments`. Esto da
historial exacto, permite imputar pagos sobre cuotas concretas y hace posible
calcular antigüedad sin recalcular en cada consulta.

**3. Un pago y su reparto son cosas distintas.**
`payments` registra el movimiento de dinero; `payment_allocations` dice a qué
cuotas se aplicó. Así se soportan pagos parciales, pagos que cubren varias
cuotas y abonos a futuro, sin duplicar filas ni perder trazabilidad.

**4. La integridad del dinero vive en la base, no en el código.**
Un `CONSTRAINT TRIGGER` diferido garantiza que ningún pago reparta más de lo
recibido y que ninguna cuota reciba más de lo que vale. La aplicación calcula el
reparto, pero la base lo verifica.

```sql
-- El pago 1 no puede repartir 600.00 : solo se recibieron 500.00
RAISE EXCEPTION 'El pago % no puede repartir % : solo se recibieron %', ...
```

> **Consecuencia operativa:** toda operación que mueva dinero debe ir dentro de
> una transacción explícita (`withTransaction`). Los triggers diferidos solo
> consolidan en el `COMMIT`.

**5. El "vencido" se deriva, no se almacena.**
Una cuota vencida es `status = 'pendiente' AND due_date < hoy`. Guardar un
campo `overdue` exigiría un proceso batch que actualice el detalle y una fuente
de verdad más que puede desincronizarse.

**6. Dos dominios de identidad que no se cruzan.**
Los tokens llevan un discriminante `typ` (`client` / `admin`). Un token de
cliente que se colara en una ruta `/admin` es rechazado aunque la firma sea
válida: ambos firmadores son el mismo servidor.

### Entidades

| Tabla | Rol |
|-------|-----|
| `clients` | Cliente, su identidad y su acceso al portal |
| `payment_accounts` | Cuentas CLABE que reciben las transferencias |
| `plans` | Financiamiento: total, cuotas, frecuencia |
| `installments` | Calendario de cuotas materializado |
| `payments` | Movimientos de dinero |
| `payment_allocations` | Reparto de un pago sobre cuotas |
| `admin_users` | Personal, con roles jerárquicos |
| `refresh_tokens` | Sesiones rotativas (se guarda el hash, no el token) |
| `webhook_events` | Idempotencia de la pasarela |
| `login_attempts` | Anti-fuerza bruta |
| `audit_log` | Trazabilidad de acciones administrativas |

### Vistas

- **`v_plan_progress`** — avance por plan. Alimenta la barra de progreso del
  portal y las tarjetas del panel.
- **`v_client_portfolio`** — una fila por cliente. Es la fuente del dashboard y
  de las exportaciones.

---

## Decisiones de diseño

### Imputación de pagos: FIFO por vencimiento

Un pago cubre primero la cuota más antigua y, a igualdad de vencimiento, la de
menor número. Es la política estándar en cobranza: el pago más antiguo es el
que primero deja de generar atraso.

El excedente **no** se reparte entre cuotas ya saldadas: queda en
`payments.unapplied_amount` como saldo a favor. Inventar un abono invisible solo
complica la conciliación bancaria.

La función `planAllocation` es pura y está cubierta por pruebas; la misma lógica
la usan el portal, el panel y el webhook.

### Calendario de cuotas

`buildSchedule` maneja el caso que rompe la mayoría de las implementaciones: un
plan mensual arrancado el día 31. `addMonths` recorta al último día del mes
destino (31-ene + 1 mes = 28/29-feb, no 3-mar), y los vencimientos nunca
retroceden. Opcionalmente mueve a lunes las cuotas que caen en fin de semana,
porque nadie liquida un sábado y una cuota que vence en fin de semana se reporta
como vencida de forma injusta.

### Redondeo

Todo el redondeo ocurre en la base como `NUMERIC` y en la aplicación como
enteros. `Number(x) * 100` —el error clásico— no aparece en ninguna parte del
código: `100 * 0.29` da `28.999999999999996` en IEEE-754, y en una cartera de
mañanas eso es un descuadre de centavos que nadie sabe explicar.

### Visibilidad del portal por cliente

El admin decide, cliente por cliente, **qué secciones ve el titular**. La
configuración vive en una sola columna JSONB (`clients.portal_view`):
`summary`, `plans`, `installments`, `payments`, `paymentInstructions` y
`card`. Se edita desde el panel (botón *Vista del portal* en cada cliente) o
por `PATCH /admin/clients/:id` con `{ "portalView": { "payments": false } }`;
el parche se **fusiona** con lo actual, así que se puede ocultar una sección
sin reenviar las demás.

La clave ausente se interpreta como **visible**: una fila antigua o un `{}` a
medio construir no oculta nada por accidente. El modo seguro exige escribir
`false` a propósito. El backend no se fía de la UI: cada endpoint del portal
revalida la sección (`/portal/installments` → `403` si está oculta; el resumen
sencillamente omite `totals` o los planes ocultos, para no enviar el dato).

---

## API

Base: `/api/v1` · OpenAPI en `/docs`

### Portal del cliente

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/auth/login` | Acceso con teléfono + CURP/DNI |
| `POST` | `/auth/refresh` | Renueva el token (rotación) |
| `POST` | `/auth/logout` | Cierra la sesión |
| `GET` | `/auth/me` | Datos del cliente autenticado |
| `GET` | `/portal/summary` | **Tarjeta de resumen**: total, pagado, pendiente, % |
| `GET` | `/portal/installments` | Cuotas (`?status=pendiente\|vencido\|pagado\|todos`) |
| `GET` | `/portal/payments` | Historial de pagos, paginado |
| `GET` | `/portal/payment-instructions` | **Ficha de pago**: CLABE, referencia, pasos |
| `POST` | `/portal/payments/card-session` | Sesión de cobro con tarjeta |

### Panel administrativo

| Método | Ruta | Rol mín. | Descripción |
|--------|------|----------|-------------|
| `POST` | `/admin/auth/login` | — | Acceso del personal |
| `GET` | `/admin/dashboard` | lectura | KPIs y antigüedad de cartera |
| `GET` | `/admin/clients` | lectura | Lista con búsqueda y filtro || `GET` | `/admin/clients/:id` | lectura | Ficha completa con planes y pagos |
| `POST` | `/admin/clients` | operador | **Alta de cliente** |
| `PATCH` | `/admin/clients/:id` | operador | Estado, contacto, CLABE y visibilidad del portal |
| `POST` | `/admin/clients/:id/plans` | operador | **Asigna plan y genera cuotas** |
| `GET` | `/admin/plans` | lectura | Lista de planes |
| `POST` | `/admin/plans/:id/cancel` | supervisor | Cancela un plan |
| `POST` | `/admin/payments` | operador | **Registro manual de pago** |
| `GET` | `/admin/payments` | lectura | Lista de pagos |
| `POST` | `/admin/payments/:id/approve` | operador | Aprueba e imputa |
| `POST` | `/admin/payments/:id/reject` | supervisor | Rechaza y revierte |
| `GET` | `/admin/payment-accounts` | lectura | Cuentas CLABE |
| `GET` | `/admin/export/cartera.csv` | lectura | **Exportación CSV** |
| `GET` | `/admin/export/cartera.xlsx` | lectura | **Exportación Excel** (2 hojas) |
| `GET` | `/admin/export/payments.csv` | lectura | Detalle de pagos |
| `POST` | `/admin/users` | admin | Crea usuario administrativo |
### Webhook

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/webhooks/pasarela` | Notificaciones de la pasarela |

### Formato de errores

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Ya existe un cliente registrado con ese telefono",
    "details": { "constraint": "clients_phone_key" }
  }
}
```

El frontend decide el comportamiento por `code`, nunca por el texto.

### Ejemplos

```bash
# Login del cliente
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"5512345678","identityId":"GODE561231GRERRN09"}'

# Resumen
curl http://localhost:3000/api/v1/portal/summary \
  -H 'Authorization: Bearer <accessToken>'

# Alta de cliente + plan
curl -X POST http://localhost:3000/api/v1/admin/clients \
  -H 'Authorization: Bearer <adminToken>' -H 'Content-Type: application/json' \
  -d '{"fullName":"Maria Lopez","phone":"5512345678","identityId":"GODE561231GRERRN09"}'

curl -X POST http://localhost:3000/api/v1/admin/clients/1/plans \
  -H 'Authorization: Bearer <adminToken>' -H 'Content-Type: application/json' \
  -d '{"totalAmount":"6000.00","installmentCount":12,"frequency":"mensual","startDate":"2026-01-15"}'

# Exportar cartera
curl http://localhost:3000/api/v1/admin/export/cartera.xlsx \
  -H 'Authorization: Bearer <adminToken>' -o cartera.xlsx
```

### Firma del webhook

```
firma = HMAC-SHA256(WEBHOOK_SECRET, timestamp + "." + cuerpoCrudo)
Cabecera: X-Webhook-Signature: t=1750000000,v1=<hex>
```

El cuerpo crudo se conserva porque la firma se calcula sobre los bytes exactos
que envió la pasarela; reconstruir el JSON desde el objeto parseado cambiaría el
orden de las claves y la firma no coincidiría.

---

## Seguridad

### Lo que está resuelto

| Riesgo | Mitigación |
|--------|------------|
| Fuerza bruta | Rate limit por IP + bloqueo por teléfono tras N fallos + hash de contraseñas con **scrypt** (`N=2^16`) |
| Robo de sesión | Refresh tokens rotativos; reutilizar uno ya rotado revoca **todas** las sesiones del titular |
| XSS | Access token en memoria (no en `localStorage`); refresh en cookie `httpOnly` + `SameSite=Lax` |
| Escalada de privilegios | Discriminante `typ` en el JWT + jerarquía de roles verificada en la base en cada petición |
| Permisos revocados | Usuario y cliente se releen de la base en cada petición: el cambio aplica de inmediato |
| Inyección SQL | Consultas parametrizadas en todo el sistema |
| CSV injection | Valores que empiezan por `=`, `+`, `-` o `@` se neutralizan (Excel ejecutaría fórmulas) |
| Webhook falso | HMAC + ventana temporal + `timingSafeEqual` |
| Pagos duplicados | Constraint único `(provider, provider_payment_id)` + tabla de idempotencia |
| Fuga de datos personales | El documento **nunca se guarda en texto plano**: se guarda bcrypt (`identity_hash`), una versión enmascarada (`identity_masked`) y un índice ciego SHA-256 con pepper (`identity_fingerprint`) para detectar duplicados; el PAN nunca pasa por la API |
| Enumeración de usuarios | Mismo mensaje y tiempo de respuesta exista o no el registro |
| Dinero sobre-aplicado | Triggers en base (§4 del modelo de datos) |
| Swagger expuesto | `/docs` solo se registra fuera de producción |
| Clickjacking / XSS de terceros | Helmet con CSP (`default-src 'self'`, sin `object`/`frame`, `base-uri` y `form-action` propios) |
| Suplantación con un par filtrado | **OTP por SMS** de un solo uso, con TTL y hash bcrypt en `otp_codes` |

### Portal: login en dos pasos (OTP)

Con `PORTAL_OTP_ENABLED=true` (por defecto) `/auth/login` **no emite tokens**:
valida teléfono + CURP/DNI, genera un código de 6 dígitos y responde
`{ otpRequired: true, expiresIn }`. El cliente llama a `/auth/verify-otp`
(`{ phone, code }`) y ahí recibe los tokens.

- El código se guarda **hasheado** (bcrypt) en `otp_codes`, con TTL de
  `PORTAL_OTP_TTL_MINUTES` y un solo uso.
- `PORTAL_OTP_PROVIDER=console` imprime el código en el log (desarrollo). Para
  producción usa `twilio` y define `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y
  `TWILIO_FROM`.
- El login de administración **no** usa OTP: tiene contraseña propia y roles.

### Documento del cliente (CURP/DNI)

- `identity_hash`: bcrypt cost 10, se compara en Node (`bcrypt.compare`), nunca
  en SQL, para no filtrar por tiempos.
- `identity_fingerprint`: `SHA-256(IDENTITY_PEPPER + documento)` con `UNIQUE`.
  Es lo que permite rechazar un documento duplicado sin guardar el documento.
  **`IDENTITY_PEPPER` debe fijarse antes del primer despliegue**; rotarlo
  invalida la detección de duplicados de los clientes ya existentes.
- `identity_masked`: 4 primeros + asteriscos + 4 últimos, lo único que ve el
  portal/admin.

### ⚠️ Limitación conocida del login del portal

El primer factor del acceso del cliente es **teléfono + CURP/DNI**. Eso **no es
autenticación criptográfica**: es una declaración de identidad que el sistema
acepta porque el titular ya le es conocido a la institución que le concedió el
crédito. El OTP es lo que convierte ese par en una prueba de posesión del
teléfono.

**Riesgo residual:** si el atacante controla o intercepta el SMS y además
conoce el par, puede entrar. Sin OTP el riesgo era simplemente conocer el par.

**Mitigaciones aplicadas:** las de la tabla anterior, más respuestas idénticas
para usuario inexistente y documento erróneo.

### Antes de producción

- [ ] `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` y `WEBHOOK_SECRET` con valores
      aleatorios distintos (el arranque **falla** si se quedan los de ejemplo)
- [ ] `IDENTITY_PEPPER` propio, secreto y de al menos 32 caracteres (el arranque
      **falla** en producción con el valor de ejemplo)
- [ ] `PORTAL_OTP_ENABLED=true` y `PORTAL_OTP_PROVIDER=twilio` con credenciales
      reales (dejar `console` en producción imprime códigos en los logs)
- [ ] `sslmode=require` en `DATABASE_URL`
- [ ] `NODE_ENV=production` (activa cookies `Secure`, apaga `/docs` y endurece
      el arranque)
- [ ] `CORS_ORIGINS` limitado a los dominios reales
- [ ] CLABE y cuenta receptora reales en `payment_accounts` (titular a nombre
      de un negocio/marca: ver Blindaje del titular)
- [ ] Contraseña del administrador cambiada (el seed lo advierte)
- [ ] Copias de seguridad de PostgreSQL
- [ ] `COMPLIANCE`: revisa si aplica la LFPDPPP

### Blindaje del titular (que no te ubiquen por el servicio)

Quien recibe una transferencia SPEI ve el **nombre del titular** de la cuenta;
quien consulta el dominio ve los datos de **WHOIS**; y quien recibe el SMS ve el
**remitente**. Nada de eso lo arregla el código: depende de **bajo qué
identidad contratas cada pieza**. Checklist:

- **Cuenta SPEI**: el cliente ve `holder` en su app bancaria al transferir
  (`SPEI_TITULAR` / `payment_accounts.holder`). Ábrela a nombre de una
  entidad, negocio o marca, **nunca a tu nombre personal**. No se puede
  enmascarar: SPEI siempre muestra el titular.
- **Correo del administrador**: usa una cuenta por rol/genérica
  (p. ej. `sistema@<tu-dominio>`), no tu correo personal (`SEED_ADMIN_EMAIL`).
  Es el que aparece en recuperaciones y notificaciones.
- **Dominio**: regístralo con **privacidad WHOIS** y un correo de contacto
  genérico. Con el subdominio de Render (`*.onrender.com`) no controlas el
  WHOIS, pero tampoco expones el tuyo.
- **SMS (OTP)**: remitente genérico y **número dedicado**, no tu celular
  personal. En Twilio, `TWILIO_FROM` es visible para el destinatario.
- **GitHub**: aloja el repo en una **organización**, no en tu cuenta personal.
  Los commits ya usan una identidad genérica (`Cobranza Dev <dev@cobranza.local>`).
- **Marca**: el título y los metadatos (`web/index.html`) usan el nombre
  comercial del servicio, no tu nombre.
- **Sin terceros**: el HTML no carga fuentes, analítica ni CDNs externos, y la
  CSP (`default-src 'self'`) lo bloquea: ni Google ni nadie ve las visitas.
- **Datos demo**: los nombres, CLABE y CURP del seed son ficticios. No metas
  clientes reales en el seed ni en el repositorio.
- **URL**: una instancia gratuita es alcanzable por quien conozca la URL (y su
  base de datos expira a los 30 días). No la publiques.

---

## Pruebas

```bash
npm test          # 81 pruebas
npm run typecheck # API + web
npm run build     # compila API y frontend
```

### Qué cubren

| Archivo | Alcance |
|---------|---------|
| `domain/schedule.test.ts` | Calendario de cuotas, meses bisiestos, fines de semana, reparto de centavos |
| `security.test.ts` | Firma del webhook, imputación FIFO, validación de identidad, CLABE, CSV injection |
| `app.test.ts` | Integración completa contra PostgreSQL |

### Sobre PGlite

Las pruebas de integración usan **PGlite**, que es PostgreSQL 18 compilado a
WebAssembly: el mismo motor, los mismos tipos y los mismos triggers que en
producción. Esto importa más de lo que parece, porque la parte que más se rompe
en silencio son precisamente los `CONSTRAINT TRIGGER` diferidos —los que
verifican que ningún pago reparta más de lo recibido— y una base de prueba
simplificada no los ejecutaría.

`pg` (producción) y PGlite (pruebas) se adaptan al mismo contrato `Queryable`,
de modo que **no existe una segunda copia del SQL de negocio**.

El arnés replica además los type-parsers de `db/pool.ts`; sin eso, PGlite
devolvería `DATE` como objeto `Date` y las pruebas pasarían por un camino de
código que en producción no existe.

---

## Despliegue en Render (plan gratuito, solo pruebas)

El repo incluye `render.yaml`. Todo se crea desde el dashboard en un paso.

### ⚠️ Antes de nada: la base expira a los 30 días

Render Postgres gratuito **caduca 30 días después de crearse**. Luego hay 14
días de gracia y, si no se actualiza a un plan de pago, Render **borra la base y
todos sus datos**. Para pruebas está bien; para producción, no.

Si quieres evitarlo, cambia en `render.yaml`:

```yaml
plan: 0.5c-1g   # 15 GB, sin expiracion, ~7 USD/mes
```

### Por qué un solo servicio

El plan gratuito **duerme a los 15 minutos sin tráfico** y tarda **~1 minuto en
despertar**. Con dos servicios (API y web) serían dos esperas. Además, con
servicios separados habría que fijar la URL de la API en tiempo de compilación
del frontend, lo que hace el despliegue frágil.

Por eso **un único proceso sirve la API y el portal**. Consecuencias:

- Mismo origen → no hay CORS ni `SameSite=None` en la cookie de refresh.
- `VITE_API_BASE_URL` queda en `/api/v1`, sin conocer la URL final.
- Un solo arranque en frío.
- Recargar en `/admin` o `/portal/pagos` devuelve el portal, no un 404: hay un
  *fallback* a `index.html` para toda ruta que no sea de la API.

### Pasos

1. Sube el repo a GitHub.
2. En Render: **New → Blueprint**, apunta al repo.
3. Render te pedirá `SEED_ADMIN_PASSWORD`. Pon una que recuerdes: es la del
   usuario `admin@cobranza.local` de la base recién creada.
4. **Apply**. Tarda unos minutos: compila e instala todo.
5. Abre la URL del servicio.

| Superficie | URL |
|-----------|-----|
| Portal | `https://<tu-servicio>.onrender.com/portal` |
| Panel | `https://<tu-servicio>.onrender.com/admin` |
| OpenAPI | `https://<tu-servicio>.onrender.com/docs` |

La primera visita tarda: el servicio está despertándose.

### Qué hace el blueprint

| Pieza | Por qué |
|-------|---------|
| `AUTO_MIGRATE=true` | El plan gratuito **no tiene `preDeployCommand`**, así que las migraciones corren al arrancar el proceso. Son idempotentes: el servicio se reinicia muchas veces al día por el frío. |
| `SEED_ON_DEPLOY=true` | Inserta datos de demo **solo si la base está vacía**. En cuanto metas datos reales, ponlo en `false`. |
| `generateValue: true` | Los tres secretos se generan en Render y no quedan escritos en git. El arranque **aborta** si faltan o si son los de ejemplo. |
| `healthCheckPath: /health` | Verifica API **y** base de datos. Si la base cae, Render deja de enrutar tráfico en vez de servir 502. |
| `ipAllowList: []` en la base | Solo conexiones internas: nadie entra a PostgreSQL desde internet. |
| Reintentos de arranque | El servidor reintenta la base 10 veces. La base gratuita también se reinicia por mantenimiento y un fallo único dejaría el servicio caído. |

### El arranque en frío, de frente

Como el servicio duerme a los 15 minutos, la primera petición tras una pausa
falla por red. El frontend lo detecta: reintenta solo con espera creciente
(1s, 2s, 4s) y, si sigue sin responder, muestra un aviso de "el servidor se está
activando" con cuenta atrás y **se reintenta solo a los 30 segundos**.

Los errores con respuesta HTTP (401, 409, 400) **no** se reintentan: son
definitivos y reintentarlos duplicaría efectos, como registrar dos veces el
mismo pago.

### Qué configurar después del primer despliegue

1. **Cambia la contraseña del admin** desde el panel de Render
   (`SEED_ADMIN_PASSWORD`) y pon `SEED_ON_DEPLOY=false`.
2. **CLABE real**: crea la cuenta en `payment_accounts` con tu CLABE; la del
   seed es de ejemplo.
3. **Límites más estrictos**: en un despliegue público, baja
   `PORTAL_MAX_FAILED_ATTEMPTS` y `PORTAL_LOCKOUT_MINUTES`.
4. Considera `renderSubdomainPolicy: disabled` si conectas un dominio propio.

### Antes de que esto sea producción

El plan gratuito no sirve para producción, no por rendimiento sino por
**persistencia y disponibilidad**:

| Limitación | Consecuencia |
|-----------|--------------|
| Base expira a los 30 días | Se pierden los datos |
| Sin disco persistente | Solo sobrevive la base |
| Duerme a los 15 min | Latencia de ~1 min al despertar |
| Sin backups | Una caída de PostgreSQL es pérdida de datos |
| Sin escalado | Una sola instancia |
| Sin shell/SSH | Depurar es log-stream |

Para producción harían falta, como mínimo: base pagada con backups, acceso por
OTP en el portal (hoy es teléfono + CURP, ver [Seguridad](#seguridad)) y gestor
de secretos externo.

---


## Puesta en producción

1. **Base de datos** — instancia administrada o contenedor propio. Aplica el
   esquema con `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql`.
2. **API** — `npm run build && npm start`. Sirve en `API_HOST:API_PORT`.
3. **Frontend** — `npm run build -w web` genera `web/dist`. Sírvelo como
   estáticos con fallback a `index.html` (SPA) y con el proxy `/api` apuntando a
   la API.
4. **HTTPS obligatorio** — el refresh token viaja en cookie `Secure`.
5. **Migración continua** — el esquema actual es la migración 001. Para futuras,
   añade archivos en `db/migrations/NNN-*.sql` en vez de editar `schema.sql`, y
   **regístralos en `api/src/db/migrator.ts`** para que corran al arrancar. Si una
   migración toca una columna que `schema.sql` ya crea (para instalaciones nuevas),
   que sea idempotente (`ADD COLUMN IF NOT EXISTS` / `ADD CONSTRAINT` guardado).
   Las migraciones que necesitan lógica que no cabe en SQL (bcrypt, pepper) se
   registran como función Node, como la 002 (`api/src/db/legacy.ts`).

### Variable `VITE_API_BASE_URL`

Vite incrusta las variables `VITE_*` **en tiempo de build**. Si Sirves el
frontend desde el mismo origen que la API, deja el valor por defecto (`/api/v1`)
y configura el proxy. Si los dominios son distintos, fija la URL antes de
construir — cambiarla después exige recompilar.