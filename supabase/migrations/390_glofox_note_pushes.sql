-- 390 — GLOFOX-NOTES: outbound push ledger.
--
-- One row per CRM note / call-email touchpoint we pushed to Glofox as an
-- interaction. The Glofox create call returns no id, so glofox_interaction_id
-- is filled LATER by the inbound sync (syncGlofoxInteractions) when it sees
-- the echo and claims it — the ledger is how we recognise our own pushes and
-- suppress the duplicate. status tracks the push lifecycle for debugging.
CREATE TABLE glofox_note_pushes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id             uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  location_id            uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  glofox_member_id       text NOT NULL,
  -- Where the pushed content came from (for audit + de-dup of re-pushes).
  source_table           text NOT NULL CHECK (source_table IN ('notes', 'activities')),
  source_id              uuid NOT NULL,
  -- The Glofox interaction type we sent + the EXACT description string sent
  -- (author-prefixed, <=500). The echo matcher fingerprints on these.
  type                   text NOT NULL CHECK (type IN ('NOTE', 'MANUAL_EMAIL')),
  description            text NOT NULL,
  truncated              boolean NOT NULL DEFAULT false,
  pushed_at              timestamptz NOT NULL DEFAULT now(),
  -- Filled on reconcile: the Glofox _id of the echo we claimed. NULL until
  -- the inbound sync sees it.
  glofox_interaction_id  text,
  status                 text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'reconciled'))
);

-- One push per source row — creating a note pushes exactly once (fire-and-forget
-- on CREATE; edits don't re-push). Guards an accidental double-enqueue.
CREATE UNIQUE INDEX uq_glofox_note_pushes_source ON glofox_note_pushes (source_table, source_id);
-- Fast unreconciled-echo lookup during inbound sync (per contact).
CREATE INDEX idx_glofox_note_pushes_contact_unreconciled
  ON glofox_note_pushes (contact_id) WHERE glofox_interaction_id IS NULL;
-- A claimed Glofox id is ours — inbound skips it on every later run.
CREATE UNIQUE INDEX uq_glofox_note_pushes_interaction
  ON glofox_note_pushes (glofox_interaction_id) WHERE glofox_interaction_id IS NOT NULL;

ALTER TABLE glofox_note_pushes ENABLE ROW LEVEL SECURITY;
-- Service-role only (all sync + note routes use createServerClient, which
-- bypasses RLS). No authenticated/anon grant → RLS-enabled-no-policy is
-- intentional (matches other sync-internal tables, e.g. glofox_sync_runs).
