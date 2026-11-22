-- ===========================================================================
-- EMAILBAR.1 (mig 870): company_settings.email_logo_url.
--
-- WHY: the studio logo (logo_url) is dark artwork on a transparent
-- background. Marketing emails drew it on a white header, and a mail app in
-- dark mode turns that header dark, so the logo all but disappears. Emails
-- written through the agent tools now draw a black bar with this logo when it
-- is set: light artwork on a dark background reads the same in both modes.
--
-- WHAT: one nullable text column, an https URL to an image in the public
-- 'branding' bucket. NULL (every row today) keeps the plain header.
--
-- GRANTS: company_settings has no client privilege (service role only), so
-- the new column needs none.
--
-- APPLY: before the code deploys (src/lib/email-logo.js selects the column;
-- it fails soft to "no email logo" if the column is missing).
-- ===========================================================================

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS email_logo_url text;

COMMENT ON COLUMN public.company_settings.email_logo_url IS
  'EMAILBAR.1 (mig 870): https URL of the logo for the black header bar of marketing emails (light artwork on a dark background). NULL keeps the plain header with logo_url.';
