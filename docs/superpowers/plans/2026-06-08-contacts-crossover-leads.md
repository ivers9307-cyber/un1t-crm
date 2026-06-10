# Crossover Contacts in the Studio Contacts List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio's contacts list shows contacts it owns **plus** contacts owned elsewhere that have any deal at it ("crossovers"), with each crossover row marked by its home-studio pill + that contact's tags.

**Architecture:** The contacts list is a service-role app-query filtered by `location_id`. A shared helper unions in contacts that have a deal at the active location and fetches their home-studio + tags. The union + context are applied identically in the server page (`contacts/page.js`) and the client search route (`/api/contacts/search` POST); `ContactsView` threads the context to `ContactsTable`, which renders the pill + chips. No RLS change, no migration.

**Tech Stack:** Next.js 16 (App Router; server page + client components), Supabase (service-role server client, PostgREST `.or()` / `.in()`), Zod, Vitest, Tailwind (`un1t-*` tokens).

**Spec:** `docs/superpowers/specs/2026-06-08-contacts-crossover-leads-design.md`
**Branch:** `contacts-crossover-leads` (spec already committed as the first commit).

---

## Testing approach (read first)

Repo convention: Vitest covers pure/lib helpers; components + pages + routes are verified by `npm run build` + manual. So:
- **Task 1** (the `contact-crossovers` lib) gets real TDD with **stub Supabase clients** (no DB).
- **Tasks 2–5** (page, route, two components) are verified by `npm run build` + a manual check on the live Hatch list.

> **Note on the spec's `markCrossovers`:** the spec mentioned a pure `markCrossovers` that flags rows. The plan drops it — the `crossoverContext` map (keyed by contact id, only crossovers) is itself the crossover signal, so the table keys off `crossoverContext[c.id]` presence. One source, DRY, and it means neither data path has to stamp a flag on rows.

Full CI mirror before push (Task 6): `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build`.

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/lib/contact-crossovers.js` | `crossoverContactIds` (deal-holders at a studio) + `fetchCrossoverContext` (home-studio + tags map) | Create |
| `src/lib/contact-crossovers.test.js` | Stub-db unit tests | Create |
| `src/app/contacts/page.js` | Union query + `location_id` field + context → ContactsView | Modify |
| `src/app/api/contacts/search/route.js` | Mirror union + context on POST list+count; return `crossoverContext` | Modify |
| `src/components/ContactsView.jsx` | Thread `crossoverContext` (server initial + client search) | Modify |
| `src/components/ContactsTable.jsx` | Home-studio pill + tag chips on crossover rows (desktop + mobile) | Modify |

---

## Task 1: `contact-crossovers` helper (TDD)

**Files:**
- Create: `src/lib/contact-crossovers.js`
- Test: `src/lib/contact-crossovers.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/contact-crossovers.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { crossoverContactIds, fetchCrossoverContext } from './contact-crossovers'

// Minimal chainable stub of the supabase builder. `result` is what the
// awaited query resolves to ({ data } or { data, count }).
function stubFrom(handlers) {
  return {
    from(table) {
      const calls = { table, filters: {} }
      const builder = {
        select() { return builder },
        eq(col, val) { calls.filters[col] = val; return builder },
        in(col, vals) { calls.filters[col] = vals; return builder },
        is(col, val) { calls.filters[`${col}__is`] = val; return builder },
        not() { return builder },
        order() { return builder },
        range(from, to) { calls.range = [from, to]; return builder },
        then(resolve) { return Promise.resolve(handlers[table](calls)).then(resolve) },
      }
      return builder
    },
  }
}

describe('crossoverContactIds', () => {
  it('returns the distinct contact_ids with a deal at the location (one page)', async () => {
    const db = stubFrom({
      deals: () => ({ data: [{ contact_id: 'a' }, { contact_id: 'b' }, { contact_id: 'a' }] }),
    })
    expect((await crossoverContactIds(db, 'loc1')).sort()).toEqual(['a', 'b'])
  })
  it('returns [] for missing args / empty result', async () => {
    expect(await crossoverContactIds(null, 'loc1')).toEqual([])
    const db = stubFrom({ deals: () => ({ data: [] }) })
    expect(await crossoverContactIds(db, 'loc1')).toEqual([])
  })
})

describe('fetchCrossoverContext', () => {
  const active = 'hatch'
  const contacts = [
    { id: 'c1', location_id: 'hatch' },        // owned — not a crossover
    { id: 'c2', location_id: 'stillorgan' },   // crossover
  ]
  it('maps home-studio + tags for crossover contacts only', async () => {
    const db = stubFrom({
      locations: () => ({ data: [{ id: 'stillorgan', name: 'UN1T Stillorgan' }] }),
      contact_tags: () => ({ data: [{ contact_id: 'c2', tag: 'member' }, { contact_id: 'c2', tag: 'vip' }] }),
    })
    const ctx = await fetchCrossoverContext(db, contacts, active)
    expect(ctx).toEqual({ c2: { homeStudio: 'UN1T Stillorgan', tags: ['member', 'vip'] } })
    expect(ctx.c1).toBeUndefined()
  })
  it('returns {} when there are no crossovers', async () => {
    const db = stubFrom({ locations: () => ({ data: [] }), contact_tags: () => ({ data: [] }) })
    expect(await fetchCrossoverContext(db, [{ id: 'c1', location_id: 'hatch' }], active)).toEqual({})
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/contact-crossovers.test.js`
Expected: FAIL — cannot resolve `./contact-crossovers`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/contact-crossovers.js`:
```js
// Crossover-contact helpers for the studio contacts list.
//
// A "crossover" is a contact OWNED by a different studio that nonetheless
// has a deal at the active studio. contacts.email is globally unique, so a
// person who's already a contact (e.g. a Stillorgan member) signing up via
// another studio's public lead form reuses their existing contact + gets a
// deal at the new studio. These helpers let the destination studio's
// contacts list surface those leads with their origin context.

const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000

// Distinct contact_ids that have ANY deal at this location. Paginated to
// respect PostgREST's 1k cap. Best-effort — returns [] on error/missing args.
export async function crossoverContactIds(db, locationId) {
  if (!db || !locationId) return []
  const ids = new Set()
  let pageStart = 0
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
      const { data, error } = await db
        .from('deals')
        .select('contact_id')
        .eq('location_id', locationId)
        .not('contact_id', 'is', null)
        .order('contact_id', { ascending: true })
        .range(pageStart, pageEnd)
      if (error || !Array.isArray(data) || data.length === 0) break
      for (const r of data) if (r.contact_id) ids.add(r.contact_id)
      if (data.length < PAGE_SIZE || ids.size >= HARD_LIMIT) break
      pageStart += PAGE_SIZE
    }
  } catch {
    return [...ids]
  }
  return [...ids]
}

// For the crossover contacts within `contacts` (owned elsewhere than
// activeLocationId), fetch their home-studio name + active tags. Returns
// { [contactId]: { homeStudio, tags } }. Best-effort — {} on error / none.
export async function fetchCrossoverContext(db, contacts, activeLocationId) {
  const crossovers = (Array.isArray(contacts) ? contacts : []).filter(
    (c) => c && c.location_id && activeLocationId && c.location_id !== activeLocationId
  )
  if (crossovers.length === 0) return {}
  const ids = crossovers.map((c) => c.id)
  const locIds = [...new Set(crossovers.map((c) => c.location_id))]
  try {
    const [{ data: locs }, { data: tagRows }] = await Promise.all([
      db.from('locations').select('id, name').in('id', locIds),
      db.from('contact_tags').select('contact_id, tag').in('contact_id', ids).is('removed_at', null),
    ])
    const locName = new Map((locs || []).map((l) => [l.id, l.name]))
    const tagsByContact = {}
    for (const r of tagRows || []) (tagsByContact[r.contact_id] ||= []).push(r.tag)
    const ctx = {}
    for (const c of crossovers) {
      ctx[c.id] = { homeStudio: locName.get(c.location_id) || 'Other studio', tags: tagsByContact[c.id] || [] }
    }
    return ctx
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/contact-crossovers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/contact-crossovers.js src/lib/contact-crossovers.test.js
git commit -m "feat(contacts): contact-crossovers helper (deal-holders + home-studio/tags context)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Server page — union query + context

**Files:**
- Modify: `src/app/contacts/page.js`

(No unit test — server page; verified by build + manual in Task 6.)

- [ ] **Step 1: Import the helpers**

Add after the existing imports in `src/app/contacts/page.js`:
```js
import { crossoverContactIds, fetchCrossoverContext } from '@/lib/contact-crossovers'
```

- [ ] **Step 2: Add `location_id` to the field set**

Change the `CONTACT_LIST_FIELDS` constant to include `location_id` (needed to detect crossovers):
```js
  const CONTACT_LIST_FIELDS = 'id, name, email, phone, lead_source, pipeline_stage_slug, trial_credits_remaining, created_at, location_id'
```

- [ ] **Step 3: Union the location filter**

Replace this line:
```js
  let query = db.from('contacts').select(CONTACT_LIST_FIELDS).eq('location_id', locationId).order('created_at', { ascending: false }).limit(200)
```
with (build the location/union filter BEFORE `.order().limit()`):
```js
  const crossIds = await crossoverContactIds(db, locationId)
  let query = db.from('contacts').select(CONTACT_LIST_FIELDS)
  query = crossIds.length > 0
    ? query.or(`location_id.eq.${locationId},id.in.(${crossIds.join(',')})`)
    : query.eq('location_id', locationId)
  query = query.order('created_at', { ascending: false }).limit(200)
```
(The existing `if (status)` / search `.or(...)` lines below stay unchanged — they compose on top.)

- [ ] **Step 4: Fetch the context + pass it to ContactsView**

Replace:
```js
  const { data: contacts } = await query
```
with:
```js
  const { data: contacts } = await query
  const crossoverContext = await fetchCrossoverContext(db, contacts || [], locationId)
```
Then add the `crossoverContext` prop to the `<ContactsView ... />` element:
```jsx
      <ContactsView
        initialContacts={contacts || []}
        locationId={locationId}
        crossoverContext={crossoverContext}
        initialStatus={status}
        initialSearch={search}
        canMerge={canMerge}
        canDelete={canDelete}
      />
```

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/app/contacts/page.js
git add src/app/contacts/page.js
git commit -m "feat(contacts): union crossover deal-holders into the contacts list query

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Search route — mirror the union + return context

**Files:**
- Modify: `src/app/api/contacts/search/route.js`

(No unit test — route reuses the tested helper; verified by build + manual.)

- [ ] **Step 1: Import the helpers**

Add to the imports at the top of `src/app/api/contacts/search/route.js`:
```js
import { crossoverContactIds, fetchCrossoverContext } from '@/lib/contact-crossovers'
```

- [ ] **Step 2: Add `location_id` to the route's field set**

In the POST handler, change its `CONTACT_LIST_FIELDS` to match the page (must stay in lock-step):
```js
  const CONTACT_LIST_FIELDS = 'id, name, email, phone, lead_source, pipeline_stage_slug, trial_credits_remaining, created_at, location_id'
```

- [ ] **Step 3: Union the location filter on BOTH queries**

Replace:
```js
  let listQuery = db.from('contacts')
    .select(CONTACT_LIST_FIELDS)
    .eq('location_id', locationId)
  let countQuery = db.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
```
with:
```js
  const crossIds = await crossoverContactIds(db, locationId)
  const applyLoc = (q) => crossIds.length > 0
    ? q.or(`location_id.eq.${locationId},id.in.(${crossIds.join(',')})`)
    : q.eq('location_id', locationId)
  let listQuery = applyLoc(db.from('contacts').select(CONTACT_LIST_FIELDS))
  let countQuery = applyLoc(db.from('contacts').select('id', { count: 'exact', head: true }))
```
(Everything below — the search `.or()` tokens, the audience filter, `.order().range()` — is unchanged and composes on top.)

- [ ] **Step 4: Fetch the context + return it**

Replace the success return:
```js
  return NextResponse.json({
    success: true,
    contacts: listRes.data || [],
    count: countRes.count ?? 0,
    limit,
    offset,
  })
```
with:
```js
  const crossoverContext = await fetchCrossoverContext(db, listRes.data || [], locationId)
  return NextResponse.json({
    success: true,
    contacts: listRes.data || [],
    crossoverContext,
    count: countRes.count ?? 0,
    limit,
    offset,
  })
```

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/app/api/contacts/search/route.js
git add src/app/api/contacts/search/route.js
git commit -m "feat(contacts/search): mirror crossover union + return crossoverContext

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `ContactsView` — thread the context

**Files:**
- Modify: `src/components/ContactsView.jsx`

(No unit test — client component; verified by build + manual.)

- [ ] **Step 1: Accept the new prop**

Add `crossoverContext = {}` to the `ContactsView` props destructure:
```js
export default function ContactsView({
  initialContacts,
  locationId,
  crossoverContext = {},
  initialStatus = '',
  initialSearch = '',
  canMerge = false,
  canDelete = false,
}) {
```

- [ ] **Step 2: Track the client-path context alongside `clientContacts`**

Immediately after the `const [clientContacts, setClientContacts] = useState(null)` line, add:
```js
  const [clientCrossoverContext, setClientCrossoverContext] = useState({})
```

- [ ] **Step 3: Capture it from the search response**

In `fetchContacts`, right after `setClientContacts(filtered)`, add:
```js
      setClientCrossoverContext(json.crossoverContext || {})
```

- [ ] **Step 4: Choose the active context + pass it to the table**

Immediately before the `return (` of the component, add:
```js
  // Use the client-path context when the API result is showing, else the
  // server-rendered initial context. Mirrors the clientContacts vs
  // initialContacts choice in visibleContacts.
  const activeCrossoverContext = clientContacts !== null ? clientCrossoverContext : crossoverContext
```
Then change the final `<ContactsTable ... />` to pass it:
```jsx
      <ContactsTable contacts={visibleContacts} locationId={locationId} crossoverContext={activeCrossoverContext} canMerge={canMerge} canDelete={canDelete} />
```

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/components/ContactsView.jsx
git add src/components/ContactsView.jsx
git commit -m "feat(contacts): thread crossoverContext through ContactsView

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `ContactsTable` — home-studio pill + tag chips

**Files:**
- Modify: `src/components/ContactsTable.jsx`

(No unit test — client component; verified by build + manual.)

- [ ] **Step 1: Accept the prop**

Change the `ContactsTable` props destructure to include `crossoverContext`:
```js
export default function ContactsTable({ contacts, locationId, crossoverContext = {}, canMerge = false, canDelete = false }) {
```

- [ ] **Step 2: Add a small render helper**

Add this component above `export default function ContactsTable` (after the `formatStage` function):
```jsx
// Crossover marker — a home-studio pill + that contact's tags, shown when
// the contact is owned by a different studio than the one being viewed.
function CrossoverMarker({ ctx }) {
  if (!ctx) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle ml-2">
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-700"
        title={`Owned by ${ctx.homeStudio} — shown here because they have a deal at this studio`}
      >
        {ctx.homeStudio}
      </span>
      {(ctx.tags || []).slice(0, 6).map((t) => (
        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-un1t-border text-un1t-subtle">{t}</span>
      ))}
    </span>
  )
}
```

- [ ] **Step 3: Render it in the desktop Name cell**

In the desktop table, change the Name `<td>`:
```jsx
                  <td className="p-3">
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                  </td>
```
to:
```jsx
                  <td className="p-3">
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                    <CrossoverMarker ctx={crossoverContext[c.id]} />
                  </td>
```

- [ ] **Step 4: Render it in the mobile card**

In the mobile card, change the name row:
```jsx
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-un1t-text truncate">
                          {c.name}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wider ${
                          statusBadge[c.pipeline_stage_slug] || 'bg-un1t-border text-un1t-subtle'
                        }`}>
                          {formatStage(c.pipeline_stage_slug)}
                        </span>
                      </div>
```
by adding the marker after the status badge `</span>` (still inside the flex-wrap div):
```jsx
                        <CrossoverMarker ctx={crossoverContext[c.id]} />
```

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/components/ContactsTable.jsx
git add src/components/ContactsTable.jsx
git commit -m "feat(contacts): show home-studio pill + tags on crossover rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Verify, build, ship

**Files:** none (verification + PR).

- [ ] **Step 1: Full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build
```
Expected: tests PASS (incl. the new `contact-crossovers` tests), lint clean (a pre-existing `ChooserEditorForm` warning may remain), parity + imports clean, `next build` succeeds.

- [ ] **Step 2: Manual check (local `npm run dev` or a Vercel preview)**

Sign in, switch active location to **Hatch Street**, open **Contacts**. Confirm:
- An existing Stillorgan member who has a Hatch deal (e.g. the founding-member crossover) now appears in the Hatch list with a **`UN1T Stillorgan`** pill + their tags.
- A Hatch-owned contact appears unchanged (no pill).
- The advanced-filter / search path also shows the pill (it goes through `/api/contacts/search`).
- Clicking a crossover opens their profile.
- Switching active location to **Stillorgan** shows Stillorgan-owned contacts as normal (no spurious pills on owned rows).

- [ ] **Step 3: Push + open the PR** (per `CLAUDE.md` ship loop)

```bash
git push -u origin contacts-crossover-leads
TOKEN=$(git config --get remote.origin.url | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ivers9307-cyber/un1t-crm/pulls \
  -d @- <<'JSON' | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('html_url') or r.get('message') or r)"
{
  "title": "CONTACTS-CROSSOVER.1 — surface other-studio deal-holders in the contacts list",
  "head": "contacts-crossover-leads",
  "base": "main",
  "body": "A studio's contacts list now shows contacts it owns **plus** contacts owned elsewhere that have any deal at it (\"crossovers\"), each marked with its home-studio pill + that contact's tags. Fixes existing-member crossovers from the public lead form being invisible in the destination studio's contacts list (contacts.email is globally unique → one contact per person).\n\nService-role app-query union (no RLS change, no migration), shared `contact-crossovers` helper mirrored across `contacts/page.js` + `/api/contacts/search`. Verified: tests (incl. new lib) · lint · parity · imports · build · manual on the Hatch list.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
}
JSON
```
Report the PR URL.

---

## Self-Review (completed by plan author)

**1. Spec coverage:** union query (owned ∪ deal-at-location) → Task 1 `crossoverContactIds` + Tasks 2/3; home-studio + tags context → Task 1 `fetchCrossoverContext` + Tasks 2/3; mirrored across both list paths → Tasks 2 + 3 (same `CONTACT_LIST_FIELDS` + union); pill + chips on crossover rows → Task 5; thread context → Task 4; no RLS/migration → confirmed (none). The spec's `markCrossovers` is intentionally subsumed by `crossoverContext` presence (documented in Testing approach).

**2. Placeholder scan:** none — every step shows complete code or an exact command.

**3. Type/name consistency:** `crossoverContactIds(db, locationId) → string[]` and `fetchCrossoverContext(db, contacts, activeLocationId) → { [id]: { homeStudio, tags } }` defined in Task 1 and used identically in Tasks 2 + 3. The `crossoverContext` prop flows page/route → `ContactsView` (Task 4) → `ContactsTable` (Task 5), keyed by `contact.id`. `CONTACT_LIST_FIELDS` gains `location_id` in BOTH Task 2 and Task 3 (kept in lock-step per the repo rule).
