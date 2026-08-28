# Mail Surface — Gmail Treatment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `/communications/mail` as a real mail client — a folder rail, one-line conversation rows at Compact density, and full-text search — without changing the data model, the ingest path, or the IMAP write path.

**Architecture:** Three panes (rail | list | reading pane) replacing today's two. The rail absorbs the view pills and the account tabs that currently sit along the top. Rows collapse from three stacked lines to one, with a persisted density preference defaulting to Compact. Search is Postgres full-text over a generated `tsvector` on `email_inbox_messages`, resolved to ticket ids and then filtered **through the list route's existing scope query**, so search can never widen visibility.

**Tech Stack:** Next.js 16 App Router, React, Tailwind (`un1t-*` tokens), Supabase/PostgREST (`supabase-js` 2.112.2), Postgres FTS (`to_tsvector` + GIN), vitest + @testing-library/react.

---

## Decisions taken (say so now, reverse cheaply later)

- **Compact is the DEFAULT, and the toggle stays.** Richard asked for Compact over Comfortable. The toggle costs ~15 lines and preserves preview text for reading sessions; if he wants it gone, delete `MailDensityToggle` and hard-code `compact`.
- **Search spans views, never scope.** Typing a query searches Inbox *and* Archived (Gmail's behaviour — a folder is not a filing cabinet), but the scoping — location, visible mailboxes, `surface='inbox'`, unmerged — is byte-identical to the list's. That is the security-critical property of this plan.
- **No multi-select / bulk toolbar.** Each archive opens its own IMAP connection sequentially, so a 50-row bulk action is 50 connections and a partial failure is hard to report honestly. Revisit once `applyWriteback` batches.
- **No labels, stars, snooze, tabbed categories.** Each is a second lifecycle to keep in step with `status`.

## Files

| File | Responsibility |
|---|---|
| `supabase/migrations/576_email_message_search.sql` | **Create.** Generated `search_tsv` column + GIN index. |
| `src/app/api/email/mail/_search.js` | **Create.** `searchTicketIds()` — query → candidate ticket ids. No scoping decisions of its own. |
| `src/app/api/email/mail/_search.test.js` | **Create.** Its unit tests. |
| `src/app/api/email/mail/route.js` | **Modify.** Accept `q`, intersect with the existing scoped query, report `search_partial`. |
| `src/app/api/email/mail/route.test.js` | **Modify.** Search scoping + cross-view tests. |
| `src/components/mail/mail-display.js` | **Modify.** Density constants + SSR-safe persistence helpers. |
| `src/components/mail/mail-display.test.js` | **Modify.** Their unit tests. |
| `src/components/mail/MailRail.jsx` | **Create.** Views + accounts + counts. Presentational. |
| `src/components/mail/MailRail.test.jsx` | **Create.** Its tests. |
| `src/components/mail/MailList.jsx` | **Modify.** One-line row, density prop, search-empty state. |
| `src/components/mail/MailList.test.jsx` | **Modify.** Row shape + density tests. |
| `src/components/mail/MailSurface.jsx` | **Modify.** Wire rail + search + density; delete the top tab strip and view pills. Shrinks — it is 830 lines today. |
| `src/components/mail/MailSurface.test.jsx` | **Modify.** Integration tests. |
| `src/lib/openapi.js` | **Modify.** Document `q` and `search_partial`. |
| `docs/CHANGELOG.md` | **Modify.** One entry. |

---

## Task 0: Branch

- [ ] **Step 1: Branch off fresh `origin/main`**

`main` is branch-protected and the previous mail work is already merged, so this must be a NEW branch — pushing to a merged branch strands the commit.

```bash
cd /Users/richardivers/code/un1t-crm/.claude/worktrees/inbox-surface
git fetch origin main
git checkout -b mail-gmail-treatment origin/main
```

Expected: `Switched to a new branch 'mail-gmail-treatment'`

---

## Task 1: Migration 576 — the search index

**Files:**
- Create: `supabase/migrations/576_email_message_search.sql`

- [ ] **Step 1: Write the migration**

```sql
-- MAIL-SEARCH.1 — full-text search for the Mail surface.
-- Extends mig 394 (email_inbox_messages).
--
-- ══ WHY A GENERATED COLUMN AND NOT A QUERY-TIME to_tsvector ═════════
-- A to_tsvector() computed per row per query cannot use an index, so every
-- search would be a sequential scan over every message body in the estate.
-- STORED + GIN makes it an index lookup. The column is derived, never written
-- by the application, and cannot drift from its source.
--
-- 🔴 THE 2-ARGUMENT FORM IS LOAD-BEARING. `to_tsvector(text)` (one arg) reads
-- default_text_search_config at run time and is therefore NOT IMMUTABLE, and
-- Postgres refuses a non-immutable expression in a generated column with a
-- confusing "generation expression is not immutable". `to_tsvector('english',
-- text)` pins the config, is immutable, and is the only form that works here.
--
-- 🔴 html_body IS DELIBERATELY EXCLUDED. It is markup — tags, inline CSS,
-- tracking-pixel URLs, base64 — and indexing it would fill the vector with
-- lexemes no operator will ever type while making every row's index entry many
-- times larger. text_body carries the words a human wrote.
--
-- Adding a STORED generated column REWRITES the table. Today that is 43 rows /
-- 448 kB, i.e. instant. It will not always be; if this ever has to be redone at
-- scale, do it as add-nullable → backfill in batches → swap.

ALTER TABLE public.email_inbox_messages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(subject, '') || ' ' ||
      coalesce(from_email, '') || ' ' ||
      coalesce(text_body, '')
    )
  ) STORED;

COMMENT ON COLUMN public.email_inbox_messages.search_tsv IS
  'MAIL-SEARCH.1: full-text index over subject + from_email + text_body, for the Mail surface search box. GENERATED, so nothing writes it and it cannot drift. html_body is excluded on purpose — it is markup, and indexing it buries real words under tags and inline CSS. 🔴 The two-argument to_tsvector is required: the one-argument form is not IMMUTABLE and Postgres will refuse it in a generated column. Searching is scoped by the LIST ROUTE, never by this column — see src/app/api/email/mail/_search.js.';

-- GIN is the right index for a tsvector that is read far more than written.
CREATE INDEX IF NOT EXISTS email_inbox_messages_search_tsv_gin
  ON public.email_inbox_messages USING gin (search_tsv);

-- The search resolves messages to their conversation and the route then filters
-- those ids through its own scope query, so this supporting index is on the
-- join column, scoped by location to match how it is always read.
CREATE INDEX IF NOT EXISTS email_inbox_messages_location_ticket_idx
  ON public.email_inbox_messages (location_id, ticket_id)
  WHERE ticket_id IS NOT NULL;
```

- [ ] **Step 2: Verify the generated expression is accepted**

Migrations are applied by the orchestrator via Supabase MCP, not by this task. Confirm the SQL parses and the immutability rule holds by reading it back — a non-immutable expression fails at `apply_migration` time with `42P17`.

Run: `grep -c "to_tsvector($" supabase/migrations/576_email_message_search.sql`
Expected: `0` — every call must be the two-argument form.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/576_email_message_search.sql
git commit -m "MAIL-SEARCH.1 — mig 576: generated search_tsv + GIN over email_inbox_messages"
```

---

## Task 2: `searchTicketIds()` — query to candidate ids

**Files:**
- Create: `src/app/api/email/mail/_search.js`
- Test: `src/app/api/email/mail/_search.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// MAIL-SEARCH.1 — the search helper answers ONE question: which conversations
// at this location contain this text? It applies NO visibility scoping and is
// not allowed to: the list route filters these ids through the same query it
// uses for an unsearched page, so there is exactly one authority on who may see
// what. A second scoping implementation here is how search becomes an IDOR.
import { describe, it, expect, vi } from 'vitest'
import { searchTicketIds, SEARCH_SCAN_LIMIT, normalizeQuery } from './_search'

function makeDb(rows, error = null) {
  const calls = []
  const b = {
    calls,
    select(cols) { calls.push(['select', cols]); return b },
    eq(col, val) { calls.push(['eq', col, val]); return b },
    not(col, op, val) { calls.push(['not', col, op, val]); return b },
    textSearch(col, q, opts) { calls.push(['textSearch', col, q, opts]); return b },
    limit(n) { calls.push(['limit', n]); return b },
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error }).then(resolve, reject)
    },
  }
  return { from(table) { calls.push(['from', table]); return b }, _b: b }
}

describe('normalizeQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeQuery('  membership   freeze ')).toBe('membership freeze')
  })

  it('answers null for anything with no searchable content', () => {
    expect(normalizeQuery('')).toBeNull()
    expect(normalizeQuery('   ')).toBeNull()
    expect(normalizeQuery(null)).toBeNull()
    expect(normalizeQuery(undefined)).toBeNull()
  })

  // A one-character query matches most of the corpus and costs a full scan to
  // say so. Two is the shortest thing worth running.
  it('answers null for a single character', () => {
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery('ab')).toBe('ab')
  })
})

describe('searchTicketIds', () => {
  it('returns the DISTINCT ticket ids of matching messages', async () => {
    const db = makeDb([
      { ticket_id: 't1' }, { ticket_id: 't2' }, { ticket_id: 't1' },
    ])
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ok).toBe(true)
    expect(out.ids.sort()).toEqual(['t1', 't2'])
  })

  it('scopes to the location and to messages that HAVE a conversation', async () => {
    const db = makeDb([{ ticket_id: 't1' }])
    await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(db._b.calls).toContainEqual(['from', 'email_inbox_messages'])
    expect(db._b.calls).toContainEqual(['eq', 'location_id', 'loc-1'])
    expect(db._b.calls).toContainEqual(['not', 'ticket_id', 'is', null])
  })

  it('uses websearch syntax so quotes and OR behave the way an operator expects', async () => {
    const db = makeDb([])
    await searchTicketIds(db, { locationId: 'loc-1', q: '"membership freeze"' })
    const ts = db._b.calls.find(c => c[0] === 'textSearch')
    expect(ts[1]).toBe('search_tsv')
    expect(ts[2]).toBe('"membership freeze"')
    expect(ts[3]).toEqual({ type: 'websearch', config: 'english' })
  })

  // 🔴 The 1,000-row cap applies to every select. A broad query truncates, and
  // a truncated search reported as complete is a conversation the operator is
  // told does not exist.
  it('flags a truncated scan rather than silently returning a suffix', async () => {
    const rows = Array.from({ length: SEARCH_SCAN_LIMIT }, (_, i) => ({ ticket_id: `t${i}` }))
    const db = makeDb(rows)
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'the' })
    expect(out.partial).toBe(true)
  })

  it('is not partial when the scan came back under the cap', async () => {
    const db = makeDb([{ ticket_id: 't1' }])
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.partial).toBe(false)
  })

  // A failed search must never read as "no results" — that is the same class as
  // reporting an unreadable mailbox as an empty inbox.
  it('reports a query failure instead of answering an empty result set', async () => {
    const db = makeDb(null, { message: 'boom' })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/boom/)
  })

  it('answers "no query" rather than searching for nothing', async () => {
    const db = makeDb([])
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: '  ' })
    expect(out.ok).toBe(true)
    expect(out.skipped).toBe(true)
    expect(db._b.calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/email/mail/_search.test.js`
Expected: FAIL — `Failed to resolve import "./_search"`

- [ ] **Step 3: Write the implementation**

```js
// MAIL-SEARCH.1 — text query → candidate conversation ids.
//
// 🔴 THIS MODULE APPLIES NO VISIBILITY SCOPING, AND MUST NOT LEARN ANY.
// It answers exactly one question: which conversations at this location contain
// this text? The list route then filters those ids through the SAME query it
// runs for an unsearched page — location, visible mailboxes, surface='inbox',
// unmerged — so there is one authority on who may see what. A second scoping
// implementation in here is precisely how a search box becomes an IDOR: the two
// copies drift, and the one nobody is looking at is the one that widens.
//
// The `location_id` filter below is a PERFORMANCE bound, not a security one.
// Deleting it would not leak anything (the route still filters), but it would
// scan every studio's mail to answer one studio's search.

/**
 * How many message rows one search may scan. Every PostgREST select caps at
 * 1,000 regardless of what is asked for, so this is stated rather than
 * discovered — and when the cap is HIT the caller is told, because a truncated
 * search reported as complete is a conversation the operator is told does not
 * exist.
 */
export const SEARCH_SCAN_LIMIT = 1000

/**
 * The query an operator actually typed, or null when there is nothing worth
 * running. A single character matches most of the corpus and costs a full scan
 * to say so.
 */
export function normalizeQuery(raw) {
  const q = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return q.length >= 2 ? q : null
}

/**
 * @returns {Promise<
 *   {ok: true, skipped: true, ids: [], partial: false} |
 *   {ok: true, skipped: false, ids: string[], partial: boolean} |
 *   {ok: false, error: string}
 * >}
 */
export async function searchTicketIds(db, { locationId, q }) {
  const query = normalizeQuery(q)
  if (!query || !locationId) {
    return { ok: true, skipped: true, ids: [], partial: false }
  }

  const { data, error } = await db.from('email_inbox_messages')
    .select('ticket_id')
    .eq('location_id', locationId)
    // A message with no conversation cannot be shown in a conversation list.
    .not('ticket_id', 'is', null)
    // `websearch` is the syntax a person already knows from every search box:
    // quoted phrases, OR, and a leading minus to exclude. `plain` would treat a
    // quoted phrase as loose words and quietly return the wrong thing.
    .textSearch('search_tsv', query, { type: 'websearch', config: 'english' })
    .limit(SEARCH_SCAN_LIMIT)

  if (error) return { ok: false, error: error.message }

  const rows = data || []
  const ids = Array.from(new Set(rows.map(r => r.ticket_id).filter(Boolean)))
  return { ok: true, skipped: false, ids, partial: rows.length >= SEARCH_SCAN_LIMIT }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/email/mail/_search.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/app/api/email/mail/_search.js src/app/api/email/mail/_search.test.js
git commit -m "MAIL-SEARCH.2 — searchTicketIds(): text query to candidate conversation ids"
```

---

## Task 3: Wire search into the list route

**Files:**
- Modify: `src/app/api/email/mail/route.js`
- Test: `src/app/api/email/mail/route.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/email/mail/route.test.js`:

```js
// MAIL-SEARCH.3 — search narrows, it NEVER widens.
describe('GET /api/email/mail — search', () => {
  it('🔴 cannot reach a conversation on a mailbox the caller may not see', async () => {
    // T_ACCOUNTS lives on the TICKET surface, so the mail surface must not list
    // it — with or without a query. If search bypassed the scope query this
    // would return it, which is the whole reason the ids are intersected rather
    // than trusted.
    setupDb(mailState({ tickets: [{ ...T_STUDIO }, { ...T_ACCOUNTS }] }))
    searchTicketIds.mockResolvedValue({
      ok: true, skipped: false, partial: false,
      ids: [T_STUDIO.id, T_ACCOUNTS.id],
    })

    const { body } = await list(`?location_id=${LOC_A}&q=freeze`)

    expect(ids(body.data.conversations)).toEqual([T_STUDIO.id])
  })

  it('searches across views — an archived conversation is still findable', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO, status: 'closed' }] }))
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, partial: false, ids: [T_STUDIO.id] })

    // The inbox view would normally exclude a closed conversation.
    const { body } = await list(`?location_id=${LOC_A}&view=inbox&q=freeze`)

    expect(ids(body.data.conversations)).toEqual([T_STUDIO.id])
  })

  it('answers an empty page when nothing matched, without running an unfiltered query', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, partial: false, ids: [] })

    const { body } = await list(`?location_id=${LOC_A}&q=zzzz`)

    expect(body.success).toBe(true)
    expect(body.data.conversations).toEqual([])
  })

  it('surfaces a FAILED search as an error, never as no results', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    searchTicketIds.mockResolvedValue({ ok: false, error: 'boom' })

    const { res, body } = await list(`?location_id=${LOC_A}&q=freeze`)

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
  })

  it('passes search_partial through so the list can say the scan was truncated', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    searchTicketIds.mockResolvedValue({ ok: true, skipped: false, partial: true, ids: [T_STUDIO.id] })

    const { body } = await list(`?location_id=${LOC_A}&q=the`)

    expect(body.data.search_partial).toBe(true)
  })

  it('does not search at all when no query was given', async () => {
    setupDb(mailState({ tickets: [{ ...T_STUDIO }] }))
    await list(`?location_id=${LOC_A}`)
    expect(searchTicketIds).not.toHaveBeenCalled()
  })
})
```

Add to the top of the file, beside the existing mocks:

```js
vi.mock('./_search', () => ({
  searchTicketIds: vi.fn(),
  SEARCH_SCAN_LIMIT: 1000,
}))
```

and to the imports:

```js
import { searchTicketIds } from './_search'
```

and inside the existing `beforeEach`:

```js
searchTicketIds.mockResolvedValue({ ok: true, skipped: true, ids: [], partial: false })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/email/mail/route.test.js`
Expected: FAIL — `search_partial` is `undefined`, and the scoping test returns both conversations

- [ ] **Step 3: Implement in the route**

In `src/app/api/email/mail/route.js`, add the import beside the existing helper imports:

```js
import { searchTicketIds } from './_search'
```

Read the parameter next to where `before` is read:

```js
  // MAIL-SEARCH.3 — the query an operator typed, or absent. See below for why
  // it deliberately overrides `view`.
  const q = searchParams.get('q')
```

Immediately **after** `query = query.in('mailbox_id', scopeIds)` and **before** `applyView`, insert:

```js
  // ══ SEARCH ═══════════════════════════════════════════════════════════════
  // 🔴 INTERSECTED WITH THE SCOPE QUERY, NEVER SUBSTITUTED FOR IT. Everything
  // above this line — location, visible mailboxes, surface, unmerged — still
  // applies; search can only ever REMOVE rows from that set. _search.js is
  // deliberately scope-free for the same reason: two copies of "who may see
  // what" drift, and the copy nobody is looking at is the one that widens.
  //
  // It also OVERRIDES the view. A folder is not a filing cabinet: an operator
  // searching for a member's name wants the answer whether it is in the inbox
  // or archived, which is what every mail client does. Merged tombstones stay
  // excluded — scopeToUnmerged is applied above and is not a view.
  let searchPartial = false
  const searched = await searchTicketIds(db, { locationId, q })
  if (!searched.ok) {
    // A failed search is NOT "no results". Reporting it as an empty list would
    // tell the operator a member's mail does not exist.
    return NextResponse.json(
      { success: false, error: 'Could not search this mailbox — try again' },
      { status: 500 },
    )
  }
  if (!searched.skipped) {
    searchPartial = searched.partial
    query = query.in('id', searched.ids)
  } else {
    query = applyView(query, view)
  }
```

Then **delete** the now-duplicated line further down:

```js
  query = applyView(query, view)
```

Finally add `search_partial` to the response payload beside `counts_partial`:

```js
      search_partial: searchPartial,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/email/mail`
Expected: PASS — all existing tests plus 6 new

- [ ] **Step 5: Mutation-check the scoping guard**

The security property has to actually bite. Temporarily change `query.in('id', searched.ids)` to `db.from('email_tickets').select('*').in('id', searched.ids)` (i.e. drop the scope) and re-run.

Run: `npx vitest run src/app/api/email/mail/route.test.js`
Expected: FAIL on "cannot reach a conversation on a mailbox the caller may not see". **Restore the line.**

- [ ] **Step 6: Commit**

```bash
git add src/app/api/email/mail/route.js src/app/api/email/mail/route.test.js
git commit -m "MAIL-SEARCH.3 — search intersects the scope query and overrides the view"
```

---

## Task 4: Density preference

**Files:**
- Modify: `src/components/mail/mail-display.js`
- Test: `src/components/mail/mail-display.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/components/mail/mail-display.test.js`:

```js
import { DENSITIES, DEFAULT_DENSITY, readDensity, writeDensity, MAIL_DENSITY_KEY } from './mail-display'

describe('density preference', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('defaults to compact — the density Richard asked for', () => {
    expect(DEFAULT_DENSITY).toBe('compact')
    expect(DENSITIES).toEqual(['compact', 'comfortable'])
  })

  it('reads a stored preference back', () => {
    window.localStorage.setItem(MAIL_DENSITY_KEY, 'comfortable')
    expect(readDensity()).toBe('comfortable')
  })

  it('falls back to the default for anything it does not recognise', () => {
    window.localStorage.setItem(MAIL_DENSITY_KEY, 'enormous')
    expect(readDensity()).toBe('compact')
  })

  it('round-trips a write', () => {
    writeDensity('comfortable')
    expect(readDensity()).toBe('comfortable')
  })

  it('refuses to store a value that is not a density', () => {
    writeDensity('enormous')
    expect(window.localStorage.getItem(MAIL_DENSITY_KEY)).toBeNull()
  })

  // Storage throws outright in a locked-down browser or a private window. A
  // display preference is never worth taking the surface down for.
  it('survives storage being unavailable, in both directions', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(readDensity()).toBe('compact')
    expect(() => writeDensity('comfortable')).not.toThrow()
    get.mockRestore(); set.mockRestore()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/mail/mail-display.test.js`
Expected: FAIL — `DEFAULT_DENSITY is not defined`

- [ ] **Step 3: Implement**

Append to `src/components/mail/mail-display.js`:

```js
/* ─────────────────────────── row density ─────────────────────────── */

/**
 * MAIL-DENSITY.1 — how much of a conversation one row shows.
 *
 * `compact` is one line: sender, subject, preview and date, ~31px. `comfortable`
 * is the same line with the preview given room to breathe. Compact is the
 * DEFAULT because that is what Richard asked for after seeing both; the toggle
 * exists because the right answer differs between triaging a morning's mail and
 * reading one thread, and it is two lines of state to keep.
 */
export const DENSITIES = ['compact', 'comfortable']
export const DEFAULT_DENSITY = 'compact'
export const MAIL_DENSITY_KEY = 'un1t.mail.density'

/**
 * The stored preference, or the default.
 *
 * 🔴 EVERY ACCESS IS WRAPPED. localStorage is not merely absent during SSR — it
 * THROWS on access in a private window and under a "block site data" policy, so
 * an unguarded read takes the whole surface down over a display preference.
 */
export function readDensity() {
  try {
    if (typeof window === 'undefined') return DEFAULT_DENSITY
    const stored = window.localStorage.getItem(MAIL_DENSITY_KEY)
    return DENSITIES.includes(stored) ? stored : DEFAULT_DENSITY
  } catch {
    return DEFAULT_DENSITY
  }
}

/** Persist a density. Silently ignores anything that is not one. */
export function writeDensity(density) {
  if (!DENSITIES.includes(density)) return
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(MAIL_DENSITY_KEY, density)
  } catch {
    // A preference that could not be saved is a preference that resets next
    // visit. Never worth an error on screen.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/mail/mail-display.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/mail/mail-display.js src/components/mail/mail-display.test.js
git commit -m "MAIL-DENSITY.1 — density preference, compact by default, storage-safe"
```

---

## Task 5: `MailRail` — the folder rail

**Files:**
- Create: `src/components/mail/MailRail.jsx`
- Test: `src/components/mail/MailRail.test.jsx`

- [ ] **Step 1: Write the failing tests**

```jsx
// MAIL-RAIL.1 — the rail replaces the view pills AND the account tab strip that
// sat along the top of the surface. Presentational: props in, callbacks out.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import MailRail from './MailRail'

const MAILBOXES = [
  { id: 'mb-1', label: 'Studio', address: 'studio@un1t.com', is_default: true },
  { id: 'mb-2', label: 'Accounts', address: 'accounts@un1t.com' },
]

function renderRail(over = {}) {
  const props = {
    views: [
      { id: 'inbox', label: 'Inbox', count: 18 },
      { id: 'needs_reply', label: 'Needs reply', count: 1 },
      { id: 'archived', label: 'Archived', count: 11 },
    ],
    viewId: 'inbox',
    onView: vi.fn(),
    mailboxes: MAILBOXES,
    mailboxId: null,
    onMailbox: vi.fn(),
    locationLabel: 'Hatch Street',
    ...over,
  }
  render(<MailRail {...props} />)
  return props
}

beforeEach(() => cleanup())

describe('MailRail', () => {
  it('lists every view with its count', () => {
    renderRail()
    expect(screen.getByRole('button', { name: /Inbox/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Needs reply/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Archived/ })).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy()
  })

  it('marks the active view, and only it', () => {
    renderRail({ viewId: 'archived' })
    const current = screen.getAllByRole('button').filter(b => b.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toMatch(/Archived/)
  })

  it('calls back with the view id', () => {
    const p = renderRail()
    screen.getByRole('button', { name: /Archived/ }).click()
    expect(p.onView).toHaveBeenCalledWith('archived')
  })

  it('lists the accounts and calls back with the mailbox id', () => {
    const p = renderRail()
    screen.getByRole('button', { name: /Accounts/ }).click()
    expect(p.onMailbox).toHaveBeenCalledWith('mb-2')
  })

  // A count of zero is information — "nothing is waiting" — but a count that
  // could not be read is not, and rendering it as 0 would be a lie.
  it('renders a zero count but omits an unknown one', () => {
    renderRail({ views: [
      { id: 'inbox', label: 'Inbox', count: 0 },
      { id: 'needs_reply', label: 'Needs reply', count: null },
    ] })
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.queryByText('null')).toBeNull()
  })

  // One account is not a choice, and a switcher offering it is furniture.
  it('hides the account section when there is only one account', () => {
    renderRail({ mailboxes: [MAILBOXES[0]] })
    expect(screen.queryByText('Accounts')).toBeNull()
  })

  it('names the studio, so an operator with two locations knows whose mail this is', () => {
    renderRail()
    expect(screen.getByText('Hatch Street')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/mail/MailRail.test.jsx`
Expected: FAIL — `Failed to resolve import "./MailRail"`

- [ ] **Step 3: Implement**

```jsx
'use client'

// MAIL-RAIL.1 — the Mail surface's left rail.
//
// It replaces TWO things that used to sit along the top: the view pills
// (Inbox / Needs reply / Archived) and the account tab strip. Both are
// navigation between sets of the same mail, which is what a rail is for, and
// moving them off the top gives the list and the reading pane the full height.
// It is also where Gmail and Outlook put them, so there is nothing to learn.
//
// PRESENTATIONAL ONLY: every count is handed in and every click is handed back.
// It never fetches, so it can never disagree with the list about what is there.

import { Inbox, Clock, Archive, Circle, CircleDot } from 'lucide-react'

const VIEW_ICONS = { inbox: Inbox, needs_reply: Clock, archived: Archive }

function RailButton({ active, icon: Icon, label, count, warn, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? 'bg-un1t-bg font-semibold text-un1t-text ring-1 ring-inset ring-un1t-border'
          : 'text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      {Icon && <Icon size={14} className="shrink-0 opacity-80" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* A zero is information; an unknown count is not, and rendering it as 0
          would claim nothing is waiting when we simply could not find out. */}
      {typeof count === 'number' && (
        <span className={`text-[11px] tabular-nums ${warn && count > 0 ? 'font-semibold text-amber-700' : 'text-un1t-muted'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

export default function MailRail({
  views, viewId, onView,
  mailboxes = [], mailboxId, onMailbox,
  locationLabel,
}) {
  const manyAccounts = mailboxes.length > 1

  return (
    <nav
      aria-label="Mail folders"
      className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-un1t-border bg-un1t-surface p-2"
    >
      {locationLabel && (
        <p className="px-2 pb-2 pt-0.5 text-[10px] font-bold uppercase tracking-widest text-un1t-muted">
          {locationLabel}
        </p>
      )}

      {views.map(v => (
        <RailButton
          key={v.id}
          active={v.id === viewId}
          icon={VIEW_ICONS[v.id]}
          label={v.label}
          count={v.count}
          warn={v.id === 'needs_reply'}
          onClick={() => onView?.(v.id)}
        />
      ))}

      {manyAccounts && (
        <>
          <div className="mx-2 my-2 h-px bg-un1t-border" />
          <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-un1t-muted">
            Accounts
          </p>
          <RailButton
            active={!mailboxId}
            icon={CircleDot}
            label="All accounts"
            onClick={() => onMailbox?.(null)}
          />
          {mailboxes.map(m => (
            <RailButton
              key={m.id}
              active={m.id === mailboxId}
              icon={Circle}
              label={m.label || m.address}
              onClick={() => onMailbox?.(m.id)}
            />
          ))}
        </>
      )}
    </nav>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/mail/MailRail.test.jsx`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/components/mail/MailRail.jsx src/components/mail/MailRail.test.jsx
git commit -m "MAIL-RAIL.1 — folder rail replacing the view pills and account tabs"
```

---

## Task 6: The one-line row

**Files:**
- Modify: `src/components/mail/MailList.jsx`
- Test: `src/components/mail/MailList.test.jsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/components/mail/MailList.test.jsx`:

```jsx
import { DEFAULT_DENSITY } from './mail-display'

// MAIL-ROW.1 — the row is the whole redesign. Three stacked lines and a 32px
// avatar at ~88px became one line at ~31px, which is the difference between six
// conversations on screen and eighteen.
describe('MailList — the one-line row', () => {
  it('drops the avatar entirely', () => {
    renderList({ conversations: [conv({ requester_name: 'Ella Byrne' })] })
    // The initials block was the only thing rendering a bare two-letter node.
    expect(screen.queryByText('EB')).toBeNull()
  })

  it('puts sender, subject and preview on ONE row element', () => {
    renderList({ conversations: [conv({
      requester_name: 'Ella Byrne',
      subject: 'Membership freeze',
      last_message_preview: 'Can I freeze from Monday?',
    }) ] })
    const row = screen.getByRole('option')
    expect(row.textContent).toContain('Ella Byrne')
    expect(row.textContent).toContain('Membership freeze')
    expect(row.textContent).toContain('Can I freeze from Monday?')
  })

  it('hides the preview at compact density and shows it at comfortable', () => {
    renderList({ density: 'compact', conversations: [conv({ last_message_preview: 'Can I freeze from Monday?' })] })
    expect(screen.queryByText(/Can I freeze from Monday\?/)).toBeNull()

    cleanup()
    renderList({ density: 'comfortable', conversations: [conv({ last_message_preview: 'Can I freeze from Monday?' })] })
    expect(screen.getByText(/Can I freeze from Monday\?/)).toBeTruthy()
  })

  it('defaults to the stored default when no density is given', () => {
    expect(DEFAULT_DENSITY).toBe('compact')
    renderList({ conversations: [conv({ last_message_preview: 'hello there' })] })
    expect(screen.queryByText(/hello there/)).toBeNull()
  })

  // The one status this surface keeps, and the one thing a mail client cannot
  // tell you. It moves INLINE onto the row rather than onto its own chip line.
  it('keeps needs-reply inline on the row', () => {
    renderList({ conversations: [conv({ status: 'open', last_message_direction: 'inbound' })] })
    expect(screen.getByRole('option').textContent).toContain('Needs reply')
  })

  it('says so when a search returned nothing, rather than looking like an empty inbox', () => {
    renderList({ conversations: [], searchActive: true })
    expect(screen.getByText(/No mail matches/i)).toBeTruthy()
  })

  it('warns when the search scan was truncated', () => {
    renderList({ conversations: [conv()], searchActive: true, searchPartial: true })
    expect(screen.getByText(/only the first/i)).toBeTruthy()
  })
})
```

Extend the existing `renderList` helper to pass the new props through:

```jsx
function renderList(over = {}) {
  const props = {
    conversations: [conv()],
    density: undefined,
    searchActive: false,
    searchPartial: false,
    ...over,
  }
  render(<MailList {...props} />)
  return props
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/mail/MailList.test.jsx`
Expected: FAIL — the avatar test fails (initials still render), preview is always shown

- [ ] **Step 3: Implement the row**

Replace the `MailRow` return in `src/components/mail/MailList.jsx` with:

```jsx
  return (
    <div
      className={`group relative border-b border-un1t-border/60 transition-colors hover:bg-un1t-surface focus-within:bg-un1t-surface ${
        selected ? 'bg-un1t-surface' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(conversation)}
        aria-current={selected ? 'true' : undefined}
        className={`grid w-full grid-cols-[10px_7rem_1fr_auto] items-center gap-2 pr-16 text-left ${
          compact ? 'px-3 py-1' : 'px-3 py-2'
        }`}
      >
        {/* MAIL-ROW.1 — unread is a dot AND weight. The accent edge and the
            avatar are gone: at one line the weight carries it, and 32px of
            initials was a quarter of the row's height for no information. */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${unread ? 'bg-channel-em' : 'bg-transparent'}`}
          aria-hidden="true"
        />

        {/* Sender in a FIXED column, so names align down the page and the eye
            scans one edge rather than a ragged one. */}
        <span className={`truncate text-[13px] text-un1t-text ${unread ? 'font-bold' : 'font-normal'}`}>
          {name}
          {!countsUnavailable && count > 1 && (
            <span className="ml-1 text-[11px] font-normal text-un1t-muted">{count}</span>
          )}
        </span>

        <span className="min-w-0 truncate text-[13px]">
          {waiting && (
            <span className="mr-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
              Needs reply
            </span>
          )}
          {archived && (
            <span className="mr-1.5 rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
              Archived
            </span>
          )}
          {showMailbox && (
            <span
              className="mr-1.5 rounded bg-un1t-surface px-1.5 py-0.5 text-[10px] text-un1t-subtle ring-1 ring-inset ring-un1t-border"
              title={mailbox?.address || 'No mail account on this conversation'}
            >
              {mailboxLabel(mailbox)}
            </span>
          )}
          <span className={unread ? 'font-semibold text-un1t-text' : 'text-un1t-text'}>
            {conversation.subject || '(no subject)'}
          </span>
          {/* Compact drops the preview — that is the whole difference between
              the two densities, and it is what buys the extra rows. */}
          {!compact && (
            <span className="text-un1t-muted">
              {' — '}
              {conversation.last_message_direction === 'outbound' ? 'You: ' : ''}
              {conversation.last_message_preview || '—'}
            </span>
          )}
        </span>

        <span className={`justify-self-end whitespace-nowrap text-[11px] tabular-nums ${
          unread ? 'font-semibold text-un1t-subtle' : 'text-un1t-muted'
        }`}>
          {relativeTime(conversation.last_message_at || conversation.created_at)}
        </span>
      </button>
      {/* Row actions are unchanged — see below. */}
```

Add `compact` to `MailRow`'s props and derive it in `MailList`:

```jsx
import { DEFAULT_DENSITY } from './mail-display'
// …
export default function MailList({ density, searchActive = false, searchPartial = false, ...rest }) {
  const compact = (density || DEFAULT_DENSITY) === 'compact'
```

Pass `compact={compact}` into each `<MailRow />`, and add the two states above the rows:

```jsx
      {searchPartial && (
        <p className="border-b border-un1t-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700">
          This search matched more mail than one pass can read, so only the first results are shown. Narrow the search to see the rest.
        </p>
      )}
      {searchActive && conversations.length === 0 && (
        <p className="px-3 py-6 text-center text-[13px] text-un1t-subtle">
          No mail matches that search.
        </p>
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/mail/MailList.test.jsx`
Expected: PASS — existing tests plus 7 new

- [ ] **Step 5: Commit**

```bash
git add src/components/mail/MailList.jsx src/components/mail/MailList.test.jsx
git commit -m "MAIL-ROW.1 — one-line conversation rows with a density switch"
```

---

## Task 7: Wire the surface together

**Files:**
- Modify: `src/components/mail/MailSurface.jsx`
- Test: `src/components/mail/MailSurface.test.jsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/components/mail/MailSurface.test.jsx`:

```jsx
describe('MailSurface — rail, search and density', () => {
  it('renders the rail instead of the old tab strip', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    expect(screen.getByRole('navigation', { name: /Mail folders/i })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: /Mail accounts/i })).toBeNull()
  })

  it('sends the typed query to the list route, debounced', async () => {
    vi.useFakeTimers()
    renderSurface()
    await screen.findByText('Membership freeze')

    const box = screen.getByRole('searchbox', { name: /Search mail/i })
    fireEvent.change(box, { target: { value: 'freeze' } })
    // Nothing yet — a request per keystroke is a request per keystroke.
    expect(calls.filter(c => c.url.includes('q=freeze'))).toHaveLength(0)

    vi.advanceTimersByTime(400)
    await vi.runOnlyPendingTimersAsync()
    expect(calls.some(c => c.url.includes('q=freeze'))).toBe(true)
    vi.useRealTimers()
  })

  it('does not send q at all when the box is cleared', async () => {
    vi.useFakeTimers()
    renderSurface()
    await screen.findByText('Membership freeze')
    const box = screen.getByRole('searchbox', { name: /Search mail/i })

    fireEvent.change(box, { target: { value: 'freeze' } })
    vi.advanceTimersByTime(400)
    await vi.runOnlyPendingTimersAsync()
    calls.length = 0

    fireEvent.change(box, { target: { value: '' } })
    vi.advanceTimersByTime(400)
    await vi.runOnlyPendingTimersAsync()
    expect(calls.every(c => !c.url.includes('q='))).toBe(true)
    vi.useRealTimers()
  })

  it('starts compact and remembers a switch to comfortable', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: /Comfortable/i }))
    expect(window.localStorage.getItem('un1t.mail.density')).toBe('comfortable')
  })

  // The search box is a typing target, so the shortcut guard has to cover it —
  // typing "e" into search must not archive the open conversation.
  it('NEVER archives while the operator is typing in the search box', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    const box = screen.getByRole('searchbox', { name: /Search mail/i })
    fireEvent.keyDown(box, { key: 'e' })

    expect(postsTo('/archive')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/mail/MailSurface.test.jsx`
Expected: FAIL — no `navigation` landmark, no `searchbox`

- [ ] **Step 3: Implement**

In `src/components/mail/MailSurface.jsx`:

Add imports:

```jsx
import MailRail from './MailRail'
import { readDensity, writeDensity, DEFAULT_DENSITY } from './mail-display'
```

Add state beside the existing `useState` calls:

```jsx
  const [density, setDensity] = useState(DEFAULT_DENSITY)
  const [queryText, setQueryText] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchPartial, setSearchPartial] = useState(false)

  // Hydrated after mount, never during render: the server has no localStorage,
  // and reading it in the initial state would mismatch the server's HTML.
  useEffect(() => { setDensity(readDensity()) }, [])

  // 🔴 DEBOUNCED. Every keystroke is otherwise a full-text scan plus a
  // conversation-count pass, and a fast typist would queue eight of them to see
  // the result of the last.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(queryText.trim()), 350)
    return () => clearTimeout(t)
  }, [queryText])

  function chooseDensity(next) {
    setDensity(next)
    writeDensity(next)
  }
```

Include the query in the list URL (beside `viewId`), and read `search_partial` where `counts_partial` is read:

```jsx
  const listUrl = buildMailUrl({ locationId, mailboxId, viewId, q: debouncedQuery })
  // …inside loadList's success branch:
  setSearchPartial(!!body.data?.search_partial)
```

`buildMailUrl` must append `q` only when non-empty — an empty `q=` would make the route search for nothing:

```jsx
  if (q) params.set('q', q)
```

Replace the top tab strip and the view-pill row with the rail. In the render, change the two-pane wrapper:

```jsx
      <div className="flex min-h-0 flex-1">
        <MailRail
          views={[
            { id: 'inbox', label: 'Inbox', count: null },
            { id: 'needs_reply', label: 'Needs reply', count: needsReplyCount },
            { id: 'archived', label: 'Archived', count: null },
          ]}
          viewId={viewId}
          onView={changeView}
          mailboxes={mailboxes}
          mailboxId={mailboxId}
          onMailbox={changeMailbox}
          locationLabel={locationLabel}
        />
        <div
          className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-un1t-border md:w-[22rem] lg:w-[24rem]`}
        >
          <div className="flex items-center gap-2 border-b border-un1t-border px-2 py-1.5">
            <input
              type="search"
              role="searchbox"
              aria-label="Search mail"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Search mail"
              className="min-w-0 flex-1 rounded-md border border-un1t-border bg-un1t-surface px-2.5 py-1 text-[13px] text-un1t-text placeholder:text-un1t-muted focus:border-un1t-muted focus:outline-none"
            />
            <div className="flex shrink-0 overflow-hidden rounded-md border border-un1t-border">
              {['compact', 'comfortable'].map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => chooseDensity(d)}
                  aria-pressed={density === d}
                  className={`px-2 py-1 text-[11px] capitalize ${
                    density === d ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-bg text-un1t-subtle'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <MailList
            /* existing props unchanged */
            density={density}
            searchActive={!!debouncedQuery}
            searchPartial={searchPartial}
          />
        </div>
        {/* reading pane unchanged */}
```

- [ ] **Step 4: Confirm the shortcut guard already covers the search box**

`isTypingTarget` matches `INPUT`, so `<input type="search">` is covered and no change is needed. The test in Step 1 proves it rather than assuming it.

Run: `npx vitest run src/components/mail/MailSurface.test.jsx`
Expected: PASS — all tests including the typing guard

- [ ] **Step 5: Commit**

```bash
git add src/components/mail/MailSurface.jsx src/components/mail/MailSurface.test.jsx
git commit -m "MAIL-SURFACE.2 — three panes: rail, searchable list, reading pane"
```

---

## Task 8: Docs, gates, ship

**Files:**
- Modify: `src/lib/openapi.js`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Document `q` and `search_partial`**

In `src/lib/openapi.js`, extend the `/api/email/mail` GET entry's query schema:

```js
      q: z.string().optional(),
```

and append to its `description`:

```
 MAIL-SEARCH.1: `q` is a full-text search over subject, sender and plain-text body (Postgres `websearch` syntax — quoted phrases, OR, leading minus to exclude). It INTERSECTS the scope query rather than replacing it, so it can only ever remove conversations from what the caller may already see, and it OVERRIDES `view` so an archived conversation is still findable. `search_partial` is true when the scan hit its 1,000-row cap — a truncated search reported as complete is a conversation the operator is told does not exist.
```

- [ ] **Step 2: Add the CHANGELOG entry**

Append one entry to `docs/CHANGELOG.md` covering: mig 576, the rail, the one-line row, the compact default, and search's scoping property.

- [ ] **Step 3: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: all eleven green.

- [ ] **Step 4: Run the production build**

New components and a new import mean `next build` is not optional — vitest runs on mocked imports and will not catch an unresolvable one.

Run: `npm run build`
Expected: `✓ Compiled successfully`, with `/communications/mail` in the route list.

- [ ] **Step 5: Apply migration 576 BEFORE the deploy**

`search_tsv` is queried directly by `_search.js`, so an un-migrated database answers `42703` on every search. Apply via Supabase MCP against project `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects` — **not** the sentinel project `tpttqakxmyxrwnqjepfm`), then run `get_advisors` with `type: 'security'`.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```

Report the PR URL. Merging deploys.

---

## Self-review

**Spec coverage**

| Asked for | Task |
|---|---|
| Folder rail replacing tabs | 5, 7 |
| One-line rows | 6 |
| Compact preferred | 4 (default), 6 (render), 7 (toggle + persistence) |
| Search | 1, 2, 3, 6 (states), 7 (box), 8 (docs) |
| Keep needs-reply | 6 |
| Keep archive verb + keyboard map | unchanged; guarded by Task 7 Step 4 |
| Skip multi-select, labels/stars/snooze | deliberately absent — recorded under Decisions |

**Placeholders:** none — every code step carries the code.

**Type consistency:** `searchTicketIds` returns `{ok, skipped, ids, partial}` in Task 2 and is consumed with exactly those keys in Task 3. `DEFAULT_DENSITY` / `readDensity` / `writeDensity` / `MAIL_DENSITY_KEY` are defined in Task 4 and used under the same names in Tasks 6 and 7. `MailRail`'s props (`views`, `viewId`, `onView`, `mailboxes`, `mailboxId`, `onMailbox`, `locationLabel`) match its call site in Task 7.

**One risk worth naming:** Task 7 edits the largest file in the feature (830 lines). If it fights, extract the list column's header — search box plus density toggle — into `MailListHeader.jsx` rather than growing `MailSurface.jsx` further.
