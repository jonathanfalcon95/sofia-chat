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
};
