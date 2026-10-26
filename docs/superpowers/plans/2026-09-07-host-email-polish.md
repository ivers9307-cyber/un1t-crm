# Host Email Polish (HOST-EMAILS.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven host-email follow-ups Richard chose (contact reasons, paused state, delete/duplicate, designer readiness, reminder to non-openers, styles + honest preview, link breakdown) plus the unsubscribe confirm step, as one PR with one migration.

**Architecture:** Mig 594 adds `non_openers` audience + `audience_campaign_id`, the `host_campaign_clicks` table and a delete guard trigger. The host sanitizer keeps `<style>` (scrubbed by the CRM's `scrubCss`) and a canonical viewport meta. One predicate `hostSendBlockReason` feeds the launch lib, the schedule route, the list and the report. New routes: DELETE, duplicate, reminder-draft, preview. The webhook and the backfill write click rows; the recipients route aggregates them. The composer gets pending-design loading, a preview modal, delete/duplicate, and a fixed audience line for reminder drafts; the report gets the paused line, the reminder button and a Links section.

**Tech Stack:** Next.js 16 App Router, Supabase (service role; migrations via MCP), vitest (+ @testing-library/react where the file already has render tests), zod.

**Spec:** `docs/superpowers/specs/2026-09-07-host-email-polish-design.md` (commit 52887a3d).

**Repo rules:** every `.select()` capped at 1,000 rows → `.range()`-paginate; supabase builders are thenables (no `.catch`); destructure `error` on every write AND on every `.maybeSingle()` read (a read failure is a 500, never a 404); `[id]` paths need quotes in zsh; branch `host-email-polish` in worktree `~/code/un1t-crm-hostconsent`; commit per task; never `git add -A`; no em-dashes in NEW customer-facing copy; `<Link>` for internal links. Parallel waves: implementers in one wave touch disjoint files and never stage or commit; the controller commits.

CI mirror before pushing:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

---

## File map and waves

| Wave | Task | Files |
|---|---|---|
| A | 1 Migration 594 | NEW `supabase/migrations/594_host_email_polish.sql` |
| A | 2 Styles survive | `src/lib/email-html.js` (export `scrubCss`), `src/lib/host-campaign-email.js` (sanitizer only, lines 20-104), `src/lib/host-campaign-email.test.js` |
| A | 3 Contact reasons | `src/lib/host-contact-list.js`, its test, `src/app/host/(portal)/contacts/page.js`, `src/app/api/host/contacts/export/route.js` (+ test if present) |
| A | 5 Click rows | `src/lib/host-campaign-webhooks.js`, its test, `src/lib/host-campaign-backfill.js`, its test, `src/app/api/hosts/[id]/backfill-campaign-events/route.js` (summary field) |
| A | 6 Unsubscribe confirm | `src/app/unsubscribe/host/[token]/page.js`, `src/app/api/unsubscribe/host/[token]/route.js`, its test, `src/lib/consent-sources.js` |
| B | 4 Block reason + non-openers resolver | `src/lib/host-campaign-launch.js`, its test, `src/lib/host-campaign-email.js` (resolver only, lines 180-275), `src/app/api/host/emails/[id]/schedule/route.js` |
| B | 8 Composer | `src/components/host/HostEmails.jsx`, `src/components/host/HostEmails.test.jsx`, `src/app/host/(portal)/emails/page.js` |
| B | 9 Report | `src/components/host/HostEmailReport.jsx`, `src/components/host/HostEmailReport.test.jsx` |
| C | 7 Routes | `src/app/api/host/emails/[id]/route.js` (+ test), NEW `[id]/duplicate/route.js` (+ test), NEW `[id]/reminder-draft/route.js` (+ test), NEW `src/app/api/host/emails/preview/route.js` (+ test), `src/app/api/host/emails/route.js`, `src/app/api/host/emails/[id]/recipients/route.js` (+ test), `src/lib/host-campaign-draft.js` (+ test), `src/lib/openapi.js` |
| D | 10 Docs, mirror, build, PR, click backfill | `docs/CHANGELOG.md` |

Task 2 and Task 4 both edit `src/lib/host-campaign-email.js` in different regions; they are in different waves so they never run together.

---

### Task 1: Migration 594

**Files:** Create `supabase/migrations/594_host_email_polish.sql`

- [ ] **Step 1: Write**

```sql
-- HOST-EMAILS.2 — host email polish: reminder audience, link clicks, delete guard.
--
-- 1. audience_kind 'non_openers' + audience_campaign_id: a reminder draft whose
--    audience is "delivered but never opened nor clicked" on a parent campaign,
--    resolved at SEND time (src/lib/host-campaign-email.js resolveHostRecipients).
-- 2. host_campaign_clicks: one row per link click (webhook Click and the
--    Postmark backfill), so the report can show clicks per URL. Unique on
--    (send_id, url, clicked_at) makes both writers idempotent.
-- 3. host_campaigns_block_sent_delete: mirrors mig 523 for CRM campaigns. A
--    sent/sending campaign and its host_campaign_sends are the record of what
--    went out; only draft/scheduled rows may be deleted.

alter table host_campaigns drop constraint if exists host_campaigns_audience_kind_check;
alter table host_campaigns add constraint host_campaigns_audience_kind_check
  check (audience_kind in ('all', 'event', 'mailing_list', 'non_openers'));

alter table host_campaigns
  add column if not exists audience_campaign_id uuid references host_campaigns(id) on delete set null;
comment on column host_campaigns.audience_campaign_id is
  'HOST-EMAILS.2: for audience_kind = non_openers, the parent campaign whose delivered-but-unopened recipients this draft targets.';

create table if not exists host_campaign_clicks (
  id                  uuid primary key default gen_random_uuid(),
  host_id             uuid not null references event_hosts(id) on delete cascade,
  campaign_id         uuid not null references host_campaigns(id) on delete cascade,
  send_id             uuid not null references host_campaign_sends(id) on delete cascade,
  contact_id          uuid references contacts(id) on delete set null,
  url                 text not null,
  clicked_at          timestamptz not null,
  postmark_message_id text,
  created_at          timestamptz not null default now()
);
create unique index if not exists host_campaign_clicks_dedupe on host_campaign_clicks (send_id, url, clicked_at);
create index if not exists idx_host_campaign_clicks_campaign_url on host_campaign_clicks (campaign_id, url);
create index if not exists idx_host_campaign_clicks_contact on host_campaign_clicks (contact_id);
alter table host_campaign_clicks enable row level security;
comment on table host_campaign_clicks is
  'HOST-EMAILS.2: one row per tracked-link click on a host campaign email (webhook Click + Postmark backfill). Service role only; no policies.';

create or replace function public.host_campaigns_block_sent_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status in ('draft', 'scheduled') then
    return old;
  end if;
  raise exception
    'Host campaign % is % and cannot be deleted. Its send rows and clicks are the record of what was actually sent.',
    old.id, coalesce(old.status, 'in an unknown state')
    using errcode = 'check_violation';
end;
$$;
drop trigger if exists host_campaigns_block_sent_delete on host_campaigns;
create trigger host_campaigns_block_sent_delete
  before delete on host_campaigns
  for each row
  execute function public.host_campaigns_block_sent_delete();
```

- [ ] **Step 2: Apply via MCP** (`apply_migration`, name `594_host_email_polish`, project `iyvtbjjxdggiadzwwvdj`), then `get_advisors` security + performance. Expected: the only new finding is the INFO "RLS enabled no policy" for `host_campaign_clicks` (same as its siblings) and possibly an "unused index" INFO.

- [ ] **Step 3: Commit** (controller)

```bash
git add supabase/migrations/594_host_email_polish.sql
git commit -m "HOST-EMAILS.2 — mig 594: non_openers audience, host_campaign_clicks, delete guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Styles survive the sanitizer

**Files:**
- Modify `src/lib/email-html.js`: change `function scrubCss(css, counter)` (line ~310) to `export function scrubCss(css, counter)` and add above it:
  ```js
  /**
   * HOST-EMAILS.2 — exported for the host campaign sanitizer, which keeps
   * <style> blocks. `counter` is `{ cssChars: 0 }` per document (the total
   * budget below is per document). Output never contains `<` or `>`.
   */
  ```
- Modify `src/lib/host-campaign-email.js` sanitizer section (lines 20-104 only)
- Modify `src/lib/host-campaign-email.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/host-campaign-email.test.js` (read its imports first; `sanitizeCampaignHtml` and `renderHostCampaignHtml` are already imported there):

```js
// HOST-EMAILS.2 — <style> survives (scrubbed), the viewport meta survives
// (canonicalised), everything else on the strip list still goes. A Canva or
// Unlayer export keeps its whole responsive layer in a <style> block; before
// this it rendered as a fixed 600px table on phones.
describe('sanitizeCampaignHtml — styles and viewport (HOST-EMAILS.2)', () => {
  const CANVA = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><style>@import url("https://evil.example/x.css"); .wrap{min-width:600px} @media (max-width:600px){ .wrap{min-width:0 !important;width:100% !important} }</style></head><body><table class="wrap"><tr><td>Hi</td></tr></table></body></html>'

  it('keeps the <style> block with its media query and drops the @import', () => {
    const out = sanitizeCampaignHtml(CANVA)
    expect(out).toContain('<style>')
    expect(out).toContain('@media (max-width:600px)')
    expect(out).toContain('width:100% !important')
    expect(out).not.toContain('@import')
    expect(out).not.toContain('evil.example')
  })

  it('keeps exactly one canonical viewport meta and strips the other metas', () => {
    const out = sanitizeCampaignHtml(CANVA)
    expect(out.match(/<meta/g)).toHaveLength(1)
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('x-apple-disable-message-reformatting')
    expect(out).not.toContain('charset')
  })

  it('never lets an authored viewport meta carry extra attributes through', () => {
    const out = sanitizeCampaignHtml('<meta name="viewport" content="width=device-width" onload="x()" http-equiv="refresh"><p>x</p>')
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('refresh')
    expect(out).not.toContain('onload')
  })

  it('a <style> that tries to close itself early cannot smuggle a tag', () => {
    const out = sanitizeCampaignHtml('<style>.a{}</style ><script>alert(1)</script><style>.b{color:red}</st\\yle><img src=x onerror=alert(1)></style>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).not.toMatch(/<style>[^<]*<img/)
  })

  it('still strips script, iframe, form, link, svg and on* handlers', () => {
    const out = sanitizeCampaignHtml('<style>.a{}</style><link rel="stylesheet" href="https://x/y.css"><script>1</script><iframe src="x"></iframe><form action="x"><input></form><svg onload="1"></svg><a href="https://ok" onclick="1">ok</a>')
    expect(out).toContain('<style>.a{}</style>')
    expect(out).not.toContain('<link')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('onclick')
    expect(out).toContain('<a href="https://ok">ok</a>')
  })

  it('a forged placeholder in the input cannot inject a style block', () => {
    const out = sanitizeCampaignHtml('<p>@@UN1T_STYLE_0@@ @@UN1T_VIEWPORT@@</p><style>.z{}</style>')
    expect(out).not.toContain('@@UN1T_')
    expect((out.match(/<style>/g) || []).length).toBe(1)
    expect(out).not.toContain('<meta')
  })

  it('renderHostCampaignHtml keeps a full-document export responsive', () => {
    const html = renderHostCampaignHtml({ host: { name: 'Club', sender_name: 'Club' }, subject: 's', bodyHtml: CANVA, unsubscribeUrl: 'https://x/u' })
    expect(html).toContain('@media (max-width:600px)')
    expect(html).toContain('name="viewport"')
    expect(html).toContain('https://x/u')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/host-campaign-email.test.js`
Expected: the new block FAILS (style stripped, no viewport meta).

- [ ] **Step 3: Implement**

In `src/lib/email-html.js` export `scrubCss` as described above (one-word change plus the JSDoc).

In `src/lib/host-campaign-email.js`, add the import at the top with the others:
```js
import { scrubCss } from './email-html'
```
Replace the constant `CONTENT_STRIP_TAGS` and its comment with:
```js
// Tags whose CONTENT is dangerous too — removed as a block. <style> is NOT
// here any more (HOST-EMAILS.2): its body is lifted out, scrubbed by the
// CRM's scrubCss (no @import, no expression(), no remote url(), never a
// `<` or `>` in the output) and put back after the strip passes.
const CONTENT_STRIP_TAGS = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
```
Keep `TAG_STRIP` exactly as it is (it still lists `style` and `meta`: after the lift, any stray `<style>` open tag or any non-viewport `<meta>` is stripped by it).

Add after `TAG_STRIP`:
```js
// HOST-EMAILS.2 — lifted before the strip passes and restored after them.
// The placeholder prefix is stripped from the input first so a host cannot
// forge one (it is plain text, never a tag, so the strip passes ignore it).
// The viewport meta is always re-emitted in its canonical form, never as
// authored (no attribute smuggling).
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
const VIEWPORT_META = /<meta\b[^>]*\bname\s*=\s*["']?viewport["']?[^>]*>/gi
const VIEWPORT_META_SAFE = '<meta name="viewport" content="width=device-width, initial-scale=1">'
const PLACEHOLDER_PREFIX = '@@UN1T_'
const STYLE_PLACEHOLDER = /@@UN1T_STYLE_(\d+)@@/g
const VIEWPORT_PLACEHOLDER = '@@UN1T_VIEWPORT@@'
```
Replace the body of `sanitizeCampaignHtml` with:
```js
export function sanitizeCampaignHtml(html) {
  if (!html || typeof html !== 'string') return ''
  const counter = { cssChars: 0 }
  const styles = []
  let out = html.split(PLACEHOLDER_PREFIX).join('')
  // 1. Lift and scrub every <style> body. An empty result after the scrub
  //    drops the block entirely.
  out = out.replace(STYLE_BLOCK, (_m, css) => {
    const safe = scrubCss(css, counter).trim()
    if (!safe) return ''
    styles.push(safe)
    return `@@UN1T_STYLE_${styles.length - 1}@@`
  })
  // 2. Remember whether the author had a viewport meta; every occurrence
  //    becomes the placeholder, and only the first is re-emitted.
  let hadViewport = false
  out = out.replace(VIEWPORT_META, () => { hadViewport = true; return VIEWPORT_PLACEHOLDER })
  // 3. Iterate to a fixed point: stripping one construct can splice a new one
  //    together (e.g. <scr<script>ipt>). Bounded — each pass only removes.
  for (let i = 0; i < 10; i++) {
    const before = out
    out = out
      .replace(CONTENT_STRIP_TAGS, '')
      .replace(TAG_STRIP, '')
      .replace(ON_ATTR_DQ, '$1')
      .replace(ON_ATTR_SQ, '$1')
      .replace(ON_ATTR_BARE, '$1')
      .replace(URL_ATTR, neutralizeUrlAttr)
    if (out === before) break
  }
  // 4. Restore. scrubCss guarantees no `<`/`>` inside a style body, so the
  //    only tags introduced here are the ones written on this line.
  out = out.replace(STYLE_PLACEHOLDER, (_m, i) => `<style>${styles[Number(i)] ?? ''}</style>`)
  let viewportEmitted = false
  out = out.split(VIEWPORT_PLACEHOLDER).reduce((acc, part, idx) => {
    if (idx === 0) return part
    const tag = hadViewport && !viewportEmitted ? VIEWPORT_META_SAFE : ''
    viewportEmitted = true
    return acc + tag + part
  }, '')
  return out
}
```
Update the module header comment (lines 6-12) so it no longer claims `<style>`/`<meta>` are stripped: "…removes active content (script/iframe/object/embed/form/link/svg/math, non-viewport meta, on* handlers…), keeps `<style>` scrubbed and one canonical viewport meta (HOST-EMAILS.2)…".

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/host-campaign-email.test.js src/lib/email-html.test.js`
Expected: PASS. If a pre-existing test in `host-campaign-email.test.js` asserted that `<style>` or the viewport meta is stripped, update THAT assertion to the new behaviour and say so in the report. Also grep `src/lib/host-campaign-queue.test.js` and `src/app/api/host/emails/[id]/send-test/route.test.js` for `<style>` assertions and update any that assert stripping.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/email-html.js src/lib/host-campaign-email.js src/lib/host-campaign-email.test.js
git commit -m "HOST-EMAILS.2 — host sanitizer keeps scrubbed <style> and a canonical viewport meta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Contacts page shows the reason

**Files:**
- Modify `src/lib/host-contact-list.js` (`fetchHostContactRows`, the `return memberships.map(...)` block ~line 381)
- Modify `src/lib/host-contact-list.test.js` (find the `fetchHostContactRows` describe; if none exists, add one using the file's existing db-fake style)
- Modify `src/app/host/(portal)/contacts/page.js`
- Modify `src/app/api/host/contacts/export/route.js` (+ `route.test.js` if it exists)

- [ ] **Step 1: Failing test** — in `src/lib/host-contact-list.test.js` add (adapting the fixture builder the file already uses for `fetchHostContactRows`; if the file only tests `isEmailable`/`emailabilityReason`, add a minimal `fetchHostContactRows` test with a chainable fake returning one membership whose contact has `email_status: 'bounced'` and one with consent true and an active mailbox):

```js
it('fetchHostContactRows carries emailable_reason (null when emailable)', async () => {
  const rows = await fetchHostContactRows(db, HOST_ID)
  const blocked = rows.find((r) => r.email === 'bounced@x.ie')
  const fine = rows.find((r) => r.email === 'ok@x.ie')
  expect(blocked.emailable).toBe(false)
  expect(blocked.emailable_reason).toBe('mailbox_blocked')
  expect(fine.emailable).toBe(true)
  expect(fine.emailable_reason).toBe(null)
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/host-contact-list.test.js` → FAIL (`emailable_reason` undefined).

- [ ] **Step 3: Implement**

In `fetchHostContactRows`, `emailabilityReason` is defined in the same file, so just call it; change the mapped object:
```js
      emailable: isEmailable(contact, suppressedIds.has(m.contact_id), { hostConsent: m.marketing_consent === true }),
      // HOST-EMAILS.2 — why not, in the send path's own vocabulary (null when emailable).
      emailable_reason: emailabilityReason(contact, suppressedIds.has(m.contact_id), { hostConsent: m.marketing_consent === true }),
```

In `src/app/host/(portal)/contacts/page.js` add `import { failureCopy } from '@/lib/host-campaign-outcome'` and change the Emailable cell to:
```jsx
                    <td className={td}>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          r.emailable ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/60'
                        }`}
                      >
                        {r.emailable ? 'Emailable' : 'No'}
                      </span>
                      {!r.emailable && r.emailable_reason && (
                        <p className="text-[11px] text-white/40 mt-1">{failureCopy(r.emailable_reason)}</p>
                      )}
                    </td>
```

In `src/app/api/host/contacts/export/route.js`: `import { failureCopy } from '@/lib/host-campaign-outcome'`, `HEADER` becomes `['Name', 'Email', 'Source', 'Joined', 'Emailable', 'Reason']`, and the row push gains `r.emailable ? '' : failureCopy(r.emailable_reason)`. If `route.test.js` exists beside it and asserts the header or a row, update it and add one assertion that a blocked row carries its reason text.

- [ ] **Step 4: Run** `npx vitest run src/lib/host-contact-list.test.js src/app/api/host/contacts` and `npx eslint src/lib/host-contact-list.js 'src/app/host/(portal)/contacts/page.js' src/app/api/host/contacts/export/route.js` → PASS, clean.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/host-contact-list.js src/lib/host-contact-list.test.js 'src/app/host/(portal)/contacts/page.js' src/app/api/host/contacts/export
git commit -m "HOST-EMAILS.2 — contacts page and CSV say why a contact can't be emailed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `hostSendBlockReason` and the non-openers resolver

**Files:**
- Modify `src/lib/host-campaign-launch.js`, `src/lib/host-campaign-launch.test.js`
- Modify `src/lib/host-campaign-email.js` (resolver region only, `resolveHostRecipients`; do not touch the sanitizer)
- Modify `src/lib/host-campaign-email.test.js` (add resolver tests; the file already has a db fake for `resolveHostRecipients`, reuse it)
- Modify `src/app/api/host/emails/[id]/schedule/route.js` (early gates)

- [ ] **Step 1: Failing tests**

`src/lib/host-campaign-launch.test.js`, new describe:
```js
import { hostSendBlockReason } from './host-campaign-launch.js' // add to the existing import line

describe('hostSendBlockReason', () => {
  const host = { sender_domain_verified: true, sender_email: 'a@b.ie', postmark_stream_id: 'colm-events' }
  it('null when verified with a stream', () => expect(hostSendBlockReason(host, { email_type: 'marketing' })).toBe(null))
  it('sender_not_verified when unverified or no sender email or no host', () => {
    expect(hostSendBlockReason({ ...host, sender_domain_verified: false }, { email_type: 'marketing' })).toBe('sender_not_verified')
    expect(hostSendBlockReason({ ...host, sender_email: null }, { email_type: 'marketing' })).toBe('sender_not_verified')
    expect(hostSendBlockReason(null, { email_type: 'marketing' })).toBe('sender_not_verified')
  })
  it('no_stream for marketing (and a missing email_type, legacy rows) without a stream; utility passes', () => {
    expect(hostSendBlockReason({ ...host, postmark_stream_id: null }, { email_type: 'marketing' })).toBe('no_stream')
    expect(hostSendBlockReason({ ...host, postmark_stream_id: null }, {})).toBe('no_stream')
    expect(hostSendBlockReason({ ...host, postmark_stream_id: null }, { email_type: 'utility' })).toBe(null)
  })
})

describe('launchHostCampaign — non_openers audience', () => {
  it('passes nonOpenersOf = audience_campaign_id to the resolver', async () => {
    const { db } = makeDb(routeFor({ campaign: { id: CAMPAIGN_ID, status: 'draft', email_type: 'marketing', audience_kind: 'non_openers', audience_event_id: null, audience_campaign_id: 'p0000000-0000-0000-0000-0000000000p1' } }))
    await launch(db)
    expect(resolveHostRecipients).toHaveBeenCalledWith(db, HOST_ID, expect.objectContaining({ nonOpenersOf: 'p0000000-0000-0000-0000-0000000000p1', mailingListOnly: false, audienceEventId: null }))
  })
})
```
(`makeDb`, `routeFor`, `launch`, `CAMPAIGN_ID`, `HOST_ID`, `resolveHostRecipients` mock already exist in that file.)

`src/lib/host-campaign-email.test.js`, in the resolver describe, add tests with the existing fake (extend its route to answer `host_campaign_sends` and a `host_campaigns` ownership read):
```js
it('nonOpenersOf: only the parent\'s delivered, unopened, unclicked, unbounced rows, then the normal emailability gate', async () => {
  // fake: host_campaigns read → { data: { id: PARENT } } (owned); host_campaign_sends → rows for contacts c1 (eligible), c2 (opened), c3 (bounced); host_contacts → c1..c4 all consented and active
  const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
  expect(out.map((r) => r.contact_id)).toEqual(['c1'])
  const sendsQuery = statements.find((s) => s.table === 'host_campaign_sends')
  expect(hasEq(sendsQuery, 'campaign_id', PARENT)).toBe(true)
  expect(hasEq(sendsQuery, 'status', 'sent')).toBe(true)
  for (const col of ['opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at']) {
    expect(sendsQuery.ops.some((o) => o.method === 'is' && o.args[0] === col && o.args[1] === null)).toBe(true)
  }
  expect(sendsQuery.ops.some((o) => o.method === 'not' && o.args[0] === 'delivered_at')).toBe(true)
})

it('nonOpenersOf: a parent that is not this host\'s throws (no cross-host audience)', async () => {
  // fake: host_campaigns read → { data: null }
  await expect(resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })).rejects.toThrow(/parent campaign/)
})
```
Write the fake so the `host_campaign_sends` filter is applied by the TEST (return only c1's row when the query carries the `is` filters), the way the file's existing resolver tests return canned data; the assertions on the ops are what pin the filters.

- [ ] **Step 2: Run** both files → FAIL.

- [ ] **Step 3: Implement**

`src/lib/host-campaign-launch.js`:
```js
/**
 * HOST-EMAILS.2 — the one predicate for "this host cannot send this campaign
 * right now". Used by the launch (refusal), the schedule route (early
 * feedback), and the list/report routes (a 'sending' campaign with a
 * reason here is PAUSED: the queue returns 'halted' for the same two
 * conditions and the campaign waits for UN1T).
 * @returns {'sender_not_verified'|'no_stream'|null}
 */
export function hostSendBlockReason(host, campaign) {
  if (!host || !host.sender_domain_verified || !host.sender_email) return 'sender_not_verified'
  if ((campaign?.email_type ?? 'marketing') !== 'utility' && !host.postmark_stream_id) return 'no_stream'
  return null
}
```
In `launchHostCampaign` replace the two inline gates (`if (!host.sender_domain_verified || !host.sender_email) return refuse('sender_not_verified')` and the `no_stream` check) with:
```js
  const blocked = hostSendBlockReason(host, campaign)
  if (blocked) return refuse(blocked)
```
Add `audience_campaign_id` to the campaign select in `launchHostCampaign` (and in `resolveMissedRecipients` if it selects the campaign). In `resolverOptionsFor(campaign)` add:
```js
    nonOpenersOf: campaign.audience_kind === 'non_openers' ? campaign.audience_campaign_id || null : null,
```

`src/lib/host-campaign-email.js` `resolveHostRecipients`: extend the signature `{ audienceEventId = null, emailType = 'marketing', mailingListOnly = false, nonOpenersOf = null } = {}` and, after the per-event block, add:
```js
  // HOST-EMAILS.2 — reminder audience: the parent's rows that were delivered
  // but never opened nor clicked (and not bounced/complained/unsubscribed),
  // re-gated below by the normal emailability rules at SEND time. The parent
  // must be this host's: a foreign id resolves nobody, loudly.
  if (nonOpenersOf) {
    const { data: parent, error: parentErr } = await db
      .from('host_campaigns').select('id').eq('id', nonOpenersOf).eq('host_id', hostId).maybeSingle()
    if (parentErr) throw new Error(`host campaign: parent campaign read failed: ${parentErr.message}`)
    if (!parent) throw new Error('host campaign: parent campaign not found for this host')
    allowedContactIds = new Set()
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('host_campaign_sends')
        .select('contact_id')
        .eq('campaign_id', nonOpenersOf)
        .eq('status', 'sent')
        .not('delivered_at', 'is', null)
        .is('opened_at', null)
        .is('clicked_at', null)
        .is('bounced_at', null)
        .is('complained_at', null)
        .is('unsubscribed_at', null)
        .order('id')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`host campaign: non-openers query failed: ${error.message}`)
      for (const row of data || []) if (row.contact_id) allowedContactIds.add(row.contact_id)
      if (!data || data.length < PAGE) break
    }
  }
```
Update the JSDoc `@param` block accordingly.

`src/app/api/host/emails/[id]/schedule/route.js`: import `hostSendBlockReason` alongside `LAUNCH_MESSAGES` and replace the two early-gate `if`s with:
```js
  const blocked = hostSendBlockReason(host, campaign)
  if (blocked) return NextResponse.json({ success: false, error: LAUNCH_MESSAGES[blocked] }, { status: 409 })
```
(the host select there already has the three columns).

- [ ] **Step 4: Run** `npx vitest run src/lib/host-campaign-launch.test.js src/lib/host-campaign-email.test.js 'src/app/api/host/emails/[id]/schedule' 'src/app/api/host/emails/[id]/send' 'src/app/api/host/emails/[id]/resend-missed'` and eslint on the four files → PASS, clean.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/host-campaign-launch.js src/lib/host-campaign-launch.test.js src/lib/host-campaign-email.js src/lib/host-campaign-email.test.js 'src/app/api/host/emails/[id]/schedule/route.js'
git commit -m "HOST-EMAILS.2 — hostSendBlockReason shared by launch/schedule; non_openers audience resolver

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Click rows from the webhook and the backfill

**Files:**
- Modify `src/lib/host-campaign-webhooks.js`, `src/lib/host-campaign-webhooks.test.js`
- Modify `src/lib/host-campaign-backfill.js`, `src/lib/host-campaign-backfill.test.js`
- Modify `src/app/api/hosts/[id]/backfill-campaign-events/route.js` (add `clicks: summary.clicks` to the `logInfo` meta) and its test's `SUMMARY` fixture (`clicks: 0`)

- [ ] **Step 1: Failing tests**

Webhook test (reuse the file's fake; find the existing `Click` test and add):
```js
it('Click inserts a host_campaign_clicks row from OriginalLink, deduped on (send_id, url, clicked_at)', async () => {
  const { db, statements } = makeDb(routeFor({ row: { id: 'row1', postmark_message_id: 'pm-1' } }))
  const r = await processHostCampaignEvent(db, {
    RecordType: 'Click', MessageID: 'pm-1', ReceivedAt: '2026-09-07T10:38:47Z', OriginalLink: 'https://x/a',
    Metadata: { host_campaign_id: CAMPAIGN_ID, host_id: HOST_ID, contact_id: CONTACT_ID },
  })
  expect(r.ok).toBe(true)
  const ins = statements.find((s) => s.table === 'host_campaign_clicks')
  expect(op(ins, 'upsert').args[0]).toEqual({
    host_id: HOST_ID, campaign_id: CAMPAIGN_ID, send_id: 'row1', contact_id: CONTACT_ID,
    url: 'https://x/a', clicked_at: '2026-09-07T10:38:47.000Z', postmark_message_id: 'pm-1',
  })
  expect(op(ins, 'upsert').args[1]).toEqual({ onConflict: 'send_id,url,clicked_at', ignoreDuplicates: true })
})

it('Click without OriginalLink writes no click row; a failed click insert never fails the event', async () => {
  // no OriginalLink → no host_campaign_clicks statement
  // host_campaign_clicks returns { error: { message: 'x' } } → r.ok still true
})
```
(Use the same `at()` normalisation the file uses for ReceivedAt; adjust the expected `clicked_at` to what `at()` returns.)

Backfill test:
```js
describe('foldClickEvents (HOST-EMAILS.2)', () => {
  it('returns one entry per LinkClicked with Details.Link, in order, skipping events without a link', () => {
    expect(foldClickEvents([
      { Type: 'Delivered', ReceivedAt: '2026-09-04T10:58:14Z' },
      { Type: 'LinkClicked', ReceivedAt: '2026-09-04T11:00:00Z', Details: { Link: 'https://a' } },
      { Type: 'LinkClicked', ReceivedAt: '2026-09-04T11:00:01Z', Details: {} },
      { Type: 'LinkClicked', ReceivedAt: '2026-09-04T11:00:02Z', Details: { Link: 'https://b' } },
    ])).toEqual([{ url: 'https://a', at: '2026-09-04T11:00:00Z' }, { url: 'https://b', at: '2026-09-04T11:00:02Z' }])
  })
  it('is empty for non-arrays', () => expect(foldClickEvents(null)).toEqual([]))
})
```
And in the existing `backfillHostCampaignEvents` live-run test, assert that a message whose details carry two `LinkClicked` events produces one `host_campaign_clicks` upsert of two rows with `{ onConflict: 'send_id,url,clicked_at', ignoreDuplicates: true }` and `summary.clicks === 2`; in dry mode no insert but `summary.clicks === 2`.

- [ ] **Step 2: Run** both test files → FAIL.

- [ ] **Step 3: Implement**

Webhook (`src/lib/host-campaign-webhooks.js`), inside `case 'Click'` after the `bump`:
```js
        // HOST-EMAILS.2 — one row per click for the report's link breakdown.
        // Best effort: a failed insert is logged, never fails the event.
        if (typeof body.OriginalLink === 'string' && body.OriginalLink) {
          const { error: clickRowErr } = await db
            .from('host_campaign_clicks')
            .upsert({
              host_id: hostId,
              campaign_id: meta.host_campaign_id,
              send_id: row.id,
              contact_id: contactId,
              url: body.OriginalLink,
              clicked_at: at(body.ReceivedAt),
              postmark_message_id: isValidMessageId(body.MessageID) ? body.MessageID : null,
            }, { onConflict: 'send_id,url,clicked_at', ignoreDuplicates: true })
          if (clickRowErr) console.warn('[host-campaign webhooks] click row insert failed', { row_id: row.id, error: clickRowErr.message })
        }
```
(`hostId`, `contactId`, `meta`, `at`, `isValidMessageId` already exist in that function's scope; check the exact names.)

Backfill (`src/lib/host-campaign-backfill.js`): add
```js
/**
 * HOST-EMAILS.2 — the message's clicks, one per LinkClicked event that
 * carries a link (Postmark's details timeline puts it in Details.Link).
 * Pure. Order preserved.
 * @returns {Array<{url: string, at: string}>}
 */
export function foldClickEvents(events) {
  if (!Array.isArray(events)) return []
  const out = []
  for (const e of events) {
    if (e?.Type !== 'LinkClicked') continue
    const url = e?.Details?.Link
    if (typeof url !== 'string' || !url) continue
    out.push({ url, at: e.ReceivedAt })
  }
  return out
}
```
Add `clicks: 0` to the summary object. Rows loaded into `rowsByKey` need `contact_id` (already selected); `hostId` is in scope. In the main loop, after the patch is folded and BEFORE the `if (Object.keys(patch).length === 0)` early continue, compute `const clicks = foldClickEvents(details?.MessageEvents)`, and change the "nothing to do" check to `if (Object.keys(patch).length === 0 && clicks.length === 0)`. After the patch write block (both dry and live paths), add:
```js
      if (clicks.length) {
        summary.clicks += clicks.length
        if (!dry) {
          const { error: clickErr } = await db
            .from('host_campaign_clicks')
            .upsert(clicks.map((c) => ({
              host_id: hostId, campaign_id: row.campaign_id, send_id: row.id, contact_id: row.contact_id,
              url: c.url, clicked_at: c.at, postmark_message_id: message.MessageID,
            })), { onConflict: 'send_id,url,clicked_at', ignoreDuplicates: true })
          if (clickErr) {
            logWarn('host-campaign-backfill', 'failed to write click rows', { row_id: row.id, error: clickErr })
            summary.errors.push({ message_id: message.MessageID, error: clickErr })
          }
        }
      }
```
Leave the `nothingLeftToLearn` shortcut exactly as it is (rows with every timestamp set skip the details call, so their clicks are not collected by this path; the one-off script in Task 10 covers historic clicks). Say so in a one-line comment next to the shortcut.

Route: add `clicks: summary.clicks` to the `logInfo` meta and `clicks: 0` to the test's `SUMMARY`.

- [ ] **Step 4: Run** `npx vitest run src/lib/host-campaign-webhooks.test.js src/lib/host-campaign-backfill.test.js 'src/app/api/hosts/[id]/backfill-campaign-events'` and eslint → PASS, clean.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/host-campaign-webhooks.js src/lib/host-campaign-webhooks.test.js src/lib/host-campaign-backfill.js src/lib/host-campaign-backfill.test.js 'src/app/api/hosts/[id]/backfill-campaign-events'
git commit -m "HOST-EMAILS.2 — host_campaign_clicks rows from the Click webhook and the backfill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Unsubscribe page confirms before writing

**Files:**
- Modify `src/app/unsubscribe/host/[token]/page.js`
- Modify `src/app/api/unsubscribe/host/[token]/route.js` and `route.test.js`
- Modify `src/lib/consent-sources.js` (add `scanner_reversal: VOLUNTARY, // HOST-EMAILS.2: restoring a contact a link scanner opted out` under the host block)

- [ ] **Step 1: Failing route tests** (in `src/app/api/unsubscribe/host/[token]/route.test.js`, following its existing fixtures):
```js
it('a form POST with redirect=1 revokes and 303s to the done page (the confirm button)', async () => {
  const req = new Request(`http://localhost/api/unsubscribe/host/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'redirect=1',
  })
  const res = await POST(req, props)
  expect(res.status).toBe(303)
  expect(res.headers.get('location')).toBe(`http://localhost/unsubscribe/host/${encodeURIComponent(TOKEN)}?done=1`)
  expect(revokeHostConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'host_unsubscribe_page' }))
})
it('a one-click POST (form body without redirect) still answers JSON and uses the one-click source', async () => {
  const req = new Request(`http://localhost/api/unsubscribe/host/${TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  })
  const res = await POST(req, props)
  expect(res.status).toBe(200)
  expect(revokeHostConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'host_one_click_unsubscribe' }))
})
it('a form POST with redirect=1 whose revoke fails 303s to ?error=1', async () => { /* revokeHostConsent → { ok:false, error:'x' } → 303 to ...?error=1 */ })
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

Route: at the top of `POST` after `params`, read the form once:
```js
  // HOST-EMAILS.2 — the landing page's confirm button posts here with
  // redirect=1 and expects a browser redirect; a mail provider's RFC 8058
  // one-click POST also arrives form-encoded (List-Unsubscribe=One-Click)
  // but never carries redirect, so it keeps getting JSON.
  let wantsRedirect = false
  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null)
    wantsRedirect = form?.get('redirect') === '1'
  }
  const origin = getRequestOrigin(request)
  const pageUrl = (qs) => `${origin}/unsubscribe/host/${encodeURIComponent(params.token)}${qs}`
```
Use `source: wantsRedirect ? 'host_unsubscribe_page' : 'host_one_click_unsubscribe'`. On the two failure returns (404 invalid token → `NextResponse.redirect(pageUrl('?error=1'), 303)` when `wantsRedirect`; the 500 likewise) and on success: `if (wantsRedirect) return NextResponse.redirect(pageUrl('?done=1'), 303)` before the JSON return. Update the file header and the `GET` comment (the page no longer writes on GET).

Page (`src/app/unsubscribe/host/[token]/page.js`): the page no longer imports or calls `revokeHostConsent` or `suppressAtPostmark`. It reads `const sp = await props.searchParams` and:
```jsx
  if (sp?.done === '1') {
    return (
      <Shell>
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Unsubscribed</p>
        <h1 className="mt-3 text-2xl font-bold">You&apos;re unsubscribed</h1>
        <p className="mt-4 text-sm text-white/70">
          You&apos;ll no longer receive emails from {host.name}. Your other email preferences are unchanged.
        </p>
      </Shell>
    )
  }
  return (
    <Shell>
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/50">Unsubscribe</p>
      <h1 className="mt-3 text-2xl font-bold">Stop emails from {host.name}?</h1>
      <p className="mt-4 text-sm text-white/70">
        This only affects emails from {host.name}. Your other email preferences are unchanged.
      </p>
      {sp?.error === '1' && (
        <p className="mt-4 text-sm text-red-300">That did not work. Please try again.</p>
      )}
      <form method="post" action={`/api/unsubscribe/host/${encodeURIComponent(params.token)}`} className="mt-6">
        <input type="hidden" name="redirect" value="1" />
        <button type="submit" className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-white/90">
          Unsubscribe
        </button>
      </form>
    </Shell>
  )
```
Header comment: "HOST-EMAILS.2 — the GET writes NOTHING. On 7 Sep 2026 a university mail scanner followed every link in a host email within seconds of delivery and opted three people out. The button posts to the one-click route, which is the single writer." Keep the token verification and host load (both reads). Search the tree for a page test (`page.test.js`) and update it if one exists.

- [ ] **Step 4: Run** `npx vitest run 'src/app/api/unsubscribe/host' 'src/app/unsubscribe/host'` and eslint; `npm run check:route-guards`; `npm run check:consent-sources` if such a script exists (check `package.json`). → PASS.

- [ ] **Step 5: Commit** (controller)

```bash
git add 'src/app/unsubscribe/host/[token]/page.js' 'src/app/api/unsubscribe/host/[token]' src/lib/consent-sources.js
git commit -m "HOST-EMAILS.2 — host unsubscribe page confirms before writing; scanners no longer opt people out

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Routes: delete, duplicate, reminder draft, preview, paused reason, links

**Files:**
- Modify `src/lib/host-campaign-draft.js` (+ `host-campaign-draft.test.js`): `HOST_CAMPAIGN_LIST_COLUMNS` gains `, audience_campaign_id`; new export `copySubject(subject, prefix = 'Copy of ')` returning `(prefix + (subject || '')).slice(0, 200)` (route modules may only export handlers, so the helper lives here)
- Modify `src/app/api/host/emails/[id]/route.js` (+ `route.test.js`): add `DELETE`; PATCH schema accepts `audience_kind: 'non_openers'` + `audience_campaign_id`
- Create `src/app/api/host/emails/[id]/duplicate/route.js` + `route.test.js`
- Create `src/app/api/host/emails/[id]/reminder-draft/route.js` + `route.test.js`
- Create `src/app/api/host/emails/preview/route.js` + `route.test.js`
- Modify `src/app/api/host/emails/route.js` (paused_reason)
- Modify `src/app/api/host/emails/[id]/recipients/route.js` (+ test): `paused_reason`, `non_openers_count`, `links`
- Modify `src/lib/openapi.js`: register DELETE `/api/host/emails/{id}`, POST `…/{id}/duplicate`, POST `…/{id}/reminder-draft`, POST `/api/host/emails/preview`; add `paused_reason`, `non_openers_count`, `links` to `HostCampaignRecipientsResponse`

Route test files copy the chainable Proxy fake from `src/app/api/host/emails/[id]/schedule/route.test.js` (with `op`/`hasEq` helpers).

- [ ] **Step 1: Failing tests** (one describe per route; the shapes below are the contract)

`host-campaign-draft.test.js`: `copySubject('Race week')` → `'Copy of Race week'`; `copySubject('x'.repeat(300))` has length 200; `copySubject('Race week', 'Reminder: ')` → `'Reminder: Race week'`; `copySubject(null)` → `'Copy of '`.

DELETE (`[id]/route.test.js`):
```js
describe('DELETE /api/host/emails/[id] (HOST-EMAILS.2)', () => {
  it('401 without a session', ...)
  it('deletes a draft or scheduled campaign of this host (CAS on status) and returns its id', async () => {
    // fake: host_campaigns delete → { data: [{ id: CAMPAIGN_ID }], error: null }
    const res = await DELETE(req(), props)
    expect(res.status).toBe(200)
    const del = statements.find((s) => s.table === 'host_campaigns')
    expect(op(del, 'delete')).toBeTruthy()
    expect(hasEq(del, 'id', CAMPAIGN_ID)).toBe(true)
    expect(hasEq(del, 'host_id', HOST_ID)).toBe(true)
    expect(op(del, 'in').args).toEqual(['status', ['draft', 'scheduled']])
  })
  it("409 'Sent emails can't be deleted. They are the record of what went out.' when nothing matched", ...)
  it('500 with the message on a db error', ...)
})
```
PATCH: add one test that `audience_kind: 'non_openers'` with an `audience_campaign_id` owned by the host writes both columns, and that `non_openers` without `audience_campaign_id` 400s ("This reminder has no parent email.").

Duplicate:
```js
it('creates "Copy of <subject>" as a draft with body, design, audience and type copied; counts and schedule not', async () => {
  // fake: host_campaigns select → source row (status 'sent', subject 'Race week', body_html '<p>x</p>', design_json {a:1}, audience_kind 'event', audience_event_id EV, audience_campaign_id null, email_type 'utility', recipient_count 124, scheduled_for '2026-…')
  //       host_campaigns insert → { data: { id: NEW_ID, subject: 'Copy of Race week', status: 'draft', ... } }
  const res = await POST(req(), props)
  expect(res.status).toBe(200)
  const ins = statements.find((s) => s.table === 'host_campaigns' && op(s, 'insert'))
  expect(op(ins, 'insert').args[0]).toEqual({
    host_id: HOST_ID, subject: 'Copy of Race week', body_html: '<p>x</p>', design_json: { a: 1 },
    audience_kind: 'event', audience_event_id: EV, audience_campaign_id: null, email_type: 'utility', status: 'draft',
  })
})
it('404 for another host\'s campaign; 500 on a read error', ...)
```
Reminder draft:
```js
it('creates "Reminder: <subject>" with audience non_openers pointing at the parent; parent must be sent', async () => {
  // parent status 'sent' → insert args include { subject: 'Reminder: Race week', audience_kind: 'non_openers', audience_campaign_id: CAMPAIGN_ID, audience_event_id: null, status: 'draft', email_type: 'marketing', body_html, design_json }
})
it("409 'Only a sent email can have a reminder.' for a draft parent", ...)
```
Preview:
```js
it('renders through renderHostCampaignHtml with sample merge values and the inert unsubscribe token; stores nothing', async () => {
  // mock @/lib/host-campaign-email renderHostCampaignHtml → '<html>{{first_name}}</html>'; mock @/lib/postmark applyMergeTags to substitute {{first_name}} → contact.first_name
  const res = await POST(req({ subject: 'Hi {{first_name}}', body_html: '<p>x</p>' }), props)
  expect(res.status).toBe(200)
  expect((await res.json()).data.html).toContain('Sample')
  expect(renderHostCampaignHtml).toHaveBeenCalledWith(expect.objectContaining({ bodyHtml: '<p>x</p>', unsubscribeUrl: expect.stringContaining('/unsubscribe/host/test-token') }))
  expect(statements.filter((s) => op(s, 'insert') || op(s, 'update'))).toHaveLength(0)
})
it('400 on an empty body or a body over 300000 chars', ...)
```
Recipients (extend the existing test file):
```js
it('a sending campaign whose host is blocked carries paused_reason; a healthy one carries null', ...)
it('a sent campaign carries non_openers_count from the resolver (null when it throws)', ...)
it('links: aggregated per url with clicks and people, sorted by clicks desc, unsubscribe link last', async () => {
  // host_campaign_clicks rows: a×3 (contacts c1,c1,c2), b×1, unsub×5
  // expect links: [{url:'https://a', clicks:3, people:2, is_unsubscribe:false}, {url:'https://b', clicks:1, people:1, is_unsubscribe:false}, {url:'https://crm/unsubscribe/host/t', clicks:5, people:5, is_unsubscribe:true}]
})
```

- [ ] **Step 2: Run** → FAIL (missing routes / fields).

- [ ] **Step 3: Implement**

`host-campaign-draft.js`: append `, audience_campaign_id` to `HOST_CAMPAIGN_LIST_COLUMNS`; add
```js
/** HOST-EMAILS.2 — subject for a copied/reminder draft, capped at the column's 200. */
export function copySubject(subject, prefix = 'Copy of ') {
  return (prefix + (subject || '')).slice(0, 200)
}
```

`[id]/route.js`:
```js
const CampaignUpdateSchema = z.object({
  ...existing fields...,
  audience_kind: z.enum(['all', 'event', 'mailing_list', 'non_openers']).optional(),
  audience_campaign_id: z.string().regex(UUIDISH).optional().nullable(),
})
```
In PATCH: `const kind = parsed.data.audience_kind || (...)`; if `kind === 'non_openers'`: require `parsed.data.audience_campaign_id` (400 "This reminder has no parent email.") and verify ownership with `db.from('host_campaigns').select('id').eq('id', parentId).eq('host_id', session.host.id).maybeSingle()` (error → 500; null → 404 "Parent email not found."); the update writes `audience_campaign_id: kind === 'non_openers' ? parentId : null` alongside the existing columns.
```js
// DELETE /api/host/emails/[id] — HOST-EMAILS.2. Only a draft or a scheduled
// email may go (CAS on status); a sent one is the record of what went out,
// and mig 594's trigger refuses it at the database too.
export async function DELETE(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const { data: rows, error } = await db
    .from('host_campaigns')
    .delete()
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .in('status', ['draft', 'scheduled'])
    .select('id')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: false, error: "Sent emails can't be deleted. They are the record of what went out." }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: { id: params.id } })
}
```

`[id]/duplicate/route.js`:
```js
// POST /api/host/emails/[id]/duplicate — HOST-EMAILS.2. A new draft copied from
// any of the host's campaigns: content, design, audience and type; never the
// schedule, counts or timestamps. Subject "Copy of …" capped at 200.
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HOST_CAMPAIGN_LIST_COLUMNS, copySubject } from '@/lib/host-campaign-draft'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
```
Handler: session → 401; read `id, subject, body_html, design_json, audience_kind, audience_event_id, audience_campaign_id, email_type` with `.eq('host_id')` (`{ data, error }`; error → 500; null → 404); insert `{ host_id, subject: copySubject(src.subject), body_html, design_json, audience_kind, audience_event_id, audience_campaign_id, email_type, status: 'draft' }` `.select(HOST_CAMPAIGN_LIST_COLUMNS).single()`; error → 500; return `{ success: true, data: row }`.

`[id]/reminder-draft/route.js`: same shape; parent read includes `status`; `status !== 'sent'` → 409 "Only a sent email can have a reminder."; insert `{ host_id, subject: copySubject(parent.subject, 'Reminder: '), body_html, design_json, audience_kind: 'non_openers', audience_event_id: null, audience_campaign_id: parent.id, email_type: parent.email_type, status: 'draft' }`; return the row.

`preview/route.js`:
```js
// POST /api/host/emails/preview — HOST-EMAILS.2. What a recipient would get:
// the same renderHostCampaignHtml the queue and the test send use (sanitizer,
// shell, footer), sample merge values, the inert unsubscribe token. Reads the
// host's sender name; stores nothing.
const Body = z.object({ subject: z.string().max(200).optional().default(''), body_html: z.string().min(1).max(300000) })
```
Handler: session → 401; parse JSON (400 'Invalid JSON'); `Body.safeParse` (400 'Add some content first.'); host read `id, name, sender_name, sender_email` (`{ data, error }`; error 500; null 404); `unsubscribeUrl` = `${baseUrl}/unsubscribe/host/test-token` via `getAppUrl()` in try/catch as send-test does; `sampleContact = { first_name: 'Sample', last_name: 'Recipient', name: 'Sample Recipient', email: session.email || 'sample@example.com' }`; `html = applyMergeTags(renderHostCampaignHtml({ host, subject, bodyHtml: body_html, unsubscribeUrl }), sampleContact, { unsubscribe_url: unsubscribeUrl })`; return `{ success: true, data: { html } }`.

List route (`route.js` GET): after the campaigns load, read the host once:
```js
  // HOST-EMAILS.2 — a 'sending' campaign the queue has halted is PAUSED;
  // say so instead of "Sending" forever. One host read for the whole list.
  const { data: hostRow, error: hostErr } = await db
    .from('event_hosts').select('sender_domain_verified, sender_email, postmark_stream_id').eq('id', session.host.id).maybeSingle()
  if (hostErr) return NextResponse.json({ success: false, error: hostErr.message }, { status: 500 })
```
and in the map add `paused_reason: campaign.status === 'sending' ? hostSendBlockReason(hostRow, campaign) : null` (restructure the `statsErr` ternary into one map that adds `stats` only when available).

Recipients route: same host read → `paused_reason`; for `status === 'sent'` compute `non_openers_count` in a try/catch via `resolveHostRecipients(db, session.host.id, { nonOpenersOf: campaign.id, emailType: campaign.email_type === 'utility' ? 'utility' : 'marketing' })` `.length` (null on throw, logged); `links` from
```js
  const clicksByUrl = new Map()
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await db.from('host_campaign_clicks').select('url, contact_id, send_id').eq('campaign_id', campaign.id).order('id').range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    for (const c of page || []) {
      const agg = clicksByUrl.get(c.url) || { url: c.url, clicks: 0, people: new Set(), is_unsubscribe: c.url.includes('/unsubscribe/host/') }
      agg.clicks += 1
      agg.people.add(c.contact_id || c.send_id)
      clicksByUrl.set(c.url, agg)
    }
    if (!page || page.length < PAGE) break
  }
  const links = [...clicksByUrl.values()]
    .map((l) => ({ url: l.url, clicks: l.clicks, people: l.people.size, is_unsubscribe: l.is_unsubscribe }))
    .sort((a, b) => (a.is_unsubscribe - b.is_unsubscribe) || (b.clicks - a.clicks) || a.url.localeCompare(b.url))
```
Return them in `data` next to `campaign` and `recipients` as `links`, and put `paused_reason` and `non_openers_count` on the campaign object.

OpenAPI: register the four paths after the `/api/host/emails/{id}/resend-missed` block (find it), and add to the recipients response campaign object `paused_reason: z.string().nullable().optional(), non_openers_count: z.number().int().nullable().optional()` plus a top-level `links: z.array(z.object({ url: z.string(), clicks: z.number().int(), people: z.number().int(), is_unsubscribe: z.boolean() }))`.

- [ ] **Step 4: Run** `npx vitest run src/app/api/host/emails src/lib/host-campaign-draft src/lib/openapi` and eslint on every touched path; `npm run check:route-guards && npm run check:location-scoping` → PASS.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/lib/host-campaign-draft.js src/lib/host-campaign-draft.test.js 'src/app/api/host/emails/[id]/route.js' 'src/app/api/host/emails/[id]/route.test.js' 'src/app/api/host/emails/[id]/duplicate' 'src/app/api/host/emails/[id]/reminder-draft' src/app/api/host/emails/preview src/app/api/host/emails/route.js 'src/app/api/host/emails/[id]/recipients' src/lib/openapi.js
git commit -m "HOST-EMAILS.2 — delete, duplicate, reminder-draft and preview routes; paused_reason, non_openers_count and links on the read routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Composer

**Files:** `src/components/host/HostEmails.jsx`, `src/components/host/HostEmails.test.jsx`, `src/app/host/(portal)/emails/page.js`

Behaviour (spec §4, §5, §6, §8, §2):
1. A designed draft always opens in design mode; the design is held in `pendingDesignRef` until the editor is initialised, then loaded. "Edit as text instead" (confirm) drops it on purpose.
2. "Preview as sent" beside Save opens a modal with a sandboxed iframe and a Mobile/Desktop toggle.
3. Every row gets "Duplicate"; draft and scheduled rows get "Delete" (confirm). Sending rows get neither.
4. A `non_openers` draft shows a fixed audience line instead of the select and saves `audience_kind: 'non_openers'` + `audience_campaign_id`.
5. A paused sending row's subline says so.
6. On mount, `?notice=reminder` in the URL shows "Reminder draft created. Edit it, test it, then send or schedule." (the report page navigates here after creating one).

- [ ] **Step 1: Failing tests** (pure helpers, the file's convention). Append to `HostEmails.test.jsx`:
```js
import { rowSubline, audienceSummary, sendConfirmCopy } from './HostEmails.jsx'

describe('rowSubline — paused (HOST-EMAILS.2)', () => {
  it('a sending row with a paused_reason says why and who to ask', () => {
    expect(rowSubline({ status: 'sending', paused_reason: 'no_stream' })).toBe('Paused. Marketing sending is not set up yet. Ask UN1T.')
  })
  it('a sending row without a reason keeps the stats line fallback', () => {
    expect(rowSubline({ status: 'sending', sent_count: 3, recipient_count: 10 })).toBe('3/10 sent')
  })
})

describe('audienceSummary', () => {
  const byId = new Map([['p1', { id: 'p1', subject: 'Race week' }]])
  it('names the parent for a reminder draft', () => {
    expect(audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: 'p1' }, byId)).toBe("People who didn't open 'Race week'")
  })
  it('falls back when the parent is gone', () => {
    expect(audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: 'zz' }, byId)).toBe("People who didn't open the original email")
  })
  it('is empty for ordinary audiences (the select shows those)', () => {
    expect(audienceSummary({ audience_kind: 'all' }, byId)).toBe('')
  })
})

describe('sendConfirmCopy', () => {
  it('reminder drafts confirm against the parent subject', () => {
    expect(sendConfirmCopy({ audience_kind: 'non_openers', audience_campaign_id: 'p1', email_type: 'marketing' }, 'attendees', new Map([['p1', { subject: 'Race week' }]])))
      .toBe("Send this email to people who didn't open 'Race week'?")
  })
  it('ordinary drafts keep the audience label and the utility note', () => {
    expect(sendConfirmCopy({ audience_kind: 'all', email_type: 'utility' }, 'all 10 contacts (where emailable)', new Map()))
      .toBe('Send this email to all 10 contacts (where emailable) as a UTILITY email (reaches attendees regardless of marketing opt-in)?')
  })
})
```

- [ ] **Step 2: Run** → FAIL (exports missing).

- [ ] **Step 3: Implement** in `HostEmails.jsx`

(a) Imports: add `useMemo` to the react import and `import { useSearchParams } from 'next/navigation'`. (`scheduleErrorCopy` is already imported.)

(b) Exported helpers, after `rowSubline`:
```js
/** HOST-EMAILS.2 — fixed audience line for a reminder draft; '' otherwise. */
export function audienceSummary(c, campaignsById) {
  if (c?.audience_kind !== 'non_openers') return ''
  const parent = campaignsById?.get(c.audience_campaign_id)
  return parent?.subject ? `People who didn't open '${parent.subject}'` : "People who didn't open the original email"
}

/** The Send confirm text, per audience kind. */
export function sendConfirmCopy(c, audienceLabelText, campaignsById) {
  const typeNote = c?.email_type === 'utility' ? ' as a UTILITY email (reaches attendees regardless of marketing opt-in)' : ''
  if (c?.audience_kind === 'non_openers') return `Send this email to ${audienceSummary(c, campaignsById).replace(/^People/, 'people')}${typeNote}?`
  return `Send this email to ${audienceLabelText}${typeNote}?`
}
```
and in `rowSubline`, before the `if (c.status === 'draft')` branch:
```js
  if (c.status === 'sending' && c.paused_reason) return `Paused. ${scheduleErrorCopy(c.paused_reason)}. Ask UN1T.`
```

(c) State additions (next to the others): `const [audienceCampaignId, setAudienceCampaignId] = useState(null)` (the parent id when editing a reminder draft, else null), `const pendingDesignRef = useRef(null)`, `const [designerNotice, setDesignerNotice] = useState('')` ('' | 'loading' | 'failed'), `const [designDropped, setDesignDropped] = useState(false)`, `const [preview, setPreview] = useState(null)` (`{ html, width }` or null), `const [previewBusy, setPreviewBusy] = useState(false)`, `const [rowBusyId, setRowBusyId] = useState(null)` (delete/duplicate in flight), and `const campaignsById = useMemo(() => new Map((campaigns || []).map((c) => [c.id, c])), [campaigns])`.

Notice from the URL: `const searchParams = useSearchParams()` and
```js
  useEffect(() => {
    if (searchParams?.get('notice') === 'reminder') setNotice('Reminder draft created. Edit it, test it, then send or schedule.')
  }, [searchParams])
```
(`useSearchParams` needs a Suspense boundary in the App Router: `src/app/host/(portal)/emails/page.js` must wrap `<HostEmails />` in `<Suspense fallback={null}>`; add the import and wrapper there.)

(d) Script load: `onError` becomes `() => { setDesignerNotice('failed'); if (!pendingDesignRef.current) setMode('text') }`.

(e) Init effect: after `editorInited.current = true` add:
```js
    if (pendingDesignRef.current) {
      try { window.unlayer.loadDesign(pendingDesignRef.current) } catch { /* stale design doc */ }
      pendingDesignRef.current = null
      setDesignerNotice('')
    }
```
Also add a second effect: when `unlayerReady` flips true and `editorInited.current` is already true and a pending design exists (the editor was initialised before the draft was opened), load it the same way.

(f) `editDraft`: replace the `if (c.design_json && unlayerReady && window.unlayer) {...} else {...}` block with:
```js
      setAudienceCampaignId(c.audience_kind === 'non_openers' ? c.audience_campaign_id || null : null)
      setDesignDropped(false)
      if (c.design_json) {
        // HOST-EMAILS.2 — a designed draft ALWAYS opens in design mode. If the
        // designer is not up yet the design waits in pendingDesignRef and
        // loads the moment the editor initialises; text mode is only ever
        // reached through "Edit as text instead".
        setMode('design')
        setTextBody(c.body_html || '')
        if (editorInited.current && window.unlayer) {
          try { window.unlayer.loadDesign(c.design_json) } catch { /* stale design doc */ }
          setDesignerNotice('')
        } else {
          pendingDesignRef.current = c.design_json
          setDesignerNotice(designerNotice === 'failed' ? 'failed' : 'loading')
        }
      } else {
        setMode('text')
        setTextBody(c.body_html || '')
      }
```
`resetComposer` also clears `pendingDesignRef.current = null`, `setDesignerNotice('')`, `setDesignDropped(false)`, `setAudienceCampaignId(null)`.

(g) `dropDesign()`:
```js
  function dropDesign() {
    if (!window.confirm('This drops the saved design and keeps only the HTML.')) return
    pendingDesignRef.current = null
    setDesignerNotice('')
    setDesignDropped(true)
    setMode('text')
  }
```
In the JSX, inside the `mode === 'design'` container, replace the `{!unlayerReady && (<p>Loading the designer…</p>)}` with:
```jsx
                  {(!unlayerReady || designerNotice) && (
                    <div className="p-4 text-sm text-white/60">
                      <p>{designerNotice === 'failed' ? 'The designer could not load. Reload the page, or edit as text (this drops the design).' : 'Loading the designer…'}</p>
                      {(pendingDesignRef.current || designerNotice === 'failed') && (
                        <button type="button" onClick={dropDesign} className="mt-2 text-xs underline text-white/70 hover:text-white">Edit as text instead</button>
                      )}
                    </div>
                  )}
```
The "Plain text" mode button: when a design is loaded or pending, route it through `dropDesign` instead of `setMode('text')` directly (`onClick={() => (pendingDesignRef.current || (editingId && mode === 'design' && !designDropped) ? dropDesign() : setMode('text'))}`).

(h) `saveDraft` payload: `audience_kind` becomes
```js
        audience_kind: audienceCampaignId ? 'non_openers' : (audienceEventId === '__mailing_list__' ? 'mailing_list' : (audienceEventId ? 'event' : 'all')),
        audience_event_id: audienceCampaignId ? null : (audienceEventId && audienceEventId !== '__mailing_list__' ? audienceEventId : null),
        audience_campaign_id: audienceCampaignId,
```
`design_json` stays `designJson` (null in text mode: by then the drop was explicit).

(i) Preview:
```js
  async function previewAsSent() {
    setError('')
    setPreviewBusy(true)
    try {
      let body = textBody
      if (mode === 'design') {
        const exported = await exportDesign()
        body = exported.html || ''
      }
      if (!body.trim()) { setError('Add some content first.'); return }
      const res = await fetch('/api/host/emails/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body_html: body }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'Could not build the preview.'); return }
      setPreview({ html: json.data.html, width: 375 })
    } catch {
      setError('Could not build the preview.')
    } finally {
      setPreviewBusy(false)
    }
  }
```
Beside the Save button:
```jsx
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save draft'}</button>
            <button type="button" onClick={previewAsSent} disabled={previewBusy} className={btnSecondary}>
              {previewBusy ? 'Building…' : 'Preview as sent'}
            </button>
          </div>
```
Modal, rendered at the end of the component's root `<div>`:
```jsx
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Preview as sent">
          <div className="bg-[#111] border border-white/15 rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10">
              <p className="text-sm text-white/70">This is what a recipient gets, including the unsubscribe footer.</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setPreview((p) => ({ ...p, width: 375 }))} aria-pressed={preview.width === 375} className={`rounded px-2 py-1 text-xs ${preview.width === 375 ? 'bg-white text-black' : 'text-white/60'}`}>Mobile</button>
                <button type="button" onClick={() => setPreview((p) => ({ ...p, width: 700 }))} aria-pressed={preview.width === 700} className={`rounded px-2 py-1 text-xs ${preview.width === 700 ? 'bg-white text-black' : 'text-white/60'}`}>Desktop</button>
                <button type="button" onClick={() => setPreview(null)} className="text-xs text-white/60 hover:text-white px-2 py-1">Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[#f4f4f5] flex justify-center p-4">
              <iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: preview.width, height: '75vh', border: 0, background: '#fff' }} />
            </div>
          </div>
        </div>
      )}
```

(j) Delete / duplicate:
```js
  async function deleteCampaign(c) {
    if (!window.confirm(`Delete "${c.subject}"? This cannot be undone.`)) return
    setError(''); setNotice(''); setRowBusyId(c.id)
    try {
      const res = await fetch(`/api/host/emails/${c.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'Could not delete the email.'); await load(); return }
      if (editingId === c.id) resetComposer()
      setNotice('Email deleted.')
      await load()
    } catch { setError('Could not delete the email.') } finally { setRowBusyId(null) }
  }

  async function duplicateCampaign(c) {
    setError(''); setNotice(''); setRowBusyId(c.id)
    try {
      const res = await fetch(`/api/host/emails/${c.id}/duplicate`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'Could not duplicate the email.'); return }
      setNotice(`Draft created: ${json.data?.subject || 'Copy'}.`)
      await load()
    } catch { setError('Could not duplicate the email.') } finally { setRowBusyId(null) }
  }
```
Row JSX: after the draft action group and the scheduled action group, add a third, muted group rendered for every status except `sending`:
```jsx
                    {c.status !== 'sending' && (
                      <div className="shrink-0 flex items-center gap-2">
                        <button type="button" onClick={() => duplicateCampaign(c)} disabled={rowBusyId === c.id} className="text-xs text-white/50 hover:text-white disabled:opacity-50">Duplicate</button>
                        {(c.status === 'draft' || c.status === 'scheduled') && (
                          <button type="button" onClick={() => deleteCampaign(c)} disabled={rowBusyId === c.id} className="text-xs text-red-300/80 hover:text-red-300 disabled:opacity-50">
                            {rowBusyId === c.id ? 'Working…' : 'Delete'}
                          </button>
                        )}
                      </div>
                    )}
```
Keep the existing groups; wrap the right-hand side in one `flex items-center gap-3` container so the groups sit together.

(k) Audience: in the form, replace the `<select id="host-email-audience">` block with:
```jsx
              {audienceCampaignId ? (
                <p id="host-email-audience" className={`${input} text-white/70`}>
                  {audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: audienceCampaignId }, campaignsById)}
                  <span className="block text-[11px] text-white/40 mt-0.5">Resolved when you send: anyone who has opened since then is left out. Duplicate this email to pick a different audience.</span>
                </p>
              ) : (
                <select …existing select unchanged… />
              )}
```
`send`: change the signature to `send(c)` and the confirm to `window.confirm(sendConfirmCopy(c, audienceLabel(c.audience_kind === 'mailing_list' ? '__mailing_list__' : (c.audience_event_id || '')), campaignsById))`; update the one call site. In the row JSX add, inside the subline `<p>`, `{c.audience_kind === 'non_openers' && <span className="text-white/35"> · {audienceSummary(c, campaignsById)}</span>}`.

- [ ] **Step 4: Run** `npx vitest run src/components/host/HostEmails.test.jsx && npx eslint src/components/host/HostEmails.jsx src/components/host/HostEmails.test.jsx 'src/app/host/(portal)/emails/page.js'` → PASS, clean. No em-dashes in new copy.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/components/host/HostEmails.jsx src/components/host/HostEmails.test.jsx 'src/app/host/(portal)/emails/page.js'
git commit -m "HOST-EMAILS.2 — composer: pending design loading, preview as sent, delete/duplicate, reminder audience, paused subline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Report

**Files:** `src/components/host/HostEmailReport.jsx`, `src/components/host/HostEmailReport.test.jsx`

- [ ] **Step 1: Failing tests** (the file has render tests with a mocked fetch; follow them):
```js
import { reminderLabel, reminderConfirmCopy, pausedCopy } from './HostEmailReport.jsx'

describe('reminder + paused helpers (HOST-EMAILS.2)', () => {
  it('reminderLabel', () => {
    expect(reminderLabel(12)).toBe("Send a reminder to 12 who didn't open")
    expect(reminderLabel(1)).toBe("Send a reminder to 1 who didn't open")
  })
  it('reminderConfirmCopy warns under 24h', () => {
    const now = Date.parse('2026-09-07T12:00:00Z')
    expect(reminderConfirmCopy(12, '2026-09-07T10:00:00Z', now)).toContain('Opens keep arriving for a day or two.')
    expect(reminderConfirmCopy(12, '2026-09-05T10:00:00Z', now)).not.toContain('Opens keep arriving')
    expect(reminderConfirmCopy(12, '2026-09-05T10:00:00Z', now)).toBe("Create a reminder draft for the 12 people who didn't open this email? You can edit it before sending.")
  })
  it('pausedCopy', () => {
    expect(pausedCopy('sender_not_verified')).toBe('Paused. Sending is not enabled yet. Ask UN1T.')
    expect(pausedCopy(null)).toBe('')
  })
})

// render tests, in the existing describe:
it('a paused sending campaign shows the paused line instead of "Still sending"', ...)   // fixture: status 'sending', paused_reason 'no_stream'
it('links render clicks and people per url with the unsubscribe link labelled', ...)   // fixture links: [{url:'https://a', clicks:3, people:2, is_unsubscribe:false}, {url:'https://x/unsubscribe/host/t', clicks:5, people:5, is_unsubscribe:true}] → text 'https://a', '3', '2', 'Unsubscribe link'
it('sent campaign with non_openers_count shows the reminder button; 0 or null hides it', ...)
```
`next/navigation`'s `useRouter` must be mocked in the render tests: `vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

Exports (near `resendLabel`):
```js
import { scheduleErrorCopy } from '@/lib/host-schedule-time'
import { useRouter } from 'next/navigation'

export function reminderLabel(count) { return `Send a reminder to ${count} who didn't open` }
export function reminderConfirmCopy(count, sentAt, nowMs = Date.now()) {
  const base = `Create a reminder draft for the ${count} people who didn't open this email? You can edit it before sending.`
  const sentMs = sentAt ? Date.parse(sentAt) : NaN
  const young = Number.isFinite(sentMs) && nowMs - sentMs < 24 * 3600 * 1000
  return young ? `${base} Opens keep arriving for a day or two. A reminder this soon reaches people who may simply not have got to it yet.` : base
}
export function pausedCopy(reason) { return reason ? `Paused. ${scheduleErrorCopy(reason)}. Ask UN1T.` : '' }
```
State: `const [links, setLinks] = useState([])` set from `json.data?.links || []` in the loader; `const [reminding, setReminding] = useState(false)`; `const router = useRouter()`.
```js
  async function createReminder() {
    if (!campaign) return
    if (!window.confirm(reminderConfirmCopy(campaign.non_openers_count, campaign.sent_at))) return
    setReminding(true); setActionError('')
    try {
      const res = await fetch(`/api/host/emails/${campaignId}/reminder-draft`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setActionError(json.error || 'Could not create the reminder.'); return }
      router.push('/host/emails?notice=reminder')
    } catch { setActionError('Could not create the reminder.') } finally { setReminding(false) }
  }
```
Header: next to the resend button, `canRemind = campaign?.status === 'sent' && Number(campaign?.non_openers_count) > 0` → a second button styled like the resend one but `border border-white/25 text-white` with `reminderLabel(campaign.non_openers_count)` ('Creating…' while busy). Replace the `Still sending` line with:
```jsx
        {campaign?.status === 'sending' && (
          <p className="text-amber-300 text-xs mt-2">
            {campaign.paused_reason ? pausedCopy(campaign.paused_reason) : 'Still sending, numbers update as it goes.'}
          </p>
        )}
```
Links section, between the tiles and the filter chips:
```jsx
      {links.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-2">Links</h2>
          <div className="rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                  <th className="px-3 py-2 font-medium">Link</th>
                  <th className="px-3 py-2 font-medium text-right">Clicks</th>
                  <th className="px-3 py-2 font-medium text-right">People</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.url} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2 max-w-[28rem] truncate text-white/80" title={l.url}>{l.is_unsubscribe ? 'Unsubscribe link' : l.url}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.clicks}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.people}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-white/35 mt-1">Security scanners open every link within seconds of delivery, so counts include them.</p>
        </section>
      )}
```

- [ ] **Step 4: Run** `npx vitest run src/components/host/HostEmailReport && npx eslint src/components/host/HostEmailReport.jsx src/components/host/HostEmailReport.test.jsx` → PASS, clean.

- [ ] **Step 5: Commit** (controller)

```bash
git add src/components/host/HostEmailReport.jsx src/components/host/HostEmailReport.test.jsx
git commit -m "HOST-EMAILS.2 — report: paused line, reminder to non-openers, links breakdown

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Changelog, CI mirror, build, PR, click backfill

- [ ] **Step 1: Changelog row** under the table header in `docs/CHANGELOG.md`:
```
| #<PR> | HOST-EMAILS.2 — host email polish | mig 594 (applied): `non_openers` audience + `audience_campaign_id`, `host_campaign_clicks`, delete guard trigger. Contacts page/CSV say why a contact is not emailable. Paused campaigns (sender unverified / no stream) say so on the list and report via one `hostSendBlockReason`. Delete (draft/scheduled) + duplicate; reminder-to-non-openers draft from the report; the composer waits for the designer instead of dropping a design; sanitizer keeps scrubbed `<style>` + a canonical viewport meta and "Preview as sent" renders through the real path; per-link clicks on the report. Unsubscribe page now confirms before writing (a scanner opted 3 people out on 7 Sep). Spec `docs/superpowers/specs/2026-09-07-host-email-polish-design.md`. |
```
- [ ] **Step 2: CI mirror** (command at the top) → all green.
- [ ] **Step 3: `npm run build`** → green; the four new routes appear.
- [ ] **Step 4: Push, PR** (`gh pr create`, body per the spec's table, ends with the Generated-with line), fill the PR number into the changelog row, amend, force-with-lease.
- [ ] **Step 5: After merge, click backfill by hand** (controller): rerun the 7 Sep one-off script with `foldClickEvents` and emit `insert into host_campaign_clicks … on conflict (send_id, url, clicked_at) do nothing` via the Supabase MCP, joining `send_id`/`contact_id` from `host_campaign_sends` by `(campaign_id, contact_id)`.
