-- IG-MEDIA.1 — receive inbound Instagram DM media (images, video, audio,
-- files) so the operator inbox can actually show it.
--
-- Today parseInstagramEvents() sees msg.attachments but keeps only a
-- boolean, and handleInstagramInbound() stores the literal body
-- "[attachment]" — the image URL Meta delivers in
-- attachments[].payload.url is discarded, and instagram_messages has no
-- column to hold media. Staff see "[attachment]" with no way to open it.
--
-- Unlike WhatsApp (where Meta hands back an opaque media ID that must be
-- resolved with the business token), Instagram delivers a DIRECT CDN URL
-- (lookaside.fbsbx.com) in the webhook. That URL is short-lived, so we
-- copy the bytes once into the SAME private 'whatsapp-media' bucket that
-- WhatsApp uses (created + locked down in mig 325 — reused here, no new
-- bucket) and serve them from there via a short-lived signed URL
-- (/api/instagram/media/[id], service-role).
--
-- Three columns track that (mirrors whatsapp_messages, minus the Meta
-- media-id column IG has no equivalent for):
--   media_url          — the original IG CDN URL (ephemeral; the source to
--                        fetch from on first re-host, kept for reference)
--   media_mime_type    — content type, once known
--   media_storage_path — object path inside the bucket once re-hosted

alter table public.instagram_messages
  add column if not exists media_url text,
  add column if not exists media_mime_type text,
  add column if not exists media_storage_path text;

comment on column public.instagram_messages.media_url is
  'IG-MEDIA.1 — original Instagram CDN URL (lookaside.fbsbx.com) for inbound media, from the webhook attachment payload. Short-lived; the durable copy lives at media_storage_path once re-hosted. Null for text messages.';
comment on column public.instagram_messages.media_mime_type is
  'IG-MEDIA.1 — content type of the inbound media, learned when the bytes are fetched. Drives inline render kind (image/video/audio/file).';
comment on column public.instagram_messages.media_storage_path is
  'IG-MEDIA.1 — object path in the private whatsapp-media bucket once the inbound IG media has been downloaded and re-hosted. Served to the inbox via a signed URL (/api/instagram/media/[id]). Null until re-hosted.';
