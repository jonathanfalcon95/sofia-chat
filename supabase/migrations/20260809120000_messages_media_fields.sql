alter table public.messages
  add column if not exists media_mime text,
  add column if not exists media_filename text,
  add column if not exists media_sha256 text;
