# Campaign Resend to Non-Openers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-scheduled resend of a marketing email campaign to recipients who didn't open it, configured at compose time, spawned by cron as a child campaign.

**Architecture:** Four new columns on `campaigns` mark a parent's resend intent and a child's parentage. The 2-minute `run-campaigns` cron spawns the child once the parent is `sent` and the wait elapses; a new populate branch in `campaign-sender.js` builds the child's recipients from the parent's non-openers re-intersected with `contact_location_audience`. Resends bypass the marketing frequency cap. Spec: `docs/superpowers/specs/2026-08-08-campaign-resend-nonopeners-design.md`.

**Tech Stack:** Next.js 16 route handlers, Supabase (mig 506 via MCP), vitest with the chainable-thenable fake-db pattern from `src/lib/campaign-sender.test.js`.

---

### Task 1: Migration 506 — resend columns

**Files:**
- Create: `supabase/migrations/506_campaign_resend_nonopeners.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 506 — CAMPAIGN-RESEND: auto-resend a marketing campaign to non-openers.
--
-- Configured at compose time (resend_enabled + resend_wait_hours +
-- optional resend_subject on the PARENT). Once the parent reaches
-- status='sent' and the wait elapses, run-campaigns spawns a CHILD
-- campaigns row (parent_campaign_id set) whose populate step resolves
-- the parent's non-openers at the last moment, re-checked against
-- contact_location_audience. One resend per campaign, DB-enforced by
-- the partial unique index. Marketing (broadcast) stream only — the
-- outbound stream has open tracking off by design, app-enforced.

ALTER TABLE campaigns
  ADD COLUMN parent_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN resend_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN resend_wait_hours INTEGER,
  ADD COLUMN resend_subject TEXT,
  ADD CONSTRAINT campaigns_resend_wait_hours_check
    CHECK (resend_wait_hours IS NULL OR (resend_wait_hours >= 1 AND resend_wait_hours <= 168));

-- One resend per campaign; also the race guard for concurrent cron ticks.
CREATE UNIQUE INDEX campaigns_one_resend_per_parent
  ON campaigns (parent_campaign_id) WHERE parent_campaign_id IS NOT NULL;

-- The spawn scan: parents flagged for resend, filtered further in app code.
CREATE INDEX idx_campaigns_resend_pending
  ON campaigns (sent_at) WHERE resend_enabled = true AND status = 'sent';

COMMENT ON COLUMN campaigns.parent_campaign_id IS 'Set on a resend child: the campaign this is a resend of (non-openers only).';
COMMENT ON COLUMN campaigns.resend_wait_hours IS 'Hours after sent_at before the non-opener resend spawns.';
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, project un1t-crm `iyvtbjjxdggiadzwwvdj`)
- [ ] **Step 3: `get_advisors` both types** — expect no new warnings
- [ ] **Step 4: Commit** `git commit -m "feat: mig 506 — campaign resend-to-non-openers columns"`

### Task 2: `src/lib/campaign-resend.js` — spawn + audience logic (TDD)

**Files:**
- Create: `src/lib/campaign-resend.js`
- Test: `src/lib/campaign-resend.test.js` (fake-db pattern copied from `campaign-sender.test.js` — `makeDb(route)` Proxy recorder)

Exports:

```js
export const RESEND_MIN_WAIT_HOURS = 1
export const RESEND_MAX_WAIT_HOURS = 168
export const NON_OPENER_STATUSES = ['sent', 'delivered']

// Subject the child sends with: explicit resend_subject wins, else the
// parent's effective subject (A/B winner variant when the parent tested).
export function resolveResendSubject(parent)

// True when parent is due to spawn: resend_enabled, status 'sent', not
// itself a child, broadcast stream, sent_at + wait elapsed.
export function isResendDue(parent, now = new Date())

// The child campaigns row cloned from the parent (no insert).
export function buildResendChildRow(parent)

// Paged: contact_ids from parent's campaign_recipients where
// opened_at IS NULL AND status IN NON_OPENER_STATUSES.
export async function loadNonOpenerContactIds(db, parentCampaignId)

// Called once per cron tick BEFORE the send ticks. Finds due parents,
// re-checks the org email cap (parity with the promote step), counts
// non-openers (zero → just clear the flag), inserts the child
// (status='queued'), clears parent.resend_enabled. 23505 on the child
// insert = another tick won → still clear the flag. Returns summary.
export async function spawnDueResends(db, { getCapStatus } = {})
```

Key implementation points:
- `isResendDue`: `parent.resend_enabled === true && parent.status === 'sent' && !parent.parent_campaign_id && parent.postmark_stream !== 'outbound' && parent.sent_at && Date.now-style compare: new Date(parent.sent_at).getTime() + (parent.resend_wait_hours || 0) * 3_600_000 <= now.getTime()` — a null/0 wait never spawns (`resend_wait_hours >= 1` guard).
- `buildResendChildRow(parent)` clones: `location_id, from_name, from_email, reply_to, preview_text, html_content, design_json, template_id, postmark_stream, created_by`; sets `name: \`${parent.name} (resend)\``, `subject: resolveResendSubject(parent)`, `audience_filter: parent.audience_filter` (informational — populate ignores it for children), `parent_campaign_id: parent.id`, `status: 'queued'`. A/B columns NOT cloned.
- `resolveResendSubject`: `parent.resend_subject` if non-empty; else if `parent.ab_subject_b && parent.ab_winner === 'b'` → `parent.ab_subject_b`; else `parent.subject`.
- `spawnDueResends` query: `.from('campaigns').select('*').eq('resend_enabled', true).eq('status', 'sent').is('parent_campaign_id', null).not('sent_at', 'is', null)` then filter `isResendDue` in JS (hours arithmetic in PostgREST is awkward). Page size 100 is plenty.
- Non-opener count per parent: `select('id', { count: 'exact', head: true })` on `campaign_recipients` with the non-opener predicate. Zero → `update({ resend_enabled: false })`, continue.
- Cap check via injected `getCapStatus` (defaults to `getEmailCapStatus` from `./usage-caps.js`); capped → skip (stays flagged, retries next tick), like the promote hold.
- `loadNonOpenerContactIds`: loop `.select('contact_id').eq('campaign_id', id).is('opened_at', null).in('status', NON_OPENER_STATUSES).order('id').range(from, from+999)` until short page (repo 1k-row cap rule).

- [ ] **Step 1: Write failing tests** covering: due/not-due matrix (disabled, wrong status, child, outbound, wait not elapsed, no sent_at), subject resolution (explicit / A/B winner b / winner a / plain), child row shape (A/B cols absent, status queued), spawn zero-non-openers clears flag without insert, spawn inserts child then clears flag, 23505 conflict still clears flag, capped org skips untouched, pagination >1000 ids
- [ ] **Step 2: Run** `npx vitest run src/lib/campaign-resend.test.js` — expect FAIL (module missing)
- [ ] **Step 3: Implement** `src/lib/campaign-resend.js`
- [ ] **Step 4: Run again** — expect PASS
- [ ] **Step 5: Commit** `feat: campaign-resend lib — spawn + non-opener resolution`

### Task 3: campaign-sender populate branch + freq-cap bypass (TDD)

**Files:**
- Modify: `src/lib/campaign-sender.js` (populate block ~lines 132–204; `capActive` line 118)
- Test: extend `src/lib/campaign-sender.test.js`

- [ ] **Step 1: Failing tests** in a new `describe('resend child campaigns')`: (a) populate for a campaign with `parent_campaign_id` reads parent `campaign_recipients` + `contact_location_audience`, NOT `buildAudienceQueryAsync`; inserts only ids surviving the view intersect; (b) view gates asserted: `audience_location_id`, `loc_email_marketing=true`, `email_status not in bounced/complained`, `email_suppressed_at is null`; (c) `capActive` false for a child even with cap enabled in location settings (queued fetch has no `.or(last_marketing_touch_at…)` op) while `stampMarketingTouch` still fires on success
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement.** In `tickCampaignSend`:

```js
// line ~118
const capActive = stream === 'broadcast' && capSetting.enabled && !campaign.parent_campaign_id
```

In the `(existingCount || 0) === 0` block, branch before the audience loop:

```js
if (campaign.parent_campaign_id) {
  // CAMPAIGN-RESEND — the child's audience is the parent's non-openers,
  // re-intersected with contact_location_audience at populate time so
  // consent / suppression / bounces since the original send are honoured.
  // (Query the VIEW, never inner-join around it — LOCCOMMS invariant.)
  const ids = await loadNonOpenerContactIds(db, campaign.parent_campaign_id)
  for (let i = 0; i < ids.length; i += AUDIENCE_PAGE_SIZE) {
    const chunk = ids.slice(i, i + AUDIENCE_PAGE_SIZE)
    const { data, error } = await db
      .from('contact_location_audience')
      .select('id')
      .eq('audience_location_id', campaign.location_id)
      .eq('loc_email_marketing', true)
      .not('email_status', 'in', '("bounced","complained")')
      .is('email_suppressed_at', null)
      .in('id', chunk)
    if (error) return { phase: 'populate', error: `resend audience load failed: ${error.message}` }
    contacts.push(...(data || []))
  }
} else { /* existing buildAudienceQueryAsync loop */ }
```

(`contacts` only ever uses `.id` downstream in populate — recipient rows are `{ campaign_id, contact_id, status }` — so `select('id')` is sufficient. A/B assignment is skipped naturally: children never have `ab_subject_b`.)

- [ ] **Step 4: Run — PASS**, then full `npx vitest run src/lib/campaign-sender.test.js`
- [ ] **Step 5: Commit** `feat: resend-child populate + frequency-cap bypass in campaign sender`

### Task 4: Cron wiring

**Files:**
- Modify: `src/app/api/cron/run-campaigns/route.js` (after the promote step, before fair pick)
- Test: `src/lib/campaign-resend.test.js` already covers spawn; add a light route test only if the file grows a route test later (none exists today — skip).

- [ ] **Step 1:** Import `spawnDueResends`; insert between STEP 1 and STEP 2:

```js
// STEP 1b — spawn due non-opener resends (CAMPAIGN-RESEND, mig 506).
try {
  const resends = await spawnDueResends(db)
  summary.resends_spawned = resends.spawned
} catch (err) {
  console.error('[cron run-campaigns] resend spawn failed:', err?.message)
}
```

- [ ] **Step 2:** Full campaign test files pass; **Step 3: Commit** `feat: spawn non-opener resends from run-campaigns cron`

### Task 5: email-draft route accepts resend config (TDD)

**Files:**
- Modify: `src/app/api/communications/email-draft/route.js`
- Test: create `src/app/api/communications/email-draft/route.test.js` (mock `@/lib/auth`, `@/lib/permissions`, `@/lib/supabase` per neighbouring route tests, e.g. `src/app/api/campaigns/[id]/send/route.test.js`)

- [ ] **Step 1: Failing tests:** resend fields persisted on the inserted row for marketing; `resend_enabled` with `email_type:'utility'` → 400; `resend_enabled` without valid `resend_wait_hours` → 400; wait bounds 1..168 enforced by zod
- [ ] **Step 2 — FAIL**, **Step 3: Implement:**

```js
// Schema additions
resend_enabled: z.boolean().optional(),
resend_wait_hours: z.number().int().min(1).max(168).optional(),
resend_subject: z.string().max(500).optional(),
```

After the schedule guard:

```js
// CAMPAIGN-RESEND — marketing only (outbound has no open tracking), and a
// wait is required so the spawn check has a real deadline.
if (resend_enabled) {
  if (email_type === 'utility') {
    return NextResponse.json({ success: false, error: 'Resend to non-openers is only available for marketing emails' }, { status: 400 })
  }
  if (!resend_wait_hours) {
    return NextResponse.json({ success: false, error: 'resend_wait_hours is required when resend is enabled' }, { status: 400 })
  }
}
```

Row additions: `...(resend_enabled ? { resend_enabled: true, resend_wait_hours, resend_subject: resend_subject || null } : {})`

- [ ] **Step 4 — PASS**; **Step 5: Commit** `feat: email-draft accepts resend-to-non-openers config`

### Task 6: Composer UI

**Files:**
- Modify: `src/components/communications/UnifiedSendComposer.jsx`

- [ ] **Step 1:** State: `resendEnabled` (false), `resendWaitHours` (48), `resendSubject` (''). New `<Section title="Follow-up" …>` rendered only when `channel === 'email' && emailType === 'marketing'`, between Message and When: checkbox "Resend to people who don't open", preset pills 24h/48h/72h + numeric input (1–168), optional new-subject input with helper "A fresh subject usually lifts second-send opens. Leave blank to reuse the original.", amber warning when `resendWaitHours < 24` ("Opens are still arriving — resending this early reaches people who just haven't got to it yet."), footnote "Counts undercount slightly: some inboxes preload images, so a few openers look unopened and vice versa." Send payload adds `...(emailType === 'marketing' && resendEnabled ? { resend_enabled: true, resend_wait_hours: Number(resendWaitHours), ...(resendSubject.trim() ? { resend_subject: resendSubject.trim() } : {}) } : {})`. Reset() clears the three states. Result screen: when resend was enabled append "A resend to non-openers goes out ~Nh after this send completes."
- [ ] **Step 2:** `npm run lint` on the file; **Step 3: Commit** `feat: resend-to-non-openers section in unified composer`

### Task 7: Cancel route + detail/list visibility

**Files:**
- Create: `src/app/api/campaigns/[id]/resend/route.js` (session-authed DELETE — mirrors `[id]/send/route.js` auth: `getCurrentUser` + `assertLocationAccessOr404`; clears `resend_enabled` where still true; 409 if a child already exists)
- Test: `src/app/api/campaigns/[id]/resend/route.test.js`
- Modify: `src/app/email/campaigns/[id]/page.js` (fetch child = `campaigns.select('id,name,status').eq('parent_campaign_id', id).maybeSingle()`; parent name when `campaign.parent_campaign_id`; pass both to CampaignDetail)
- Modify: `src/components/CampaignDetail.jsx` (banner card on overview: pending → "Resend to non-openers scheduled for ~{sent_at + wait} · Cancel resend" button calling `DELETE /api/campaigns/{id}/resend` then `router.refresh()`; child exists → link card "Resent to non-openers → {child.name}"; child campaign → header sub-line "Resend of {parentName}" linking back)
- Modify: `src/app/communications/sent/page.js` (add `parent_campaign_id, resend_enabled` to the campaigns select; child rows show a small "Resend" chip `bg-un1t-border/40 text-un1t-subtle`; parents with `resend_enabled && status==='sent'` show "resend scheduled" hint text)

- [ ] **Step 1: Failing route test:** unauthenticated 401; clears flag → 200; child already exists → 409; foreign location → 404
- [ ] **Step 2 — FAIL → implement → PASS**
- [ ] **Step 3: Commit** `feat: resend cancel route + campaign detail/list visibility`

### Task 8: Verification + PR

- [ ] **Step 1:** `npm test` — full suite green
- [ ] **Step 2:** `npm run lint` + `npm run check:route-guards` + `npm run check:location-scoping` + `npm run check:guardrails`
- [ ] **Step 3:** `get_advisors` re-check clean; update `docs/CHANGELOG.md` (next entry number) 
- [ ] **Step 4:** Push branch, `gh pr create` against main with summary + test plan
