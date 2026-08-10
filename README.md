# Sofia Chat

Inbox WhatsApp multi-empresa (Next.js + Supabase + YCloud) · marca sofIA.

## Stack

- Next.js App Router
- Supabase Auth + Postgres + RLS + Realtime
- YCloud WhatsApp API (una sola API key de plataforma)

## Setup local

1. Copia `.env.example` a `.env.local` y completa valores.
2. Obligatorio para crear usuarios desde la UI: `SUPABASE_SERVICE_ROLE_KEY` (Dashboard Supabase → Settings → API).
3. Instala y arranca:

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

## Webhook YCloud

Endpoint: `POST /api/webhooks/ycloud`

Eventos:

- `whatsapp.inbound_message.received`
- `whatsapp.message.updated`

Configura la URL pública (Vercel) en YCloud Developers → Webhooks con el `YCLOUD_WEBHOOK_SECRET`.

## Deploy Vercel

Producción actual: `https://chatbase-beryl.vercel.app`

Webhook YCloud: `https://chatbase-beryl.vercel.app/api/webhooks/ycloud`

Para crear usuarios desde la UI, añade `SUPABASE_SERVICE_ROLE_KEY` en `.env.local` y en Vercel (Settings → API del proyecto Supabase).
