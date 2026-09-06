# Host Scheduled Send (HOST-SCHEDULE.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host can schedule an email for a Dublin date and time; the sweeper launches it within two minutes of that time through the same gates as Send now, and a gate refusal returns it to draft with a visible reason.

**Architecture:** Mig 592 adds `scheduled` to the `host_campaigns` status check plus `scheduled_for` / `schedule_error`. The send route's gate-and-enqueue body moves, unchanged, into `launchHostCampaign()` in a new `host-campaign-launch.js`; the send route becomes a thin wrapper and the sweeper cron calls the same function for due `scheduled` rows (CAS `scheduled → sending` is the lock). Two small routes schedule / unschedule. A browser-safe `host-schedule-time.js` owns the Dublin wall-clock conversions and the plain-language refusal copy; `HostEmails.jsx` gains a Schedule button, an inline date/time panel and the scheduled-row actions.

**Tech Stack:** Next.js 16 App Router, Supabase (service role; migrations via MCP), vitest (+ @testing-library/react for the one render test), zod.

**Spec:** `docs/superpowers/specs/2026-09-07-host-scheduled-send-design.md` (commit 82bc99b6).

**Repo rules:** every `.select()` capped at 1,000 rows (all selects here are `.limit()`ed or single-row); supabase builders are thenables (no `.catch`); destructure `error` on every write; `[id]` paths need quotes in zsh; branch `host-scheduled-send` in worktree `~/code/un1t-crm-hostconsent`; commit per task; never `git add -A`; no em-dashes in new customer-facing copy (the pre-existing 409 messages are moved verbatim, not rewritten). Parallel waves: implementers in the same wave touch disjoint files and never stage or commit; the controller commits. Test files sit beside their source (`x.test.js`), and route tests mock `@/lib/supabase`, `@/lib/host-auth` etc. exactly as the sibling tests do.

CI mirror before pushing:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

**One deviation from the spec, decided while planning:** spec §6 says a `launch_failed` leaves the campaign as `draft`. That is only true for a failure BEFORE the CAS. A failure AFTER the CAS (an enqueue error) has already flipped the row to `sending` and the cron drains whatever landed, exactly as Send now behaves today. The sweeper's back-to-draft update is therefore itself a CAS on `status = 'scheduled'`, so it is a no-op in that case. Task 8 updates the spec sentence.

---

## File map and waves

| Wave | Task | Files |
|---|---|---|
| A | 1 Migration 592 | NEW `supabase/migrations/592_host_campaign_schedule.sql` |
| A | 2 Launch lib | NEW `src/lib/host-campaign-launch.js`, NEW `.test.js` |
| A | 3 Schedule-time helpers | NEW `src/lib/host-schedule-time.js`, NEW `.test.js` |
| B | 4 Schedule + unschedule routes + OpenAPI | NEW `src/app/api/host/emails/[id]/schedule/route.js`, `.test.js`, NEW `src/app/api/host/emails/[id]/unschedule/route.js`, `.test.js`, `src/lib/openapi.js` |
| B | 5 Send wrapper + sweeper due-launch | `src/app/api/host/emails/[id]/send/route.js`, `src/app/api/cron/send-host-campaigns/route.js`, `.test.js` |
| B | 6 Read routes carry the new columns + report line | `src/app/api/host/emails/route.js`, `src/app/api/host/emails/[id]/recipients/route.js`, `src/components/host/HostEmailReport.jsx` |
| B | 7 Portal UI | `src/components/host/HostEmails.jsx`, `src/components/host/HostEmails.test.jsx` |
| C | 8 Spec note, changelog, mirror, build, PR | `docs/CHANGELOG.md`, `docs/superpowers/specs/2026-09-07-host-scheduled-send-design.md` |

Wave B tasks depend on Wave A being committed (Task 4 imports `LAUNCH_MESSAGES` from Task 2 and `validateScheduledFor` from Task 3; Task 5 imports Task 2; Task 7 imports Task 3). Wave B tasks are file-disjoint with each other; only Task 4 touches `openapi.js`.

---

### Task 1: Migration 592

**Files:** Create `supabase/migrations/592_host_campaign_schedule.sql`

- [ ] **Step 1: Write the migration**

```sql
-- HOST-SCHEDULE.1 — scheduled send for host campaigns.
--
-- WHY. A host writes on their own time and wants the send to land at a
-- chosen hour. The sweeper cron (/api/cron/send-host-campaigns, every 2
-- min) already exists, so scheduling is one more status plus a fire time.
--
-- status flow:  draft -> scheduled -> sending -> sent
--                 ^         |
--                 +---------+  (host cancels, or a fire-time gate refuses:
--                               schedule_error carries the reason)
--
-- scheduled_for is UTC; the portal converts to/from Europe/Dublin.
-- schedule_error is set ONLY by the sweeper when a gate refused at fire
-- time and is cleared by the next successful schedule. Vocabulary (fixed
-- in code, src/lib/host-schedule-time.js): sender_not_verified | no_stream
-- | daily_cap | no_recipients | launch_failed.

alter table host_campaigns drop constraint if exists host_campaigns_status_check;
alter table host_campaigns add constraint host_campaigns_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed'));

alter table host_campaigns
  add column if not exists scheduled_for  timestamptz,
  add column if not exists schedule_error text;

comment on column host_campaigns.scheduled_for  is 'HOST-SCHEDULE.1: UTC instant the sweeper launches this campaign; kept after firing so the report can show it.';
comment on column host_campaigns.schedule_error is 'HOST-SCHEDULE.1: why the last scheduled fire went back to draft (sender_not_verified | no_stream | daily_cap | no_recipients | launch_failed); null once rescheduled.';

-- The sweeper's due pick: status = scheduled and scheduled_for <= now().
create index if not exists idx_host_campaigns_due
  on host_campaigns (scheduled_for) where status = 'scheduled';
```

- [ ] **Step 2: Check the existing constraint name before relying on it**

Run (via the Supabase MCP `execute_sql`, project `iyvtbjjxdggiadzwwvdj`):
```sql
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'host_campaigns'::regclass and contype = 'c';
```
Expected: one row named `host_campaigns_status_check` listing `draft, sending, sent, failed`. If the name differs, change BOTH the `drop constraint` line and the `add constraint` line to that name, then note the real name in the migration comment.

- [ ] **Step 3: Apply via MCP and run advisors**

`apply_migration` with name `592_host_campaign_schedule` and the file body; then `get_advisors` (security + performance). Expected: no new findings mentioning `host_campaigns`.

- [ ] **Step 4: Commit** (controller)

```bash
git add supabase/migrations/592_host_campaign_schedule.sql
git commit -m "HOST-SCHEDULE.1 — mig 592: scheduled status, scheduled_for, schedule_error on host_campaigns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `launchHostCampaign` (extracted from the send route, no behaviour change)

**Files:**
- Create `src/lib/host-campaign-launch.js`
- Create `src/lib/host-campaign-launch.test.js`
- Read only: `src/app/api/host/emails/[id]/send/route.js` (the source of every gate; do NOT edit it in this task, Task 5 rewires it)

Contract:

```
launchHostCampaign(db, { campaignId, hostId, trigger })
  trigger: 'send_now' (CAS draft -> sending) | 'schedule' (CAS scheduled -> sending)
  -> { ok: true, recipientCount }
  -> { ok: false, reason, status, error }
     reason: not_found(404) | sender_not_verified(409) | no_stream(409) | daily_cap(409)
           | no_recipients(409) | cas_lost(409) | db_error(500) | resolve_failed(500) | enqueue_failed(500)
     error:  the user-facing message the send route returns today (LAUNCH_MESSAGES) or the db message
```

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/host-campaign-launch.test.js
// HOST-SCHEDULE.1 — launchHostCampaign is the ONE launch path for a host
// campaign: the send route (trigger 'send_now') and the sweeper cron
// (trigger 'schedule') both call it. Gates, in order: own campaign → sender
// verified → stream for marketing → daily cap → recipients → CAS to
// 'sending' → chunked enqueue → QStash kick. The trigger changes ONLY the
// CAS's from-status. Refusals come back as { ok:false, reason, status,
// error } so the route can answer with the same statuses it always has and
// the sweeper can write the reason onto the row.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-campaign-email', () => ({ resolveHostRecipients: vi.fn() }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-kick' }),
  HOST_CAMPAIGNS_WORKER_PATH: '/api/webhooks/qstash/host-campaigns',
}))

import { launchHostCampaign, LAUNCH_MESSAGES } from './host-campaign-launch.js'
import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

const HOST_ROW = {
  id: HOST_ID,
  sender_domain_verified: true,
  sender_email: 'news@runners.ie',
  sender_name: 'Dublin Runners CC',
  email_daily_send_cap: 2,
  postmark_stream_id: 'colm-events',
}

// ── chainable fake (same shape as send/route.test.js) ─────────────────
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}

const op = (state, method) => state.ops.find((o) => o.method === method)
const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

function routeFor(cfg = {}) {
  return (state) => {
    const first = state.ops[0]
    if (state.table === 'host_campaigns') {
      if (first.method === 'select' && first.args[1]?.head) return { count: cfg.sentToday ?? 0, error: cfg.capErr ?? null }
      if (first.method === 'select') return { data: cfg.campaign === undefined ? { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing', audience_kind: 'all', audience_event_id: null } : cfg.campaign, error: null }
      if (first.method === 'update') return { data: cfg.casRows ?? [{ id: CAMPAIGN_ID }], error: cfg.casErr ?? null }
    }
    if (state.table === 'event_hosts') return { data: cfg.host === undefined ? HOST_ROW : cfg.host, error: null }
    if (state.table === 'host_campaign_sends') return { error: cfg.enqueueErr ?? null }
    return {}
  }
}

const launch = (db, trigger = 'send_now') => launchHostCampaign(db, { campaignId: CAMPAIGN_ID, hostId: HOST_ID, trigger })

beforeEach(() => {
  vi.clearAllMocks()
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-kick' })
  resolveHostRecipients.mockResolvedValue([
    { contact_id: 'c1', email: 'a@x.ie' },
    { contact_id: 'c2', email: 'b@x.ie' },
  ])
})

describe('launchHostCampaign — happy path', () => {
  it("send_now: CAS draft→sending, enqueues, kicks once, returns the recipient count", async () => {
    const { db, statements } = makeDb(routeFor())
    const r = await launch(db, 'send_now')
    expect(r).toEqual({ ok: true, recipientCount: 2 })

    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(cas, 'update').args[0]).toEqual({ status: 'sending', recipient_count: 2 })
    expect(hasEq(cas, 'status', 'draft')).toBe(true)

    const enqueue = statements.find((s) => s.table === 'host_campaign_sends')
    expect(op(enqueue, 'upsert').args[0]).toEqual([
      { campaign_id: CAMPAIGN_ID, contact_id: 'c1', email: 'a@x.ie', status: 'pending' },
      { campaign_id: CAMPAIGN_ID, contact_id: 'c2', email: 'b@x.ie', status: 'pending' },
    ])
    expect(op(enqueue, 'upsert').args[1]).toEqual({ onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })

    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: CAMPAIGN_ID },
      deduplicationId: `host-campaign-${CAMPAIGN_ID}-kick`,
    })
  })

  it("schedule: the CAS is from 'scheduled', everything else is identical", async () => {
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'scheduled', email_type: 'marketing', audience_kind: 'all', audience_event_id: null } }))
    const r = await launch(db, 'schedule')
    expect(r.ok).toBe(true)
    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(hasEq(cas, 'status', 'scheduled')).toBe(true)
    expect(hasEq(cas, 'status', 'draft')).toBe(false)
    expect(publishQueuePush).toHaveBeenCalledTimes(1)
  })

  it('the kick is published only AFTER the last enqueue chunk', async () => {
    const order = []
    const { db } = makeDb((state) => {
      if (state.table === 'host_campaign_sends') { order.push('upsert'); return { error: null } }
      return routeFor()(state)
    })
    publishQueuePush.mockImplementation(async () => { order.push('publish'); return { ok: true } })
    await launch(db)
    expect(order).toEqual(['upsert', 'publish'])
  })

  it('a publish rejection never fails the launch', async () => {
    publishQueuePush.mockRejectedValue(new Error('qstash exploded'))
    const { db } = makeDb(routeFor())
    expect((await launch(db)).ok).toBe(true)
  })

  it('scopes the campaign read to the host (tenancy) and resolves recipients with the campaign audience', async () => {
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility', audience_kind: 'event', audience_event_id: 'ev1' } }))
    await launch(db)
    const read = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(read, 'host_id', HOST_ID)).toBe(true)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, { audienceEventId: 'ev1', mailingListOnly: false, emailType: 'utility' })
  })
})

describe('launchHostCampaign — refusals (nothing enqueued, nothing published)', () => {
  const refusal = async (cfg, trigger) => {
    const { db, statements } = makeDb(routeFor(cfg))
    const r = await launch(db, trigger)
    expect(r.ok).toBe(false)
    expect(statements.some((s) => s.table === 'host_campaign_sends')).toBe(false)
    expect(publishQueuePush).not.toHaveBeenCalled()
    return r
  }

  it('not_found 404 when the campaign is not this host\'s', async () => {
    const r = await refusal({ campaign: null })
    expect(r).toMatchObject({ reason: 'not_found', status: 404, error: LAUNCH_MESSAGES.not_found })
  })

  it('sender_not_verified 409 (kill switch)', async () => {
    const r = await refusal({ host: { ...HOST_ROW, sender_domain_verified: false } })
    expect(r).toMatchObject({ reason: 'sender_not_verified', status: 409, error: LAUNCH_MESSAGES.sender_not_verified })
  })

  it('sender_not_verified when verified but the sender email is missing (provisioning inconsistency)', async () => {
    const r = await refusal({ host: { ...HOST_ROW, sender_email: null } })
    expect(r.reason).toBe('sender_not_verified')
  })

  it('no_stream 409 for a marketing campaign without a host stream; utility passes', async () => {
    const r = await refusal({ host: { ...HOST_ROW, postmark_stream_id: null } })
    expect(r).toMatchObject({ reason: 'no_stream', status: 409 })
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility', audience_kind: 'all' } }))
    expect((await launch(db)).ok).toBe(true)
  })

  it('daily_cap 409 once today\'s sending/sent count reaches the cap', async () => {
    const r = await refusal({ sentToday: 2 })
    expect(r).toMatchObject({ reason: 'daily_cap', status: 409, error: LAUNCH_MESSAGES.daily_cap })
  })

  it('db_error 500 when the cap count fails', async () => {
    const r = await refusal({ capErr: { message: 'boom' } })
    expect(r).toMatchObject({ reason: 'db_error', status: 500, error: 'boom' })
  })

  it('no_recipients 409 when nobody is emailable', async () => {
    resolveHostRecipients.mockResolvedValue([])
    const r = await refusal({})
    expect(r).toMatchObject({ reason: 'no_recipients', status: 409, error: LAUNCH_MESSAGES.no_recipients })
  })

  it('resolve_failed 500 when the resolver throws', async () => {
    resolveHostRecipients.mockRejectedValue(new Error('resolver down'))
    const r = await refusal({})
    expect(r).toMatchObject({ reason: 'resolve_failed', status: 500, error: 'resolver down' })
  })

  it('cas_lost 409 when the CAS matches no row (double send / already fired)', async () => {
    const r = await refusal({ casRows: [] })
    expect(r).toMatchObject({ reason: 'cas_lost', status: 409, error: LAUNCH_MESSAGES.cas_lost })
  })

  it('enqueue_failed 500 after the CAS: no kick (the cron drains what landed)', async () => {
    const { db } = makeDb(routeFor({ enqueueErr: { message: 'insert failed' } }))
    const r = await launch(db)
    expect(r).toMatchObject({ ok: false, reason: 'enqueue_failed', status: 500, error: 'Queueing failed: insert failed' })
    expect(publishQueuePush).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/host-campaign-launch.test.js`
Expected: FAIL, cannot resolve `./host-campaign-launch.js`.

- [ ] **Step 3: Write the lib**

```js
// src/lib/host-campaign-launch.js
// HOST-SCHEDULE.1 — the ONE launch path for a host campaign.
//
// Extracted verbatim from POST /api/host/emails/[id]/send (HOST-EMAIL.3 /
// QSTASH.8 / HOST-CONSENT.1) so that Send now and the scheduled fire share
// every gate. Gates, in order:
//
//   1. own campaign (.eq('host_id') is the tenancy boundary) → not_found
//   2. sender_domain_verified + sender_email (the UN1T kill switch) → sender_not_verified
//   2b. postmark_stream_id for a marketing send → no_stream
//   3. daily cap — campaigns sending/sent today (UTC) vs email_daily_send_cap → daily_cap
//   4. recipients resolved NOW (consent + per-host suppression) → no_recipients
//   5. CAS <from> → sending, stamping recipient_count → cas_lost (0 rows)
//      <from> is 'draft' for trigger 'send_now', 'scheduled' for 'schedule'.
//      This CAS is the double-send lock for both callers: two clicks, or two
//      overlapping sweeper ticks, and exactly one wins.
//
// Then the fan-out is ENQUEUED (chunked upsert into host_campaign_sends,
// ignoreDuplicates on UNIQUE(campaign_id, contact_id) keeps a retry
// idempotent) and the QStash worker is kicked ONCE, AFTER the last chunk
// (a kick before the rows exist looks "drained" and mis-finalises). A
// partial enqueue returns enqueue_failed and publishes nothing — the
// campaign is already 'sending' and the sweeper cron drains what landed.
//
// Returns { ok:true, recipientCount } or { ok:false, reason, status, error }
// where `status` is the HTTP status the send route has always answered
// with and `error` its user-facing message.

import { resolveHostRecipients } from '@/lib/host-campaign-email'
import { publishQueuePush, HOST_CAMPAIGNS_WORKER_PATH } from '@/lib/qstash'

const ENQUEUE_CHUNK = 500 // rows per host_campaign_sends insert statement

/** User-facing refusal copy — moved from the send route unchanged. */
export const LAUNCH_MESSAGES = Object.freeze({
  not_found: 'Not found',
  sender_not_verified: 'Sending is not enabled — ask UN1T to verify your sending domain.',
  no_stream: 'Marketing sending is not set up for this host yet — ask UN1T to attach your Postmark stream.',
  daily_cap: 'Daily send limit reached.',
  no_recipients: 'No emailable contacts.',
  cas_lost: 'This email has already been sent.',
})

const REFUSAL_STATUS = Object.freeze({
  not_found: 404,
  sender_not_verified: 409,
  no_stream: 409,
  daily_cap: 409,
  no_recipients: 409,
  cas_lost: 409,
})

function refuse(reason, error) {
  return { ok: false, reason, status: REFUSAL_STATUS[reason] ?? 500, error: error ?? LAUNCH_MESSAGES[reason] }
}

/**
 * @param {object} db  service-role client
 * @param {{ campaignId: string, hostId: string, trigger: 'send_now'|'schedule' }} args
 */
export async function launchHostCampaign(db, { campaignId, hostId, trigger }) {
  const fromStatus = trigger === 'schedule' ? 'scheduled' : 'draft'

  const { data: campaign } = await db
    .from('host_campaigns')
    .select('id, status, audience_kind, audience_event_id, email_type')
    .eq('id', campaignId)
    .eq('host_id', hostId)
    .maybeSingle()
  if (!campaign) return refuse('not_found')

  // Sender identity — HOST_PORTAL_COLS deliberately excludes the sender
  // columns, so load them here. Missing sender_email with verified=true is a
  // provisioning inconsistency; treat it as not-enabled rather than sending
  // from a broken From header.
  const { data: host } = await db
    .from('event_hosts')
    .select('id, sender_domain_verified, sender_email, sender_name, email_daily_send_cap, postmark_stream_id')
    .eq('id', hostId)
    .maybeSingle()
  if (!host) return refuse('not_found')
  if (!host.sender_domain_verified || !host.sender_email) return refuse('sender_not_verified')

  // HOST-CONSENT.1 — marketing needs the host's own Postmark stream.
  if (campaign.email_type !== 'utility' && !host.postmark_stream_id) return refuse('no_stream')

  // Daily cap: campaigns this host has put into flight today (UTC midnight —
  // matches the cap's plain reading, no BST wobble on the boundary).
  const now = new Date()
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const { count: sentToday, error: capErr } = await db
    .from('host_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('host_id', hostId)
    .in('status', ['sending', 'sent'])
    .gte('created_at', utcMidnight)
  if (capErr) return refuse('db_error', capErr.message)
  const cap = host.email_daily_send_cap ?? 2
  if ((sentToday || 0) >= cap) return refuse('daily_cap')

  // Recipients resolve at launch time — consent + per-host suppression + dedupe.
  // HOST-GROWTH.11 — audience_kind picks the population. Legacy-row guard:
  // an event id on a non-mailing_list row always means a per-event audience
  // (pre-mig-460 writers left audience_kind at its 'all' default).
  let recipients
  try {
    const audienceEventId = campaign.audience_kind !== 'mailing_list' ? campaign.audience_event_id || null : null
    recipients = await resolveHostRecipients(db, hostId, {
      audienceEventId,
      mailingListOnly: campaign.audience_kind === 'mailing_list',
      emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing',
    })
  } catch (e) {
    return refuse('resolve_failed', e?.message || String(e))
  }
  if (recipients.length === 0) return refuse('no_recipients')

  // CAS <from>→sending — the double-launch guard. 0 rows = someone else won.
  const { data: claimed, error: casErr } = await db
    .from('host_campaigns')
    .update({ status: 'sending', recipient_count: recipients.length })
    .eq('id', campaign.id)
    .eq('status', fromStatus)
    .select('id')
  if (casErr) return refuse('db_error', casErr.message)
  if (!claimed || claimed.length === 0) return refuse('cas_lost')

  const rows = recipients.map((r) => ({
    campaign_id: campaign.id,
    contact_id: r.contact_id,
    email: r.email,
    status: 'pending',
  }))
  for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
    const chunk = rows.slice(i, i + ENQUEUE_CHUNK)
    const { error } = await db
      .from('host_campaign_sends')
      .upsert(chunk, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
    if (error) return refuse('enqueue_failed', `Queueing failed: ${error.message}`)
  }

  // QSTASH.8 — one campaign-level kick, after every chunk landed. Dedup id
  // is DASH-ONLY (QStash 400s on colons). Fire-and-forget.
  try {
    await publishQueuePush({
      path: HOST_CAMPAIGNS_WORKER_PATH,
      body: { campaignId: campaign.id },
      deduplicationId: `host-campaign-${campaign.id}-kick`,
    })
  } catch {
    // publishQueuePush swallows its own errors; belt-and-braces only.
  }

  return { ok: true, recipientCount: recipients.length }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/host-campaign-launch.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/host-campaign-launch.js src/lib/host-campaign-launch.test.js
git commit -m "HOST-SCHEDULE.1 — launchHostCampaign: the send route's gates as one lib, trigger picks the CAS from-status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Dublin schedule-time helpers and refusal copy

**Files:**
- Create `src/lib/host-schedule-time.js` (browser-safe: Intl only, no server imports)
- Create `src/lib/host-schedule-time.test.js`

Why a new file rather than `dublin-time.js`: that file is server-oriented and its wall-clock parts helper is not exported; the composer needs the same conversion in the browser, and both the schedule route and the composer need the validation window and the reason copy. One small module keeps them together.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/host-schedule-time.test.js
// HOST-SCHEDULE.1 — Dublin wall-clock <-> UTC for the schedule panel, the
// "next quarter hour" default, the validation window the schedule route
// enforces, and the plain-language copy for a fire-time refusal.
// Everything here runs in the browser too, so it is Intl-only.

import { describe, it, expect } from 'vitest'
import {
  dublinLocalToIso, isoToDublinInputs, nextQuarterHour, dublinScheduleLabel,
  validateScheduledFor, scheduleErrorCopy, SCHEDULE_ERROR_COPY, TIME_OPTIONS,
  MIN_LEAD_MS, MAX_LEAD_MS,
} from './host-schedule-time.js'

describe('dublinLocalToIso', () => {
  it('converts an IST (summer) wall clock to UTC', () => {
    expect(dublinLocalToIso('2026-09-09', '09:00')).toBe('2026-09-09T08:00:00.000Z')
  })
  it('converts a GMT (winter) wall clock to UTC', () => {
    expect(dublinLocalToIso('2026-01-15', '09:00')).toBe('2026-01-15T09:00:00.000Z')
  })
  it('rejects malformed inputs with null', () => {
    expect(dublinLocalToIso('', '09:00')).toBe(null)
    expect(dublinLocalToIso('2026-09-09', '9am')).toBe(null)
    expect(dublinLocalToIso('2026-13-40', '09:00')).toBe(null)
  })
})

describe('isoToDublinInputs', () => {
  it('round-trips a UTC instant back to Dublin date + time', () => {
    expect(isoToDublinInputs('2026-09-09T08:00:00.000Z')).toEqual({ date: '2026-09-09', time: '09:00' })
    expect(isoToDublinInputs('2026-01-15T09:00:00.000Z')).toEqual({ date: '2026-01-15', time: '09:00' })
  })
  it('returns null for garbage', () => {
    expect(isoToDublinInputs('nope')).toBe(null)
  })
})

describe('nextQuarterHour', () => {
  it('is the first quarter hour at least 15 minutes out, in Dublin time', () => {
    // 10:03Z + 15 min = 10:18Z -> 10:30Z -> 11:30 Dublin (IST)
    expect(nextQuarterHour(Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
  it('lands exactly on a quarter when the lead already does', () => {
    // 10:15Z + 15 = 10:30Z exactly
    expect(nextQuarterHour(Date.parse('2026-09-07T10:15:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
  it('rolls over the Dublin day', () => {
    // 23:50Z 7 Sep = 00:50 Dublin 8 Sep; +15 -> 01:05 -> 01:15 Dublin
    expect(nextQuarterHour(Date.parse('2026-09-07T23:50:00Z'))).toEqual({ date: '2026-09-08', time: '01:15' })
  })
})

describe('dublinScheduleLabel', () => {
  it('reads "Wed 9 Sep, 09:00" for a summer instant', () => {
    expect(dublinScheduleLabel('2026-09-09T08:00:00.000Z')).toBe('Wed 9 Sep, 09:00')
  })
  it('reads a winter instant without the DST shift', () => {
    expect(dublinScheduleLabel('2026-01-15T09:00:00.000Z')).toBe('Thu 15 Jan, 09:00')
  })
  it('is empty for null or garbage, never "Invalid Date"', () => {
    expect(dublinScheduleLabel(null)).toBe('')
    expect(dublinScheduleLabel('nope')).toBe('')
  })
})

describe('validateScheduledFor', () => {
  const now = Date.parse('2026-09-07T10:00:00Z')
  it('accepts a time inside the window and normalises it to ISO', () => {
    expect(validateScheduledFor('2026-09-07T11:20:00+01:00', now)).toEqual({ ok: true, iso: '2026-09-07T10:20:00.000Z' })
  })
  it('rejects a non-date', () => {
    expect(validateScheduledFor('tomorrow', now)).toEqual({ ok: false, error: 'Pick a date and time.' })
    expect(validateScheduledFor(undefined, now).ok).toBe(false)
  })
  it('rejects anything under 15 minutes ahead, including the past', () => {
    expect(validateScheduledFor('2026-09-07T10:10:00Z', now)).toEqual({ ok: false, error: 'Pick a time at least 15 minutes from now.' })
    expect(validateScheduledFor('2026-09-07T09:00:00Z', now).ok).toBe(false)
  })
  it('accepts exactly 15 minutes ahead and rejects anything past 90 days', () => {
    expect(validateScheduledFor(new Date(now + MIN_LEAD_MS).toISOString(), now).ok).toBe(true)
    expect(validateScheduledFor(new Date(now + MAX_LEAD_MS + 60_000).toISOString(), now)).toEqual({ ok: false, error: 'Pick a time within the next 90 days.' })
  })
})

describe('scheduleErrorCopy', () => {
  it('has plain copy for every reason the sweeper can write, with no em-dashes', () => {
    for (const code of ['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients', 'launch_failed']) {
      expect(SCHEDULE_ERROR_COPY[code]).toBeTruthy()
      expect(SCHEDULE_ERROR_COPY[code]).not.toContain('—')
    }
  })
  it('falls back to the generic line for an unknown code', () => {
    expect(scheduleErrorCopy('something_new')).toBe(SCHEDULE_ERROR_COPY.launch_failed)
  })
})

describe('TIME_OPTIONS', () => {
  it('is every quarter hour of the day, zero-padded', () => {
    expect(TIME_OPTIONS).toHaveLength(96)
    expect(TIME_OPTIONS[0]).toBe('00:00')
    expect(TIME_OPTIONS[1]).toBe('00:15')
    expect(TIME_OPTIONS[95]).toBe('23:45')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/host-schedule-time.test.js`
Expected: FAIL, cannot resolve `./host-schedule-time.js`.

- [ ] **Step 3: Write the module**

```js
// src/lib/host-schedule-time.js
// HOST-SCHEDULE.1 — Dublin wall-clock helpers for scheduled host sends.
//
// Shared by the composer (browser) and the schedule route (server), so this
// file is Intl-only: no supabase, no server imports. `scheduled_for` is
// stored in UTC; the host only ever sees and picks Europe/Dublin times.
// Hard-codes the zone like src/lib/dublin-time.js does (UN1T is Dublin-only).

const DUBLIN_TZ = 'Europe/Dublin'
const MINUTE_MS = 60_000
const QUARTER_MS = 15 * MINUTE_MS

/** A scheduled time must be at least this far ahead (the sweeper runs every 2 min). */
export const MIN_LEAD_MS = 15 * MINUTE_MS
/** ...and at most this far ahead. */
export const MAX_LEAD_MS = 90 * 24 * 60 * MINUTE_MS

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hour12: false,
})
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: DUBLIN_TZ, weekday: 'short' })

/** Europe/Dublin wall-clock parts for a UTC ms instant. */
function dublinParts(ms) {
  const p = {}
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value
  // 'en-GB' can emit hour '24' at midnight; normalise to 0.
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: hour, mi: Number(p.minute) }
}

function toMs(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * UTC instant -> the { date: 'YYYY-MM-DD', time: 'HH:MM' } pair the
 * schedule panel's inputs hold, in Dublin time. Null for garbage.
 * @param {string|number} isoOrMs
 */
export function isoToDublinInputs(isoOrMs) {
  const ms = toMs(isoOrMs)
  if (ms == null) return null
  const p = dublinParts(ms)
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` }
}

/**
 * Dublin wall clock ('YYYY-MM-DD', 'HH:MM') -> UTC ISO string. Robust
 * across DST: take the naive UTC instant for the wall clock, read back what
 * Dublin wall clock that instant actually is, and correct by the observed
 * offset. One pass is exact for Dublin's whole-hour offsets. Null when
 * either input is malformed or the date does not exist.
 * @param {string} date
 * @param {string} time
 */
export function dublinLocalToIso(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '')
  const t = /^(\d{2}):(\d{2})$/.exec(time || '')
  if (!m || !t) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const h = Number(t[1]); const mi = Number(t[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  // Date.UTC silently rolls an impossible day (Feb 30) forward; reject that.
  const g = new Date(guess)
  if (g.getUTCMonth() !== mo - 1 || g.getUTCDate() !== d) return null
  const p = dublinParts(guess)
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0)
  return new Date(guess - (wall - guess)).toISOString()
}

/**
 * The panel's default: the first quarter hour at least MIN_LEAD_MS ahead of
 * `nowMs`, as Dublin inputs. Dublin's offset is a whole hour, so UTC quarter
 * boundaries are Dublin quarter boundaries.
 * @param {number} [nowMs=Date.now()]
 */
export function nextQuarterHour(nowMs = Date.now()) {
  const target = Math.ceil((nowMs + MIN_LEAD_MS) / QUARTER_MS) * QUARTER_MS
  return isoToDublinInputs(target)
}

/**
 * 'Wed 9 Sep, 09:00' in Dublin time. Built from parts (not a locale
 * pattern) so it reads the same on every ICU build. '' for null/garbage.
 * @param {string|number|null|undefined} isoOrMs
 */
export function dublinScheduleLabel(isoOrMs) {
  if (isoOrMs == null || isoOrMs === '') return ''
  const ms = toMs(isoOrMs)
  if (ms == null) return ''
  const p = dublinParts(ms)
  return `${weekdayFmt.format(new Date(ms))} ${p.d} ${MONTHS[p.mo - 1]}, ${pad(p.h)}:${pad(p.mi)}`
}

/**
 * The schedule route's window check. Returns { ok:true, iso } (normalised
 * to a UTC ISO string) or { ok:false, error } with host-facing copy.
 * @param {string|undefined} value  what the client posted
 * @param {number} [nowMs=Date.now()]
 */
export function validateScheduledFor(value, nowMs = Date.now()) {
  const ms = typeof value === 'string' && value ? toMs(value) : null
  if (ms == null) return { ok: false, error: 'Pick a date and time.' }
  if (ms < nowMs + MIN_LEAD_MS) return { ok: false, error: 'Pick a time at least 15 minutes from now.' }
  if (ms > nowMs + MAX_LEAD_MS) return { ok: false, error: 'Pick a time within the next 90 days.' }
  return { ok: true, iso: new Date(ms).toISOString() }
}

/** Every quarter hour of the day for the time select. */
export const TIME_OPTIONS = Object.freeze(
  Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`),
)

/**
 * Plain-language copy for host_campaigns.schedule_error — what the sweeper
 * writes when a fire-time gate refuses. Operator tone, no em-dashes.
 */
export const SCHEDULE_ERROR_COPY = Object.freeze({
  sender_not_verified: 'Sending is not enabled yet',
  no_stream: 'Marketing sending is not set up yet',
  daily_cap: 'Daily send limit was reached',
  no_recipients: 'Nobody on the list could be emailed',
  launch_failed: 'Could not start the send',
})

/** @param {string|null|undefined} code */
export function scheduleErrorCopy(code) {
  return SCHEDULE_ERROR_COPY[code] || SCHEDULE_ERROR_COPY.launch_failed
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/host-schedule-time.test.js`
Expected: PASS, 17 tests. If the weekday test fails with a different abbreviation on this machine's ICU, switch `weekdayFmt` to a hand-rolled `['Sun','Mon',...][new Date(ms + offsetMs).getUTCDay()]` using `offsetMs = wall - guess` from `dublinParts`, and keep the assertions.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/host-schedule-time.js src/lib/host-schedule-time.test.js
git commit -m "HOST-SCHEDULE.1 — Dublin schedule-time helpers, validation window, refusal copy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Schedule and unschedule routes + OpenAPI

**Files:**
- Create `src/app/api/host/emails/[id]/schedule/route.js` and `route.test.js`
- Create `src/app/api/host/emails/[id]/unschedule/route.js` and `route.test.js`
- Modify `src/lib/openapi.js`: two new `registry.registerPath` blocks directly AFTER the `/api/host/emails/{id}/send-test` block (search for `path: '/api/host/emails/{id}/send-test'`, then its closing `})`), and two fields added to the recipients-response campaign object (search for `sent_count: z.number().int().nullable(),` inside `HostCampaignRecipientsResponse`).

`check:route-guards` recognises `getCurrentHost` as a session guard; both routes call it first, so no allowlist entry is needed.

- [ ] **Step 1: Write the failing schedule-route tests**

```js
// src/app/api/host/emails/[id]/schedule/route.test.js
// HOST-SCHEDULE.1 — POST /api/host/emails/[id]/schedule { scheduled_for }.
// Host session; the campaign must be the session host's (404, no
// enumeration). The window (≥15 min, ≤90 days) is validateScheduledFor's.
// Early feedback gates (sender verified, stream for marketing) run here;
// the cap and recipients do NOT (they change by fire time). CAS from
// draft OR scheduled → scheduled (reschedule is the same call), clearing
// schedule_error; a sending/sent campaign 409s.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'
const HOST_ROW = { id: HOST_ID, sender_domain_verified: true, sender_email: 'news@runners.ie', postmark_stream_id: 'colm-events' }
const IN_30_MIN = () => new Date(Date.now() + 30 * 60_000).toISOString()

function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}
const op = (state, method) => state.ops.find((o) => o.method === method)
const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

function routeFor(cfg = {}) {
  return (state) => {
    const first = state.ops[0]
    if (state.table === 'host_campaigns') {
      if (first.method === 'select') return { data: cfg.campaign === undefined ? { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing' } : cfg.campaign, error: null }
      if (first.method === 'update') return { data: cfg.casRows ?? [{ id: CAMPAIGN_ID, status: 'scheduled', scheduled_for: cfg.echo ?? null, schedule_error: null }], error: cfg.updateErr ?? null }
    }
    if (state.table === 'event_hosts') return { data: cfg.host === undefined ? HOST_ROW : cfg.host, error: null }
    return {}
  }
}

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }
function req(body) {
  return new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('POST /api/host/emails/[id]/schedule', () => {
  it('401s without a host session and touches no table', async () => {
    getCurrentHost.mockResolvedValue(null)
    const { db, statements } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(401)
    expect(statements).toHaveLength(0)
  })

  it('400s on invalid JSON, a missing field, a non-date, too soon, too far', async () => {
    const { db } = makeDb(routeFor())
    createServerClient.mockReturnValue(db)
    expect((await POST(req('{nope'), props)).status).toBe(400)
    expect((await POST(req({}), props)).status).toBe(400)
    expect((await POST(req({ scheduled_for: 'tomorrow' }), props)).status).toBe(400)
    const soon = await POST(req({ scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString() }), props)
    expect(soon.status).toBe(400)
    expect((await soon.json()).error).toBe('Pick a time at least 15 minutes from now.')
    const far = await POST(req({ scheduled_for: new Date(Date.now() + 91 * 24 * 3600_000).toISOString() }), props)
    expect(far.status).toBe(400)
    expect((await far.json()).error).toBe('Pick a time within the next 90 days.')
  })

  it("404s another host's campaign (tenancy via .eq('host_id'))", async () => {
    const { db, statements } = makeDb(routeFor({ campaign: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(404)
    const read = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(read, 'host_id', HOST_ID)).toBe(true)
  })

  it('409s a campaign that is sending or sent, before any gate or write', async () => {
    const { db, statements } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'sent', email_type: 'marketing' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(409)
    expect(statements.some((s) => op(s, 'update'))).toBe(false)
  })

  it('409s when the sender is unverified (early feedback for the kill switch)', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, sender_domain_verified: false } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not enabled/)
  })

  it('409s a marketing campaign with no host stream; utility passes', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null } }))
    createServerClient.mockReturnValue(db)
    expect((await POST(req({ scheduled_for: IN_30_MIN() }), props)).status).toBe(409)
    const u = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility' } }))
    createServerClient.mockReturnValue(u.db)
    expect((await POST(req({ scheduled_for: IN_30_MIN() }), props)).status).toBe(200)
  })

  it('CAS from draft or scheduled → scheduled, stamps the normalised time, clears schedule_error, returns the row', async () => {
    const when = IN_30_MIN()
    const { db, statements } = makeDb(routeFor({ echo: when }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: when }), props)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.data.status).toBe('scheduled')

    const cas = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(cas, 'update').args[0]).toEqual({ status: 'scheduled', scheduled_for: when, schedule_error: null })
    expect(hasEq(cas, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(cas, 'host_id', HOST_ID)).toBe(true)
    const inOp = op(cas, 'in')
    expect(inOp.args[0]).toBe('status')
    expect(inOp.args[1]).toEqual(['draft', 'scheduled'])
  })

  it('409s when the CAS matches no row (it fired or was sent meanwhile)', async () => {
    const { db } = makeDb(routeFor({ casRows: [] }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(409)
  })

  it('500s with the db message when the update fails', async () => {
    const { db } = makeDb(routeFor({ updateErr: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req({ scheduled_for: IN_30_MIN() }), props)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('kaboom')
  })
})
```

- [ ] **Step 2: Write the failing unschedule-route tests**

```js
// src/app/api/host/emails/[id]/unschedule/route.test.js
// HOST-SCHEDULE.1 — POST /api/host/emails/[id]/unschedule: CAS scheduled →
// draft, scheduled_for cleared. Host session + .eq('host_id'). 409 when the
// campaign is no longer scheduled (it fired, or was never scheduled).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { POST } from './route.js'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

const HOST_ID = 'b0000000-0000-0000-0000-0000000000b1'
const CAMPAIGN_ID = 'a0000000-0000-0000-0000-0000000000a1'

function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? {})
            return p.then.bind(p)
          }
          return (...args) => { state.ops.push({ method, args }); return b }
        },
      })
      return b
    },
  }
  return { db, statements }
}
const op = (state, method) => state.ops.find((o) => o.method === method)
const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

const props = { params: Promise.resolve({ id: CAMPAIGN_ID }) }
const req = () => new Request(`http://localhost/api/host/emails/${CAMPAIGN_ID}/unschedule`, { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentHost.mockResolvedValue({ host: { id: HOST_ID } })
})

describe('POST /api/host/emails/[id]/unschedule', () => {
  it('401s without a host session', async () => {
    getCurrentHost.mockResolvedValue(null)
    expect((await POST(req(), props)).status).toBe(401)
  })

  it('CAS scheduled → draft with scheduled_for cleared, scoped to the host', async () => {
    const { db, statements } = makeDb(() => ({ data: [{ id: CAMPAIGN_ID, status: 'draft', scheduled_for: null }], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('draft')
    const cas = statements[0]
    expect(cas.table).toBe('host_campaigns')
    expect(op(cas, 'update').args[0]).toEqual({ status: 'draft', scheduled_for: null })
    expect(hasEq(cas, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(cas, 'host_id', HOST_ID)).toBe(true)
    expect(hasEq(cas, 'status', 'scheduled')).toBe(true)
  })

  it('409s when nothing matched (already fired, not scheduled, or not this host\'s)', async () => {
    const { db } = makeDb(() => ({ data: [], error: null }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This email is no longer scheduled.')
  })

  it('500s with the db message on a failed update', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'kaboom' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(req(), props)
    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run 'src/app/api/host/emails/[id]/schedule' 'src/app/api/host/emails/[id]/unschedule'`
Expected: FAIL, cannot resolve `./route.js` in both.

- [ ] **Step 4: Write the schedule route**

```js
// src/app/api/host/emails/[id]/schedule/route.js
// POST /api/host/emails/[id]/schedule — HOST-SCHEDULE.1.
//
// Body { scheduled_for: ISO }. Marks a draft (or an already scheduled
// campaign: reschedule is the same call) as 'scheduled' for that UTC
// instant; the sweeper cron (/api/cron/send-host-campaigns) launches it
// through launchHostCampaign when it comes due. Gates:
//
//   1. getCurrentHost() + own campaign (.eq('host_id')) → 404 (no enumeration).
//   2. window — validateScheduledFor: ≥15 min ahead, ≤90 days → 400.
//   3. status must be draft|scheduled → 409 (a sending/sent campaign cannot
//      be scheduled; the same message the send route uses).
//   4. Early feedback ONLY: sender verified, stream for marketing → 409 with
//      the send route's wording. The daily cap and the recipient list are
//      NOT checked here — both can change before fire time and are
//      re-evaluated by the launch; a refusal then lands in schedule_error.
//   5. CAS status in (draft, scheduled) → scheduled, clearing schedule_error.
//
// PATCH /api/host/emails/[id] stays CAS'd on 'draft', so a scheduled body
// cannot be edited under a pending fire (the composer unschedules first).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { validateScheduledFor } from '@/lib/host-schedule-time'
import { LAUNCH_MESSAGES } from '@/lib/host-campaign-launch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ scheduled_for: z.string().min(1) })

const CAMPAIGN_COLUMNS = 'id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error'

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = Body.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Pick a date and time.' }, { status: 400 })
  const when = validateScheduledFor(parsed.data.scheduled_for)
  if (!when.ok) return NextResponse.json({ success: false, error: when.error }, { status: 400 })

  const db = createServerClient()

  const { data: campaign } = await db
    .from('host_campaigns')
    .select('id, status, email_type')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (!campaign) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.cas_lost }, { status: 409 })
  }

  const { data: host } = await db
    .from('event_hosts')
    .select('id, sender_domain_verified, sender_email, postmark_stream_id')
    .eq('id', session.host.id)
    .maybeSingle()
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!host.sender_domain_verified || !host.sender_email) {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.sender_not_verified }, { status: 409 })
  }
  if (campaign.email_type !== 'utility' && !host.postmark_stream_id) {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.no_stream }, { status: 409 })
  }

  // CAS on draft|scheduled — a fire or a send that landed between the read
  // and this write matches 0 rows → 409, never a silent overwrite.
  const { data: rows, error } = await db
    .from('host_campaigns')
    .update({ status: 'scheduled', scheduled_for: when.iso, schedule_error: null })
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .in('status', ['draft', 'scheduled'])
    .select(CAMPAIGN_COLUMNS)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: LAUNCH_MESSAGES.cas_lost }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: rows[0] })
}
```

- [ ] **Step 5: Write the unschedule route**

```js
// src/app/api/host/emails/[id]/unschedule/route.js
// POST /api/host/emails/[id]/unschedule — HOST-SCHEDULE.1.
//
// CAS scheduled → draft with scheduled_for cleared. schedule_error is left
// alone (it is only ever set by a refused fire, and this path is the host
// cancelling). 0 rows = it already fired (or was never scheduled, or is
// not this host's) → 409; the composer reloads and shows the real state.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CAMPAIGN_COLUMNS = 'id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: rows, error } = await db
    .from('host_campaigns')
    .update({ status: 'draft', scheduled_for: null })
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .eq('status', 'scheduled')
    .select(CAMPAIGN_COLUMNS)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: 'This email is no longer scheduled.' }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: rows[0] })
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run 'src/app/api/host/emails/[id]/schedule' 'src/app/api/host/emails/[id]/unschedule'`
Expected: PASS, 9 + 4 tests.

- [ ] **Step 7: Register in OpenAPI**

In `src/lib/openapi.js`, inside the `HostCampaignRecipientsResponse` campaign object, directly after the line `sent_count: z.number().int().nullable(),` add:

```js
              scheduled_for: z.string().nullable().optional(),
              schedule_error: z.string().nullable().optional(),
```

Then, directly after the closing `})` of the `path: '/api/host/emails/{id}/send-test'` registration, add:

```js
const HostScheduleBody = z.object({
  scheduled_for: z.string().describe('ISO instant (UTC or offset). Must be at least 15 minutes ahead and within 90 days.'),
}).openapi('HostScheduleBody')

registry.registerPath({
  method: 'post',
  path: '/api/host/emails/{id}/schedule',
  tags: ['Host Portal'],
  security: [{ CookieAuth: [] }],
  summary: 'Schedule (or reschedule) a host campaign for a later send (HOST-SCHEDULE.1)',
  description: "Host session; the campaign must belong to the session host (404 otherwise, so ids stay un-enumerable). Marks a draft or an already scheduled campaign as `scheduled` for the given UTC instant (the portal converts from Europe/Dublin); the send-host-campaigns sweeper cron launches it within about two minutes of that time through the SAME launch function as Send now, re-running every gate then. Early feedback only here: sender domain verified, and a Postmark stream for a marketing campaign. The daily cap and the recipient list are NOT checked at schedule time; a fire-time refusal returns the campaign to draft with `schedule_error` set. Clears any earlier `schedule_error`. A sending/sent campaign 409s.",
  request: { params: z.object({ id: uuidLike }), body: { content: { 'application/json': { schema: HostScheduleBody } } } },
  responses: {
    200: { description: 'The scheduled campaign row', content: { 'application/json': { schema: SuccessResponse(z.object({ id: uuidLike, status: z.string(), scheduled_for: z.string().nullable(), schedule_error: z.string().nullable() }).passthrough()) } } },
    400: { description: 'Malformed body, or the time is under 15 minutes ahead or over 90 days ahead', content: { 'application/json': { schema: ErrorResponse } } },
    401: { description: 'Unauthorized — no host session', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Not found, or not this host\'s campaign', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Already sent or sending; sender domain unverified; no stream for a marketing campaign', content: { 'application/json': { schema: ErrorResponse } } },
  },
})

registry.registerPath({
  method: 'post',
  path: '/api/host/emails/{id}/unschedule',
  tags: ['Host Portal'],
  security: [{ CookieAuth: [] }],
  summary: 'Cancel a scheduled host campaign back to draft (HOST-SCHEDULE.1)',
  description: 'Host session. Compare-and-set scheduled → draft with `scheduled_for` cleared. 409 when the campaign is no longer scheduled (it already fired, or was never scheduled).',
  request: { params: z.object({ id: uuidLike }) },
  responses: {
    200: { description: 'The campaign row, now a draft', content: { 'application/json': { schema: SuccessResponse(z.object({ id: uuidLike, status: z.string(), scheduled_for: z.string().nullable() }).passthrough()) } } },
    401: { description: 'Unauthorized — no host session', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'No longer scheduled', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

Run: `npx vitest run src/lib/openapi` (whatever openapi test exists; if none, `node -e "import('./src/lib/openapi.js')"` is not viable under the `@/` alias, so run `npm run lint -- src/lib/openapi.js` instead).
Expected: no errors.

- [ ] **Step 8: Commit** (controller)

```bash
git add 'src/app/api/host/emails/[id]/schedule' 'src/app/api/host/emails/[id]/unschedule' src/lib/openapi.js
git commit -m "HOST-SCHEDULE.1 — schedule + unschedule routes (CAS on draft|scheduled), OpenAPI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Send route becomes a wrapper; sweeper launches due campaigns

**Files:**
- Modify `src/app/api/host/emails/[id]/send/route.js` (whole file)
- Modify `src/app/api/cron/send-host-campaigns/route.js`
- Modify `src/app/api/cron/send-host-campaigns/route.test.js`
- Do NOT edit `src/app/api/host/emails/[id]/send/route.test.js`: its mocks of `@/lib/host-campaign-email` and `@/lib/qstash` apply module-wide, so every existing test keeps passing against the wrapper. That is the regression proof for the extraction.

- [ ] **Step 1: Rewrite the send route**

Replace the whole file with:

```js
// POST /api/host/emails/[id]/send — queue a draft campaign for sending
// (HOST-EMAIL.3). Since HOST-SCHEDULE.1 this is a thin wrapper over
// launchHostCampaign (src/lib/host-campaign-launch.js), which owns every
// gate, the draft→sending CAS, the chunked enqueue and the QStash kick, so
// Send now and a scheduled fire can never drift apart. The refusal reasons
// map 1:1 onto the statuses this route has always answered with:
//   not_found 404 · sender_not_verified / no_stream / daily_cap /
//   no_recipients / cas_lost 409 · db_error / resolve_failed /
//   enqueue_failed 500.

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { launchHostCampaign } from '@/lib/host-campaign-launch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const result = await launchHostCampaign(db, { campaignId: params.id, hostId: session.host.id, trigger: 'send_now' })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: result.status })
  return NextResponse.json({ success: true, data: { recipient_count: result.recipientCount } })
}
```

- [ ] **Step 2: Run the existing send-route tests unchanged**

Run: `npx vitest run 'src/app/api/host/emails/[id]/send'`
Expected: PASS, every existing test (QStash kick, audience_kind, stream gate). If any fails, the lib diverged from the route: fix the LIB, not the test.

- [ ] **Step 3: Write the failing sweeper tests**

In `src/app/api/cron/send-host-campaigns/route.test.js`:

(a) Add the launch mock and extend the log mock. Replace
```js
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
```
with
```js
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/host-campaign-launch', () => ({ launchHostCampaign: vi.fn() }))
```
and after `import { processHostCampaignChunk } from '@/lib/host-campaign-queue'` add
```js
import { launchHostCampaign } from '@/lib/host-campaign-launch'
```

(b) Replace `routeFor` with one that tells the due pick, the back-to-draft update and the sending pick apart:
```js
function routeFor(cfg = {}) {
  return (state) => {
    if (state.table === 'host_campaigns') {
      if (hasEq(state, 'status', 'scheduled') && op(state, 'select')) return { data: cfg.due ?? [], error: cfg.dueErr ?? null }
      if (op(state, 'update')) return { data: cfg.backRows ?? [{ id: 'x' }], error: cfg.backErr ?? null }
      return { data: cfg.campaigns ?? [], error: cfg.pickErr ?? null }
    }
    if (state.table === 'host_campaign_sends') return { data: cfg.swept ?? [], error: null } // stale sweep
    return {}
  }
}
```
(`op` and `hasEq` are already defined above `routeFor`.)

(c) In `beforeEach`, after the `processHostCampaignChunk.mockResolvedValue(...)` line add:
```js
  launchHostCampaign.mockResolvedValue({ ok: true, recipientCount: 5 })
```

(d) Append a new describe block at the end of the file:
```js
// HOST-SCHEDULE.1 — due scheduled campaigns are launched at the top of the
// tick (before the 'sending' pass, so a just-launched campaign gets its
// first chunk in the same tick) through the SAME launchHostCampaign the
// send route uses. A refusal CAS-returns the row to draft with the reason;
// cas_lost (another sweep won) is silent; nothing here ever blocks the
// sending pass or the heartbeat.
describe('GET /api/cron/send-host-campaigns — scheduled launches', () => {
  const DUE_1 = { id: 'd0000000-0000-0000-0000-0000000000d1', host_id: 'h1' }
  const DUE_2 = { id: 'd0000000-0000-0000-0000-0000000000d2', host_id: 'h2' }

  it('picks due scheduled rows (scheduled_for <= now, ordered, ≤10) and launches each with trigger schedule, before the sending pass', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1, DUE_2], campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    const order = []
    launchHostCampaign.mockImplementation(async () => { order.push('launch'); return { ok: true, recipientCount: 5 } })
    processHostCampaignChunk.mockImplementation(async () => { order.push('chunk'); return { status: 'drained', sent: 1, failed: 0 } })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.launched).toBe(2)
    expect(body.refused).toEqual([])

    const pick = statements.find((s) => s.table === 'host_campaigns' && hasEq(s, 'status', 'scheduled'))
    expect(op(pick, 'lte').args[0]).toBe('scheduled_for')
    expect(op(pick, 'order').args[0]).toBe('scheduled_for')
    expect(op(pick, 'limit').args[0]).toBe(10)

    expect(launchHostCampaign).toHaveBeenNthCalledWith(1, db, { campaignId: DUE_1.id, hostId: 'h1', trigger: 'schedule' })
    expect(launchHostCampaign).toHaveBeenNthCalledWith(2, db, { campaignId: DUE_2.id, hostId: 'h2', trigger: 'schedule' })
    expect(order).toEqual(['launch', 'launch', 'chunk'])
    expect(stampHeartbeat).toHaveBeenCalledWith('send-host-campaigns')
  })

  it('a refused launch goes back to draft with the reason (CAS on scheduled) and the tick carries on', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1], campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockResolvedValue({ ok: false, reason: 'daily_cap', status: 409, error: 'Daily send limit reached.' })

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.launched).toBe(0)
    expect(body.refused).toEqual([{ campaign_id: DUE_1.id, reason: 'daily_cap' }])

    const back = statements.find((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(op(back, 'update').args[0]).toEqual({ status: 'draft', scheduled_for: null, schedule_error: 'daily_cap' })
    expect(hasEq(back, 'id', DUE_1.id)).toBe(true)
    expect(hasEq(back, 'status', 'scheduled')).toBe(true)
    expect(processHostCampaignChunk).toHaveBeenCalledWith(db, CAMPAIGN_A.id)
  })

  it('maps every non-gate reason to launch_failed and stays silent on cas_lost', async () => {
    const { db, statements } = makeDb(routeFor({ due: [DUE_1, DUE_2] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign
      .mockResolvedValueOnce({ ok: false, reason: 'db_error', status: 500, error: 'boom' })
      .mockResolvedValueOnce({ ok: false, reason: 'cas_lost', status: 409, error: 'This email has already been sent.' })

    const body = await (await GET(req())).json()
    expect(body.refused).toEqual([{ campaign_id: DUE_1.id, reason: 'launch_failed' }])
    const backs = statements.filter((s) => s.table === 'host_campaigns' && op(s, 'update'))
    expect(backs).toHaveLength(1)
    expect(hasEq(backs[0], 'id', DUE_1.id)).toBe(true)
  })

  it('a thrown launch is a launch_failed, never a 500 tick', async () => {
    const { db } = makeDb(routeFor({ due: [DUE_1] }))
    createServerClient.mockReturnValue(db)
    launchHostCampaign.mockRejectedValue(new Error('exploded'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).refused).toEqual([{ campaign_id: DUE_1.id, reason: 'launch_failed' }])
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a failed due pick is logged into errors and the sending pass still runs', async () => {
    const { db } = makeDb(routeFor({ dueErr: { message: 'pick broke' }, campaigns: [CAMPAIGN_A] }))
    createServerClient.mockReturnValue(db)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.errors).toEqual([{ stage: 'due_pick', error: 'pick broke' }])
    expect(launchHostCampaign).not.toHaveBeenCalled()
    expect(processHostCampaignChunk).toHaveBeenCalledWith(db, CAMPAIGN_A.id)
  })
})
```

- [ ] **Step 4: Run to verify the new tests fail**

Run: `npx vitest run src/app/api/cron/send-host-campaigns`
Expected: the five new tests FAIL (`launched` undefined / no due pick); the pre-existing tests still PASS.

- [ ] **Step 5: Add the due-launch step to the sweeper**

In `src/app/api/cron/send-host-campaigns/route.js`:

(a) Extend the header comment. After the paragraph ending `so the host can tell a crashed-consumer row apart from a gate refusal.` add:
```js
//
// HOST-SCHEDULE.1 — the cron ALSO fires scheduled campaigns: at the top of
// every tick it picks ≤10 rows with status='scheduled' and scheduled_for
// <= now() (idx_host_campaigns_due, mig 592) and calls launchHostCampaign
// with trigger 'schedule' — the SAME gates and enqueue as Send now; the
// CAS scheduled→sending inside it is the lock, so two overlapping ticks
// launch once. Runs BEFORE the 'sending' pass so a just-launched campaign
// gets its first chunk in this tick (the QStash kick also fires). A
// refusal CAS-returns the row scheduled→draft with schedule_error set to
// the reason (gate reasons verbatim; anything else 'launch_failed'); that
// CAS is a no-op when the launch had already flipped the row to sending
// (post-CAS enqueue failure — the cron drains what landed, exactly as
// Send now). cas_lost means another sweep won: silent.
```

(b) Imports: change `import { logError } from '@/lib/log'` to `import { logError, logInfo } from '@/lib/log'` and add `import { launchHostCampaign } from '@/lib/host-campaign-launch'`.

(c) Constants: after `const CLAIM_STALE_MS = ...` add
```js
const MAX_DUE_PER_TICK = 10
// schedule_error vocabulary (mig 592) — gate reasons pass through, the rest collapse.
const SCHEDULE_GATE_REASONS = new Set(['sender_not_verified', 'no_stream', 'daily_cap', 'no_recipients'])
```

(d) In `GET`, change the summary line to
```js
  const summary = { launched: 0, refused: [], campaigns: 0, sent: 0, failed: 0, finalised: 0, errors: [] }
```
and insert, directly before `const { data: campaigns, error: pickErr } = await db`:
```js
  await launchDueCampaigns(db, summary)

```

(e) Add the function at the end of the file:
```js
// HOST-SCHEDULE.1 — fire due scheduled campaigns (see header). Never
// throws: every failure lands in summary.refused / summary.errors and the
// sending pass + heartbeat still run.
async function launchDueCampaigns(db, summary) {
  const { data: due, error: dueErr } = await db
    .from('host_campaigns')
    .select('id, host_id')
    .eq('status', 'scheduled')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(MAX_DUE_PER_TICK)
  if (dueErr) {
    logError('host-campaigns', 'due pick failed', { error: dueErr.message })
    summary.errors.push({ stage: 'due_pick', error: dueErr.message })
    return
  }

  for (const c of due || []) {
    let result
    try {
      result = await launchHostCampaign(db, { campaignId: c.id, hostId: c.host_id, trigger: 'schedule' })
    } catch (err) {
      result = { ok: false, reason: 'launch_failed', error: err?.message || String(err) }
    }
    if (result.ok) {
      summary.launched += 1
      logInfo('host-campaigns', 'scheduled campaign launched', { campaign_id: c.id, recipient_count: result.recipientCount })
      continue
    }
    if (result.reason === 'cas_lost') continue // another sweep won the CAS

    const code = SCHEDULE_GATE_REASONS.has(result.reason) ? result.reason : 'launch_failed'
    const { error: backErr } = await db
      .from('host_campaigns')
      .update({ status: 'draft', scheduled_for: null, schedule_error: code })
      .eq('id', c.id)
      .eq('status', 'scheduled')
    if (backErr) {
      summary.errors.push({ campaign_id: c.id, error: backErr.message })
      logError('host-campaigns', 'scheduled refusal write failed', { campaign_id: c.id, error: backErr.message })
    }
    summary.refused.push({ campaign_id: c.id, reason: code })
    logError('host-campaigns', 'scheduled launch refused', { campaign_id: c.id, reason: code, error: result.error })
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/app/api/cron/send-host-campaigns 'src/app/api/host/emails/[id]/send'`
Expected: PASS, all.

- [ ] **Step 7: Commit** (controller)

```bash
git add 'src/app/api/host/emails/[id]/send/route.js' src/app/api/cron/send-host-campaigns/route.js src/app/api/cron/send-host-campaigns/route.test.js
git commit -m "HOST-SCHEDULE.1 — send route wraps launchHostCampaign; sweeper fires due scheduled campaigns, refusals back to draft with a reason

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Read routes carry the new columns; report shows the scheduled time

**Files:**
- Modify `src/app/api/host/emails/route.js` (two select strings)
- Modify `src/app/api/host/emails/[id]/recipients/route.js` (one select string)
- Modify `src/components/host/HostEmailReport.jsx` (header line)

- [ ] **Step 1: List + create route**

In `src/app/api/host/emails/route.js` there are two identical select strings (the GET list and the POST create's returning select):
```js
.select('id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at')
```
Change BOTH to:
```js
.select('id, subject, status, audience_kind, audience_event_id, email_type, recipient_count, sent_count, created_at, sent_at, scheduled_for, schedule_error')
```

- [ ] **Step 2: Recipients route**

In `src/app/api/host/emails/[id]/recipients/route.js` change the campaign select
```js
.select('id, subject, status, email_type, audience_kind, audience_event_id, sent_at, created_at, recipient_count, sent_count')
```
to
```js
.select('id, subject, status, email_type, audience_kind, audience_event_id, sent_at, created_at, recipient_count, sent_count, scheduled_for')
```

- [ ] **Step 3: Report header**

In `src/components/host/HostEmailReport.jsx`, directly after the two lines
```jsx
          {whenStr && <span>{whenStr}</span>}
          {whenStr && <span>·</span>}
```
add
```jsx
          {campaign?.scheduled_for && formatWhen(campaign.scheduled_for) && (
            <>
              <span>Scheduled for {formatWhen(campaign.scheduled_for)}</span>
              <span>·</span>
            </>
          )}
```

- [ ] **Step 4: Run the touched suites**

Run: `npx vitest run src/app/api/host/emails src/components/host/HostEmailReport`
Expected: PASS. If a recipients-route test asserts the exact select string, update that one assertion to the new string.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/app/api/host/emails/route.js 'src/app/api/host/emails/[id]/recipients/route.js' src/components/host/HostEmailReport.jsx
git commit -m "HOST-SCHEDULE.1 — list/create/recipients return scheduled_for + schedule_error; report shows the scheduled time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Portal UI (Schedule button, inline panel, scheduled row, refusal chip)

**Files:**
- Modify `src/components/host/HostEmails.jsx`
- Modify `src/components/host/HostEmails.test.jsx`

Behaviour: a draft row gets a "Schedule" button beside "Send" that opens an inline panel under the row (date input + 15-minute time select, Dublin, defaulting to the next quarter hour ≥15 min out). A scheduled row shows a sky "Scheduled" chip, the subline "Scheduled for Wed 9 Sep, 09:00", and the actions "Change time" (same panel, prefilled), "Edit" (confirm, unschedule, then open the composer) and "Cancel" (confirm, unschedule). A draft with `schedule_error` shows an amber "Not sent" chip and a plain-language subline.

- [ ] **Step 1: Write the failing tests** (pure helpers, per the file's convention)

Append to `src/components/host/HostEmails.test.jsx`:

```js
import { rowSubline, schedulePanelDefaults } from './HostEmails.jsx'

// HOST-SCHEDULE.1 — the list row's subline is one pure decision over the
// campaign row, and the schedule panel opens either on the row's own time
// (Change time) or on the next quarter hour (a fresh schedule).
describe('rowSubline', () => {
  it('a plain draft', () => {
    expect(rowSubline({ status: 'draft' })).toBe('Not sent yet')
  })
  it('a draft the sweeper refused reads the reason in plain words', () => {
    expect(rowSubline({ status: 'draft', schedule_error: 'daily_cap' })).toBe('Not sent. Daily send limit was reached. Schedule it again or send it now.')
  })
  it('a scheduled row shows the Dublin time', () => {
    expect(rowSubline({ status: 'scheduled', scheduled_for: '2026-09-09T08:00:00.000Z' })).toBe('Scheduled for Wed 9 Sep, 09:00')
  })
  it('a sent row with stats keeps the stats line', () => {
    expect(rowSubline({ status: 'sent', stats: { sent: 124, delivered: 118, opened: 41, clicked: 9 } })).toBe('124 sent · 118 delivered · 41 opened · 9 clicked')
  })
  it('a sent row without stats falls back to the coarse count', () => {
    expect(rowSubline({ status: 'sent', sent_count: 120, recipient_count: 124 })).toBe('120/124 sent')
  })
})

describe('schedulePanelDefaults', () => {
  it('prefills a scheduled row with its own time', () => {
    expect(schedulePanelDefaults({ scheduled_for: '2026-09-09T08:00:00.000Z' }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-09', time: '09:00' })
  })
  it('defaults a draft to the next quarter hour at least 15 minutes out', () => {
    expect(schedulePanelDefaults({ scheduled_for: null }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/host/HostEmails.test.jsx`
Expected: FAIL, `rowSubline` / `schedulePanelDefaults` are not exported.

- [ ] **Step 3: Implement**

In `src/components/host/HostEmails.jsx`:

(a) Imports. After `import Link from 'next/link'` add:
```js
import {
  nextQuarterHour, isoToDublinInputs, dublinLocalToIso, dublinScheduleLabel, scheduleErrorCopy, TIME_OPTIONS,
} from '@/lib/host-schedule-time'
```

(b) Exported helpers. Directly after the `statsLine` function add:
```js
/**
 * The list row's one-line status, per campaign state (HOST-SCHEDULE.1):
 * a scheduled row shows its Dublin fire time; a draft the sweeper refused
 * shows the reason in plain words; anything sent keeps the stats line.
 * @param {object} c  campaign row from GET /api/host/emails
 */
export function rowSubline(c) {
  if (c.status === 'scheduled') return `Scheduled for ${dublinScheduleLabel(c.scheduled_for)}`
  if (c.status === 'draft') {
    return c.schedule_error
      ? `Not sent. ${scheduleErrorCopy(c.schedule_error)}. Schedule it again or send it now.`
      : 'Not sent yet'
  }
  return statsLine(c.stats) || `${c.sent_count || 0}/${c.recipient_count ?? '—'} sent`
}

/**
 * What the schedule panel opens on: the row's own time when rescheduling,
 * else the next quarter hour at least 15 minutes out.
 * @param {object} c
 * @param {number} [nowMs=Date.now()]
 */
export function schedulePanelDefaults(c, nowMs = Date.now()) {
  return (c?.scheduled_for && isoToDublinInputs(c.scheduled_for)) || nextQuarterHour(nowMs)
}
```

(c) Chip maps. Add `scheduled` to both:
```js
const STATUS_CHIP = {
  draft: 'bg-white/10 text-white/70',
  scheduled: 'bg-sky-500/15 text-sky-300',
  sending: 'bg-amber-500/15 text-amber-300',
  sent: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

const STATUS_LABEL = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
}
```

(d) State. After `const [loadingDraftId, setLoadingDraftId] = useState(null)` add:
```js
  const [schedulingId, setSchedulingId] = useState(null) // row whose schedule panel is open
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduleBusy, setScheduleBusy] = useState(false)
```

(e) Actions. Directly after the `send(...)` function add:
```js
  // HOST-SCHEDULE.1 — schedule panel + scheduled-row actions.
  function openSchedule(c) {
    setError('')
    setNotice('')
    const d = schedulePanelDefaults(c)
    setScheduleDate(d.date)
    setScheduleTime(d.time)
    setSchedulingId(c.id)
  }

  async function confirmSchedule(id) {
    const iso = dublinLocalToIso(scheduleDate, scheduleTime)
    if (!iso) { setError('Pick a date and time.'); return }
    setError('')
    setNotice('')
    setScheduleBusy(true)
    try {
      const res = await fetch(`/api/host/emails/${id}/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: iso }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not schedule the email.')
        return
      }
      setSchedulingId(null)
      setNotice(`Scheduled for ${dublinScheduleLabel(json.data?.scheduled_for || iso)}.`)
      await load()
    } catch {
      setError('Could not schedule the email.')
    } finally {
      setScheduleBusy(false)
    }
  }

  // Returns true when the row is a draft again (so callers can chain).
  async function unschedule(id) {
    setError('')
    setNotice('')
    try {
      const res = await fetch(`/api/host/emails/${id}/unschedule`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Could not cancel the schedule.')
        await load() // a 409 means it already fired: show the real state
        return false
      }
      await load()
      return true
    } catch {
      setError('Could not cancel the schedule.')
      return false
    }
  }

  async function cancelSchedule(id) {
    if (!window.confirm('Cancel this scheduled send? The email goes back to your drafts.')) return
    if (await unschedule(id)) setNotice('Schedule cancelled.')
  }

  async function editScheduled(id) {
    if (!window.confirm('Editing cancels the scheduled send. You can schedule it again after saving.')) return
    if (await unschedule(id)) await editDraft(id)
  }
```

(f) The row. Replace the whole `<li key={c.id} ...>...</li>` block inside `campaigns.map` with:
```jsx
                <li key={c.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {c.status === 'draft' || c.status === 'scheduled' ? (
                          <span className="truncate">{c.subject}</span>
                        ) : (
                          <Link href={`/host/emails/${c.id}`} className="truncate hover:underline">{c.subject}</Link>
                        )}
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
                          {STATUS_LABEL[c.status] || c.status}
                        </span>
                        {c.status === 'draft' && c.schedule_error && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-300">
                            Not sent
                          </span>
                        )}
                        {c.email_type === 'utility' && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-sky-500/15 text-sky-300">
                            Utility
                          </span>
                        )}
                        {c.stats?.failed > 0 && (
                          <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-300">
                            {c.stats.failed} failed
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-white/45 mt-0.5">
                        {rowSubline(c)}
                        {c.status !== 'scheduled' && (
                          <>
                            {' · '}
                            {(c.sent_at || c.created_at || '').slice(0, 10) || '—'}
                          </>
                        )}
                      </p>
                    </div>
                    {c.status === 'draft' && (
                      <div className="shrink-0 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => editDraft(c.id)}
                          disabled={loadingDraftId === c.id}
                          className="rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 hover:text-white hover:border-white/40 disabled:opacity-50"
                        >
                          {loadingDraftId === c.id ? 'Opening…' : 'Edit'}
                        </button>
                        <button
                          type="button"
                          onClick={() => sendTest(c.id)}
                          disabled={testingId === c.id}
                          className="rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 hover:text-white hover:border-white/40 disabled:opacity-50"
                        >
                          {testingId === c.id ? 'Sending…' : 'Test'}
                        </button>
                        <button
                          type="button"
                          onClick={() => (schedulingId === c.id ? setSchedulingId(null) : openSchedule(c))}
                          className="rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 hover:text-white hover:border-white/40"
                        >
                          Schedule
                        </button>
                        <button
                          type="button"
                          onClick={() => send(c.id, c.audience_kind === 'mailing_list' ? '__mailing_list__' : (c.audience_event_id || ''), c.email_type)}
                          disabled={sendingId === c.id}
                          className="rounded-lg bg-white text-black text-xs font-semibold px-3 py-1.5 hover:bg-white/90 disabled:opacity-50"
                        >
                          {sendingId === c.id ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    )}
                    {c.status === 'scheduled' && (
                      <div className="shrink-0 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => (schedulingId === c.id ? setSchedulingId(null) : openSchedule(c))}
                          className="rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 hover:text-white hover:border-white/40"
                        >
                          Change time
                        </button>
                        <button
                          type="button"
                          onClick={() => editScheduled(c.id)}
                          disabled={loadingDraftId === c.id}
                          className="rounded-lg border border-white/20 text-white/80 text-xs font-semibold px-3 py-1.5 hover:text-white hover:border-white/40 disabled:opacity-50"
                        >
                          {loadingDraftId === c.id ? 'Opening…' : 'Edit'}
                        </button>
                        <button
                          type="button"
                          onClick={() => cancelSchedule(c.id)}
                          className="rounded-lg border border-red-400/40 text-red-300 text-xs font-semibold px-3 py-1.5 hover:border-red-300"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  {schedulingId === c.id && (
                    <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 flex flex-wrap items-end gap-3">
                      <label className="block text-xs text-white/60">
                        Date
                        <input
                          type="date"
                          value={scheduleDate}
                          onChange={(e) => setScheduleDate(e.target.value)}
                          className={`${input} mt-1 w-auto`}
                        />
                      </label>
                      <label className="block text-xs text-white/60">
                        Time (Dublin)
                        <select
                          value={scheduleTime}
                          onChange={(e) => setScheduleTime(e.target.value)}
                          className={`${input} mt-1 w-auto`}
                        >
                          {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => confirmSchedule(c.id)}
                        disabled={scheduleBusy}
                        className="rounded-lg bg-white text-black text-xs font-semibold px-3 py-2 hover:bg-white/90 disabled:opacity-50"
                      >
                        {scheduleBusy ? 'Saving…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSchedulingId(null)}
                        className="text-xs text-white/60 hover:text-white px-2 py-2"
                      >
                        Close
                      </button>
                      <p className="basis-full text-[11px] text-white/40 mt-1">
                        Sends within two minutes of this time. Every check (sender, list, daily limit) runs again then.
                      </p>
                    </div>
                  )}
                </li>
```

Note the `<li>` no longer carries `flex items-center justify-between gap-4`; that moved to the inner `<div>` so the panel can sit under the row. `input` is the existing class-string const declared just above the JSX.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run src/components/host/HostEmails.test.jsx && npx eslint src/components/host/HostEmails.jsx`
Expected: PASS, 7 new tests; no lint errors.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/components/host/HostEmails.jsx src/components/host/HostEmails.test.jsx
git commit -m "HOST-SCHEDULE.1 — composer: Schedule button, Dublin date/time panel, scheduled-row actions, refusal chip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Spec note, changelog, CI mirror, build, PR

**Files:**
- Modify `docs/superpowers/specs/2026-09-07-host-scheduled-send-design.md` (section 6)
- Modify `docs/CHANGELOG.md` (one row under the table header)

- [ ] **Step 1: Spec §6 correction**

Replace the sentence
```
A `launch_failed` (a thrown enqueue) leaves the campaign as `draft` with the reason; the host can schedule again.
```
with
```
A refusal before the CAS (a thrown resolver, a db error) leaves the campaign as `draft` with `schedule_error = launch_failed`; the host can schedule again. A failure after the CAS (an enqueue error) has already flipped the row to `sending`, and the cron drains whatever landed, exactly as Send now does today; the sweeper's back-to-draft write is itself a CAS on `scheduled`, so it is a no-op there.
```

- [ ] **Step 2: Changelog row**

Directly under `| #/PR | Item | Notes |` + `|---|------|-------|` in `docs/CHANGELOG.md` add (the PR number is filled in after `gh pr create`; use `#TBD` until then, then amend the commit):
```
| #<PR> | HOST-SCHEDULE.1 — scheduled send for host emails | mig 592 (applied): `scheduled` status, `scheduled_for`, `schedule_error`, partial index for the due pick. The send route's gates moved verbatim into `launchHostCampaign()` (`trigger` picks the CAS from-status); the sweeper cron fires ≤10 due campaigns per tick through it and CAS-returns a refusal to draft with the reason. `POST /api/host/emails/[id]/schedule` (≥15 min, ≤90 days, early sender/stream feedback only) + `/unschedule`. Composer: Schedule beside Send, Dublin date + 15-min time panel, scheduled-row Change time / Edit (cancels first) / Cancel, amber "Not sent" chip with plain copy. Host portal only. Spec `docs/superpowers/specs/2026-09-07-host-scheduled-send-design.md`. |
```

- [ ] **Step 3: CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: all green. `check:route-guards` must list nothing new (both new routes call `getCurrentHost` first). `check:location-scoping` may flag the new routes: if so, add them to its EXEMPT list with the reason `host portal: tenancy is host_id via getCurrentHost, not location_id` mirroring the entries for `/api/host/emails/[id]/send`.

- [ ] **Step 4: Build**

```bash
npm run build
```
Expected: succeeds; the two new routes appear in the route table.

- [ ] **Step 5: Commit docs, push, PR**

```bash
git add docs/CHANGELOG.md docs/superpowers/specs/2026-09-07-host-scheduled-send-design.md
git commit -m "HOST-SCHEDULE.1 — changelog + spec note on post-CAS failures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin host-scheduled-send
gh pr create --title "HOST-SCHEDULE.1 — scheduled send for host emails (portal only)" --body-file - <<'EOF'
## What
A host can schedule an email for a Dublin date and time instead of sending now. The sweeper cron fires it within two minutes through the same gates as Send now; a refusal at fire time returns it to draft with a visible reason.

## How
- mig 592 (applied): `scheduled` status, `scheduled_for`, `schedule_error`, partial index for the due pick.
- `launchHostCampaign()` extracted verbatim from the send route; `trigger` picks the CAS from-status (draft or scheduled). The send route is a thin wrapper and its existing tests pass unchanged.
- Sweeper: ≤10 due campaigns per tick, launched before the sending pass; refusal → CAS scheduled→draft with the reason; cas_lost silent.
- Routes: `POST /api/host/emails/[id]/schedule` (≥15 min, ≤90 days; early sender/stream feedback) and `/unschedule`.
- Composer: Schedule beside Send, Dublin date + 15-min time panel, scheduled-row actions, amber "Not sent" chip.

## Verification
- CI mirror green; `npm run build` green.
- Live after merge: schedule a test campaign 15 minutes out on the host portal, watch the sweeper log `scheduled campaign launched`, confirm the report page fills.

Spec: `docs/superpowers/specs/2026-09-07-host-scheduled-send-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```
Then replace `#<PR>` in the changelog row with the real number and `git commit --amend --no-edit` + `git push --force-with-lease`.
