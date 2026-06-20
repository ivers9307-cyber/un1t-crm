# Event-Registration Audience Filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Registered for event" filter to the audience selector so operators can message everyone signed up for a specific event, across email, SMS, WhatsApp, sequences, and the live audience count.

**Architecture:** `event_registration` is a **virtual audience field** (like the existing `tag`): it isn't a `contacts` column, so it's resolved async into a `contacts.id IN (…)` constraint by a new `resolveEventFilters`, chained into the existing `applyAudienceFilterAsync`. "Registered" = `race_registrations.status IN ('pending_payment','confirmed')` (excludes cancelled + no_show), registrants ∪ linked teammates. The sync count + SMS + WhatsApp callers are pointed at the async path (which also fixes the existing `tag` filter on those channels).

**Tech Stack:** Next.js 16 App Router, Supabase (PostgREST), Vitest. No migration, no new permission — pure read-side.

**Spec:** `docs/EVENT_AUDIENCE_FILTER_2026-06.md`

**Working directory:** `/Users/richardivers/code/un1t-crm-event-filter` (worktree on branch `event-audience-filter`). All paths below are repo-relative; run all commands from this directory.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/audience-filter.js` | Whitelist `event_registration`; `resolveEventFilters`; pure helpers `LIVE_REGISTRATION_STATUSES` + `mergeRegistrationContactIds`; chain into `applyAudienceFilterAsync` | Modify |
| `src/lib/audience-filter.test.js` | Unit tests for the above | Modify |
| `src/app/api/communications/audience-count/route.js` | Use async filter so the live count honours virtual fields | Modify |
| `src/lib/sms.js` | `buildSmsAudienceAsync`; `sendBroadcast` uses it | Modify |
| `src/lib/sms.test.js` | Test the async builder | Modify |
| `src/lib/whatsapp.js` | `buildWhatsAppAudienceAsync`; `fetchAllWhatsAppAudience` + `sendBroadcast` use it | Modify |
| `src/lib/whatsapp-audience.test.js` | Test the async builder | Modify |
| `src/app/api/communications/events/route.js` | List the active location's events for the filter dropdown | Create |
| `src/app/api/communications/events/route.test.js` | Auth gates + happy path | Create |
| `src/components/AudienceBuilder.jsx` | "Registered for event" field + `event-select` widget + options fetch | Modify |

---

## Task 1: Whitelist the `event_registration` virtual field

**Files:**
- Modify: `src/lib/audience-filter.js`
- Test: `src/lib/audience-filter.test.js`

- [ ] **Step 1: Write failing tests**

Add to `src/lib/audience-filter.test.js`, inside the existing `describe('AUDIENCE_FIELDS allowlist', …)` block (after the `tag` test ~line 240):

```js
  it('exposes the event_registration field with eq/neq operators', () => {
    expect(AUDIENCE_FIELDS).toHaveProperty('event_registration')
    expect(AUDIENCE_FIELDS.event_registration.type).toBe('event')
    expect(AUDIENCE_FIELDS.event_registration.ops).toEqual(['eq', 'neq'])
  })
```

And add a new `describe` block after the existing `describe('applyAudienceFilter — tag is a virtual field', …)` block (~line 264). It reuses the file's existing `makeMockQuery()` helper:

```js
describe('applyAudienceFilter — event_registration is a virtual field', () => {
  it('skips event_registration clauses (resolveEventFilters does the work)', () => {
    const q = makeMockQuery()
    applyAudienceFilter(q.query, {
      filters: [
        { field: 'event_registration', op: 'eq', value: 'evt-1' },
        { field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' },
      ],
    })
    expect(q.calls).toEqual([['eq', 'pipeline_stage_slug', 'active_member']])
  })

  it('still validates the operator allowlist for event_registration', () => {
    const q = makeMockQuery()
    expect(() => applyAudienceFilter(q.query, {
      filters: [{ field: 'event_registration', op: 'contains', value: 'evt' }],
    })).toThrow(/not allowed on field "event_registration"/)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run src/lib/audience-filter.test.js -t event_registration`
Expected: FAIL — `event_registration` not in `AUDIENCE_FIELDS`; the skip test throws `Unknown audience field`.

- [ ] **Step 3: Add the field to the whitelist + skip it in the sync loop**

In `src/lib/audience-filter.js`, add this entry to `AUDIENCE_FIELDS` immediately after the `tag:` line (~line 137), before the PILLAR2 `id:` entry:

```js
  // EVENT-FILTER — virtual field. 'event_registration' is not a
  // contacts column; resolveEventFilters() pre-fetches the contact_ids
  // registered for the chosen event (race_registrations.status IN
  // pending_payment/confirmed, registrants + linked teammates) and the
  // caller injects them as an id IN (…) constraint. The builder's value
  // is a race_events UUID. eq = registered for; neq = not registered for.
  event_registration:        { type: 'event',   ops: ['eq', 'neq'] },
```

Then in `applyAudienceFilter`, directly below the existing tag skip (`if (fieldConfig.type === 'tag') continue`, ~line 199), add:

```js
    // 'event' is a virtual field (event_registration) resolved by
    // resolveEventFilters into a contacts.id IN (…) constraint — skip
    // it in the scalar-filter loop, exactly like 'tag'.
    if (fieldConfig.type === 'event') continue
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/lib/audience-filter.test.js -t event_registration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audience-filter.js src/lib/audience-filter.test.js
git commit -m "feat(audience): whitelist event_registration virtual field"
```

---

## Task 2: `resolveEventFilters` + chain into `applyAudienceFilterAsync`

**Files:**
- Modify: `src/lib/audience-filter.js`
- Test: `src/lib/audience-filter.test.js`

- [ ] **Step 1: Write failing tests**

In `src/lib/audience-filter.test.js`, extend the import on line 2 to add the new exports:

```js
import { applyAudienceFilter, AUDIENCE_FIELDS, InvalidAudienceFilterError, resolveTagFilters, resolveEventFilters, applyAudienceFilterAsync, mergeRegistrationContactIds, LIVE_REGISTRATION_STATUSES } from './audience-filter.js'
```

Append these `describe` blocks to the end of the file:

```js
// ─── event_registration virtual field ───────────────────────────

describe('LIVE_REGISTRATION_STATUSES', () => {
  it('is exactly pending_payment + confirmed (excludes cancelled + no_show)', () => {
    expect(LIVE_REGISTRATION_STATUSES).toEqual(['pending_payment', 'confirmed'])
  })
})

describe('mergeRegistrationContactIds', () => {
  it('unions registrants with teammates, dropping nulls and dupes', () => {
    const regs = [
      { contact_id: 'a', team_id: 't1' },
      { contact_id: null, team_id: 't2' },
      { contact_id: 'b', team_id: 't3' },
    ]
    const members = [{ contact_id: 'b' }, { contact_id: 'c' }, { contact_id: null }]
    const out = mergeRegistrationContactIds(regs, members)
    expect(new Set(out)).toEqual(new Set(['a', 'b', 'c']))
    expect(out).toHaveLength(3)
  })

  it('handles empty / null inputs', () => {
    expect(mergeRegistrationContactIds(null, null)).toEqual([])
    expect(mergeRegistrationContactIds([], [])).toEqual([])
  })
})

describe('resolveEventFilters — sync edges (no DB)', () => {
  it('is exported as an async function', () => {
    expect(typeof resolveEventFilters).toBe('function')
    expect(resolveEventFilters({ db: {}, query: {}, filter: null })).toBeInstanceOf(Promise)
  })

  it('returns { query } unchanged when filter is null', async () => {
    const dummyQuery = { id: 'unchanged' }
    const result = await resolveEventFilters({
      db: { from: () => { throw new Error('should not be called') } },
      query: dummyQuery, filter: null,
    })
    expect(result.query).toBe(dummyQuery)
  })

  it('returns { query } unchanged when no event filters present', async () => {
    const dummyQuery = { id: 'unchanged' }
    const result = await resolveEventFilters({
      db: { from: () => { throw new Error('should not be called') } },
      query: dummyQuery,
      filter: { filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'active_member' }] },
    })
    expect(result.query).toBe(dummyQuery)
  })

  it('rejects empty / whitespace event ids without hitting the DB', async () => {
    let dbCalled = false
    const db = { from: () => { dbCalled = true; return null } }
    await expect(resolveEventFilters({
      db, query: {},
      filter: { filters: [{ field: 'event_registration', op: 'eq', value: '   ' }] },
    })).rejects.toThrow(/non-empty/)
    expect(dbCalled).toBe(false)
  })
})

describe('resolveEventFilters — DB-backed (explicit mock)', () => {
  // Explicit thenable chain per table (NOT a Proxy) — robust against the
  // PromiseLike auto-unwrap that makes Supabase-builder mocking fragile.
  function eventDb({ regs, members }) {
    return {
      from(table) {
        if (table === 'race_registrations') {
          const chain = {
            select: () => chain, eq: () => chain, in: () => chain,
            then: (resolve) => Promise.resolve({ data: regs, error: null }).then(resolve),
          }
          return chain
        }
        if (table === 'team_members') {
          const chain = {
            select: () => chain, in: () => chain, not: () => chain,
            then: (resolve) => Promise.resolve({ data: members, error: null }).then(resolve),
          }
          return chain
        }
        throw new Error(`unexpected table ${table}`)
      },
    }
  }
  function captureQuery() {
    const calls = []
    const query = {
      in: (...a) => { calls.push(['in', ...a]); return query },
      eq: (...a) => { calls.push(['eq', ...a]); return query },
      not: (...a) => { calls.push(['not', ...a]); return query },
    }
    return { query, calls }
  }

  it('eq → query.in(id, registrants ∪ teammates)', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [{ contact_id: 'a', team_id: 't1' }], members: [{ contact_id: 'b' }] })
    await resolveEventFilters({ db, query, filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] } })
    const inCall = calls.find(c => c[0] === 'in' && c[1] === 'id')
    expect(inCall).toBeTruthy()
    expect(new Set(inCall[2])).toEqual(new Set(['a', 'b']))
  })

  it('eq with no live registrations → unsatisfiable sentinel', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [], members: [] })
    await resolveEventFilters({ db, query, filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] } })
    expect(calls).toContainEqual(['eq', 'id', '00000000-0000-0000-0000-000000000000'])
  })

  it('neq → query.not(id, in, (...))', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [{ contact_id: 'a', team_id: 't1' }], members: [] })
    await resolveEventFilters({ db, query, filter: { filters: [{ field: 'event_registration', op: 'neq', value: 'evt-1' }] } })
    const notCall = calls.find(c => c[0] === 'not')
    expect(notCall).toBeTruthy()
    expect(notCall[1]).toBe('id')
    expect(notCall[2]).toBe('in')
    expect(notCall[3]).toContain('a')
  })

  it('applyAudienceFilterAsync resolves an event filter end to end', async () => {
    const { query, calls } = captureQuery()
    const db = eventDb({ regs: [{ contact_id: 'a', team_id: 't1' }], members: [] })
    await applyAudienceFilterAsync({
      db, query, locationId: 'loc-1',
      filter: { filters: [{ field: 'event_registration', op: 'eq', value: 'evt-1' }] },
    })
    expect(calls.some(c => c[0] === 'in' && c[1] === 'id')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run src/lib/audience-filter.test.js -t "event_registration|LIVE_REGISTRATION|mergeRegistration|resolveEventFilters"`
Expected: FAIL — `resolveEventFilters`, `mergeRegistrationContactIds`, `LIVE_REGISTRATION_STATUSES` are not exported.

- [ ] **Step 3: Implement the helpers + resolver**

In `src/lib/audience-filter.js`, add after the `AUDIENCE_FIELDS` definition (after the closing `})` ~line 145, before the `DAYS_SINCE_OPS` const):

```js
// EVENT-FILTER — registration statuses that count as a LIVE registration
// for audience targeting. pending_payment = signed up, checkout not yet
// completed; confirmed = paid (or a free event). Deliberately EXCLUDES
// 'cancelled' (operator removed) and 'no_show' (post-event) — mirrors the
// capacity predicate used at signup time (events/[slug]/register).
export const LIVE_REGISTRATION_STATUSES = Object.freeze(['pending_payment', 'confirmed'])

// Union a live event's registrants (race_registrations.contact_id) with
// the linked teammates on those registrations' teams
// (team_members.contact_id) into a de-duplicated array of contact ids.
// NULL contact_ids (un-linked teammates) are dropped — no contact row,
// unreachable by any channel.
export function mergeRegistrationContactIds(registrations, teamMembers) {
  const ids = new Set()
  for (const r of registrations || []) if (r?.contact_id) ids.add(r.contact_id)
  for (const m of teamMembers || []) if (m?.contact_id) ids.add(m.contact_id)
  return Array.from(ids)
}
```

Then add `resolveEventFilters` immediately after `resolveTagFilters` (after its closing `}` ~line 368):

```js
/**
 * Resolve any `event_registration` filters into a contacts.id constraint.
 *
 * "Registered for event X" = race_registrations rows for X whose status
 * is a LIVE_REGISTRATION_STATUS (pending_payment or confirmed), taking the
 * registrant (contact_id) UNION the linked teammates (team_members.contact_id)
 * on those registrations' teams. cancelled + no_show are excluded.
 *
 * eq clauses (registered for) intersect (AND). neq clauses (not registered
 * for) subtract via NOT IN. Empty positive set → unsatisfiable sentinel.
 *
 * Same wrapped { query } return as resolveTagFilters — defeats the
 * thenable auto-unwrap (see that function's JSDoc). The chosen event id is
 * itself location-bound and the base contacts query is location-scoped, so
 * no extra location filter is needed here.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.query      contacts query already scoped by location
 * @param {object|null} args.filter
 * @returns {Promise<{ query: object }>}
 */
export async function resolveEventFilters({ db, query, filter }) {
  if (!filter?.filters?.length) return { query }

  const positives = []
  const negatives = []
  for (const f of filter.filters) {
    const cfg = AUDIENCE_FIELDS[f?.field]
    if (!cfg || cfg.type !== 'event') continue
    if (typeof f.value !== 'string' || !f.value.trim()) {
      throw new InvalidAudienceFilterError('event filter requires a non-empty event id')
    }
    const eventId = f.value.trim()
    if (f.op === 'eq') positives.push(eventId)
    else if (f.op === 'neq') negatives.push(eventId)
  }
  if (positives.length === 0 && negatives.length === 0) return { query }

  // contact_ids registered (live) for one event: registrants + teammates.
  async function contactIdsForEvent(eventId) {
    const { data: regs, error: rErr } = await db
      .from('race_registrations')
      .select('contact_id, team_id')
      .eq('race_event_id', eventId)
      .in('status', LIVE_REGISTRATION_STATUSES)
    if (rErr) throw new InvalidAudienceFilterError(`event lookup failed: ${rErr.message}`)

    const teamIds = Array.from(new Set((regs || []).map(r => r.team_id).filter(Boolean)))
    let members = []
    if (teamIds.length) {
      const { data: mem, error: mErr } = await db
        .from('team_members')
        .select('contact_id')
        .in('team_id', teamIds)
        .not('contact_id', 'is', null)
      if (mErr) throw new InvalidAudienceFilterError(`event teammate lookup failed: ${mErr.message}`)
      members = mem || []
    }
    return mergeRegistrationContactIds(regs, members)
  }

  // Positives: intersect across all "registered for X" clauses (AND).
  let allowed = null
  for (const eventId of positives) {
    const ids = await contactIdsForEvent(eventId)
    allowed = allowed === null ? new Set(ids) : new Set([...allowed].filter(x => ids.includes(x)))
    if (allowed.size === 0) {
      return { query: query.eq('id', '00000000-0000-0000-0000-000000000000') }
    }
  }
  if (allowed && allowed.size > 0) {
    query = query.in('id', [...allowed])
  }

  // Negatives: subtract via NOT IN.
  for (const eventId of negatives) {
    const ids = await contactIdsForEvent(eventId)
    if (ids.length === 0) continue
    query = query.not('id', 'in', `(${ids.join(',')})`)
  }

  return { query }
}
```

Finally, update `applyAudienceFilterAsync` (the last function in the file) to chain the new resolver:

```js
export async function applyAudienceFilterAsync({ db, query, filter, locationId }) {
  const tagResult = await resolveTagFilters({ db, query, filter, locationId })
  const eventResult = await resolveEventFilters({ db, query: tagResult.query, filter })
  return { query: applyAudienceFilter(eventResult.query, filter) }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/lib/audience-filter.test.js`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/audience-filter.js src/lib/audience-filter.test.js
git commit -m "feat(audience): resolveEventFilters — registered-for-event → contacts.id IN"
```

---

## Task 3: Live audience count honours virtual fields

**Files:**
- Modify: `src/app/api/communications/audience-count/route.js`

The count route currently uses the sync `applyAudienceFilter`, which silently drops every virtual field (event AND tag). Switch it to the async path. Correctness of the resolution itself is covered by Task 2's `resolveEventFilters` tests; this is a thin wiring change verified by the full suite + manual count in Task 8.

- [ ] **Step 1: Swap the import**

In `src/app/api/communications/audience-count/route.js`, change line 14:

```js
import { applyAudienceFilter } from '@/lib/audience-filter'
```

to:

```js
import { applyAudienceFilterAsync } from '@/lib/audience-filter'
```

- [ ] **Step 2: Use the async resolver in the handler**

Replace the two lines inside the `try` block (currently):

```js
    let q = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', location_id)
    q = applyAudienceFilter(q, audience_filter || { logic: 'and', filters: [] })
    const { count, error } = await q
```

with:

```js
    const baseQuery = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', location_id)
    const { query } = await applyAudienceFilterAsync({
      db,
      query: baseQuery,
      filter: audience_filter || { logic: 'and', filters: [] },
      locationId: location_id,
    })
    const { count, error } = await query
```

(The existing `catch` already maps `InvalidAudienceFilterError` → 400, and the await is inside the `try`, so a thrown resolver error still becomes a 400.)

- [ ] **Step 3: Run the suite — nothing regressed**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/communications/audience-count/route.js
git commit -m "feat(audience-count): resolve virtual fields (event + tag) in the live count"
```

---

## Task 4: SMS broadcasts honour the event filter

**Files:**
- Modify: `src/lib/sms.js`
- Test: `src/lib/sms.test.js`

- [ ] **Step 1: Write a failing test for the async builder**

Append to the bottom of `src/lib/sms.test.js`, and extend the import on line 7 to `import { buildSmsAudience, buildSmsAudienceAsync } from './sms.js'`:

```js
describe('buildSmsAudienceAsync', () => {
  it('returns a wrapped { query } (resolves virtual fields via the async path)', async () => {
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    const result = await buildSmsAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(result).toHaveProperty('query')
    expect(result.query).toBeDefined()
  })

  it('applies the same base eligibility gates as the sync builder', async () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: (t) => { calls.push({ method: 'from', args: [t] }); return builder } }
    await buildSmsAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(calls[0]).toEqual({ method: 'from', args: ['contacts'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['sms_status', 'active'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['contact_preferences.sms_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['phone', 'is', null] })
  })
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/lib/sms.test.js -t buildSmsAudienceAsync`
Expected: FAIL — `buildSmsAudienceAsync` is not exported.

- [ ] **Step 3: Extract the base query + add the async builder**

In `src/lib/sms.js`, ensure the async helper is imported (line 18 currently imports `applyAudienceFilter`):

```js
import { applyAudienceFilter, applyAudienceFilterAsync } from '@/lib/audience-filter'
```

Replace the existing `buildSmsAudience` function (lines 50–66) with a base-extracted version + the new async sibling. **The fluent call order is unchanged**, so the existing `buildSmsAudience` tests stay green:

```js
function smsAudienceBase(db, locationId) {
  return db
    .from('contacts')
    .select('id, name, first_name, last_name, email, phone, pipeline_stage_slug, sms_status, location_id, contact_preferences!inner(sms_marketing)')
    .eq('location_id', locationId)
    .eq('sms_status', 'active')
    .eq('contact_preferences.sms_marketing', true)
    .not('phone', 'is', null)
}

export function buildSmsAudience(db, filter, locationId) {
  return applyAudienceFilter(smsAudienceBase(db, locationId), filter)
}

// Async sibling — resolves virtual fields (event_registration + tag) into
// the contacts.id constraint before applying scalar filters. Returns the
// wrapped { query } (thenable-unwrap guard); the caller destructures and
// awaits it. SMS sends are single-shot, so no per-page rebuild is needed.
export async function buildSmsAudienceAsync(db, filter, locationId) {
  return applyAudienceFilterAsync({ db, query: smsAudienceBase(db, locationId), filter, locationId })
}
```

- [ ] **Step 4: Point `sendBroadcast` at the async builder**

In `src/lib/sms.js`, replace the audience-resolution block in `sendBroadcast` (currently ~lines 135–139):

```js
  const { data: contacts, error: cErr } = await buildSmsAudience(
    db, broadcast.audience_filter, broadcast.location_id,
  )
  if (cErr) throw new Error(`Audience query failed: ${cErr.message}`)
```

with:

```js
  const { query: audienceQuery } = await buildSmsAudienceAsync(
    db, broadcast.audience_filter, broadcast.location_id,
  )
  const { data: contacts, error: cErr } = await audienceQuery
  if (cErr) throw new Error(`Audience query failed: ${cErr.message}`)
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run src/lib/sms.test.js`
Expected: PASS (existing `buildSmsAudience` tests + new async tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sms.js src/lib/sms.test.js
git commit -m "feat(sms): resolve virtual audience fields in broadcasts (event + tag)"
```

---

## Task 5: WhatsApp broadcasts honour the event filter

**Files:**
- Modify: `src/lib/whatsapp.js`
- Test: `src/lib/whatsapp-audience.test.js`

WhatsApp has a paged path (`fetchAllWhatsAppAudience`) and a single-shot path (`sendBroadcast`). The async builder returns a wrapped `{ query }`, so the paged loop rebuilds + re-resolves per page (the established `segment-sync.js` pattern) and the single-shot path awaits once.

- [ ] **Step 1: Write a failing test for the async builder**

Append to `src/lib/whatsapp-audience.test.js`. Check its existing import line for `buildWhatsAppAudience` and add `buildWhatsAppAudienceAsync` to it (e.g. `import { buildWhatsAppAudience, buildWhatsAppAudienceAsync } from './whatsapp.js'`). Reuse the file's existing fake-query helper — these tests assume a `makeFakeQuery()` returning `{ builder, calls }` where `db = { from: () => builder }`; if the file's helper differs, adapt the two lines that build `db`:

```js
describe('buildWhatsAppAudienceAsync', () => {
  it('returns a wrapped { query }', async () => {
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    const result = await buildWhatsAppAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(result).toHaveProperty('query')
    expect(result.query).toBeDefined()
  })

  it('applies the WhatsApp eligibility gates', async () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: (t) => { calls.push({ method: 'from', args: [t] }); return builder } }
    await buildWhatsAppAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(calls).toContainEqual({ method: 'eq', args: ['contact_preferences.whatsapp_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['wa_phone', 'is', null] })
  })
})
```

> If `whatsapp-audience.test.js` does not define a `makeFakeQuery()` helper, copy the one from `src/lib/sms.test.js` (lines 14–25) verbatim into the test file above the new `describe`.

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/lib/whatsapp-audience.test.js -t buildWhatsAppAudienceAsync`
Expected: FAIL — `buildWhatsAppAudienceAsync` is not exported.

- [ ] **Step 3: Extract the base query + add the async builder**

In `src/lib/whatsapp.js`, update the import on line 2:

```js
import { applyAudienceFilter, applyAudienceFilterAsync } from './audience-filter'
```

Replace the existing `buildWhatsAppAudience` (lines 423–436) with the base-extracted version + async sibling (fluent order unchanged so existing tests stay green):

```js
function whatsAppAudienceBase(db, locationId) {
  return db
    .from('contacts')
    .select('*, contact_preferences!inner(*)')
    .eq('location_id', locationId)
    .eq('contact_preferences.whatsapp_marketing', true)
    .not('wa_phone', 'is', null)
    .neq('wa_status', 'blocked')
    .neq('wa_status', 'opted_out')
}

export function buildWhatsAppAudience(db, filter, locationId) {
  // Apply user-supplied filters via the whitelisted helper. Throws
  // InvalidAudienceFilterError on unknown field or unsupported op.
  // Sync path skips virtual fields (event_registration / tag).
  return applyAudienceFilter(whatsAppAudienceBase(db, locationId), filter)
}

// Async sibling — resolves virtual fields (event_registration + tag) into
// the contacts.id constraint, then applies scalar filters. Returns the
// wrapped { query } so the caller can chain .order()/.range() (paged path)
// or await it directly (single-shot).
export async function buildWhatsAppAudienceAsync(db, filter, locationId) {
  return applyAudienceFilterAsync({ db, query: whatsAppAudienceBase(db, locationId), filter, locationId })
}
```

- [ ] **Step 4: Update the paged fetch to re-resolve per page**

In `src/lib/whatsapp.js`, replace the query line in `fetchAllWhatsAppAudience` (currently ~lines 450–452):

```js
    const { data: page, error } = await buildWhatsAppAudience(db, filter, locationId)
      .order('id', { ascending: true })
      .range(start, end)
```

with (rebuild the wrapped query each page — builders are single-use; mirrors `segment-sync.js`):

```js
    const { query } = await buildWhatsAppAudienceAsync(db, filter, locationId)
    const { data: page, error } = await query
      .order('id', { ascending: true })
      .range(start, end)
```

- [ ] **Step 5: Update the single-shot `sendBroadcast`**

In `src/lib/whatsapp.js`, replace the audience block in `sendBroadcast` (currently ~lines 514–518):

```js
  // Get audience
  const audienceQuery = buildWhatsAppAudience(db, broadcast.audience_filter, broadcast.location_id)
  const { data: contacts, error: cErr } = await audienceQuery
```

with:

```js
  // Get audience (async — resolves event_registration / tag virtual fields)
  const { query: audienceQuery } = await buildWhatsAppAudienceAsync(db, broadcast.audience_filter, broadcast.location_id)
  const { data: contacts, error: cErr } = await audienceQuery
```

- [ ] **Step 6: Run tests — verify they pass**

Run: `npx vitest run src/lib/whatsapp-audience.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-audience.test.js
git commit -m "feat(whatsapp): resolve virtual audience fields in broadcasts + drip (event + tag)"
```

---

## Task 6: `GET /api/communications/events` — dropdown data

**Files:**
- Create: `src/app/api/communications/events/route.js`
- Test: `src/app/api/communications/events/route.test.js`

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/communications/events/route.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => { vi.clearAllMocks() })

it('401 when not signed in', async () => {
  getCurrentUser.mockResolvedValue(null)
  const res = await GET()
  expect(res.status).toBe(401)
})

it('403 for non-manager roles', async () => {
  getCurrentUser.mockResolvedValue({ role: 'staff', activeLocation: { id: 'loc-1' } })
  const res = await GET()
  expect(res.status).toBe(403)
})

it('returns events with a live registration_count, scoped to the active location', async () => {
  getCurrentUser.mockResolvedValue({ role: 'owner', activeLocation: { id: 'loc-1' } })

  // events list query: .from('race_events').select().order().limit().eq()  → { data, error }
  const listChain = {
    select: () => listChain, order: () => listChain, limit: () => listChain, eq: () => listChain,
    then: (r) => Promise.resolve({ data: [{ id: 'evt-1', name: 'Nutrition Seminar', kind: 'seminar', race_date: '2026-06-28' }], error: null }).then(r),
  }
  // count query: .from('race_registrations').select(head).eq().in() → { count }
  const countChain = {
    select: () => countChain, eq: () => countChain, in: () => countChain,
    then: (r) => Promise.resolve({ count: 23, error: null }).then(r),
  }
  createServerClient.mockReturnValue({
    from: (t) => (t === 'race_events' ? listChain : countChain),
  })

  const res = await GET()
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.success).toBe(true)
  expect(body.data).toEqual([
    { id: 'evt-1', name: 'Nutrition Seminar', kind: 'seminar', race_date: '2026-06-28', registration_count: 23 },
  ])
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/app/api/communications/events/route.test.js`
Expected: FAIL — `./route.js` does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/communications/events/route.js`:

```js
// GET /api/communications/events
//
// Lists the active location's events (race_events — races, workshops,
// seminars, open days, masterclasses) for the AudienceBuilder's
// "Registered for event" dropdown, each with a LIVE registration count
// (status IN pending_payment/confirmed). Manager+ only; master with no
// active location sees an empty list (must pick a location first).
// Active-location scoping mirrors /api/segments.
//
// Returns: { success, data: [{ id, name, kind, race_date, registration_count }] }

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { LIVE_REGISTRATION_STATUSES } from '@/lib/audience-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const activeLocationId = user.activeLocation?.id || null
  // A master with no active location can't scope the list — mirror
  // /api/segments and return empty rather than aggregate every tenant's
  // events into one dropdown.
  if (!activeLocationId) {
    return NextResponse.json({ success: true, data: [] })
  }

  let q = db
    .from('race_events')
    .select('id, name, kind, race_date')
    .order('race_date', { ascending: false })
    .limit(200)
    .eq('location_id', activeLocationId)
  const { data: events, error } = await q
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  const data = await Promise.all((events || []).map(async (ev) => {
    const { count } = await db
      .from('race_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('race_event_id', ev.id)
      .in('status', LIVE_REGISTRATION_STATUSES)
    return { ...ev, registration_count: count || 0 }
  }))

  return NextResponse.json({ success: true, data })
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run src/app/api/communications/events/route.test.js`
Expected: PASS.

- [ ] **Step 5: Verify the route guard check passes**

Run: `npm run check:route-guards`
Expected: PASS (the route calls `getCurrentUser` + `MANAGER_ROLES` gate).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/communications/events/route.js src/app/api/communications/events/route.test.js
git commit -m "feat(api): GET /api/communications/events for the audience event filter"
```

---

## Task 7: AudienceBuilder UI — "Registered for event" field

**Files:**
- Modify: `src/components/AudienceBuilder.jsx`

This is UI wiring (lazy-load a dropdown), verified by build + manual click-test rather than unit tests — matching the codebase's untested-client-component convention.

- [ ] **Step 1: Add the field option**

In `src/components/AudienceBuilder.jsx`, add to `FIELD_OPTIONS` immediately after the `tag` (Segment tag) entry (~line 57):

```js
  // EVENT-FILTER — virtual field. Resolved server-side via
  // resolveEventFilters (race_registrations → contacts.id). Options load
  // dynamically from /api/communications/events. Value is a race_events id.
  { value: 'event_registration',    label: 'Registered for event',  type: 'event-select' },
```

- [ ] **Step 2: Add the operator labels for the new type**

In `OPS_BY_TYPE`, add after the `'tag-select'` block (~line 98):

```js
  // event-select — registered / not registered for a specific event.
  'event-select': [
    { value: 'eq',  label: 'registered for' },
    { value: 'neq', label: 'not registered for' },
  ],
```

- [ ] **Step 3: Lazy-load the event options**

In the `AudienceBuilder` component, after the `planOptions` effect block (~line 181), add:

```js
  // EVENT-FILTER — event options, loaded once the user adds a
  // "Registered for event" row. Mirrors the tag/plan dynamic loaders.
  const [eventOptions, setEventOptions] = useState(null)
  const usesEventField = filters.some(f => f.field === 'event_registration')
  useEffect(() => {
    if (!usesEventField || eventOptions !== null) return
    let cancelled = false
    fetch('/api/communications/events').then(r => r.json()).then(j => {
      if (!cancelled && j?.success) setEventOptions(j.data || [])
      else if (!cancelled) setEventOptions([])
    }).catch(() => { if (!cancelled) setEventOptions([]) })
    return () => { cancelled = true }
  }, [usesEventField, eventOptions])
```

- [ ] **Step 4: Render the event dropdown**

In the value-rendering chain (~line 312), add a branch immediately after the `plan-select` branch (after its closing `</select>\n              ) :`) and before the `number` branch:

```jsx
              ) : showValue && fieldConfig.type === 'event-select' ? (
                <select
                  value={f.value || ''}
                  onChange={e => updateRow(index, { value: e.target.value })}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-1.5 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted flex-1"
                >
                  <option value="">
                    {eventOptions === null ? 'Loading events…' : '— pick an event —'}
                  </option>
                  {(eventOptions || []).map(ev => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} — {ev.kind} — {ev.race_date}
                      {typeof ev.registration_count === 'number' ? ` (${ev.registration_count})` : ''}
                    </option>
                  ))}
                </select>
```

(`handleFieldChange` already defaults a non-select/non-boolean field's value to `''` and the op to the first in `OPS_BY_TYPE['event-select']` = `eq`, so no change is needed there.)

- [ ] **Step 5: Verify lint + production build**

Run: `npm run lint && npm run build`
Expected: lint clean; build succeeds (catches any import/JSX error in the new branch).

- [ ] **Step 6: Commit**

```bash
git add src/components/AudienceBuilder.jsx
git commit -m "feat(audience-ui): Registered-for-event filter in AudienceBuilder"
```

---

## Task 8: Full verification + manual smoke + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Expected: all green. (No `shared/permissions.js` change → parity unaffected; no new permission key.)

- [ ] **Step 2: Run a real production build**

Run: `npm run build`
Expected: PASS — the only check that catches import-resolution + Turbopack failures (new route + new import of `LIVE_REGISTRATION_STATUSES` into the route).

- [ ] **Step 3: Manual smoke (dev server)**

Run: `npm run dev`, then at `/communications/send`:
1. Add a filter row → choose **Registered for event** → confirm the dropdown loads the active location's events with `(count)`.
2. Pick an event → confirm the live "N contacts match" count is sane (matches the event's known registrant count, incl. pending-payment, excl. cancelled).
3. Switch channel to SMS, then WhatsApp → confirm the count is consistent (the async resolver now applies to all three).

Note in the PR description what you observed (the count for a known event).

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin event-audience-filter
```

Then open a PR (`base: main`) titled **"feat(audience): Registered-for-event filter across all channels"**, body summarising: the virtual-field resolver, the `pending_payment + confirmed` semantics (excl. cancelled/no_show), the all-channels wiring (count + SMS + WhatsApp, which also fixes the existing tag filter there), the new `/api/communications/events` endpoint, and the verification (tests/lint/build/parity + the manual count observed). Link the spec `docs/EVENT_AUDIENCE_FILTER_2026-06.md`.

---

## Self-Review

**Spec coverage:**
- §4 semantics (pending_payment + confirmed, excl. cancelled/no_show, registrants ∪ teammates) → Task 2 (`LIVE_REGISTRATION_STATUSES`, `mergeRegistrationContactIds`, `resolveEventFilters`). ✅
- §5.1 whitelist + resolver + chaining → Tasks 1–2. ✅
- §5.2 count + SMS + WhatsApp wiring → Tasks 3–5. ✅
- §5.3 AudienceBuilder field → Task 7. ✅
- §5.4 `/api/communications/events` → Task 6. ✅
- §6 testing → Tasks 1, 2, 4, 5, 6 + manual (7, 8). ✅
- §7 "no migration / no new permission" honoured; openapi registration intentionally skipped to match the un-registered sibling routes (`/api/segments`, `/api/communications/audience-count`). ✅

**Placeholder scan:** none — every step has complete code/commands.

**Type/name consistency:** `event_registration` (field), `type: 'event'`, `resolveEventFilters({ db, query, filter })`, `LIVE_REGISTRATION_STATUSES`, `mergeRegistrationContactIds(registrations, teamMembers)`, `buildSmsAudienceAsync`/`buildWhatsAppAudienceAsync` (both return wrapped `{ query }`), endpoint shape `{ id, name, kind, race_date, registration_count }` — used consistently across all tasks. ✅

**Note for the implementer:** Tasks are sequential — Task 2 depends on Task 1 (the `type: 'event'` skip), and Tasks 3–7 depend on Task 2's exports. Line numbers are approximate (the files drift); anchor on the quoted surrounding code, not the line number.
