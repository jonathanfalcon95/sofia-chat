# Deep links de chat (empresa + teléfono)

Permite abrir el hilo de WhatsApp de un contacto con una URL estable, sin conocer el UUID interno de la conversación.

La URL canónica del chat sigue siendo `/conversations/{uuid}`. El deep link solo **resuelve** y **redirige**; no crea contactos ni conversaciones.

## Formato

```
/c/{guid_empresa}/{telefono}
```

| Segmento | Qué es | Ejemplo |
|----------|--------|---------|
| `guid_empresa` | `companies.guid_company` (GUID externo). También acepta `companies.id` | `08be5fd3-a186-4141-83c8-4a9133de25f4` |
| `telefono` | Número del **contacto** (cliente), preferiblemente solo dígitos | `584266330794` |

Ejemplo (Vital Sonrisa Centro, contacto loreanny planas):

```
https://chatbase-beryl.vercel.app/c/08be5fd3-a186-4141-83c8-4a9133de25f4/584266330794
```

En local:

```
http://localhost:3000/c/08be5fd3-a186-4141-83c8-4a9133de25f4/584266330794
```

### Teléfono en la URL

El path **no debe llevar `+`**. El `+` en URLs se interpreta mal; usa solo dígitos.

Estos valores se normalizan al mismo número (`584266330794`):

- `584266330794` (recomendado)
- `%2B584266330794` (`+` encoded)
- `+584266330794` (si el servidor conserva el `+` en el path)

La búsqueda prueba `+{dígitos}` y `{dígitos}` contra `contacts.phone_number`.

## Flujo

```
GET /c/{guid}/{telefono}
        │
        ├─ Sin sesión ──► /login?next=/c/{guid}/{telefono}
        │                      │
        │                      └─ Tras login ──► vuelve a /c/...
        │
        ├─ Empresa no visible / sin permiso conversations.view
        │                      └─► “Conversación no encontrada”
        │
        ├─ Contacto o conversación inexistentes
        │                      └─► “Conversación no encontrada”
        │
        └─ OK ──► redirect /conversations/{uuid}
```

1. Si no hay sesión, el middleware (y el layout de la app) redirigen a login **guardando** la URL en `?next=`.
2. Tras autenticarse, se vuelve a `/c/{guid}/{telefono}`.
3. Se resuelve empresa → permiso → contacto → conversación más reciente.
4. Redirect 302/307 a `/conversations/{uuid}` (inbox habitual).
5. Si el usuario tiene varias empresas, el inbox cambia el filtro al `company_id` de ese hilo.

Login **sin** `next` (entrada normal) sigue abriendo el chat más reciente, como antes.

## Autorización

No es un enlace público. Quien abre la URL debe:

1. Estar autenticado (Supabase Auth).
2. Tener membresía activa en esa empresa (o ser Super Admin de plataforma).
3. Tener permiso `conversations.view`.
4. Pasar RLS de conversaciones: `has_inbox_access` + `conversations.view`.

Si falta cualquiera de esos puntos, la UI es la misma: **Conversación no encontrada**. No se indica si la empresa o el teléfono existen.

Un usuario de otra empresa no puede abrir el chat aunque conozca GUID y teléfono.

## Resolución de datos

Orden interno (`resolveChatByCompanyGuidAndPhone`):

1. Normalizar el teléfono a dígitos.
2. Buscar empresa por `guid_company`; si no hay fila, buscar por `companies.id`.
3. Comprobar `conversations.view` en esa empresa.
4. Buscar contactos de esa empresa con ese teléfono.
5. Tomar la conversación de esos contactos con `last_message_at` más reciente (si hay varios inboxes).

No se crea nada si el contacto o el chat no existen.

El GUID de empresa se configura en **Empresas** (`guid_company`), no es el UUID interno salvo que se use ese fallback a propósito.

## Destinos permitidos tras login (`next`)

Solo se aceptan paths internos:

- `/c/...`
- `/conversations` y `/conversations/{uuid}`

Se rechazan `//sitio-externo`, `https://...` y cualquier otra ruta (por ejemplo `/dashboard`). Así se evita un open redirect.

## Archivos

| Archivo | Rol |
|---------|-----|
| `src/app/(app)/c/[companyGuid]/[phone]/route.ts` | Ruta del deep link (307) |
| `src/app/(app)/chat-not-found/page.tsx` | UI de no encontrado |
| `src/lib/conversations/resolve-chat-by-phone.ts` | Lookup empresa + teléfono |
| `src/lib/conversations/phone-digits.ts` | Normalización del número |
| `src/lib/auth/safe-next-path.ts` | Validación de `next` |
| `src/lib/supabase/middleware.ts` | Redirect a login con `next` |
| `src/app/login/login-form.tsx` | Tras login, ir a `next` si es seguro |
| `src/components/conversations/chat-not-found.tsx` | UI de no encontrado |

## Cómo usarlo desde otro sistema

Desde un ERP u otra app, arma el enlace con el GUID de la compañía y el teléfono del cliente **sin `+`**:

```
https://<host>/c/<guid_company>/<digitos_telefono>
```

El usuario de Sofia Chat debe tener acceso a esa empresa. Si no está logueado, verá el login y después el hilo.

## Pruebas unitarias

```bash
node --test --experimental-strip-types src/lib/auth/safe-next-path.test.ts src/lib/conversations/phone-digits.test.ts src/lib/conversations/fetch-conversation-list.test.ts src/lib/conversations/resolve-chat-by-phone.test.ts src/lib/conversations/inbox-company-preference.test.ts
```
