export const PERMISSIONS = [
  "companies.manage",
  "users.manage",
  "roles.manage",
  "inboxes.manage",
  "inboxes.view",
  "conversations.view",
  "conversations.reply",
  "conversations.assign",
  "conversations.tag",
  "notes.manage",
  "tickets.manage",
  "tickets.view",
  "contacts.view",
  "templates.send",
  "kanban.manage",
  "tags.manage",
  "error_logs.view",
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<PermissionCode, string> = {
  "companies.manage": "Administrar empresas",
  "users.manage": "Gestionar usuarios",
  "roles.manage": "Gestionar roles",
  "inboxes.manage": "Administrar inboxes",
  "inboxes.view": "Ver inboxes",
  "conversations.view": "Ver conversaciones",
  "conversations.reply": "Responder chats",
  "conversations.assign": "Asignar chats",
  "conversations.tag": "Etiquetar / Kanban",
  "notes.manage": "Notas internas",
  "tickets.manage": "Gestionar tickets",
  "tickets.view": "Ver tickets",
  "contacts.view": "Ver contactos",
  "templates.send": "Enviar plantillas",
  "kanban.manage": "Administrar Kanban",
  "tags.manage": "Crear y gestionar tags de contacto",
  "error_logs.view": "Ver log de errores del sistema",
};

/** Only Super Admin (is_platform_admin) may grant or revoke these. */
export const PLATFORM_PERMISSIONS = [
  "companies.manage",
  "roles.manage",
  "error_logs.view",
] as const satisfies readonly PermissionCode[];

const PLATFORM_PERMISSION_SET = new Set<string>(PLATFORM_PERMISSIONS);
const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPlatformPermission(code: string) {
  return PLATFORM_PERMISSION_SET.has(code);
}

export function isReservedRoleName(name: string) {
  return name.trim().toLowerCase() === "super admin";
}

export function sanitizeRolePermissionCodes(
  requested: string[],
  existing: string[],
  isPlatformAdmin: boolean,
): string[] {
  const uniqueRequested = [
    ...new Set(requested.filter((code) => PERMISSION_SET.has(code))),
  ];
  if (isPlatformAdmin) return uniqueRequested;
  const preserved = existing.filter(isPlatformPermission);
  const unlocked = uniqueRequested.filter((code) => !isPlatformPermission(code));
  return [...new Set([...unlocked, ...preserved])];
}
