# Email Ticketing — Plan 2: Mailboxes and per-mailbox access

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each studio one email inbox that can hold several email accounts, tabbed, with a feature permission gating the inbox and a per-account grant gating each tab — as schema plus pure helpers, with zero behaviour change.

**Architecture:** `email_mailboxes` replaces the single `locations.email_inbox_reply_to` column, many rows per location, one location per row. `email_mailbox_access` grants named people access to a named mailbox; master and owner-at-location are implicitly elevated and need no row. `email_tickets` gains `mailbox_id` so a ticket records the address it arrived at and can reply from the same one. The routing and visibility rules live in a pure `src/lib/email-mailboxes.js` with no DB and no env, mirroring `email-inbox.js` and `email-tickets.js`, so they are testable before any route depends on them. **Nothing reads any of it until Plan 3.**

**Tech Stack:** Supabase Postgres (migrations via Supabase MCP `apply_migration` against `iyvtbjjxdggiadzwwvdj`), supabase-js service role, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-email-ticketing-design.md`

**Plan 2 of 6.** Plan 1 (model + helpers + backfill) is merged. After this: 3 — webhook + send cutover, which is where the mailbox rules actually take effect and the dangerous fallback dies; 4 — quota accounting; 5 — HTML rendering; 6 — the tabbed inbox UI.

---

## Why this plan exists

Plan 1 assumed one mailbox per studio, because mig 394 modelled it that way — a single `locations.email_inbox_reply_to`, uniquely indexed. Richard's requirement on 2026-08-06 is one **inbox** per studio containing several **accounts** (`accounts@`, `sales@`, `studio@`, potentially on different domains), each separately permissioned. No configuration satisfies that against a single column.

The mailbox also turns out to be the natural access-control unit, which is better than the abstract `queue_id` Plan 1 reserved. `accounts@` is finance-sensitive in a way `studio@` is not, and "who can see this address" is a question operators can answer, unlike "which queue does this belong to". `queue_id` stays reserved and unused; if queues are ever wanted they sit *within* a mailbox.

**Proven working 2026-08-06:** a real message from `accounts@champfitness.ie` to `accounts@hatchstreetfitness.com` routed correctly to UN1T Hatch Street. The inbound path this plan builds on is live, not theoretical.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/485_email_mailboxes.sql` (create) | Both tables, `email_tickets.mailbox_id`, backfill, RLS |
| `src/lib/email-mailboxes.js` (create) | Pure routing + visibility rules. No DB, no env |
| `src/lib/email-mailboxes.test.js` (create) | Vitest unit tests |
| `shared/permissions.js` (modify) | New `email_inbox` feature key + per-role defaults |
| `scripts/check-mobile-parity.mjs` (modify) | Register `email_inbox` in `WEB_ONLY_OK` with a reason |

`src/lib/email-inbox.js`, `src/lib/email-tickets.js` and the webhook are **not** touched. The cutover is Plan 3.

---

## As built — deltas from this plan

Executed 2026-08-06. Three things differ from the text below; the decisions are
unchanged, the code moved on.

1. **`resolveMailboxByRecipient` loops the other way round.** As drafted it
   iterated *mailboxes* on the outside, so when a message named two estate
   addresses the winner was whichever DB row came back first — and
   `email_mailboxes` has no natural `ORDER BY`. Review proved it: `To: accounts@`
   + `Cc: stillorgan@` resolved to a different studio depending on row order.
   That is the same silent-misrouting class the module exists to kill. It now
   builds a Map of active mailboxes by address and iterates *recipients*, so the
   caller's precedence (To → Cc → `OriginalRecipient`, as `recipientEmails()`
   returns it) decides. Recipient order is now a documented contract.
2. **The local `norm()` helper is gone**, replaced by `normalizeEmail` imported
   from `./email-inbox`. It could not cause a wrong match, but two halves of the
   estate's email routing normalising through different functions would drift the
   moment either is hardened.
3. **Two tests were vacuous and were replaced.** Deleting the entire
   `is_default` sort key left every test passing, because the fixture's default
   also sorted first alphabetically; and the inactive-mailbox case only covered
   the elevated branch, so a granted user keeping access to a deactivated
   mailbox went uncaught. Final count is 23, not 21.

Also: migration **485 collides** with `485_rls_restrictive_forall_kills_select`
(#1223), which merged first. The prefix is kept, not renumbered — see the header
comment in the migration for why.

---

## Task 1: Branch and confirm the migration number

**Files:** none (setup only)

- [ ] **Step 1: Branch off fresh `origin/main`**

```bash
cd ~/code/un1t-crm && git fetch origin main && git checkout -b email-tickets-p2-mailboxes origin/main
```

- [ ] **Step 2: Confirm the next free migration number**

Plan 1 caught a real collision here, so do not skip it. Use the Supabase MCP tool `list_migrations` against `iyvtbjjxdggiadzwwvdj`.

Expected: the highest numeric prefix is **484** (`484_email_tickets_backfill`), so this plan uses **485**. If anything landed since, use the next free number throughout and say so in the PR.

---

## Task 2: Pure mailbox routing and visibility rules

**Files:**
- Create: `src/lib/email-mailboxes.js`
- Test: `src/lib/email-mailboxes.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/email-mailboxes.test.js`:

```js
// Tests for the pure mailbox routing + visibility rules.
// No DB, no env — the route owns the queries, these own the decisions.

import { describe, it, expect } from 'vitest'
import {
  resolveMailboxByRecipient,
  visibleMailboxes,
  orderMailboxTabs,
  hasAnyMailboxAccess,
} from './email-mailboxes'

const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const STILL = 'a0000000-0000-0000-0000-000000000001'

const accounts = { id: 'm1', location_id: HATCH, address: 'accounts@hatchstreetfitness.com', label: 'Accounts', is_default: true,  active: true }
const sales    = { id: 'm2', location_id: HATCH, address: 'sales@hatchstreetfitness.com',    label: 'Sales',    is_default: false, active: true }
const retired  = { id: 'm3', location_id: HATCH, address: 'old@hatchstreetfitness.com',      label: 'Old',      is_default: false, active: false }
const stillo   = { id: 'm4', location_id: STILL, address: 'stillorgan@un1t.com',             label: 'Studio',   is_default: true,  active: true }
const ALL = [accounts, sales, retired, stillo]

describe('resolveMailboxByRecipient', () => {
  it('matches a delivered-to address to its mailbox', () => {
    expect(resolveMailboxByRecipient(ALL, ['accounts@hatchstreetfitness.com'])).toBe(accounts)
  })

  it('matches case-insensitively', () => {
    expect(resolveMailboxByRecipient(ALL, ['ACCounts@HatchStreetFitness.COM'])).toBe(accounts)
  })

  it('picks the matching address out of several recipients', () => {
    expect(resolveMailboxByRecipient(ALL, ['someone@example.com', 'sales@hatchstreetfitness.com']))
      .toBe(sales)
  })

  it('returns NULL rather than guessing when nothing matches', () => {
    // This is the death of the "oldest active location" fallback. An unmatched
    // recipient must dead-letter, not silently file into another studio.
    expect(resolveMailboxByRecipient(ALL, ['mailbox+samplehash@inbound.postmarkapp.com']))
      .toBeNull()
  })

  it('does not route to an inactive mailbox', () => {
    expect(resolveMailboxByRecipient(ALL, ['old@hatchstreetfitness.com'])).toBeNull()
  })

  it('tolerates junk input', () => {
    expect(resolveMailboxByRecipient(null, ['a@b.com'])).toBeNull()
    expect(resolveMailboxByRecipient(ALL, null)).toBeNull()
    expect(resolveMailboxByRecipient(ALL, [])).toBeNull()
    expect(resolveMailboxByRecipient(ALL, [null, '', 'not-an-address'])).toBeNull()
  })

  it('never crosses locations — a Hatch address never resolves to Stillorgan', () => {
    const m = resolveMailboxByRecipient(ALL, ['accounts@hatchstreetfitness.com'])
    expect(m.location_id).toBe(HATCH)
  })
})

describe('visibleMailboxes', () => {
  const atHatch = [accounts, sales, retired]

  it('shows an elevated user every active mailbox, no grants needed', () => {
    expect(visibleMailboxes(atHatch, { isElevated: true, grantedMailboxIds: [] }))
      .toEqual([accounts, sales])
  })

  it('shows a granted user only their mailboxes', () => {
    expect(visibleMailboxes(atHatch, { isElevated: false, grantedMailboxIds: ['m2'] }))
      .toEqual([sales])
  })

  it('shows nothing to an ungranted, unelevated user', () => {
    expect(visibleMailboxes(atHatch, { isElevated: false, grantedMailboxIds: [] }))
      .toEqual([])
  })

  it('hides inactive mailboxes even from an elevated user', () => {
    const seen = visibleMailboxes(atHatch, { isElevated: true, grantedMailboxIds: ['m3'] })
    expect(seen.find(m => m.id === 'm3')).toBeUndefined()
  })

  it('ignores a grant for a mailbox not in the list', () => {
    expect(visibleMailboxes(atHatch, { isElevated: false, grantedMailboxIds: ['m4'] }))
      .toEqual([])
  })

  it('tolerates junk input', () => {
    expect(visibleMailboxes(null, { isElevated: true, grantedMailboxIds: [] })).toEqual([])
    expect(visibleMailboxes(atHatch, {})).toEqual([])
  })
})

describe('orderMailboxTabs', () => {
  it('puts the default mailbox first, then labels A to Z', () => {
    const zebra = { id: 'm9', label: 'Zebra', is_default: false, active: true, address: 'z@x.com' }
    expect(orderMailboxTabs([sales, zebra, accounts]).map(m => m.label))
      .toEqual(['Accounts', 'Sales', 'Zebra'])
  })

  it('falls back to address when labels collide, so order is total', () => {
    const a = { id: 'a', label: 'Same', is_default: false, active: true, address: 'b@x.com' }
    const b = { id: 'b', label: 'Same', is_default: false, active: true, address: 'a@x.com' }
    expect(orderMailboxTabs([a, b]).map(m => m.id)).toEqual(['b', 'a'])
  })

  it('does not mutate its input', () => {
    const input = [sales, accounts]
    orderMailboxTabs(input)
    expect(input.map(m => m.id)).toEqual(['m2', 'm1'])
  })

  it('tolerates junk input', () => {
    expect(orderMailboxTabs(null)).toEqual([])
  })
})

describe('hasAnyMailboxAccess', () => {
  it('is true for an elevated user with at least one active mailbox', () => {
    expect(hasAnyMailboxAccess([accounts], { isElevated: true, grantedMailboxIds: [] })).toBe(true)
  })

  it('is FALSE for an elevated user at a studio with no mailboxes', () => {
    // The feature permission alone must not surface an empty inbox.
    expect(hasAnyMailboxAccess([], { isElevated: true, grantedMailboxIds: [] })).toBe(false)
  })

  it('is true for a granted user', () => {
    expect(hasAnyMailboxAccess([accounts, sales], { isElevated: false, grantedMailboxIds: ['m2'] })).toBe(true)
  })

  it('is false for an ungranted user', () => {
    expect(hasAnyMailboxAccess([accounts, sales], { isElevated: false, grantedMailboxIds: [] })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they FAIL**

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/email-mailboxes.test.js
```

Expected: FAIL — cannot resolve `./email-mailboxes`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/email-mailboxes.js`:

```js
// EMAIL-TICKET.2 — pure mailbox routing + visibility rules.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS EXISTS
// Mig 394 gave a studio ONE inbound address, on locations.email_inbox_reply_to.
// A studio actually needs several — accounts@, sales@, studio@ — possibly on
// different domains, each visible to different people. email_mailboxes replaces
// that column; this module holds the two decisions that come with it: which
// mailbox an inbound message belongs to, and which mailboxes a person may see.
//
// THE RULE THAT MATTERS
// resolveMailboxByRecipient returns NULL when nothing matches. It deliberately
// has no fallback. The webhook it replaces resolved an unmatched recipient to
// "the oldest active location", which is why Postmark's own sample payload
// filed itself into Stillorgan's queue on 2026-08-05. With several addresses
// across several domains that behaviour silently mixes one studio's mail into
// another's. Null here means the caller dead-letters — loudly wrong beats
// quietly wrong.
//
// Pure: no DB, no env, no clock. The route owns the queries.

/** Lowercased, trimmed address, or null if it isn't one. */
function norm(addr) {
  if (!addr || typeof addr !== 'string') return null
  const e = addr.trim().toLowerCase()
  return e.includes('@') ? e : null
}

/**
 * The mailbox an inbound message was delivered to, or null.
 *
 * Matching is exact (case-insensitive) against ACTIVE mailboxes only — a
 * deactivated address stops accepting mail, the same way mig 394 treated a
 * NULL email_inbox_reply_to as "channel off".
 *
 * @param {Array<{id: string, address: string, active: boolean}>} mailboxes
 * @param {string[]} recipients — every address the mail was delivered to
 * @returns {object|null} the mailbox row, or null. NEVER a guess.
 */
export function resolveMailboxByRecipient(mailboxes, recipients) {
  if (!Array.isArray(mailboxes) || !Array.isArray(recipients)) return null
  const wanted = new Set(recipients.map(norm).filter(Boolean))
  if (wanted.size === 0) return null
  return mailboxes.find((m) => {
    if (!m?.active) return false
    const a = norm(m.address)
    return a !== null && wanted.has(a)
  }) || null
}

/**
 * The mailboxes a person may see at a location.
 *
 * Elevated (master, or owner at that location) sees every active mailbox with
 * no grant rows needed — the same posture as the rest of the estate, where
 * owners are not asked to grant themselves things. Everyone else sees only
 * mailboxes they hold an explicit grant for, because `accounts@` carries
 * billing correspondence that a coach has no business reading.
 *
 * Inactive mailboxes are hidden from everyone, elevated included.
 *
 * @param {Array} mailboxes — mailboxes at ONE location; the caller scopes that
 * @param {{isElevated?: boolean, grantedMailboxIds?: string[]}} viewer
 */
export function visibleMailboxes(mailboxes, viewer) {
  if (!Array.isArray(mailboxes)) return []
  const active = mailboxes.filter(m => m?.active)
  if (viewer?.isElevated) return active
  const granted = new Set(Array.isArray(viewer?.grantedMailboxIds) ? viewer.grantedMailboxIds : [])
  if (granted.size === 0) return []
  return active.filter(m => granted.has(m.id))
}

/**
 * Display order for the tab strip: the studio's default mailbox first, then
 * label A→Z, with address as a final tiebreak so the order is total and the
 * tabs never reshuffle between renders.
 *
 * Returns a new array; does not mutate the input.
 */
export function orderMailboxTabs(mailboxes) {
  if (!Array.isArray(mailboxes)) return []
  return [...mailboxes].sort((a, b) => {
    if (!!b?.is_default !== !!a?.is_default) return b?.is_default ? 1 : -1
    const byLabel = String(a?.label ?? '').localeCompare(String(b?.label ?? ''))
    if (byLabel !== 0) return byLabel
    return String(a?.address ?? '').localeCompare(String(b?.address ?? ''))
  })
}

/**
 * Whether the email-inbox surface should appear at all for this person here.
 *
 * Deliberately false when a studio has no mailboxes, even for an elevated
 * viewer: holding the feature permission should not put an empty inbox in the
 * nav of a studio that does not do email.
 */
export function hasAnyMailboxAccess(mailboxes, viewer) {
  return visibleMailboxes(mailboxes, viewer).length > 0
}
```

- [ ] **Step 4: Run the tests and confirm they PASS**

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/email-mailboxes.test.js
```

Expected: PASS, 21 tests.

- [ ] **Step 5: Lint**

```bash
cd ~/code/un1t-crm && npx eslint src/lib/email-mailboxes.js src/lib/email-mailboxes.test.js
```

Expected: clean.

- [ ] **Step 6: Commit**

Write the message to a file and use `-F`. Backticks inside a `-m` string get eaten by zsh command substitution — this bit a previous task.

```bash
cd ~/code/un1t-crm && git add src/lib/email-mailboxes.js src/lib/email-mailboxes.test.js && git commit -F- <<'MSG'
EMAIL-TICKET.2 — pure mailbox routing + visibility rules

resolveMailboxByRecipient, visibleMailboxes, orderMailboxTabs,
hasAnyMailboxAccess. Pure (no DB, no env, no clock), same posture as
email-inbox.js and email-tickets.js.

The load-bearing rule: resolveMailboxByRecipient returns NULL when nothing
matches, with no fallback. The webhook it will replace resolves an unmatched
recipient to "the oldest active location", which is why Postmark's sample
payload filed itself into Stillorgan on 2026-08-05. Null means the caller
dead-letters.

Nothing imports this yet — zero behaviour change.
MSG
```

---

## Task 3: Migration 485 — mailboxes, access grants, backfill

**Files:**
- Create: `supabase/migrations/485_email_mailboxes.sql`

- [ ] **Step 1: Record the pre-migration state**

Via MCP `execute_sql`:

```sql
SELECT count(*) AS locations_with_mailbox
  FROM public.locations WHERE email_inbox_reply_to IS NOT NULL;
```

Expected at time of writing: **2** (UN1T Stillorgan, UN1T Hatch Street). Write the number down — the backfill must produce exactly that many mailbox rows.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/485_email_mailboxes.sql`:

```sql
-- EMAIL-TICKET.2 — a studio gets ONE inbox holding MANY email accounts.
-- Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
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

-- The PK covers (mailbox_id, …); this covers the other direction, which is the
-- one the inbox asks: "which mailboxes may THIS person see".
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
ALTER TABLE public.email_mailboxes     ENABLE ROW LEVEL SECURITY;
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

CREATE POLICY email_mailbox_deny_insert ON public.email_mailboxes
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY email_mailbox_deny_update ON public.email_mailboxes
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
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

CREATE POLICY email_mailbox_access_deny_insert ON public.email_mailbox_access
  AS RESTRICTIVE FOR INSERT TO authenticated, anon WITH CHECK (false);
CREATE POLICY email_mailbox_access_deny_update ON public.email_mailbox_access
  AS RESTRICTIVE FOR UPDATE TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY email_mailbox_access_deny_delete ON public.email_mailbox_access
  AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (false);

ALTER PUBLICATION supabase_realtime ADD TABLE public.email_mailboxes;
```

- [ ] **Step 3: Apply it**

MCP `apply_migration`, project `iyvtbjjxdggiadzwwvdj`, name `485_email_mailboxes`.

- [ ] **Step 4: Run BOTH advisors**

Security-only missed an unindexed FK in Plan 1 and produced a wrong claim in a commit message. Run both.

```
get_advisors  type=security
get_advisors  type=performance
```

The performance result is large; filter it for `email_mailbox` rather than reading it whole. Expected: no new finding naming either table. `unused_index` hits on brand-new empty tables are expected noise. Any `unindexed_foreign_keys` naming these tables must be fixed before committing.

- [ ] **Step 5: Verify the backfill and the constraints**

```sql
SELECT 'mailboxes'        AS check, count(*)::text AS result FROM public.email_mailboxes
UNION ALL SELECT 'locations_with_column',
  (SELECT count(*)::text FROM public.locations WHERE email_inbox_reply_to IS NOT NULL)
UNION ALL SELECT 'defaults_per_location',
  (SELECT coalesce(string_agg(location_id::text || '=' || c::text, ', '), 'none')
     FROM (SELECT location_id, count(*) c FROM public.email_mailboxes
            WHERE is_default GROUP BY location_id) x)
UNION ALL SELECT 'would_insert_on_rerun',
  (SELECT count(*)::text FROM public.locations l
    WHERE l.email_inbox_reply_to IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.email_mailboxes m
                       WHERE lower(m.address) = lower(l.email_inbox_reply_to)))
UNION ALL SELECT 'select_works_as_authenticated', 'see next step';
```

Expected: `mailboxes` equals `locations_with_column` (2 at time of writing), every location shows `=1` default, and `would_insert_on_rerun` is **0** — the backfill is idempotent.

- [ ] **Step 6: Prove SELECT still works under RLS**

The single most important regression check on this migration, because getting it wrong is silent.

```sql
BEGIN;
SET LOCAL role authenticated;
EXPLAIN (COSTS OFF) SELECT * FROM public.email_mailboxes;
ROLLBACK;
```

Expected: a real `Seq Scan` with a `Filter:` containing `auth_is_master` and the `profile_locations` subplan. If you see `One-Time Filter: false`, a `FOR ALL` restrictive policy has crept back in — fix it before committing.

- [ ] **Step 7: Commit**

```bash
cd ~/code/un1t-crm && git add supabase/migrations/485_email_mailboxes.sql && git commit -F- <<'MSG'
EMAIL-TICKET.2 — mig 485: email_mailboxes + per-account access grants

A studio gets ONE inbox holding MANY accounts. Replaces the single
locations.email_inbox_reply_to column, which allowed exactly one address per
studio and cannot express accounts@ being visible to different people than
studio@.

A mailbox belongs to exactly one location (Richard, 2026-08-06) — an org-wide
accounts@ was rejected because per-location scoping is what the existing RLS,
permissions and assertLocationAccess are built on.

Access is two-level, mirroring approvals_inbox + approvals_*: the email_inbox
permission gates the surface, a row in email_mailbox_access gates each account.
Approval categories are static keys; mailboxes are rows, so this half is a
table. Master and owner-at-location are elevated in app code.

email_tickets.mailbox_id records which address a ticket arrived at, so replies
leave from the same one.

RLS uses per-command restrictive deny-writes, NOT FOR ALL — mig 483 fixed
exactly that mistake, where FOR ALL also blocked SELECT and silently killed
reads and realtime. Verified after applying: a real Seq Scan under role
authenticated, not One-Time Filter: false.

Backfill is idempotent and matched the column count. locations.email_inbox_reply_to
marked DEPRECATED; the webhook still reads it until the Plan 3 cutover.
MSG
```

---

## Task 4: The `email_inbox` permission key

**Files:**
- Modify: `shared/permissions.js`
- Modify: `scripts/check-mobile-parity.mjs`

- [ ] **Step 1: Add the key**

There is already an `email` key — it gates **marketing** email (it sits beside `whatsapp` and `sms`). This is a different surface and needs its own key. Add to the `WEB_PERMISSIONS` list in `shared/permissions.js`, next to `issues_inbox`, matching that entry's shape:

```js
  // EMAIL-TICKET.2 — the studio email inbox. NOT the same as `email`, which
  // gates marketing/campaign email. Two levels, like approvals_inbox: this key
  // gates the surface, and a row in email_mailbox_access gates each individual
  // account within it. Holding this key alone shows nothing — a studio with no
  // mailboxes, or a person with no grants, gets no inbox at all.
  { key: 'email_inbox', label: 'Email inbox',
    hint: 'Ticketed inbox for the studio email accounts (accounts@, sales@, studio@). Access to each individual account is granted separately per person. Master + owner + manager by default.' },
```

- [ ] **Step 2: Add the per-role defaults**

Add `email_inbox` to every role block in `DEFAULT_WEB_PERMISSIONS_BY_ROLE`. The parity test asserts every role carries every key, so a missing one fails.

```
master:      email_inbox: true
owner:       email_inbox: true
manager:     email_inbox: true
head_coach:  email_inbox: false
reception:   email_inbox: false
staff:       email_inbox: false
```

Rationale to put in a comment: the feature key is deliberately not the fine control — per-account grants are. Defaulting head coach and reception to false keeps the nav clean; an operator turning it on still has to grant an account before anything appears.

- [ ] **Step 3: Register the parity decision**

`npm run check:mobile-parity` fails on a new `WEB_PERMISSIONS` key with no mobile counterpart. Add `email_inbox` to `WEB_ONLY_OK` in `scripts/check-mobile-parity.mjs`, with a reason in the same style as the neighbouring entries:

> `email_inbox` — desktop operator surface. The tabbed inbox with per-account permissions is a wide layout; a mobile counterpart is deliberately deferred until the UI exists (Plan 6) rather than reserved speculatively.

- [ ] **Step 4: Run the permission tests**

```bash
cd ~/code/un1t-crm && npx vitest run shared/permissions.test.js shared/__tests__/permissions.approvals.test.js
```

Expected: PASS. These assert no orphan keys and no role missing a key, so a partial edit fails here.

- [ ] **Step 5: Run the parity and lint checks**

```bash
cd ~/code/un1t-crm && npm run check:mobile-parity && npm run check:mobile-imports && npx eslint shared/permissions.js scripts/check-mobile-parity.mjs
```

Expected: all clean.

- [ ] **Step 6: Commit**

```bash
cd ~/code/un1t-crm && git add shared/permissions.js scripts/check-mobile-parity.mjs && git commit -F- <<'MSG'
EMAIL-TICKET.2 — email_inbox permission key

Gates the studio email inbox surface. Deliberately separate from the existing
`email` key, which gates marketing/campaign email — same word, different
surface.

Two levels, mirroring approvals_inbox: this key gates the surface, and a row in
email_mailbox_access (mig 485) gates each individual account. Holding the key
alone shows nothing, because a studio with no mailboxes and a person with no
grants both resolve to an empty list.

Master + owner + manager on by default; head coach, reception and staff off.
Registered in WEB_ONLY_OK — the mobile counterpart is deferred until the UI
exists rather than reserved speculatively.
MSG
```

---

## Task 5: Full CI mirror, build, PR

**Files:** none (verification only)

- [ ] **Step 1: Run the complete CI mirror**

Green vitest alone does not mean CI passes.

```bash
cd ~/code/un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```

Expected: all six pass. The suite was 9862 tests before this plan; expect roughly +21 from the new module plus whatever the permission tests add per key.

- [ ] **Step 2: Production build**

This plan adds a module and touches `shared/`, so the build is the only check that catches import-resolution failures.

```bash
cd ~/code/un1t-crm && npm run build
```

- [ ] **Step 3: Push and open the PR**

```bash
cd ~/code/un1t-crm && git push -u origin HEAD && gh pr create --base main --title "EMAIL-TICKET.2 — mailboxes and per-account access (Plan 2 of 6)" --body-file <(cat <<'EOF'
Plan 2 of the email ticketing program. **Zero behaviour change** — nothing reads the new tables or the new permission key yet.

## What this lands
- **mig 485** — `email_mailboxes` (many per studio, one studio per mailbox), `email_mailbox_access` (per-account grants), `email_tickets.mailbox_id`, and an idempotent backfill from `locations.email_inbox_reply_to`
- **`src/lib/email-mailboxes.js`** — pure routing + visibility rules, 21 tests
- **`email_inbox` permission key** — gates the surface; per-account grants gate each tab

## Why
Plan 1 inherited mig 394's assumption of one address per studio. A studio needs `accounts@`, `sales@` and `studio@`, on possibly different domains, visible to different people — `accounts@` carries billing correspondence a coach has no business reading.

## The rule that matters
`resolveMailboxByRecipient` returns **null** when nothing matches, with no fallback. The webhook it will replace resolves an unmatched recipient to *"the oldest active location"* — which is why Postmark's own sample payload filed itself into Stillorgan's queue on 2026-08-05. Null means the caller dead-letters. Loudly wrong beats quietly wrong.

## Verified
- Both advisors run after DDL, neither names the new tables
- `SELECT` under `role authenticated` plans a real `Seq Scan`, **not** `One-Time Filter: false` — mig 483 fixed exactly that mistake and this migration deliberately uses per-command restrictive policies
- Backfill matched the column count, one default per location, re-run inserts nothing
- Full CI mirror and `npm run build` green

## Context
Inbound delivery was proven live on 2026-08-06: a real message to `accounts@hatchstreetfitness.com` routed correctly to UN1T Hatch Street.

Next: Plan 3 cuts the webhook and send routes over to mailbox + ticket semantics, which is where the fallback actually dies.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch checks**

```bash
cd ~/code/un1t-crm && gh pr checks --watch
```

---

## Spec coverage

| Requirement | Task |
|---|---|
| One inbox per studio | 3 (`email_mailboxes.location_id`) |
| Tabbed when several accounts exist | 2 (`orderMailboxTabs`), rendered in Plan 6 |
| Permission controlling the inbox | 4 (`email_inbox` key) |
| Permission controlling each account | 3 (`email_mailbox_access`) + 2 (`visibleMailboxes`) |
| Multiple domains | 3 — an address carries its own domain; no per-domain modelling needed |
| Reply from the address written to | 3 (`email_tickets.mailbox_id`) |
| Quota per mailbox | Deferred to Plan 4; `email_storage_usage` keys on `mailbox_id` |

**Deliberately deferred:** the webhook cutover and the death of the location fallback (Plan 3) · quota accounting (4) · HTML rendering (5) · the tabbed UI and the grant editor (6).

## Carried into Plan 3 — Postmark server topology

Richard, 2026-08-06: **three separate Postmark servers, always** — marketing,
email inbox, invoices inbound. Inbox vs invoices is forced (a Postmark server
has exactly one inbound stream, so two inbound purposes cannot share one).
Marketing vs the rest is a deliberate reputation firebreak: bulk campaigns are
where reputation damage happens, and support replies must not bounce because a
campaign went badly.

Separately, and more immediately: **ticket replies go out on the TRANSACTIONAL
stream, not broadcast** (Richard, 2026-08-06). `src/lib/postmark.js` already has
both — `sendTransactionalEmail()` on the `outbound` stream versus
`sendMarketingEmail()` on `broadcast` — and `consentFieldForStream()` maps them
to `email_administrative` and `email_marketing` respectively. A reply to one
person who just wrote in is transactional on every count: consent family,
reputation pool, and analytics. **Plan 3 calls `sendTransactionalEmail()`.**

This plan touches no send path, so nothing here implements either point. Plan 3
must also decide, rather than inherit, whether a reply *within a ticket* should
be gated on `email_administrative` at all — the member initiated contact, and a
suppression flag silently swallowing the answer to their own question is worse
than the consent risk it avoids.
