# Glofox Notes Sync (GLOFOX-NOTES) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-way sync of member notes/comments between Glofox and the CRM: Glofox → CRM already lands interactions on the contact timeline (extend to the Notes view); CRM → Glofox pushes CRM-authored notes and logged call/email touchpoints into Glofox as interactions, fire-and-forget, without echo duplicates.

**Architecture:** Glofox's `/2.1/branches/{branchId}/leads/{userId}/interactions` is the only note surface — **create + list only, no edit/delete, no webhook, `description` ≤500 chars, no author field, and the create returns no body** (so the created id is unknowable at push time). Outbound is therefore one-way create-only (edits/deletes stay CRM-only, operator-approved 2026-07-04). The echo problem — a pushed note gets pulled back by the existing inbound sync and shows twice — is solved with an **outbound ledger table (`glofox_note_pushes`)**: each push records the exact text + type + time we sent; the inbound sync claims a matching incoming interaction as "ours" (by ledger fingerprint, then by id on later runs) and suppresses the duplicate. Inbound already runs on the member-sync path (`applyMemberSync` → `syncGlofoxInteractions`); we hook reconciliation into it.

**Tech Stack:** Next.js 16 App Router, Supabase (migrations via MCP, project `iyvtbjjxdggiadzwwvdj`), Vitest. Glofox REST client in `src/lib/glofox.js`; sync engine in `src/lib/glofox-sync.js`.

**Operator-approved scope (Richard, 2026-07-04):**
- Direction: **both** (inbound into the Notes view + outbound push).
- Outbound model: **fire-and-forget copy on create.** Edits/deletes NOT synced. Author embedded in the text; text truncated at 500 with a marker.
- Mapping: **CRM notes AND logged call/email touchpoints** → Glofox interactions.

**Design decisions to confirm on review (called out where they bite):**
- **Outbound activity scope (Task 6):** mirror ONLY `activities` with `type IN ('call','email')` AND `kind = 'task'` AND `done = true` AND `source IS DISTINCT FROM 'glofox'`. This deliberately EXCLUDES system-event activities (door unlocks, SMS/WhatsApp auto-logs, tapo toggles — all `kind='event'`) so Glofox isn't spammed. Notes (the `notes` table) are mirrored unconditionally (all are human-authored).
- **Only Glofox-linked contacts** (`glofox_member_id IS NOT NULL`) can be pushed; CRM-only leads are silently skipped (no target userId).
- **Echo fingerprint window (Task 5):** an incoming interaction is claimed as our echo when an unreconciled ledger row matches (same `contact_id`, same `type`, exact `description`, and `|interaction.created − pushed_at| ≤ 2h`). Exact-text match makes the window generous-safe.

**Deploy sequencing:** migration (Task 2) → code → no backfill (no existing pushes). Outbound is gated by Glofox creds existing for the location (Stillorgan only), so it's inert elsewhere.

**Worktree:** branch off fresh `origin/main`: `git fetch origin main && git checkout -b glofox-notes-sync origin/main` (run `npm install` after — the `-ct` worktree drifts behind main's deps).

---

## File map

- `src/lib/glofox.js` — **add** `createGlofoxInteraction(creds, userId, { type, description })` (POST). Reuse the existing `glofoxFetch` POST idiom (see `registerGlofoxMember`).
- `src/lib/glofox-notes.js` — **new**. Pure helpers: `buildInteractionDescription({ authorName, content })` (author prefix + 500-char truncation) and `matchesPush(interaction, pushRow)` (echo fingerprint). Keeps the string/matching logic testable + out of the DB code.
- `src/lib/glofox-note-push.js` — **new**. `pushNoteToGlofox(db, { contactId, sourceTable, sourceId, type, authorName, content })`: resolves creds + `glofox_member_id`, builds the description, calls `createGlofoxInteraction`, writes the `glofox_note_pushes` ledger row. Best-effort; never throws to the caller.
- `src/lib/glofox-sync.js` — **modify** `syncGlofoxInteractions` to claim echoes via the ledger before upserting (Task 5).
- `src/app/api/notes/route.js` — **modify**: after a note insert, fire-and-forget `pushNoteToGlofox` (Task 4).
- `src/app/api/contacts/[id]/activity/route.js` (or wherever call/email task activities are created — resolve in Task 6) — **modify**: fire-and-forget push for qualifying call/email activities (Task 6).
- `supabase/migrations/371_glofox_note_pushes.sql` — **new** (Task 2; confirm the next free number at build time).
- `src/components/ContactDetailTabs.jsx` / contact page Notes tab — **modify** (Task 7) so Glofox NOTE interactions render in the Notes view, not only the full timeline.

---

### Task 1: Glofox client — create an interaction

**Files:**
- Modify: `src/lib/glofox.js` (add `createGlofoxInteraction` near `fetchUserInteractions`)
- Test: `src/lib/glofox.test.js` (or the existing glofox client test file — confirm name)

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi } from 'vitest'
import { createGlofoxInteraction } from './glofox.js'

describe('createGlofoxInteraction', () => {
  const creds = { branchId: 'b'.repeat(24), token: 't' }
  it('POSTs to the interactions endpoint with user_id, type, description', async () => {
    const calls = []
    global.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts })
      return { ok: true, status: 200, json: async () => ({}) }
    })
    const uid = 'a'.repeat(24)
    const r = await createGlofoxInteraction(creds, uid, { type: 'NOTE', description: 'hi' })
    expect(r.ok).toBe(true)
    expect(calls[0].url).toContain(`/2.1/branches/${creds.branchId}/leads/${uid}/interactions`)
    expect(calls[0].opts.method).toBe('POST')
    const sent = JSON.parse(calls[0].opts.body)
    expect(sent).toMatchObject({ user_id: uid, type: 'NOTE', description: 'hi' })
  })
  it('returns { ok:false } on missing creds/userId (no throw)', async () => {
    expect((await createGlofoxInteraction(null, 'x', { type: 'NOTE', description: 'y' })).ok).toBe(false)
    expect((await createGlofoxInteraction(creds, '', { type: 'NOTE', description: 'y' })).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/glofox.test.js -t createGlofoxInteraction`
Expected: FAIL — `createGlofoxInteraction is not a function`.

- [ ] **Step 3: Implement** (add to `src/lib/glofox.js`, modelled on `registerGlofoxMember`'s POST via `glofoxFetch`)

```javascript
/**
 * Create a Glofox interaction (note / manual email) for a user via
 * POST /2.1/branches/{branchId}/leads/{userId}/interactions.
 *
 * Glofox accepts only type NOTE or MANUAL_EMAIL on create, description
 * <= 500 chars. The response has NO body (the created interaction id is
 * not returned) — reconciliation happens later via the inbound pull +
 * the glofox_note_pushes ledger. Best-effort: returns { ok, status }.
 */
export async function createGlofoxInteraction(creds, userId, { type, description } = {}) {
  if (!creds || !creds.branchId || !userId || !type) return { ok: false, status: 0 }
  try {
    const r = await glofoxFetch(
      creds,
      `/2.1/branches/${encodeURIComponent(creds.branchId)}/leads/${encodeURIComponent(userId)}/interactions`,
      { method: 'POST', body: JSON.stringify({ user_id: userId, type, description: description ?? '' }) },
    )
    return { ok: r.ok, status: r.status }
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || 'network error' }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/glofox.test.js -t createGlofoxInteraction`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox.js src/lib/glofox.test.js
git commit -m "GLOFOX-NOTES — client: createGlofoxInteraction (POST, create-only)"
```

---

### Task 2: Migration — the outbound push ledger

**Files:**
- Create: `supabase/migrations/371_glofox_note_pushes.sql` (confirm next free number with `ls supabase/migrations | tail`)

- [ ] **Step 1: Write the migration**

```sql
-- 371 — GLOFOX-NOTES: outbound push ledger.
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
  -- the inbound sync sees it. Unique (partial) so a claimed id is ours forever.
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
```

- [ ] **Step 2: Apply via MCP** — `apply_migration` name `371_glofox_note_pushes` against project `iyvtbjjxdggiadzwwvdj`. Then `get_advisors` (type=security) — expect only the intentional `rls_enabled_no_policy` INFO for this table (same class as `glofox_sync_runs`).

- [ ] **Step 3: Verify**

```sql
select column_name, data_type from information_schema.columns
where table_name='glofox_note_pushes' order by ordinal_position;
```
Expected: the 11 columns above.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/371_glofox_note_pushes.sql
git commit -m "GLOFOX-NOTES — mig 371: glofox_note_pushes outbound ledger"
```

---

### Task 3: Pure helpers — description builder + echo matcher

**Files:**
- Create: `src/lib/glofox-notes.js`
- Test: `src/lib/glofox-notes.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
import { describe, it, expect } from 'vitest'
import { buildInteractionDescription, matchesPush } from './glofox-notes.js'

describe('buildInteractionDescription', () => {
  it('prefixes the author and does not truncate short content', () => {
    const r = buildInteractionDescription({ authorName: 'Jane', content: 'Called, keen to join' })
    expect(r.description).toBe('[UN1T CRM · Jane] Called, keen to join')
    expect(r.truncated).toBe(false)
  })
  it('truncates to 500 chars with an ellipsis marker and flags truncated', () => {
    const long = 'x'.repeat(600)
    const r = buildInteractionDescription({ authorName: 'Jane', content: long })
    expect(r.description.length).toBe(500)
    expect(r.description.endsWith('…')).toBe(true)
    expect(r.truncated).toBe(true)
  })
  it('falls back to a neutral author when name missing', () => {
    expect(buildInteractionDescription({ content: 'hi' }).description).toBe('[UN1T CRM] hi')
  })
})

describe('matchesPush', () => {
  const base = { contact_id: 'c1', type: 'NOTE', description: '[UN1T CRM · Jane] hi', pushed_at: '2026-07-04T10:00:00Z' }
  const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000)
  it('matches same contact + type + exact description within 2h', () => {
    const interaction = { type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T10:01:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(true)
  })
  it('no match on different description', () => {
    const interaction = { type: 'NOTE', description: 'something else', created: secs('2026-07-04T10:01:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(false)
  })
  it('no match outside the 2h window', () => {
    const interaction = { type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T13:00:00Z') }
    expect(matchesPush(interaction, base, 'c1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/lib/glofox-notes.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/glofox-notes.js`**

```javascript
// GLOFOX-NOTES — pure helpers for the outbound note push + echo reconciliation.
// No DB, no network — string building + fingerprint matching only.

const MAX_DESCRIPTION = 500
const ECHO_WINDOW_MS = 2 * 60 * 60 * 1000 // 2h — exact-text match makes this safe

/**
 * Build the Glofox interaction description from a CRM note: author-prefixed
 * (Glofox interactions carry no author field) and truncated to 500 chars with
 * an ellipsis. Returns { description, truncated }.
 */
export function buildInteractionDescription({ authorName, content }) {
  const prefix = authorName && authorName.trim()
    ? `[UN1T CRM · ${authorName.trim()}] `
    : '[UN1T CRM] '
  const full = prefix + (content || '')
  if (full.length <= MAX_DESCRIPTION) return { description: full, truncated: false }
  // Reserve 1 char for the ellipsis marker.
  return { description: full.slice(0, MAX_DESCRIPTION - 1) + '…', truncated: true }
}

/**
 * Is this incoming Glofox interaction the echo of a ledger push? Exact
 * description + type match, same contact, within the echo window of pushed_at.
 * interaction.created is Unix SECONDS (Glofox convention).
 */
export function matchesPush(interaction, pushRow, contactId) {
  if (!interaction || !pushRow) return false
  if (pushRow.contact_id !== contactId) return false
  if (String(interaction.type || '') !== pushRow.type) return false
  if (String(interaction.description || '') !== pushRow.description) return false
  const createdMs = Number(interaction.created) * 1000
  const pushedMs = new Date(pushRow.pushed_at).getTime()
  if (!Number.isFinite(createdMs) || !Number.isFinite(pushedMs)) return false
  return Math.abs(createdMs - pushedMs) <= ECHO_WINDOW_MS
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/glofox-notes.test.js`
Expected: PASS (9 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox-notes.js src/lib/glofox-notes.test.js
git commit -m "GLOFOX-NOTES — pure helpers: description builder + echo matcher"
```

---

### Task 4: Outbound push service + wire into note creation

**Files:**
- Create: `src/lib/glofox-note-push.js`
- Test: `src/lib/glofox-note-push.test.js`
- Modify: `src/app/api/notes/route.js` (fire-and-forget after insert)

- [ ] **Step 1: Write the failing test** (mock glofox client + a fake db)

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./glofox.js', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  createGlofoxInteraction: vi.fn(),
}))

import { pushNoteToGlofox } from './glofox-note-push.js'
import { glofoxCredentialsForLocation, createGlofoxInteraction } from './glofox.js'

const CREDS = { branchId: 'b'.repeat(24), token: 't' }

function makeDb(contact, ledgerSpy) {
  return {
    from: (t) => {
      if (t === 'contacts') return { select: () => ({ eq: () => ({ single: async () => ({ data: contact, error: null }) }) }) }
      if (t === 'glofox_note_pushes') return { insert: async (row) => { ledgerSpy(row); return { error: null } } }
      throw new Error(t)
    },
  }
}

beforeEach(() => { vi.clearAllMocks(); glofoxCredentialsForLocation.mockResolvedValue(CREDS); createGlofoxInteraction.mockResolvedValue({ ok: true, status: 200 }) })

describe('pushNoteToGlofox', () => {
  it('pushes a NOTE for a glofox-linked contact and records the ledger', async () => {
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: 'gm1' }, ledger)
    const r = await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', authorName: 'Jane', content: 'hi' })
    expect(r.pushed).toBe(true)
    expect(createGlofoxInteraction).toHaveBeenCalledWith(CREDS, 'gm1', { type: 'NOTE', description: '[UN1T CRM · Jane] hi' })
    expect(ledger.mock.calls[0][0]).toMatchObject({ contact_id: 'c1', glofox_member_id: 'gm1', source_table: 'notes', source_id: 'n1', type: 'NOTE', status: 'sent' })
  })
  it('skips (no push, no throw) when the contact has no glofox_member_id', async () => {
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: null }, ledger)
    const r = await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', content: 'hi' })
    expect(r.pushed).toBe(false)
    expect(createGlofoxInteraction).not.toHaveBeenCalled()
    expect(ledger).not.toHaveBeenCalled()
  })
  it('records status=failed when the Glofox create fails', async () => {
    createGlofoxInteraction.mockResolvedValue({ ok: false, status: 500 })
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: 'gm1' }, ledger)
    await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', content: 'hi' })
    expect(ledger.mock.calls[0][0].status).toBe('failed')
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/lib/glofox-note-push.test.js` → module not found.

- [ ] **Step 3: Implement `src/lib/glofox-note-push.js`**

```javascript
// GLOFOX-NOTES — outbound push service. Fire-and-forget: a CRM note / logged
// call-email touchpoint is copied into Glofox as an interaction ONCE on create.
// Never throws to the caller (best-effort side effect). Records every push in
// glofox_note_pushes so the inbound sync can claim the echo and suppress the
// duplicate (Task 5).

import { glofoxCredentialsForLocation, createGlofoxInteraction } from './glofox.js'
import { buildInteractionDescription } from './glofox-notes.js'
import { logWarn } from './log.js'

/**
 * @param db  service-role client
 * @param {object} args
 *   contactId, sourceTable ('notes'|'activities'), sourceId,
 *   type ('NOTE'|'MANUAL_EMAIL'), authorName?, content
 * @returns {Promise<{pushed:boolean, reason?:string}>}
 */
export async function pushNoteToGlofox(db, { contactId, sourceTable, sourceId, type, authorName, content }) {
  try {
    if (!contactId || !sourceId || !content) return { pushed: false, reason: 'missing args' }

    const { data: contact } = await db
      .from('contacts')
      .select('id, location_id, glofox_member_id')
      .eq('id', contactId)
      .single()
    if (!contact || !contact.glofox_member_id) return { pushed: false, reason: 'no glofox member' }

    const creds = await glofoxCredentialsForLocation(db, contact.location_id)
    if (!creds) return { pushed: false, reason: 'no glofox creds' }

    const { description, truncated } = buildInteractionDescription({ authorName, content })
    const res = await createGlofoxInteraction(creds, contact.glofox_member_id, { type, description })

    await db.from('glofox_note_pushes').insert({
      contact_id: contactId,
      location_id: contact.location_id,
      glofox_member_id: contact.glofox_member_id,
      source_table: sourceTable,
      source_id: sourceId,
      type,
      description,
      truncated,
      status: res.ok ? 'sent' : 'failed',
    })
    return { pushed: res.ok }
  } catch (e) {
    logWarn('glofox-note-push', 'push threw', { err: e?.message, contactId })
    return { pushed: false, reason: 'threw' }
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/glofox-note-push.test.js` → PASS.

- [ ] **Step 5: Wire into `src/app/api/notes/route.js`** — after the successful note insert (the `db.from('notes').insert(...).select().single()` returns `data`), add a fire-and-forget push (do NOT await-block the response; catch internally):

```javascript
// GLOFOX-NOTES — copy the note into Glofox for the front desk (fire-and-forget;
// only for Glofox-linked contacts; edits/deletes are NOT synced back).
if (data?.id && (body.contact_id || body.person_id)) {
  import('@/lib/glofox-note-push').then(({ pushNoteToGlofox }) =>
    pushNoteToGlofox(db, {
      contactId: body.contact_id || body.person_id,
      sourceTable: 'notes',
      sourceId: data.id,
      type: 'NOTE',
      authorName: auth?.user?.full_name || null,
      content: body.content,
    }),
  ).catch(() => {})
}
```

(Confirm the auth/user variable name in that route — it uses `assertCreateInOrg`; grab the display name from whatever `getCurrentUser`/auth object the route already has, else pass `null`.)

- [ ] **Step 6: Run the notes route test** — `npx vitest run src/app/api/notes` (add a case asserting the push is invoked with `sourceTable:'notes'` if the route has a test; if not, the service test in Step 1 covers the logic and this wire-up is verified by `npm run build` + manual smoke).

- [ ] **Step 7: Commit**

```bash
git add src/lib/glofox-note-push.js src/lib/glofox-note-push.test.js src/app/api/notes/route.js
git commit -m "GLOFOX-NOTES — outbound push service + fire-and-forget on note create"
```

---

### Task 5: Echo reconciliation in the inbound sync

**Files:**
- Modify: `src/lib/glofox-sync.js` (`syncGlofoxInteractions`, ~line 1250)
- Test: `src/lib/glofox-sync.test.js` (add cases)

- [ ] **Step 1: Write the failing tests** — a fake db exposing `glofox_note_pushes` select/update + `activities` upsert spy. Assert: (a) an interaction matching an unreconciled push is CLAIMED (ledger row updated with its `_id`, status `reconciled`) and NOT upserted into activities; (b) an interaction whose `_id` is already claimed is skipped; (c) an unrelated interaction still upserts into activities as before.

```javascript
describe('syncGlofoxInteractions — echo reconciliation (GLOFOX-NOTES)', () => {
  const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000)
  function makeDb({ pushes = [], claimSpy = () => {}, activitySpy = () => {} }) {
    return {
      from: (t) => {
        if (t === 'glofox_note_pushes') return {
          select: () => ({ eq: () => ({ is: async () => ({ data: pushes, error: null }) }) }),
          update: (patch) => ({ eq: async (col, val) => { claimSpy({ patch, val }); return { error: null } } }),
        }
        if (t === 'activities') return { upsert: async (row) => { activitySpy(row); return { error: null } } }
        throw new Error(t)
      },
    }
  }
  it('claims a matching echo and does NOT duplicate it into activities', async () => {
    const push = { id: 'p1', contact_id: 'c1', type: 'NOTE', description: '[UN1T CRM · Jane] hi', pushed_at: '2026-07-04T10:00:00Z', glofox_interaction_id: null }
    const claimSpy = vi.fn(); const activitySpy = vi.fn()
    const db = makeDb({ pushes: [push], claimSpy, activitySpy })
    const interaction = { _id: 'g'.repeat(24), type: 'NOTE', description: '[UN1T CRM · Jane] hi', created: secs('2026-07-04T10:01:00Z') }
    await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(claimSpy).toHaveBeenCalledTimes(1)
    expect(claimSpy.mock.calls[0][0].patch).toMatchObject({ glofox_interaction_id: interaction._id, status: 'reconciled' })
    expect(activitySpy).not.toHaveBeenCalled() // no duplicate timeline row
  })
  it('skips an interaction whose _id is already claimed', async () => {
    const claimed = { id: 'p1', contact_id: 'c1', type: 'NOTE', description: 'x', pushed_at: '2026-07-04T10:00:00Z', glofox_interaction_id: 'g'.repeat(24) }
    const activitySpy = vi.fn()
    // claimed rows come back from a second query keyed on the id set; model
    // however the implementation reads them (see Step 3).
    const db = makeDb({ pushes: [claimed], activitySpy })
    const interaction = { _id: 'g'.repeat(24), type: 'NOTE', description: 'anything', created: secs('2026-07-04T10:05:00Z') }
    await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(activitySpy).not.toHaveBeenCalled()
  })
  it('upserts a genuine (non-echo) interaction into activities', async () => {
    const activitySpy = vi.fn()
    const db = makeDb({ pushes: [], activitySpy })
    const interaction = { _id: 'h'.repeat(24), type: 'NOTE', description: 'front desk note', created: secs('2026-07-04T09:00:00Z') }
    await syncGlofoxInteractions(db, 'l1', 'c1', [interaction])
    expect(activitySpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify fail** — the new block fails (current `syncGlofoxInteractions` upserts everything).

- [ ] **Step 3: Implement** — modify `syncGlofoxInteractions`: load this contact's ledger rows once (both unreconciled, for fingerprint matching, and the set of already-claimed `glofox_interaction_id`s, for id-skip); for each interaction, (a) if its `_id` is in the claimed set → skip; (b) else if it matches an unreconciled push (`matchesPush`) → claim it (`update glofox_note_pushes set glofox_interaction_id=_id, status='reconciled' where id=push.id`), remove that push from the in-memory unreconciled list, and skip the activities upsert; (c) else upsert into activities as today. Import `matchesPush` from `./glofox-notes.js`.

```javascript
import { matchesPush } from './glofox-notes.js'

export async function syncGlofoxInteractions(db, locationId, contactId, interactions) {
  const result = { synced: 0, skipped: 0, errors: 0, reconciled: 0 }
  if (!db || !contactId || !locationId || !Array.isArray(interactions)) return result

  // GLOFOX-NOTES — load this contact's outbound pushes so we can recognise and
  // suppress our own echoes (a pushed note comes back on the inbound pull).
  let unreconciled = []
  const claimedIds = new Set()
  try {
    const { data: pushes } = await db
      .from('glofox_note_pushes')
      .select('id, contact_id, type, description, pushed_at, glofox_interaction_id')
      .eq('contact_id', contactId)
    for (const p of pushes || []) {
      if (p.glofox_interaction_id) claimedIds.add(p.glofox_interaction_id)
      else unreconciled.push(p)
    }
  } catch { /* ledger unavailable → behave as before (no reconciliation) */ }

  for (const i of interactions) {
    // (a) already claimed as ours on a previous run → never re-import.
    if (i && i._id && claimedIds.has(String(i._id))) { result.skipped++; continue }

    // (b) first sight of our echo → claim the ledger row, suppress the dupe.
    const matchIdx = unreconciled.findIndex((p) => matchesPush(i, p, contactId))
    if (matchIdx !== -1) {
      const push = unreconciled[matchIdx]
      try {
        await db.from('glofox_note_pushes')
          .update({ glofox_interaction_id: String(i._id), status: 'reconciled' })
          .eq('id', push.id)
        result.reconciled++
      } catch { result.errors++ }
      unreconciled.splice(matchIdx, 1)
      continue
    }

    // (c) genuine Glofox-originated interaction → upsert into activities.
    const row = mapGlofoxInteraction(i, contactId, locationId)
    if (!row) { result.skipped++; continue }
    const { error } = await db.from('activities').upsert(row, { onConflict: 'glofox_interaction_id' })
    if (error) result.errors++
    else result.synced++
  }
  return result
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/glofox-sync.test.js -t reconciliation`. Then the full glofox-sync suite (`npx vitest run src/lib/glofox-sync.test.js`) — the existing inbound tests must still pass (a contact with no ledger rows behaves exactly as before). Adjust the fake-db in the existing tests if they don't stub `glofox_note_pushes` (the `try/catch` around the ledger load means an unstubbed table degrades gracefully, but a throwing mock could still surface — prefer stubbing it to return `{ data: [] }`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/glofox-sync.js src/lib/glofox-sync.test.js
git commit -m "GLOFOX-NOTES — inbound sync claims + suppresses outbound echoes"
```

---

### Task 6: Extend outbound to logged call/email touchpoints

**Files:**
- Resolve + modify the route(s) that create call/email `activities` (candidates: `src/app/api/assistant/chat/route.js` `create_activity` tool; any `/api/activities` or `/api/contacts/[id]/activity` create route — run `grep -rn "from('activities').insert" src/app/api` and pick the human-touchpoint ones, EXCLUDING system-event writers listed in the design note).
- Test: alongside the chosen route, or a focused service test.

- [ ] **Step 1: Identify the create surface(s)** — Run:
```bash
grep -rn "from('activities').insert" src/app/api --include='*.js' | grep -v test
```
Qualifying = a human logging a call/email touchpoint (assistant `create_activity` with `type in call/email`; a manual "log activity" route if one exists). DISQUALIFYING = `kind:'event'` system writers (studio-management/unlock, tapo/toggle) and channel auto-logs (sms/whatsapp/email SENT records) — those must NOT push. Record the chosen file(s) in the commit message.

- [ ] **Step 2: Write the failing test** — for the chosen route, assert that creating a `type:'call'` (or `'email'`) task activity for a Glofox-linked contact invokes `pushNoteToGlofox` with `sourceTable:'activities'` and the mapped type (`call`/`email` → `NOTE`/`MANUAL_EMAIL`; a call has no Glofox create-type, so **calls map to `NOTE`** with the description carrying the call outcome, e.g. `[UN1T CRM · Jane] Call: keen to join`; emails map to `MANUAL_EMAIL`). Mock `@/lib/glofox-note-push`.

- [ ] **Step 3: Implement** — after the qualifying activity insert, fire-and-forget:

```javascript
// GLOFOX-NOTES — mirror a logged call/email touchpoint into Glofox. Calls have
// no Glofox create-type, so they go as NOTE with the outcome in the text;
// emails go as MANUAL_EMAIL. System events (kind:'event') never reach here.
const GLOFOX_PUSH_TYPES = { call: 'NOTE', email: 'MANUAL_EMAIL' }
if (record?.id && record.contact_id && record.kind === 'task' && GLOFOX_PUSH_TYPES[record.type]) {
  const label = record.type === 'call' ? 'Call' : 'Email'
  import('@/lib/glofox-note-push').then(({ pushNoteToGlofox }) =>
    pushNoteToGlofox(db, {
      contactId: record.contact_id,
      sourceTable: 'activities',
      sourceId: record.id,
      type: GLOFOX_PUSH_TYPES[record.type],
      authorName: user?.full_name || null,
      content: `${label}: ${record.note || record.subject || ''}`.trim(),
    }),
  ).catch(() => {})
}
```

- [ ] **Step 4: Run tests** — the route test + `npx vitest run src/lib/glofox-note-push.test.js` (unchanged) pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "GLOFOX-NOTES — mirror logged call/email touchpoints to Glofox (notes stay unconditional; system events excluded)"
```

---

### Task 7: Inbound — Glofox notes in the CRM Notes view

**Files:**
- Modify: `src/app/contacts/[id]/page.js` (~line 319–322 unified list; ~line 366 overview / a Notes tab) and/or `src/components/ContactDetailTabs.jsx`

- [ ] **Step 1: Confirm current behaviour** — the page already merges `notes` + `activities` into a unified timeline (line 321-322), so Glofox NOTE interactions (activities, `type:'note'`, `source:'glofox'`) ALREADY appear on the timeline. Check the Notes-specific surface (the overview/Notes tab) — does it show only `notes`-table rows, or the merged set? Read the relevant tab render.

- [ ] **Step 2: Write/adjust** — if a Notes tab/section shows only `notes`-table rows, include Glofox NOTE activities so front-desk notes appear alongside CRM notes. Prefer a DERIVED merge in the render (don't copy Glofox notes into the `notes` table — that would create a re-push loop and duplicate storage). Add a small source chip ("Glofox") on inbound-note rows so provenance is clear. Since this is presentation-only over already-fetched data, verify by reading the rendered output; no new query.

- [ ] **Step 3: Verify** — `npm run dev`, open a Stillorgan contact with a Glofox note, confirm it shows in the Notes view with a Glofox source chip and that CRM-authored notes are unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/app/contacts/[id]/page.js src/components/ContactDetailTabs.jsx
git commit -m "GLOFOX-NOTES — Glofox notes render in the contact Notes view (derived, not duplicated)"
```

---

### Task 8: Docs, CI mirror, build, PR

- [ ] **Step 1: CHANGELOG** — add the next numbered entry to `docs/CHANGELOG.md`: two-way notes sync; inbound already existed (extended to Notes view); outbound fire-and-forget create-only (no edit/delete — API has none), 500-char truncation + author prefix, ledger-based echo suppression; mig 371; scoping (notes always, call/email tasks only, system events excluded); Glofox-linked contacts only.

- [ ] **Step 2: REFERENCE.md** — under the Glofox integration section, document the interactions endpoint constraints (create+list only, ≤500, no author, no webhook), the `glofox_note_pushes` ledger + echo-reconciliation flow, and the outbound scope rule.

- [ ] **Step 3: Full CI mirror + build**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`
Expected: all green. (`check:route-guards` will see the modified `/api/notes` + activity route — they already have auth; no new route added.)

- [ ] **Step 4: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```
Report the PR URL.

---

### Task 9: Post-deploy smoke test (after merge + deploy)

- [ ] **Step 1: Outbound** — on a Stillorgan Glofox-linked contact, add a CRM note. Within a moment confirm a `glofox_note_pushes` row (`status='sent'`) and that the note appears in Glofox's member interactions.
- [ ] **Step 2: Echo suppression** — trigger a member sync for that contact (or wait for the nightly/webhook). Confirm the ledger row flips to `status='reconciled'` with a `glofox_interaction_id`, and that the note appears exactly ONCE in the CRM (no timeline duplicate).
- [ ] **Step 3: Inbound** — add a note at the Glofox front desk for a member; after their next sync, confirm it lands on the CRM timeline + Notes view (as inbound already does).
- [ ] **Step 4: Truncation** — push a >500-char CRM note; confirm Glofox receives the 500-char ellipsis version and the ledger row has `truncated=true`.

---

## Self-review notes

- **Spec coverage:** inbound → Notes view (Task 7, mostly pre-existing) ✓; outbound notes (Task 4) ✓; outbound call/email (Task 6) ✓; fire-and-forget create-only ✓ (no edit/delete anywhere by design); echo suppression (Tasks 2+5) ✓; 500-char + author (Task 3) ✓; Glofox-linked-only (Task 4) ✓; system-event exclusion (Task 6 design note) ✓.
- **Known limitation (documented, not a gap):** edits/deletes of a CRM note after the first push do NOT propagate to Glofox — the API has no edit/delete. Accepted (Richard, 2026-07-04).
- **Load-bearing sequencing:** the echo ledger (Task 2) + reconciliation (Task 5) MUST land before/with the outbound push (Task 4) is enabled in prod, or the first pushed note double-shows until reconciled. All ship in one PR, so order within the PR is fine; do not cherry-pick Task 4 alone.
- **Open item flagged for review:** call→NOTE mapping (Glofox has no "call" create-type) — calls are pushed as NOTE with a "Call:" prefix. Confirm that's the desired representation vs. not pushing calls at all.
