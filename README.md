# Sofia Chat

Inbox WhatsApp multi-empresa (Next.js + Supabase + YCloud) · marca sofIA.

## Stack

- Next.js App Router
- Supabase Auth + Postgres + RLS + Realtime
- YCloud WhatsApp API (varias cuentas de plataforma en base de datos)

## Setup local

1. Copia `.env.example` a `.env.local` y completa valores.
2. Obligatorio para crear usuarios desde la UI: `SUPABASE_SERVICE_ROLE_KEY` (Dashboard Supabase → Settings → API).
3. Genera `CREDENTIALS_ENCRYPTION_KEY` (32 bytes hex) para cifrar las API keys de YCloud en Postgres. La misma clave debe existir en Vercel.
4. Instala y arranca:

```bash
npm install
npm run dev
```

### Super Admin (bootstrap)

Credenciales demo del super admin de plataforma (no se muestran en la UI de login):

- Email: `admin@chatbase.local`
- Password: `Admin123!`

El seed SQL crea la empresa demo y roles, pero **no** crea el usuario en Supabase Auth ni marca el super admin. Para bootstrap:

1. Crea el usuario en Supabase Dashboard → Authentication → Users (mismo email/password), o desde la UI de admin si ya tienes otro usuario con `SUPABASE_SERVICE_ROLE_KEY`.
2. En la tabla `profiles`, pon `is_platform_admin = true` para ese usuario (`id` = UUID de Auth).

Con eso el usuario entra como Super Admin de plataforma (acceso a todas las empresas y pantallas de admin).

## Cuentas YCloud

Las API keys viven cifradas en `ycloud_accounts`. En **Inboxes**, el super admin:

1. Selecciona una cuenta (YCloud 1, YCloud 2, …) o da de alta otra.
2. Pulsa **Sincronizar con YCloud** para traer los números de esa cuenta.
3. Al guardar una cuenta, el sistema crea o actualiza el webhook en YCloud vía API (`POST/PATCH /webhookEndpoints`).

`YCLOUD_API_KEY` / `YCLOUD_WEBHOOK_SECRET` siguen sirviendo para sembrar la cuenta 1. Una segunda cuenta se puede sembrar con `YCLOUD_ACCOUNT_2_API_KEY` (solo en `.env.local`, nunca en git).

## Webhook YCloud

- Legacy: `POST /api/webhooks/ycloud` (sigue aceptando la cuenta 1 mientras se migra).
- Por cuenta: `POST /api/webhooks/ycloud/<accountId>`

Eventos:

- `whatsapp.inbound_message.received`
- `whatsapp.message.updated`

La URL pública de producción es `https://chatbase-beryl.vercel.app/api/webhooks/ycloud/<accountId>`. El secret lo genera YCloud; no se pega a mano al crear el endpoint.

## Deploy Vercel

Producción actual: `https://chatbase-beryl.vercel.app`

Además de las vars de Supabase, configura `CREDENTIALS_ENCRYPTION_KEY` (la misma que en local).

Para crear usuarios desde la UI, añade `SUPABASE_SERVICE_ROLE_KEY` en `.env.local` y en Vercel (Settings → API del proyecto Supabase).
