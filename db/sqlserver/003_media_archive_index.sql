-- Lets the media archive job find recent files without scanning all messages every minute.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

CREATE INDEX messages_media_created_idx ON chatbase.messages (created_at)
  WHERE type IN (N'image', N'audio', N'video', N'document', N'sticker');
GO
