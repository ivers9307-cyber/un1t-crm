-- EMAIL-TICKET.2 — a studio gets ONE inbox holding MANY email accounts.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- ⚠️ DUPLICATE PREFIX, DELIBERATE. There are two 485s:
--   485_email_mailboxes.sql              (this one)
--   485_rls_restrictive_forall_kills_select.sql  (RLS-RESTRICTIVE.1, #1223)
-- Both were authored and applied in parallel; that one merged first. The prefix
-- is kept rather than renumbered because the live schema_migrations row for this
-- file is already named `485_email_mailboxes`, and renaming the file would
-- desync it from the database for purely cosmetic gain. The repo already carries
-- duplicate prefixes (480 twice, plus 284/301/367 on purpose). The two are
-- independent — replay order between them does not matter.
--
-- WHY
-- Mig 394 put a single inbound address on locations.email_inbox_reply_to,
-- uniquely indexed — one mailbox per studio. A studio actually needs several:
-- accounts@, sales@, studio@, potentially on different domains, each visible to
-- different people. accounts@ carries billing correspondence a coach has no
-- business reading; studio@ does not. No configuration of a single column
-- expresses that.
--
-- SCOPE OF A MAILBOX (Richard, 2026-08-06): exactly ONE location. A central
-- org-wide accounts@ was considered and rejected — per-location scoping is what
-- the existing RLS, staff permissions and assertLocationAccess are built on, and
-- breaking that alignment for one mailbox is a large cost for a small
-- convenience.
--
-- ACCESS MODEL: two levels, mirroring approvals_inbox + approvals_* (mig 378).
--   • the `email_inbox` feature permission gates the surface
--   • a row in email_mailbox_access gates each individual account
-- Approval categories are static permission keys; mailboxes are rows, so the
-- per-account half has to be a table rather than more keys.
-- Master and owner-at-location are implicitly elevated and need no rows.
--
-- NOTHING READS THIS YET. The webhook and UI cut over in later PRs.

-- ── Mailboxes ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_mailboxes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  address     text NOT NULL,
  label       text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_mailboxes_address_shape
    CHECK (address ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT email_mailboxes_label_len CHECK (length(btrim(label)) BETWEEN 1 AND 40)
);

COMMENT ON TABLE public.email_mailboxes IS
  'EMAIL-TICKET.2: one row per inbound email account. Replaces the single locations.email_inbox_reply_to column. Many per location, exactly one location per mailbox.';
COMMENT ON COLUMN public.email_mailboxes.is_default IS
  'EMAIL-TICKET.2: the address stamped as Reply-To on campaign + marketing sends, and the first tab in the inbox. At most one per location.';
COMMENT ON COLUMN public.email_mailboxes.active IS
  'EMAIL-TICKET.2: false = stops accepting inbound (mail to it dead-letters) and hides the tab from everyone including owners. Rows are kept, not deleted, so historic tickets keep their provenance.';

-- An address resolves to exactly one mailbox, estate-wide, so inbound routing
-- is never ambiguous. Case-insensitive because mail addresses are.
CREATE UNIQUE INDEX IF NOT EXISTS email_mailboxes_address_uidx
  ON public.email_mailboxes (lower(address));

-- At most one default per location.
CREATE UNIQUE INDEX IF NOT EXISTS email_mailboxes_one_default_uidx
  ON public.email_mailboxes (location_id) WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_email_mailboxes_location
  ON public.email_mailboxes (location_id, active);

-- ── Per-account access grants ───────────────────────────────────────
-- Master and owner-at-location are elevated in app code and need no row here;
-- this table is for granting a specific person a specific account.
CREATE TABLE IF NOT EXISTS public.email_mailbox_access (
  mailbox_id uuid NOT NULL REFERENCES public.email_mailboxes(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id)        ON DELETE CASCADE,
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, profile_id)
);

COMMENT ON TABLE public.email_mailbox_access IS
  'EMAIL-TICKET.2: who may see which email account. The email_inbox permission gates the surface; a row here gates one account within it. Master + owner-at-location are elevated in app code and need no rows.';

-- The PK covers (mailbox_id, …); these cover the other directions — "which
-- mailboxes may THIS person see" is the query the inbox actually asks.
CREATE INDEX IF NOT EXISTS idx_email_mailbox_access_profile
  ON public.email_mailbox_access (profile_id);
CREATE INDEX IF NOT EXISTS idx_email_mailbox_access_granted_by
  ON public.email_mailbox_access (granted_by);

-- ── Tickets remember which account they arrived at ──────────────────
ALTER TABLE public.email_tickets
  ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES public.email_mailboxes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_tickets.mailbox_id IS
  'EMAIL-TICKET.2: the account this ticket arrived at. Replies go back out from the same address — without it a member who wrote to accounts@ could be answered from sales@. ON DELETE SET NULL so removing a mailbox never deletes correspondence.';

CREATE INDEX IF NOT EXISTS idx_email_tickets_mailbox
  ON public.email_tickets (mailbox_id, status, last_message_at DESC);

-- ── Backfill from the column being replaced ─────────────────────────
-- Label 'Studio' rather than guessing from the local part: the two live
-- addresses are stillorgan@ and accounts@, which would produce inconsistent
-- labels. An operator renames them in one click; a wrong guess looks like a bug.
INSERT INTO public.email_mailboxes (location_id, address, label, is_default, active)
SELECT l.id, l.email_inbox_reply_to, 'Studio', true, true
  FROM public.locations l
 WHERE l.email_inbox_reply_to IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.email_mailboxes m
      WHERE lower(m.address) = lower(l.email_inbox_reply_to)
   );

COMMENT ON COLUMN public.locations.email_inbox_reply_to IS
  'DEPRECATED (mig 485) — superseded by email_mailboxes, which allows several accounts per studio. Retained read-only for one release so a rollback needs no DB action; the webhook still reads it until the Plan 3 cutover. Dropped in a later migration.';

-- ── RLS ─────────────────────────────────────────────────────────────
-- Per-command restrictive deny-writes, NOT `FOR ALL`. Mig 483 fixed exactly
-- this: `AS RESTRICTIVE FOR ALL ... USING (false)` also blocks SELECT, because
-- RLS is (OR of permissive) AND (AND of restrictive) and FOR ALL includes
-- SELECT. That silently killed reads and realtime on the tables mig 482
-- created. Do not reintroduce it here.
ALTER TABLE public.email_mailboxes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_mailbox_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_mailbox_select ON public.email_mailboxes;
CREATE POLICY email_mailbox_select ON public.email_mailboxes
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_mailboxes.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_mailbox_deny_insert ON public.email_mailboxes;
CREATE POLICY email_mailbox_deny_insert ON public.email_mailboxes
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
DROP POLICY IF EXISTS email_mailbox_deny_update ON public.email_mailboxes;
CREATE POLICY email_mailbox_deny_update ON public.email_mailboxes
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS email_mailbox_deny_delete ON public.email_mailboxes;
CREATE POLICY email_mailbox_deny_delete ON public.email_mailboxes
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

-- Grants are readable by the grantee (so the UI can ask "what may I see") and
-- by master + owner-at-location (so the grant editor can list them).
DROP POLICY IF EXISTS email_mailbox_access_select ON public.email_mailbox_access;
CREATE POLICY email_mailbox_access_select ON public.email_mailbox_access
  FOR SELECT TO authenticated
  USING (
    profile_id = (SELECT auth.uid())
    OR private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.email_mailboxes m
               WHERE m.id = email_mailbox_access.mailbox_id
                 AND private.auth_is_owner_at(m.location_id))
  );

DROP POLICY IF EXISTS email_mailbox_access_deny_insert ON public.email_mailbox_access;
CREATE POLICY email_mailbox_access_deny_insert ON public.email_mailbox_access
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
DROP POLICY IF EXISTS email_mailbox_access_deny_update ON public.email_mailbox_access;
CREATE POLICY email_mailbox_access_deny_update ON public.email_mailbox_access
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS email_mailbox_access_deny_delete ON public.email_mailbox_access;
CREATE POLICY email_mailbox_access_deny_delete ON public.email_mailbox_access
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

ALTER PUBLICATION supabase_realtime ADD TABLE public.email_mailboxes;
