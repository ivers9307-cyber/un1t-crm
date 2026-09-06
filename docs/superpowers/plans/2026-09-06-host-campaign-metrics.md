# Host Campaign Metrics (HOST-METRICS.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host can open any sent email and see sent / delivered / opened / clicked / bounced / unsubscribed / failed counts plus a per-recipient outcome table with failure reasons; the three historical sends are backfilled from Postmark.

**Architecture:** Mig 590 adds outcome columns to `host_campaign_sends` (queue `status` untouched) and two SQL functions (`host_campaign_stats`, `bump_host_send_counter`). The queue writes the Postmark message id and a failure reason. `processHostCampaignEvent` resolves the send row by `(campaign_id, contact_id)` from metadata and applies guarded writes. A pure `host-campaign-outcome.js` derives the displayed outcome by precedence. New read routes feed a report page. A `postmark-messages.js` client plus `host-campaign-backfill.js` fold Postmark's message event timelines into the rows, exposed as an admin route with a button on the host settings card.

**Tech Stack:** Next.js 16 App Router, Supabase (service role; migrations via MCP), Postmark REST, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-09-06-host-campaign-metrics-design.md`.

**Repo rules:** every `.select()` capped at 1,000 rows → `.range()`-paginate; supabase builders are thenables (no `.catch`); destructure `error` on every write; `[id]` paths need quotes in zsh; branch `host-metrics` in worktree `~/code/un1t-crm-hostconsent`; commit per task; never `git add -A`. Parallel waves: implementers in the same wave touch disjoint files, never stage or commit — the controller commits.

CI mirror before pushing:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

---

## File map and waves

| Wave | Task | Files |
|---|---|---|
| A | 1 Migration 590 | `supabase/migrations/590_host_campaign_metrics.sql` |
| A | 2 `emailabilityReason` | `src/lib/host-contact-list.js`, `.test.js` |
| A | 3 Outcome lib | NEW `src/lib/host-campaign-outcome.js`, `.test.js` |
| A | 5 Webhook writes | `src/lib/host-campaign-webhooks.js`, `.test.js` |
| A | 6 Postmark messages client | NEW `src/lib/postmark-messages.js`, `.test.js` |
| B | 4 Queue + sweeper reasons + message id | `src/lib/host-campaign-queue.js`, `.test.js`, `src/app/api/cron/send-host-campaigns/route.js` |
| B | 7 Backfill lib + admin route + button | NEW `src/lib/host-campaign-backfill.js`, `.test.js`, NEW `src/app/api/hosts/[id]/backfill-campaign-events/route.js`, `.test.js`, `src/components/settings/HostDetail.jsx`, `src/lib/openapi.js` |
| B | 8 Read APIs | `src/app/api/host/emails/route.js`, NEW `src/app/api/host/emails/[id]/recipients/route.js`, `.test.js`, `src/lib/openapi.js` (Task 7 and 8 both touch openapi.js: Task 8 registers ONLY the recipients route; Task 7 ONLY the admin route; controller commits Task 7 first, Task 8 rebases its one insert) |
| B | 9 Portal UI | `src/components/host/HostEmails.jsx`, NEW `src/components/host/HostEmailReport.jsx`, `.test.jsx`, NEW `src/app/host/(portal)/emails/[id]/page.js` |
| C | 10 Changelog, mirror, build, PR | `docs/CHANGELOG.md` |

---

### Task 1: Migration 590

**Files:** Create `supabase/migrations/590_host_campaign_metrics.sql`

- [ ] **Step 1: Write**
```sql
-- HOST-METRICS.1 — per-send outcomes for host campaign email.
--
-- WHY. A sent host email showed "120/124 sent" and nothing else: no Postmark
-- message id, no delivery/open/click, no reason for the 4 that failed. Host
-- sends write no email_sends row (they are not CRM sends), and until
-- HOST-CONSENT.1 their Postmark events were dropped. Outcomes now live on the
-- queue row itself. `status` stays the QUEUE state; the displayed outcome is
-- derived in code by precedence (failed > bounced > complained > unsubscribed
-- > clicked > opened > delivered > sent) so a late Delivery never regresses an
-- Open. No denormalised counters: host_campaign_stats() counts the rows.

alter table host_campaign_sends
  add column if not exists postmark_message_id text,
  add column if not exists delivered_at    timestamptz,
  add column if not exists opened_at       timestamptz,
  add column if not exists open_count      integer not null default 0,
  add column if not exists clicked_at      timestamptz,
  add column if not exists click_count     integer not null default 0,
  add column if not exists bounced_at      timestamptz,
  add column if not exists bounce_type     text,
  add column if not exists complained_at   timestamptz,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists failed_reason   text;

alter table host_campaign_sends drop constraint if exists host_campaign_sends_bounce_type_check;
alter table host_campaign_sends add constraint host_campaign_sends_bounce_type_check
  check (bounce_type is null or bounce_type in ('hard', 'soft', 'transient'));

create index if not exists idx_host_campaign_sends_message
  on host_campaign_sends (postmark_message_id) where postmark_message_id is not null;

-- Stats per campaign for one host, same precedence as the code's outcome.
create or replace function public.host_campaign_stats(p_host_id uuid)
returns table (
  campaign_id uuid, queued bigint, sent bigint, delivered bigint, opened bigint,
  clicked bigint, bounced bigint, complained bigint, unsubscribed bigint, failed bigint
)
language sql
security invoker
set search_path = public
as $$
  select
    s.campaign_id,
    count(*) filter (where s.status in ('pending','claimed'))                                   as queued,
    count(*) filter (where s.status = 'sent')                                                    as sent,
    count(*) filter (where s.status = 'sent' and s.delivered_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as delivered,
    count(*) filter (where s.status = 'sent' and s.opened_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as opened,
    count(*) filter (where s.status = 'sent' and s.clicked_at is not null
                       and s.bounced_at is null and s.complained_at is null)                    as clicked,
    count(*) filter (where s.bounced_at is not null)                                             as bounced,
    count(*) filter (where s.complained_at is not null)                                          as complained,
    count(*) filter (where s.unsubscribed_at is not null)                                        as unsubscribed,
    count(*) filter (where s.status = 'failed')                                                  as failed
  from host_campaign_sends s
  join host_campaigns c on c.id = s.campaign_id
  where c.host_id = p_host_id
  group by s.campaign_id
$$;
revoke all on function public.host_campaign_stats(uuid) from public, anon, authenticated;
grant execute on function public.host_campaign_stats(uuid) to service_role;

-- Atomic counter bump for open_count / click_count (mirrors mig 157's
-- increment_campaign_metric: allowlisted field, format(%I)).
create or replace function public.bump_host_send_counter(p_send_id uuid, p_field text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_field not in ('open_count', 'click_count') then
    raise exception 'bump_host_send_counter: invalid p_field %', p_field;
  end if;
  execute format('update public.host_campaign_sends set %1$I = %1$I + 1 where id = $1', p_field) using p_send_id;
end;
$$;
revoke all on function public.bump_host_send_counter(uuid, text) from public, anon, authenticated;
grant execute on function public.bump_host_send_counter(uuid, text) to service_role;

comment on column host_campaign_sends.failed_reason is
  'HOST-METRICS.1 — no_host_consent | host_unsubscribed | mailbox_blocked | no_email | send_error | stale_claim';
```
- [ ] **Step 2: Apply** via Supabase MCP `apply_migration` (project `iyvtbjjxdggiadzwwvdj`, name `590_host_campaign_metrics`), then `get_advisors` security: expect no new ERROR/WARN (both functions are invoker + service_role only).
- [ ] **Step 3: Verify** `select * from host_campaign_stats('6db1ad24-7982-4e40-91ea-7400616e872a')` → 3 rows, `sent` 126/126/120, `failed` 0/0/4, everything else 0 (nothing backfilled yet).
- [ ] **Step 4: Commit** `git add supabase/migrations/590_host_campaign_metrics.sql && git commit -m "HOST-METRICS.1 — mig 590: per-send outcome columns, host_campaign_stats(), bump_host_send_counter()"`

---

### Task 2: `emailabilityReason` in `src/lib/host-contact-list.js`

**Files:** Modify `src/lib/host-contact-list.js` (the `isEmailable` block), `src/lib/host-contact-list.test.js`

- [ ] **Step 1: Failing tests** — add a describe:
```js
describe('emailabilityReason (HOST-METRICS.1)', () => {
  const good = { email: 'a@b.ie', email_status: 'active', email_suppressed_at: null }
  it('null when mailable', () => expect(emailabilityReason(good, false, { hostConsent: true })).toBeNull())
  it('no_email', () => expect(emailabilityReason({ ...good, email: null }, false, { hostConsent: true })).toBe('no_email'))
  it('null contact → no_email', () => expect(emailabilityReason(null, false, { hostConsent: true })).toBe('no_email'))
  it('mailbox_blocked for the repeat-bounce stamp, bounced and complained', () => {
    expect(emailabilityReason({ ...good, email_suppressed_at: '2026-08-11T05:45:14Z' }, false, { hostConsent: true })).toBe('mailbox_blocked')
    expect(emailabilityReason({ ...good, email_status: 'bounced' }, false, { hostConsent: true })).toBe('mailbox_blocked')
    expect(emailabilityReason({ ...good, email_status: 'complained' }, false, { hostConsent: true })).toBe('mailbox_blocked')
  })
  it('host_unsubscribed beats no_host_consent (a revoke sets both)', () => {
    expect(emailabilityReason(good, true, { hostConsent: false })).toBe('host_unsubscribed')
  })
  it('no_host_consent', () => expect(emailabilityReason(good, false, { hostConsent: false })).toBe('no_host_consent'))
  it('utility: no_administrative_consent, and hostConsent/suppressed ignored', () => {
    expect(emailabilityReason({ ...good, email_administrative: false }, true, { emailType: 'utility' })).toBe('no_administrative_consent')
    expect(emailabilityReason({ ...good, email_administrative: true }, true, { emailType: 'utility', hostConsent: false })).toBeNull()
  })
  it('isEmailable is exactly reason === null', () => {
    expect(isEmailable(good, false, { hostConsent: true })).toBe(true)
    expect(isEmailable(good, true, { hostConsent: true })).toBe(false)
  })
})
```
- [ ] **Step 2: Run** `npx vitest run src/lib/host-contact-list.test.js -t emailabilityReason` → FAIL (not exported).
- [ ] **Step 3: Implement** — keep the existing `isEmailable` docblock; add above it:
```js
/**
 * HOST-METRICS.1 — WHY a contact cannot be mailed, or null when they can.
 * The single predicate behind isEmailable, so the queue can stamp
 * host_campaign_sends.failed_reason with the same decision the gate makes.
 * Reasons: 'no_email' | 'mailbox_blocked' | 'no_administrative_consent'
 *        | 'host_unsubscribed' | 'no_host_consent'.
 */
export function emailabilityReason(contact, suppressed, { emailType = 'marketing', hostConsent = false } = {}) {
  if (!contact || !contact.email) return 'no_email'
  if (contact.email_suppressed_at) return 'mailbox_blocked'
  if (emailType === 'utility') {
    if (contact.email_administrative !== true) return 'no_administrative_consent'
    if (['bounced', 'complained'].includes(contact.email_status ?? 'active')) return 'mailbox_blocked'
    return null
  }
  if (suppressed) return 'host_unsubscribed'
  if (hostConsent !== true) return 'no_host_consent'
  if (BLOCKED_EMAIL_STATUSES.includes(contact.email_status ?? 'active')) return 'mailbox_blocked' // NULL = legacy 'active'
  return null
}
```
and make `isEmailable` a one-liner: `return emailabilityReason(contact, suppressed, opts) === null` (signature unchanged; note the order of checks is byte-identical to the previous body so every existing `isEmailable` test keeps its answer).
- [ ] **Step 4: Run** the whole file → PASS. `npx eslint src/lib/host-contact-list.js src/lib/host-contact-list.test.js`.
- [ ] **Step 5: Commit** `HOST-METRICS.1 — emailabilityReason: the gate's decision as a stampable reason; isEmailable wraps it`

---

### Task 3: `src/lib/host-campaign-outcome.js` (pure)

**Files:** Create `src/lib/host-campaign-outcome.js`, `src/lib/host-campaign-outcome.test.js`

- [ ] **Step 1: Failing tests**
```js
import { describe, it, expect } from 'vitest'
import { deriveOutcome, outcomeAt, OUTCOMES, FAILURE_COPY, failureCopy } from './host-campaign-outcome.js'

const base = { status: 'sent', sent_at: '2026-09-04T10:58:14Z', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null, failed_reason: null }

describe('deriveOutcome — precedence', () => {
  it('queued for pending/claimed', () => {
    expect(deriveOutcome({ ...base, status: 'pending' })).toBe('queued')
    expect(deriveOutcome({ ...base, status: 'claimed' })).toBe('queued')
  })
  it('failed beats everything', () => expect(deriveOutcome({ ...base, status: 'failed', opened_at: 'x', failed_reason: 'send_error' })).toBe('failed'))
  it('bounced > complained > unsubscribed > clicked > opened > delivered > sent', () => {
    expect(deriveOutcome({ ...base, bounced_at: 'x', complained_at: 'x', clicked_at: 'x' })).toBe('bounced')
    expect(deriveOutcome({ ...base, complained_at: 'x', unsubscribed_at: 'x', clicked_at: 'x' })).toBe('complained')
    expect(deriveOutcome({ ...base, unsubscribed_at: 'x', clicked_at: 'x' })).toBe('unsubscribed')
    expect(deriveOutcome({ ...base, clicked_at: 'x', opened_at: 'x', delivered_at: 'x' })).toBe('clicked')
    expect(deriveOutcome({ ...base, opened_at: 'x', delivered_at: 'x' })).toBe('opened')
    expect(deriveOutcome({ ...base, delivered_at: 'x' })).toBe('delivered')
    expect(deriveOutcome(base)).toBe('sent')
  })
  it('a late Delivery after an Open still reads opened', () => expect(deriveOutcome({ ...base, opened_at: '2026-09-04T11:00:00Z', delivered_at: '2026-09-04T11:05:00Z' })).toBe('opened'))
})

describe('outcomeAt — the timestamp the outcome is about', () => {
  it('returns the matching column', () => {
    expect(outcomeAt({ ...base, opened_at: 'o', delivered_at: 'd' })).toBe('o')
    expect(outcomeAt({ ...base, status: 'failed', claimed_at: 'c' })).toBe('c')
    expect(outcomeAt({ ...base, status: 'pending' })).toBeNull()
    expect(outcomeAt(base)).toBe(base.sent_at)
  })
})

describe('failure copy', () => {
  it('every stamped reason has customer-tone copy with no em-dash', () => {
    for (const r of ['no_host_consent', 'host_unsubscribed', 'mailbox_blocked', 'no_email', 'send_error', 'stale_claim', 'no_administrative_consent']) {
      expect(FAILURE_COPY[r]).toBeTruthy()
      expect(FAILURE_COPY[r]).not.toMatch(/—/)
    }
  })
  it('unknown reason falls back', () => expect(failureCopy('wat')).toBe('Could not be sent'))
  it('OUTCOMES lists the nine outcomes in display order', () => {
    expect(OUTCOMES).toEqual(['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued'])
  })
})
```
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement**
```js
// HOST-METRICS.1 — the displayed outcome of one host_campaign_sends row.
//
// `status` is the QUEUE state (pending|claimed|sent|failed). Everything Postmark
// tells us afterwards lands as timestamps, and the outcome is DERIVED here by
// precedence so a late Delivery can never regress an Open (the POSTMARK-RACE.2
// lesson on email_sends.status). host_campaign_stats() in mig 590 counts with
// the same precedence — keep the two in step.

export const OUTCOMES = Object.freeze(['failed', 'bounced', 'complained', 'unsubscribed', 'clicked', 'opened', 'delivered', 'sent', 'queued'])

export function deriveOutcome(row) {
  if (!row) return 'queued'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'pending' || row.status === 'claimed') return 'queued'
  if (row.bounced_at) return 'bounced'
  if (row.complained_at) return 'complained'
  if (row.unsubscribed_at) return 'unsubscribed'
  if (row.clicked_at) return 'clicked'
  if (row.opened_at) return 'opened'
  if (row.delivered_at) return 'delivered'
  return 'sent'
}

/** The timestamp the derived outcome refers to, or null (queued). */
export function outcomeAt(row) {
  switch (deriveOutcome(row)) {
    case 'failed': return row.claimed_at || row.sent_at || null
    case 'bounced': return row.bounced_at
    case 'complained': return row.complained_at
    case 'unsubscribed': return row.unsubscribed_at
    case 'clicked': return row.clicked_at
    case 'opened': return row.opened_at
    case 'delivered': return row.delivered_at
    case 'sent': return row.sent_at || null
    default: return null
  }
}

// Host-facing copy for failed_reason. Operator tone, no em-dashes (house rule
// for customer-facing text; hosts are customers of the platform).
export const FAILURE_COPY = Object.freeze({
  no_host_consent: 'Not consented to your list',
  host_unsubscribed: 'Unsubscribed from your list',
  mailbox_blocked: 'Mailbox rejected earlier mail',
  no_email: 'No email address',
  no_administrative_consent: 'Not opted in to event updates',
  send_error: 'Mail server rejected the send',
  stale_claim: 'Send timed out',
})

export function failureCopy(reason) {
  return FAILURE_COPY[reason] || 'Could not be sent'
}
```
- [ ] **Step 4: Run** → PASS; eslint both files.
- [ ] **Step 5: Commit** `HOST-METRICS.1 — host-campaign-outcome.js: derived outcome by precedence + failure copy`

---

### Task 4: Queue writes the message id and failure reasons (after Task 2)

**Files:** Modify `src/lib/host-campaign-queue.js`, `src/lib/host-campaign-queue.test.js`, `src/app/api/cron/send-host-campaigns/route.js`

- [ ] **Step 1: Failing tests** (queue test file; `sendEmail` mock resolves `{ messageId: 'pm-1' }` already):
```js
describe('processHostCampaignChunk — HOST-METRICS.1', () => {
  const base = { candidates: [{ id: 's1' }], claimed: [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }], contacts: [emailableContact('c1', 'a@x.ie')], hostContacts: [{ contact_id: 'c1', marketing_consent: true }] }
  it('stamps postmark_message_id on the sent row', async () => {
    const { db, statements } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const sentUpd = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'sent')
    expect(op(sentUpd, 'update').args[0]).toMatchObject({ postmark_message_id: 'pm-1' })
  })
  it('a consent-revoked row carries the gate reason', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, hostContacts: [{ contact_id: 'c1', marketing_consent: false }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(op(failed, 'update').args[0]).toEqual({ status: 'failed', failed_reason: 'no_host_consent' })
  })
  it('a suppressed row reads host_unsubscribed', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, suppressions: [{ contact_id: 'c1' }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(op(failed, 'update').args[0].failed_reason).toBe('host_unsubscribed')
  })
  it('a thrown send writes send_error', async () => {
    sendEmail.mockRejectedValueOnce(new Error('422 inactive recipient'))
    const { db, statements } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(op(failed, 'update').args[0]).toEqual({ status: 'failed', failed_reason: 'send_error' })
  })
})
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Import `emailabilityReason` alongside `isEmailable` (or replace). Revocation loop becomes per-reason: collect `revoked = [{ id, reason }]`, then group by reason and issue one update per reason group: `.update({ status: 'failed', failed_reason: reason }).in('id', ids)`. Sent update: `.update({ status: 'sent', sent_at: …, postmark_message_id: result.messageId || null })` where `const result = await sendEmail({...})`. Catch: `.update({ status: 'failed', failed_reason: 'send_error' })` (message stays in the logError meta as today). Sweeper (`send-host-campaigns/route.js` ~107): `.update({ status: 'failed', failed_reason: 'stale_claim' })`. Header comment: one line on the reasons.
- [ ] **Step 4: Run** queue tests + `npx vitest run src/app/api/cron/send-host-campaigns src/app/api/webhooks/qstash` → PASS; eslint.
- [ ] **Step 5: Commit** `HOST-METRICS.1 — queue stamps postmark_message_id and a failure reason at every failure site`

---

### Task 5: Webhook events land on the send row

**Files:** Modify `src/lib/host-campaign-webhooks.js`, `src/lib/host-campaign-webhooks.test.js`

- [ ] **Step 1: Failing tests.** Extend `stubDb` so `host_campaign_sends` selects answer a configurable row and updates are recorded (`sendUpdates: [{ values, filters }]`), and `rpc(fn, args)` is recorded (`rpcCalls`). Add:
```js
describe('processHostCampaignEvent — send row outcomes (HOST-METRICS.1)', () => {
  const ROW = { id: 'send-1', postmark_message_id: null }
  const ev = (RecordType, extra = {}) => ({ RecordType, MessageID: 'pm-9', Metadata: META, ...extra })
  it('resolves the row by (campaign_id, contact_id) and stamps the message id when null', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Delivery'))
    const sel = db.sendSelects[0]
    expect(sel.filters).toEqual(expect.arrayContaining([['campaign_id', 'hc-1'], ['contact_id', 'c-1']]))
    expect(db.sendUpdates.some((u) => u.values.postmark_message_id === 'pm-9' && u.filters.some((f) => f[0] === 'is' && f[1] === 'postmark_message_id'))).toBe(true)
  })
  it('Delivery stamps delivered_at guarded on null', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Delivery', { DeliveredAt: '2026-09-06T21:24:46Z' }))
    const u = db.sendUpdates.find((u) => 'delivered_at' in u.values)
    expect(u.values.delivered_at).toBe('2026-09-06T21:24:46Z')
    expect(u.filters).toEqual(expect.arrayContaining([['id', 'send-1'], ['is', 'delivered_at', null]]))
  })
  it('Open stamps opened_at once and bumps open_count every time', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Open', { ReceivedAt: '2026-09-06T21:25:17Z' }))
    expect(db.sendUpdates.find((u) => 'opened_at' in u.values).filters).toEqual(expect.arrayContaining([['is', 'opened_at', null]]))
    expect(db.rpcCalls).toEqual([['bump_host_send_counter', { p_send_id: 'send-1', p_field: 'open_count' }]])
  })
  it('Click stamps clicked_at + opened_at (a click implies an open) and bumps click_count', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Click', { ReceivedAt: 't' }))
    expect(db.sendUpdates.some((u) => 'clicked_at' in u.values)).toBe(true)
    expect(db.sendUpdates.some((u) => 'opened_at' in u.values)).toBe(true)
    expect(db.rpcCalls).toEqual([['bump_host_send_counter', { p_send_id: 'send-1', p_field: 'click_count' }]])
  })
  it('HardBounce stamps bounced_at + bounce_type on the row AND the shared mailbox fact', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Bounce', { Type: 'HardBounce', BouncedAt: 'b' }))
    expect(db.sendUpdates.find((u) => 'bounced_at' in u.values).values).toEqual({ bounced_at: 'b', bounce_type: 'hard' })
    expect(db.contactUpdates[0].values).toEqual({ email_status: 'bounced' })
  })
  it('SoftBounce stamps the row (soft) but not the contact', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('Bounce', { Type: 'SoftBounce', BouncedAt: 'b' }))
    expect(db.sendUpdates.find((u) => 'bounced_at' in u.values).values.bounce_type).toBe('soft')
    expect(db.contactUpdates).toEqual([])
  })
  it('SpamComplaint stamps complained_at; SubscriptionChange stamps unsubscribed_at', async () => {
    let db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('SpamComplaint', { BouncedAt: 'c' }))
    expect(db.sendUpdates.some((u) => u.values.complained_at === 'c')).toBe(true)
    db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, ev('SubscriptionChange', { SuppressSending: true, ChangedAt: 'u' }))
    expect(db.sendUpdates.some((u) => u.values.unsubscribed_at === 'u')).toBe(true)
  })
  it('no matching row (test send, deleted campaign) → acknowledged, nothing written', async () => {
    const db = stubDb({ sendRow: null })
    expect(await processHostCampaignEvent(db, ev('Open'))).toEqual({ ok: true })
    expect(db.sendUpdates).toEqual([])
    expect(db.rpcCalls).toEqual([])
  })
  it('a test-send event (no contact_id) never looks up a row', async () => {
    const db = stubDb({ sendRow: ROW })
    await processHostCampaignEvent(db, { RecordType: 'Open', MessageID: 'pm-t', Metadata: { host_campaign_id: 'hc-1', host_id: 'h-1', test_send: '1' } })
    expect(db.sendSelects).toEqual([])
  })
  it('a failed row write is reported not-ok', async () => {
    const db = stubDb({ sendRow: ROW, failTable: 'host_campaign_sends' })
    expect((await processHostCampaignEvent(db, ev('Delivery'))).ok).toBe(false)
  })
})
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `processHostCampaignEvent`, after the metadata guard:
```js
  const row = await findSendRow(db, meta.host_campaign_id, contactId)   // .select('id, postmark_message_id').eq('campaign_id').eq('contact_id').maybeSingle(); error → { ok:false }
  if (row && !row.postmark_message_id && body.MessageID) {
    const { error } = await db.from('host_campaign_sends').update({ postmark_message_id: body.MessageID }).eq('id', row.id).is('postmark_message_id', null)
    if (error) return { ok: false, error: error.message }
  }
```
Timestamps: Postmark's field per event — Delivery `DeliveredAt`, Open/Click `ReceivedAt`, Bounce/SpamComplaint `BouncedAt`, SubscriptionChange `ChangedAt`; fall back to `new Date().toISOString()`. Helper `stampOnce(db, rowId, column, value)` → `.update({ [column]: value }).eq('id', rowId).is(column, null)` with error propagated; `bump(db, rowId, field)` → `db.rpc('bump_host_send_counter', { p_send_id, p_field })`, error logged (best-effort counter). Wire per the spec table; `row` null → skip all row writes but keep the contact/consent writes that already exist (a bounce for a deleted campaign still marks the mailbox). Delivery/Open/Click no longer "parked": they write and return `{ ok: true }`. Update the module header table.
- [ ] **Step 4: Run** both webhook test files → PASS; eslint; `npm run check:guardrails`.
- [ ] **Step 5: Commit** `HOST-METRICS.1 — host-stream events land on the send row (guarded stamps, counter bumps, message id)`

---

### Task 6: `src/lib/postmark-messages.js`

**Files:** Create `src/lib/postmark-messages.js`, `src/lib/postmark-messages.test.js`

- [ ] **Step 1: Failing tests** (stub `fetch` via `vi.stubGlobal('fetch', vi.fn())`, set `process.env.POSTMARK_API_KEY='t'` in `beforeEach`):
```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listOutboundMessages, getOutboundMessageDetails } from './postmark-messages.js'

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })
beforeEach(() => { process.env.POSTMARK_API_KEY = 't'; vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); delete process.env.POSTMARK_API_KEY })

describe('listOutboundMessages', () => {
  it('GETs /messages/outbound with tag, dates, count, offset and the server token', async () => {
    fetch.mockResolvedValueOnce(json({ TotalCount: 1, Messages: [{ MessageID: 'm1', Metadata: { host_campaign_id: 'hc' } }] }))
    const r = await listOutboundMessages({ tag: 'host-campaign', fromDate: '2026-07-23', toDate: '2026-09-06', count: 500, offset: 0 })
    expect(r).toEqual({ total: 1, messages: [{ MessageID: 'm1', Metadata: { host_campaign_id: 'hc' } }], error: null })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://api.postmarkapp.com/messages/outbound?count=500&offset=0&tag=host-campaign&fromdate=2026-07-23&todate=2026-09-06')
    expect(init.headers['X-Postmark-Server-Token']).toBe('t')
  })
  it('a non-2xx is returned as error, never thrown', async () => {
    fetch.mockResolvedValueOnce(json({ Message: 'nope' }, false, 401))
    expect(await listOutboundMessages({ tag: 'x' })).toEqual({ total: 0, messages: [], error: 'nope' })
  })
  it('no token → error', async () => {
    delete process.env.POSTMARK_API_KEY
    expect((await listOutboundMessages({ tag: 'x' })).error).toMatch(/token/i)
  })
})
describe('getOutboundMessageDetails', () => {
  it('GETs /messages/outbound/{id}/details and returns MessageEvents', async () => {
    fetch.mockResolvedValueOnce(json({ MessageID: 'm1', MessageEvents: [{ Type: 'Delivered', ReceivedAt: 'd' }] }))
    expect(await getOutboundMessageDetails('m1')).toEqual({ details: { MessageID: 'm1', MessageEvents: [{ Type: 'Delivered', ReceivedAt: 'd' }] }, error: null })
    expect(fetch.mock.calls[0][0]).toBe('https://api.postmarkapp.com/messages/outbound/m1/details')
  })
  it('a thrown fetch is returned as error', async () => {
    fetch.mockRejectedValueOnce(new Error('net'))
    expect(await getOutboundMessageDetails('m1')).toEqual({ details: null, error: 'net' })
  })
})
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — token via `resolvePostmarkToken` from `./postmark-token`; `POSTMARK_API_URL = 'https://api.postmarkapp.com'`; headers `{ Accept: 'application/json', 'X-Postmark-Server-Token': token }`; both functions never throw; `listOutboundMessages({ tag, fromDate, toDate, count = 500, offset = 0 })` builds the query string in exactly that key order (count, offset, tag, fromdate, todate; omit undefined) and returns `{ total: TotalCount, messages: Messages, error }`; `getOutboundMessageDetails(id)` returns `{ details, error }`. Header comment: retention is 45 days; Messages API is read-only; used by the backfill only.
- [ ] **Step 4: Run** → PASS; eslint.
- [ ] **Step 5: Commit** `HOST-METRICS.1 — postmark-messages.js: read-only Messages API client (list by tag, details)`

---

### Task 7: Backfill lib + admin route + settings button (after Task 6)

**Files:** Create `src/lib/host-campaign-backfill.js`, `src/lib/host-campaign-backfill.test.js`, `src/app/api/hosts/[id]/backfill-campaign-events/route.js`, `src/app/api/hosts/[id]/backfill-campaign-events/route.test.js`; modify `src/components/settings/HostDetail.jsx` (EmailSendingCard), `src/lib/openapi.js` (one `registerPath` for the admin route, placed right after the `/api/hosts/{id}/email-domain/verify` entry — grep it)

- [ ] **Step 1: Failing lib tests**
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('./postmark-messages.js', () => ({ listOutboundMessages: vi.fn(), getOutboundMessageDetails: vi.fn() }))
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
import { foldMessageEvents, backfillHostCampaignEvents } from './host-campaign-backfill.js'
import { listOutboundMessages, getOutboundMessageDetails } from './postmark-messages.js'

describe('foldMessageEvents', () => {
  it('maps Postmark event types to the row patch, first-of-kind timestamps, counts by multiplicity', () => {
    const events = [
      { Type: 'Delivered', ReceivedAt: 'd1' },
      { Type: 'Opened', ReceivedAt: 'o1' }, { Type: 'Opened', ReceivedAt: 'o2' },
      { Type: 'LinkClicked', ReceivedAt: 'c1' },
      { Type: 'Bounced', ReceivedAt: 'b1', Details: { BounceID: '1' } },
      { Type: 'SubscriptionChanged', ReceivedAt: 'u1', Details: { SuppressSending: 'True' } },
    ]
    expect(foldMessageEvents(events)).toEqual({ delivered_at: 'd1', opened_at: 'o1', open_count: 2, clicked_at: 'c1', click_count: 1, bounced_at: 'b1', bounce_type: 'hard', unsubscribed_at: 'u1' })
  })
  it('empty → {}', () => expect(foldMessageEvents([])).toEqual({}))
})

describe('backfillHostCampaignEvents', () => {
  // recorder db: host_campaigns select → campaigns of the host; host_campaign_sends select → rows; updates recorded
  it('dry run: counts what it would stamp, writes nothing', async () => { /* listOutboundMessages → 1 message with Metadata {host_campaign_id:'hc-1', contact_id:'c-1'}; row exists with null postmark_message_id; expect summary { scanned:1, matched:1, stamped:0, updated:0, skipped:0, errors:[] , dry:true } and no update statements */ })
  it('live: stamps the id (guarded) and folds the events with null guards', async () => { /* expect an update with postmark_message_id + .is('postmark_message_id', null), and an update carrying delivered_at/opened_at… each guarded by .is(col, null); open_count/click_count written only when the row's current counts are 0 */ })
  it('messages for other hosts or unknown rows are skipped, not errors', async () => {})
  it('pages past 500 using offset until scanned == total', async () => {})
  it('a details error is collected per message and the run continues', async () => {})
})
```
Write the five recorder-based tests fully (use the `makeDb(route)` recorder from `host-campaign-queue.test.js`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `host-campaign-backfill.js`**
```js
// HOST-METRICS.1 — one-off (and repair) backfill of host_campaign_sends
// outcomes from Postmark's Messages API. Postmark keeps 45 days, so the three
// pre-metrics campaigns (31 Jul, 31 Jul, 4 Sep 2026) must be folded before
// ~14 Sep 2026. Idempotent: every write is null-guarded, counts are written
// only onto a row that still has 0, so a second run changes nothing.
import { listOutboundMessages, getOutboundMessageDetails } from './postmark-messages.js'
import { logWarn } from './log.js'

const PAGE = 500
const PAUSE_MS = 40

export function foldMessageEvents(events) { /* per test: first ReceivedAt per type, counts; Bounced → bounce_type 'hard' unless Details?.BounceID hints otherwise — Postmark's Type for soft is also 'Bounced'; read Details.Type when present ('SoftBounce' → 'soft', 'Transient' → 'transient', else 'hard') */ }

export async function backfillHostCampaignEvents(db, { hostId, dry = true, fromDate, toDate, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // 1. campaigns of this host → Set of ids; 2. their send rows keyed `${campaign_id}:${contact_id}` (paginate .range under 1k per campaign);
  // 3. page listOutboundMessages({ tag: 'host-campaign', fromDate, toDate, count: PAGE, offset }) until scanned >= total or an empty page;
  // 4. per message: meta = Metadata; key lookup; miss → skipped++; hit: if row.postmark_message_id null → (live) update guarded, stamped++;
  //    details = getOutboundMessageDetails(id) (error → errors.push({ message_id, error }), continue); patch = foldMessageEvents(details.MessageEvents);
  //    (live) for each timestamp column: update({[col]: v}).eq('id').is(col, null); for counts: update({open_count}).eq('id').eq('open_count', 0) (same for click); updated++ when patch non-empty;
  //    await sleep(PAUSE_MS)
  // returns { dry, scanned, matched, stamped, updated, skipped, errors }
}
```
- [ ] **Step 4: Admin route** `src/app/api/hosts/[id]/backfill-campaign-events/route.js`: `POST`, gate = `getCurrentUser()` + `ADMIN_ROLES` (copy the `gate()` from `src/app/api/hosts/[id]/route.js`), `loadHostForOrg` 404 (org scoping), `dry = request.nextUrl.searchParams.get('dry') !== '0'`, `fromDate` = 45 days ago (`YYYY-MM-DD`), `toDate` = tomorrow; returns `{ success: true, data: summary }`. Route test: 401/403/404/dry-default/`?dry=0` passes `dry:false` (mock the lib). Register in `openapi.js`. Route-guards check: the route is session-guarded (no EXEMPT).
- [ ] **Step 5: Button** in `HostDetail.jsx` `EmailSendingCard`, after the Verify/Disable buttons row (only when `provisioned`): a "Backfill Postmark events" secondary button that POSTs `?dry=1` first and shows `matched/stamped/updated/skipped/errors.length`, then a "Run for real" confirm (`window.confirm`) posting `?dry=0`. Result line in `text-xs text-un1t-subtle`.
- [ ] **Step 6: Run** `npx vitest run src/lib/host-campaign-backfill.test.js 'src/app/api/hosts/[id]/backfill-campaign-events' src/lib/openapi.test.js`; eslint; `npm run check:route-guards`; `npm run check:location-scoping` (the route reads `host_campaigns`/`host_campaign_sends` scoped by the org-loaded host id — if flagged, add an EXEMPT reason).
- [ ] **Step 7: Commit** `HOST-METRICS.1 — Postmark backfill lib + admin route + settings button`

---

### Task 8: Read APIs (after Task 3)

**Files:** Modify `src/app/api/host/emails/route.js` (GET), create `src/app/api/host/emails/[id]/recipients/route.js` + `route.test.js`, modify `src/lib/openapi.js` (register the recipients route next to `/api/host/emails/{id}` — grep it)

- [ ] **Step 1: Failing route test** for recipients (recorder db; mock `@/lib/host-auth` `getCurrentHost`):
  - 401 without session; 404 when the campaign is another host's (the campaign select returns null); 200 shape `{ campaign: { id, subject, status, email_type, audience_kind, sent_at, recipient_count, stats }, recipients: [...] }` where `stats` comes from `db.rpc('host_campaign_stats', { p_host_id })` filtered to this campaign (zeros when absent); each recipient has `outcome` from `deriveOutcome`, `outcome_at` from `outcomeAt`, `failure_copy` when failed; rows paginate with `.range` under the 1k cap and are ordered by `sent_at` desc nulls last then `email`; contact name via `contact:contacts!contact_id ( name, first_name, last_name )` → `name` = `first_name last_name` or `name` or ''.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the recipients route (`getCurrentHost`, `.eq('host_id', session.host.id)` on the campaign, service client, `{ success, data }`). List route GET: after loading campaigns, `const { data: statRows, error: statErr } = await db.rpc('host_campaign_stats', { p_host_id: session.host.id })`; on error log and return campaigns without stats (never fail the list); attach `stats` per campaign (zeros default, numbers coerced from bigint strings with `Number()`).
- [ ] **Step 4: Run** `npx vitest run src/app/api/host/emails` → PASS; eslint; `npm run check:route-guards`; `npm run check:location-scoping`.
- [ ] **Step 5: Commit** `HOST-METRICS.1 — list gains per-campaign stats; GET /api/host/emails/[id]/recipients`

---

### Task 9: Portal UI (after Task 3)

**Files:** Modify `src/components/host/HostEmails.jsx`; create `src/components/host/HostEmailReport.jsx`, `src/components/host/HostEmailReport.test.jsx`, `src/app/host/(portal)/emails/[id]/page.js`

- [ ] **Step 1: Failing test** — `HostEmailReport.test.jsx` (jsdom, `@testing-library/react` is available: check `ls src/components/**/*.test.jsx | head` for an existing render-based test to copy the setup from; if none renders, export and unit-test the pure helpers `statTiles(stats)` and `filterRecipients(rows, filter)` instead, matching the repo's host-component convention noted in `HostEmails.test.jsx`):
  - `statTiles({ sent: 124, delivered: 118, opened: 41, clicked: 9, bounced: 2, unsubscribed: 1, failed: 4 })` → 7 tiles with labels in that order and `Opened` / `Clicked` carrying `sub: '35%'` / `'8%'` of delivered (0% when delivered 0).
  - `filterRecipients(rows, 'not_opened')` = delivered rows without opened_at; `'failed'` = outcome failed; `'all'` = everything.
- [ ] **Step 2: Implement `HostEmailReport.jsx`** (client): props `{ campaignId }`; fetches `/api/host/emails/${campaignId}/recipients`; renders header (subject, sent date via `.slice(0,10)`, audience label from `audience_kind`: All contacts / Mailing list signups / Event attendees, Utility chip), the 7 tiles using the dashboard tile classes (`rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3`, grid `grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3`), filter chips (All / Opened / Clicked / Not opened / Bounced / Unsubscribed / Failed, counts in brackets), and the table: `<table>` on `sm:` and up (Name, Email, Outcome chip, When), stacked `<ul>` under 640px (`sm:hidden`). Outcome chip classes: failed/bounced/complained `bg-red-500/15 text-red-300`, unsubscribed `bg-amber-500/15 text-amber-300`, clicked `bg-emerald-500/15 text-emerald-300`, opened `bg-sky-500/15 text-sky-300`, delivered/sent `bg-white/10 text-white/70`, queued `bg-white/5 text-white/40`. Failed rows show `failure_copy` under the chip. States: loading, error ("Could not load this email."), `status === 'sending'` note "Still sending", zero delivered with `sent_at` older than an hour → "Nothing delivered yet. If this persists, contact UN1T." Empty recipients → "No recipients." No em-dashes in any string.
- [ ] **Step 3: Page** `src/app/host/(portal)/emails/[id]/page.js`: `getCurrentHost()` → redirect `/host/login`; `<a href="/host/emails">← Back to emails</a>`; `<HostEmailReport campaignId={params.id} />` (the API does the 404; the page passes the id through). `dynamic = 'force-dynamic'`.
- [ ] **Step 4: List row** in `HostEmails.jsx`: for non-draft campaigns the subline becomes `${s.sent} sent · ${s.delivered} delivered · ${s.opened} opened · ${s.clicked} clicked` when `c.stats` exists (fallback to today's text), plus a `bg-amber-500/15 text-amber-300` chip `${s.failed} failed` when > 0, and the subject becomes a `<a href={`/host/emails/${c.id}`}>` for non-drafts. Add a unit test in `HostEmails.test.jsx` for an exported `statsLine(stats)` helper.
- [ ] **Step 5: Run** `npx vitest run src/components/host` → PASS; eslint; `npm run check:guardrails` (chip contrast rule is path-excluded for dark host surfaces — confirm `eslint.guardrails.config.mjs` lists `src/components/host`; if not, use the `-300` ramps as above which are the dark-surface idiom already used in this file).
- [ ] **Step 6: Commit** `HOST-METRICS.1 — host email report page + list-row stats`

---

### Task 10: Finish

- [ ] Changelog row under the table header (PR number after `gh pr create`): `| #<PR> | HOST-METRICS.1 — host campaign send metrics | mig 590 (applied). Per-send outcomes on host_campaign_sends (message id, delivered/opened/clicked/bounced/complained/unsubscribed, counts, failed_reason), host_campaign_stats() + bump_host_send_counter(). Webhook branch resolves the row by (campaign, contact) metadata; queue stamps the message id + a reason at every failure site. Report page /host/emails/[id] with 7 tiles + filterable recipient table; list row shows sent/delivered/opened/clicked. Postmark Messages-API backfill (lib + admin route + button on Settings → Hosts); run before ~14 Sep for the 31 Jul sends. Spec docs/superpowers/specs/2026-09-06-host-campaign-metrics-design.md. |`
- [ ] CI mirror + `npm run build`.
- [ ] `git push -u origin HEAD && gh pr create --base main --fill-first` with a body listing: migration applied, what changed, verification, post-merge: run the backfill (dry then live) from Settings → Hosts → Pride Training Club and compare `updated` with the 372 messages; open `/host/emails/<4 Sep campaign>` and check the 4 failed rows read "Mailbox rejected earlier mail" (they were Postmark-suppressed at send time → `send_error`? No: they failed inside `sendEmail` with 422, so they read "Mail server rejected the send" — state which).
- [ ] After merge: run the backfill; verify against Postmark's numbers for the 4 Sep campaign (120 sent).

## Self-review
- Spec §1 → T1; §2 → T2, T4; §3 → T5; §4 → T8; §5 → T9; §6 → T6, T7; §7 → each task destructures error; §8 → each task's tests; §9 → T1 step 2, T10.
- Names: `emailabilityReason`, `deriveOutcome`, `outcomeAt`, `FAILURE_COPY`, `failureCopy`, `OUTCOMES`, `listOutboundMessages`, `getOutboundMessageDetails`, `foldMessageEvents`, `backfillHostCampaignEvents`, `bump_host_send_counter`, `host_campaign_stats`, `statTiles`, `filterRecipients`, `statsLine`.
- Reasons vocabulary identical in T2 (producer), T3 (copy), mig 590 comment.
