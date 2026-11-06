-- rowversion columns: SQL Server bumps them on every write, by anyone, with no application code.
-- Realtime reads the newest changes from them, and the return to Supabase uses them to find what
-- changed after the cutover.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

ALTER TABLE chatbase.auth_users ADD change_version rowversion;
ALTER TABLE chatbase.companies ADD change_version rowversion;
ALTER TABLE chatbase.profiles ADD change_version rowversion;
ALTER TABLE chatbase.company_memberships ADD change_version rowversion;
ALTER TABLE chatbase.roles ADD change_version rowversion;
ALTER TABLE chatbase.role_permissions ADD change_version rowversion;
ALTER TABLE chatbase.membership_roles ADD change_version rowversion;
ALTER TABLE chatbase.ycloud_accounts ADD change_version rowversion;
ALTER TABLE chatbase.inboxes ADD change_version rowversion;
ALTER TABLE chatbase.membership_inboxes ADD change_version rowversion;
ALTER TABLE chatbase.contacts ADD change_version rowversion;
ALTER TABLE chatbase.conversations ADD change_version rowversion;
ALTER TABLE chatbase.messages ADD change_version rowversion;
ALTER TABLE chatbase.tags ADD change_version rowversion;
ALTER TABLE chatbase.conversation_tags ADD change_version rowversion;
ALTER TABLE chatbase.contact_tags ADD change_version rowversion;
ALTER TABLE chatbase.conversation_notes ADD change_version rowversion;
ALTER TABLE chatbase.tickets ADD change_version rowversion;
ALTER TABLE chatbase.error_logs ADD change_version rowversion;
GO

CREATE INDEX messages_change_version_idx ON chatbase.messages (change_version);
CREATE INDEX conversations_change_version_idx ON chatbase.conversations (change_version);
GO
