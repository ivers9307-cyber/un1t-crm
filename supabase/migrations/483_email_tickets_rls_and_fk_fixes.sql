-- EMAIL-TICKET.1 — corrections to mig 482, found by review before anything
-- read the new tables. Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- Three defects, all confirmed against the live database:
--
-- 1. THE RESTRICTIVE `FOR ALL` DENY-WRITES ALSO KILLED SELECT.
--    Postgres evaluates RLS as (OR of permissive) AND (AND of restrictive), and
--    `FOR ALL` includes SELECT — so `AS RESTRICTIVE FOR ALL ... USING (false)`
--    folded the permissive SELECT policy away entirely. Proven:
--
--      BEGIN; SET LOCAL role authenticated;
--      EXPLAIN (COSTS OFF) SELECT * FROM public.email_tickets;
--      -->  Result
--      -->    One-Time Filter: false
--
--    Consequence: mig 482's own `ALTER PUBLICATION supabase_realtime ADD TABLE`
--    was inert. Realtime authorises each row through the subscriber's SELECT
--    policy, so no authenticated subscriber could ever receive an event — the
--    tickets UI would have inherited a feed that never fires, and any
--    browser-side read would return an EMPTY SET rather than an error, which is
--    the silent-wrong-answer shape.
--
--    The fix keeps the backstop but scopes it per command. The write denial is
--    strictly redundant today (no permissive INSERT/UPDATE/DELETE policy exists,
--    so writes are default-denied), but it is retained deliberately: it is what
--    stops a future carelessly-added permissive write policy from opening client
--    writes on a table whose every writer is meant to be a service-role route.
--
--    NOTE: this pattern is inherited from mig 394 and is shared by ~19 tables
--    estate-wide, including email_conversations and instagram_conversations.
--    Fixing those is deliberately OUT OF SCOPE here — it is tracked separately.
--    This migration corrects only the two tables mig 482 created.
--
-- 2. email_inbox_messages.conversation_id WAS STILL NOT NULL.
--    Mig 482 said the column was "retained through the transition" per the
--    deprecated-columns-stay-on-disk convention, but that convention only works
--    if code can stop WRITING the column. It could not: a ticket-only insert
--    would have died on a not-null violation, forcing the webhook to keep
--    minting email_conversations rows — which are still governed by the UNIQUE
--    idx_email_conv_location_counterpart, i.e. exactly the immortal-thread
--    machinery this whole design exists to remove. A member's second concurrent
--    ticket would have collided on the conversation row.
--
-- 3. UNINDEXED FOREIGN KEY on email_ticket_attachments.location_id.
--    get_advisors(type=performance) flags it, and it is the column both the
--    table's own RLS policy and every app-side location filter key on. Same
--    class as migs 108, 203 and 434. (Mig 482's commit message claimed the
--    advisors named neither new table; that was checked against the SECURITY
--    advisor only, and was wrong for the PERFORMANCE one.)
--
-- Also hardens the attachment columns against hostile input, matching mig 213's
-- posture: filename, mime_type and size_bytes come straight from an
-- unauthenticated stranger's Postmark payload and were unbounded.
--
-- Still nothing reads these tables. All three tables are empty in production.

-- ── 1. Per-command deny-writes, so SELECT survives ──────────────────
DROP POLICY IF EXISTS email_ticket_deny_writes ON public.email_tickets;

CREATE POLICY email_ticket_deny_insert ON public.email_tickets
  AS RESTRICTIVE FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY email_ticket_deny_update ON public.email_tickets
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY email_ticket_deny_delete ON public.email_tickets
  AS RESTRICTIVE FOR DELETE TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS email_attach_deny_writes ON public.email_ticket_attachments;

CREATE POLICY email_attach_deny_insert ON public.email_ticket_attachments
  AS RESTRICTIVE FOR INSERT TO authenticated, anon
  WITH CHECK (false);

CREATE POLICY email_attach_deny_update ON public.email_ticket_attachments
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon
  USING (false) WITH CHECK (false);

CREATE POLICY email_attach_deny_delete ON public.email_ticket_attachments
  AS RESTRICTIVE FOR DELETE TO authenticated, anon
  USING (false);

-- ── 2. Let a message belong to a ticket and no conversation ─────────
ALTER TABLE public.email_inbox_messages
  ALTER COLUMN conversation_id DROP NOT NULL;

COMMENT ON COLUMN public.email_inbox_messages.conversation_id IS
  'DEPRECATED (mig 483) — superseded by ticket_id. Nullable so a ticket-only message can be written without minting an email_conversations row (which would collide on the UNIQUE idx_email_conv_location_counterpart and resurrect the immortal-thread model). Dropped with email_conversations in a later migration.';

-- ── 3. Cover the FK the advisor flagged ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_email_attach_location
  ON public.email_ticket_attachments (location_id);

-- ── Hostile-input guards (mig 213's posture) ────────────────────────
ALTER TABLE public.email_ticket_attachments
  ADD CONSTRAINT email_attach_size_positive CHECK (size_bytes > 0),
  ADD CONSTRAINT email_attach_mime_len      CHECK (length(mime_type) <= 100),
  ADD CONSTRAINT email_attach_filename_len  CHECK (length(filename) <= 255);
