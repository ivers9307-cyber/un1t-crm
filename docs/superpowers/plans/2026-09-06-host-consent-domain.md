# Host Consent Domain (HOST-CONSENT.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host marketing email becomes its own consent domain: consent lives on the host membership row, revocation stays per host, each host sends on its own Postmark stream, and a UN1T unsubscribe never touches the host consent or vice versa.

**Architecture:** One migration (588) adds the consent columns, the per-host stream id, and a `race_registrations.marketing_consent` column. A new `src/lib/host-consent.js` owns every grant/revoke write (host_contacts + consent_log). The send gate `isEmailable` gains a `hostConsent` input and stops reading `contacts.email_marketing`. The queue sends marketing on the host's Postmark stream via `sendEmail`'s existing `postmarkStream` option (internal stream stays `'broadcast'`, which is what attaches the one-click headers and tracking). Host-stream webhook events are identified by metadata and routed to a new `src/lib/host-campaign-webhooks.js` before the CRM switch.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role client, migrations applied via Supabase MCP), Postmark, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-09-06-host-consent-domain-design.md`. One deviation from the spec, recorded there: no new `marketing: true` option on `sendEmail`. The existing `postmarkStream` option (EMAIL-OUTBOUND-SERVER.1) already puts a foreign stream id on the wire while the internal `stream: 'broadcast'` keeps tracking and the List-Unsubscribe headers.

**Repo rules that apply throughout** (from `CLAUDE.md`): every `.select()` is capped at 1,000 rows, so fan-outs paginate with `.range()`; supabase builders are thenables (no `.catch`); destructure `error` on every write; `[id]`/`[slug]` paths need single quotes in zsh; branch is `host-consent-domain` in worktree `~/code/un1t-crm-hostconsent`; commit after every task; never `git add -A`.

Run the CI mirror before pushing:

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/588_host_consent_domain.sql` | Create: consent columns on `host_contacts`, `consent_log.host_id` + channel vocabulary, `event_hosts.postmark_stream_id`, `race_registrations.marketing_consent`, backfill |
| `src/lib/host-contact-list.js` | Modify: `isEmailable` takes `hostConsent`; `fetchHostContactRows` and `addEventAttendeesToHostList` read/write consent |
| `src/lib/host-campaign-email.js` | Modify: `resolveHostRecipients` passes `hostConsent` |
| `src/lib/host-consent.js` | Create: grant / bulk grant / revoke / resubscribe writes |
| `src/lib/host-campaign-queue.js` | Modify: consent re-check via `host_contacts`, per-host `postmarkStream`, `unsubscribeUrl`, halt when no stream |
| `src/app/api/host/emails/[id]/send/route.js` | Modify: 409 when marketing and no stream |
| `src/app/api/public/host-list/[slug]/subscribe/route.js` | Modify: grant host consent, resubscribe path |
| `src/app/api/public/events/[slug]/register/route.js` | Modify: persist `marketing_consent` on both registration inserts |
| `src/app/api/public/events/[slug]/route.js` | Modify: expose `host_name` and `organization_name` |
| `src/app/unsubscribe/host/[token]/page.js` | Modify: revoke through the lib, push Postmark suppression |
| `src/app/api/unsubscribe/host/[token]/route.js` | Create: RFC 8058 one-click POST target |
| `src/lib/host-campaign-webhooks.js` | Create: `isHostCampaignEvent`, `processHostCampaignEvent` |
| `src/lib/postmark-webhook-processor.js` | Modify: route host events before the switch |
| `src/lib/hosts.js`, `src/app/api/hosts/[id]/route.js`, `src/components/settings/HostDetail.jsx` | Modify: admin edits `postmark_stream_id` |
| `src/components/HostListSignup.jsx`, `src/app/h/[slug]/page.js`, `src/components/RaceSignupWidget.jsx` | Modify: two-consent copy |
| `scripts/check-route-guards.mjs`, `src/lib/openapi.js`, `docs/CHANGELOG.md` | Modify: register the new route |

---

### Task 1: Migration 588

**Files:**
- Create: `supabase/migrations/588_host_consent_domain.sql`

- [ ] **Step 1: Write the migration**

```sql
-- HOST-CONSENT.1 — host marketing becomes its own consent domain.
--
-- WHY. A host's marketing send read the UN1T-wide contacts.email_marketing
-- flag and rode Postmark's shared `broadcast` stream, so a UN1T unsubscribe
-- (or a Postmark suppression from a UN1T campaign) silently blocked the host,
-- and a host-list signup re-granted UN1T consent. Measured 6 Sep 2026: 47 of
-- the only host's 179 contacts were unreachable, none of whom had left the
-- host's list. Richard's decision: two INDEPENDENT consents, stated on the
-- form; each host sends on its own Postmark stream.
--
-- host_email_suppressions stays the per-host revocation record. Consent true
-- + no suppression row = mailable by that host, subject to mailbox facts.

alter table host_contacts
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists marketing_consented_at timestamptz,
  add column if not exists marketing_consent_source text;

alter table host_contacts
  drop constraint if exists host_contacts_marketing_consent_source_check;
alter table host_contacts
  add constraint host_contacts_marketing_consent_source_check
  check (marketing_consent_source is null or marketing_consent_source in
    ('mailing_list_form', 'event_form', 'backfill_2026_09', 'host_resubscribe'));

-- consent_log gains a host scope. Existing rows keep host_id NULL.
alter table consent_log add column if not exists host_id uuid references event_hosts(id) on delete cascade;
create index if not exists idx_consent_log_host on consent_log (host_id) where host_id is not null;

-- The channel vocabulary CHECK (live in prod) must admit the host channel.
alter table consent_log drop constraint if exists consent_log_channel_vocabulary;
alter table consent_log add constraint consent_log_channel_vocabulary
  check (channel in ('email_marketing', 'email_administrative', 'sms_marketing',
                     'sms_administrative', 'whatsapp_marketing', 'whatsapp_administrative',
                     'host_email_marketing'));

-- One Postmark Broadcasts stream per host (suppression lists are per stream).
-- NULL = marketing sending not set up; the send route fails closed on it.
alter table event_hosts add column if not exists postmark_stream_id text;
alter table event_hosts drop constraint if exists event_hosts_postmark_stream_id_check;
alter table event_hosts add constraint event_hosts_postmark_stream_id_check
  check (postmark_stream_id is null or postmark_stream_id ~ '^[a-z0-9][a-z0-9-]{0,63}$');

-- The register form's soft opt-in checkbox was applied to UN1T consent and
-- discarded. Persist it so the attendee sync can grant HOST consent when the
-- registration confirms. NULL = row written before this migration.
alter table race_registrations add column if not exists marketing_consent boolean;

-- Backfill: every existing membership came from a signup or a confirmed
-- booking that showed marketing copy. Members already in
-- host_email_suppressions LEFT the host's list: they stay consent=false.
update host_contacts hc
set marketing_consent = true,
    marketing_consented_at = hc.created_at,
    marketing_consent_source = 'backfill_2026_09'
where hc.marketing_consent = false
  and not exists (
    select 1 from host_email_suppressions s
    where s.host_id = hc.host_id and s.contact_id = hc.contact_id
  );

comment on column host_contacts.marketing_consent is
  'HOST-CONSENT.1 — consent to THIS host''s marketing. Independent of contacts.email_marketing (UN1T). Revocation = host_email_suppressions row.';
comment on column event_hosts.postmark_stream_id is
  'HOST-CONSENT.1 — the host''s own Postmark Broadcasts stream id (e.g. colm-events). NULL = marketing sending not set up; send route 409s.';
comment on column race_registrations.marketing_consent is
  'HOST-CONSENT.1 — the register form checkbox as submitted. NULL = pre-588 row.';
```

- [ ] **Step 2: Apply to the un1t-crm Supabase project via MCP**

Use `apply_migration` on project `iyvtbjjxdggiadzwwvdj` with name `588_host_consent_domain` and the file's content. Then `get_advisors` type `security`. Expected: no new ERROR-level findings (the three tables already have RLS enabled with no policies, service-role only).

- [ ] **Step 3: Verify the backfill against live numbers**

Run via `execute_sql`:

```sql
select
  count(*) filter (where marketing_consent) as consented,
  count(*) filter (where not marketing_consent) as not_consented,
  (select count(*) from host_email_suppressions) as suppressed
from host_contacts;
```

Expected on 6 Sep data: `consented` + `not_consented` = 179, and `not_consented` = number of memberships that have a suppression row (11 suppression rows exist; a suppression row for a contact who is not a member does not count).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/588_host_consent_domain.sql
git commit -m "HOST-CONSENT.1 — mig 588: host_contacts consent, consent_log.host_id, event_hosts.postmark_stream_id, race_registrations.marketing_consent"
```

---

### Task 2: `isEmailable` reads host consent, not `contacts.email_marketing`

**Files:**
- Modify: `src/lib/host-contact-list.js:91-105`
- Test: `src/lib/host-contact-list.test.js` (the `describe('isEmailable'` block, from line 46)

- [ ] **Step 1: Write the failing tests**

Add inside `describe('isEmailable', () => {` after the existing cases:

```js
  describe('HOST-CONSENT.1 — host consent replaces the UN1T flag for marketing', () => {
    const optedOutOfUn1t = { ...good, email_marketing: false }

    it('is TRUE for a contact opted out of UN1T marketing but consented to the host', () => {
      expect(isEmailable(optedOutOfUn1t, false, { hostConsent: true })).toBe(true)
    })
    it('is FALSE when host consent is false, even with UN1T consent true', () => {
      expect(isEmailable(good, false, { hostConsent: false })).toBe(false)
    })
    it('fails CLOSED when hostConsent is omitted', () => {
      expect(isEmailable(good, false)).toBe(false)
      expect(isEmailable(good, false, {})).toBe(false)
    })
    it('still blocks a per-host suppression with host consent true', () => {
      expect(isEmailable(good, true, { hostConsent: true })).toBe(false)
    })
    it('still blocks mailbox facts with host consent true', () => {
      expect(isEmailable({ ...good, email_status: 'bounced' }, false, { hostConsent: true })).toBe(false)
      expect(isEmailable({ ...good, email_status: 'complained' }, false, { hostConsent: true })).toBe(false)
      expect(isEmailable({ ...good, email_suppressed_at: '2026-08-11T05:45:14Z' }, false, { hostConsent: true })).toBe(false)
    })
    it('utility ignores hostConsent entirely (administrative consent + mailbox facts only)', () => {
      const admin = { ...good, email_administrative: true, email_marketing: false }
      expect(isEmailable(admin, true, { emailType: 'utility', hostConsent: false })).toBe(true)
    })
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/host-contact-list.test.js -t "HOST-CONSENT.1"`
Expected: the first three tests FAIL (`true` where `false` expected and vice versa). Existing `isEmailable` tests that pass `good` with no `hostConsent` will also start failing once Step 3 lands — update them in Step 3.

- [ ] **Step 3: Implement**

Replace the docblock + function at `src/lib/host-contact-list.js:72-105` with:

```js
/**
 * Send-time emailability predicate — the SAME gate the send path uses.
 * Pure: the caller loads the contact flags, the per-host suppression set and
 * the host_contacts.marketing_consent value.
 *
 * HOST-CONSENT.1 — host marketing is its own consent domain:
 *   marketing (default)  opts.hostConsent === true (host_contacts.marketing_consent),
 *                        no host_email_suppressions row, and the mailbox facts
 *                        below. It does NOT read contacts.email_marketing any
 *                        more — a UN1T opt-out is not a host opt-out.
 *   utility              operational messages to attendees (time change,
 *                        instructions) — email_administrative === true;
 *                        marketing opt-outs do NOT block it, deliverability
 *                        blocks (bounced / complained / suppressed_at) do.
 * Shared on purpose: email_status bounced/complained and the repeat-bounce
 * stamp email_suppressed_at describe the MAILBOX, not the relationship.
 *
 * hostConsent defaults to false so a caller that forgets it fails closed.
 *
 * @param {object|null} contact  contacts row with email, email_administrative,
 *   email_status, email_suppressed_at
 * @param {boolean} suppressed   contact_id ∈ host_email_suppressions for this host
 * @param {{emailType?: 'marketing'|'utility', hostConsent?: boolean}} [opts]
 * @returns {boolean}
 */
export function isEmailable(contact, suppressed, { emailType = 'marketing', hostConsent = false } = {}) {
  if (!contact) return false
  if (!contact.email) return false
  if (contact.email_suppressed_at) return false
  if (emailType === 'utility') {
    if (contact.email_administrative !== true) return false
    if (['bounced', 'complained'].includes(contact.email_status ?? 'active')) return false
    return true
  }
  if (suppressed) return false
  if (hostConsent !== true) return false
  if (BLOCKED_EMAIL_STATUSES.includes(contact.email_status ?? 'active')) return false // NULL = legacy 'active' (column default, mig 005)
  return true
}
```

Also update the file header comment (lines 6-20) to say the marketing gate is host consent, and rewrite the existing marketing cases in the test's `describe('isEmailable'` block so every positive case passes `{ hostConsent: true }`, and the old `email_marketing: false → false` case becomes `hostConsent: false → false`.

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run src/lib/host-contact-list.test.js`
Expected: PASS (the `fetchHostContactRows` and `addEventAttendeesToHostList` blocks still pass because they do not yet assert consent).

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-contact-list.js src/lib/host-contact-list.test.js
git commit -m "HOST-CONSENT.1 — isEmailable gates marketing on host consent, fails closed without it"
```

---

### Task 3: Pass host consent through the three readers

**Files:**
- Modify: `src/lib/host-contact-list.js:287-329` (`fetchHostContactRows`)
- Modify: `src/lib/host-campaign-email.js:232-259` (`resolveHostRecipients`)
- Test: `src/lib/host-contact-list.test.js` (`describe('fetchHostContactRows'`), `src/lib/host-campaign-email.test.js` (`describe('resolveHostRecipients'`)

- [ ] **Step 1: Write the failing tests**

In `src/lib/host-contact-list.test.js`, the `membership` helper at line 412 gains a consent field, and add a test:

```js
  const membership = (contactId, contact, source = 'event', marketing_consent = true) => ({
    contact_id: contactId,
    source,
    created_at: '2026-07-01T10:00:00Z',
    marketing_consent,
    contact,
  })

  it('HOST-CONSENT.1 — emailable follows host consent, not contacts.email_marketing', async () => {
    const db = fakeRowsDb({
      memberships: [
        membership('c1', { ...goodContact('c1'), email_marketing: false }, 'event', true),
        membership('c2', goodContact('c2'), 'event', false),
      ],
    })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows.map((r) => [r.contact_id, r.emailable, r.marketing_consent])).toEqual([
      ['c1', true, true],
      ['c2', false, false],
    ])
  })
```

In `src/lib/host-campaign-email.test.js`, the `member` helper at line ~241 gains consent, and add:

```js
const member = (contactId, contact, marketing_consent = true) => ({ contact_id: contactId, marketing_consent, contact })

  it('HOST-CONSENT.1 — includes a UN1T-opted-out contact who consented to the host, excludes one who did not', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', { ...goodContact('c1', 'a@x.ie'), email_marketing: false }, true),
        member('c2', goodContact('c2', 'b@x.ie'), false),
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c1', email: 'a@x.ie' }])
  })
```

The existing test at line 259 (`email_marketing: false` excluded) changes to `member('c2', goodContact('c2', 'b@x.ie'), false)` with the description "host consent false".

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/host-contact-list.test.js src/lib/host-campaign-email.test.js`
Expected: the two new tests FAIL (`c1` missing / `emailable` false).

- [ ] **Step 3: Implement**

`fetchHostContactRows`: change the select and the mapping.

```js
      .select(`
        contact_id, source, created_at, marketing_consent,
        contact:contacts!contact_id ( id, name, email, email_status, email_suppressed_at )
      `)
```

```js
  return memberships.map((m) => {
    const contact = m.contact || null
    return {
      contact_id: m.contact_id,
      name: contact?.name || '',
      email: contact?.email || '',
      source: m.source,
      created_at: m.created_at,
      marketing_consent: m.marketing_consent === true,
      emailable: isEmailable(contact, suppressedIds.has(m.contact_id), { hostConsent: m.marketing_consent === true }),
    }
  })
```

`resolveHostRecipients`: select and gate.

```js
      .select(`
        contact_id, marketing_consent,
        contact:contacts!contact_id ( id, email, email_administrative, email_status, email_suppressed_at )
      `)
```

```js
      if (!isEmailable(contact, suppressed.has(row.contact_id), { emailType, hostConsent: row.marketing_consent === true })) continue
```

Update the docblock of `fetchHostContactRows` (`@returns`) to include `marketing_consent:boolean`, and the header comment of `host-campaign-email.js` line 16 to say "host consent + minus host_email_suppressions".

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/host-contact-list.test.js src/lib/host-campaign-email.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-contact-list.js src/lib/host-contact-list.test.js src/lib/host-campaign-email.js src/lib/host-campaign-email.test.js
git commit -m "HOST-CONSENT.1 — contacts page and recipient resolver read host_contacts.marketing_consent"
```

---

### Task 4: `src/lib/host-consent.js` — the one place that writes host consent

**Files:**
- Create: `src/lib/host-consent.js`
- Test: `src/lib/host-consent.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// HOST-CONSENT.1 — every host consent write goes through this module.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import {
  HOST_CONSENT_CHANNEL,
  grantHostConsent,
  grantHostConsentBulk,
  revokeHostConsent,
  resubscribeHost,
} from './host-consent.js'

// Chainable thenable recorder (host-campaign-queue.test.js idiom).
function makeDb(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? { data: null, error: null })
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
const op = (s, m) => s.ops.find((o) => o.method === m)
const hasEq = (s, col, val) => s.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

const H = 'h-1', C = 'c-1'

beforeEach(() => vi.clearAllMocks())

describe('grantHostConsent', () => {
  it('flips consent on the membership row and logs opt_in with host_id', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_contacts') return { data: [{ contact_id: C }], error: null }
      return { data: null, error: null }
    })
    const r = await grantHostConsent(db, { hostId: H, contactId: C, source: 'mailing_list_form', ipAddress: '1.2.3.4' })
    expect(r).toEqual({ ok: true, changed: true })

    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'update').args[0]).toMatchObject({ marketing_consent: true, marketing_consent_source: 'mailing_list_form' })
    expect(typeof op(upd, 'update').args[0].marketing_consented_at).toBe('string')
    expect(hasEq(upd, 'host_id', H) && hasEq(upd, 'contact_id', C) && hasEq(upd, 'marketing_consent', false)).toBe(true)

    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0]).toEqual([{
      contact_id: C, channel: HOST_CONSENT_CHANNEL, action: 'opt_in',
      source: 'mailing_list_form', ip_address: '1.2.3.4', host_id: H, location_id: null,
    }])
  })

  it('is a no-op (no log row) when consent was already true', async () => {
    const { db, statements } = makeDb(() => ({ data: [], error: null }))
    const r = await grantHostConsent(db, { hostId: H, contactId: C, source: 'event_form' })
    expect(r).toEqual({ ok: true, changed: false })
    expect(statements.some((s) => s.table === 'consent_log')).toBe(false)
  })

  it('reports a failed write instead of swallowing it', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'boom' } }))
    const r = await grantHostConsent(db, { hostId: H, contactId: C, source: 'event_form' })
    expect(r).toEqual({ ok: false, changed: false, error: 'boom' })
  })
})

describe('grantHostConsentBulk', () => {
  it('updates only rows still false and logs one row per contact actually flipped', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_contacts') return { data: [{ contact_id: 'c-2' }], error: null }
      return { data: null, error: null }
    })
    const r = await grantHostConsentBulk(db, { hostId: H, contactIds: ['c-1', 'c-2'], source: 'event_form' })
    expect(r).toEqual({ ok: true, changed: 1 })
    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'in').args).toEqual(['contact_id', ['c-1', 'c-2']])
    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0]).toHaveLength(1)
    expect(op(log, 'insert').args[0][0]).toMatchObject({ contact_id: 'c-2', action: 'opt_in', host_id: H })
  })
  it('returns changed 0 with no writes for an empty list', async () => {
    const { db, statements } = makeDb(() => ({}))
    expect(await grantHostConsentBulk(db, { hostId: H, contactIds: [], source: 'event_form' })).toEqual({ ok: true, changed: 0 })
    expect(statements).toHaveLength(0)
  })
})

describe('revokeHostConsent', () => {
  it('upserts the suppression row (insert-once) and logs opt_out', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [{ id: 's-1' }], error: null }
      return { data: null, error: null }
    })
    const r = await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page', ipAddress: '9.9.9.9' })
    expect(r).toEqual({ ok: true, changed: true })
    const sup = statements.find((s) => s.table === 'host_email_suppressions')
    expect(op(sup, 'upsert').args).toEqual([
      { host_id: H, contact_id: C },
      { onConflict: 'host_id,contact_id', ignoreDuplicates: true },
    ])
    const log = statements.find((s) => s.table === 'consent_log')
    expect(op(log, 'insert').args[0][0]).toMatchObject({ contact_id: C, channel: HOST_CONSENT_CHANNEL, action: 'opt_out', source: 'host_unsubscribe_page', host_id: H })
  })
  it('already suppressed → ok, changed false, no log row', async () => {
    const { db, statements } = makeDb(() => ({ data: [], error: null }))
    expect(await revokeHostConsent(db, { hostId: H, contactId: C, source: 'postmark_one_click_unsubscribe' })).toEqual({ ok: true, changed: false })
    expect(statements.some((s) => s.table === 'consent_log')).toBe(false)
  })
  it('never touches contacts.email_marketing', async () => {
    const { db, statements } = makeDb(() => ({ data: [{ id: 's-1' }], error: null }))
    await revokeHostConsent(db, { hostId: H, contactId: C, source: 'host_unsubscribe_page' })
    expect(statements.some((s) => s.table === 'contacts' || s.table === 'contact_preferences')).toBe(false)
  })
})

describe('resubscribeHost', () => {
  it('deletes the suppression row, then grants with source host_resubscribe', async () => {
    const { db, statements } = makeDb((s) => {
      if (s.table === 'host_email_suppressions') return { data: [{ id: 's-1' }], error: null }
      if (s.table === 'host_contacts') return { data: [{ contact_id: C }], error: null }
      return { data: null, error: null }
    })
    const r = await resubscribeHost(db, { hostId: H, contactId: C, ipAddress: '1.1.1.1' })
    expect(r).toEqual({ ok: true, unsuppressed: true, changed: true })
    const del = statements.find((s) => s.table === 'host_email_suppressions')
    expect(op(del, 'delete')).toBeTruthy()
    expect(hasEq(del, 'host_id', H) && hasEq(del, 'contact_id', C)).toBe(true)
    const upd = statements.find((s) => s.table === 'host_contacts')
    expect(op(upd, 'update').args[0]).toMatchObject({ marketing_consent_source: 'host_resubscribe' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/host-consent.test.js`
Expected: FAIL — `Cannot find module './host-consent.js'`.

- [ ] **Step 3: Implement**

```js
// HOST-CONSENT.1 — the ONE writer of host marketing consent.
//
// Host marketing is its own consent domain (spec:
// docs/superpowers/specs/2026-09-06-host-consent-domain-design.md).
//   grant   → host_contacts.marketing_consent = true (+ when/source), one
//             consent_log row, channel 'host_email_marketing', host_id set.
//   revoke  → host_email_suppressions row (insert-once), one opt_out row.
//   resub   → delete the suppression row, then grant (source host_resubscribe).
// None of these touch contacts.email_marketing / contact_preferences —
// that is the UN1T domain and the whole point is that the two never cross.
//
// Postmark suppress/unsuppress on the host's stream is the CALLER's
// fire-and-forget side effect (it needs the host row's postmark_stream_id),
// kept out of here so this module stays a pure-DB unit.
//
// Every write destructures `error` (CLAUDE.md: a bare supabase write resolves
// rather than throws) and returns {ok, changed} so a caller can judge it.

import { logError } from './log.js'

export const HOST_CONSENT_CHANNEL = 'host_email_marketing'

function logRow({ contactId, hostId, action, source, ipAddress }) {
  return {
    contact_id: contactId,
    channel: HOST_CONSENT_CHANNEL,
    action,
    source,
    ip_address: ipAddress ?? null,
    host_id: hostId,
    location_id: null,
  }
}

async function insertLog(db, rows) {
  if (!rows.length) return
  const { error } = await db.from('consent_log').insert(rows)
  // The consent decision is already durable in host_contacts /
  // host_email_suppressions; a lost audit row is logged, never thrown.
  if (error) logError('host-consent', 'consent_log insert failed', { error: error.message, rows: rows.length })
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db service-role
 * @param {{hostId:string, contactId:string, source:'mailing_list_form'|'event_form'|'host_resubscribe', ipAddress?:string|null}} args
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string}>}
 */
export async function grantHostConsent(db, { hostId, contactId, source, ipAddress = null }) {
  const { data, error } = await db
    .from('host_contacts')
    .update({
      marketing_consent: true,
      marketing_consented_at: new Date().toISOString(),
      marketing_consent_source: source,
    })
    .eq('host_id', hostId)
    .eq('contact_id', contactId)
    .eq('marketing_consent', false)
    .select('contact_id')
  if (error) return { ok: false, changed: false, error: error.message }
  const changed = (data || []).length > 0
  if (changed) await insertLog(db, [logRow({ contactId, hostId, action: 'opt_in', source, ipAddress })])
  return { ok: true, changed }
}

/**
 * Attendee-sync variant: one UPDATE for many contacts, one log row per
 * contact that actually flipped. Caller chunks to ≤500 ids.
 * @returns {Promise<{ok:boolean, changed:number, error?:string}>}
 */
export async function grantHostConsentBulk(db, { hostId, contactIds, source }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (ids.length === 0) return { ok: true, changed: 0 }
  const { data, error } = await db
    .from('host_contacts')
    .update({
      marketing_consent: true,
      marketing_consented_at: new Date().toISOString(),
      marketing_consent_source: source,
    })
    .eq('host_id', hostId)
    .in('contact_id', ids)
    .eq('marketing_consent', false)
    .select('contact_id')
  if (error) return { ok: false, changed: 0, error: error.message }
  const flipped = (data || []).map((r) => r.contact_id)
  await insertLog(db, flipped.map((contactId) => logRow({ contactId, hostId, action: 'opt_in', source, ipAddress: null })))
  return { ok: true, changed: flipped.length }
}

/**
 * @param {{hostId:string, contactId:string, source:'host_unsubscribe_page'|'host_one_click_unsubscribe'|'postmark_one_click_unsubscribe'|'postmark_spam_complaint', ipAddress?:string|null}} args
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string}>}
 */
export async function revokeHostConsent(db, { hostId, contactId, source, ipAddress = null }) {
  const { data, error } = await db
    .from('host_email_suppressions')
    .upsert({ host_id: hostId, contact_id: contactId }, { onConflict: 'host_id,contact_id', ignoreDuplicates: true })
    .select('id')
  if (error) return { ok: false, changed: false, error: error.message }
  // ignoreDuplicates returns zero rows when the pair already existed.
  const changed = (data || []).length > 0
  if (changed) await insertLog(db, [logRow({ contactId, hostId, action: 'opt_out', source, ipAddress })])
  return { ok: true, changed }
}

/**
 * Re-signup by a previously unsubscribed contact.
 * @returns {Promise<{ok:boolean, unsuppressed:boolean, changed:boolean, error?:string}>}
 */
export async function resubscribeHost(db, { hostId, contactId, ipAddress = null }) {
  const { data, error } = await db
    .from('host_email_suppressions')
    .delete()
    .eq('host_id', hostId)
    .eq('contact_id', contactId)
    .select('id')
  if (error) return { ok: false, unsuppressed: false, changed: false, error: error.message }
  const unsuppressed = (data || []).length > 0
  const grant = await grantHostConsent(db, { hostId, contactId, source: 'host_resubscribe', ipAddress })
  if (!grant.ok) return { ok: false, unsuppressed, changed: false, error: grant.error }
  return { ok: true, unsuppressed, changed: grant.changed }
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/host-consent.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-consent.js src/lib/host-consent.test.js
git commit -m "HOST-CONSENT.1 — host-consent.js: grant / bulk grant / revoke / resubscribe"
```

---

### Task 5: Attendee sync grants host consent from the registration checkbox

**Files:**
- Modify: `src/lib/host-contact-list.js:150-183` (`addEventAttendeesToHostList`)
- Test: `src/lib/host-contact-list.test.js` (`describe('addEventAttendeesToHostList'`)

- [ ] **Step 1: Write the failing test**

The existing fake for these tests is `fakeListDb(...)` at `src/lib/host-contact-list.test.js:93`; it routes `race_registrations` rows with `teams.team_members`. Extend its registration fixture so each row also carries `contact_id` and `marketing_consent`, and add:

```js
  it('HOST-CONSENT.1 — grants host consent to registrants who ticked the box, not to their team-mates', async () => {
    const { db, statements } = fakeSyncDb({
      race: { id: 'r1', host_id: 'h1', slug: 'run', name: 'Run' },
      registrations: [
        { id: 'reg-1', contact_id: 'cap-1', marketing_consent: true,  teams: { team_members: [{ contact_id: 'cap-1' }, { contact_id: 'mate-1' }] } },
        { id: 'reg-2', contact_id: 'cap-2', marketing_consent: false, teams: { team_members: [{ contact_id: 'cap-2' }] } },
        { id: 'reg-3', contact_id: 'cap-3', marketing_consent: null,  teams: { team_members: [{ contact_id: 'cap-3' }] } },
      ],
    })
    await addEventAttendeesToHostList(db, 'r1')
    // membership for all four
    const upsert = statements.find((s) => s.table === 'host_contacts' && op(s, 'upsert'))
    expect(op(upsert, 'upsert').args[0].map((r) => r.contact_id).sort()).toEqual(['cap-1', 'cap-2', 'cap-3', 'mate-1'])
    // consent for cap-1 only (pre-588 NULL rows and unticked boxes grant nothing)
    const grant = statements.find((s) => s.table === 'host_contacts' && op(s, 'update'))
    expect(op(grant, 'in').args).toEqual(['contact_id', ['cap-1']])
    expect(op(grant, 'update').args[0]).toMatchObject({ marketing_consent: true, marketing_consent_source: 'event_form' })
  })
```

If `fakeListDb` cannot record an `update` statement on `host_contacts` (it may only model `select`/`upsert`), write this one test against the `makeDb(route)` recorder from Task 4 (copy it into the file as `fakeSyncDb`) routing `race_events` → `race`, `race_registrations` → `registrations`, `event_hosts` → `{ data: { id: 'h1', slug: 'run', name: 'Run' } }`, `contacts` → `{ data: { tags: [] } }`, everything else `{ data: [], error: null }`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/host-contact-list.test.js -t "HOST-CONSENT.1 — grants"`
Expected: FAIL (no update statement on host_contacts).

- [ ] **Step 3: Implement**

In `addEventAttendeesToHostList`, change the registrations select and collect consenting registrants:

```js
  const contactIds = new Set()
  const consentingIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select('id, contact_id, marketing_consent, teams:team_id ( team_members ( contact_id ) )')
      .eq('race_event_id', raceEventId)
      .eq('status', 'confirmed')
      .order('registered_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`host contact list: registrations query failed: ${error.message}`)
    for (const reg of data || []) {
      const members = Array.isArray(reg?.teams?.team_members) ? reg.teams.team_members : []
      for (const m of members) {
        if (m?.contact_id) contactIds.add(m.contact_id)
      }
      // HOST-CONSENT.1 — only the registrant of record saw the checkbox.
      // Team-mates get membership (utility mail) but no marketing consent.
      // NULL = pre-588 registration: grants nothing (the backfill covered
      // those memberships once; anything later must come from a real tick).
      if (reg?.contact_id && reg.marketing_consent === true) consentingIds.add(reg.contact_id)
    }
    if (!data || data.length < PAGE) break
  }
```

After the upsert loop (after line 183), before the tagging block:

```js
  // HOST-CONSENT.1 — grant host consent to the registrants who ticked the
  // box. Best-effort like tagging: membership is already durable.
  const consenting = [...consentingIds]
  for (let i = 0; i < consenting.length; i += UPSERT_CHUNK) {
    const r = await grantHostConsentBulk(db, { hostId: race.host_id, contactIds: consenting.slice(i, i + UPSERT_CHUNK), source: 'event_form' })
    if (!r.ok) logWarn('host-contact-list', 'host consent grant failed', { race_event_id: raceEventId, error: r.error })
  }
```

Add the import at the top: `import { grantHostConsentBulk } from '@/lib/host-consent'`.

In the test file add `vi.mock('@/lib/host-consent', ...)`? No — let the real module run against the recorder so the test above can see the update statement. Ensure `vi.mock('@/lib/log', ...)` already stubs `logWarn` (it does, line 19).

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/host-contact-list.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-contact-list.js src/lib/host-contact-list.test.js
git commit -m "HOST-CONSENT.1 — attendee sync grants host consent from race_registrations.marketing_consent"
```

---

### Task 6: Register route persists the checkbox

**Files:**
- Modify: `src/app/api/public/events/[slug]/register/route.js:233-236` and `:625-636`

- [ ] **Step 1: Edit both inserts**

Free/lead path (line 233):

```js
    const { data: reg, error: regErr } = await db.from('race_registrations').insert({
      race_event_id: race.id, team_id: teamId, contact_id: contactId,
      status: 'confirmed', wave_id: null, team_composition: 'all_non_members',
      // HOST-CONSENT.1 — persisted so the attendee sync can grant HOST consent.
      marketing_consent: body.marketing_consent !== false,
    }).select('id, registered_at').single()
```

Paid path (line 625):

```js
    .insert({
      race_event_id: race.id,
      team_id: teamId,
      contact_id: captainContactId,
      status: initialStatus,
      wave_id: wave.id,
      team_composition: pricing.team_composition,
      promo_code_id: appliedPromo?.id || null,
      promo_discount_cents: appliedPromo ? promoDiscountCents : null,
      // HOST-CONSENT.1 — persisted so the attendee sync can grant HOST consent
      // when the registration confirms (immediately for free, on payment for paid).
      marketing_consent: body.marketing_consent !== false,
    })
```

- [ ] **Step 2: Run the route's existing tests and lint**

Run: `npx vitest run 'src/app/api/public/events' && npx eslint 'src/app/api/public/events/[slug]/register/route.js'`
Expected: PASS, no lint errors.

- [ ] **Step 3: Commit**

```bash
git add 'src/app/api/public/events/[slug]/register/route.js'
git commit -m "HOST-CONSENT.1 — register route persists marketing_consent on the registration row"
```

---

### Task 7: Signup route grants host consent and handles resubscribe

**Files:**
- Modify: `src/app/api/public/host-list/[slug]/subscribe/route.js:63-123`
- Test: `src/app/api/public/host-list/[slug]/subscribe/route.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// HOST-CONSENT.1 — a signup grants BOTH consents (UN1T as before, host new),
// and a re-signup by a host-unsubscribed contact lifts the host suppression.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '1.2.3.4',
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/host-events', () => ({ resolveMasterLocationId: vi.fn().mockResolvedValue('loc-master'), ensureAnchorLocation: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn().mockResolvedValue('c-1') }))
vi.mock('@/lib/host-contact-list', () => ({ hostTagFor: () => 'host:pride' }))
vi.mock('@/lib/validate', async (importOriginal) => await importOriginal())
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTag: vi.fn() }))
vi.mock('@/lib/host-consent', () => ({
  grantHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }),
  resubscribeHost: vi.fn().mockResolvedValue({ ok: true, unsuppressed: true, changed: true }),
}))
vi.mock('@/lib/postmark-suppressions', () => ({ unsuppressAtPostmark: vi.fn().mockResolvedValue({ ok: 1, failed: [], skipped: [] }) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { applyFormMarketingConsent } from '@/lib/marketing-consent'
import { grantHostConsent, resubscribeHost } from '@/lib/host-consent'
import { unsuppressAtPostmark } from '@/lib/postmark-suppressions'

const HOST = { id: 'h-1', name: 'Pride Training Club', slug: 'pride', organization_id: 'org-1', anchor_location_id: 'loc-a', postmark_stream_id: 'colm-events' }

function stubDb({ suppressed = false } = {}) {
  return {
    from: (table) => {
      const chain = {
        select: () => chain, eq: () => chain, upsert: () => chain, update: () => chain,
        maybeSingle: async () => {
          if (table === 'event_hosts') return { data: HOST, error: null }
          if (table === 'host_email_suppressions') return { data: suppressed ? { id: 's-1' } : null, error: null }
          if (table === 'contacts') return { data: { tags: [] }, error: null }
          return { data: null, error: null }
        },
        then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
      }
      return chain
    },
  }
}

function req() {
  return new Request('http://localhost/api/public/host-list/pride/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Pat Doe', email: 'Pat@Example.com' }),
  })
}
const props = { params: Promise.resolve({ slug: 'pride' }) }

beforeEach(() => vi.clearAllMocks())

describe('POST /api/public/host-list/[slug]/subscribe — HOST-CONSENT.1', () => {
  it('grants UN1T consent (unchanged) AND host consent from the mailing-list form', async () => {
    createServerClient.mockReturnValue(stubDb())
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(applyFormMarketingConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c-1', consent: true, source: 'host_mailing_list' }))
    expect(grantHostConsent).toHaveBeenCalledWith(expect.anything(), { hostId: 'h-1', contactId: 'c-1', source: 'mailing_list_form', ipAddress: '1.2.3.4' })
    expect(resubscribeHost).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('a host-unsubscribed contact who signs up again is resubscribed and lifted on the HOST stream', async () => {
    createServerClient.mockReturnValue(stubDb({ suppressed: true }))
    await POST(req(), props)
    expect(resubscribeHost).toHaveBeenCalledWith(expect.anything(), { hostId: 'h-1', contactId: 'c-1', ipAddress: '1.2.3.4' })
    expect(grantHostConsent).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).toHaveBeenCalledWith('pat@example.com', { stream: 'colm-events' })
  })
})
```

The mock specifiers above match the route's imports (`@/lib/race-contact-linking`, `@/lib/host-events`, `@/lib/host-contact-list`, `@/lib/contact-tags`, `@/lib/marketing-consent`). `@/lib/validate` runs for real so the zod body validation is exercised.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/api/public/host-list/[slug]/subscribe/route.test.js'`
Expected: FAIL — `grantHostConsent` never called.

- [ ] **Step 3: Implement**

Add imports:

```js
import { grantHostConsent, resubscribeHost } from '@/lib/host-consent'
import { unsuppressAtPostmark } from '@/lib/postmark-suppressions'
```

Change the host select (line 65) to include the stream: `.select('id, name, slug, organization_id, anchor_location_id, postmark_stream_id')`.

Replace the membership block (lines 114-123) with:

```js
    // List membership — insert-once (re-subscribing is a no-op).
    const { error: memberErr } = await db
      .from('host_contacts')
      .upsert(
        { host_id: host.id, contact_id: contactId, source: 'mailing_list' },
        { onConflict: 'host_id,contact_id', ignoreDuplicates: true },
      )
    if (memberErr) {
      logError('host-list-subscribe', 'host_contacts upsert failed', { err: memberErr })
    } else {
      // HOST-CONSENT.1 — the HOST consent, independent of the UN1T one above.
      // A contact who previously unsubscribed from THIS host and signs up
      // again is resubscribing: drop the suppression, grant, and lift only
      // our own ManualSuppression on the host's Postmark stream (never a
      // bounce or complaint — unsuppressAtPostmark reads the reason first).
      const { data: existingSup, error: supErr } = await db
        .from('host_email_suppressions')
        .select('id')
        .eq('host_id', host.id)
        .eq('contact_id', contactId)
        .maybeSingle()
      if (supErr) logWarn('host-list-subscribe', 'suppression lookup failed', { err: supErr })
      const consentResult = existingSup
        ? await resubscribeHost(db, { hostId: host.id, contactId, ipAddress: ip })
        : await grantHostConsent(db, { hostId: host.id, contactId, source: 'mailing_list_form', ipAddress: ip })
      if (!consentResult.ok) {
        logError('host-list-subscribe', 'host consent write failed', { err: consentResult.error, host_id: host.id })
      }
      if (existingSup && host.postmark_stream_id) {
        try {
          const lift = await unsuppressAtPostmark(email, { stream: host.postmark_stream_id })
          if (lift?.failed?.length) logWarn('host-list-subscribe', 'Postmark host-stream lift failed', { message: lift.failed[0]?.message })
        } catch (e) {
          logWarn('host-list-subscribe', 'Postmark host-stream lift threw', { err: e?.message || String(e) })
        }
      }
    }
```

Update the file header comment (lines 13-18) to describe both consents.

- [ ] **Step 4: Run**

Run: `npx vitest run 'src/app/api/public/host-list/[slug]/subscribe/route.test.js'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/public/host-list/[slug]/subscribe/route.js' 'src/app/api/public/host-list/[slug]/subscribe/route.test.js'
git commit -m "HOST-CONSENT.1 — signup grants host consent; re-signup resubscribes and lifts the host-stream suppression"
```

---

### Task 8: Host unsubscribe page + one-click POST route

**Files:**
- Modify: `src/app/unsubscribe/host/[token]/page.js:57-76`
- Create: `src/app/api/unsubscribe/host/[token]/route.js`
- Test: `src/app/api/unsubscribe/host/[token]/route.test.js`
- Modify: `scripts/check-route-guards.mjs` (EXEMPT map, after the `/api/unsubscribe/[token]` entry), `src/lib/openapi.js` (after the `/api/unsubscribe/{token}` registration at line 284)

- [ ] **Step 1: Write the failing route test**

```js
// HOST-CONSENT.1 — the RFC 8058 one-click target for host emails.
// toListUnsubscribeUrl rewrites /unsubscribe/host/<t> → /api/unsubscribe/host/<t>,
// which 404'd until this route existed: Gmail's POST was silently lost.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-unsubscribe', () => ({ verifyHostUnsubToken: vi.fn() }))
vi.mock('@/lib/host-consent', () => ({ revokeHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }) }))
vi.mock('@/lib/postmark-suppressions', () => ({ suppressAtPostmark: vi.fn().mockResolvedValue({ ok: 1, failed: [] }) }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '5.5.5.5',
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitResponse: vi.fn(() => new Response('rl', { status: 429 })),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyHostUnsubToken } from '@/lib/host-unsubscribe'
import { revokeHostConsent } from '@/lib/host-consent'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
import { checkRateLimit } from '@/lib/rate-limit'

function stubDb({ host = { id: 'h-1', postmark_stream_id: 'colm-events' }, contact = { email: 'pat@x.ie' } } = {}) {
  return {
    from: (table) => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === 'event_hosts' ? host : table === 'contacts' ? contact : null, error: null }),
      }
      return chain
    },
  }
}
const req = () => new Request('http://localhost/api/unsubscribe/host/tok', { method: 'POST' })
const props = { params: Promise.resolve({ token: 'tok' }) }

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true })
})

describe('POST /api/unsubscribe/host/[token]', () => {
  it('revokes host consent, pushes the host-stream suppression, answers 200 with no body required', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    createServerClient.mockReturnValue(stubDb())
    const res = await POST(req(), props)
    expect(res.status).toBe(200)
    expect(revokeHostConsent).toHaveBeenCalledWith(expect.anything(), { hostId: 'h-1', contactId: 'c-1', source: 'host_one_click_unsubscribe', ipAddress: '5.5.5.5' })
    expect(suppressAtPostmark).toHaveBeenCalledWith('pat@x.ie', { stream: 'colm-events' })
  })
  it('skips the Postmark push when the host has no stream yet', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    createServerClient.mockReturnValue(stubDb({ host: { id: 'h-1', postmark_stream_id: null } }))
    expect((await POST(req(), props)).status).toBe(200)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })
  it('404s an invalid token without touching the database', async () => {
    verifyHostUnsubToken.mockReturnValue(null)
    createServerClient.mockReturnValue(stubDb())
    expect((await POST(req(), props)).status).toBe(404)
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it('429s when the per-IP invalid-token budget is spent', async () => {
    verifyHostUnsubToken.mockReturnValue(null)
    checkRateLimit.mockResolvedValue({ allowed: false })
    createServerClient.mockReturnValue(stubDb())
    expect((await POST(req(), props)).status).toBe(429)
  })
  it('a repeat click is a 200 no-op', async () => {
    verifyHostUnsubToken.mockReturnValue({ hostId: 'h-1', contactId: 'c-1' })
    revokeHostConsent.mockResolvedValueOnce({ ok: true, changed: false })
    createServerClient.mockReturnValue(stubDb())
    expect((await POST(req(), props)).status).toBe(200)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/api/unsubscribe/host/[token]/route.test.js'`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the route**

```js
// POST /api/unsubscribe/host/[token] — HOST-CONSENT.1, the RFC 8058
// one-click target for host marketing email.
//
// sendEmail's List-Unsubscribe header points at toListUnsubscribeUrl(pageUrl),
// which rewrites /unsubscribe/host/<t> → /api/unsubscribe/host/<t>. Until this
// route existed that path 404'd, so a Gmail/Yahoo one-click on a host email
// was silently lost (the page-visit path still worked).
//
// The HMAC token is the capability (host-unsubscribe.js). Same posture as the
// CRM one-click route: a POST arrives from the MAIL PROVIDER, often from a
// shared proxy pool, so the only limiter is a per-IP budget on INVALID tokens
// (probing) — a valid token is never rate-limited. Body is ignored; the
// suppression is per host by design and never touches UN1T consent.
//
// Public by design → registered in scripts/check-route-guards.mjs EXEMPT and
// src/proxy.js already allowlists the '/api/unsubscribe/' prefix.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyHostUnsubToken } from '@/lib/host-unsubscribe'
import { revokeHostConsent } from '@/lib/host-consent'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
import { getClientIp, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INVALID_TOKEN_BUDGET = { max: 30, windowMs: 15 * 60_000 }

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()
  const ip = getClientIp(request)

  let ids = null
  try {
    ids = verifyHostUnsubToken(params.token)
  } catch (e) {
    logError('host-unsubscribe', 'token verification threw', { err: e })
  }
  if (!ids) {
    const limit = await checkRateLimit(db, `host-unsub-invalid:${ip}`, INVALID_TOKEN_BUDGET)
    if (!limit.allowed) return rateLimitResponse(limit)
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  const { data: host } = await db
    .from('event_hosts')
    .select('id, postmark_stream_id')
    .eq('id', ids.hostId)
    .maybeSingle()
  if (!host) return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })

  const result = await revokeHostConsent(db, {
    hostId: host.id, contactId: ids.contactId, source: 'host_one_click_unsubscribe', ipAddress: ip,
  })
  if (!result.ok) {
    // The person pressed the button; do not report success on a failed write.
    logError('host-unsubscribe', 'one-click revoke failed', { err: result.error, host_id: host.id })
    return NextResponse.json({ success: false, error: 'Could not unsubscribe, please try again.' }, { status: 500 })
  }

  // Second, independent refusal at Postmark on the HOST's stream — best-effort.
  if (host.postmark_stream_id) {
    try {
      const { data: contact } = await db.from('contacts').select('email').eq('id', ids.contactId).maybeSingle()
      if (contact?.email) {
        const push = await suppressAtPostmark(contact.email, { stream: host.postmark_stream_id })
        if (push?.failed?.length) logWarn('host-unsubscribe', 'Postmark host-stream suppress failed', { message: push.failed[0]?.message })
      }
    } catch (e) {
      logWarn('host-unsubscribe', 'Postmark host-stream suppress threw', { err: e?.message || String(e) })
    }
  }

  return NextResponse.json({ success: true, data: { changed: result.changed } })
}
```

- [ ] **Step 4: Update the page to use the same write**

In `src/app/unsubscribe/host/[token]/page.js` replace lines 57-76 with:

```js
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, postmark_stream_id')
    .eq('id', ids.hostId)
    .maybeSingle()
  if (!host) return <InvalidLink />

  // HOST-CONSENT.1 — the ONE writer of a host opt-out. Per-host by design:
  // UN1T marketing preferences and other hosts' lists are untouched.
  const result = await revokeHostConsent(db, {
    hostId: host.id, contactId: ids.contactId, source: 'host_unsubscribe_page',
  })
  if (!result.ok) {
    // FK failure (deleted contact) or transient DB error — either way the
    // suppression wasn't recorded, so don't claim it was.
    logError('host-unsubscribe', 'suppression write failed', { err: result.error })
    return <InvalidLink />
  }

  // Second refusal at Postmark on the host's own stream — best-effort.
  if (host.postmark_stream_id) {
    try {
      const { data: contact } = await db.from('contacts').select('email').eq('id', ids.contactId).maybeSingle()
      if (contact?.email) await suppressAtPostmark(contact.email, { stream: host.postmark_stream_id })
    } catch (e) {
      logError('host-unsubscribe', 'Postmark host-stream suppress threw', { err: e?.message || String(e) })
    }
  }
```

Add imports `import { revokeHostConsent } from '@/lib/host-consent'` and `import { suppressAtPostmark } from '@/lib/postmark-suppressions'`.

- [ ] **Step 5: Register the route**

`scripts/check-route-guards.mjs`, inside `EXEMPT` after the `/api/unsubscribe/[token]` line:

```js
  'src/app/api/unsubscribe/host/[token]/route.js':
    'Capability-token URL (HMAC per-host, per-contact token, host-unsubscribe.js) + per-IP budget on invalid tokens — public by design, RFC 8058 one-click target for host emails (HOST-CONSENT.1).',
```

`src/lib/openapi.js`, after the block ending at line 299:

```js
registry.registerPath({
  method: 'post',
  path: '/api/unsubscribe/host/{token}',
  tags: ['Public'],
  summary: 'One-click unsubscribe from a host\'s marketing list (RFC 8058)',
  description: 'Anonymous. `token` is the HMAC host-unsubscribe token from a host campaign footer (pins host + contact). Writes a per-host suppression only — UN1T marketing consent is untouched (HOST-CONSENT.1). Body ignored. A repeat click is a 200 no-op. Invalid tokens spend a per-IP budget.',
  request: { params: z.object({ token: z.string().min(1) }) },
  responses: {
    200: { description: 'Unsubscribed from the host (or already unsubscribed)' },
    404: { description: 'Invalid token', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 6: Run**

Run: `npx vitest run 'src/app/api/unsubscribe/host/[token]/route.test.js' && npm run check:route-guards && npx vitest run src/lib/openapi.test.js`
Expected: PASS, route guards clean (if there is no `openapi.test.js`, skip that part).

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/unsubscribe/host/[token]/route.js' 'src/app/api/unsubscribe/host/[token]/route.test.js' 'src/app/unsubscribe/host/[token]/page.js' scripts/check-route-guards.mjs src/lib/openapi.js
git commit -m "HOST-CONSENT.1 — one-click POST route for host unsubscribes; page + route share revokeHostConsent and push the host-stream suppression"
```

---

### Task 9: Queue sends on the host's stream with one-click headers and host-consent re-check

**Files:**
- Modify: `src/lib/host-campaign-queue.js:84-104, 139-163, 189-201`
- Test: `src/lib/host-campaign-queue.test.js`

- [ ] **Step 1: Write the failing tests**

Update the `HOST` fixture (line ~68) to include `postmark_stream_id: 'colm-events'`, and extend `routeFor` so `host_contacts` answers consent:

```js
    if (state.table === 'host_contacts') return { data: cfg.hostContacts ?? [], error: cfg.hostContactsErr ?? null }
```

Add a describe block:

```js
describe('processHostCampaignChunk — HOST-CONSENT.1', () => {
  const claimedRows = [{ id: 's1', contact_id: 'c1', email: 'a@x.ie' }]
  const base = {
    candidates: [{ id: 's1' }], claimed: claimedRows,
    contacts: [emailableContact('c1', 'a@x.ie')],
    hostContacts: [{ contact_id: 'c1', marketing_consent: true }],
  }

  it('sends marketing on the HOST stream (postmarkStream) with the internal broadcast stream and the unsubscribe URL', async () => {
    const { db } = makeDb(routeFor(base))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const call = sendEmail.mock.calls[0][0]
    expect(call.stream).toBe('broadcast')
    expect(call.postmarkStream).toBe('colm-events')
    expect(call.unsubscribeUrl).toBe('https://crm.test/unsubscribe/host/tok')
    expect(call.metadata).toMatchObject({ host_campaign_id: CAMPAIGN_ID, host_id: HOST_ID, contact_id: 'c1' })
  })

  it('utility stays on outbound with no postmarkStream', async () => {
    const { db } = makeDb(routeFor({ ...base, campaign: { ...CAMPAIGN, email_type: 'utility' }, contacts: [{ ...emailableContact('c1', 'a@x.ie'), email_administrative: true }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    const call = sendEmail.mock.calls[0][0]
    expect(call.stream).toBe('outbound')
    expect(call.postmarkStream).toBeUndefined()
  })

  it('halts a marketing campaign when the host has no stream (nothing sent, nothing finalised)', async () => {
    const { db } = makeDb(routeFor({ ...base, host: { ...HOST, postmark_stream_id: null } }))
    const r = await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(r).toEqual({ status: 'halted', sent: 0, failed: 0 })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('marks a claimed row failed when host consent is false, even with UN1T consent true', async () => {
    const { db, statements } = makeDb(routeFor({ ...base, hostContacts: [{ contact_id: 'c1', marketing_consent: false }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).not.toHaveBeenCalled()
    const failed = statements.find((s) => s.table === 'host_campaign_sends' && op(s, 'update')?.args[0]?.status === 'failed')
    expect(failed).toBeTruthy()
  })

  it('sends to a contact opted OUT of UN1T marketing but consented to the host', async () => {
    const { db } = makeDb(routeFor({ ...base, contacts: [{ ...emailableContact('c1', 'a@x.ie'), email_marketing: false }] }))
    await processHostCampaignChunk(db, CAMPAIGN_ID)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })
})
```

Existing tests that assert a send with the old fixture need `hostContacts` in their cfg (add `hostContacts: [{ contact_id: <id>, marketing_consent: true }]` for each contact they send to). A `describe` there that asserts "revoked consent → failed" using `email_marketing: false` changes to `marketing_consent: false`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/host-campaign-queue.test.js`
Expected: the new block FAILS (`postmarkStream` undefined, no halt).

- [ ] **Step 3: Implement**

Host select (line 86): `.select('id, name, email, sender_email, sender_name, sender_domain_verified, reply_to_email, postmark_stream_id')`.

After the kill switch (line 104):

```js
  // HOST-CONSENT.1 — marketing rides the host's OWN Postmark stream. No
  // stream = not set up; halt exactly like the kill switch (resumes on the
  // next sweep once an admin fills postmark_stream_id). Utility is unaffected.
  const isMarketing = campaign.email_type !== 'utility'
  if (isMarketing && !host.postmark_stream_id) {
    logError('host-campaigns', 'host has no postmark_stream_id — marketing campaign paused', {
      campaign_id: campaign.id, host_id: host.id,
    })
    return { status: 'halted', sent: 0, failed: 0 }
  }
```

Consent re-check (replace lines 139-159):

```js
    const contactIds = claimed.map((r) => r.contact_id)
    const { data: contactRows, error: contactErr } = await db
      .from('contacts')
      .select('id, email, first_name, last_name, name, email_administrative, email_status, email_suppressed_at')
      .in('id', contactIds)
    if (contactErr) throw new Error(`consent re-check failed: ${contactErr.message}`)
    const { data: suppRows, error: suppErr } = await db
      .from('host_email_suppressions')
      .select('contact_id')
      .eq('host_id', campaign.host_id)
      .in('contact_id', contactIds)
    if (suppErr) throw new Error(`suppression re-check failed: ${suppErr.message}`)
    // HOST-CONSENT.1 — the host's consent, off the membership row.
    const { data: memberRows, error: memberErr } = await db
      .from('host_contacts')
      .select('contact_id, marketing_consent')
      .eq('host_id', campaign.host_id)
      .in('contact_id', contactIds)
    if (memberErr) throw new Error(`host consent re-check failed: ${memberErr.message}`)
    const contactById = new Map((contactRows || []).map((c) => [c.id, c]))
    const suppressedIds = new Set((suppRows || []).map((r) => r.contact_id))
    const consentById = new Map((memberRows || []).map((m) => [m.contact_id, m.marketing_consent === true]))
    const sendable = []
    const revokedIds = []
    for (const row of claimed) {
      const ok = isEmailable(contactById.get(row.contact_id) || null, suppressedIds.has(row.contact_id), {
        emailType: isMarketing ? 'marketing' : 'utility',
        hostConsent: consentById.get(row.contact_id) === true,
      })
      if (ok) sendable.push(row)
      else revokedIds.push(row.id)
    }
```

Send call (lines 190-201):

```js
        await sendEmail({
          to: row.email,
          from,
          replyTo: host.reply_to_email || host.email || undefined,
          subject: mergedSubject,
          htmlBody,
          // HOST-CONSENT.1 — utility rides the transactional stream. Marketing
          // keeps the INTERNAL 'broadcast' vocabulary (tracking on, one-click
          // headers attached) while the wire MessageStream is the host's own
          // stream, so Postmark's UN1T suppression list can never refuse it.
          stream: isMarketing ? 'broadcast' : 'outbound',
          postmarkStream: isMarketing ? host.postmark_stream_id : undefined,
          // The same URL the footer carries → List-Unsubscribe / One-Click.
          // Real sends omitted this until HOST-CONSENT.1 (only the test send had it).
          unsubscribeUrl: isMarketing ? unsubscribeUrl : undefined,
          tag: 'host-campaign',
          metadata: { host_campaign_id: campaign.id, host_id: host.id, contact_id: row.contact_id },
        })
```

Update the file's header comment where it describes the consent re-check.

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/host-campaign-queue.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-campaign-queue.js src/lib/host-campaign-queue.test.js
git commit -m "HOST-CONSENT.1 — queue sends on the host's Postmark stream with one-click headers; re-checks host consent per claimed row"
```

---

### Task 10: Send route fails closed without a stream

**Files:**
- Modify: `src/app/api/host/emails/[id]/send/route.js:51-62`
- Test: `src/app/api/host/emails/[id]/send/route.test.js`

- [ ] **Step 1: Write the failing test**

Add `postmark_stream_id: 'colm-events'` to `HOST_ROW`, and:

```js
describe('POST /api/host/emails/[id]/send — HOST-CONSENT.1 stream gate', () => {
  it('409s a marketing send when the host has no postmark_stream_id and publishes nothing', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not set up/i)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })
  it('lets a UTILITY send through without a stream', async () => {
    const { db } = makeDb(routeFor({ host: { ...HOST_ROW, postmark_stream_id: null }, campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'utility' } }))
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest(), props)
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run 'src/app/api/host/emails/[id]/send/route.test.js' -t "stream gate"`
Expected: first test FAILS (200 instead of 409).

- [ ] **Step 3: Implement**

Host select (line 53): `.select('id, sender_domain_verified, sender_email, sender_name, email_daily_send_cap, postmark_stream_id')`.

After the sender check (line 62):

```js
  // HOST-CONSENT.1 — marketing needs the host's own Postmark stream.
  if (campaign.email_type !== 'utility' && !host.postmark_stream_id) {
    return NextResponse.json(
      { success: false, error: 'Marketing sending is not set up for this host yet — ask UN1T to attach your Postmark stream.' },
      { status: 409 },
    )
  }
```

Add "2b. postmark_stream_id for marketing → 409" to the header comment's gate list.

- [ ] **Step 4: Run**

Run: `npx vitest run 'src/app/api/host/emails/[id]/send/route.test.js'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/host/emails/[id]/send/route.js' 'src/app/api/host/emails/[id]/send/route.test.js'
git commit -m "HOST-CONSENT.1 — send route 409s a marketing send when the host has no Postmark stream"
```

---

### Task 11: Webhook processor routes host-stream events to host tables

**Files:**
- Create: `src/lib/host-campaign-webhooks.js`
- Test: `src/lib/host-campaign-webhooks.test.js`
- Modify: `src/lib/postmark-webhook-processor.js` (after the BCA block, before `recordTicketMessageDelivery` at line 199)
- Test: `src/lib/postmark-webhook-processor.test.js`

- [ ] **Step 1: Write the failing module tests**

```js
// HOST-CONSENT.1 — host-stream Postmark events land on HOST tables and never
// on contacts.email_marketing. Identified by Metadata.host_campaign_id (every
// host send stamps it), not by stream name — streams are per host.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./host-consent.js', () => ({ revokeHostConsent: vi.fn().mockResolvedValue({ ok: true, changed: true }) }))

import { isHostCampaignEvent, processHostCampaignEvent } from './host-campaign-webhooks.js'
import { revokeHostConsent } from './host-consent.js'

const META = { host_campaign_id: 'hc-1', host_id: 'h-1', contact_id: 'c-1' }

function stubDb() {
  const contactUpdates = []
  return {
    contactUpdates,
    from: (table) => {
      const filters = []
      const chain = {
        update: (values) => { chain._values = values; return chain },
        eq: (c, v) => { filters.push([c, v]); return chain },
        in: (c, v) => { filters.push(['in', c, v]); return chain },
        then: (resolve, reject) => {
          if (table === 'contacts') contactUpdates.push({ values: chain._values, filters })
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
      }
      return chain
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('isHostCampaignEvent', () => {
  it('true when Metadata.host_campaign_id is present', () => {
    expect(isHostCampaignEvent({ Metadata: META })).toBe(true)
  })
  it('false otherwise (CRM sends, ops mail, no metadata)', () => {
    expect(isHostCampaignEvent({ Metadata: { crm_send: '1' } })).toBe(false)
    expect(isHostCampaignEvent({})).toBe(false)
    expect(isHostCampaignEvent(null)).toBe(false)
  })
})

describe('processHostCampaignEvent', () => {
  it('HardBounce marks the contact bounced (shared mailbox fact) and nothing else', async () => {
    const db = stubDb()
    const r = await processHostCampaignEvent(db, { RecordType: 'Bounce', Type: 'HardBounce', MessageID: 'm', Metadata: META })
    expect(r).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([{ values: { email_status: 'bounced' }, filters: [['id', 'c-1']] }])
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it('SoftBounce writes nothing', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'Bounce', Type: 'SoftBounce', MessageID: 'm', Metadata: META })
    expect(db.contactUpdates).toEqual([])
  })
  it('SpamComplaint marks complained AND revokes host consent', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SpamComplaint', MessageID: 'm', Metadata: META })
    expect(db.contactUpdates[0].values).toEqual({ email_status: 'complained' })
    expect(revokeHostConsent).toHaveBeenCalledWith(db, { hostId: 'h-1', contactId: 'c-1', source: 'postmark_spam_complaint' })
  })
  it('SubscriptionChange SuppressSending=true revokes host consent only', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SubscriptionChange', SuppressSending: true, MessageID: 'm', Metadata: META })
    expect(revokeHostConsent).toHaveBeenCalledWith(db, { hostId: 'h-1', contactId: 'c-1', source: 'postmark_one_click_unsubscribe' })
    expect(db.contactUpdates).toEqual([])
  })
  it('SubscriptionChange SuppressSending=false (reactivation) is a no-op', async () => {
    const db = stubDb()
    await processHostCampaignEvent(db, { RecordType: 'SubscriptionChange', SuppressSending: false, MessageID: 'm', Metadata: META })
    expect(revokeHostConsent).not.toHaveBeenCalled()
  })
  it.each(['Delivery', 'Open', 'Click'])('%s is acknowledged and parked for HOST-METRICS.1', async (t) => {
    const db = stubDb()
    expect(await processHostCampaignEvent(db, { RecordType: t, MessageID: 'm', Metadata: META })).toEqual({ ok: true })
    expect(db.contactUpdates).toEqual([])
  })
  it('a failed revoke is reported not-ok so the queue retries', async () => {
    revokeHostConsent.mockResolvedValueOnce({ ok: false, changed: false, error: 'db down' })
    const r = await processHostCampaignEvent(stubDb(), { RecordType: 'SubscriptionChange', SuppressSending: true, MessageID: 'm', Metadata: META })
    expect(r).toEqual({ ok: false, error: 'db down' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/host-campaign-webhooks.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

```js
// HOST-CONSENT.1 — Postmark events for HOST campaign mail.
//
// Host sends deliberately write no email_sends row (they are not CRM sends),
// so the CRM processor's lookup-by-MessageID can never resolve them and used
// to drop every one of them as "unmarked" noise. They are identified here by
// the metadata every host send stamps (host-campaign-queue.js):
//   { host_campaign_id, host_id, contact_id }
// — NOT by MessageStream, because streams are per host (event_hosts.postmark_stream_id).
//
// What lands where:
//   Bounce (hard)        contacts.email_status = 'bounced'   — a MAILBOX fact, shared
//   SpamComplaint        email_status = 'complained' + host suppression
//   SubscriptionChange   host suppression (SuppressSending) — NEVER contacts.email_marketing
//   Delivery/Open/Click  acknowledged, parked for HOST-METRICS.1
//
// Contract mirrors processPostmarkEvent: {ok:true} = processed, {ok:false,error}
// = leave the queue row unprocessed so it retries (bounded by MAX_ATTEMPTS).

import { revokeHostConsent } from './host-consent.js'

export function isHostCampaignEvent(body) {
  const id = body?.Metadata?.host_campaign_id
  return typeof id === 'string' && id.length > 0
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {object} body raw Postmark webhook JSON (isHostCampaignEvent(body) === true)
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function processHostCampaignEvent(db, body) {
  const meta = body?.Metadata || {}
  const hostId = meta.host_id
  const contactId = meta.contact_id
  if (!hostId || !contactId) {
    console.warn('[host-campaign webhooks] host event without host_id/contact_id metadata — acknowledged, nothing written', { message: body?.MessageID })
    return { ok: true }
  }

  switch (body.RecordType) {
    case 'Bounce': {
      if (body.Type !== 'HardBounce') return { ok: true }
      const { error } = await db.from('contacts').update({ email_status: 'bounced' }).eq('id', contactId)
      if (error) return { ok: false, error: error.message }
      return { ok: true }
    }
    case 'SpamComplaint': {
      const { error } = await db.from('contacts').update({ email_status: 'complained' }).eq('id', contactId)
      if (error) return { ok: false, error: error.message }
      const r = await revokeHostConsent(db, { hostId, contactId, source: 'postmark_spam_complaint' })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    }
    case 'SubscriptionChange': {
      // Reactivation (SuppressSending=false) is an operator clearing a
      // suppression at Postmark. Consent is restored only by the person, via
      // a re-signup — same rule as the CRM branch (COMMSFIX.C.7).
      if (!body.SuppressSending) return { ok: true }
      const r = await revokeHostConsent(db, { hostId, contactId, source: 'postmark_one_click_unsubscribe' })
      if (!r.ok) return { ok: false, error: r.error }
      return { ok: true }
    }
    case 'Delivery':
    case 'Open':
    case 'Click':
      // HOST-METRICS.1 lands per-send tracking here. Acknowledged so the
      // queue row is processed and the event is not logged as noise.
      return { ok: true }
    default:
      console.error(`[host-campaign webhooks] UNHANDLED record_type: ${body.RecordType} (message ${body?.MessageID}) — acknowledged`)
      return { ok: true }
  }
}
```

- [ ] **Step 4: Route from the processor and pin it**

In `src/lib/postmark-webhook-processor.js` add the import `import { isHostCampaignEvent, processHostCampaignEvent } from './host-campaign-webhooks.js'` and insert after the BCA block (after line 183, before `recordTicketMessageDelivery`):

```js
  // HOST-CONSENT.1 — host campaign mail rides per-host Postmark streams and
  // writes no email_sends row, so nothing below could ever resolve it. Route
  // by the metadata the host queue stamps and return; the CRM switch is for
  // CRM sends only.
  if (isHostCampaignEvent(body)) {
    return processHostCampaignEvent(db, body)
  }
```

Add to `src/lib/postmark-webhook-processor.test.js`:

```js
vi.mock('./host-campaign-webhooks.js', () => ({
  isHostCampaignEvent: vi.fn(() => false),
  processHostCampaignEvent: vi.fn(async () => ({ ok: true })),
}))
import { isHostCampaignEvent, processHostCampaignEvent } from './host-campaign-webhooks.js'

describe('processPostmarkEvent — HOST-CONSENT.1 routing', () => {
  it('hands a host campaign event to processHostCampaignEvent and never reaches the CRM branches', async () => {
    isHostCampaignEvent.mockReturnValueOnce(true)
    const rpcCalls = []
    const db = stubDb({ send: null, rpcCalls })
    const r = await processPostmarkEvent(db, { RecordType: 'SubscriptionChange', MessageID: 'pm-h', SuppressSending: true, Metadata: { host_campaign_id: 'hc-1', host_id: 'h-1', contact_id: 'c-1' } })
    expect(r).toEqual({ ok: true })
    expect(processHostCampaignEvent).toHaveBeenCalledTimes(1)
    expect(applyMarketingPreferencesBulk).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run**

Run: `npx vitest run src/lib/host-campaign-webhooks.test.js src/lib/postmark-webhook-processor.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/host-campaign-webhooks.js src/lib/host-campaign-webhooks.test.js src/lib/postmark-webhook-processor.js src/lib/postmark-webhook-processor.test.js
git commit -m "HOST-CONSENT.1 — host-stream Postmark events route to host tables (bounce fact, complaint, one-click) before the CRM switch"
```

---

### Task 12: Admin can set the host's Postmark stream

**Files:**
- Modify: `src/lib/hosts.js:7-15` (`HOST_COLS`)
- Modify: `src/app/api/hosts/[id]/route.js:30-41, 63-69`
- Modify: `src/components/settings/HostDetail.jsx:105-189` (`SenderDefaultsCard`)

- [ ] **Step 1: Server side**

`HOST_COLS` — append `, postmark_stream_id` to the last string:

```js
  'postmark_domain_id, email_daily_send_cap, reply_to_email, slug, ' +
  // HOST-CONSENT.1 — the host's own Postmark Broadcasts stream (per-host suppression list).
  'postmark_stream_id'
```

`PatchSchema` — add:

```js
  // HOST-CONSENT.1 — Postmark Broadcasts stream id, created by hand in Postmark
  // (Message Streams → Create → Broadcasts, unsubscribe handling Custom, then a
  // webhook on that stream to /api/webhooks/postmark with all six events and
  // the x-webhook-token header). Empty string clears it → sends fail closed.
  postmark_stream_id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable().optional().or(z.literal('')),
```

and in `PATCH`: `if (v.data.postmark_stream_id !== undefined) updates.postmark_stream_id = v.data.postmark_stream_id || null`.

- [ ] **Step 2: Admin UI**

In `SenderDefaultsCard`, add state `const [streamId, setStreamId] = useState(host?.postmark_stream_id || '')`, include `postmark_stream_id: streamId.trim() || null` in the PATCH body, and add a field after the Reply-to one:

```jsx
        <Field label="Postmark marketing stream">
          <input
            type="text"
            value={streamId}
            onChange={(e) => setStreamId(e.target.value)}
            maxLength={64}
            placeholder="colm-events"
            className="w-full border border-un1t-border rounded-md px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-un1t-subtle mt-1">
            The host&apos;s own Postmark Broadcasts stream ID. Create it in Postmark (Message Streams → Create → Broadcasts, unsubscribe handling Custom), add a webhook on that stream to <code>/api/webhooks/postmark</code> with all six events and the <code>x-webhook-token</code> header, then paste the ID here. Marketing sends are blocked until this is set; utility emails are unaffected.
          </p>
        </Field>
```

Update the `key` on the `<SenderDefaultsCard>` mount (line ~1054) to include `host.postmark_stream_id`.

- [ ] **Step 3: Lint and the hosts route tests**

Run: `npx vitest run 'src/app/api/hosts' src/lib/hosts.test.js && npx eslint src/components/settings/HostDetail.jsx 'src/app/api/hosts/[id]/route.js' src/lib/hosts.js`

> Execution note: at the time this step ran there were no tests under `src/app/api/hosts`, so the vitest half verified only `hosts.test.js`. The review fix commit `f6d2604a` added `src/app/api/hosts/[id]/route.test.js` (PATCH schema through the real handler, 8 cases), which is what the command exercises now.
Expected: PASS, no lint errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/hosts.js 'src/app/api/hosts/[id]/route.js' src/components/settings/HostDetail.jsx
git commit -m "HOST-CONSENT.1 — admins set event_hosts.postmark_stream_id from Settings → Hosts"
```

---

### Task 13: Two-consent copy on both forms

**Files:**
- Modify: `src/components/HostListSignup.jsx:21, 115-117`
- Modify: `src/app/h/[slug]/page.js:43-60`
- Modify: `src/app/api/public/events/[slug]/route.js:36-45, 148-160`
- Modify: `src/components/RaceSignupWidget.jsx:1017-1020`

- [ ] **Step 1: Signup page**

`HostListSignup.jsx` signature: `export default function HostListSignup({ slug, hostName, orgName, headline, blurb, buttonLabel, successMessage })` and the footer:

```jsx
      <p className="mt-6 text-center text-xs text-white/40">
        By joining you agree to receive emails from {hostName} about their events, and from {orgName || 'the studio'} about events and promotions. You can leave either list at any time.
      </p>
```

`h/[slug]/page.js` — after the host lookup, resolve the organisation name and pass it:

```js
  const { data: org } = await db
    .from('organizations')
    .select('name')
    .eq('id', host.organization_id)
    .maybeSingle()
```

(add `organization_id` to the host select) and `<HostListSignup … orgName={org?.name || null} />`.

- [ ] **Step 2: Public event payload**

In the route's select add `host:event_hosts!host_id ( name )` and `organization_id` inside the `locations:location_id ( … )` embed. After `publicLocation` is built, resolve the org name and strip the id:

```js
  const { organization_id: _orgId, ...publicLocationSafe } = publicLocation || {}
  let organizationName = null
  if (publicLocation?.organization_id) {
    const { data: org } = await db.from('organizations').select('name').eq('id', publicLocation.organization_id).maybeSingle()
    organizationName = org?.name || null
  }
```

and in the response `data`: `locations: publicLocation ? publicLocationSafe : publicLocation`, `host_name: racePublic.host?.name || null`, `organization_name: organizationName`, and drop the embedded `host` object (`const { capacity: _omit, host: _host, ...racePublic } = data`).

- [ ] **Step 3: Widget copy**

Replace the checkbox `<span>` (lines 1017-1020):

```jsx
                <span>
                  {race.host_name ? (
                    <>
                      Yes, send me emails from {race.host_name} about their events, and promotional updates from {race.organization_name || 'the studio'} via email, SMS or WhatsApp. You can leave either list at any time. Event-related notifications are sent regardless.
                    </>
                  ) : (
                    <>
                      Yes, send me UN1T promotional updates and offers via email, SMS or WhatsApp.
                      You can unsubscribe at any time. Event-related notifications are sent regardless.
                    </>
                  )}
                </span>
```

- [ ] **Step 4: Verify**

Run: `npx vitest run 'src/app/api/public/events' src/components && npx eslint src/components/HostListSignup.jsx src/components/RaceSignupWidget.jsx 'src/app/h/[slug]/page.js' 'src/app/api/public/events/[slug]/route.js'`
Expected: PASS. Then `npm run build` (new imports + a page change) — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/HostListSignup.jsx 'src/app/h/[slug]/page.js' 'src/app/api/public/events/[slug]/route.js' src/components/RaceSignupWidget.jsx
git commit -m "HOST-CONSENT.1 — both forms state the two consents; public event payload carries host_name + organization_name"
```

---

### Task 14: Changelog, CI mirror, build, PR

**Files:**
- Modify: `docs/CHANGELOG.md` (add one row under the table header)

- [ ] **Step 1: Changelog row**

Insert directly under `|---|------|-------|`:

```
| #<PR> | HOST-CONSENT.1 — host marketing is its own consent domain | mig 588. Host consent on `host_contacts` (backfilled), `consent_log.host_id`, per-host Postmark stream (`event_hosts.postmark_stream_id`, Colm = `colm-events`), `race_registrations.marketing_consent`. Gate no longer reads `contacts.email_marketing`; UN1T ↔ host opt-outs never cross. Real sends now carry List-Unsubscribe + a one-click POST route. Host-stream webhooks land on host tables. Send route 409s without a stream. Spec `docs/superpowers/specs/2026-09-06-host-consent-domain-design.md`. |
```

Fill `#<PR>` after `gh pr create` returns the number (a second commit is fine; never edit a pushed row).

- [ ] **Step 2: CI mirror + build**

Run the full mirror command from the top of this plan, then `npm run build`. Expected: all green, build exit 0. Fix anything red before pushing.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "HOST-CONSENT.1 — host marketing as its own consent domain" --body-file - <<'EOF'
Spec: docs/superpowers/specs/2026-09-06-host-consent-domain-design.md

- mig 588 (APPLIED to prod before merge): host consent columns + backfill, consent_log.host_id + channel vocabulary, event_hosts.postmark_stream_id, race_registrations.marketing_consent
- isEmailable gates marketing on host_contacts.marketing_consent (fails closed), never contacts.email_marketing
- src/lib/host-consent.js: the one writer (grant / bulk / revoke / resubscribe)
- signup + hosted-event registration grant BOTH consents; forms say so
- host unsubscribe page + NEW one-click POST /api/unsubscribe/host/[token]; both push a suppression on the host's stream
- queue sends marketing with postmarkStream = host.postmark_stream_id, internal stream broadcast (tracking + List-Unsubscribe headers, missing on real sends before)
- host-stream Postmark events route to host tables (bounce fact, complaint, one-click) before the CRM switch
- send route 409s a marketing send when the host has no stream; admins set it on Settings → Hosts

Post-merge: set postmark_stream_id = colm-events on Pride Training Club, then one test send + one real send; confirm the message is on colm-events with List-Unsubscribe, and a Gmail one-click lands as a host_email_suppressions row.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: After merge (operator steps, in order)**

1. Settings → Hosts → Pride Training Club → Sender defaults → Postmark marketing stream = `colm-events` → Save.
2. Host portal → Emails → a test send to Richard, then a real send. In Postmark confirm `MessageStream: colm-events` and the `List-Unsubscribe` header on the message.
3. From a Gmail account on the list, click Gmail's own Unsubscribe; within a minute confirm a new `host_email_suppressions` row for that contact and no change to `contacts.email_marketing`.

---

## Self-review against the spec

- §1 data → Task 1. §2 grant paths → Tasks 5, 6, 7 (resubscribe in 7). §3 revoke paths → Tasks 8, 11; UN1T paths untouched, pinned by the `never touches contacts` test in Task 4 and the routing test in Task 11. §4 gate → Tasks 2, 3, 9. §5 stream → Tasks 9, 10, 12 (manual stream + webhook creation stays operator-side, as the spec says). §6 processor → Task 11. §7 copy → Task 13. §8 error handling → every write destructures `error`; public form still answers `{success:true}`. §9 tests → each task. §10 rollout → Task 1 applies the migration first; Task 14 lists the post-merge steps.
- Deviation recorded in the spec: `postmarkStream` instead of a new `marketing` option (Task 9).
- Names used consistently: `isEmailable(contact, suppressed, { emailType, hostConsent })`; `grantHostConsent`, `grantHostConsentBulk`, `revokeHostConsent`, `resubscribeHost`, `HOST_CONSENT_CHANNEL`; `isHostCampaignEvent`, `processHostCampaignEvent`; sources `mailing_list_form` / `event_form` / `host_resubscribe` (host_contacts CHECK) and `host_unsubscribe_page` / `host_one_click_unsubscribe` / `postmark_one_click_unsubscribe` / `postmark_spam_complaint` (consent_log.source, free text).
