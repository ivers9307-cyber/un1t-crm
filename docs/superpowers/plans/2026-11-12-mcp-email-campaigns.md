# Email campaigns from an agent (MCPEMAIL.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person with the `email` permission and Connect an Agent drafts a campaign, picks its audience and timing from Claude, gets a test in their own inbox, and releases it by pressing a button on a signed-in CRM confirm page.

**Architecture:** Nine new tools in `src/lib/agent-tools/` create and edit ordinary `campaigns` rows; the body is a block list the server renders to HTML. No tool can change a campaign's status to a send state. `send_email_for_approval` stores a content-bound, person-bound, timing-bound approval and emails a link; a new session route behind a confirm page consumes it and runs the one shared release function that the existing send and schedule routes are refactored onto.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), zod 4, vitest, `mcp-handler` (unchanged), Postmark via `src/lib/postmark.js`.

**Spec:** [`docs/superpowers/specs/2026-11-12-mcp-email-campaigns-design.md`](../specs/2026-11-12-mcp-email-campaigns-design.md). Read it first; this plan does not repeat its reasoning.

## Global Constraints

- Work in the worktree `~/code/un1t-crm-mcp-email`, branch `mcp-email-campaigns`. Before the first task: `git fetch origin main && git merge origin/main`, `npm ci`, and re-check the next free migration number (`ls supabase/migrations | tail -1`; 827 at planning time).
- Every tool: `defineTool`, `studio_id: uuidLike.optional()`, gate `(user, studioId) => hasPermissionForLocation(user, studioId, 'email')`, studio and person from `ctx` only (two-doors invariant). None is added to `BRIDGED_TOOL_NAMES`.
- No tool file names an `email_*` table. Every `.from()` in a tool file carries `.eq('location_id', studio.id)` (or an `.in('id', …)` of ids already scoped). `tests/agent-tools-guard.test.js` is not weakened.
- No tool writes `campaigns.status` to `queued` or `scheduled`. Only `releaseCampaign` (Task 3) does, and only routes call it.
- `postmark_stream` is always `'broadcast'`; `from_email` is never set by a tool; `ab_*` are never set.
- Limits, verbatim from the spec: blocks ≤ 60; subject ≤ 200; `from_name` ≤ 100; `preview_text` ≤ 500; `send_at` future and ≤ 90 days; approval valid 24 hours; ≤ 5 approvals per campaign per hour; audience-growth refusal when `now > tested * 1.10` AND `now - tested > 25`; list cap 50.
- A campaign id at another studio, another tenant, or a random uuid answers the same `ToolRefusal('not_found', 'Campaign not found.')`.
- Supabase writes: `await`, destructure `error`, `.select('id')` and judge rows where the row must exist. No `'Europe/Dublin'` literal; zone maths through `@/lib/location-time`.
- Commit after every task, subject `MCPEMAIL.1 — …`, trailer `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Never run the full test suite and `npm run build` at the same time (8 GB machine).

## Review Focus

1. **The campaign is edited after the test went out but before the button is pressed** (from Claude or in the CRM editor). The confirm route must refuse with "ask for a new test", never send the changed version. → Task 9.
2. **The approve link is opened by a different signed-in staff member** (forwarded email, shared laptop). Must be the ordinary not-found, with no campaign details shown. → Task 9.
3. **The button is pressed twice, or in two tabs.** Exactly one release; the second answers "already approved", and the campaign is not re-queued. → Task 9.
4. **`send_at` near a clock change, and a `send_at` that has passed by the time the person presses.** `2027-03-28T01:30` (a wall-clock time that does not exist in Dublin) is `invalid_input`; a passed time at press is refused. → Tasks 8 and 9.
5. **An audience filter with no rows.** `{ filters: [] }` would match the whole studio. It is `invalid_input` ("name at least one filter, or use a saved segment") at save and at test. → Task 7.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/830_mcp_email_campaigns.sql` | `campaign_release_approvals`; `campaigns.agent_blocks`, `campaigns.created_via` | 1 |
| `src/lib/agent-email-blocks.js` | Block schema, validation, blocks → HTML | 2 |
| `src/lib/campaign-release.js` | The one copy of preflight, release and stop | 3 |
| `src/lib/email-audience-counts.js` | matched / eligible / excluded breakdown | 4 |
| `src/lib/campaign-approval.js` | Content key, issue, load, consume, void, growth rule | 5 |
| `src/lib/agent-tools/_email-campaign.js` | Shared gate, studio-scoped campaign load, audience resolve | 6 |
| `src/lib/agent-tools/{list-email-segments,count-email-audience,list-email-images,list-email-campaigns,get-email-campaign}.js` | Read tools | 6 |
| `src/lib/agent-tools/{create-email-draft,update-email-draft,cancel-email-campaign}.js` | Write tools | 7 |
| `src/lib/campaign-test-email.js`, `src/lib/agent-tools/send-email-for-approval.js` | The test email and the approval request | 8 |
| `src/lib/campaign-approval-view.js`, `src/app/communications/campaigns/approve/[token]/page.js`, `src/components/CampaignApproveForm.jsx`, `src/app/api/communications/campaigns/approve/[token]/route.js` | Confirm page and its route | 9 |
| campaign list component, `CLAUDE.md`, `docs/architecture/INTEGRATIONS.md`, `src/lib/openapi.js` | Marker, docs, registration | 10 |

---

### Task 1: Migration 827

**Files:**
- Create: `supabase/migrations/830_mcp_email_campaigns.sql`
- Test: `tests/migration-830-mcp-email-campaigns.test.js` (style of `tests/migration-801-mcp-server.test.js`)

**Interfaces:**
- Produces: `public.campaign_release_approvals (id uuid pk default gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, content_key text NOT NULL, audience_eligible integer NOT NULL, send_at timestamptz, expires_at timestamptz NOT NULL, used_at timestamptz, voided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`, index `(campaign_id, created_at desc)`; `campaigns.agent_blocks jsonb`; `campaigns.created_via text NOT NULL DEFAULT 'web' CHECK (created_via IN ('web','mcp'))`.

- [ ] **Step 1: Write the failing test** — asserts on the migration text: the table is created; `ENABLE ROW LEVEL SECURITY`; `REVOKE ALL ON public.campaign_release_approvals FROM anon, authenticated`; no `CREATE POLICY` naming it; no column named `token` (only `token_hash`); both `campaigns` columns added with `IF NOT EXISTS`; no `GRANT` on `campaign_release_approvals`.
- [ ] **Step 2: Run** `npx vitest run tests/migration-830-mcp-email-campaigns.test.js` → FAIL (file missing).
- [ ] **Step 3: Write the migration.** House header comment. Before adding the `campaigns` columns, check whether `campaigns` is a column-granted table for `authenticated` (search `supabase/migrations` for `GRANT SELECT (` … `ON public.campaigns`). If it is, state the grant decision in the file (`-- column-grant: withheld campaigns.agent_blocks`; `created_via` granted if the campaign list reads it from the browser client). `voided_at` is added to the spec's column list so "voided" and "used" stay distinguishable.
- [ ] **Step 4: Run** the test plus `npm run check:select-columns && npm run check:rls-restrictive` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — mig 827: release approvals, agent_blocks, created_via`. Do **not** apply it; applying is a rollout step for Richard's go-ahead.

---

### Task 2: Blocks and the renderer

**Files:**
- Create: `src/lib/agent-email-blocks.js`
- Test: `src/lib/agent-email-blocks.test.js`

**Interfaces:**
- Consumes: `OFFERED_MERGE_TAGS` (`@/lib/merge-tags`).
- Produces:
  - `EmailBlocksSchema` — `z.array(block).min(1).max(60)`; `block` is a discriminated union on `type`: `{type:'heading', text, level: 1|2}`, `{type:'paragraph', text}`, `{type:'list', items: string[] (1-30), ordered?: boolean}`, `{type:'button', label (≤ 60), url}`, `{type:'image', url, alt (≤ 200)}`, `{type:'divider'}`. Text fields ≤ 5000.
  - `validateBlocks(blocks, { allowedImageUrls: Set<string> }): string | null` — first problem as a plain sentence, else null. Checks: every `url` (button, image, inline link) parses and is `https:`; every image `url` is in `allowedImageUrls`; every `{{tag}}` in any text is an offered tag name.
  - `renderAgentEmail({ blocks, branding: { companyName, logoUrl } }): string` — a full HTML document: 600px single column, logo (when present) and company name header, neutral colours, all text HTML-escaped. Inline syntax in `paragraph` and list items: `**bold**`, `*italic*`, `[label](https://…)`; nothing else is interpreted. Merge tags pass through untouched for `applyMergeTags` at send time. Adds no footer, unsubscribe or preheader.
  - `unknownMergeTags(text): string[]`.

- [ ] **Step 1: Write the failing tests**

```js
it('escapes markup in every text field', () => { /* '<script>x</script>' in heading, paragraph, list, button label, alt → no '<script' in output */ })
it('renders bold, italic and an https link, and leaves other punctuation alone', …)
it('refuses an http link, a javascript: link and an unparseable url', …)        // validateBlocks → sentence naming the url
it('refuses an image url that is not in the studio library', …)
it('refuses an unknown merge tag and accepts {{first_name}}', …)
it('keeps merge tags verbatim in the output', …)                                   // '{{first_name}}' survives
it('caps the list at 60 blocks', …)                                                // schema
it('omits the logo when branding has none and still names the company', …)
it('is deterministic: the same blocks and branding render byte-identical html', …) // Task 7 relies on it
```

- [ ] **Step 2: Run** `npx vitest run src/lib/agent-email-blocks.test.js` → FAIL.
- [ ] **Step 3: Implement.** No HTML parser and no markdown library: escape first, then apply the three inline patterns to the escaped text.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — email blocks: schema, validation and the server renderer`.

---

### Task 3: One copy of release and stop

**Files:**
- Create: `src/lib/campaign-release.js`
- Modify: `src/app/api/campaigns/[id]/send/route.js`, `src/app/api/communications/campaigns/[id]/schedule/route.js`, `src/app/api/communications/campaigns/[id]/stop/route.js`
- Test: `src/lib/campaign-release.test.js`; the three routes' existing tests must stay green

**Interfaces:**
- Consumes: `getEmailCapStatus` (`@/lib/usage-caps`), `checkSpend` (`@/lib/wallet-enforcement`).
- Produces:
  - `RELEASABLE_STATUSES = ['draft','scheduled','failed']`.
  - `releasePreflight(db, campaign, { statuses = RELEASABLE_STATUSES } = {}): Promise<{ ok: true } | { ok: false, code: 'status' | 'no_subject' | 'no_body' | 'email_hard_cap' | 'wallet_empty', message: string }>` — the checks and exact messages currently inline in the send route (status, subject, body, cap, wallet; cap and wallet fail open as today). `campaign` needs `id, location_id, status, subject, html_content`.
  - `releaseCampaign(db, campaign, { sendAt = null, statuses = RELEASABLE_STATUSES } = {}): Promise<{ ok: true, status: 'queued' | 'scheduled', scheduled_at: string | null } | { ok: false, code: 'conflict' | 'error', message }>` — `sendAt` null: `{status:'queued', cancel_requested_at:null, scheduled_at:null, last_error:null}`; `sendAt` (a `Date`): `{status:'scheduled', scheduled_at, cancel_requested_at:null}`. One update with `.eq('id').in('status', statuses).select('id')`; zero rows → `conflict`.
  - `stopCampaign(db, campaign): Promise<{ ok: true, outcome: 'back_to_draft' | 'stop_requested' } | { ok: false, code: 'not_stoppable' | 'error', message }>` — the stop route's logic moved verbatim (scheduled → draft with the cron-race fallback; queued/sending → `cancel_requested_at`).

- [ ] **Step 1: Write the failing tests**

```js
it('preflight refuses sent, sending, queued and cancelled with the status named', …)
it('preflight refuses an empty subject and an empty body with the routes\' existing messages', …)
it('preflight passes when the cap and wallet reads throw (fail open)', …)
it('release queues now and clears scheduled_at, cancel_requested_at and last_error', …)
it('release schedules at sendAt', …)
it('release answers conflict when the compare-and-set touches no row', …)
it('release with statuses [draft, scheduled] never touches a failed campaign', …)
it('stop sends a scheduled campaign back to draft and stamps a cancel request on a sending one', …)
```

- [ ] **Step 2: Run** `npx vitest run src/lib/campaign-release.test.js` → FAIL.
- [ ] **Step 3: Implement the module, then switch the three routes to it.** Responses, status codes and messages of the routes do not change, except that the send route now answers the schedule route's 409 `STATUS_CHANGED` when its compare-and-set touches no row (it had none before).
- [ ] **Step 4: Run** `npx vitest run src/lib/campaign-release.test.js src/app/api/campaigns src/app/api/communications/campaigns && npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — campaign-release: one copy of preflight, release and stop; the send route gains its compare-and-set`.

---

### Task 4: Audience counts as a lib function

**Files:**
- Create: `src/lib/email-audience-counts.js`
- Modify: `src/app/api/communications/audience-count/route.js` (its email branch calls the new function)
- Test: `src/lib/email-audience-counts.test.js`

**Interfaces:**
- Produces: `emailAudienceCounts(db, { filter, locationId }): Promise<{ matched: number, eligible: number, excluded: { not_opted_in: number, bounced_or_complained: number, suppressed: number } }>` — `eligible` from `buildEligibleAudienceQuery({ db, channel: 'email', filter, locationId, selectOpts: { count: 'exact', head: true } })`; the rest is the route's existing email-branch logic moved, not rewritten. A query error throws.

- [ ] **Step 1: Write the failing tests** — `returns matched, eligible and the three excluded counts`; `throws when a count query errors` (never a zero).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Move the logic; the route keeps its response shape** (`count`, `reachable`, `excluded`, `suppressed`).
- [ ] **Step 4: Run** `npx vitest run src/lib/email-audience-counts.test.js src/app/api/communications/audience-count` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — email audience counts as a shared function`.

---

### Task 5: The approval module

**Files:**
- Create: `src/lib/campaign-approval.js`
- Test: `src/lib/campaign-approval.test.js`

**Interfaces:**
- Produces:
  - `APPROVAL_TTL_MS = 24 * 60 * 60 * 1000`, `APPROVALS_PER_HOUR = 5`.
  - `APPROVAL_CONTENT_FIELDS = ['location_id','subject','preview_text','from_name','reply_to','html_content','audience_filter']`.
  - `campaignContentKey(row): string` — sha256 hex over a stable JSON of those fields (object keys sorted, `undefined` as `null`).
  - `audienceGrewTooMuch(tested: number, now: number): boolean` — `now > tested * 1.10 && now - tested > 25`.
  - `issueApproval(db, { campaign, profileId, audienceEligible, sendAt, nowMs }): Promise<{ ok: true, token: string, expiresAt: string } | { ok: false, code: 'too_many' }>` — counts this campaign's rows created in the last hour (`>= 5` → `too_many`); stamps `voided_at` on its unused, unvoided rows; inserts a row with `token_hash = sha256(token)`; `token` is 32 random bytes, base64url. The token is returned once and stored nowhere.
  - `findApproval(db, { token, profileId, nowMs }): Promise<{ ok: true, approval } | { ok: false, code: 'not_found' | 'used' | 'expired' | 'voided' }>` — looks up by hash; a row for another profile is `not_found`.
  - `consumeApproval(db, approvalId): Promise<boolean>` — `update({ used_at }).eq('id').is('used_at', null).is('voided_at', null).select('id')`; true only when one row was touched.
  - `voidApprovals(db, campaignId): Promise<void>` — stamps `voided_at` on unused rows; throws on error.
  - `pendingApproval(db, campaignId, nowMs): Promise<{ send_at, expires_at, audience_eligible } | null>`.

- [ ] **Step 1: Write the failing tests**

```js
it('the content key changes when any of the seven fields changes and not when updated_at or status does', …)
it('the content key ignores key order inside audience_filter', …)
it('audienceGrewTooMuch: 100→111 false (only 11 more), 100→130 true, 1000→1050 false (5%), 10→40 true, 500→400 false', …)
it('issue stores only the hash, voids the earlier unused approval and returns the token once', …)
it('issue answers too_many on the sixth request inside an hour', …)
it('find answers not_found for another person\'s token and for a random token alike', …)
it('find answers expired after 24 hours, used after consume, voided after a newer issue', …)
it('consume returns true once and false the second time', …)
```

- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement** (`node:crypto` `randomBytes`, `createHash`). - [ ] **Step 4: Run** `npx vitest run src/lib/campaign-approval.test.js` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — campaign approvals: content key, issue, find, consume, void`.

---

### Task 6: Read tools

**Files:**
- Create: `src/lib/agent-tools/_email-campaign.js`, `list-email-segments.js`, `count-email-audience.js`, `list-email-images.js`, `list-email-campaigns.js`, `get-email-campaign.js`
- Modify: `src/lib/agent-tools/index.js` (append in this order, after `getAppointments`)
- Test: `src/lib/agent-tools/email-read-tools.test.js`

**Interfaces:**
- Consumes: `emailAudienceCounts` (Task 4); `pendingApproval` (Task 5); `validateAudienceFilter`, `AUDIENCE_FIELDS` (`@/lib/audience-filter`); `audienceFilterSchema` (`@/lib/schemas`); `canReadSegmentsAt` (`@/lib/segment-access`); `listLandingMediaForUser` (`@/lib/landing-media-library`); `campaignDisplayStats`, `loadCampaignRecipientStats` (`@/lib/campaign-display-stats`); `describeFromAddress` (`@/lib/from-address`).
- Produces, in `_email-campaign.js`:
  - `emailGate = (user, studioId) => hasPermissionForLocation(user, studioId, 'email')`.
  - `CAMPAIGN_COLS` — the named columns the tools read (`id, location_id, name, subject, preview_text, from_name, reply_to, html_content, audience_filter, agent_blocks, created_via, status, scheduled_at, last_error, created_at`, plus the `total_*` counters `campaignDisplayStats` reads).
  - `loadCampaignAtStudio(db, studio, campaignId): Promise<object>` — `.eq('id', campaignId).eq('location_id', studio.id).maybeSingle()`; error throws; no row → `ToolRefusal('not_found', 'Campaign not found.')`.
  - `resolveAudienceFilter(db, studio, user, { segment_id, filter }): Promise<object>` — exactly one of the two, else `invalid_input`; a segment is read `.eq('id').eq('location_id', studio.id)` and needs `canReadSegmentsAt` (missing or unreadable → `not_found`); the result must pass `validateAudienceFilter` and have at least one filter row (Review Focus 5), else `invalid_input` with the validator's message.
  - `allowedImageUrls(db, user, studio): Promise<Set<string>>` — `listLandingMediaForUser(db, user, { kind: 'image' })` filtered to `location_id === studio.id`.
- Tools (inputs beyond `studio_id` → output):
  - `list_email_segments` → `{ segments: [{ id, name, description }], capped }` (≤ 50), gate `emailGate` AND `canReadSegmentsAt`.
  - `count_email_audience` `{ segment_id?, filter? }` → `{ matched, eligible, excluded, note }`; `note` says the frequency cap is applied per person at send time. Its `description` lists the fields and operators, generated from `AUDIENCE_FIELDS` at module load (not hand-typed).
  - `list_email_images` → `{ images: [{ url, name }], capped }`.
  - `list_email_campaigns` `{ status? }` → `{ campaigns: [{ id, name, subject, status, scheduled_at, created_via, sent, open_rate, click_rate }], capped }`, newest first.
  - `get_email_campaign` `{ campaign_id }` → `{ campaign: { id, name, subject, preview_text, from_name, reply_to, status, scheduled_at, last_error, created_via, sends_as }, blocks | null, body_edited_in_crm: boolean, audience: counts | null, approval_waiting: {…} | null, results: campaignDisplayStats(…) | null }`. `results` only for `queued`, `sending`, `sent`, `failed`, `cancelled`; stats are loaded with `[campaign.id]` **after** the studio-scoped load.

- [ ] **Step 1: Write the failing tests**

```js
it('every email tool is refused without the email permission at the studio', …)            // forbidden via runToolAtStudio
it('get_email_campaign answers the same not_found for another studio\'s campaign and a random uuid', …)
it('count_email_audience needs exactly one of segment_id and filter', …)
it('count_email_audience refuses a filter with no rows', …)                                   // Review Focus 5
it('count_email_audience answers not_found for a segment at another studio', …)
it('list_email_images returns only this studio\'s images', …)
it('list_email_campaigns caps at 50 and marks capped', …)
it('get_email_campaign returns no recipient-level fields and loads stats only for the scoped id', …)
it('count_email_audience\'s description names every AUDIENCE_FIELDS key', …)
```

- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement; add to `index.js`.**
- [ ] **Step 4: Run** `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:select-columns && npm run check:guardrails` → PASS. If the guard's "every tool listed once" or column checks need the new names registered in a manifest, register them; do not relax a rule.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — email read tools: segments, audience count, images, campaigns`.

---

### Task 7: Draft, edit and cancel tools

**Files:**
- Create: `src/lib/agent-tools/create-email-draft.js`, `update-email-draft.js`, `cancel-email-campaign.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/agent-tools/email-write-tools.test.js`

**Interfaces:**
- Consumes: Task 2 (`EmailBlocksSchema`, `validateBlocks`, `renderAgentEmail`); Task 3 (`stopCampaign`); Task 5 (`voidApprovals`); Task 6 helpers; `getLocationBranding` (`@/lib/location-branding`); `describeFromAddress`, `isOnVerifiedDomain` (`@/lib/from-address`); `EDITABLE_CAMPAIGN_STATUSES` (`@/lib/campaign-editability`).
- Produces:
  - `create_email_draft` `{ name (1-200), subject (1-200), preview_text?, from_name?, reply_to?, blocks, segment_id?, filter? }` → inserts `{ location_id: studio.id, status: 'draft', created_by: user.id, created_via: 'mcp', postmark_stream: 'broadcast', name, subject, preview_text, from_name, reply_to, agent_blocks: blocks, html_content: renderAgentEmail(…), audience_filter: resolved | null }` → `{ campaign: { id, name, status }, sends_as, audience: counts | null }`. The audience is optional here.
  - `update_email_draft` `{ campaign_id, name?, subject?, preview_text?, from_name?, reply_to?, blocks?, segment_id?, filter? }` → at least one field besides the id. Only when status is in `EDITABLE_CAMPAIGN_STATUSES`; otherwise `conflict` naming the status (a `failed` campaign: "open it in the CRM"). A `blocks` edit on a campaign with `agent_blocks` null, or whose stored `html_content !== renderAgentEmail(stored blocks, current branding)`, is `conflict`: "The body was edited in the CRM. Edit the body there." One update, compare-and-set `.eq('id').eq('location_id', studio.id).in('status', EDITABLE)`, which also sets `status: 'draft', scheduled_at: null` when the row was `scheduled`; then `voidApprovals`. Result `{ campaign, unscheduled: boolean, note }`.
  - `cancel_email_campaign` `{ campaign_id }` → `stopCampaign`; `{ outcome }`; `not_stoppable` → `conflict`.
  - `reply_to` rule (create and update): must be on the studio's verified domain, else `invalid_input` naming the domain.
  - All three: `writes: true`, description ends "This writes to the CRM: confirm with the user first."

- [ ] **Step 1: Write the failing tests**

```js
it('create inserts a draft stamped mcp, broadcast, created_by the caller, with rendered html and stored blocks', …)
it('create never sets from_email, status other than draft, or any ab_ field', …)                 // inserted keys asserted
it('create refuses blocks with an image outside the studio library', …)
it('create refuses a reply_to off the verified domain', …)
it('create and update refuse a filter with no rows', …)                                            // Review Focus 5
it('update on a scheduled campaign writes the change, returns it to draft and voids the approval', …)
it('update refuses a body edit when html_content no longer matches the stored blocks, and still allows a subject edit', …)
it('update answers conflict for sent, sending, queued and failed', …)
it('update answers not_found for another studio\'s campaign', …)
it('cancel maps stopCampaign outcomes and refusals', …)
```

- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement; add to `index.js`.**
- [ ] **Step 4: Run** `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:guardrails && npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — draft, edit and cancel tools`.

---

### Task 8: The test email and `send_email_for_approval`

**Files:**
- Create: `src/lib/campaign-test-email.js`, `src/lib/agent-tools/send-email-for-approval.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/campaign-test-email.test.js`, `src/lib/agent-tools/send-email-for-approval.test.js`

**Interfaces:**
- Consumes: `applyMergeTags`, `appendUnsubscribeFooter`, `sendEmail` (`@/lib/postmark`); `prependViewInBrowserLink` (`@/lib/campaign-web-view`); `injectPreheader` (`@/lib/email-content`); `resolveEmailSender` (`@/lib/tenant-email`); `getLocationBranding`; `getAppUrl`; `zonedWallClockToInstant` (`@/lib/location-time`); Tasks 3-6.
- Produces:
  - `buildCampaignTestEmail({ campaign, studio, person: { name, email }, branding, approveUrl, audienceEligible, sendsAs, sendAtLabel, appUrl }): { subject, html }` — `subject` = `[TEST] ` + merged subject. Body = the campaign's `html_content` through the four send-time steps in the sender's order (`applyMergeTags` → `appendUnsubscribeFooter` → `prependViewInBrowserLink` → `injectPreheader` when `preview_text`), fed placeholder URLs `${appUrl}/unsubscribe/test-token` and `${appUrl}/preferences/test-token` and a non-resolving view-in-browser placeholder; then a staff banner prepended above everything with the studio name, "This will go to N people", sends-as, the timing, and the approve button linking `approveUrl`. Mirror the argument shapes at `src/lib/campaign-sender.js` ~l.820-870.
  - `parseSendAt(value, zone, nowMs): { ok: true, at: Date } | { ok: false, message }` — `YYYY-MM-DDTHH:mm`; converts with `zonedWallClockToInstant`; refuses a wall-clock time that does not exist in the zone (round-trip the instant back to wall clock and compare), a past time, and one more than 90 days out.
  - Tool `send_email_for_approval` `{ campaign_id, send_at? }`, `writes: true`. Order: load at studio; status must be `draft` or `scheduled` (else `conflict`); `audience_filter` present with at least one row (else `invalid_input` "choose an audience first"); `parseSendAt`; `releasePreflight(db, campaign, { statuses: ['draft','scheduled'] })` (a refusal → `conflict` with its message); `emailAudienceCounts` (`eligible === 0` → `conflict` "nobody would receive this"); `issueApproval` (`too_many` → `conflict`); build and `sendEmail` to `user.user.email` on the transactional path (no unsubscribe header, not the broadcast stream); a failed send voids the approval just issued and throws. Returns `{ sent_to: maskEmail(email), audience: counts, sends_as, timing: 'as soon as approved' | '<studio-zone date and time, zone named>', expires_at }`. Never returns `token` or `approveUrl`.
  - `approveUrl` = `getAppUrl() + '/communications/campaigns/approve/' + token`.
  - Description tells the agent: the person approves in the CRM from the link in their inbox; never look for, open or follow that link yourself.

- [ ] **Step 1: Write the failing tests**

```js
// campaign-test-email.test.js
it('runs the four send-time steps in the sender\'s order with placeholder links', …)   // spies; unsubscribe url ends /unsubscribe/test-token
it('puts the banner with head count, sends-as, timing and approve link above the body', …)
it('prefixes the subject with [TEST] and merges the person\'s first name', …)
// send-email-for-approval.test.js
it('sends only to the caller\'s own login email, whatever the input', …)               // schema has no address field
it('never returns the token or the link', …)                                             // JSON.stringify(result) contains neither
it('refuses 2027-03-28T01:30 at a Dublin studio as a time that does not exist', …)     // Review Focus 4
it('refuses a past send_at and one 91 days out, and accepts 2026-12-01T09:00', …)
it('refuses a campaign with no audience, an empty audience, and a failed/sent/queued status', …)
it('voids the approval and fails when the email send fails', …)
it('answers conflict on the sixth request in an hour', …)
```

- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement; add to `index.js`** (the registry now holds 27 tools; update any test that pins the count or the name list).
- [ ] **Step 4: Run** `npx vitest run src/lib/campaign-test-email.test.js src/lib/agent-tools src/lib/mcp tests/agent-tools-guard.test.js && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — the test email and send_email_for_approval`.

---

### Task 9: The confirm page and its route

**Files:**
- Create: `src/lib/campaign-approval-view.js`, `src/app/communications/campaigns/approve/[token]/page.js`, `src/components/CampaignApproveForm.jsx`, `src/app/api/communications/campaigns/approve/[token]/route.js`
- Modify: `src/lib/openapi.js`
- Test: `src/app/api/communications/campaigns/approve/[token]/route.test.js`, `src/components/CampaignApproveForm.test.jsx`, `src/app/communications/campaigns/approve/[token]/page.test.js`

**Interfaces:**
- Consumes: `getCurrentUser`; `hasPermissionForLocation`; `findApproval`, `consumeApproval`, `campaignContentKey`, `audienceGrewTooMuch` (Task 5); `releasePreflight`, `releaseCampaign` (Task 3); `emailAudienceCounts` (Task 4); `describeFromAddress`.
- Produces:
  - `loadApprovalView(db, user, token, nowMs)` in a new `src/lib/campaign-approval-view.js` (used by page and route) → `{ ok: true, approval, campaign, studio, counts, sendsAs } | { ok: false, reason: 'not_found' | 'used' | 'expired' | 'voided' | 'changed' | 'send_at_passed' | 'audience_grew' | 'no_permission' }`. `not_found` covers a bad token, another person's token, and a campaign the person has no access to. `changed` = `campaignContentKey(campaign) !== approval.content_key`.
  - `GET` page: signed out → the app's normal login redirect with the path preserved (the page is **not** added to any public allowlist). Renders the facts (campaign name, subject, studio, sends-as, timing, head count at test, head count now) and `<CampaignApproveForm>`; for a refusal reason, a plain sentence and a link to the campaign in the CRM (no campaign details for `not_found`).
  - `POST /api/communications/campaigns/approve/[token]` (cookie session only): `loadApprovalView`; then `releasePreflight(…, { statuses: ['draft','scheduled'] })`; then `consumeApproval` — **false → 409 "already approved", stop**; then `releaseCampaign(db, campaign, { sendAt: approval.send_at, statuses: ['draft','scheduled'] })`. If release fails after a successful consume, the approval stays spent and the response says to ask for a new test (a spent approval with no send is the safe failure; a send with a reusable approval is not). Response `{ success, data: { status, scheduled_at } }`.
  - `CampaignApproveForm({ token, label })` (`'use client'`): one `type="button"` button, disabled while posting and after success; shows the outcome inline.

- [ ] **Step 1: Write the failing tests**

```js
// route.test.js
it('releases now when the approval has no send_at, and schedules at send_at when it has one', …)
it('refuses when the campaign content changed since the test, and does not consume the approval', …)   // Review Focus 1
it('answers 404 for another signed-in person\'s token, identical to a random token', …)                // Review Focus 2
it('a second press answers 409 and releaseCampaign is called once', …)                                  // Review Focus 3
it('refuses when send_at has passed', …)                                                                // Review Focus 4
it('refuses when the audience grew from 100 to 130, passes at 100 to 105', …)
it('refuses a person who has lost the email permission since the test', …)
it('refuses an OAuth-issued bearer (no cookie session) with 401', …)
it('refuses a campaign that is no longer draft or scheduled', …)
// page.test.js
it('redirects a signed-out visitor to login with the approve path preserved', …)
it('shows no campaign details for not_found', …)
// CampaignApproveForm.test.jsx
it('posts once, disables the button, and shows the scheduled time or "queued"', …)
it('the button has type="button"', …)
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Confirm `/communications` is an auth-gated segment (its layout redirects signed-out visitors) and that `src/proxy.js` does not list the new API path as public. Register the route in `src/lib/openapi.js`.
- [ ] **Step 4: Run** `npx vitest run src/app/api/communications/campaigns/approve src/app/communications/campaigns/approve src/components/CampaignApproveForm.test.jsx src/proxy.test.js && npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails` → PASS. If `check:location-scoping` flags the token lookup, the fix is the studio check in `loadApprovalView` being visible to the scan, or a `SCOPING_HELPERS` entry for it; not `EXEMPT`.
- [ ] **Step 5: Commit** — `MCPEMAIL.1 — the approve page: a signed-in press is the only way an agent-prepared campaign sends`.

---

### Task 10: Marker, docs, CI mirror, PR

**Files:**
- Modify: the campaign list component under `src/components/` or `src/app/communications/` that renders the campaigns table (find it by the list's `status` chip); its data read (name `created_via` in the select); `CLAUDE.md`; `docs/architecture/INTEGRATIONS.md` § Staff MCP server
- Create after the PR exists: `docs/changelog/entries/<PR>.md`
- Test: the list component's existing test file

- [ ] **Step 1: Write the failing test** — `shows "Made in Claude" on a campaign with created_via 'mcp' and nothing on a web one`. Chip recipe: `bg-<c>-500/10 text-<c>-700`.
- [ ] **Step 2: Run** → FAIL. - [ ] **Step 3: Implement the marker.**
- [ ] **Step 4: Docs.** `CLAUDE.md` MCP invariant bullet: email is in scope through the nine tools; no tool can release; release is `releaseCampaign` behind the approve route; approvals are content-, person- and timing-bound. `INTEGRATIONS.md`: the flow, the tool list, the limits from Global Constraints, and the spec's "Known limits".
- [ ] **Step 5: Run the thirteen-command CI mirror from `CLAUDE.md`, then `npm run build`** (separately). Expected: all green.
- [ ] **Step 6: Commit, push, open the PR** titled `MCPEMAIL.1 — email campaigns from an agent`. Body: what shipped; mig 827 must be applied **before** the deploy; the first-use plan (Test Studio, then Stillorgan); the four calls from the spec's "Calls made while writing this up". No customer names. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Check the PR is open in the same call as any later push.
- [ ] **Step 7: Add the changelog entry** `docs/changelog/entries/<PR>.md` and push.

---

## Rollout (operator steps, not tasks)

1. On Richard's go-ahead: apply mig 827 via Supabase MCP to `iyvtbjjxdggiadzwwvdj`; `get_advisors` (security).
2. Merge; confirm the Vercel deploy is live.
3. From Claude at **Test Studio**: draft, count, test, press the link, confirm one `campaigns` row goes `draft → queued → sent` and the recipient count matches.
4. Negative checks live: edit the draft after the test and press the old link (refused); press a used link (refused).
5. One small real audience at Stillorgan.
