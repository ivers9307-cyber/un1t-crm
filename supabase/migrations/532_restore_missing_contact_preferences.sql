-- 532 — UNSUBTOKEN.1: give every contact a contact_preferences row, so the
-- unsubscribe link in their email can actually work.
--
-- THE DEFECT
-- ──────────
-- buildUnsubscribeUrl (src/lib/postmark.js) prefers
-- contact_preferences.unsubscribe_token and FALLS BACK to contact.id. The
-- unsubscribe API resolves `.eq('unsubscribe_token', token)` and nothing else,
-- and the two ids are independently generated UUIDs — so the fallback can never
-- match. A contact with no preferences row therefore receives marketing email
-- carrying an unsubscribe link, and a List-Unsubscribe header built from the
-- same URL, that CANNOT WORK.
--
-- The fallback's comment claims it mirrors "the lookup logic the unsubscribe
-- page already accepts". That is stale: the page passes straight through to the
-- API, which is token-only. The sibling code change in this PR removes the
-- fallback so a missing row fails loudly at send time instead of shipping a
-- dead link.
--
-- LIVE AT WRITING: exactly one contact, garrett@garrettivers.com, with
-- email_status='active', location marketing consent TRUE, and present in
-- contact_location_audience — i.e. in the sendable set for the next campaign.
--
-- WHY IT MATTERS BEYOND ONE ROW
-- ─────────────────────────────
-- mergeContacts' dedupePreUpdate DELETES the loser's contact_preferences row as
-- its first destructive act, before any of the FK re-points that can fail. With
-- no transaction around the merge, an abandoned half-merge leaves a contact that
-- is still mailable but can no longer unsubscribe. I cannot prove that is how
-- this row went missing (it predates any merge I can see, and nothing audits
-- merges — there are zero merge audit rows), but it is exactly the shape such a
-- failure leaves, which is why the merge is being wrapped in a transaction in
-- the same PR.
--
-- CONSENT IS NOT CHANGED
-- ──────────────────────
-- Every consent column on this table DEFAULTS to true, so inserting with
-- defaults would silently GRANT permissions. Instead each column is copied from
-- what the contact already has: the marketing flags from
-- contact_location_preferences at the contact's own location, and
-- email_administrative from contacts. Where a contact has no location row
-- either, the marketing flags land FALSE — absent consent is not consent, and
-- this migration exists to restore a token, never to widen an audience.
--
-- Sends read contact_location_audience (LOCCOMMS), not this table, so the
-- restored row does not move anyone into or out of an audience. It restores the
-- unsubscribe_token, which is what was actually missing.
--
-- Idempotent: the NOT EXISTS guard makes a re-run a no-op. Forward-only.

INSERT INTO contact_preferences (
  contact_id,
  location_id,
  email_marketing,
  email_administrative,
  sms_marketing,
  sms_administrative,
  whatsapp_marketing,
  whatsapp_administrative
)
SELECT
  c.id,
  c.location_id,
  COALESCE(p.email_marketing,    false),
  COALESCE(c.email_administrative, true),
  COALESCE(p.sms_marketing,      false),
  true,
  COALESCE(p.whatsapp_marketing, false),
  true
FROM contacts c
LEFT JOIN contact_location_preferences p
       ON p.contact_id = c.id
      AND p.location_id = c.location_id
WHERE NOT EXISTS (
  SELECT 1 FROM contact_preferences cp WHERE cp.contact_id = c.id
);

-- Post-flight: prove the hole is closed. A contact without a preferences row
-- has no unsubscribe_token, and a send to them ships a dead opt-out link.
DO $$
DECLARE missing int;
BEGIN
  SELECT count(*) INTO missing
    FROM contacts c
   WHERE NOT EXISTS (SELECT 1 FROM contact_preferences cp WHERE cp.contact_id = c.id);
  IF missing > 0 THEN
    RAISE EXCEPTION 'mig 532 FAILED: % contacts still have no contact_preferences row', missing;
  END IF;
  RAISE NOTICE 'mig 532 — every contact now has a preferences row, so every unsubscribe link resolves.';
END $$;
