-- EMAIL-RLS-MAILBOX.1 — mailbox-scoped SELECT on the email ticketing tables.
-- 2026-08-08 audit, finding 1 (CONFIRMED HIGH).
--
-- WHAT WAS TRUE BEFORE THIS
-- The SELECT policies on email_inbox_messages (mig 394), email_tickets and
-- email_ticket_attachments (mig 482) and email_mailboxes (mig 485) allowed any
-- profile_locations member at the row's location, plus master. But the app's
-- confidentiality boundary for email is NOT the location — it is the per-account
-- grant in email_mailbox_access (loadTicketForUser: master/owner-at-location are
-- elevated; everyone else needs a grant row for the ticket's mailbox). That
-- boundary lives only in the service-role routes, which RLS does not touch —
-- so a coach with no grant on accounts@ could open the browser console and read
-- the whole location's mail via PostgREST with their own session:
--
--     supabase.from('email_inbox_messages').select('*')
--
-- raw html_body, bcc_emails, accounts@ billing correspondence, all of it.
-- Attachment BYTES were never exposed (private bucket, signed URLs minted by a
-- route that checks access first) — but the rows (filenames, sizes, which
-- member sent what to which address) leaked with the rest.
--
-- Mig 496 already tightened email_storage_usage to master/owner-at-location —
-- the accepted pattern for this family. The content tables were left coarse;
-- this migration brings them to the same boundary the app enforces.
--
-- THE RULE (mirrors loadTicketForUser exactly)
--   master
--   OR owner at the row's location            (elevated: no grant rows needed)
--   OR a row in email_mailbox_access for the row's mailbox
-- A row whose mailbox is NULL (mailbox deleted — ON DELETE SET NULL — or the
-- mig 484 backfill) is elevated-only: no mailbox means no grant can exist, and
-- loadTicketForUser makes exactly the same call. Both helpers below return
-- false on NULL input, so the fail-closed default needs no special casing.
--
-- DELIBERATELY NARROWER THAN THE APP in one respect: guardMasterOrOwner also
-- honours SAAS-4 org admins (synthetic 'owner' everywhere in their org), which
-- private.auth_is_owner_at does not know about. RLS ⊆ app access is safe — the
-- UIs (web and mobile both) read exclusively through service-role /api routes,
-- verified before writing this: no browser-side .from() on any of these tables,
-- and the realtime email subscriptions were removed in INBOX-SPLIT.1 (#1251).
-- Mig 496 made the identical trade for email_storage_usage.
--
-- The `email_inbox` SURFACE permission (JSONB on profile_locations) is NOT
-- replicated here, on purpose: a grant row is a deliberate per-account
-- authorisation minted by master/owner on the mailbox-admin surface, and
-- defense-in-depth does not need to re-derive the permission resolver in SQL.
-- The service-role routes remain the full gate; RLS now fails closed to the
-- same population they would approve.
--
-- MECHANICS
--   • SECURITY DEFINER helpers in `private` (the mig 051 idiom), so the
--     policies do not nest RLS evaluation: an inline EXISTS against
--     email_mailbox_access — and worse, messages joining email_tickets — would
--     re-run those tables' own policies per row. The helpers read the tables
--     directly, answer only about the CALLING user (auth.uid()), and leak
--     nothing about anyone else's grants.
--   • Grant lookups ride the email_mailbox_access PRIMARY KEY
--     (mailbox_id, profile_id); the ticket hop rides email_tickets' PK.
--     No new index needed.
--   • Attachments use their own mailbox_id (denormalised from the ticket in
--     mig 496; both columns are SET NULL on the same mailbox FK, and no write
--     path moves a ticket between mailboxes, so they cannot disagree). A row
--     written without it fails closed to elevated-only.
--   • Same policy names, DROP + CREATE — still exactly ONE permissive SELECT
--     per table (the mig 320 rule); the per-command restrictive deny-writes
--     from migs 483/485 are untouched.
--   • Realtime: email_tickets and email_inbox_messages remain in the
--     supabase_realtime publication. Nothing subscribes to them today; if
--     something ever does again, each subscriber now receives exactly the rows
--     their grants allow, which is the point.
--
-- ⚠️ Authored WITHOUT live-database access (no Supabase MCP in this session):
-- the 502 prefix is derived from origin/main, where 501 is a DELIBERATE
-- duplicate prefix (485-style) — EMAIL-FORWARD.1 and EMAILSTATUS-REMINT.1
-- both minted a 501 the same morning and both are applied to prod. Whoever
-- applies this: confirm 502 is free against live schema_migrations first,
-- and run get_advisors (BOTH types — security AND performance) after.

-- ── Helpers ─────────────────────────────────────────────────────────
-- STABLE + SECURITY DEFINER + empty search_path, per the mig 051 family.
-- Both answer a question about the CALLER only and return false on NULL.

CREATE OR REPLACE FUNCTION private.auth_has_mailbox_grant(p_mailbox_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_mailbox_access a
    WHERE a.mailbox_id = p_mailbox_id
      AND a.profile_id = (SELECT auth.uid())
  )
$$;

COMMENT ON FUNCTION private.auth_has_mailbox_grant(uuid) IS
  'EMAIL-RLS-MAILBOX.1: does the CALLING user hold an email_mailbox_access row for this mailbox. False on NULL (a deleted/unset mailbox is elevated-only, matching loadTicketForUser). SECURITY DEFINER so policies using it do not nest RLS evaluation of email_mailbox_access.';

CREATE OR REPLACE FUNCTION private.auth_has_ticket_mailbox_grant(p_ticket_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.email_tickets t
    JOIN public.email_mailbox_access a ON a.mailbox_id = t.mailbox_id
    WHERE t.id = p_ticket_id
      AND a.profile_id = (SELECT auth.uid())
  )
$$;

COMMENT ON FUNCTION private.auth_has_ticket_mailbox_grant(uuid) IS
  'EMAIL-RLS-MAILBOX.1: does the CALLING user hold a grant on the mailbox of this ticket — the hop email_inbox_messages needs, since messages carry ticket_id, not mailbox_id. False on NULL ticket_id and on NULL-mailbox tickets (elevated-only, matching loadTicketForUser). The inner join is RLS-free (SECURITY DEFINER), so no recursive policy evaluation.';

-- Functions default to EXECUTE for PUBLIC; policies evaluate these as the
-- querying role, so only `authenticated` needs them. anon reaches none of
-- these tables (mig 485's _deny_anon backstops) and gets no grant here.
REVOKE ALL ON FUNCTION private.auth_has_mailbox_grant(uuid)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.auth_has_ticket_mailbox_grant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.auth_has_mailbox_grant(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION private.auth_has_ticket_mailbox_grant(uuid) TO authenticated;

-- ── Policies ────────────────────────────────────────────────────────
-- Same names as migs 394/482/485, so the net state stays one permissive
-- SELECT per (table, command). Shape mirrors mig 496: explicit master OR
-- owner-at-location, then the grant tier.

DROP POLICY IF EXISTS email_ticket_select ON public.email_tickets;
CREATE POLICY email_ticket_select ON public.email_tickets
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(email_tickets.location_id)
    OR private.auth_has_mailbox_grant(email_tickets.mailbox_id)
  );

DROP POLICY IF EXISTS email_msg_select ON public.email_inbox_messages;
CREATE POLICY email_msg_select ON public.email_inbox_messages
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(email_inbox_messages.location_id)
    OR private.auth_has_ticket_mailbox_grant(email_inbox_messages.ticket_id)
  );

DROP POLICY IF EXISTS email_attach_select ON public.email_ticket_attachments;
CREATE POLICY email_attach_select ON public.email_ticket_attachments
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(email_ticket_attachments.location_id)
    OR private.auth_has_mailbox_grant(email_ticket_attachments.mailbox_id)
  );

DROP POLICY IF EXISTS email_mailbox_select ON public.email_mailboxes;
CREATE POLICY email_mailbox_select ON public.email_mailboxes
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(email_mailboxes.location_id)
    OR private.auth_has_mailbox_grant(email_mailboxes.id)
  );
