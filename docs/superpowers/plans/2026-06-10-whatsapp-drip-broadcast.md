# WhatsApp Drip Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator send a WhatsApp broadcast to a filtered lead list that delivers up to a configurable number of messages per rolling 24h (default 500), only during a daytime window (default 09:00–20:00 Europe/Dublin), resuming day after day until every eligible contact has been messaged once.

**Architecture:** Extend `whatsapp_broadcasts` with six pacing columns + add a `(broadcast_id, contact_id)` unique key to `whatsapp_broadcast_recipients`. A new `run-whatsapp-broadcasts` Vercel cron (every 15 min) gates the send window and calls a new `sendDripChunk(broadcastId)` engine in `src/lib/whatsapp.js` — a paced, resumable port of the proven `sms.js → sendBroadcast` pattern. Pure decision logic (window check, rolling headroom, recipient selection, finalisation, ETA) lives in a new `src/lib/whatsapp-drip.js` and is fully unit-tested; the IO engine composes those helpers and reuses the existing WhatsApp send loop verbatim. The operator picks Blast vs Drip in the unified composer (`UnifiedSendComposer.jsx`); the broadcast detail editor (`WABroadcastEditor.jsx`) shows live progress + ETA + Pause/Resume.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (service-role `createServerClient`), Vitest, Zod, Vercel Cron, Meta WhatsApp Cloud API. Spec: `docs/superpowers/specs/2026-06-10-whatsapp-drip-broadcast-design.md`.

---

## Decisions resolved during planning (spec open questions)

The spec left four items "to resolve during planning". They are resolved here and baked into the tasks below:

1. **`PER_TICK_MAX = 100`, cron interval `*/15 * * * *` (every 15 min).** During the 09:00–20:00 window that's ~44 ticks/day; at 100/tick a 500/day cap is spent in the first ~5 ticks (~75 min each morning), then headroom stays 0 until the rolling-24h window frees capacity ~24h later. This matches the spec's "drain over the first few morning ticks".
2. **Template disabled/paused mid-drip → auto-pause** (set `paused_at`, leave `'sending'`). The engine re-checks `template.status === 'APPROVED'` every tick; a non-approved template auto-pauses so the operator notices rather than the list draining into template errors.
3. **`AUTO_PAUSE_CONSECUTIVE_FAILURES = 5`** — a run of 5 consecutive send failures in one tick auto-pauses (mirrors the sequences runner). NOTE the spec was corrected: the SMS `sendBroadcast` does **not** auto-pause; this is genuinely new code.
4. **Multiple concurrent drips share one number's tier budget** — v1 treats each broadcast's `daily_cap` independently (acceptable for a single-number operator). Documented as a known limitation; not enforced.

**Key correction vs. the original spec (now reflected in the spec doc):** the resume/selection does **not** use an RPC anti-join. The real constraint is the 1000-row PostgREST cap (an RPC couldn't reuse the JS-side `applyAudienceFilter` whitelist anyway), so the engine **paginates** both the eligible audience and the done-set with the codebase's `.range()` pattern and takes a JS `Set` difference (which also sidesteps the Cloudflare 414). `whatsapp_broadcast_recipients` has **no** `(broadcast_id, contact_id)` unique constraint today — the migration adds it.

---

## File Structure

| File | New/Modify | Responsibility |
|---|---|---|
| `supabase/migrations/253_whatsapp_drip_broadcast.sql` | Create | 6 pacing columns on `whatsapp_broadcasts`, dedup + unique key on recipients, cron heartbeat row |
| `src/lib/whatsapp-drip.js` | Create | Pure helpers + constants: `isWithinSendWindow`, `rollingHeadroom`, `estimateDripDays`, `selectDripRecipients`, `dripOutcome`, `PER_TICK_MAX`, `AUTO_PAUSE_CONSECUTIVE_FAILURES` |
| `src/lib/whatsapp-drip.test.js` | Create | Unit tests for every pure helper |
| `src/lib/whatsapp-audience.test.js` | Create | Unit tests for the paginated fetch helpers |
| `src/lib/whatsapp.js` | Modify | Add `fetchAllWhatsAppAudience`, `fetchDripDoneContactIds`, `sendDripChunk` |
| `src/app/api/cron/run-whatsapp-broadcasts/route.js` | Create | Cron: pull active drips, gate window, call `sendDripChunk`, stamp heartbeat |
| `vercel.json` | Modify | Register the cron (every 15 min) |
| `src/app/api/whatsapp/broadcasts/route.js` | Modify | Accept pacing fields on create; status `'sending'` for drips |
| `src/app/api/whatsapp/broadcasts/[id]/pause/route.js` | Create | POST to set/clear `paused_at` |
| `src/components/communications/UnifiedSendComposer.jsx` | Modify | Pacing section (Blast/Drip + cap + window) + drip create branch + result message |
| `src/components/WABroadcastEditor.jsx` | Modify | In-flight drip status panel: progress, ETA, Pause/Resume |

---

## Task 1: Migration — pacing columns, recipients unique key, heartbeat row

**Files:**
- Create: `supabase/migrations/253_whatsapp_drip_broadcast.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 253_whatsapp_drip_broadcast.sql
-- WhatsApp drip broadcast (WA-DRIP). Adds paced delivery to whatsapp_broadcasts,
-- the dedup/resume key on recipients, and the cron heartbeat row.

-- 1. Pacing columns. delivery_mode defaults to 'blast' so every existing row and
--    the all-at-once sendBroadcast path are completely unchanged.
alter table public.whatsapp_broadcasts
  add column if not exists delivery_mode     text        not null default 'blast',
  add column if not exists daily_cap         integer     not null default 500,
  add column if not exists send_window_start time        not null default '09:00',
  add column if not exists send_window_end   time        not null default '20:00',
  add column if not exists send_window_tz    text        not null default 'Europe/Dublin',
  add column if not exists paused_at         timestamptz;

alter table public.whatsapp_broadcasts
  drop constraint if exists whatsapp_broadcasts_delivery_mode_chk;
alter table public.whatsapp_broadcasts
  add  constraint whatsapp_broadcasts_delivery_mode_chk
  check (delivery_mode in ('blast', 'drip'));

alter table public.whatsapp_broadcasts
  drop constraint if exists whatsapp_broadcasts_daily_cap_chk;
alter table public.whatsapp_broadcasts
  add  constraint whatsapp_broadcasts_daily_cap_chk
  check (daily_cap > 0);

-- 2. Dedup any pre-existing duplicate (broadcast_id, contact_id) rows (keep the
--    earliest by ctid), THEN add the unique constraint the drip resume +
--    idempotency relies on. The blast sender never resumed, so it never needed
--    this; the drip does (cron retries must never double-send).
delete from public.whatsapp_broadcast_recipients a
using public.whatsapp_broadcast_recipients b
where a.broadcast_id = b.broadcast_id
  and a.contact_id   = b.contact_id
  and a.contact_id is not null
  and a.ctid > b.ctid;

alter table public.whatsapp_broadcast_recipients
  drop constraint if exists whatsapp_broadcast_recipients_broadcast_contact_uniq;
alter table public.whatsapp_broadcast_recipients
  add  constraint whatsapp_broadcast_recipients_broadcast_contact_uniq
  unique (broadcast_id, contact_id);

-- 3. Cron heartbeat row so /api/cron/health-check tracks the new runner. Runs
--    every 15 min (900s). Generous grace: a tick fired outside the send window is
--    a no-op but STILL stamps the heartbeat, so freshness is bounded by 900+grace.
insert into public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
values ('run-whatsapp-broadcasts', 900, 300, 'WhatsApp drip broadcast paced sender (WA-DRIP)')
on conflict (name) do nothing;
```

- [ ] **Step 2: Apply the migration to the live project**

Use the Supabase MCP `apply_migration` tool (project `iyvtbjjxdggiadzwwvdj`, name `253_whatsapp_drip_broadcast`). If MCP is unavailable, paste the SQL into the Supabase SQL Editor.

- [ ] **Step 3: Verify columns + constraint + heartbeat landed**

Run via MCP `execute_sql`:

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_schema='public' and table_name='whatsapp_broadcasts'
  and column_name in ('delivery_mode','daily_cap','send_window_start','send_window_end','send_window_tz','paused_at')
order by column_name;

select conname from pg_constraint
where conrelid='public.whatsapp_broadcast_recipients'::regclass and contype='u';

select name, expected_interval_seconds, grace_seconds
from public.cron_heartbeats where name='run-whatsapp-broadcasts';
```

Expected: 6 column rows; `whatsapp_broadcast_recipients_broadcast_contact_uniq` present; one heartbeat row (900 / 300).

- [ ] **Step 4: Run the security advisor**

Use MCP `get_advisors` (type=security). Expected: no NEW errors attributable to this migration (adding columns/constraints to existing RLS-enabled tables introduces none). Note any pre-existing warnings are unrelated.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/253_whatsapp_drip_broadcast.sql
git commit -m "WA-DRIP.1 — migration: drip columns + recipients unique key + heartbeat

Adds delivery_mode/daily_cap/send_window_*/paused_at to whatsapp_broadcasts
(delivery_mode defaults 'blast' so the blast path is unchanged), dedups and adds
UNIQUE(broadcast_id, contact_id) on whatsapp_broadcast_recipients (the drip
resume/idempotency key — the table had only a PK on id), and seeds the
run-whatsapp-broadcasts cron heartbeat row."
```

---

## Task 2: Pure drip helpers + constants

**Files:**
- Create: `src/lib/whatsapp-drip.js`
- Test: `src/lib/whatsapp-drip.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/whatsapp-drip.test.js
import { describe, it, expect } from 'vitest'
import {
  isWithinSendWindow, rollingHeadroom, estimateDripDays, selectDripRecipients, dripOutcome,
  PER_TICK_MAX, AUTO_PAUSE_CONSECUTIVE_FAILURES,
} from './whatsapp-drip.js'

const DUBLIN = 'Europe/Dublin'
const win = { start: '09:00', end: '20:00', tz: DUBLIN }

describe('isWithinSendWindow', () => {
  it('is true at midday Dublin summer time', () => {
    // 12:00Z = 13:00 IST (BST) — inside 09:00–20:00
    expect(isWithinSendWindow(new Date('2026-06-10T12:00:00Z'), win)).toBe(true)
  })
  it('is false before the window opens (winter / GMT)', () => {
    // 08:30Z = 08:30 GMT in January — before 09:00
    expect(isWithinSendWindow(new Date('2026-01-10T08:30:00Z'), win)).toBe(false)
  })
  it('is false after the window closes', () => {
    // 21:00Z = 22:00 IST — after 20:00
    expect(isWithinSendWindow(new Date('2026-06-10T21:00:00Z'), win)).toBe(false)
  })
  it('respects DST: the same UTC wall-clock flips across the BST boundary', () => {
    // 19:30Z → 20:30 IST in summer (OUT), 19:30 GMT in winter (IN)
    expect(isWithinSendWindow(new Date('2026-06-10T19:30:00Z'), win)).toBe(false)
    expect(isWithinSendWindow(new Date('2026-01-10T19:30:00Z'), win)).toBe(true)
  })
  it('accepts HH:MM:SS times (Postgres `time` columns serialise that way)', () => {
    const w = { start: '09:00:00', end: '20:00:00', tz: DUBLIN }
    expect(isWithinSendWindow(new Date('2026-06-10T12:00:00Z'), w)).toBe(true)
  })
  it('a zero-length window never sends', () => {
    expect(isWithinSendWindow(new Date('2026-06-10T12:00:00Z'), { start: '09:00', end: '09:00', tz: DUBLIN })).toBe(false)
  })
})

describe('rollingHeadroom', () => {
  it('returns the unused allowance', () => {
    expect(rollingHeadroom(500, 0)).toBe(500)
    expect(rollingHeadroom(500, 123)).toBe(377)
  })
  it('clamps to 0 when the cap is met or exceeded', () => {
    expect(rollingHeadroom(500, 500)).toBe(0)
    expect(rollingHeadroom(500, 600)).toBe(0)
  })
})

describe('estimateDripDays', () => {
  it('is 0 when nothing remains', () => {
    expect(estimateDripDays(0, 500)).toBe(0)
  })
  it('ceils remaining / dailyCap', () => {
    expect(estimateDripDays(500, 500)).toBe(1)
    expect(estimateDripDays(501, 500)).toBe(2)
    expect(estimateDripDays(1200, 500)).toBe(3)
  })
  it('is Infinity when the cap is non-positive', () => {
    expect(estimateDripDays(10, 0)).toBe(Infinity)
  })
})

describe('selectDripRecipients', () => {
  const aud = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, wa_phone: `+1${i}` }))

  it('sends the whole short audience and marks exhausted', () => {
    const r = selectDripRecipients({ audience: aud(5), doneIds: [], headroom: 100, perTickMax: 100 })
    expect(r.toSend).toHaveLength(5)
    expect(r.remainingCount).toBe(5)
    expect(r.exhausted).toBe(true)
  })
  it('caps at perTickMax and is not exhausted when more remain', () => {
    const r = selectDripRecipients({ audience: aud(250), doneIds: [], headroom: 500, perTickMax: 100 })
    expect(r.toSend).toHaveLength(100)
    expect(r.remainingCount).toBe(250)
    expect(r.exhausted).toBe(false)
  })
  it('excludes already-done contacts and exhausts on the last batch', () => {
    const audience = aud(250)
    const doneIds = audience.slice(0, 200).map(c => c.id) // 50 remain
    const r = selectDripRecipients({ audience, doneIds, headroom: 500, perTickMax: 100 })
    expect(r.toSend).toHaveLength(50)
    expect(r.exhausted).toBe(true)
  })
  it('caps at headroom when headroom < perTickMax', () => {
    const r = selectDripRecipients({ audience: aud(250), doneIds: [], headroom: 30, perTickMax: 100 })
    expect(r.toSend).toHaveLength(30)
    expect(r.exhausted).toBe(false)
  })
  it('sends nothing and is NOT exhausted when headroom is 0', () => {
    const r = selectDripRecipients({ audience: aud(250), doneIds: [], headroom: 0, perTickMax: 100 })
    expect(r.toSend).toHaveLength(0)
    expect(r.exhausted).toBe(false)
  })
  it('an empty audience is exhausted', () => {
    const r = selectDripRecipients({ audience: [], doneIds: [], headroom: 100, perTickMax: 100 })
    expect(r.toSend).toHaveLength(0)
    expect(r.exhausted).toBe(true)
  })
})

describe('dripOutcome', () => {
  const ISO = '2026-06-10T10:00:00.000Z'
  it('finalises to sent when exhausted', () => {
    expect(dripOutcome({ autoPaused: false, exhausted: true }, ISO)).toEqual({ status: 'sent', sent_at: ISO, paused_at: null })
  })
  it('stays sending mid-drip', () => {
    expect(dripOutcome({ autoPaused: false, exhausted: false }, ISO)).toEqual({ status: 'sending' })
  })
  it('pauses (stays sending + paused_at) on auto-pause', () => {
    expect(dripOutcome({ autoPaused: true, exhausted: false }, ISO)).toEqual({ status: 'sending', paused_at: ISO })
  })
  it('auto-pause beats exhaustion', () => {
    expect(dripOutcome({ autoPaused: true, exhausted: true }, ISO)).toEqual({ status: 'sending', paused_at: ISO })
  })
})

describe('constants', () => {
  it('are sane', () => {
    expect(PER_TICK_MAX).toBe(100)
    expect(AUTO_PAUSE_CONSECUTIVE_FAILURES).toBe(5)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/whatsapp-drip.test.js`
Expected: FAIL — "Failed to resolve import './whatsapp-drip.js'" / functions not defined.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/whatsapp-drip.js
// Pure helpers + tunables for the WhatsApp drip broadcast engine (WA-DRIP). No IO
// — unit-tested in whatsapp-drip.test.js. The IO engine (sendDripChunk) lives in
// whatsapp.js and composes these. Client-safe (UI imports estimateDripDays).

// Per-tick send ceiling. A drip's daily_cap drains over several morning ticks
// rather than one burst: at 100/tick + a 15-min cron, a 500/day cap is spent in
// ~5 ticks (~75 min) then idles until the rolling-24h window frees capacity.
export const PER_TICK_MAX = 100

// Auto-pause a drip after this many CONSECUTIVE send failures in one tick. An
// unattended drip runs for days, so a quality-collapse or expired token must stop
// the bleed rather than drain the whole list into failures. (The blast
// sendBroadcast does NOT do this — verified against src/lib/whatsapp.js.)
export const AUTO_PAUSE_CONSECUTIVE_FAILURES = 5

// 'HH:MM' or 'HH:MM:SS' → minutes since local midnight.
function parseHHMM(value) {
  const [h, m] = String(value).slice(0, 5).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

// Minutes-since-local-midnight of `date` in IANA `tz`. DST-safe: Intl resolves the
// correct wall-clock for the instant (Europe/Dublin BST vs GMT included).
// hourCycle:'h23' guarantees 00-23 (no '24' at midnight).
function localMinutesOfDay(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const h = Number(parts.find(p => p.type === 'hour').value)
  const m = Number(parts.find(p => p.type === 'minute').value)
  return h * 60 + m
}

// Is `now` within [start, end) local time-of-day in `tz`? Daytime windows
// (start < end) in practice; a wrap-past-midnight window is handled defensively.
export function isWithinSendWindow(now, { start, end, tz }) {
  const mins = localMinutesOfDay(now, tz)
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  if (s === e) return false              // zero-length window — never send
  if (s < e) return mins >= s && mins < e
  return mins >= s || mins < e           // wraps midnight
}

// How many more we may send in the current rolling-24h window.
export function rollingHeadroom(dailyCap, sentLast24h) {
  return Math.max(0, dailyCap - sentLast24h)
}

// Whole-days estimate to finish the remaining audience at dailyCap/day (ETA).
export function estimateDripDays(remaining, dailyCap) {
  if (remaining <= 0) return 0
  if (dailyCap <= 0) return Infinity
  return Math.ceil(remaining / dailyCap)
}

// Pick this tick's recipients: eligible audience minus already-processed, capped
// to min(headroom, perTickMax). `exhausted` means this batch finishes the list
// (or there was nothing left) — note headroom===0 yields an empty batch that is
// NOT exhaustion (there's capacity-wait, not completion).
export function selectDripRecipients({ audience, doneIds, headroom, perTickMax = PER_TICK_MAX }) {
  const done = new Set(doneIds)
  const remaining = audience.filter(c => !done.has(c.id))
  const cap = Math.max(0, Math.min(headroom, perTickMax))
  const toSend = remaining.slice(0, cap)
  return { toSend, remainingCount: remaining.length, exhausted: remaining.length <= toSend.length }
}

// Decide the broadcast's post-tick row state. autoPaused beats everything (we hit
// the consecutive-failure guard — stay 'sending' but stamp paused_at so the cron
// skips it until an operator resumes); else exhausting the audience finalises to
// 'sent'; else stay 'sending' for the next tick.
export function dripOutcome({ autoPaused, exhausted }, nowIso) {
  if (autoPaused) return { status: 'sending', paused_at: nowIso }
  if (exhausted) return { status: 'sent', sent_at: nowIso, paused_at: null }
  return { status: 'sending' }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp-drip.test.js`
Expected: PASS — all cases green.

- [ ] **Step 5: Guard the DST tests across host timezones**

Run: `for tz in UTC Europe/Dublin America/Los_Angeles Asia/Tokyo; do TZ=$tz npx vitest run src/lib/whatsapp-drip.test.js; done`
Expected: PASS in every host TZ (the helper passes `tz` explicitly to Intl, so it must be host-TZ-independent).

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp-drip.js src/lib/whatsapp-drip.test.js
git commit -m "WA-DRIP.2 — pure drip helpers (window/headroom/selection/outcome/ETA)

DST-safe isWithinSendWindow (Intl, explicit tz), rollingHeadroom, estimateDripDays,
selectDripRecipients (audience minus done, capped to min(headroom, PER_TICK_MAX)),
dripOutcome (finalise/pause/continue) + PER_TICK_MAX=100, AUTO_PAUSE=5. Fully
unit-tested incl. cross-TZ DST guard."
```

---

## Task 3: Paginated audience + done-set fetch helpers

**Files:**
- Modify: `src/lib/whatsapp.js` (add two exported functions near `buildWhatsAppAudience`, ~line 339)
- Test: `src/lib/whatsapp-audience.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/whatsapp-audience.test.js
import { describe, it, expect } from 'vitest'
import { fetchAllWhatsAppAudience, fetchDripDoneContactIds } from './whatsapp.js'

// Fluent fake whose terminal .range() resolves to the next configured page. Every
// other method returns the builder so buildWhatsAppAudience's chain + applyAudienceFilter
// compose without error.
function fakeAudienceDb(pages) {
  let i = 0
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === 'range') return () => Promise.resolve({ data: pages[i++] ?? [], error: null })
      if (prop === 'then') return undefined // builder itself is not awaited
      return () => builder
    },
  })
  return { from: () => builder }
}

describe('fetchAllWhatsAppAudience', () => {
  it('returns a single short page without paging again', async () => {
    const db = fakeAudienceDb([[{ id: 'a' }, { id: 'b' }]])
    const rows = await fetchAllWhatsAppAudience(db, { logic: 'and', filters: [] }, 'loc')
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
  })
  it('pages until a short page ends the loop', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}` }))
    const db = fakeAudienceDb([full, [{ id: 'p2-0' }]]) // 1000 then 1 → stop after page 2
    const rows = await fetchAllWhatsAppAudience(db, { logic: 'and', filters: [] }, 'loc')
    expect(rows).toHaveLength(1001)
    expect(rows[1000].id).toBe('p2-0')
  })
})

describe('fetchDripDoneContactIds', () => {
  function fakeRecipientsDb(pages) {
    let i = 0
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'range') return () => Promise.resolve({ data: pages[i++] ?? [], error: null })
        if (prop === 'then') return undefined
        return () => builder
      },
    })
    return { from: () => builder }
  }
  it('flattens contact_id across pages and drops nulls', async () => {
    const db = fakeRecipientsDb([[{ contact_id: 'x' }, { contact_id: null }, { contact_id: 'y' }]])
    const ids = await fetchDripDoneContactIds(db, 'b1')
    expect(ids).toEqual(['x', 'y'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/whatsapp-audience.test.js`
Expected: FAIL — `fetchAllWhatsAppAudience` / `fetchDripDoneContactIds` are not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/whatsapp.js`, immediately after the `buildWhatsAppAudience` function (ends ~line 339, before `export async function sendBroadcast`), insert:

```js
// Paginate the full WhatsApp-eligible audience (consent + opt-out + wa_phone + the
// operator's audience_filter). buildWhatsAppAudience awaited is capped at the
// project's 1000-row PostgREST limit, so a drip over a large lead list MUST page —
// the >1k pattern from pipeline-reclassify.js. Deterministic order by id so paging
// is stable. Rebuilds the query per page (builders are single-use).
export async function fetchAllWhatsAppAudience(db, filter, locationId) {
  const PAGE = 1000
  const HARD_LIMIT = 50_000
  const rows = []
  let start = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await buildWhatsAppAudience(db, filter, locationId)
      .order('id', { ascending: true })
      .range(start, end)
    if (error) throw new Error(`Audience query failed: ${error.message}`)
    if (!Array.isArray(page) || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE) break
    if (rows.length >= HARD_LIMIT) break
    start += PAGE
  }
  return rows
}

// Paginate the already-processed contact_ids for one broadcast (sent OR failed —
// both insert a recipients row, so both are skipped on resume). Also >1k-safe: a
// long-running drip accumulates thousands of recipient rows.
export async function fetchDripDoneContactIds(db, broadcastId) {
  const PAGE = 1000
  const HARD_LIMIT = 200_000
  const ids = []
  let start = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const end = Math.min(start + PAGE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('whatsapp_broadcast_recipients')
      .select('contact_id')
      .eq('broadcast_id', broadcastId)
      .order('contact_id', { ascending: true })
      .range(start, end)
    if (error) throw new Error(`Recipients query failed: ${error.message}`)
    if (!Array.isArray(page) || page.length === 0) break
    for (const r of page) if (r.contact_id) ids.push(r.contact_id)
    if (page.length < PAGE) break
    if (ids.length >= HARD_LIMIT) break
    start += PAGE
  }
  return ids
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp-audience.test.js`
Expected: PASS — both helpers green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp.js src/lib/whatsapp-audience.test.js
git commit -m "WA-DRIP.3 — paginated audience + done-set fetch for the drip

fetchAllWhatsAppAudience + fetchDripDoneContactIds page past the 1000-row
PostgREST cap (the real >1k risk a naive blast-port would hit), enabling a JS
Set-difference selection that sidesteps the Cloudflare 414. Pinned by tests."
```

---

## Task 4: `sendDripChunk` engine

**Files:**
- Modify: `src/lib/whatsapp.js` (add `sendDripChunk` after `sendBroadcast`; add imports at top)

This is the IO orchestrator. Per the codebase convention (`sms.js → sendBroadcast` has no unit test — it's "integration-tested implicitly through the API route + manual sends"), it is verified via the cron + a manual drip in Task 10, not a mocked-DB unit test. All its decision logic is already unit-tested in Task 2.

- [ ] **Step 1: Add the imports**

At the top of `src/lib/whatsapp.js`, add an import for the pure helpers. Place it with the other imports (the file already imports `createServerClient`, `getWhatsAppConfig`, etc.):

```js
import {
  PER_TICK_MAX, AUTO_PAUSE_CONSECUTIVE_FAILURES,
  rollingHeadroom, selectDripRecipients, dripOutcome,
} from './whatsapp-drip.js'
```

- [ ] **Step 2: Add the engine**

After `sendBroadcast` (ends ~line 459), append:

```js
/**
 * Send one cron tick's worth of a paced WhatsApp broadcast (WA-DRIP).
 *
 * Mirrors the blast sendBroadcast send loop but: (1) caps the tick to the rolling
 * -24h headroom and PER_TICK_MAX, (2) resumes via the recipients table, (3) auto-
 * pauses on a run of failures, (4) leaves the row 'sending' until the audience is
 * exhausted. The run-whatsapp-broadcasts cron gates the send window and only calls
 * this for delivery_mode='drip', status='sending', paused_at IS NULL.
 *
 * Concurrency: the 15-min cadence + a fast tick (<=100 sends) means two ticks for
 * the same drip never overlap, so pre-filtering done-ids is sufficient; the unique
 * (broadcast_id, contact_id) constraint is the belt-and-braces backstop.
 *
 * @param {string} broadcastId
 * @param {object} [opts]
 * @param {number} [opts.perTickMax=PER_TICK_MAX]
 * @returns {Promise<{status:string, sent:number, failed:number, recipients?:number, paused?:boolean, skipped?:string}>}
 */
export async function sendDripChunk(broadcastId, { perTickMax = PER_TICK_MAX } = {}) {
  const db = createServerClient()

  const { data: broadcast, error: bErr } = await db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(*)')
    .eq('id', broadcastId)
    .single()
  if (bErr || !broadcast) throw new Error('Broadcast not found')
  if (broadcast.delivery_mode !== 'drip') throw new Error('Not a drip broadcast')
  if (broadcast.status !== 'sending') return { status: broadcast.status, skipped: 'not_sending', sent: 0, failed: 0 }
  if (broadcast.paused_at) return { status: 'sending', skipped: 'paused', sent: 0, failed: 0 }

  // Template gate — also covers Meta disabling a template mid-drip: auto-pause so
  // the operator notices rather than the list draining into template errors.
  const template = broadcast.whatsapp_templates
  if (!template || template.status !== 'APPROVED') {
    await db.from('whatsapp_broadcasts')
      .update({ paused_at: new Date().toISOString() })
      .eq('id', broadcastId)
    return { status: 'sending', skipped: 'template_not_approved', paused: true, sent: 0, failed: 0 }
  }

  // Rolling-24h headroom. head:true count — the .select() is the first one off
  // .from() so it reads the count option (see CLAUDE.md postgrest two-overload lesson).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count: sentLast24h } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'sent')
    .gt('sent_at', since)
  const headroom = rollingHeadroom(broadcast.daily_cap, sentLast24h || 0)
  if (headroom <= 0) return { status: 'sending', skipped: 'no_headroom', headroom: 0, sent: 0, failed: 0 }

  // Eligible audience (paginated) minus already-processed, capped to this tick.
  const audience = await fetchAllWhatsAppAudience(db, broadcast.audience_filter, broadcast.location_id)
  if (audience.length === 0) {
    await db.from('whatsapp_broadcasts').update({
      status: 'sent', sent_at: new Date().toISOString(), total_recipients: 0,
    }).eq('id', broadcastId)
    return { status: 'sent', sent: 0, failed: 0, recipients: 0 }
  }
  const doneIds = await fetchDripDoneContactIds(db, broadcastId)
  const { toSend, exhausted } = selectDripRecipients({ audience, doneIds, headroom, perTickMax })

  if (toSend.length === 0) {
    if (exhausted) {
      await db.from('whatsapp_broadcasts').update({
        status: 'sent', sent_at: new Date().toISOString(), total_recipients: audience.length,
      }).eq('id', broadcastId)
      return { status: 'sent', sent: 0, failed: 0, recipients: audience.length }
    }
    return { status: 'sending', skipped: 'no_capacity', sent: 0, failed: 0 }
  }

  // Resolve the location's WA config once for the whole tick (as the blast does).
  const config = await getWhatsAppConfig(broadcast.location_id)
  const variableMapping = broadcast.variable_mapping || {}
  let sent = 0, failed = 0, consecutiveFailures = 0, autoPaused = false

  for (const contact of toSend) {
    try {
      const components = buildTemplateComponents(template, contact, variableMapping, broadcast.header_media_url)
      const result = await sendTemplateMessage(contact.wa_phone, template.name, template.language, components, { config })

      await db.from('whatsapp_broadcast_recipients').insert({
        broadcast_id: broadcastId, contact_id: contact.id,
        wa_message_id: result.messageId, status: 'sent', sent_at: new Date().toISOString(),
      })
      await db.from('whatsapp_messages').insert({
        conversation_id: await getOrCreateConversation(db, contact, broadcast.location_id),
        contact_id: contact.id, location_id: broadcast.location_id,
        wa_message_id: result.messageId, direction: 'outbound', message_type: 'template',
        template_name: template.name, template_variables: variableMapping,
        status: 'sent', broadcast_id: broadcastId, sent_at: new Date().toISOString(),
      })
      sent++; consecutiveFailures = 0
    } catch (err) {
      console.error(`[drip ${broadcastId}] send to ${contact.wa_phone} failed:`, err.message)
      await db.from('whatsapp_broadcast_recipients').insert({
        broadcast_id: broadcastId, contact_id: contact.id,
        status: 'failed', error_message: err.message, failed_at: new Date().toISOString(),
      })
      failed++; consecutiveFailures++
      if (consecutiveFailures >= AUTO_PAUSE_CONSECUTIVE_FAILURES) { autoPaused = true; break }
    }
    // Same conservative rate-limit as the blast sender (~50/sec ceiling).
    if (sent % 50 === 0 && sent > 0) await new Promise(r => setTimeout(r, 1000))
  }

  // Cumulative totals from the recipients table.
  const { count: totalSent } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'sent')
  const { count: totalFailed } = await db.from('whatsapp_broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId).eq('status', 'failed')

  // We truly exhausted the audience only if we sent the last batch WITHOUT auto-
  // pausing partway (a pause leaves unsent contacts for the resume).
  const reallyExhausted = exhausted && !autoPaused && (sent + failed) >= toSend.length
  const outcome = dripOutcome({ autoPaused, exhausted: reallyExhausted }, new Date().toISOString())

  await db.from('whatsapp_broadcasts').update({
    ...outcome,
    total_recipients: audience.length,
    total_sent: totalSent || 0,
    total_failed: totalFailed || 0,
  }).eq('id', broadcastId)

  return { status: outcome.status, paused: !!outcome.paused_at, sent, failed, recipients: audience.length }
}
```

- [ ] **Step 3: Verify the module compiles (full test suite + lint)**

Run: `npx vitest run src/lib/whatsapp-drip.test.js src/lib/whatsapp-audience.test.js && npm run lint`
Expected: PASS — existing tests unaffected, no lint errors (the `no-constant-condition` disables are in place; `console.error` is allowed for error paths).

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp.js
git commit -m "WA-DRIP.4 — sendDripChunk engine (paced, resumable, auto-pausing)

One cron tick of a drip: rolling-24h headroom → paginated audience minus done →
selectDripRecipients → reuse the existing template send loop → recompute totals →
dripOutcome (finalise 'sent' on exhaustion, stamp paused_at on a 5-failure run or
a non-APPROVED template). Composes the unit-tested helpers; verified via the cron."
```

---

## Task 5: Cron route + `vercel.json`

**Files:**
- Create: `src/app/api/cron/run-whatsapp-broadcasts/route.js`
- Modify: `vercel.json`

- [ ] **Step 1: Write the cron route**

```js
// src/app/api/cron/run-whatsapp-broadcasts/route.js
// Vercel cron — every 15 min. Picks up in-flight drip broadcasts and sends one
// chunk each, but only while the broadcast is inside its configured send window.
// Mirrors run-sms-broadcasts. Auth via Authorization: Bearer ${CRON_SECRET}.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendDripChunk } from '@/lib/whatsapp'
import { isWithinSendWindow } from '@/lib/whatsapp-drip'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Pro ceiling

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const now = new Date()

  // Active drips only: delivery_mode='drip', status='sending', not paused.
  const { data: drips, error } = await db.from('whatsapp_broadcasts')
    .select('id, name, location_id, send_window_start, send_window_end, send_window_tz')
    .eq('delivery_mode', 'drip')
    .eq('status', 'sending')
    .is('paused_at', null)
    .order('updated_at', { ascending: true })
    .limit(20)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const stats = { found: drips.length, sent: 0, failed: 0, finished: 0, in_progress: 0, outside_window: 0, errors: [] }

  for (const row of drips) {
    try {
      const inWindow = isWithinSendWindow(now, {
        start: row.send_window_start, end: row.send_window_end, tz: row.send_window_tz,
      })
      if (!inWindow) { stats.outside_window++; continue }

      const r = await sendDripChunk(row.id)
      stats.sent += r.sent || 0
      stats.failed += r.failed || 0
      if (r.status === 'sent') stats.finished++
      else stats.in_progress++
    } catch (e) {
      const msg = e?.message || String(e)
      console.warn(`[cron run-whatsapp-broadcasts] drip ${row.id} (${row.name}) failed: ${msg}`)
      stats.errors.push({ broadcast_id: row.id, error: msg })
    }
  }

  await stampHeartbeat('run-whatsapp-broadcasts')
  return NextResponse.json({ success: true, stats })
}
```

- [ ] **Step 2: Register the cron in `vercel.json`**

Add this object to the `crons` array (alongside the existing `run-sms-broadcasts` entry). Open `vercel.json`, find `"crons": [` and add:

```json
    { "path": "/api/cron/run-whatsapp-broadcasts", "schedule": "*/15 * * * *" }
```

Ensure the surrounding array stays valid JSON (add a comma after the preceding entry; no trailing comma after the last).

- [ ] **Step 3: Verify lint + the heartbeat-stamp invariant**

Run: `npm run lint && grep -L stampHeartbeat src/app/api/cron/*/route.js`
Expected: lint clean; the `grep -L` lists only `health-check/route.js` (every other cron, including the new one, calls `stampHeartbeat` — see the CLAUDE.md heartbeat-or-bust lesson).

- [ ] **Step 4: Verify the route resolves in a production build**

Run: `npm run build`
Expected: build succeeds and the route `/api/cron/run-whatsapp-broadcasts` appears in the route manifest. (A new route + new `import` is exactly the class CLAUDE.md flags as catchable only by a real `next build`.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/run-whatsapp-broadcasts/route.js vercel.json
git commit -m "WA-DRIP.5 — run-whatsapp-broadcasts cron (15 min, window-gated)

Pulls delivery_mode='drip' + status='sending' + paused_at IS NULL rows, skips any
outside its send window (isWithinSendWindow), otherwise sends one sendDripChunk.
Stamps the heartbeat every tick. Registered in vercel.json at */15."
```

---

## Task 6: Create API — accept pacing fields, route status

**Files:**
- Modify: `src/app/api/whatsapp/broadcasts/route.js` (schema lines 8–15, insert lines 59–68)

- [ ] **Step 1: Extend the Zod schema**

Replace the import line and `BroadcastCreateSchema` (lines 6–15). Current:

```js
import { uuidLike, audienceFilterSchema, url } from '@/lib/schemas'

const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  template_id: uuidLike,
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  location_id: uuidLike.optional(),
})
```

New:

```js
import { uuidLike, audienceFilterSchema, url, timeOfDay } from '@/lib/schemas'

const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  template_id: uuidLike,
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  location_id: uuidLike.optional(),
  // WA-DRIP — paced delivery. Defaults keep the blast path identical.
  delivery_mode: z.enum(['blast', 'drip']).optional().default('blast'),
  daily_cap: z.number().int().positive().max(100000).optional(),
  send_window_start: timeOfDay.optional(),
  send_window_end: timeOfDay.optional(),
  send_window_tz: z.string().max(64).optional(),
})
```

> If `timeOfDay` is not exported from `@/lib/schemas` (CLAUDE.md lists it, but verify with `grep -n "export const timeOfDay" src/lib/schemas.js`), substitute `z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/)` for both window fields and drop the import change.

- [ ] **Step 2: Route the insert by delivery mode**

Replace the insert block (lines 58–68). Current:

```js
  const db = createServerClient()
  const { data, error } = await db.from('whatsapp_broadcasts').insert({
    name: body.name || 'Untitled Broadcast',
    template_id: body.template_id,
    variable_mapping: body.variable_mapping || {},
    header_media_url: body.header_media_url || null,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    status: 'draft',
    location_id: locationId,
    created_by: user.id,
  }).select().single()
```

New:

```js
  const db = createServerClient()
  const isDrip = body.delivery_mode === 'drip'
  const { data, error } = await db.from('whatsapp_broadcasts').insert({
    name: body.name || 'Untitled Broadcast',
    template_id: body.template_id,
    variable_mapping: body.variable_mapping || {},
    header_media_url: body.header_media_url || null,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    // A drip starts immediately — the run-whatsapp-broadcasts cron drives it during
    // the send window. A blast stays 'draft' until the operator fires /send.
    status: isDrip ? 'sending' : 'draft',
    delivery_mode: body.delivery_mode || 'blast',
    ...(isDrip ? {
      daily_cap: body.daily_cap ?? 500,
      send_window_start: body.send_window_start || '09:00',
      send_window_end: body.send_window_end || '20:00',
      send_window_tz: body.send_window_tz || 'Europe/Dublin',
    } : {}),
    location_id: locationId,
    created_by: user.id,
  }).select().single()
```

- [ ] **Step 3: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: clean — the route still resolves and the new schema fields compile.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/whatsapp/broadcasts/route.js
git commit -m "WA-DRIP.6 — create API accepts pacing fields, starts drips immediately

BroadcastCreateSchema gains delivery_mode/daily_cap/send_window_*. A drip is
inserted at status='sending' (cron-driven) with its window+cap; a blast is
unchanged (status='draft', fired via /send)."
```

---

## Task 7: Pause / Resume API

**Files:**
- Create: `src/app/api/whatsapp/broadcasts/[id]/pause/route.js`

- [ ] **Step 1: Write the route**

```js
// src/app/api/whatsapp/broadcasts/[id]/pause/route.js
// POST /api/whatsapp/broadcasts/[id]/pause — set or clear paused_at on a drip.
// { paused: true } stops the cron from picking it up; { paused: false } resumes.
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const PauseSchema = z.object({ paused: z.boolean() })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, PauseSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: broadcast } = await db.from('whatsapp_broadcasts')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!broadcast) return NextResponse.json({ success: false, error: 'Broadcast not found' }, { status: 404 })

  const guard = assertLocationAccess(user, broadcast.location_id)
  if (guard) return guard

  const { data, error } = await db.from('whatsapp_broadcasts')
    .update({ paused_at: validation.data.paused ? new Date().toISOString() : null })
    .eq('id', params.id)
    .select('id, paused_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}
```

- [ ] **Step 2: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: clean; the new route appears in the manifest.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/whatsapp/broadcasts/[id]/pause/route.js"
git commit -m "WA-DRIP.7 — pause/resume API for drip broadcasts

POST .../[id]/pause { paused } sets/clears paused_at (auth + location guard). The
cron's paused_at IS NULL filter does the rest."
```

> zsh note: single-quote the bracketed path in `git add` (see CLAUDE.md).

---

## Task 8: Pacing UI + drip branch in the unified composer

**Files:**
- Modify: `src/components/communications/UnifiedSendComposer.jsx`

- [ ] **Step 1: Add pacing state**

After the WhatsApp state block (after line 38, `const [variables, setVariables] = useState({})`), add:

```js
  // WhatsApp pacing (WA-DRIP)
  const [waMode, setWaMode] = useState('blast') // 'blast' | 'drip'
  const [dailyCap, setDailyCap] = useState(500)
  const [windowStart, setWindowStart] = useState('09:00')
  const [windowEnd, setWindowEnd] = useState('20:00')
```

- [ ] **Step 2: Add an `isDrip` derived flag**

After the `isSchedule` line (line 114), add:

```js
  const isDrip = channel === 'whatsapp' && waMode === 'drip'
```

- [ ] **Step 3: Branch the WhatsApp submit**

Replace the WhatsApp branch in `send()` (lines 147–153):

```js
      } else if (channel === 'whatsapp') {
        const { broadcast } = await postJson('/api/whatsapp/broadcasts', {
          name: defaultLabel(), template_id: templateId, variable_mapping: variables,
          audience_filter: effectiveFilter, location_id: locationId,
        })
        const data = await postJson(`/api/whatsapp/broadcasts/${broadcast.id}/send`, {})
        setResult({ channel, mode: 'sent', id: broadcast.id, detail: `/whatsapp/broadcasts/${broadcast.id}`, ...data })
      } else {
```

with:

```js
      } else if (channel === 'whatsapp') {
        const drip = waMode === 'drip'
        const { broadcast } = await postJson('/api/whatsapp/broadcasts', {
          name: defaultLabel(), template_id: templateId, variable_mapping: variables,
          audience_filter: effectiveFilter, location_id: locationId,
          delivery_mode: waMode,
          ...(drip ? {
            daily_cap: Number(dailyCap) || 500,
            send_window_start: windowStart, send_window_end: windowEnd,
            send_window_tz: 'Europe/Dublin',
          } : {}),
        })
        if (drip) {
          // Create set status='sending'; the run-whatsapp-broadcasts cron drives
          // it during the window. No /send call for a drip.
          setResult({ channel, mode: 'drip', id: broadcast.id, detail: `/whatsapp/broadcasts/${broadcast.id}`,
            dailyCap: Number(dailyCap) || 500, windowStart, windowEnd })
        } else {
          const data = await postJson(`/api/whatsapp/broadcasts/${broadcast.id}/send`, {})
          setResult({ channel, mode: 'sent', id: broadcast.id, detail: `/whatsapp/broadcasts/${broadcast.id}`, ...data })
        }
      } else {
```

- [ ] **Step 4: Reset pacing on "Send another"**

In `reset()` (line 191), append the pacing resets:

```js
  function reset() {
    setResult(null); setError(null); setBody(''); setTemplateId(''); setVariables({})
    setLabel(''); setFilter(EMPTY_FILTER); setScheduleMode('now'); setScheduledAtLocal('')
    setWaMode('blast'); setDailyCap(500); setWindowStart('09:00'); setWindowEnd('20:00')
  }
```

- [ ] **Step 5: Add the drip result screen + icon**

In the result block, change the icon line (line 200–202) from:

```jsx
          {result.mode === 'scheduled' ? <Clock size={22} /> : <Check size={22} />}
```

to:

```jsx
          {result.mode === 'scheduled' || result.mode === 'drip' ? <Clock size={22} /> : <Check size={22} />}
```

Then add a drip branch as the FIRST case of the mode conditional. Replace the opening of the conditional (line 203, `{result.mode === 'scheduled' ? (`) with:

```jsx
        {result.mode === 'drip' ? (
          <>
            <h2 className="text-lg font-semibold text-un1t-text">Drip started</h2>
            <p className="text-sm text-un1t-subtle mt-1">
              Up to {result.dailyCap}/day will go out between {result.windowStart} and {result.windowEnd} (Europe/Dublin)
              until everyone&apos;s been messaged. Pause or track progress on the details page.
            </p>
          </>
        ) : result.mode === 'scheduled' ? (
```

(The existing `scheduled` and `sent` branches are preserved after this — the `:` chain now has three arms.)

- [ ] **Step 6: Add the Pacing section UI**

After the Message `</Section>` (line 350) and before the When section (`{(channel === 'sms' || channel === 'email') && (`), insert:

```jsx
      {/* Pacing — WhatsApp only (WA-DRIP) */}
      {channel === 'whatsapp' && (
        <Section title="Pacing" sub="Send all at once, or drip a capped number per day until everyone's been messaged — the safe way to work a large list without tripping WhatsApp's per-day limits.">
          <div className="flex gap-2 mb-3">
            <ChannelPill active={waMode === 'blast'} onClick={() => setWaMode('blast')} icon={Send} label="Send now" small />
            <ChannelPill active={waMode === 'drip'} onClick={() => setWaMode('drip')} icon={Clock} label="Drip" small />
          </div>
          {waMode === 'drip' && (
            <div className="space-y-3">
              <label className="block">
                <span className="block text-xs font-medium text-un1t-subtle mb-1">Daily limit (messages per 24h)</span>
                <input type="number" min={1} max={100000} className={fieldCls}
                  value={dailyCap} onChange={e => setDailyCap(e.target.value)} />
              </label>
              <div className="flex gap-3">
                <label className="block flex-1">
                  <span className="block text-xs font-medium text-un1t-subtle mb-1">Send from</span>
                  <input type="time" className={fieldCls} value={windowStart} onChange={e => setWindowStart(e.target.value)} />
                </label>
                <label className="block flex-1">
                  <span className="block text-xs font-medium text-un1t-subtle mb-1">Send until</span>
                  <input type="time" className={fieldCls} value={windowEnd} onChange={e => setWindowEnd(e.target.value)} />
                </label>
              </div>
              <p className="text-[11px] text-un1t-subtle">Europe/Dublin time. The drip pauses overnight and resumes each morning.</p>
            </div>
          )}
        </Section>
      )}
```

- [ ] **Step 7: Label the action button for drips**

Change the submit button label (line 377). Current:

```jsx
          {isSchedule ? 'Schedule' : 'Send now'}
```

New:

```jsx
          {isSchedule ? 'Schedule' : isDrip ? 'Start drip' : 'Send now'}
```

- [ ] **Step 8: Verify lint (incl. the Next link rule) + build**

Run: `npx next lint && npm run build`
Expected: clean. (Use `next lint`, not just `npm run lint` — CLAUDE.md notes the no-html-link rule only fires under `next lint`. This change adds no `<a>` tags, but the verification habit is required for UI changes.)

- [ ] **Step 9: Commit**

```bash
git add src/components/communications/UnifiedSendComposer.jsx
git commit -m "WA-DRIP.8 — Pacing (Blast/Drip) controls in the unified composer

WhatsApp channel gains a Pacing section (Send now | Drip + daily limit + send
window). Drip create posts delivery_mode='drip' + cap/window and skips /send (the
cron drives it); button reads 'Start drip'; a 'Drip started' result screen links
to the detail page."
```

---

## Task 9: In-flight drip status panel in the broadcast editor

**Files:**
- Modify: `src/components/WABroadcastEditor.jsx`

The detail page (`src/app/whatsapp/broadcasts/[id]/page.js`) renders this editor for every broadcast. A drip in `status='sending'` must show a read-only progress panel (not the editable setup view).

- [ ] **Step 1: Add the import + derived flags + pause state**

At the top, add to the imports (after line 7, `import AudienceBuilder...`):

```js
import { estimateDripDays } from '@/lib/whatsapp-drip'
```

After `const isSent = broadcast?.status === 'sent'` (line 11), add:

```js
  const isDripInFlight = broadcast?.delivery_mode === 'drip' && broadcast?.status === 'sending'
```

After `const [sending, setSending] = useState(false)` (line 22), add:

```js
  const [pausing, setPausing] = useState(false)
```

- [ ] **Step 2: Add the pause/resume handler**

After `handleSend` (after line 109), add:

```js
  async function handlePauseToggle() {
    setPausing(true)
    setError(null)
    try {
      const paused = !broadcast.paused_at
      const res = await fetch(`/api/whatsapp/broadcasts/${broadcastId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      }).then(r => r.json())
      if (!res.success) throw new Error(res.error)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setPausing(false)
    }
  }
```

- [ ] **Step 3: Hide the Save/Send top-bar actions for an in-flight drip**

Change the top-bar actions guard (line 138). Current:

```jsx
        {!isSent && (
          <div className="flex items-center gap-2">
```

New:

```jsx
        {!isSent && !isDripInFlight && (
          <div className="flex items-center gap-2">
```

- [ ] **Step 4: Render the drip status panel + hide the setup view for an in-flight drip**

In the content area, the setup view is gated by `{!isSent && (` (line 257). Change it to `{!isSent && !isDripInFlight && (`. Then, immediately BEFORE that block (before line 257), insert the panel:

```jsx
        {isDripInFlight && (
          <div className="max-w-2xl space-y-4">
            {broadcast.paused_at && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 text-sm px-4 py-2">
                Paused — resume to continue sending.
              </div>
            )}
            <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-un1t-subtle uppercase tracking-wider">Drip in progress</h3>
                <button
                  onClick={handlePauseToggle}
                  disabled={pausing}
                  className="text-sm border border-un1t-border px-3 py-1.5 rounded-md hover:border-un1t-text/30 transition-colors disabled:opacity-50"
                >
                  {pausing ? '…' : broadcast.paused_at ? 'Resume' : 'Pause'}
                </button>
              </div>
              {(() => {
                const total = broadcast.total_recipients || 0
                const done = (broadcast.total_sent || 0) + (broadcast.total_failed || 0)
                const remaining = Math.max(0, total - done)
                const pct = total > 0 ? Math.round((done / total) * 100) : 0
                const days = estimateDripDays(remaining, broadcast.daily_cap || 500)
                return (
                  <>
                    <div className="h-2 bg-un1t-border/40 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-center">
                      <DripStat label="Sent" value={broadcast.total_sent || 0} />
                      <DripStat label="Failed" value={broadcast.total_failed || 0} />
                      <DripStat label="Remaining" value={remaining} />
                      <DripStat label="Est. days left" value={remaining === 0 ? '0' : `~${days}`} />
                    </div>
                    <p className="text-xs text-un1t-muted">
                      Up to {broadcast.daily_cap || 500}/day · {String(broadcast.send_window_start).slice(0, 5)}–{String(broadcast.send_window_end).slice(0, 5)} {broadcast.send_window_tz}
                    </p>
                  </>
                )
              })()}
            </div>
          </div>
        )}

```

- [ ] **Step 5: Add the `DripStat` helper component**

At the very bottom of the file (after the default-export component's closing brace, line 355), add:

```jsx
function DripStat({ label, value }) {
  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-lg p-3">
      <p className="text-xs text-un1t-subtle uppercase">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
    </div>
  )
}
```

- [ ] **Step 6: Verify lint + build**

Run: `npx next lint && npm run build`
Expected: clean. `estimateDripDays` is a pure import (no server-only deps) so it's safe in this client component.

- [ ] **Step 7: Commit**

```bash
git add src/components/WABroadcastEditor.jsx
git commit -m "WA-DRIP.9 — in-flight drip status panel (progress, ETA, pause/resume)

For delivery_mode='drip' + status='sending' the broadcast editor shows a read-only
panel: progress bar, sent/failed/remaining, estimateDripDays ETA, the cap+window,
and a Pause/Resume button (POST .../pause). Setup view + Save/Send hidden while a
drip is in flight; completed drips fall through to the existing results view."
```

---

## Task 10: Full verification + ship

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports`
Expected: all green. (This feature is web-only — no `shared/permissions.js` or `WEB_PERMISSIONS` change — so parity has nothing new to reconcile. If parity complains, something unintended changed; investigate before proceeding.)

- [ ] **Step 2: Run a real production build**

Run: `npm run build`
Expected: success. This is the gate that catches import-resolution / Turbopack failures the test+lint pass misses (two new routes + new cross-module imports = exactly that risk class).

- [ ] **Step 3: Confirm the migration is applied in production**

Re-run the Task 1 Step 3 verification query via MCP `execute_sql`. Expected: the 6 columns, the unique constraint, and the heartbeat row are all present (the migration was applied in Task 1; this confirms nothing regressed).

- [ ] **Step 4: Manual click-test a real drip (auth-gated — cannot be unit-verified)**

This is the one path no test covers. Do it against the deployed preview/prod:
1. Go to `/communications/send`, pick the WhatsApp channel, choose a SMALL test audience (e.g. an `id in (…)` of 2–3 opted-in test contacts), pick an APPROVED template.
2. In Pacing choose **Drip**, set daily limit `2`, window to a range that includes "now" in Dublin. Click **Start drip**. Confirm the "Drip started" result.
3. Open the detail page (`/whatsapp/broadcasts/[id]`) — confirm the progress panel renders with cap/window and a Pause button.
4. Manually fire one cron tick (so you don't wait 15 min):
   ```bash
   curl -s -H "Authorization: Bearer $CRON_SECRET" https://crm.un1tdublin.com/api/cron/run-whatsapp-broadcasts | python3 -m json.tool
   ```
   Expected JSON: `stats.found >= 1` and either `sent > 0` (in window) or `outside_window >= 1` (out of window — adjust the broadcast's window to include now and retry).
5. Verify the test contacts received the message; refresh the detail page — sent count advanced, ETA shown.
6. Click **Pause**, fire the cron again → `stats.found` excludes it (paused_at set). Click **Resume** → it's picked up again.
7. Let it run until exhausted (or fire ticks until `remaining` hits 0) → status flips to `sent`, the results view renders.

Record the outcome in the PR description. If anything misbehaves, STOP and debug (systematic-debugging) before merging — do NOT merge an unverified send path.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin whatsapp-drip-broadcast
TOKEN=$(git config --get remote.origin.url | sed -E 's|.*x-access-token:([^@]+)@.*|\1|')
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ivers9307-cyber/un1t-crm/pulls \
  -d @- <<'JSON' | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('html_url') or r.get('message') or r)"
{
  "title": "WA-DRIP — WhatsApp drip broadcast (paced, daily-capped, daytime-only)",
  "head": "whatsapp-drip-broadcast",
  "base": "main",
  "body": "## WhatsApp drip broadcast\n\nSend a WhatsApp broadcast to a filtered lead list that delivers up to a configurable number/24h (default 500), only during a daytime window (default 09:00–20:00 Europe/Dublin), resuming daily until everyone eligible has been messaged once.\n\n**Spec:** docs/superpowers/specs/2026-06-10-whatsapp-drip-broadcast-design.md\n**Plan:** docs/superpowers/plans/2026-06-10-whatsapp-drip-broadcast.md\n\n### What shipped\n- **mig 253** — pacing columns on whatsapp_broadcasts, UNIQUE(broadcast_id, contact_id) on recipients (the resume/idempotency key — the table only had a PK on id), run-whatsapp-broadcasts heartbeat row.\n- **src/lib/whatsapp-drip.js** — pure, unit-tested helpers (DST-safe window check, rolling headroom, recipient selection, finalisation, ETA) + tunables (PER_TICK_MAX=100, AUTO_PAUSE=5).\n- **src/lib/whatsapp.js** — paginated audience + done-set fetch (>1k-safe; sidesteps the 414) + sendDripChunk engine (paced, resumable, auto-pausing; reuses the existing template send loop).\n- **run-whatsapp-broadcasts cron** (every 15 min, window-gated) + vercel.json.\n- **Create API** accepts delivery_mode/daily_cap/window; a drip starts at status='sending'.\n- **Pause/Resume API** + Pacing UI in the unified composer + an in-flight drip status panel (progress/ETA/pause/resume) in the broadcast editor.\n\n### Guardrails\nConsent (whatsapp_marketing) + opt-out via buildWhatsAppAudience; APPROVED MARKETING template required (auto-pause if Meta disables it mid-drip); auto-pause after 5 consecutive failures.\n\n### Verified\nN tests pass (incl. cross-TZ DST guard), lint clean, build clean, parity clean. Manual drip click-test: <fill in the Step 4 outcome — created, ticked the cron, messages delivered, pause/resume, exhaustion→sent>."
}
JSON
```

Report the returned PR URL to the user.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

| Spec section | Task |
|---|---|
| Data model (6 columns) | T1 |
| Recipients unique key (spec: "add if missing" → confirmed missing) | T1 |
| Cron heartbeat row | T1 |
| Engine: rolling-24h headroom | T2 (`rollingHeadroom`) + T4 (count query) |
| Engine: select next eligible (paginated, not RPC) | T2 (`selectDripRecipients`) + T3 (pagination) + T4 |
| Engine: send loop reusing sendTemplateMessage/buildTemplateComponents/getOrCreateConversation | T4 |
| Engine: exhaustion → 'sent' | T2 (`dripOutcome`) + T4 |
| Cron (window-gated, 15 min, maxDuration 300, heartbeat) | T5 |
| Send-window helper (pure, DST-safe, unit-tested) | T2 (`isWithinSendWindow`) |
| UI: Pacing section (Blast/Drip + cap + window) | T8 |
| UI: detail ETA + Pause/Resume | T9 (+ T7 API) |
| Guardrail: auto-pause on consecutive failures | T2/T4 |
| Guardrail: consent + opt-out | reused via `buildWhatsAppAudience` (T3/T4) |
| Guardrail: APPROVED template (+ disabled-mid-drip → auto-pause) | T4 |
| Testing: pure helpers + ETA | T2 |
| Testing: recipient-dedup, cap-respected, exhaustion | T2 (`selectDripRecipients`, `rollingHeadroom`, `dripOutcome`) |

Open questions 1–4 resolved in the "Decisions resolved" section. No spec requirement is left without a task.

**2. Placeholder scan** — every code step contains complete code (migration SQL, full helper module, full engine, full cron, full route, exact UI edits with before/after anchors). No "TBD"/"add validation"/"similar to Task N". The one conditional is the `timeOfDay` import fallback in T6, which gives the exact substitute regex.

**3. Type/name consistency** — checked across tasks:
- `PER_TICK_MAX`, `AUTO_PAUSE_CONSECUTIVE_FAILURES` defined in T2, imported in T4.
- `selectDripRecipients` returns `{ toSend, remainingCount, exhausted }` (T2) — consumed as `{ toSend, exhausted }` in T4. ✓
- `dripOutcome(...)` returns `{ status, sent_at?, paused_at? }` (T2) — spread into the update in T4. ✓
- `fetchAllWhatsAppAudience(db, filter, locationId)` / `fetchDripDoneContactIds(db, broadcastId)` defined T3, called T4. ✓
- `sendDripChunk(broadcastId)` defined T4, called by the cron T5. ✓
- `isWithinSendWindow(now, { start, end, tz })` defined T2, called by the cron T5. ✓
- `estimateDripDays(remaining, dailyCap)` defined T2, imported in the UI T9. ✓
- Pause API contract `{ paused: boolean }` (T7) matches the UI call body (T9). ✓
- Create payload fields `delivery_mode`/`daily_cap`/`send_window_start`/`send_window_end`/`send_window_tz` (T8 UI) match the schema + insert (T6) and the migration columns (T1). ✓
- Result `mode: 'drip'` set in T8 submit, rendered in T8 result screen. ✓

No inconsistencies found.

---

## Execution notes

- All work happens in the existing worktree `/Users/richardivers/code/un1t-crm-spec` on branch `whatsapp-drip-broadcast` (the spec + this plan already live there). The user works concurrently in the main checkout, so do NOT touch their working tree.
- The send path is auth-gated and cannot be unit-verified — Task 10 Step 4 is mandatory before merge.
- If `sendDripChunk` misbehaves under load, the smallest revert is the cron (`vercel.json` entry + route) — a drip then simply stops advancing with no data loss (recipients already sent stay recorded).
