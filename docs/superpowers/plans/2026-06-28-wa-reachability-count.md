# WhatsApp Reachability Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WhatsApp broadcast pre-send count truthful (reachable + exclusion reasons) and make the send result/record/list explain why anyone was excluded — so "1 match → Sent · 0, no reason" can't happen.

**Architecture:** Denormalize `contacts.whatsapp_marketing` (mirroring the existing `email_marketing` trigger) so reachability is a single-table predicate. One shared `applyWhatsAppReachability(query)` gates both the send path and the count endpoint; one shared `computeWhatsAppReachabilitySummary()` produces `{ matched, reachable, excluded:{no_number,no_consent,opted_out} }` for the count endpoint and the persisted `whatsapp_broadcasts.delivery_summary`.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + supabase-js service role), Vitest (pure-lib, mocked db), Zod.

**Spec:** `docs/superpowers/specs/2026-06-28-wa-reachability-count-design.md`

**Working dir:** worktree `~/code/un1t-crm-wa`, branch `feat/wa-reachability-count`.

**Key invariants (from CLAUDE.md):**
- Migrations forward-only, applied via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj`; run `get_advisors(type=security)` after DDL; apply migration **before** dependent code deploys.
- `head:true`/`count` options are read only on the FIRST `.select()` after `.from()`. Embedded-resource filters break under `head:true` counts → that's exactly why we denormalize.
- supabase-js builders are thenables; `.update()/.insert()` must be `await`ed.
- `npm test` runs on mocked imports — run `npm run build` before pushing (new column reads + route shape change).
- Standard response shape `{ success, data?, error? }`.

---

## File Structure

- **Create** `supabase/migrations/325_denormalise_whatsapp_marketing.sql` — column + backfill + sync trigger + `delivery_summary` column.
- **Modify** `src/lib/whatsapp.js` — add `applyWhatsAppReachability`, `computeWhatsAppReachabilitySummary`; switch `whatsAppAudienceBase` to single-table; persist `delivery_summary` in `sendBroadcast` + `sendDripChunk`.
- **Modify** `src/lib/whatsapp-audience.test.js` — update the eligibility-gate contract test.
- **Create** `src/lib/whatsapp-reachability.test.js` — unit tests for the two new helpers.
- **Modify** `src/app/api/communications/audience-count/route.js` — optional `channel`; WhatsApp branch returns `reachable` + `excluded`.
- **Create** `src/app/api/communications/audience-count/route.test.js` — endpoint shape tests (mocked db).
- **Modify** `src/components/communications/UnifiedSendComposer.jsx` — fetch with `channel`, store/render reachable + excluded, gate `canSend` on reachable, result screen wording.
- **Modify** `src/app/communications/sent/page.js` — select + render `delivery_summary` hint.
- **Modify** `src/components/WABroadcastEditor.jsx` — results-tab exclusion breakdown card.
- **Modify** `docs/CHANGELOG.md` — Done entry.

---

## Task 1: Migration — denormalize `whatsapp_marketing` + `delivery_summary` column

**Files:**
- Create: `supabase/migrations/325_denormalise_whatsapp_marketing.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 325 — denormalise contact_preferences.whatsapp_marketing onto contacts, +
-- whatsapp_broadcasts.delivery_summary.
--
-- WHY: WhatsApp broadcast reachability gates on whatsapp_marketing (consent),
-- wa_phone (a normalized WA number) and wa_status. consent lived only on
-- contact_preferences, so the gate needed an inner-join embed — which a
-- head:true count silently returns 0 for (CLAUDE.md PostgREST lesson). The
-- pre-send count therefore ignored consent/reachability and overstated the
-- audience; a 0-recipient send looked like "Sent · 0" with no reason.
--
-- Mirrors mig 155 (email_marketing) / 064 (sms_marketing). Source of truth
-- stays contact_preferences.whatsapp_marketing; this column is a trigger-
-- maintained read-copy so reachability is single-table.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_marketing boolean NOT NULL DEFAULT true;

-- Backfill from the source of truth.
UPDATE contacts c
  SET whatsapp_marketing = cp.whatsapp_marketing
  FROM contact_preferences cp
  WHERE cp.contact_id = c.id
    AND c.whatsapp_marketing IS DISTINCT FROM cp.whatsapp_marketing;

-- Keep it in sync. Exact mirror of sync_contacts_email_marketing (mig 155).
CREATE OR REPLACE FUNCTION sync_contacts_whatsapp_marketing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE contacts
    SET whatsapp_marketing = NEW.whatsapp_marketing
    WHERE id = NEW.contact_id
      AND whatsapp_marketing IS DISTINCT FROM NEW.whatsapp_marketing;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_contacts_whatsapp_marketing_trigger ON contact_preferences;
CREATE TRIGGER sync_contacts_whatsapp_marketing_trigger
  AFTER INSERT OR UPDATE OF whatsapp_marketing ON contact_preferences
  FOR EACH ROW
  EXECUTE FUNCTION sync_contacts_whatsapp_marketing();

COMMENT ON COLUMN contacts.whatsapp_marketing IS
  'Denormalized read-copy of contact_preferences.whatsapp_marketing (mig 325). Trigger-maintained; operators never write it. Lets WhatsApp broadcast audiences gate reachability single-table. Source of truth = contact_preferences.';

-- Per-send reachability snapshot so the record/list explain exclusions.
ALTER TABLE whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS delivery_summary jsonb;

COMMENT ON COLUMN whatsapp_broadcasts.delivery_summary IS
  'Reachability snapshot stamped at send: { matched, reachable, excluded: { no_number, no_consent, opted_out } }. matched = raw audience_filter count; reachable = contacts actually attempted. Reason counts may overlap. Nullable for rows sent before mig 325.';
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Use the `apply_migration` MCP tool: project_id `iyvtbjjxdggiadzwwvdj`, name `denormalise_whatsapp_marketing`, the SQL above.
Confirm the project is **un1t-crm** (not sentinel `tpttqakxmyxrwnqjepfm`) via `list_projects` first if unsure.

- [ ] **Step 3: Run security advisors**

Use `get_advisors` MCP tool, type `security`. Expected: no NEW errors attributable to this migration. The `SECURITY DEFINER` function matches the accepted `sync_contacts_email_marketing` precedent; a `function_search_path_mutable` notice is acceptable (we set `search_path = public`).

- [ ] **Step 4: Validate backfill parity + trigger (via execute_sql MCP)**

Backfill parity — expect `0`:
```sql
SELECT count(*) AS drift
FROM contacts c JOIN contact_preferences cp ON cp.contact_id = c.id
WHERE c.whatsapp_marketing IS DISTINCT FROM cp.whatsapp_marketing;
```
Spot-check the repro contacts — expect `4ca74d64…` false, the other two true:
```sql
SELECT id, whatsapp_marketing FROM contacts
WHERE id IN ('091d56fd-1043-4d69-b52d-e60a8b349d90',
             '271a8eb4-e519-4fbf-b2c4-3e606cb94c25',
             '4ca74d64-9dff-4380-a4ae-f8672fd20904');
```

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-wa
git add supabase/migrations/325_denormalise_whatsapp_marketing.sql
git commit -m "WA-REACH.1 — mig 325: denormalise contacts.whatsapp_marketing + delivery_summary"
```

---

## Task 2: `applyWhatsAppReachability` + switch the send audience to single-table

**Files:**
- Modify: `src/lib/whatsapp.js` (`whatsAppAudienceBase` ~424-433; add export near it)
- Modify: `src/lib/whatsapp-audience.test.js:77-83`

- [ ] **Step 1: Update the failing contract test** (`whatsapp-audience.test.js`)

Replace the `'applies the WhatsApp eligibility gates'` test (lines 77-83) with the post-denormalization contract:

```js
  it('applies the WhatsApp eligibility gates (single-table, post mig 325)', async () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: (t) => { calls.push({ method: 'from', args: [t] }); return builder } }
    await buildWhatsAppAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    // Gate now reads the denormalized contacts.whatsapp_marketing — no contact_preferences embed.
    expect(calls).toContainEqual({ method: 'eq', args: ['whatsapp_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['wa_phone', 'is', null] })
    expect(calls).toContainEqual({ method: 'neq', args: ['wa_status', 'blocked'] })
    expect(calls).toContainEqual({ method: 'neq', args: ['wa_status', 'opted_out'] })
    // The old embedded-join gate is gone.
    expect(calls).not.toContainEqual({ method: 'eq', args: ['contact_preferences.whatsapp_marketing', true] })
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- whatsapp-audience`
Expected: FAIL — current `whatsAppAudienceBase` still calls `eq('contact_preferences.whatsapp_marketing', true)` and selects the embed.

- [ ] **Step 3: Add `applyWhatsAppReachability` and rewrite `whatsAppAudienceBase`**

In `src/lib/whatsapp.js`, replace the existing `whatsAppAudienceBase` (lines ~424-433) with:

```js
/**
 * The WhatsApp broadcast reachability gate, as single-table predicates on
 * contacts (post mig 325: whatsapp_marketing is denormalized). Shared by the
 * send audience and the pre-send count so they agree by construction:
 * opted into WA marketing, has a normalized WA number, not blocked/opted-out.
 */
export function applyWhatsAppReachability(query) {
  return query
    .eq('whatsapp_marketing', true)
    .not('wa_phone', 'is', null)
    .neq('wa_status', 'blocked')
    .neq('wa_status', 'opted_out')
}

/**
 * Build audience query for WhatsApp broadcasts. Single-table on contacts now
 * that whatsapp_marketing is denormalized (mig 325) — no contact_preferences
 * embed, so head:true counts over this gate are safe.
 */
function whatsAppAudienceBase(db, locationId) {
  return applyWhatsAppReachability(
    db.from('contacts').select('*').eq('location_id', locationId)
  )
}
```

(Leave `buildWhatsAppAudience`, `buildWhatsAppAudienceAsync`, `fetchAllWhatsAppAudience` unchanged — they consume `whatsAppAudienceBase`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- whatsapp-audience`
Expected: PASS (all four gate clauses recorded; no embed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-audience.test.js
git commit -m "WA-REACH.2 — single-table WA reachability gate (applyWhatsAppReachability)"
```

---

## Task 3: `computeWhatsAppReachabilitySummary` helper

**Files:**
- Modify: `src/lib/whatsapp.js` (add after `applyWhatsAppReachability`)
- Create: `src/lib/whatsapp-reachability.test.js`

- [ ] **Step 1: Write the failing test** (`src/lib/whatsapp-reachability.test.js`)

```js
import { describe, it, expect, vi } from 'vitest'
import { computeWhatsAppReachabilitySummary } from './whatsapp.js'

// applyAudienceFilterAsync is async and resolves virtual fields; stub it to a
// pass-through so we exercise only the count assembly.
vi.mock('./audience-filter', () => ({
  applyAudienceFilter: (q) => q,
  applyAudienceFilterAsync: async ({ query }) => ({ query }),
}))

// A fluent builder whose terminal await resolves to a configured count. Each
// db.from() returns a fresh builder; we hand back counts in call order.
function dbReturningCounts(counts) {
  let i = 0
  function makeBuilder() {
    const value = { count: counts[i++] ?? 0, error: null }
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (resolve) => resolve(value)
        return () => builder
      },
    })
    return builder
  }
  return { from: () => makeBuilder() }
}

describe('computeWhatsAppReachabilitySummary', () => {
  it('returns matched, reachable, and the three exclusion reason counts', async () => {
    // Call order in the helper: matched, reachable, no_number, no_consent, opted_out
    const db = dbReturningCounts([10, 6, 3, 2, 1])
    const out = await computeWhatsAppReachabilitySummary(db, { logic: 'and', filters: [] }, 'loc')
    expect(out).toEqual({
      matched: 10,
      reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1 },
    })
  })

  it('coerces null counts to 0', async () => {
    const db = dbReturningCounts([null, null, null, null, null])
    const out = await computeWhatsAppReachabilitySummary(db, { logic: 'and', filters: [] }, 'loc')
    expect(out).toEqual({ matched: 0, reachable: 0, excluded: { no_number: 0, no_consent: 0, opted_out: 0 } })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- whatsapp-reachability`
Expected: FAIL — `computeWhatsAppReachabilitySummary` is not exported.

- [ ] **Step 3: Implement the helper** (in `src/lib/whatsapp.js`, after `applyWhatsAppReachability`)

Ensure `applyAudienceFilterAsync` is imported (the file already imports `applyAudienceFilter, applyAudienceFilterAsync` at line 2).

```js
/**
 * Reachability breakdown for an audience_filter at a location, as single-table
 * head:true counts on contacts (safe post mig 325). Shared by the pre-send
 * count endpoint and the persisted delivery_summary so the number the operator
 * sees before sending matches what actually goes out.
 *
 * Reason counts (no_number / no_consent / opted_out) are independent and may
 * overlap; the true excluded total is matched - reachable.
 *
 * @returns {Promise<{matched:number, reachable:number, excluded:{no_number:number,no_consent:number,opted_out:number}}>}
 */
export async function computeWhatsAppReachabilitySummary(db, filter, locationId) {
  const filtered = async () => {
    const base = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', locationId)
    const { query } = await applyAudienceFilterAsync({ db, query: base, filter, locationId })
    return query
  }
  const countOf = async (extra) => {
    const q = await filtered()
    const { count } = await (extra ? extra(q) : q)
    return count || 0
  }
  // Order matters — keep aligned with the test's call sequence.
  const matched = await countOf(null)
  const reachable = await countOf((q) => applyWhatsAppReachability(q))
  const no_number = await countOf((q) => q.is('wa_phone', null))
  const no_consent = await countOf((q) => q.eq('whatsapp_marketing', false))
  const opted_out = await countOf((q) => q.in('wa_status', ['blocked', 'opted_out']))
  return { matched, reachable, excluded: { no_number, no_consent, opted_out } }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- whatsapp-reachability`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-reachability.test.js
git commit -m "WA-REACH.3 — computeWhatsAppReachabilitySummary (matched/reachable/excluded)"
```

---

## Task 4: Count endpoint — optional `channel`, WhatsApp returns reachable + excluded

**Files:**
- Modify: `src/app/api/communications/audience-count/route.js`
- Create: `src/app/api/communications/audience-count/route.test.js`

- [ ] **Step 1: Write the failing test** (`route.test.js`)

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  computeWhatsAppReachabilitySummary: vi.fn(async () => ({
    matched: 10, reachable: 6, excluded: { no_number: 3, no_consent: 2, opted_out: 1 },
  })),
}))
// Channel-agnostic path resolves the filter then awaits a { count } builder.
vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: vi.fn(async ({ query }) => ({ query })),
}))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'

function reqWith(body) { return { json: async () => body } }
function fakeCountDb(count) {
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (resolve) => resolve({ count, error: null })
      return () => builder
    },
  })
  return { from: () => builder }
}

beforeEach(() => { createServerClient.mockReturnValue(fakeCountDb(10)) })

describe('audience-count POST', () => {
  it('default (no channel) returns just count', async () => {
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] } }))
    const json = await res.json()
    expect(json).toEqual({ success: true, count: 10 })
  })

  it('channel=whatsapp returns reachable + excluded breakdown', async () => {
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] }, channel: 'whatsapp' }))
    const json = await res.json()
    expect(json).toEqual({
      success: true, count: 10, reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1 },
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- audience-count`
Expected: FAIL — route ignores `channel`; the whatsapp case returns `{ success, count }` only.

- [ ] **Step 3: Implement the route changes**

In `src/app/api/communications/audience-count/route.js`:

(a) Add `channel` to the schema:
```js
const Schema = z.object({
  location_id: uuidLike,
  audience_filter: z.unknown().optional(),
  channel: z.enum(['sms', 'whatsapp', 'email']).optional(),
})
```

(b) Import the helper at the top:
```js
import { computeWhatsAppReachabilitySummary } from '@/lib/whatsapp'
```

(c) Destructure `channel` and branch. Replace the body after `const db = createServerClient()`:
```js
  const db = createServerClient()
  try {
    if (channel === 'whatsapp') {
      // Single-table reachability counts (safe post mig 325) — keep the pre-send
      // number honest about WhatsApp consent + a usable wa_phone.
      const { matched, reachable, excluded } =
        await computeWhatsAppReachabilitySummary(db, audience_filter || { logic: 'and', filters: [] }, location_id)
      return NextResponse.json({ success: true, count: matched, reachable, excluded })
    }
    // Count on the FIRST .select() (postgrest-js only reads head/count there).
    const baseQuery = db.from('contacts').select('id', { count: 'exact', head: true }).eq('location_id', location_id)
    const { query } = await applyAudienceFilterAsync({
      db, query: baseQuery,
      filter: audience_filter || { logic: 'and', filters: [] },
      locationId: location_id,
    })
    const { count, error } = await query
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return NextResponse.json({ success: true, count: count || 0 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || 'Could not count audience' }, { status: 400 })
  }
```
And add `channel` to the destructure: `const { location_id, audience_filter, channel } = validation.data`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- audience-count`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/communications/audience-count/route.js src/app/api/communications/audience-count/route.test.js
git commit -m "WA-REACH.4 — audience-count: channel-aware WhatsApp reachable + excluded"
```

---

## Task 5: Persist `delivery_summary` in `sendBroadcast` and `sendDripChunk`

**Files:**
- Modify: `src/lib/whatsapp.js` (`sendBroadcast` ~508-626; `sendDripChunk` ~646-756)

**Testing note (read first):** `sendBroadcast`/`sendDripChunk` are DB- and network-orchestrating functions with many collaborators (`getWhatsAppConfig` runs *before* the audience fetch at line 528, then `fetchAllWhatsAppAudience`, `getLocationBranding`, `sendTemplateMessage`). The codebase deliberately does **not** unit-test them — it tests the *pure* helpers they call (`whatsapp-drip.test.js` covers `selectDripRecipients`/`dripOutcome`; never `sendDripChunk`). The summary *logic* is already TDD-anchored by Task 3 (`computeWhatsAppReachabilitySummary`); this task is orchestration glue: call the helper and write its result into the existing `update()`s. We therefore verify it by (a) the existing `whatsapp*` suite staying green, (b) `npm run build`, and (c) a live MCP re-run of the repro after deploy (Task 9, Step 6). Do **not** add a fragile full-`sendBroadcast` fake-db test — it fights the codebase pattern and the `getWhatsAppConfig` ordering.

- [ ] **Step 1: Implement — compute + persist summary in `sendBroadcast`**

In `sendBroadcast`, compute the summary right after resolving `contacts` and use it in both the empty branch and the final update. Replace the empty-audience branch (lines ~538-545):

```js
  // Reachability snapshot for the record/list (same single-table counts the
  // composer shows pre-send). reachable is overridden to what we actually
  // attempt, to reflect reality over any count-vs-fetch race.
  const summary = await computeWhatsAppReachabilitySummary(db, broadcast.audience_filter, broadcast.location_id)
  const deliverySummary = { ...summary, reachable: contacts?.length || 0 }

  if (!contacts?.length) {
    await db.from('whatsapp_broadcasts').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      total_recipients: 0,
      delivery_summary: deliverySummary,
    }).eq('id', broadcastId)
    return { sent: 0, delivery_summary: deliverySummary }
  }
```

And add `delivery_summary` to the final metrics update (lines ~614-620) and return (line ~625):

```js
  await db.from('whatsapp_broadcasts').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    total_recipients: contacts.length,
    total_sent: sentCount,
    total_failed: failedCount,
    delivery_summary: deliverySummary,
  }).eq('id', broadcastId)

  try { await db.rpc('increment_whatsapp_template_sent', { p_template_id: template.id, p_delta: sentCount }) } catch {}

  return { sent: sentCount, failed: failedCount, total: contacts.length, delivery_summary: deliverySummary }
```

- [ ] **Step 2: Implement — persist summary in `sendDripChunk` completion branches**

In `sendDripChunk`, stamp `delivery_summary` only where the drip reaches a terminal `status:'sent'` (the empty-audience branch ~681-686 and the exhausted branch ~690-696). Compute it once after the audience is fetched:

Empty-audience branch (replace ~681-686):
```js
  if (audience.length === 0) {
    const summary = await computeWhatsAppReachabilitySummary(db, broadcast.audience_filter, broadcast.location_id)
    await db.from('whatsapp_broadcasts').update({
      status: 'sent', sent_at: new Date().toISOString(), total_recipients: 0,
      delivery_summary: { ...summary, reachable: 0 },
    }).eq('id', broadcastId)
    return { status: 'sent', sent: 0, failed: 0, recipients: 0 }
  }
```

Exhausted branch (replace ~690-696):
```js
  if (toSend.length === 0) {
    if (exhausted) {
      const summary = await computeWhatsAppReachabilitySummary(db, broadcast.audience_filter, broadcast.location_id)
      await db.from('whatsapp_broadcasts').update({
        status: 'sent', sent_at: new Date().toISOString(), total_recipients: audience.length,
        delivery_summary: { ...summary, reachable: audience.length },
      }).eq('id', broadcastId)
      return { status: 'sent', sent: 0, failed: 0, recipients: audience.length }
    }
    return { status: 'sending', skipped: 'no_capacity', sent: 0, failed: 0 }
  }
```

(The mid-drip final update at ~748-753 stays as-is; the summary is stamped only at terminal completion to avoid recomputing every tick.)

- [ ] **Step 3: Verify no regressions + build**

Run: `npm test -- whatsapp && npm run build`
Expected: existing `whatsapp*` suite stays green; build resolves the new `computeWhatsAppReachabilitySummary` usage. (Live re-run of the repro send is done post-deploy in Task 9, Step 6.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp.js
git commit -m "WA-REACH.5 — persist delivery_summary on blast + drip completion"
```

---

## Task 6: Composer — truthful count line, reachable gate, result wording

**Files:**
- Modify: `src/components/communications/UnifiedSendComposer.jsx`

- [ ] **Step 1: Add reachable/excluded state and channel-aware fetch**

After the count state (lines 49-50) add:
```js
  const [reachable, setReachable] = useState(null)   // WhatsApp only
  const [excluded, setExcluded] = useState(null)     // { no_number, no_consent, opted_out }
```

Replace the count `useEffect` (lines 76-95) so it sends `channel` and stores the WhatsApp breakdown:
```js
  // Live audience size — debounced. For WhatsApp we ask channel-aware so the
  // number reflects consent + a usable wa_phone (the same gate the send applies).
  useEffect(() => {
    let alive = true
    setCounting(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/communications/audience-count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId, audience_filter: effectiveFilter, channel }),
        })
        const data = await res.json()
        if (!alive) return
        setCount(data?.success ? data.count : null)
        setReachable(data?.success && channel === 'whatsapp' ? (data.reachable ?? null) : null)
        setExcluded(data?.success && channel === 'whatsapp' ? (data.excluded ?? null) : null)
      } catch {
        if (alive) { setCount(null); setReachable(null); setExcluded(null) }
      } finally {
        if (alive) setCounting(false)
      }
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [locationId, effectiveFilter, channel])
```

- [ ] **Step 2: Gate `canSend` on reachable for WhatsApp**

Replace `canSend` (line 122):
```js
  // For WhatsApp the meaningful gate is the reachable count, not raw matches —
  // an audience of 1 with 0 reachable has nobody to send to.
  const sendableCount = channel === 'whatsapp' ? reachable : count
  const canSend = !busy && composeValid && scheduleValid && audienceValid && (sendableCount == null || sendableCount > 0)
```

- [ ] **Step 3: Render the WhatsApp reachable + excluded count line**

Replace the count line block (lines 299-306) with:
```jsx
        <div className="mt-2 flex flex-col gap-0.5 text-xs text-un1t-subtle">
          <div className="flex items-center gap-1.5">
            <Users size={13} />
            {counting
              ? <span className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> counting…</span>
              : count == null
                ? <span>Add a condition to see how many contacts match.</span>
                : channel === 'whatsapp'
                  ? <span><b className="text-un1t-text">{count.toLocaleString()}</b> match · <b className="text-un1t-text">{(reachable ?? 0).toLocaleString()}</b> reachable on WhatsApp</span>
                  : <span><b className="text-un1t-text">{count.toLocaleString()}</b> contact{count === 1 ? '' : 's'} match this filter</span>}
          </div>
          {channel === 'whatsapp' && !counting && count != null && reachable != null && (count - reachable) > 0 && (
            <div className="flex items-start gap-1.5 text-amber-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {(count - reachable).toLocaleString()} excluded
                {excluded ? ` — ${[
                  excluded.no_number ? `${excluded.no_number} no WhatsApp number` : null,
                  excluded.no_consent ? `${excluded.no_consent} no marketing opt-in` : null,
                  excluded.opted_out ? `${excluded.opted_out} opted out` : null,
                ].filter(Boolean).join(', ')}` : ''}
              </span>
            </div>
          )}
        </div>
```
(`AlertTriangle` is already imported at line 11.)

- [ ] **Step 4: Reset reachable/excluded in `reset()`**

In `reset()` (lines 212-216), add: `setReachable(null); setExcluded(null)`.

- [ ] **Step 5: Result screen — explain a 0/partial WhatsApp send**

In the "sent" result block (lines 241-258), make the WhatsApp 0-reachable case explicit. Replace the heading + paragraph for the non-scheduled/non-drip branch:
```jsx
            <h2 className="text-lg font-semibold text-un1t-text">
              {result.queued
                ? 'Queued'
                : result.channel === 'whatsapp' && (result.sent ?? 0) === 0 && result.remaining ? 'Sending…'
                : result.channel === 'whatsapp' && (result.sent ?? 0) === 0 ? 'Nobody was reachable'
                : (result.remaining > 0 ? 'Sending…' : 'Sent')}
            </h2>
            <p className="text-sm text-un1t-subtle mt-1">
              {result.queued
                ? 'Your email is queued — it goes out within the next minute.'
                : (() => {
                    const ds = result.delivery_summary
                    const k = ds ? (ds.matched - ds.reachable) : null
                    const reasons = ds && ds.excluded ? [
                      ds.excluded.no_number ? `${ds.excluded.no_number} no WhatsApp number` : null,
                      ds.excluded.no_consent ? `${ds.excluded.no_consent} no marketing opt-in` : null,
                      ds.excluded.opted_out ? `${ds.excluded.opted_out} opted out` : null,
                    ].filter(Boolean).join(', ') : ''
                    if (result.channel === 'whatsapp' && (result.sent ?? 0) === 0 && !result.remaining) {
                      return reasons
                        ? `None of the ${ds.matched} matched contacts could be messaged — ${reasons}.`
                        : 'None of the matched contacts could be messaged on WhatsApp.'
                    }
                    return <>
                      {`${result.sent ?? result.total ?? 0} sent`}
                      {result.failed ? `, ${result.failed} failed` : ''}
                      {result.recipients != null ? ` of ${result.recipients}` : ''}
                      {k > 0 ? ` · ${k} excluded${reasons ? ` (${reasons})` : ''}` : ''}
                      {result.remaining > 0 ? ' — the rest go out automatically over the next few minutes.' : '.'}
                    </>
                  })()}
            </p>
```
(The send handler at lines 172-173 already spreads `...data` into `result`, so `result.delivery_summary` flows through from the send API.)

- [ ] **Step 6: Verify the build + a manual smoke of the composer logic**

Run: `npm run build`
Expected: PASS (no unresolved imports / JSX errors).

- [ ] **Step 7: Commit**

```bash
git add src/components/communications/UnifiedSendComposer.jsx
git commit -m "WA-REACH.6 — composer: reachable count, exclusion reasons, reachable send-gate"
```

---

## Task 7: Sent list — show exclusion hint

**Files:**
- Modify: `src/app/communications/sent/page.js`

- [ ] **Step 1: Pull `delivery_summary` into the WhatsApp rows**

The shared `SELECT` (line 27) is used for SMS + WhatsApp. `delivery_summary` only exists on `whatsapp_broadcasts`, so add it to the WhatsApp query only. Replace the WhatsApp block (lines 46-50):
```js
  if (canWa && locationId) {
    const { data } = await db.from('whatsapp_broadcasts').select(`${SELECT}, delivery_summary`)
      .eq('location_id', locationId).order('created_at', { ascending: false }).limit(100)
    for (const b of data || []) rows.push({ ...b, channel: 'whatsapp', detail: `/whatsapp/broadcasts/${b.id}` })
  }
```

- [ ] **Step 2: Render the hint in the Sent column**

Replace the Sent cell (lines 103-107):
```jsx
                    <td className="px-4 py-3 text-right text-un1t-subtle tabular-nums">
                      {(r.status === 'sent' || r.status === 'sending')
                        ? <>
                            {(r.total_sent || 0).toLocaleString()}
                            {r.total_failed ? <span className="text-rose-700"> · {r.total_failed} failed</span> : null}
                            {(() => {
                              const ds = r.delivery_summary
                              const k = ds && ds.matched != null && ds.reachable != null ? ds.matched - ds.reachable : 0
                              return k > 0 ? <span className="text-amber-700"> · {k} excluded</span> : null
                            })()}
                          </>
                        : '—'}
                    </td>
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/communications/sent/page.js
git commit -m "WA-REACH.7 — Sent list: surface WhatsApp excluded count"
```

---

## Task 8: WA broadcast detail — exclusion breakdown card

**Files:**
- Modify: `src/components/WABroadcastEditor.jsx` (results tab, after the stat grid at line 229)

- [ ] **Step 1: Add the breakdown card to the results tab**

Inside the `isSent && tab === 'results'` block, after the closing `</div>` of the stat grid (line 229) and before the block's closing `</div>` (line 230), insert:
```jsx
            {broadcast.delivery_summary && (broadcast.delivery_summary.matched - broadcast.delivery_summary.reachable) > 0 && (
              <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                <p className="text-xs text-un1t-subtle uppercase">Excluded from this send</p>
                <p className="text-sm mt-1">
                  {(broadcast.delivery_summary.matched - broadcast.delivery_summary.reachable).toLocaleString()} of {broadcast.delivery_summary.matched.toLocaleString()} matched contacts weren&apos;t reachable on WhatsApp.
                </p>
                <ul className="mt-2 text-sm text-un1t-subtle space-y-0.5">
                  {broadcast.delivery_summary.excluded?.no_number ? <li>• {broadcast.delivery_summary.excluded.no_number} have no WhatsApp number</li> : null}
                  {broadcast.delivery_summary.excluded?.no_consent ? <li>• {broadcast.delivery_summary.excluded.no_consent} haven&apos;t opted into WhatsApp marketing</li> : null}
                  {broadcast.delivery_summary.excluded?.opted_out ? <li>• {broadcast.delivery_summary.excluded.opted_out} opted out</li> : null}
                </ul>
              </div>
            )}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/WABroadcastEditor.jsx
git commit -m "WA-REACH.8 — WA broadcast detail: exclusion breakdown card"
```

---

## Task 9: Full verification, changelog, push, PR

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Add a Done entry at the top of `docs/CHANGELOG.md` (match the file's existing numbered format), e.g.:
```
WA-REACH — WhatsApp broadcasts now show reachable count + exclusion reasons
before send, and the result/record/Sent list explain a 0/partial send. Root:
the pre-send count was channel-agnostic while the send applied a consent +
wa_phone + opt-out gate, so a 0-recipient send looked like "Sent · 0" with no
reason. Denormalised contacts.whatsapp_marketing (mig 325) → single-table
reachability shared by the count endpoint + send path; persisted
whatsapp_broadcasts.delivery_summary. Files: src/lib/whatsapp.js,
src/app/api/communications/audience-count/route.js,
src/components/communications/UnifiedSendComposer.jsx,
src/app/communications/sent/page.js, src/components/WABroadcastEditor.jsx.
```

- [ ] **Step 2: Run the full CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all PASS. (No new `WEB_PERMISSIONS` key, no mobile import of `src/lib` → parity/import checks unaffected.)

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: PASS (Turbopack resolves the new helper import + route shape + page reads).

- [ ] **Step 4: Commit the changelog**

```bash
git add docs/CHANGELOG.md
git commit -m "WA-REACH.9 — CHANGELOG"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/wa-reachability-count
gh pr create --base main --fill
```
Report the PR URL. Pushing is NOT shipping — the Vercel check on the PR is the real build gate.

- [ ] **Step 6: Live verification (post-merge / on the Vercel preview)**

Once deployed (preview or prod), confirm the orchestration glue end-to-end:
- In the composer at `/communications/send`, WhatsApp channel, target the repro contact `4ca74d64…` → the count line shows `1 match · 0 reachable on WhatsApp` and Send is disabled with the exclusion hint.
- Target the good contact `091d56fd…` → `1 match · 1 reachable`, Send enabled; sending delivers and the result reads `Sent to 1 of 1`.
- Via `execute_sql` MCP, confirm a fresh 0-reachable send persisted the breakdown:
  `SELECT name, total_recipients, delivery_summary FROM whatsapp_broadcasts ORDER BY created_at DESC LIMIT 3;`
  → the 0-send row has a non-null `delivery_summary` with `matched > reachable`.

---

## Self-review notes

- **Spec coverage:** migration (Task 1), shared reachability predicate (Task 2), shared summary helper (Task 3), channel-aware count endpoint (Task 4), persisted `delivery_summary` on blast + drip (Task 5), composer count line + reachable gate + result wording (Task 6), Sent list (Task 7), detail page (Task 8), changelog + verification (Task 9). All spec sections covered.
- **Type consistency:** the summary shape `{ matched, reachable, excluded:{no_number,no_consent,opted_out} }` is identical across the helper, the endpoint response, the persisted column, and every UI reader. The excluded total is always derived as `matched - reachable` (never summed from reasons).
- **Migration-before-code:** Task 1 applies + validates the migration before any code reads `whatsapp_marketing` / `delivery_summary`.
- **Mobile boundary:** no `shared/` or `mobile/` changes; `whatsapp.js` is server-only (`createServerClient`) and not imported by mobile.
