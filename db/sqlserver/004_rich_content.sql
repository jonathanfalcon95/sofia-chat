-- What a template or interactive message showed: header, text and buttons, so the thread can draw
-- them. Filled by the webhook, the template enrichment and scripts/backfill-rich-content.ts.
-- Nullable with no default, so adding it touches no rows.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
-- The schema lock waits for open webhook transactions; give up rather than queue them behind it.
SET LOCK_TIMEOUT 10000;
GO

IF COL_LENGTH(N'chatbase.messages', N'rich_content') IS NULL
  ALTER TABLE chatbase.messages ADD rich_content nvarchar(max) NULL
    CONSTRAINT messages_rich_content_json CHECK (rich_content IS NULL OR ISJSON(rich_content) = 1);
GO
