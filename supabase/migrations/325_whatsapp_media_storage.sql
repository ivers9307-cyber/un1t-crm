-- WA-MEDIA.1 — re-host inbound WhatsApp/Instagram media so the inbox can
-- actually show it.
--
-- Today the webhook stores Meta's opaque media ID in
-- whatsapp_messages.media_url (e.g. "1554871089537157") and nothing
-- downloads the bytes. A media ID is not a viewable URL — the real
-- download URL has to be fetched with the business access token, expires
-- in minutes, and Meta drops the media after ~30 days. So inbound images
-- never render (the web inbox shows "[image]").
--
-- Fix: copy each inbound media object once into a private
-- 'whatsapp-media' bucket and serve it from there via a short-lived
-- signed URL (the /api/whatsapp/media/[id] route, service-role). Two new
-- columns track that:
--   media_external_id  — Meta's media ID (the thing to (re)fetch from)
--   media_storage_path — object path inside the bucket once re-hosted
-- media_url is left to the outbound template-header media that already
-- uses it; inbound media stops writing it.

-- ====================================================================
-- 1. Private storage bucket
-- ====================================================================
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

-- Deny the anon/authenticated roles any direct access to this bucket.
-- A RESTRICTIVE policy (AND-ed with all permissive policies) is used on
-- purpose: the existing per-bucket "deny all" policies are PERMISSIVE
-- `using (bucket_id <> '<their-bucket>')`, which — being OR-ed — actually
-- GRANT authenticated/anon read on every *other* bucket, including a new
-- one. A restrictive `bucket_id <> 'whatsapp-media'` removes this bucket
-- regardless of those grants, while leaving every other bucket's access
-- untouched. The app never uses these roles for storage anyway: writes
-- go through the service role and reads through signed URLs, both of
-- which bypass RLS. Customer photos shouldn't be reachable with a
-- publishable/anon key.
do $$
begin
  drop policy if exists "whatsapp-media restrictive deny" on storage.objects;
exception when others then null;
end $$;

create policy "whatsapp-media restrictive deny"
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'whatsapp-media')
  with check (bucket_id <> 'whatsapp-media');

-- ====================================================================
-- 2. Columns on whatsapp_messages
-- ====================================================================
alter table public.whatsapp_messages
  add column if not exists media_external_id text,
  add column if not exists media_storage_path text;

comment on column public.whatsapp_messages.media_external_id is
  'WA-MEDIA.1 — Meta/WhatsApp media ID for inbound media. The source to (re)fetch the bytes from until Meta expires it (~30 days). Re-hosted copy lives at media_storage_path.';
comment on column public.whatsapp_messages.media_storage_path is
  'WA-MEDIA.1 — object path in the private whatsapp-media bucket once the inbound media has been downloaded from Meta and re-hosted. Served to the inbox via a signed URL (/api/whatsapp/media/[id]). Null until re-hosted.';

-- ====================================================================
-- 3. Backfill external id from legacy media_url
-- ====================================================================
-- Inbound media rows wrote the raw Meta media ID into media_url. Copy it
-- into the dedicated column so the proxy can lazily re-host historical
-- media (e.g. images received before this migration) on first view.
update public.whatsapp_messages
set media_external_id = media_url
where direction = 'inbound'
  and message_type in ('image', 'video', 'document', 'audio', 'voice', 'sticker')
  and media_external_id is null
  and media_url ~ '^[0-9]{8,24}$';
