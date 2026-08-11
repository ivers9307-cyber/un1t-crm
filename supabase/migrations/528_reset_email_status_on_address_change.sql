-- 528 — EMAILREP.3: reset contacts.email_status when the ADDRESS changes,
-- in the database, for every write path at once.
--
-- WHY. contacts.email_status is REPUTATION, and reputation belongs to an
-- ADDRESS, not to a person (mig 005 defines it; migs 492/501 pin it to
-- active | bounced | complained and label it "REPUTATION ONLY"). A hard bounce
-- or a spam complaint stamps it, and every send path then refuses that
-- contact: marketing and transactional audiences (postmark.js
-- buildAudienceQuery), the campaign sender, manual staff email, booking
-- confirmations and event reminders. Refusing a bounced address is correct.
--
-- Keeping the stamp after the address has been REPLACED is not. EMAILREP.1
-- added emailStatusResetForAddressChange (src/lib/email-reputation.js) and
-- wired it into two write paths. Five change contacts.email:
--
--   1. PUT /api/contacts/[id]                     — wired (EMAILREP.1)
--   2. src/lib/contact-import-runner.js           — wired (EMAILREP.1)
--   3. mergeContacts (src/lib/contact-merge.js)   — NOT wired
--   4. POST /api/contacts/imports/[id]/rollback   — NOT wired
--   5. the agent's fill-when-empty tools:           NOT wired
--        save_lead_details   (src/lib/agent/booking-tools.js)
--        register_for_event  (src/lib/agent/event-tools.js)
--
-- On paths 3-5 the contact keeps a stamp describing a mailbox they no longer
-- have, and is permanently unmailable on every channel above with no UI
-- symptom beyond a greyed-out button. A BEFORE trigger closes all five and any
-- sixth nobody has written yet — the same reasoning, and the same shape, as
-- mig 330's derive_wa_phone_trigger.
--
-- WHAT THIS DOES NOT DO. Reputation is restored; CONSENT is not. The
-- hard-bounce handler revokes email_marketing at the moment it stamps
-- 'bounced', and marketing additionally needs per-location consent
-- (contact_location_audience, LOCCOMMS.3 — row absent means that location may
-- never send) and email_suppressed_at IS NULL (mig 395). None of those are
-- touched here, so a corrected address gets administrative mail back
-- immediately and still needs a fresh opt-in before any marketing reaches it.
--
-- NO BACKFILL. Nothing records which historical rows changed address while
-- carrying a stamp, so a backfill would be a guess that silently un-suppresses
-- genuinely dead mailboxes. mig 524 already restamped from evidence; this
-- changes the future only.
--
-- ── The three decisions in the trigger body ────────────────────────────────
--
-- NORMALISE BEFORE COMPARING. Contacts are stored mixed-case (the .ilike
-- invariant in CLAUDE.md), so re-saving 'Ann@x.com' as 'ann@x.com' is the SAME
-- mailbox and must not clear a genuine bounce. lower(btrim(...)) mirrors
-- normalise() in src/lib/email-reputation.js exactly.
--
-- COMPARE AT ALL. `UPDATE OF email` fires whenever the column appears in the
-- SET list, whether or not the value differs — and mergeContacts writes
-- { ...pickMergedFields(survivor, loser) }, which ALWAYS carries an `email`
-- key. Without the value comparison this would clear a bounce on every merge.
-- COALESCE to '' makes a NULL address comparable, so clearing an address reads
-- as a change (it is) and NULL-to-NULL does not.
--
-- GUARD ON *NEW*.email_status, NOT OLD. The two already-wired call sites fold
-- email_status := 'active' into the same UPDATE, so NEW is already 'active'
-- and the trigger is a clean no-op rather than a second opinion. It also means
-- a caller that deliberately states a status alongside a new address keeps it:
-- that caller is describing the NEW mailbox, and overriding an explicit stamp
-- would be worse than deferring to it. Nothing in the estate writes both today
-- (the only email_status writers are the Postmark processor and the consent
-- paths, none of which change email).
--
-- ── Import rollback is genuinely ambiguous; this is the call ───────────────
-- Restoring an old address arguably should restore its old reputation, but
-- before_snapshot does not carry email_status, so there is nothing to restore
-- and both available behaviours are a guess. Leaving the stamp is wrong when
-- the import CORRECTED a typo and the new address later bounced: the rollback
-- restores the old address and leaves it stamped from a different mailbox,
-- permanently, with no symptom. Clearing it is wrong when the old address had
-- genuinely bounced before the import: we then attempt one send, Postmark
-- re-bounces it, the webhook re-stamps 'bounced', and the estate is correct
-- again inside one send (and Postmark's own suppression list very likely
-- refuses it first). One error is permanent and invisible; the other is
-- transient and self-healing. So the trigger applies here too, uniformly —
-- which is also the point of doing this in the database rather than
-- per-path.

CREATE OR REPLACE FUNCTION reset_email_status_on_address_change()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF lower(btrim(COALESCE(OLD.email, ''))) IS DISTINCT FROM lower(btrim(COALESCE(NEW.email, ''))) THEN
    -- Only reputation states are address-bound. 'active' and NULL stay as they
    -- are; anything unrecognised is left alone rather than guessed at. Mirrors
    -- ADDRESS_BOUND_EMAIL_STATUSES in src/lib/email-reputation.js, which
    -- src/lib/email-status-reset-trigger.test.js pins to this list.
    IF NEW.email_status IN ('bounced', 'complained') THEN
      NEW.email_status := 'active';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS reset_email_status_on_address_change_trigger ON contacts;
CREATE TRIGGER reset_email_status_on_address_change_trigger
  BEFORE UPDATE OF email ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION reset_email_status_on_address_change();

COMMENT ON FUNCTION reset_email_status_on_address_change() IS
  'EMAILREP.3 (mig 528): clear an address-bound contacts.email_status (bounced/complained) when the email address itself is replaced. Reputation only — consent (email_marketing, contact_location_audience, email_suppressed_at) is deliberately untouched. Compares lower(btrim(...)) because contacts are stored mixed-case and a re-save of the same mailbox must not clear a genuine bounce.';
