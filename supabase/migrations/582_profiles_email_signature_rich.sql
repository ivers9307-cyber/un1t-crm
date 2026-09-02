-- MAIL-SIG.1 — the structured rich signature (Richard, 2 Sep: photo, social
-- links, set on the profile, appended to every email the user sends from any
-- account).
--
-- STRUCTURED DATA, NEVER USER HTML. Mig 493's email_signature stayed plain
-- text because a markup-bearing column would be the one un-sanitised HTML
-- path into outbound mail. That invariant survives here in spirit: the jsonb
-- holds FIELDS (name, title, phone, photo_url, links[]) that the server-side
-- renderer escapes and assembles into email-safe HTML — the user authors
-- values, never markup. photo_url is validated at write time against OUR
-- public branding-bucket prefix, so the render can never embed a foreign URL.
--
-- The legacy text column stays as the fallback (rich absent/disabled → the
-- plain-text behaviour, byte-identical) and as the plain-text part's base.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_signature_rich jsonb,
  ADD CONSTRAINT profiles_email_signature_rich_size
    CHECK (email_signature_rich IS NULL OR pg_column_size(email_signature_rich) <= 8192);

COMMENT ON COLUMN public.profiles.email_signature_rich IS
  'MAIL-SIG.1: structured signature {enabled, name, title, phone, note, photo_url, links:[{label,url}]}. Rendered server-side (escaped) at send; the user never authors HTML. Validated by /api/me/preferences; photo_url must point into the public branding bucket.';
