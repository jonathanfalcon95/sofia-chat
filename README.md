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

Usuario semilla:

- Email: `admin@chatbase.local`
- Password: `Admin123!`

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
