-- Baseline DDL for the chatbase schema on Azure SQL.
-- Generated from the live Supabase schema on 2026-11-05.
-- Supabase migrations are not ported: they carry one-off backfills and demo data.
--
-- Column rules:
--   * External ids (wamid, ycloud_*) use Latin1_General_100_BIN2: they are case-sensitive,
--     and the database default collation is not.
--   * User text uses Latin1_General_100_CI_AS_SC: case-insensitive and accent-sensitive like
--     the ILIKE searches it replaces, and supplementary-character aware for emoji.
--   * All timestamps are datetime2(3) in UTC.
--   * jsonb becomes nvarchar(max) with an ISJSON check.
--   * Triggers are not ported; their logic moves to the repositories.

-- Filtered indexes require these, and sqlcmd leaves QUOTED_IDENTIFIER off by default.
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF SCHEMA_ID(N'chatbase') IS NULL EXEC(N'CREATE SCHEMA chatbase');
GO

-- Identity and tenancy ------------------------------------------------------

CREATE TABLE chatbase.auth_users (
  id                  uniqueidentifier NOT NULL CONSTRAINT auth_users_pkey PRIMARY KEY,
  email               nvarchar(320) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  password_hash       varchar(72) COLLATE Latin1_General_100_BIN2 NOT NULL,
  session_version     int NOT NULL CONSTRAINT auth_users_session_version_df DEFAULT 1,
  is_disabled         bit NOT NULL CONSTRAINT auth_users_is_disabled_df DEFAULT 0,
  failed_login_count  int NOT NULL CONSTRAINT auth_users_failed_login_count_df DEFAULT 0,
  locked_until        datetime2(3) NULL,
  email_confirmed_at  datetime2(3) NULL,
  last_sign_in_at     datetime2(3) NULL,
  password_changed_at datetime2(3) NULL,
  created_at          datetime2(3) NOT NULL CONSTRAINT auth_users_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at          datetime2(3) NOT NULL CONSTRAINT auth_users_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT auth_users_email_key UNIQUE (email)
);
GO

CREATE TABLE chatbase.companies (
  id           uniqueidentifier NOT NULL CONSTRAINT companies_id_df DEFAULT NEWID() CONSTRAINT companies_pkey PRIMARY KEY,
  name         nvarchar(200) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  slug         nvarchar(100) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  is_active    bit NOT NULL CONSTRAINT companies_is_active_df DEFAULT 1,
  guid_company nvarchar(64) NULL,
  created_at   datetime2(3) NOT NULL CONSTRAINT companies_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at   datetime2(3) NOT NULL CONSTRAINT companies_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT companies_slug_key UNIQUE (slug)
);
GO

CREATE TABLE chatbase.profiles (
  id                uniqueidentifier NOT NULL CONSTRAINT profiles_pkey PRIMARY KEY,
  email             nvarchar(320) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  full_name         nvarchar(200) COLLATE Latin1_General_100_CI_AS_SC NULL,
  is_platform_admin bit NOT NULL CONSTRAINT profiles_is_platform_admin_df DEFAULT 0,
  created_at        datetime2(3) NOT NULL CONSTRAINT profiles_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at        datetime2(3) NOT NULL CONSTRAINT profiles_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES chatbase.auth_users (id) ON DELETE CASCADE
);
GO

CREATE TABLE chatbase.company_memberships (
  id         uniqueidentifier NOT NULL CONSTRAINT company_memberships_id_df DEFAULT NEWID() CONSTRAINT company_memberships_pkey PRIMARY KEY,
  company_id uniqueidentifier NOT NULL,
  user_id    uniqueidentifier NOT NULL,
  is_active  bit NOT NULL CONSTRAINT company_memberships_is_active_df DEFAULT 1,
  created_at datetime2(3) NOT NULL CONSTRAINT company_memberships_created_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT company_memberships_company_id_user_id_key UNIQUE (company_id, user_id),
  CONSTRAINT company_memberships_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT company_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES chatbase.profiles (id)
);
CREATE INDEX company_memberships_user_id_idx ON chatbase.company_memberships (user_id);
GO

CREATE TABLE chatbase.permissions (
  id          uniqueidentifier NOT NULL CONSTRAINT permissions_id_df DEFAULT NEWID() CONSTRAINT permissions_pkey PRIMARY KEY,
  code        nvarchar(100) COLLATE Latin1_General_100_BIN2 NOT NULL,
  description nvarchar(400) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  created_at  datetime2(3) NOT NULL CONSTRAINT permissions_created_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT permissions_code_key UNIQUE (code)
);
GO

CREATE TABLE chatbase.roles (
  id          uniqueidentifier NOT NULL CONSTRAINT roles_id_df DEFAULT NEWID() CONSTRAINT roles_pkey PRIMARY KEY,
  company_id  uniqueidentifier NULL,
  name        nvarchar(100) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  description nvarchar(500) COLLATE Latin1_General_100_CI_AS_SC NULL,
  is_system   bit NOT NULL CONSTRAINT roles_is_system_df DEFAULT 0,
  created_at  datetime2(3) NOT NULL CONSTRAINT roles_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at  datetime2(3) NOT NULL CONSTRAINT roles_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id)
);
-- SQL Server treats NULLs as equal in a unique index, so templates get their own index.
CREATE UNIQUE INDEX roles_company_id_name_key ON chatbase.roles (company_id, name) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX roles_template_name_key ON chatbase.roles (name) WHERE company_id IS NULL;
GO

CREATE TABLE chatbase.role_permissions (
  role_id       uniqueidentifier NOT NULL,
  permission_id uniqueidentifier NOT NULL,
  CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id),
  CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES chatbase.roles (id) ON DELETE CASCADE,
  CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES chatbase.permissions (id) ON DELETE CASCADE
);
CREATE INDEX role_permissions_permission_id_idx ON chatbase.role_permissions (permission_id);
GO

CREATE TABLE chatbase.membership_roles (
  membership_id uniqueidentifier NOT NULL,
  role_id       uniqueidentifier NOT NULL,
  CONSTRAINT membership_roles_pkey PRIMARY KEY (membership_id, role_id),
  CONSTRAINT membership_roles_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES chatbase.company_memberships (id) ON DELETE CASCADE,
  CONSTRAINT membership_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES chatbase.roles (id) ON DELETE CASCADE
);
CREATE INDEX membership_roles_role_id_idx ON chatbase.membership_roles (role_id);
GO

-- WhatsApp accounts and inboxes ---------------------------------------------

CREATE TABLE chatbase.ycloud_accounts (
  id                         uniqueidentifier NOT NULL CONSTRAINT ycloud_accounts_id_df DEFAULT NEWID() CONSTRAINT ycloud_accounts_pkey PRIMARY KEY,
  name                       nvarchar(200) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  api_key_encrypted          nvarchar(1024) COLLATE Latin1_General_100_BIN2 NOT NULL,
  webhook_secret_encrypted   nvarchar(1024) COLLATE Latin1_General_100_BIN2 NULL,
  ycloud_webhook_endpoint_id nvarchar(64) COLLATE Latin1_General_100_BIN2 NULL,
  api_key_last4              nvarchar(8) COLLATE Latin1_General_100_BIN2 NULL,
  is_active                  bit NOT NULL CONSTRAINT ycloud_accounts_is_active_df DEFAULT 1,
  created_at                 datetime2(3) NOT NULL CONSTRAINT ycloud_accounts_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at                 datetime2(3) NOT NULL CONSTRAINT ycloud_accounts_updated_at_df DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE chatbase.inboxes (
  id                     uniqueidentifier NOT NULL CONSTRAINT inboxes_id_df DEFAULT NEWID() CONSTRAINT inboxes_pkey PRIMARY KEY,
  company_id             uniqueidentifier NULL,
  name                   nvarchar(200) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  phone_number           nvarchar(32) COLLATE Latin1_General_100_BIN2 NOT NULL,
  ycloud_phone_number_id nvarchar(64) COLLATE Latin1_General_100_BIN2 NULL,
  waba_id                nvarchar(64) COLLATE Latin1_General_100_BIN2 NULL,
  ycloud_account_id      uniqueidentifier NULL,
  is_active              bit NOT NULL CONSTRAINT inboxes_is_active_df DEFAULT 1,
  created_at             datetime2(3) NOT NULL CONSTRAINT inboxes_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at             datetime2(3) NOT NULL CONSTRAINT inboxes_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT inboxes_phone_number_key UNIQUE (phone_number),
  CONSTRAINT inboxes_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT inboxes_ycloud_account_id_fkey FOREIGN KEY (ycloud_account_id) REFERENCES chatbase.ycloud_accounts (id) ON DELETE SET NULL
);
CREATE INDEX inboxes_company_id_idx ON chatbase.inboxes (company_id);
CREATE INDEX inboxes_ycloud_account_id_idx ON chatbase.inboxes (ycloud_account_id);
CREATE UNIQUE INDEX inboxes_account_ycloud_phone_id_uidx ON chatbase.inboxes (ycloud_account_id, ycloud_phone_number_id)
  WHERE ycloud_account_id IS NOT NULL AND ycloud_phone_number_id IS NOT NULL;
GO

CREATE TABLE chatbase.membership_inboxes (
  membership_id uniqueidentifier NOT NULL,
  inbox_id      uniqueidentifier NOT NULL,
  CONSTRAINT membership_inboxes_pkey PRIMARY KEY (membership_id, inbox_id),
  CONSTRAINT membership_inboxes_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES chatbase.company_memberships (id) ON DELETE CASCADE,
  CONSTRAINT membership_inboxes_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES chatbase.inboxes (id) ON DELETE CASCADE
);
CREATE INDEX membership_inboxes_inbox_id_idx ON chatbase.membership_inboxes (inbox_id);
GO

-- Conversations -------------------------------------------------------------

CREATE TABLE chatbase.contacts (
  id           uniqueidentifier NOT NULL CONSTRAINT contacts_id_df DEFAULT NEWID(),
  company_id   uniqueidentifier NOT NULL,
  phone_number nvarchar(32) COLLATE Latin1_General_100_BIN2 NOT NULL,
  name         nvarchar(1000) COLLATE Latin1_General_100_CI_AS_SC NULL,
  metadata     nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL CONSTRAINT contacts_metadata_df DEFAULT N'{}',
  created_at   datetime2(3) NOT NULL CONSTRAINT contacts_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at   datetime2(3) NOT NULL CONSTRAINT contacts_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT contacts_pkey PRIMARY KEY NONCLUSTERED (id),
  CONSTRAINT contacts_company_id_phone_number_key UNIQUE CLUSTERED (company_id, phone_number),
  CONSTRAINT contacts_metadata_isjson CHECK (ISJSON(metadata) = 1),
  CONSTRAINT contacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id)
);
GO

CREATE TABLE chatbase.conversations (
  id                   uniqueidentifier NOT NULL CONSTRAINT conversations_id_df DEFAULT NEWID(),
  company_id           uniqueidentifier NOT NULL,
  inbox_id             uniqueidentifier NOT NULL,
  contact_id           uniqueidentifier NOT NULL,
  assignee_id          uniqueidentifier NULL,
  status               nvarchar(20) NOT NULL CONSTRAINT conversations_status_df DEFAULT N'open',
  last_message_at      datetime2(3) NULL,
  last_inbound_at      datetime2(3) NULL,
  window_expires_at    datetime2(3) NULL,
  -- left(x, 200) counts code points in Postgres: up to 400 UTF-16 units.
  last_message_preview nvarchar(400) COLLATE Latin1_General_100_CI_AS_SC NULL,
  unread_count         int NOT NULL CONSTRAINT conversations_unread_count_df DEFAULT 0,
  created_at           datetime2(3) NOT NULL CONSTRAINT conversations_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at           datetime2(3) NOT NULL CONSTRAINT conversations_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT conversations_pkey PRIMARY KEY NONCLUSTERED (id),
  -- Stable key: last_message_at changes on every message and must not move the row.
  CONSTRAINT conversations_inbox_id_contact_id_key UNIQUE CLUSTERED (inbox_id, contact_id),
  CONSTRAINT conversations_status_check CHECK (status IN (N'open', N'pending', N'resolved', N'closed')),
  CONSTRAINT conversations_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT conversations_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES chatbase.inboxes (id),
  CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES chatbase.contacts (id),
  CONSTRAINT conversations_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES chatbase.profiles (id)
);
CREATE INDEX conversations_assignee_id_idx ON chatbase.conversations (assignee_id);
CREATE INDEX conversations_contact_id_idx ON chatbase.conversations (contact_id);
-- Descending order already puts NULLs last in SQL Server.
CREATE INDEX conversations_company_last_msg_idx ON chatbase.conversations (company_id, last_message_at DESC, id DESC);
CREATE INDEX conversations_inbox_last_msg_idx ON chatbase.conversations (inbox_id, last_message_at DESC, id DESC);
GO

CREATE TABLE chatbase.messages (
  id                  uniqueidentifier NOT NULL CONSTRAINT messages_id_df DEFAULT NEWID(),
  conversation_id     uniqueidentifier NOT NULL,
  company_id          uniqueidentifier NOT NULL,
  direction           nvarchar(8) NOT NULL,
  type                nvarchar(64) NOT NULL CONSTRAINT messages_type_df DEFAULT N'text',
  body                nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NULL,
  template_name       nvarchar(512) COLLATE Latin1_General_100_CI_AS_SC NULL,
  template_language   nvarchar(32) NULL,
  template_components nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NULL,
  ycloud_message_id   nvarchar(128) COLLATE Latin1_General_100_BIN2 NULL,
  status              nvarchar(32) NOT NULL CONSTRAINT messages_status_df DEFAULT N'received',
  media_url           nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL,
  raw_payload         nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NULL,
  sent_by             uniqueidentifier NULL,
  created_at          datetime2(3) NOT NULL CONSTRAINT messages_created_at_df DEFAULT SYSUTCDATETIME(),
  media_mime          nvarchar(255) NULL,
  media_filename      nvarchar(1024) COLLATE Latin1_General_100_CI_AS_SC NULL,
  media_sha256        nvarchar(128) COLLATE Latin1_General_100_BIN2 NULL,
  wamid               nvarchar(256) COLLATE Latin1_General_100_BIN2 NULL,
  reply_to_wamid      nvarchar(256) COLLATE Latin1_General_100_BIN2 NULL,
  reactions           nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL CONSTRAINT messages_reactions_df DEFAULT N'[]',
  CONSTRAINT messages_pkey PRIMARY KEY NONCLUSTERED (id),
  CONSTRAINT messages_direction_check CHECK (direction IN (N'inbound', N'outbound')),
  CONSTRAINT messages_template_components_isjson CHECK (ISJSON(template_components) = 1),
  CONSTRAINT messages_raw_payload_isjson CHECK (ISJSON(raw_payload) = 1),
  CONSTRAINT messages_reactions_isjson CHECK (ISJSON(reactions) = 1),
  CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chatbase.conversations (id) ON DELETE CASCADE,
  CONSTRAINT messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT messages_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES chatbase.profiles (id)
);
CREATE UNIQUE CLUSTERED INDEX messages_conversation_created_idx ON chatbase.messages (conversation_id, created_at, id);
-- 4 rows have a NULL ycloud_message_id; a plain unique index would allow only one.
CREATE UNIQUE INDEX messages_ycloud_message_id_key ON chatbase.messages (ycloud_message_id) WHERE ycloud_message_id IS NOT NULL;
CREATE INDEX messages_wamid_idx ON chatbase.messages (wamid) WHERE wamid IS NOT NULL;
CREATE INDEX messages_reply_to_wamid_idx ON chatbase.messages (reply_to_wamid) WHERE reply_to_wamid IS NOT NULL;
CREATE INDEX messages_company_created_idx ON chatbase.messages (company_id, created_at DESC);
GO

CREATE TABLE chatbase.tags (
  id               uniqueidentifier NOT NULL CONSTRAINT tags_id_df DEFAULT NEWID() CONSTRAINT tags_pkey PRIMARY KEY,
  company_id       uniqueidentifier NOT NULL,
  name             nvarchar(200) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  color            nvarchar(32) NOT NULL CONSTRAINT tags_color_df DEFAULT N'#64748b',
  position         int NOT NULL CONSTRAINT tags_position_df DEFAULT 0,
  is_kanban_column bit NOT NULL CONSTRAINT tags_is_kanban_column_df DEFAULT 1,
  created_at       datetime2(3) NOT NULL CONSTRAINT tags_created_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT tags_company_id_name_key UNIQUE (company_id, name),
  CONSTRAINT tags_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id)
);
CREATE INDEX tags_company_position_idx ON chatbase.tags (company_id, position);
GO

CREATE TABLE chatbase.conversation_tags (
  conversation_id uniqueidentifier NOT NULL,
  tag_id          uniqueidentifier NOT NULL,
  created_at      datetime2(3) NOT NULL CONSTRAINT conversation_tags_created_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT conversation_tags_pkey PRIMARY KEY (conversation_id, tag_id),
  CONSTRAINT conversation_tags_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chatbase.conversations (id) ON DELETE CASCADE,
  CONSTRAINT conversation_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES chatbase.tags (id) ON DELETE CASCADE
);
CREATE INDEX conversation_tags_tag_id_idx ON chatbase.conversation_tags (tag_id);
GO

CREATE TABLE chatbase.contact_tags (
  contact_id uniqueidentifier NOT NULL,
  tag_id     uniqueidentifier NOT NULL,
  created_at datetime2(3) NOT NULL CONSTRAINT contact_tags_created_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT contact_tags_pkey PRIMARY KEY (contact_id, tag_id),
  CONSTRAINT contact_tags_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES chatbase.contacts (id) ON DELETE CASCADE,
  CONSTRAINT contact_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES chatbase.tags (id) ON DELETE CASCADE
);
CREATE INDEX contact_tags_tag_id_idx ON chatbase.contact_tags (tag_id);
GO

CREATE TABLE chatbase.conversation_notes (
  id              uniqueidentifier NOT NULL CONSTRAINT conversation_notes_id_df DEFAULT NEWID() CONSTRAINT conversation_notes_pkey PRIMARY KEY,
  conversation_id uniqueidentifier NOT NULL,
  company_id      uniqueidentifier NOT NULL,
  author_id       uniqueidentifier NOT NULL,
  body            nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  created_at      datetime2(3) NOT NULL CONSTRAINT conversation_notes_created_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT conversation_notes_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chatbase.conversations (id) ON DELETE CASCADE,
  CONSTRAINT conversation_notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT conversation_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES chatbase.profiles (id)
);
CREATE INDEX conversation_notes_conversation_id_idx ON chatbase.conversation_notes (conversation_id, created_at);
GO

CREATE TABLE chatbase.tickets (
  id                   uniqueidentifier NOT NULL CONSTRAINT tickets_id_df DEFAULT NEWID() CONSTRAINT tickets_pkey PRIMARY KEY,
  company_id           uniqueidentifier NOT NULL,
  conversation_id      uniqueidentifier NOT NULL,
  title                nvarchar(500) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  description          nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NULL,
  status               nvarchar(20) NOT NULL CONSTRAINT tickets_status_df DEFAULT N'open',
  priority             nvarchar(20) NOT NULL CONSTRAINT tickets_priority_df DEFAULT N'medium',
  assignee_id          uniqueidentifier NULL,
  created_by           uniqueidentifier NOT NULL,
  support_response     nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NULL,
  support_responded_at datetime2(3) NULL,
  support_responded_by uniqueidentifier NULL,
  created_at           datetime2(3) NOT NULL CONSTRAINT tickets_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at           datetime2(3) NOT NULL CONSTRAINT tickets_updated_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT tickets_status_check CHECK (status IN (N'open', N'in_progress', N'resolved', N'closed')),
  CONSTRAINT tickets_priority_check CHECK (priority IN (N'low', N'medium', N'high', N'urgent')),
  CONSTRAINT tickets_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT tickets_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chatbase.conversations (id) ON DELETE CASCADE,
  CONSTRAINT tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES chatbase.profiles (id),
  CONSTRAINT tickets_created_by_fkey FOREIGN KEY (created_by) REFERENCES chatbase.profiles (id),
  CONSTRAINT tickets_support_responded_by_fkey FOREIGN KEY (support_responded_by) REFERENCES chatbase.profiles (id)
);
CREATE INDEX tickets_assignee_id_idx ON chatbase.tickets (assignee_id);
CREATE INDEX tickets_company_status_idx ON chatbase.tickets (company_id, status);
CREATE INDEX tickets_conversation_id_idx ON chatbase.tickets (conversation_id);
CREATE INDEX tickets_created_by_idx ON chatbase.tickets (created_by);
GO

-- Operations ----------------------------------------------------------------

CREATE TABLE chatbase.webhook_events (
  id              uniqueidentifier NOT NULL CONSTRAINT webhook_events_id_df DEFAULT NEWID(),
  ycloud_event_id nvarchar(128) COLLATE Latin1_General_100_BIN2 NOT NULL,
  event_type      nvarchar(128) NOT NULL,
  payload         nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  processed_at    datetime2(3) NOT NULL CONSTRAINT webhook_events_processed_at_df DEFAULT SYSUTCDATETIME(),
  CONSTRAINT webhook_events_pkey PRIMARY KEY NONCLUSTERED (id),
  CONSTRAINT webhook_events_ycloud_event_id_key UNIQUE (ycloud_event_id),
  CONSTRAINT webhook_events_payload_isjson CHECK (ISJSON(payload) = 1)
);
-- Clustered on time so the retention job deletes old rows in key order.
CREATE UNIQUE CLUSTERED INDEX webhook_events_processed_at_idx ON chatbase.webhook_events (processed_at, id);
GO

CREATE TABLE chatbase.error_logs (
  id              uniqueidentifier NOT NULL CONSTRAINT error_logs_id_df DEFAULT NEWID() CONSTRAINT error_logs_pkey PRIMARY KEY,
  created_at      datetime2(3) NOT NULL CONSTRAINT error_logs_created_at_df DEFAULT SYSUTCDATETIME(),
  updated_at      datetime2(3) NOT NULL CONSTRAINT error_logs_updated_at_df DEFAULT SYSUTCDATETIME(),
  level           nvarchar(8) NOT NULL CONSTRAINT error_logs_level_df DEFAULT N'error',
  status          nvarchar(16) NOT NULL CONSTRAINT error_logs_status_df DEFAULT N'open',
  source          nvarchar(200) NOT NULL,
  message         nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  error_name      nvarchar(256) NULL,
  error_code      nvarchar(128) NULL,
  http_status     int NULL,
  stack           nvarchar(max) NULL,
  context         nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL CONSTRAINT error_logs_context_df DEFAULT N'{}',
  company_id      uniqueidentifier NULL,
  user_id         uniqueidentifier NULL,
  request_id      nvarchar(128) NULL,
  resolved_at     datetime2(3) NULL,
  resolved_by     uniqueidentifier NULL,
  resolution_note nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NULL,
  CONSTRAINT error_logs_level_check CHECK (level IN (N'error', N'warn', N'fatal')),
  CONSTRAINT error_logs_status_check CHECK (status IN (N'open', N'acknowledged', N'resolved', N'ignored')),
  CONSTRAINT error_logs_context_isjson CHECK (ISJSON(context) = 1),
  CONSTRAINT error_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES chatbase.companies (id),
  CONSTRAINT error_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES chatbase.profiles (id),
  CONSTRAINT error_logs_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES chatbase.profiles (id)
);
CREATE INDEX error_logs_company_id_created_at_idx ON chatbase.error_logs (company_id, created_at DESC) WHERE company_id IS NOT NULL;
CREATE INDEX error_logs_created_at_idx ON chatbase.error_logs (created_at DESC);
CREATE INDEX error_logs_source_created_at_idx ON chatbase.error_logs (source, created_at DESC);
CREATE INDEX error_logs_status_created_at_idx ON chatbase.error_logs (status, created_at DESC);
GO

-- New for the cutover: raw webhook capture and runtime flags with no app restart.

CREATE TABLE chatbase.webhook_inbox (
  id           bigint IDENTITY(1, 1) NOT NULL CONSTRAINT webhook_inbox_pkey PRIMARY KEY,
  received_at  datetime2(3) NOT NULL CONSTRAINT webhook_inbox_received_at_df DEFAULT SYSUTCDATETIME(),
  account_id   uniqueidentifier NULL,
  raw_body     nvarchar(max) COLLATE Latin1_General_100_CI_AS_SC NOT NULL,
  processed_at datetime2(3) NULL
);
GO

CREATE TABLE chatbase.app_flags (
  [key]      nvarchar(64) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT app_flags_pkey PRIMARY KEY,
  value      nvarchar(256) NOT NULL,
  updated_at datetime2(3) NOT NULL CONSTRAINT app_flags_updated_at_df DEFAULT SYSUTCDATETIME()
);
GO
