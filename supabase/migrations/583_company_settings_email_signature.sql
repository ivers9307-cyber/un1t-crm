-- MAIL-SIG.2 — the STUDIO half of the email signature (Richard, 2 Sep:
-- "the links for Richard sending on Hatch will be different to the links
-- on emails sending in Stillorgan", and the links must be operator-editable
-- in the portal — the customer-facing-copy invariant).
--
-- Per location, on company_settings (the per-location branding home):
--   email_signature jsonb { phone, links: [{label, url}] }
-- Resolved at SEND TIME against the MAILBOX'S location: a signature's
-- studio-dependent parts (studio line, phone, links) follow the account the
-- email leaves from; the person's own profile supplies name/photo always and
-- phone/links only as fallback when the studio defines none.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS email_signature jsonb,
  ADD CONSTRAINT company_settings_email_signature_size
    CHECK (email_signature IS NULL OR pg_column_size(email_signature) <= 4096);

COMMENT ON COLUMN public.company_settings.email_signature IS
  'MAIL-SIG.2: studio-level signature parts {phone, links:[{label,url}]}. Edited on the studio''s Email settings card; resolved at send against the sending mailbox''s location. Person-level email_signature_rich supplies name/photo, and phone/links only when the studio defines none.';
