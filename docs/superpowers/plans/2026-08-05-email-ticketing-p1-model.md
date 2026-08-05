# Email Ticketing — Plan 1: Ticket model, helpers, backfill

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `email_tickets` data model, a unit-tested identity resolver, and a 1:1 backfill from the existing conversations — with zero behaviour change, because nothing reads the new tables yet.

**Architecture:** Two new tables plus additive columns on `email_inbox_messages`, with RLS copied exactly from mig 394 (`private.auth_is_master()` OR a `profile_locations` match, `auth.uid()` wrapped per the initplan advisor, restrictive deny-writes). The ticket identity rules live in a new pure module `src/lib/email-tickets.js` — no DB, no env, same posture as the existing `email-inbox.js`, so they are fully testable before any route depends on them. The backfill is plain SQL that reuses each conversation's UUID as its ticket's UUID, which makes it idempotent and sidesteps the 1,000-row select cap entirely.

**Tech Stack:** Supabase Postgres (migrations applied via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj`), supabase-js service role, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-email-ticketing-design.md`

**Plan 1 of 5.** Later plans: 2 — webhook + send cutover; 3 — quota accounting; 4 — HTML rendering; 5 — tickets UI and removing email from the unified inbox.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/482_email_tickets.sql` (create) | Tables, columns, indexes, RLS, realtime, storage bucket |
| `supabase/migrations/483_email_tickets_rls_and_fk_fixes.sql` (create) | **Added during execution** — corrects three defects review found in 482 |
| `supabase/migrations/484_email_tickets_backfill.sql` (create) | Idempotent 1:1 conversation → ticket backfill |
| `src/lib/email-tickets.js` (create) | Pure ticket identity + lifecycle rules. No DB, no env |
| `src/lib/email-tickets.test.js` (create) | Vitest unit tests for the above |
| `src/lib/enums.js` (modify) | Mirror the new status/priority CHECK lists, per that file's convention |
| `src/lib/enums.test.js` (modify) | Register the new enum sets in the existing guard test |

`src/lib/email-inbox.js` is **not** modified in this plan. Its threading helpers (`extractCandidateMessageIds`, `matchLocationByRecipient`) are reused as-is by Plan 2.

---

## Task 1: Branch and confirm the migration number

**Files:** none (setup only)

- [ ] **Step 1: Branch off fresh `origin/main`**

The local checkout does not reliably hold `main`. Always fetch first.

```bash
cd ~/code/un1t-crm && git fetch origin main && git checkout -b email-tickets-p1-model origin/main
```

- [ ] **Step 2: Confirm the next free migration number**

Local files stop at 478, but 479 (`ccfautos`) and 480 (studio KPI scorecard) were applied via MCP. Confirm against the live project rather than the filesystem.

Use the Supabase MCP tool `list_migrations` against project `iyvtbjjxdggiadzwwvdj`.

**Resolved 2026-08-05:** `list_migrations` shows the highest numeric prefix live
is **481** (`481_hr_session_share_token_expiry`, applied 2026-08-04), and 480 is
already doubled up (`480_prune_hr_detections_heartbeat` and
`480_membership_transitions_price`). This plan therefore uses **482** and
**484**, which is what every later task already says. Do not renumber again.

---

## Task 2: Pure ticket identity helpers

**Files:**
- Create: `src/lib/email-tickets.js`
- Test: `src/lib/email-tickets.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/email-tickets.test.js`:

```js
// Tests for the pure ticket identity + lifecycle rules.
// No DB, no env — every function here is a pure decision function so the
// webhook can be reasoned about without a database.

import { describe, it, expect } from 'vitest'
import {
  resolveTicketAction,
  shouldStampFirstResponse,
  ticketSubject,
  ticketsDueForAutoClose,
  DEFAULT_AUTO_CLOSE_DAYS,
} from './email-tickets'

describe('resolveTicketAction', () => {
  it('creates a fresh ticket when nothing threaded', () => {
    expect(resolveTicketAction(null)).toEqual({ action: 'create', reopenedFrom: null })
  })

  it('creates a fresh ticket when the threaded row has no id', () => {
    expect(resolveTicketAction({ status: 'open' })).toEqual({ action: 'create', reopenedFrom: null })
  })

  it('appends to an open ticket without reopening it', () => {
    expect(resolveTicketAction({ id: 't1', status: 'open' }))
      .toEqual({ action: 'append', ticketId: 't1', reopen: false })
  })

  it('appends to a pending ticket and reopens it', () => {
    expect(resolveTicketAction({ id: 't2', status: 'pending' }))
      .toEqual({ action: 'append', ticketId: 't2', reopen: true })
  })

  it('appends to a solved ticket and reopens it', () => {
    expect(resolveTicketAction({ id: 't3', status: 'solved' }))
      .toEqual({ action: 'append', ticketId: 't3', reopen: true })
  })

  it('mints a NEW ticket when the thread resolves to a closed one', () => {
    expect(resolveTicketAction({ id: 't4', status: 'closed' }))
      .toEqual({ action: 'create', reopenedFrom: 't4' })
  })
})

describe('shouldStampFirstResponse', () => {
  it('stamps on the first outbound reply', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'outbound', isInternalNote: false,
    })).toBe(true)
  })

  it('does not stamp twice', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: '2026-08-05T10:00:00Z', direction: 'outbound', isInternalNote: false,
    })).toBe(false)
  })

  it('does not stamp on inbound', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'inbound', isInternalNote: false,
    })).toBe(false)
  })

  it('does not stamp on an internal note — the member never saw it', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'outbound', isInternalNote: true,
    })).toBe(false)
  })
})

describe('ticketSubject', () => {
  it('takes the inbound subject for a new ticket', () => {
    expect(ticketSubject(null, 'Billing question')).toBe('Billing question')
  })

  it('KEEPS the original subject on an existing ticket', () => {
    // Deliberately unlike mig 394, where subject tracked the most recent inbound.
    // A ticket is named by the issue that opened it.
    expect(ticketSubject('Billing question', 'Re: Billing question')).toBe('Billing question')
  })

  it('falls back for an empty inbound subject', () => {
    expect(ticketSubject(null, '   ')).toBe('(no subject)')
    expect(ticketSubject(null, null)).toBe('(no subject)')
  })
})

describe('ticketsDueForAutoClose', () => {
  const now = Date.parse('2026-08-05T12:00:00Z')

  it('closes a solved ticket past the window', () => {
    const t = { id: 'a', status: 'solved', solved_at: '2026-07-20T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], 7, now)).toEqual([t])
  })

  it('leaves a solved ticket inside the window', () => {
    const t = { id: 'b', status: 'solved', solved_at: '2026-08-04T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], 7, now)).toEqual([])
  })

  it('ignores tickets that are not solved', () => {
    const t = { id: 'c', status: 'open', solved_at: '2026-07-01T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], 7, now)).toEqual([])
  })

  it('ignores a solved ticket with no solved_at', () => {
    expect(ticketsDueForAutoClose([{ id: 'd', status: 'solved', solved_at: null }], 7, now)).toEqual([])
  })

  it('returns nothing for a nonsense window rather than closing everything', () => {
    const t = { id: 'e', status: 'solved', solved_at: '2026-01-01T12:00:00Z' }
    expect(ticketsDueForAutoClose([t], -1, now)).toEqual([])
    expect(ticketsDueForAutoClose([t], 'soon', now)).toEqual([])
    // Number() maps all of these to 0, which is finite and non-negative — so a
    // Number()-based guard lets them through and mass-closes the queue. null is
    // what an unset settings column returns and '' is what an empty form field
    // posts, so these are the expected shapes, not exotic ones.
    expect(ticketsDueForAutoClose([t], null, now)).toEqual([])
    expect(ticketsDueForAutoClose([t], '', now)).toEqual([])
    expect(ticketsDueForAutoClose([t], false, now)).toEqual([])
    expect(ticketsDueForAutoClose([t], [], now)).toEqual([])
  })

  it('honours an explicit numeric 0 as close-as-soon-as-solved', () => {
    const t = { id: 'f', status: 'solved', solved_at: '2026-08-05T11:00:00Z' }
    expect(ticketsDueForAutoClose([t], 0, now)).toEqual([t])
  })

  it('tolerates a non-array', () => {
    for (const bad of [null, undefined, '', {}, 0]) {
      expect(ticketsDueForAutoClose(bad, 7, now)).toEqual([])
    }
  })

  // NOT `expect(DEFAULT_AUTO_CLOSE_DAYS).toBe(7)` — that asserts a literal
  // equals itself and would not notice the constant ceasing to be the value
  // actually used as a window. Running it through the function ties it to
  // behaviour and pins the `<=` cutoff boundary, which nothing else does.
  it('uses DEFAULT_AUTO_CLOSE_DAYS as a real window, and includes the exact cutoff', () => {
    const dayMs = 86_400_000
    const atCutoff = {
      id: 'g', status: 'solved',
      solved_at: new Date(now - DEFAULT_AUTO_CLOSE_DAYS * dayMs).toISOString(),
    }
    const anHourFresher = {
      id: 'h', status: 'solved',
      solved_at: new Date(now - DEFAULT_AUTO_CLOSE_DAYS * dayMs + 3_600_000).toISOString(),
    }
    expect(ticketsDueForAutoClose([atCutoff, anHourFresher], DEFAULT_AUTO_CLOSE_DAYS, now))
      .toEqual([atCutoff])
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/email-tickets.test.js
```

Expected: FAIL — cannot resolve `./email-tickets`. Relative, not the `@/lib/`
alias: 354 of the repo's 376 lib test files import relatively, including the
sibling `email-inbox.test.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/email-tickets.js`:

```js
// EMAIL-TICKET.1 — pure ticket identity + lifecycle rules for the email
// channel. Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS IS SEPARATE FROM email-inbox.js
// email-inbox.js resolves WHO an email is from and WHICH location it belongs
// to. That logic is unchanged. This module answers the new question mig 394
// could not: WHICH TICKET does this message join, or does it start one?
//
// THE RULE THAT MATTERS
// mig 394 kept one conversation per (location, address) forever, so a member
// with two unrelated questions had one immortal thread. Here a reply to a
// CLOSED ticket mints a NEW ticket rather than resurrecting the old one. That
// single rule is what stops a ticket decaying back into a per-person thread.
//
// Everything here is pure (no DB, no env, no clock) so the webhook's decisions
// are unit-testable; the route owns the queries and passes `now` in.

// The ticket-status enum deliberately does NOT live here. src/lib/enums.js is
// the single source of truth for constants mirroring Postgres CHECK lists, and
// it is updated in the same PR as the constraint — see Task 3.

/** Default window before a solved ticket closes itself. Operator-editable. */
export const DEFAULT_AUTO_CLOSE_DAYS = 7

/**
 * Given the ticket an inbound message threaded to (or null), decide whether
 * to append to it or mint a new one.
 *
 * `reopen` and `reopenedFrom` mean OPPOSITE things:
 *   • append + reopen: true     — THIS ticket goes back to open
 *   • create + reopenedFrom: X  — a NEW ticket; X stays CLOSED, and is merely
 *     its predecessor. Never write status='open' against X.
 *
 * `status` is required, not optional: resolveTicketAction({ id }) alone would
 * report reopen:true for a ticket that may already be open, so a threading
 * query that selects only `id` is a bug the type should refuse.
 *
 * @param {{ id?: string, status: string }|null} threadedTicket
 * @returns {{ action: 'append', ticketId: string, reopen: boolean }
 *          |{ action: 'create', reopenedFrom: string|null }}
 */
export function resolveTicketAction(threadedTicket) {
  if (!threadedTicket || !threadedTicket.id) {
    return { action: 'create', reopenedFrom: null }
  }
  if (threadedTicket.status === 'closed') {
    return { action: 'create', reopenedFrom: threadedTicket.id }
  }
  return {
    action: 'append',
    ticketId: threadedTicket.id,
    reopen: threadedTicket.status !== 'open',
  }
}

// There is deliberately no `statusAfterInbound` helper. resolveTicketAction
// only ever returns `append` for a NOT-closed ticket, so the status after an
// inbound is always 'open' and a function to compute it would have no
// reachable second branch. The caller sets `status: 'open'` directly; the
// `reopen` boolean above carries the genuinely useful bit — whether the status
// actually CHANGED, which is what an audit line wants.

/**
 * First-response time is a support metric, so it counts only a real outbound
 * reply the member could actually receive — never an inbound, never an
 * internal note, and never a second time.
 *
 * @param {{ firstResponseAt: string|null, direction: 'inbound'|'outbound',
 *           isInternalNote: boolean }} args
 * @returns {boolean}
 */
export function shouldStampFirstResponse({ firstResponseAt, direction, isInternalNote }) {
  if (firstResponseAt) return false
  if (direction !== 'outbound') return false
  return !isInternalNote
}

/**
 * A ticket is named by the issue that opened it. Deliberately unlike mig 394,
 * where `subject` tracked the most recent inbound and a thread's name drifted
 * with every "Re: Re: Fwd:".
 */
export function ticketSubject(existingSubject, inboundSubject) {
  if (existingSubject) return existingSubject
  const s = typeof inboundSubject === 'string' ? inboundSubject.trim() : ''
  return s || '(no subject)'
}

/**
 * Solved tickets past the auto-close window. Pure: the caller passes `now` in
 * milliseconds so this is testable without faking a clock.
 *
 * Anything that is not a finite, non-negative NUMBER returns nothing rather
 * than closing the whole queue — a bad settings value must not mass-close live
 * tickets, and `closed` being terminal means a mass-close would fork every
 * in-flight conversation into a new ticket on its next reply.
 *
 * The type check is strict on purpose. `Number(null)`, `Number('')`,
 * `Number(false)` and `Number([])` are all 0 — finite and non-negative — so
 * coercing first would let an unset settings column or an empty form field
 * through as "close everything solved". A string '7' returning [] is a caller
 * bug to fix upstream; failing closed is the safe direction. An explicit
 * numeric 0 stays legal and means "close as soon as solved".
 */
export function ticketsDueForAutoClose(tickets, autoCloseDays, nowMs) {
  if (!Array.isArray(tickets)) return []
  if (typeof autoCloseDays !== 'number' || !Number.isFinite(autoCloseDays) || autoCloseDays < 0) {
    return []
  }
  const cutoff = nowMs - autoCloseDays * 86_400_000
  return tickets.filter((t) => {
    if (t?.status !== 'solved') return false
    const solved = Date.parse(t?.solved_at ?? '')
    return Number.isFinite(solved) && solved <= cutoff
  })
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/email-tickets.test.js
```

Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm && git add src/lib/email-tickets.js src/lib/email-tickets.test.js && git commit -m "EMAIL-TICKET.1 — pure ticket identity + lifecycle rules

Adds src/lib/email-tickets.js: resolveTicketAction, statusAfterInbound,
shouldStampFirstResponse, ticketSubject, ticketsDueForAutoClose. Pure (no DB,
no env, no clock) in the same posture as email-inbox.js, so the webhook's
decisions in Plan 2 are testable before anything reads them.

The load-bearing rule: a reply threading to a CLOSED ticket mints a NEW ticket
rather than reopening it. Without it the model decays back to mig 394's
one-immortal-thread-per-person shape.

Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
Nothing imports this yet — zero behaviour change."
```

---

## Task 3: Migration 482 — schema

**Files:**
- Create: `supabase/migrations/482_email_tickets.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/482_email_tickets.sql`:

```sql
-- EMAIL-TICKET.1 — email becomes a ticketing system.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- WHY
-- Mig 394 modelled email on the Instagram twin: ONE conversation per
-- (location_id, counterpart_email), forever, with a two-state resolved_at.
-- That is right for a chat channel and wrong for support correspondence. A
-- member who emails about billing in January and a class in March lands in
-- the same row, and there is no way to say one is handled and the other is not.
--
-- Mig 213 (`issues`) already had the right lifecycle — open/in_progress/
-- resolved/closed with claim-to-assign and bucket-backed attachments — but its
-- only channel was an in-app form. This marries the two.
--
-- THE DELIBERATE ABSENCE
-- There is NO unique index on (location_id, requester_email). That absence is
-- the whole point: one person may hold many concurrent tickets. Mig 394's
-- idx_email_conv_location_counterpart is what made a conversation immortal.
--
-- SCOPE: email only. whatsapp_conversations and instagram_conversations keep
-- today's resolve model and are not touched by this or any later migration in
-- this program.
--
-- NOTHING READS THESE TABLES YET. The webhook and send routes cut over in a
-- later PR; this migration plus its backfill (484) are inert on their own.

-- ── Tickets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_tickets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id             uuid REFERENCES public.contacts(id) ON DELETE SET NULL,

  -- Reserved for v2 queues (Billing / Memberships / General) + per-queue
  -- grants. Always NULL today. No FK and no table yet, deliberately: the
  -- column exists so adding queues later is additive, the same trick mig 213
  -- used by reserving `closed` up front.
  queue_id               uuid,

  requester_email        text NOT NULL,
  requester_name         text,
  subject                text,

  status                 text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','pending','solved','closed')),
  priority               text NOT NULL DEFAULT 'normal'
                           CHECK (priority IN ('low','normal','high')),

  assigned_to            uuid,
  reopened_from          uuid REFERENCES public.email_tickets(id) ON DELETE SET NULL,

  first_response_at      timestamptz,
  last_message_at        timestamptz,
  last_message_direction text,
  last_message_preview   text,
  unread_count           integer NOT NULL DEFAULT 0,

  solved_at              timestamptz,
  closed_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_tickets IS
  'EMAIL-TICKET.1: one row per ISSUE, not per person. Replaces email_conversations (mig 394), which is retained read-only for one release and dropped later. Deliberately has NO unique index on (location_id, requester_email).';
COMMENT ON COLUMN public.email_tickets.queue_id IS
  'EMAIL-TICKET.1: reserved for v2 queues + per-queue grants. Always NULL in v1; no FK and no queues table yet.';
COMMENT ON COLUMN public.email_tickets.reopened_from IS
  'EMAIL-TICKET.1: set when an inbound reply threaded to a CLOSED ticket. The closed ticket stays closed; this is its successor.';
COMMENT ON COLUMN public.email_tickets.first_response_at IS
  'EMAIL-TICKET.1: first OUTBOUND non-note message. Internal notes never stamp it — the member never saw them.';

CREATE INDEX IF NOT EXISTS idx_email_tickets_loc_status
  ON public.email_tickets (location_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_tickets_loc_assigned
  ON public.email_tickets (location_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_email_tickets_contact
  ON public.email_tickets (contact_id);
CREATE INDEX IF NOT EXISTS idx_email_tickets_requester
  ON public.email_tickets (location_id, lower(requester_email));
CREATE INDEX IF NOT EXISTS idx_email_tickets_reopened_from
  ON public.email_tickets (reopened_from);

-- ── Message columns ─────────────────────────────────────────────────
-- conversation_id is retained through the transition and dropped with
-- email_conversations, per the deprecated-columns-stay-on-disk convention.
ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS ticket_id        uuid REFERENCES public.email_tickets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS cc_emails        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS bcc_emails       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_internal_note boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.email_inbox_messages.bcc_emails IS
  'EMAIL-TICKET.1: audit only. Written from compose, put on the wire to Postmark, and thereafter read only by staff on the ticket. MUST NEVER be rendered in any member-visible context.';
COMMENT ON COLUMN public.email_inbox_messages.is_internal_note IS
  'EMAIL-TICKET.1: staff-only note on a ticket. Never sent, never carries cc/bcc, never stamps first_response_at.';

CREATE INDEX IF NOT EXISTS idx_email_msg_ticket
  ON public.email_inbox_messages (ticket_id, created_at);

-- ── Attachments ─────────────────────────────────────────────────────
-- Same shape as issue_attachments (mig 213): rows record path/mime/size, the
-- bytes live in a private bucket reached by short-lived signed URLs.
--
-- storage_path is NULLABLE on purpose. When the mailbox quota is full (Plan 3)
-- the message still persists in full and the attachment is recorded with
-- storage_path NULL + skipped_reason, so staff see "not stored" and can ask
-- for a resend. A silent drop would be far worse than a visible one.
CREATE TABLE IF NOT EXISTS public.email_ticket_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     uuid NOT NULL REFERENCES public.email_inbox_messages(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  storage_path   text,
  filename       text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL,
  skipped_reason text CHECK (skipped_reason IN ('quota','too_large','rehost_failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_attach_stored_xor_skipped
    CHECK ((storage_path IS NOT NULL) <> (skipped_reason IS NOT NULL))
);

COMMENT ON TABLE public.email_ticket_attachments IS
  'EMAIL-TICKET.1: attachment metadata; bytes live in the private email-attachments bucket. storage_path NULL + skipped_reason set = accepted the message but did not store the file (see Plan 3 quota behaviour).';

CREATE INDEX IF NOT EXISTS idx_email_attach_message
  ON public.email_ticket_attachments (message_id);

-- ── Storage bucket ──────────────────────────────────────────────────
-- PRIVATE. Inbound attachments are arbitrary files from unauthenticated
-- strangers, so no public read and no MIME allowlist (we must store what
-- members actually send); access is a short-lived signed URL minted per view
-- by a service-role route that checks location access first. 25MB per file
-- matches Postmark's inbound limit — anything larger never reaches us.
-- Same posture as fleet-screenshots (mig 477) and car-documents (mig 025).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('email-attachments', 'email-attachments', FALSE, 26214400)
ON CONFLICT (id) DO NOTHING;

-- ── RLS (mirrors mig 394 exactly) ───────────────────────────────────
ALTER TABLE public.email_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_ticket_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_ticket_select ON public.email_tickets;
CREATE POLICY email_ticket_select ON public.email_tickets
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_tickets.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_ticket_deny_writes ON public.email_tickets;
CREATE POLICY email_ticket_deny_writes ON public.email_tickets
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS email_attach_select ON public.email_ticket_attachments;
CREATE POLICY email_attach_select ON public.email_ticket_attachments
  FOR SELECT TO authenticated
  USING (
    private.auth_is_master()
    OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.location_id = email_ticket_attachments.location_id
                 AND pl.profile_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS email_attach_deny_writes ON public.email_ticket_attachments;
CREATE POLICY email_attach_deny_writes ON public.email_ticket_attachments
  AS RESTRICTIVE FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- ── Realtime (mirrors mig 394) ──────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.email_tickets;

-- ── Atomic unread bump (extends the mig 314 family) ─────────────────
CREATE OR REPLACE FUNCTION public.increment_email_ticket_unread(p_ticket_id uuid)
RETURNS void LANGUAGE sql SET search_path = '' AS $$
  UPDATE public.email_tickets
     SET unread_count = coalesce(unread_count, 0) + 1
   WHERE id = p_ticket_id;
$$;
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tool `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects` first — the sentinel project `tpttqakxmyxrwnqjepfm` is a different database), with `name: "482_email_tickets"` and the file's contents as the query.

Expected: success, no error.

- [ ] **Step 3: Run the security advisors**

Required after any DDL. Use the Supabase MCP tool `get_advisors` with `type: "security"` against the same project.

Expected: no NEW findings attributable to `email_tickets` or `email_ticket_attachments`. Pre-existing findings elsewhere are not this task's problem, but a new `rls_disabled_in_public`, `auth_rls_initplan`, or `multiple_permissive_policies` naming either new table must be fixed before the next step.

- [ ] **Step 4: Verify the deliberate absence**

The single most important property of this schema is a missing index. Confirm it is actually missing, using the MCP tool `execute_sql`:

```sql
SELECT indexname FROM pg_indexes
 WHERE tablename = 'email_tickets'
   AND indexdef ILIKE '%unique%';
```

Expected: **zero rows** other than the primary key. If a unique index on `(location_id, requester_email)` appears, the model has silently reverted to mig 394's shape and the migration is wrong.

- [ ] **Step 5: Mirror the new CHECK lists in `src/lib/enums.js`**

`src/lib/enums.js` is the single source of truth for constants that mirror
Postgres `CHECK (col IN (...))` lists, and its header requires updating it **in
the same PR as the constraint**. This migration adds two such constraints, so
they belong there — not as a loose constant beside the helpers.

Follow that file's stated convention exactly: a frozen `<TABLE>_<COL>` object
whose values match the CHECK list character-for-character, plus an `*_VALUES`
array sibling built with `Object.values(...)`. Append to `src/lib/enums.js`:

```js
// ── email_tickets.status (mig 482) ────────────────────────────────
// Support lifecycle. `solved` still reopens on an inbound reply;
// `closed` is terminal and an inbound against it mints a NEW ticket
// (see resolveTicketAction in src/lib/email-tickets.js).
export const EMAIL_TICKET_STATUS = Object.freeze({
  OPEN: 'open',       // needs the studio's attention
  PENDING: 'pending', // replied, waiting on the member
  SOLVED: 'solved',   // handled, still reopenable
  CLOSED: 'closed',   // terminal — a reply starts a new ticket
})
export const EMAIL_TICKET_STATUS_VALUES = Object.values(EMAIL_TICKET_STATUS)

// ── email_tickets.priority (mig 482) ──────────────────────────────
export const EMAIL_TICKET_PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
})
export const EMAIL_TICKET_PRIORITY_VALUES = Object.values(EMAIL_TICKET_PRIORITY)
```

Then register both sets in the existing guard test `src/lib/enums.test.js`.
That file is table-driven: an `ALL_SETS` array of `[name, constants,
valuesArray]` triples feeds four `it.each(ALL_SETS)` assertions (non-empty,
unique values, frozen, and `*_VALUES` matches `Object.values`). So two entries
buy eight tests and **no new assertions are needed** — do not add a bespoke
`describe` block.

Two edits, both additive. First, append to the import list, immediately after
the existing `TEAM_MEMBER_ROLE, TEAM_MEMBER_ROLE_VALUES,` line:

```js
  EMAIL_TICKET_STATUS, EMAIL_TICKET_STATUS_VALUES,
  EMAIL_TICKET_PRIORITY, EMAIL_TICKET_PRIORITY_VALUES,
```

Second, append to the end of the `ALL_SETS` array, after the
`['TEAM_MEMBER_ROLE', ...]` entry:

```js
  ['EMAIL_TICKET_STATUS', EMAIL_TICKET_STATUS, EMAIL_TICKET_STATUS_VALUES],
  ['EMAIL_TICKET_PRIORITY', EMAIL_TICKET_PRIORITY, EMAIL_TICKET_PRIORITY_VALUES],
```

Do not touch the second `describe('enums — known shipped values')` block. It
pins values that specific shipped code depends on; nothing depends on the
ticket enums yet, so adding entries there would be speculative.

Verify:

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/enums.test.js
```

Expected: PASS, with the test count up by exactly 8 from its previous run.

- [ ] **Step 6: Commit**

```bash
cd ~/code/un1t-crm && git add supabase/migrations/482_email_tickets.sql src/lib/enums.js src/lib/enums.test.js && git commit -m "EMAIL-TICKET.1 — mig 482: email_tickets, attachments, message columns

One row per ISSUE, replacing mig 394's one-conversation-per-person model.
Deliberately NO unique index on (location_id, requester_email) — that index is
what made a conversation immortal.

Adds ticket_id / cc_emails / bcc_emails / is_internal_note to
email_inbox_messages, an email_ticket_attachments table with a nullable
storage_path (quota-skipped files are recorded, not silently dropped), and the
private email-attachments bucket. RLS copied verbatim from mig 394.

The status and priority CHECK lists are mirrored into src/lib/enums.js in this
same commit, per that file's stated convention.

Applied via MCP; advisors clean. WA/IG untouched. Nothing reads these yet.
Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md"
```

---

## Task 3b: Migration 483 — corrections to 482 (added during execution)

Review of the applied 482 found three real defects. All were fixed forward-only
in `supabase/migrations/483_email_tickets_rls_and_fk_fixes.sql` and verified
against the live database. Recorded here because Plans 2–5 depend on all three.

1. **The restrictive `FOR ALL` deny-writes also killed SELECT.** RLS is
   `(OR of permissive) AND (AND of restrictive)`, and `FOR ALL` includes SELECT,
   so the permissive SELECT policy was folded away — `EXPLAIN` under `role
   authenticated` gave `One-Time Filter: false`. That made 482's own
   `ALTER PUBLICATION` line inert, since realtime authorises rows through the
   subscriber's SELECT policy. Now split into per-command restrictive INSERT /
   UPDATE / DELETE policies, so the write backstop survives and reads work.
   **Plan 5 must use this per-command shape, not `FOR ALL`.**
2. **`email_inbox_messages.conversation_id` was still `NOT NULL`**, so a
   ticket-only insert would have forced the webhook to keep minting
   `email_conversations` rows — which still carry the UNIQUE
   `idx_email_conv_location_counterpart`, resurrecting the immortal-thread
   model. Now nullable. **This was a hard blocker for Plan 2.**
3. **Unindexed FK** on `email_ticket_attachments.location_id`, flagged by
   `get_advisors(type=performance)`. Note the lesson: 482 was verified with the
   **security** advisor only, and its commit message wrongly claimed the
   advisors named neither new table. Run both advisor types.

Also added hostile-input guards on the attachment columns (`size_bytes > 0`,
`mime_type <= 100`, `filename <= 255`), matching mig 213 — these values come
straight from an unauthenticated stranger's Postmark payload.

The `FOR ALL` pattern is inherited from mig 394 and shared by ~19 tables
estate-wide, which is why the `postgres_changes` listeners in `EmailInbox.jsx`
have never fired. That is tracked separately and is out of scope here.

---

## Task 4: Migration 484 — backfill

**Files:**
- Create: `supabase/migrations/484_email_tickets_backfill.sql`

> **Checked against prod 2026-08-05: `email_conversations` and
> `email_inbox_messages` are both EMPTY (0 rows).** One mailbox is configured
> (`UN1T Stillorgan`) but the channel has never received a single email.
>
> Two consequences, and neither changes the SQL:
>
> 1. **This backfill is a no-op and carries essentially no risk.** Its real
>    remaining effect is the `DEPRECATED` comment on `email_conversations`.
> 2. **The verification steps below are therefore vacuous** — `0 == 0` passes
>    whatever the mapping does. The id-reuse logic stays effectively unexercised
>    until real mail exists. Do NOT seed synthetic rows into production to
>    manufacture a test; record the limitation and let Plan 2's first real
>    inbound be the proof. Re-check the counts at execution time in case mail
>    has arrived since.

- [ ] **Step 1: Record the pre-backfill counts**

You need these to verify the backfill, and again to prove idempotency. Use the MCP tool `execute_sql`:

```sql
SELECT
  (SELECT count(*) FROM public.email_conversations)                          AS conversations,
  (SELECT count(*) FROM public.email_inbox_messages)                         AS messages,
  (SELECT count(*) FROM public.email_tickets)                                AS tickets_before,
  (SELECT count(*) FROM public.email_inbox_messages WHERE ticket_id IS NULL) AS unmapped_before;
```

Write the four numbers down. Expected before backfill: `tickets_before = 0`, `unmapped_before = messages`.

- [ ] **Step 2: Write the backfill migration**

Create `supabase/migrations/484_email_tickets_backfill.sql`:

```sql
-- EMAIL-TICKET.1 — backfill: one ticket per existing conversation.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
--
-- REUSING THE UUID IS THE WHOLE TRICK
-- Each ticket takes its conversation's id verbatim. That buys three things:
--   • idempotency is a plain ON CONFLICT DO NOTHING
--   • mapping messages is `ticket_id := conversation_id`, no join table, no
--     temp mapping, no second pass
--   • debugging a backfilled row against the old table is a straight id match
--
-- WHY SQL AND NOT A SCRIPT
-- A JS backfill would hit the 1,000-row select cap and need .range() paging
-- with an explicit .order(). Set-based SQL has no such cap and is atomic.
--
-- STATUS MAPPING
-- mig 394 had two states via resolved_at. resolved → 'solved' (not 'closed'):
-- an operator who marked a thread handled did not thereby consent to it never
-- accepting a reply again, and 'solved' still reopens on inbound. Choosing
-- 'closed' here would silently fork every future reply into a new ticket.

INSERT INTO public.email_tickets (
  id, location_id, contact_id, requester_email, requester_name, subject,
  status, assigned_to,
  last_message_at, last_message_direction, last_message_preview, unread_count,
  solved_at, created_at, updated_at
)
SELECT
  c.id,
  c.location_id,
  c.contact_id,
  c.counterpart_email,
  c.counterpart_name,
  coalesce(nullif(btrim(c.subject), ''), '(no subject)'),
  CASE WHEN c.resolved_at IS NOT NULL THEN 'solved' ELSE 'open' END,
  c.assigned_to,
  c.last_message_at,
  c.last_message_direction,
  c.last_message_preview,
  coalesce(c.unread_count, 0),
  c.resolved_at,
  c.created_at,
  c.updated_at
FROM public.email_conversations c
ON CONFLICT (id) DO NOTHING;

-- Messages inherit the mapping directly, since ticket id == conversation id.
UPDATE public.email_inbox_messages
   SET ticket_id = conversation_id
 WHERE ticket_id IS NULL
   AND conversation_id IS NOT NULL;

COMMENT ON TABLE public.email_conversations IS
  'DEPRECATED (mig 484) — superseded by email_tickets. Retained read-only for one release so a rollback needs no DB action; dropped in a later migration. Do not write to this table.';
```

- [ ] **Step 3: Apply the migration**

Use the MCP tool `apply_migration` with `name: "484_email_tickets_backfill"`.

Expected: success.

- [ ] **Step 4: Verify the backfill landed**

Run the same count query as Step 1 via `execute_sql`:

```sql
SELECT
  (SELECT count(*) FROM public.email_conversations)                          AS conversations,
  (SELECT count(*) FROM public.email_inbox_messages)                         AS messages,
  (SELECT count(*) FROM public.email_tickets)                                AS tickets_after,
  (SELECT count(*) FROM public.email_inbox_messages WHERE ticket_id IS NULL) AS unmapped_after;
```

Expected: `tickets_after = conversations` and `unmapped_after = 0`.

- [ ] **Step 5: Prove idempotency**

Re-running must not duplicate. Prove it **without** actually re-running the
insert — a probe that writes would pollute real data if the conflict target
turned out to be wrong, which is precisely the case being tested. Ask instead
how many rows a re-run would insert, via `execute_sql`:

```sql
SELECT count(*) AS would_insert_on_rerun
  FROM public.email_conversations c
 WHERE NOT EXISTS (SELECT 1 FROM public.email_tickets t WHERE t.id = c.id);
```

Expected: `0`. Any other number means the id-reuse mapping did not hold and a
second run would duplicate — stop and fix the backfill before shipping.

- [ ] **Step 6: Verify referential sanity**

```sql
SELECT count(*) AS orphans
  FROM public.email_inbox_messages m
  LEFT JOIN public.email_tickets t ON t.id = m.ticket_id
 WHERE m.ticket_id IS NOT NULL AND t.id IS NULL;
```

Expected: `0`.

- [ ] **Step 7: Commit**

```bash
cd ~/code/un1t-crm && git add supabase/migrations/484_email_tickets_backfill.sql && git commit -m "EMAIL-TICKET.1 — mig 484: backfill one ticket per conversation

Each ticket reuses its conversation's UUID, which makes idempotency an
ON CONFLICT DO NOTHING and makes the message mapping a direct
ticket_id := conversation_id with no join table and no second pass. Set-based
SQL rather than a JS backfill, so the 1,000-row select cap never applies.

resolved_at maps to 'solved', not 'closed' — an operator marking a thread
handled did not consent to it refusing all future replies, and 'closed' would
silently fork every reply into a new ticket.

email_conversations marked DEPRECATED and retained read-only for one release.
Verified: tickets == conversations, zero unmapped messages, zero orphans,
re-run adds nothing."
```

---

## Task 5: Full CI mirror and PR

**Files:** none (verification only)

- [ ] **Step 1: Run the complete CI mirror**

Green vitest alone does not mean CI passes. Run all six.

```bash
cd ~/code/un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```

Expected: all six pass. `check:mobile-parity` has nothing to say here — this plan adds no `WEB_PERMISSIONS` key (the `tickets` key lands in Plan 5, where its mobile counterpart is decided).

- [ ] **Step 2: Run the production build**

This plan adds a new module, so the build is the only check that catches import-resolution failures.

```bash
cd ~/code/un1t-crm && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Push and open the PR**

Pushing is not shipping — open the PR and report its URL.

```bash
cd ~/code/un1t-crm && git push -u origin HEAD && gh pr create --base main --title "EMAIL-TICKET.1 — ticket model, identity helpers, backfill (Plan 1 of 5)" --body "$(cat <<'EOF'
Plan 1 of the email ticketing program. **Zero behaviour change** — nothing reads
the new tables yet.

## What this lands
- `src/lib/email-tickets.js` — pure ticket identity + lifecycle rules, 22 tests
- **mig 482** — `email_tickets`, `email_ticket_attachments`, four new columns on
  `email_inbox_messages`, the private `email-attachments` bucket, RLS copied
  verbatim from mig 394
- **mig 484** — idempotent 1:1 backfill; `email_conversations` marked DEPRECATED
  and retained read-only for one release

## The point of it
Mig 394 kept one conversation per (location, address) forever, so a member with
two unrelated questions had one immortal thread. `email_tickets` has **no**
unique index on `(location_id, requester_email)` — that absence is the design.
A reply threading to a *closed* ticket mints a new one rather than reopening it.

## Verified
- Advisors clean after DDL
- `tickets == conversations`, zero unmapped messages, zero orphan `ticket_id`s
- Backfill re-run adds no rows
- No unique index on `(location_id, requester_email)` — checked explicitly
- Full CI mirror + `npm run build` green

## Scope
Email only. `whatsapp_conversations` and `instagram_conversations` are untouched
here and in every later plan in this program.

Spec: `docs/superpowers/specs/2026-08-05-email-ticketing-design.md`
Next: Plan 2 cuts the inbound webhook and send route over to ticket semantics.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR created. Report the URL.

- [ ] **Step 4: Confirm the Vercel and Next-build checks pass on the PR**

```bash
cd ~/code/un1t-crm && gh pr checks --watch
```

Expected: all checks green.

---

## Spec coverage for Plan 1

| Spec section | Covered by |
|---|---|
| `email_tickets` columns, statuses, indexes | Task 3 |
| No unique index on requester | Task 3 Step 4 (verified explicitly) |
| `queue_id` reserved, always NULL | Task 3 |
| `ticket_id`/`cc_emails`/`bcc_emails`/`is_internal_note` | Task 3 |
| `email_ticket_attachments` + `skipped_reason` | Task 3 |
| Private bucket | Task 3 |
| RLS mirroring mig 394 | Task 3 |
| Ticket identity rules 1–3 | Task 2 (`resolveTicketAction`) |
| Rule 4 (auto-close, default 7, operator-editable) | Task 2 (`ticketsDueForAutoClose`); the settings field lands in Plan 5 |
| Rule 5 (first-response stamping) | Task 2 (`shouldStampFirstResponse`) |
| Migration step 1 (create, no behaviour change) | Task 3 |
| Migration step 2 (idempotent backfill) | Task 4 |
| Migration step 5 (retain read-only) | Task 4 Step 2 (DEPRECATED comment) |

**Deferred by design:** webhook and send cutover (Plan 2, spec migration step 3) · quota accounting and `email_storage_usage` (Plan 3) · HTML sanitisation and the sandboxed iframe (Plan 4) · the tickets UI, the `tickets` permission key, saved-filter views, the auto-close settings field, and removing email from the unified inbox (Plan 5, spec migration step 4).
