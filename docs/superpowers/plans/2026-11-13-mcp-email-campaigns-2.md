# Email campaigns from an agent, round two (MCPEMAIL.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five more MCP abilities for email campaigns (duplicate, resend to non-openers approved with the first send, masked audience sample, create/edit segments, start from a saved template) without weakening the rule that only a signed-in approve press releases a send.

**Architecture:** New tools in `src/lib/agent-tools/` on the same door, gate and helpers as MCPEMAIL.1. Resend is three existing `campaigns` columns, written by the draft tools, added to the approval content key, and shown on the test email and approve page; the existing `run-campaigns` cron sends the child. Reads of `email_templates` and `email_sequences` live in lib helpers outside the tool directory.

**Tech Stack:** Next.js 16 App Router, Supabase service role, zod 4, vitest.

**Spec:** [`docs/superpowers/specs/2026-11-13-mcp-email-campaigns-2-design.md`](../specs/2026-11-13-mcp-email-campaigns-2-design.md), building on [`2026-11-12-mcp-email-campaigns-design.md`](../specs/2026-11-12-mcp-email-campaigns-design.md). Read both.

## Global Constraints

- Worktree `~/code/un1t-crm-mcp-email-2`, branch `mcp-email-campaigns-2`. Before Task 1: `git fetch origin main && git merge origin/main` (APPROVECOPY.1, #2358, touches the approve page and its form), then `npm ci`.
- Every tool: `defineTool`, `studio_id: uuidLike.optional()`, gate `emailGate` (`src/lib/agent-tools/_email-campaign.js`), studio and person from `ctx` only. None added to `BRIDGED_TOOL_NAMES`.
- No tool writes a campaign `status` other than `'draft'`. `tests/agent-tools-guard.test.js` must stay green without loosening a rule; a new helper file goes in `NOT_TOOLS` exactly as `_email-draft.js` is.
- Another studio's id and a random uuid answer the same `ToolRefusal('not_found', …)`.
- Supabase writes: `await`, destructure `error`, judge rows touched where the row must exist. Named columns only.
- Resend: `after_hours` 1 to 168 (the DB CHECK, mig 506); `resend_subject` at most 200 characters, exact merge tags only (`OFFERED_MERGE_TAGS`).
- Audience sample: at most 50 rows (`PREVIEW_MAX_PAGE_SIZE`); first name, masked email, pipeline stage only; never phone, full email or contact id.
- Segment `name` at most 120 characters (the CRM route's limit); a duplicate name is a `conflict`.
- No migration is expected. If one becomes necessary, stop and report.
- Commit after every task, subject `MCPEMAIL.2 — …`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 8 GB machine: focused vitest files only during tasks; never the full suite beside `npm run build`.

## Review Focus

1. **A resend switched on, changed or off after the test email.** The approve press must be refused ("ask for a new test"), never release a resend the person did not see. → Task 1.
2. **A resend on a campaign that is itself a resend, or a resend subject with a spaced or unknown tag.** `invalid_input`, never stored. → Task 2.
3. **A segment a sequence starts from, including a draft sequence, and a failed read of that count.** Edit refused in both cases; a read error is never "no sequences". → Task 5.
4. **A template a booking type, event or race uses as a confirmation or reminder.** Never listed and refused by id. → Task 6.
5. **An audience sample for an empty filter, or for a campaign with no audience.** `invalid_input` with the same sentence as `count_email_audience`, never a whole-studio sample. → Task 4.

---

### Task 1: Resend joins the approval

**Files:**
- Modify: `src/lib/campaign-approval.js` (`APPROVAL_CONTENT_FIELDS`), `src/lib/campaign-approval-view.js` (`APPROVAL_CAMPAIGN_COLUMNS`), `src/lib/agent-tools/_email-campaign.js` (`CAMPAIGN_COLS`)
- Modify: `src/lib/campaign-test-email.js` (banner), `src/app/communications/campaigns/approve/[token]/page.js` (fact row and button label), `src/lib/agent-tools/send-email-for-approval.js` (passes the resend to the email builder)
- Test: `src/lib/campaign-approval.test.js`, `src/lib/campaign-test-email.test.js`, `src/app/communications/campaigns/approve/[token]/page.test.js`, `src/app/api/communications/campaigns/approve/[token]/route.test.js`, `tests/agent-tools-guard.test.js` (its column-list rule already covers the new names)

**Interfaces:**
- Produces: `APPROVAL_CONTENT_FIELDS` gains `'resend_enabled', 'resend_wait_hours', 'resend_subject'` (16 entries). `resendSummary(campaign): string | null` exported from `src/lib/campaign-approval.js` — null when `resend_enabled` is false, else exactly `Then resends to people who did not open it, ${h} hours after it sends, with the subject "${subject}".` where `subject` is `resend_subject` or, when null, the campaign's `subject` (use `h === 1 ? '1 hour' : '${h} hours'`).
- `buildCampaignTestEmail` takes a new `resendLabel` (string | null) and shows it as a banner row "Resend" when present.

- [ ] **Step 1: Failing tests**

```js
it('the content key changes when resend_enabled, resend_wait_hours or resend_subject changes', …)
it('the content key throws on a row missing resend_subject', …)              // existing short-row rule
it('resendSummary: null when off; "1 hour" singular; falls back to the subject', …)
it('the test email banner shows the resend sentence when given, nothing when null', …)
it('the approve page shows a Resend fact and labels the button "Send to N people now, then resend"', …)  // button label: append ', then resend' when resendSummary is non-null
it('a resend switched on after the test is refused at the press and nothing is released', …)  // route test: key mismatch → 'changed'
```

- [ ] **Step 2: Run** `npx vitest run src/lib/campaign-approval.test.js src/lib/campaign-test-email.test.js 'src/app/communications/campaigns/approve' 'src/app/api/communications/campaigns/approve'` → FAIL.
- [ ] **Step 3: Implement.** Add the three fields to all three column lists. `send-email-for-approval.js` passes `resendLabel: resendSummary(campaign)`.
- [ ] **Step 4: Run** the same command plus `npx vitest run tests/agent-tools-guard.test.js src/lib/agent-tools && npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.2 — resend settings are part of what an approval covers`.

---

### Task 2: Resend on the draft tools, in get and cancel

**Files:**
- Modify: `src/lib/agent-tools/_email-draft.js`, `create-email-draft.js`, `update-email-draft.js`, `get-email-campaign.js`, `cancel-email-campaign.js`
- Test: `src/lib/agent-tools/email-write-tools.test.js`, `email-read-tools.test.js`

**Interfaces:**
- Consumes: `resendSummary` (Task 1); `unknownMergeTags` (`src/lib/agent-email-blocks.js`); `RESEND_MIN_WAIT_HOURS`, `RESEND_MAX_WAIT_HOURS` (`src/lib/campaign-resend.js`).
- Produces in `_email-draft.js`: `ResendSchema = z.object({ after_hours: z.number().int().min(RESEND_MIN_WAIT_HOURS).max(RESEND_MAX_WAIT_HOURS), subject: z.string().trim().min(1).max(200).optional() }).nullable().optional()`; `resendColumns(resend): { resend_enabled, resend_wait_hours, resend_subject }` — `null` gives `{ false, null, null }`, `undefined` gives `{}` (leave unchanged on update); refuses (`invalid_input`) a subject with unknown or spaced tags.
- `create_email_draft` and `update_email_draft` accept `resend`. Update refuses `resend` on a campaign with `parent_campaign_id` set ("a resend cannot itself be resent").
- `get_email_campaign` adds `resend: { after_hours, subject, summary } | null`, and once a child exists (`campaigns` where `parent_campaign_id = campaign.id` and `location_id = studio.id`), `resend_child: { id, status, sent }`.
- `cancel_email_campaign` on a `sent` campaign with `resend_enabled` true: if a child row exists → `conflict` "The resend has already started. Cancel it instead: <child id>."; otherwise write `resend_enabled: false` (scoped, judged) and answer `{ outcome: 'resend_cancelled' }`. Mirrors `src/app/api/campaigns/[id]/resend/route.js` DELETE.

- [ ] **Step 1: Failing tests**

```js
it('create writes resend_enabled, resend_wait_hours and resend_subject from resend', …)
it('update with resend: null switches it off; omitting resend leaves it unchanged', …)
it('refuses after_hours 0 and 169, and a resend subject with {{ first_name }} or {{nope}}', …)
it('update refuses a resend on a campaign that is itself a resend', …)
it('an update that changes only the resend still returns the campaign to draft and voids approvals', …)
it('get_email_campaign reports the resend and, once spawned, the child', …)
it('cancel switches off a pending resend on a sent campaign, and refuses once the child exists', …)
```

- [ ] **Step 2: Run** `npx vitest run src/lib/agent-tools` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:guardrails && npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.2 — resend to non-openers from the draft tools`.

---

### Task 3: `duplicate_email_campaign`

**Files:**
- Create: `src/lib/agent-tools/duplicate-email-campaign.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/agent-tools/email-duplicate-tool.test.js`

**Interfaces:**
- Consumes: `buildCampaignDuplicate(source, userId)` from `src/app/api/campaigns/[id]/duplicate/route.js` (if a route file may not export it under the house rules, move it to `src/lib/campaign-duplicate.js` and import it from both; say so in the commit).
- Produces: tool `duplicate_email_campaign` `{ campaign_id, name? }`, `writes: true` → `{ campaign: { id, name, status: 'draft' }, body_editable_from_claude: boolean, sends_as }`.
- Rules from the spec: source loaded at studio; non-`broadcast` source → `conflict` "This is a service email. Duplicate it in the CRM."; insert `buildCampaignDuplicate(...)` plus `created_via: 'mcp'`, `agent_blocks: source.agent_blocks ?? null`, `name: input.name ?? <its default>`; never copies `parent_campaign_id`, `ab_*`, `scheduled_at`, `resend_*`. `body_editable_from_claude` = source `agent_blocks` non-null and `htmlSha256(source.html_content) === source.agent_blocks.html_sha256`.

- [ ] **Step 1: Failing tests**

```js
it('copies a sent campaign as a draft stamped mcp, without parent, A/B, schedule or resend', …)
it('keeps a Claude-written body editable and marks a CRM-built body as not editable', …)
it('refuses an outbound (service) source', …)
it('answers not_found for another studio\'s campaign and a random uuid alike', …)
it('copies the source from_email and reports it as sends_as', …)
```

- [ ] **Step 2–4:** run `npx vitest run src/lib/agent-tools/email-duplicate-tool.test.js` (FAIL), implement, then `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js src/app/api/campaigns && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.2 — duplicate_email_campaign`.

---

### Task 4: `sample_email_audience`

**Files:**
- Create: `src/lib/email-audience-sample.js`, `src/lib/agent-tools/sample-email-audience.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/email-audience-sample.test.js`, `src/lib/agent-tools/email-sample-tool.test.js`

**Interfaces:**
- Produces: `emailAudienceSample(db, { filter, locationId, limit = PREVIEW_MAX_PAGE_SIZE }): Promise<Array<{ first_name: string | null, email: string, stage: string | null }>>` — the audience-preview route's eligible query (`buildEligibleAudienceQuery`, channel `email`, `.order('id').range(0, limit - 1)`), each row reduced to `first_name`, `maskEmail(email)`, `pipeline_stage_slug`; a query error throws.
- Tool `sample_email_audience` `{ segment_id? | filter? | campaign_id? }` (exactly one) → `{ sample, count: eligible, note: 'A sample of up to 50 of the people who would receive it.' }`. `campaign_id` uses that campaign's stored filter (stripped); no filter rows → the same `invalid_input` as `count_email_audience`.

- [ ] **Step 1: Failing tests**

```js
it('returns at most 50 rows of first name, masked email and stage, and no phone or id', …)
it('throws on a query error rather than returning an empty sample', …)
it('needs exactly one of segment_id, filter and campaign_id', …)
it('refuses an empty filter and a campaign with no audience', …)          // Review Focus 5
```

- [ ] **Step 2–4:** FAIL, implement, then `npx vitest run src/lib/email-audience-sample.test.js src/lib/agent-tools tests/agent-tools-guard.test.js` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.2 — sample_email_audience`.

---

### Task 5: `create_email_segment` and `update_email_segment`

**Files:**
- Create: `src/lib/agent-tools/create-email-segment.js`, `update-email-segment.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/agent-tools/email-segment-tools.test.js`

**Interfaces:**
- Consumes: `canWriteSegmentsAt`, `countSequencesUsingSegment`, `validateAudienceFilter` / `InvalidAudienceFilterError` (`src/lib/segment-access.js`, `src/lib/audience-filter.js`). `countSequencesUsingSegment` reads `email_sequences` outside the tool directory, which is how the guard's forbidden-table rule stays satisfied.
- Produces: `create_email_segment` `{ name (1-120), description? (≤2000), filter }` → `{ segment: { id, name } , count }`; `update_email_segment` `{ segment_id, name?, description?, filter? }` (at least one) → `{ segment: { id, name }, count }`. Both `writes: true`, gate `emailGate && canWriteSegmentsAt`. Filter must have rows (same rule as MCPEMAIL.1). Unique-name violation → `conflict` "A segment with this name already exists." Update: segment loaded `.eq('id').eq('location_id', studio.id)`; `countSequencesUsingSegment` count > 0 → `conflict` "A sequence starts from this segment. Edit it in the CRM."; count `null` (read failed) → throw (tool_failed), never proceed.

- [ ] **Step 1: Failing tests**

```js
it('creates a segment at the studio stamped with the person', …)
it('refuses a duplicate name as a conflict', …)
it('refuses an edit to a segment any sequence starts from, a draft sequence included', …)   // Review Focus 3
it('fails, and does not edit, when the sequence count cannot be read', …)                   // Review Focus 3
it('needs both the email and segment-write permissions', …)
it('answers not_found for another studio\'s segment', …)
```

- [ ] **Step 2–4:** FAIL, implement, then `npx vitest run src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.2 — create and edit segments from Claude`.

---

### Task 6: Templates

**Files:**
- Create: `src/lib/email-templates-for-agents.js`, `src/lib/agent-tools/list-email-templates.js`, `src/lib/agent-tools/create-email-draft-from-template.js`
- Modify: `src/lib/agent-tools/index.js`
- Test: `src/lib/email-templates-for-agents.test.js`, `src/lib/agent-tools/email-template-tools.test.js`

**Interfaces:**
- Produces in the lib (it reads `email_templates`, so it lives outside the tool directory):
  - `EXCLUDED_TEMPLATE_CATEGORIES = ['transactional', 'reminder']`.
  - `usedTemplateIds(db, locationId): Promise<Set<string>>` — every template id referenced by a confirmation or reminder column at the studio. Find the columns by grepping migrations for `REFERENCES … email_templates` (at planning time: `confirmation_email_template_id` and `reminder_email_template_id` on `event_types`, `race_events` and possibly `bookings`; confirm each table has `location_id` and use it). A read error throws.
  - `listMarketingTemplates(db, locationId): Promise<Array<{ id, name, subject, category, description }>>` — the studio's templates minus excluded categories and used ids, ordered by name, capped at 50.
  - `loadMarketingTemplate(db, locationId, templateId): Promise<{ id, name, subject, html_content, design_json } | null>` — null when not at the studio, excluded or used.
- Tools: `list_email_templates` → `{ templates, capped }`; `create_email_draft_from_template` `{ template_id, name, subject?, preview_text?, from_name?, reply_to?, segment_id? | filter?, resend? }`, `writes: true` → like `create_email_draft`'s result plus `body_editable_from_claude: false`. Unknown or spaced merge tags in the template's `html_content` or the chosen subject → `invalid_input` naming them (`unknownMergeTags`). The draft: `html_content`, `design_json` from the template, `template_id`, `agent_blocks: null`, `created_via: 'mcp'`, `postmark_stream: 'broadcast'`, status `draft`.

- [ ] **Step 1: Failing tests**

```js
it('lists the studio\'s templates without transactional, reminder or confirmation/reminder-linked ones', …)  // Review Focus 4
it('refuses by id a template an event type uses as its reminder', …)                                          // Review Focus 4
it('throws when the linked-template read fails, never listing everything', …)
it('creates a draft from a template with the body editable in the CRM only', …)
it('refuses a template whose body carries {{booking_time}} or another tag a campaign cannot fill', …)
it('answers not_found for another studio\'s template', …)
```

- [ ] **Step 2–4:** FAIL, implement, then `npx vitest run src/lib/email-templates-for-agents.test.js src/lib/agent-tools tests/agent-tools-guard.test.js && npm run check:select-columns && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** — `MCPEMAIL.2 — start a draft from a saved template`.

---

### Task 7: Docs, mirror, PR

**Files:**
- Modify: `CLAUDE.md` (the MCPEMAIL bullet: the 16-field key, resend approved with the first send, segments edit refused when a sequence uses one), `docs/architecture/INTEGRATIONS.md` § Email campaigns (the new tools and rules)
- Create after the PR exists: `docs/changelog/entries/<PR>.md`

- [ ] **Step 1: Docs.**
- [ ] **Step 2: Run the thirteen-command CI mirror from `CLAUDE.md`, then `npm run build` separately.** All green.
- [ ] **Step 3: Push and open the PR** `MCPEMAIL.2 — duplicate, resend, audience sample, segments, templates from Claude`. Body: what shipped; that any approval waiting at deploy is refused once (the key grew); no migration; the live check (duplicate the 13 Nov test campaign, add a resend after 1 hour, approve to Richard only, confirm the child spawns only if unopened). No customer names. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 4: Changelog entry** and push, checking the PR is open in the same call.
