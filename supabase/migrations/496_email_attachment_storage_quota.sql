-- EMAIL-ATTACH.1 — inbound attachments are actually stored, and mailbox
-- storage is metered against Richard's 5 GB-per-mailbox ceiling.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md ("Storage quota")
--
-- WHAT WAS ACTUALLY TRUE BEFORE THIS
-- Mig 482 created email_ticket_attachments and the private `email-attachments`
-- bucket, and mig 483 made its RLS work. Both shipped INERT: the table has zero
-- rows and nothing in the codebase writes it. The Postmark inbound webhook never
-- looked at the `Attachments` array at all, so every file a member has ever sent
-- us was discarded on arrival, silently. Metering storage without storing
-- anything would have metered nothing, so both halves land together.
--
-- ── 1. The mailbox a stored file belongs to ─────────────────────────
-- email_ticket_attachments carries location_id, not mailbox_id, and the quota
-- is PER MAILBOX. Reaching the mailbox meant message → ticket → mailbox_id: a
-- two-hop join on every write, every prune and every reconcile, through
-- PostgREST's nested-embed filtering, which this repo has been bitten by before.
-- Denormalising the mailbox onto the attachment (the contacts.pipeline_stage_slug
-- precedent) makes the write path, the counter key and the prune filter one
-- column lookup each.
--
-- ON DELETE SET NULL matches email_tickets.mailbox_id exactly: deleting a
-- mailbox must never delete correspondence, and the attachment then falls into
-- the same "unfiled" state its ticket does.
--
-- ── 2. attachment_index — what makes the accounting idempotent ──────
-- The inbound webhook releases its dedupe claim on any 5xx (EMAIL-DEDUPE-RELEASE.1)
-- precisely so Postmark's retry re-processes the message. That is the right
-- trade for not losing mail, but it means "this payload may be processed twice"
-- is a designed-in property, not a hypothetical — and bytes counted twice would
-- shrink a mailbox's usable quota permanently, with no way for an operator to
-- tell why.
--
-- attachment_index is the attachment's position in Postmark's own `Attachments`
-- array. It is derived from the payload, so it is IDENTICAL on every retry, and
-- UNIQUE (message_id, attachment_index) therefore makes "record this attachment"
-- an operation that can only succeed once. The writer treats 23505 here as
-- "someone already accounted for this" and gives its reservation back.
--
-- ── 3. 'pruned' joins the skipped_reason vocabulary ─────────────────
-- Mig 482's XOR constraint says every row is either stored or explains why not.
-- Reclaiming space has to leave the row (a file vanishing from a thread with no
-- explanation is the silent-drop failure the XOR exists to prevent), so the
-- pruned row needs an honest reason. Reusing 'quota' would tell staff the file
-- was never stored, which is false — it was stored, read, and then deliberately
-- removed by an operator.
--
-- ── 4. email_storage_usage — a counter, never a SUM at write time ───
-- Per mig 314: read-modify-write from JS loses increments under concurrent
-- writers, and two attachments arriving on one mailbox at once is the ordinary
-- case, not the exotic one.
--
-- WHERE THIS DIVERGES FROM THE SPEC, AND WHY. The spec keys the table
-- `mailbox_id uuid PRIMARY KEY`. That has no answer for a ticket whose mailbox
-- is NULL — which is reachable, because email_tickets.mailbox_id is ON DELETE
-- SET NULL. Under the spec's shape those bytes would either escape accounting
-- entirely or blow up a NOT NULL on the write path.
--
-- So the key is (location_id, mailbox_id) with mailbox_id NULLABLE, declared
-- UNIQUE NULLS NOT DISTINCT (PG 15+; this project is on 17.6) so the NULL row
-- is a real, single, upsertable row rather than an unbounded set of them. A
-- NULL mailbox_id is the location's UNFILED bucket: it carries the same 5 GB
-- ceiling, it is visible to exactly the people who can see unfiled tickets
-- (master/owner — loadTicketForUser makes NULL-mailbox tickets elevated-only),
-- and it can be pruned like any other. Nothing escapes accounting, nothing
-- crashes, and a deleted mailbox cannot be used as a quota bypass.
--
-- bytes_used counts STORED ATTACHMENT BYTES ONLY. The spec also wanted
-- text_body + html_body lengths in the figure; deliberately not done, because
-- the same spec forbids ever pruning bodies ("they are cheap and they are the
-- record"). Metering something no release valve can reclaim is how a full
-- mailbox becomes a permanently full one.
--
-- quota_bytes stays per-row and overridable, as the spec asked, so it can hang
-- off a plan tier later without another migration.

-- ── 1. Mailbox on the attachment ────────────────────────────────────
ALTER TABLE public.email_ticket_attachments
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.email_mailboxes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_ticket_attachments.mailbox_id IS
  'EMAIL-ATTACH.1: the mailbox whose 5 GB quota these bytes are metered against, denormalised from the ticket (message → ticket → mailbox_id) so the counter key, the prune filter and the reconcile are one column each. ON DELETE SET NULL mirrors email_tickets.mailbox_id — the bytes then meter against the location''s unfiled bucket (email_storage_usage row with mailbox_id NULL).';

-- The prune and reconcile paths both ask "everything stored for this bucket",
-- and the unfiled bucket is a NULL scan, so location leads the index.
CREATE INDEX IF NOT EXISTS idx_email_attach_mailbox_created
  ON public.email_ticket_attachments (location_id, mailbox_id, created_at);

-- ── 2. Idempotency key ──────────────────────────────────────────────
ALTER TABLE public.email_ticket_attachments
  ADD COLUMN IF NOT EXISTS attachment_index integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.email_ticket_attachments.attachment_index IS
  'EMAIL-ATTACH.1: position in Postmark''s inbound Attachments array. Derived from the payload, so a re-processed delivery produces the SAME value — UNIQUE (message_id, attachment_index) is what makes storage accounting idempotent across the dedupe-claim release (EMAIL-DEDUPE-RELEASE.1). A 23505 here means "already accounted for"; the writer hands its byte reservation back rather than counting twice.';

ALTER TABLE public.email_ticket_attachments
  DROP CONSTRAINT IF EXISTS email_attach_index_nonneg;
ALTER TABLE public.email_ticket_attachments
  ADD CONSTRAINT email_attach_index_nonneg CHECK (attachment_index >= 0);

-- The table is empty in production (verified 2026-08-07), so this needs no
-- backfill and cannot collide with existing rows.
CREATE UNIQUE INDEX IF NOT EXISTS email_attach_message_index_uidx
  ON public.email_ticket_attachments (message_id, attachment_index);

-- ── 3. 'pruned' as a skipped_reason ─────────────────────────────────
-- The constraint mig 482 wrote was an unnamed column CHECK, so Postgres named
-- it <table>_<column>_check. Name confirmed against the live database before
-- writing this, rather than assumed — a DROP ... IF EXISTS that matched nothing
-- would leave the old constraint in force and 23514 every prune.
ALTER TABLE public.email_ticket_attachments
  DROP CONSTRAINT IF EXISTS email_ticket_attachments_skipped_reason_check;
ALTER TABLE public.email_ticket_attachments
  DROP CONSTRAINT IF EXISTS email_attach_skipped_reason_known;

ALTER TABLE public.email_ticket_attachments
  ADD CONSTRAINT email_attach_skipped_reason_known
    CHECK (skipped_reason IN ('quota','too_large','too_many','rehost_failed','pruned'));

COMMENT ON COLUMN public.email_ticket_attachments.skipped_reason IS
  'EMAIL-ATTACH.1: why the bytes are not in the bucket. quota = the mailbox was full on arrival; too_large = over the per-file ceiling; too_many = past the per-message attachment cap; rehost_failed = upload or insert error; pruned = stored, then deliberately reclaimed by an operator. The row ALWAYS survives — staff must be able to see that a file existed and ask for a resend. too_many is its own value rather than folded into too_large because staff act on this text: "over the size limit" would send them asking the member to compress a file that was never oversized.';

-- ── 4. The counter ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_storage_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id)       ON DELETE CASCADE,
  -- NULL = this location's UNFILED bucket (attachments whose mailbox row is
  -- gone). CASCADE, not SET NULL: SET NULL would try to fold a deleted
  -- mailbox's counter onto the unfiled row and collide with it.
  mailbox_id  uuid          REFERENCES public.email_mailboxes(id) ON DELETE CASCADE,
  bytes_used  bigint NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  quota_bytes bigint NOT NULL DEFAULT 5368709120 CHECK (quota_bytes > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_storage_usage_scope_uniq
    UNIQUE NULLS NOT DISTINCT (location_id, mailbox_id)
);

COMMENT ON TABLE public.email_storage_usage IS
  'EMAIL-ATTACH.1: stored-attachment bytes per mailbox, 5 GiB default ceiling (Richard, 2026-08-05). One row per (location, mailbox); mailbox_id NULL is the location''s unfiled bucket for attachments orphaned by a deleted mailbox. Written ONLY through add_email_storage_bytes() — a JS read-modify-write loses increments when two attachments land at once.';
COMMENT ON COLUMN public.email_storage_usage.bytes_used IS
  'EMAIL-ATTACH.1: STORED attachment bytes only. Message bodies are deliberately NOT counted — the spec forbids ever pruning them, and metering what no release valve can reclaim turns a full mailbox into a permanently full one.';
COMMENT ON COLUMN public.email_storage_usage.quota_bytes IS
  'EMAIL-ATTACH.1: per-row so a plan tier can raise one mailbox later without a migration. 5368709120 = 5 GiB.';

-- location_id needs NO index of its own: it is the leading column of
-- email_storage_usage_scope_uniq, which covers both the FK and the
-- "everything at this location" read. mailbox_id does need one — it is an
-- unindexed FK otherwise, the class get_advisors(type=performance) flags and
-- the class mig 483 had to come back and fix on this very family of tables.
CREATE INDEX IF NOT EXISTS idx_email_storage_usage_mailbox
  ON public.email_storage_usage (mailbox_id);

-- ── RLS ─────────────────────────────────────────────────────────────
-- Per-command restrictive deny-writes, NEVER `AS RESTRICTIVE FOR ALL` — that
-- pattern folds the permissive SELECT away and kills reads silently (mig 483,
-- mig 485; check:rls-restrictive gates it).
--
-- SELECT is master-or-owner-at-location, NOT every staff member at the
-- location: the operator surface that shows these figures is already gated on
-- guardMailboxAdmin (master/owner), and a coach who cannot manage mailboxes has
-- no reason to read their fill level. Same population as email_mailbox_access's
-- management half.
ALTER TABLE public.email_storage_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_storage_usage_select ON public.email_storage_usage;
CREATE POLICY email_storage_usage_select ON public.email_storage_usage
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR private.auth_is_owner_at(email_storage_usage.location_id)
  );

DROP POLICY IF EXISTS email_storage_usage_deny_insert ON public.email_storage_usage;
CREATE POLICY email_storage_usage_deny_insert ON public.email_storage_usage
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
DROP POLICY IF EXISTS email_storage_usage_deny_update ON public.email_storage_usage;
CREATE POLICY email_storage_usage_deny_update ON public.email_storage_usage
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS email_storage_usage_deny_delete ON public.email_storage_usage;
CREATE POLICY email_storage_usage_deny_delete ON public.email_storage_usage
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- ── Atomic counter (the mig 314 family) ─────────────────────────────
-- INSERT … ON CONFLICT DO UPDATE, so the row is created on first use and every
-- subsequent write takes the row lock: two concurrent attachments on one
-- mailbox serialise and neither loses the other's bytes. Returns the NEW total
-- so the caller can decide the quota question from a value it knows is post-
-- increment — a separate read would race exactly the way the counter exists to
-- prevent.
--
-- Clamped at zero on both ends: a release for bytes that were never counted
-- (a retried prune, a rolled-back reservation) must not drive the counter
-- negative, because a negative counter reads as free space that does not exist.
CREATE OR REPLACE FUNCTION public.add_email_storage_bytes(
  p_location_id uuid,
  p_mailbox_id  uuid,
  p_delta       bigint
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_bytes bigint;
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'add_email_storage_bytes: p_location_id is required';
  END IF;

  INSERT INTO public.email_storage_usage (location_id, mailbox_id, bytes_used, updated_at)
  VALUES (p_location_id, p_mailbox_id, greatest(coalesce(p_delta, 0), 0), now())
  ON CONFLICT (location_id, mailbox_id) DO UPDATE
    SET bytes_used = greatest(public.email_storage_usage.bytes_used + coalesce(p_delta, 0), 0),
        updated_at = now()
  RETURNING bytes_used INTO v_bytes;

  RETURN v_bytes;
END
$$;

COMMENT ON FUNCTION public.add_email_storage_bytes(uuid, uuid, bigint) IS
  'EMAIL-ATTACH.1: the ONLY write path for email_storage_usage.bytes_used. Returns the new total so the caller judges the quota post-increment (reserve-then-check), never from a racing read. p_mailbox_id NULL addresses the location''s unfiled bucket. Clamps at 0.';

-- ── Reconcile ───────────────────────────────────────────────────────
-- Counters drift: a process killed between "reserve" and "insert the row", a
-- prune whose decrement failed after its rows were updated, or a mailbox
-- hard-deleted in SQL (which CASCADEs its counter away while its attachments
-- survive with mailbox_id NULL). This re-derives every bucket at one location
-- from the attachment rows themselves.
--
-- Deliberately NOT on the write path — this is the SUM the counter exists to
-- avoid. It is an operator action (and the repair the drift cases need), not
-- something an inbound email ever triggers.
CREATE OR REPLACE FUNCTION public.recalc_email_storage_usage(p_location_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'recalc_email_storage_usage: p_location_id is required';
  END IF;

  -- Existing counters first, so a bucket whose every attachment has been
  -- pruned is driven to 0 rather than left at its old figure.
  UPDATE public.email_storage_usage u
     SET bytes_used = coalesce((
           SELECT sum(a.size_bytes)::bigint
             FROM public.email_ticket_attachments a
            WHERE a.location_id = p_location_id
              AND a.storage_path IS NOT NULL
              AND a.mailbox_id IS NOT DISTINCT FROM u.mailbox_id
         ), 0),
         updated_at = now()
   WHERE u.location_id = p_location_id;

  -- Then any bucket that holds bytes but has no counter row yet.
  INSERT INTO public.email_storage_usage (location_id, mailbox_id, bytes_used, updated_at)
  SELECT p_location_id, a.mailbox_id, sum(a.size_bytes)::bigint, now()
    FROM public.email_ticket_attachments a
   WHERE a.location_id = p_location_id
     AND a.storage_path IS NOT NULL
   GROUP BY a.mailbox_id
  ON CONFLICT (location_id, mailbox_id) DO UPDATE
    SET bytes_used = excluded.bytes_used,
        updated_at = now();
END
$$;

COMMENT ON FUNCTION public.recalc_email_storage_usage(uuid) IS
  'EMAIL-ATTACH.1: re-derive every storage counter at one location from email_ticket_attachments. Operator-invoked repair for counter drift; never called on the write path (it is the SUM the counter exists to avoid).';

-- Both are SECURITY INVOKER (the default), and every caller is a service-role
-- route. RLS would already refuse an `authenticated` caller's write through the
-- deny-write policies above, but EXECUTE is withdrawn as well so the failure is
-- "you may not call this" rather than a silent no-op. Mig 310/420 posture.
REVOKE ALL ON FUNCTION public.add_email_storage_bytes(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalc_email_storage_usage(uuid)            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_email_storage_bytes(uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.recalc_email_storage_usage(uuid)            TO service_role;
