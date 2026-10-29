# UN1TWELCOME Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every un1t.online account first seen after deploy is enrolled in a "Welcome: new un1t.online account" email sequence that sends, on the transactional stream, a welcome telling them to download the un1t.online app. CRM-made accounts whose account email already went out skip that step, and the account email itself gains the app section.

**Architecture:** Three new columns on `un1t_clients`, including a cursor stamped on every row already there. A sweep arm on the `un1t-online-sync` cron enrols each new row through a new sequence trigger, `un1t_account_created`. The sequence engine gains `startStepOrder` and an "account stream" lane, keyed on the enrolment's `source_type`. App links and the app-section copy live on `locations.settings.un1t_online.app_links`, and the merge tags and the account email both render them through one pure helper.

**Tech Stack:** Next.js 16 route handlers, Supabase (service role), Postmark, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-un1t-welcome-email-design.md` (mockup: `docs/superpowers/specs/2026-10-28-un1t-welcome-email-mockup.html`)

**Change from the spec (Claude's call):** the app section's heading and body live with the links in `settings.un1t_online.app_links`, not on the class-funnel block. The `/trial` account email never loads the class-funnel block, so one place serves both account-email kinds and the sequence.

## Global Constraints

- Branch off fresh `origin/main` (`git fetch origin main && git checkout -b un1t-welcome-email origin/main`); run `npm ci` in a fresh worktree.
- Migration numbers: `790_un1t_welcome.sql` (columns) and `791_un1t_welcome_sweep_heartbeat.sql` (heartbeat). Renumber if `main` has moved past 789.
- Trigger value `un1t_account_created`; enrolment `source_type` `'un1t_account_created'`; heartbeat name `un1t-welcome-sweep` (interval 900 s, grace 1800 s).
- New `un1t_clients` columns: `first_seen_at timestamptz NOT NULL DEFAULT now()`, `welcome_checked_at timestamptz`, `account_email_sent_at timestamptz`.
- Unmatched rows wait 48 h (`WELCOME_CONTACT_WAIT_MS = 48 * 3600_000`); sweep page size 500.
- Store button labels are exactly "Download on the App Store" and "Get it on Google Play".
- Default app section: heading "Book your classes in the un1t.online app"; body "Download the app and log in with this email address once you've set your password. That's where you'll book and manage every class."
- No em or en dashes in any customer copy.
- Every supabase write destructures and handles `error` (`no-unchecked-supabase-write`); no new `console.log`.
- CI mirror (all thirteen from CLAUDE.md) plus `npm run build` before the PR.

## Review Focus

1. A sync that creates a contact with no email: the sweep stamps `no_email`, never enrols, never throws (Task 5).
2. The sequence is switched off (or doesn't exist yet): rows are neither read nor stamped, so they are welcomed once it's on (Task 5).
3. The same sequence enrolled by hand or by another trigger still sends on the marketing stream with the unsubscribe footer (Task 3).
4. A studio with no app links set: `{{app_download_links}}` renders `''`, the account email has no app section, and nothing throws (Tasks 1, 3, 4).
5. The account email went out but the `account_email_sent_at` stamp hit 0 rows (the `un1t_clients` row isn't there yet): log a warning and carry on. The person then also gets the welcome, which is the accepted worst case (Task 4).

---

### Task 1: App links setting and render helpers

**Files:**
- Create: `src/lib/un1t-online-app-links.js`, `src/lib/un1t-online-app-links.test.js`
- Modify: `src/lib/un1t-online-settings.js` (`un1tWriteSettingsFrom` returns `appLinks`), `src/lib/un1t-online-settings.test.js`
- Modify: `src/app/api/locations/[id]/un1t-online/route.js` (GET returns it; `WriteSettingsSchema` + PATCH key loop accept it), `route.write-settings.test.js`
- Modify: `src/components/settings/integrations/Un1tOnlineIntegrationTab.jsx` (four inputs under the existing master-only write settings), its test if one covers the form

**Interfaces:**
- Produces:
  - `appLinksFrom(settings) -> { iosUrl: string|null, androidUrl: string|null, heading: string, body: string }`. Takes the WHOLE `locations.settings`. A URL counts only if it is a string starting `https://`. Blank heading/body fall back to the defaults.
  - `renderAppDownloadLinks({ iosUrl, androidUrl }) -> string`: the mockup's two-button table (black cells, white uppercase 13 px labels, 12 px gap), with a missing link's cell left out, and `''` when both are missing. Escape the hrefs (`&`, `"`, `<`).
  - `renderStudioLogo({ logoUrl, name }) -> string`: the mockup's `<img width="200" alt="${name}">` when `logoUrl` is set, else the "UN1T" text wordmark span. Escape both.
  - `renderAppSection(appLinks) -> string`: `''` when `renderAppDownloadLinks` is `''`, else heading (bold) + body paragraph + buttons, as email-safe HTML.
  - `DEFAULT_APP_SECTION_COPY = { heading, body }` (Global Constraints).
  - `un1tWriteSettingsFrom(...).appLinks` = `appLinksFrom(settings)`.
  - Stored shape `settings.un1t_online.app_links = { ios_url, android_url, heading, body }`. PATCH body key `app_links`: `z.object({ ios_url: z.string().trim().url().startsWith('https://').max(500).nullable().optional(), android_url: same, heading: z.string().trim().max(120).nullable().optional(), body: z.string().trim().max(600).nullable().optional() }).optional()`. The route merges it into the stored object (`null` clears a key). GET returns `app_links` as stored.

- [ ] **Step 1: Write failing tests** in `un1t-online-app-links.test.js`:
  - `appLinksFrom({ un1t_online: { app_links: { ios_url: 'https://apps.apple.com/x', android_url: 'http://bad' } } })` → `{ iosUrl: 'https://apps.apple.com/x', androidUrl: null, heading: DEFAULT_APP_SECTION_COPY.heading, body: DEFAULT_APP_SECTION_COPY.body }`.
  - `appLinksFrom(null)` → both URLs null, default copy.
  - `renderAppDownloadLinks({ iosUrl: null, androidUrl: null })` → `''`.
  - `renderAppDownloadLinks({ iosUrl: 'https://a', androidUrl: null })` contains `Download on the App Store` and not `Google Play`.
  - Both links: contains both labels, and `href="https://a?x=1&amp;y=2"` for an `&` in the URL.
  - `renderStudioLogo({ logoUrl: null, name: 'UN1T Hatch Street' })` contains `UN1T` and no `<img`; with a URL it contains `<img` and `alt="UN1T Hatch Street"`.
  - `renderAppSection` with no links → `''`; with links it contains the heading text.
  - No output contains `—` or `–`.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-app-links.test.js`; expect FAIL (module missing).
- [ ] **Step 3:** Implement the module; add `appLinks` to `un1tWriteSettingsFrom` (update its JSDoc return type).
- [ ] **Step 4:** Add a route test: a master PATCH with `{ app_links: { ios_url: 'https://apps.apple.com/x' } }` stores `settings.un1t_online.app_links.ios_url` and keeps the other `un1t_online` keys. `ios_url: 'http://x'` → 400. A non-master → 403 (existing gate).
- [ ] **Step 5:** Implement the route and the four inputs in `Un1tOnlineIntegrationTab.jsx` (labels "App Store link", "Google Play link", "App section heading", "App section text"; placeholders show the defaults; every `<button>` typed).
- [ ] **Step 6:** Run `npx vitest run src/lib/un1t-online-app-links.test.js src/lib/un1t-online-settings.test.js 'src/app/api/locations/[id]/un1t-online'`; expect PASS.
- [ ] **Step 7:** Commit `UN1TWELCOME.1 — app links setting and render helpers`.

### Task 2: `startStepOrder` and the `un1t_account_created` trigger

**Files:**
- Modify: `src/lib/sequences/enrol.js` (+ its test)
- Modify: `src/lib/sequences/triggers.js` (+ `triggers.test.js`)
- Modify (register the value next to `contact_created` in each): `src/app/api/sequences/route.js`, `src/app/api/sequences/[id]/route.js`, `src/lib/sequences/graph/schema.js`, `src/lib/sequences/graph/view.js`, `src/lib/sequences/agent/prompt.js`, `src/components/sequences/SequenceSettings.jsx` (label "When a new un1t.online account is created"), and every automations list component that maps trigger labels (`grep -rn "'contact_created'" src/components src/lib/sequences`)

**Interfaces:**
- Produces:
  - `enrolContacts({ ..., startStepOrder = 0 })`: writes `current_step_order: startStepOrder` on a fresh insert (the re-activation path is unchanged). It must be a non-negative integer, else throw.
  - `triggerSequencesForUn1tAccountCreated(db, { contactId, locationId, crmMade, un1tUserId }) -> Promise<{ ok: true, enrolled: number } | { ok: false, reason: string }>`. Reads `email_sequences` (`id, audience_filter`) at `locationId` with `trigger_type = 'un1t_account_created'` and `status = 'active'`. For each sequence whose audience the contact matches (`contactMatchesSequenceAudience`), it calls `enrolContacts({ sequenceId, contactIds: [contactId], sourceType: 'un1t_account_created', sourceRef: un1tUserId, startStepOrder: crmMade ? 1 : 0 })`. A read error or throw returns `{ ok: false, reason }` and is logged with `logError`. Unlike its siblings, it never swallows silently, because the sweep counts failures.

- [ ] **Step 1: Failing tests:**
  - enrol: `startStepOrder: 1` → the inserted row has `current_step_order: 1`; the default is 0; `startStepOrder: -1` throws.
  - trigger: one active matching sequence → `enrolContacts` called with `sourceType: 'un1t_account_created'`, `sourceRef: 'u1'`, `startStepOrder: 0`; `crmMade: true` → `startStepOrder: 1`; no sequences → `{ ok: true, enrolled: 0 }`; a sequences read error → `{ ok: false }`; an audience miss → not enrolled.
  - sequences POST route accepts `trigger_type: 'un1t_account_created'`.
- [ ] **Step 2:** Run `npx vitest run src/lib/sequences/enrol src/lib/sequences/triggers src/app/api/sequences`; expect FAIL.
- [ ] **Step 3:** Implement and register the value everywhere listed.
- [ ] **Step 4:** Rerun; expect PASS. Then add a scheduler test: an enrolment with `current_step_order: 1` on a one-step sequence completes with no send.
- [ ] **Step 5:** Commit `UN1TWELCOME.2 — un1t_account_created trigger and start step`.

### Task 3: Account stream lane in `sendEmailStep`, plus two merge tags

**Files:**
- Modify: `src/lib/sequences/steps.js` (+ its email-step tests)
- Modify: `src/lib/postmark.js` (`applyMergeTags` replacements), `src/lib/merge-tags.js` (+ `merge-tags.test.js`)

**Interfaces:**
- Consumes: `appLinksFrom`, `renderAppDownloadLinks`, `renderStudioLogo` (Task 1).
- Produces:
  - `TRANSACTIONAL_SOURCE_TYPES` gains `'un1t_account_created'`.
  - `export const ACCOUNT_STREAM_SOURCE_TYPES = Object.freeze(['un1t_account_created'])` and `export function isAccountStreamEnrolment(enrollment) -> boolean`.
  - Merge tags `{{app_download_links}}` ← `extras.app_download_links` and `{{studio_logo}}` ← `extras.studio_logo` in `applyMergeTags` (both `''` when absent). Registered in `MERGE_TAGS` with `offered: false` and `why: 'only resolved by sequence email steps; empty in a broadcast'`.
- Behaviour in `sendEmailStep`:
  - The location select adds `settings`. `app_download_links = renderAppDownloadLinks(appLinksFrom(seqLocation.settings))` and `studio_logo = renderStudioLogo({ logoUrl, name: companyName || locationName })`, using `logoUrl` from the existing `getLocationBranding` call. Both go into the extras of every sequence email, whatever the lane.
  - If the html contains `{{app_download_links}}` and it rendered `''`: `logWarn('sequences', 'app_download_links empty: no app links set', { locationId })`.
  - **Account stream** (`isAccountStreamEnrolment(enrollment)`): skip the `unsubscribeUrl` null-skip; give `unsubscribe_url`/`preference_url` extras `''`; no `appendUnsubscribeFooter`; send with `sendTransactionalEmail({ to, subject, htmlBody, contactId, locationId, tag: \`seq-${sequence.id}\`, replyTo: sequence.reply_to || await getLocationInboxReplyTo(sequence.location_id) || undefined, sourceType: 'sequence', sequenceId, sequenceStepId })`; no `stampMarketingTouch`. Everything else (feature gate, the list-row check, suppression) is unchanged.
  - Any other enrolment: byte-identical to today.

- [ ] **Step 1: Failing tests** (extend the existing `sendEmailStep` tests):
  - Enrolment `source_type: 'un1t_account_created'` → `sendTransactionalEmail` called, `sendMarketingEmail` not called, html has no unsubscribe footer, `stampMarketingTouch` not called, a contact with no unsubscribe token still sends, and marketing consent `false` still sends.
  - The same sequence with `source_type: 'manual'` → `sendMarketingEmail`, footer present (Review Focus 3).
  - Location settings with an iOS link and html `<p>{{app_download_links}}</p>` → the sent html contains `Download on the App Store`. With no links → the literal tag is gone, the html is otherwise unchanged, and `logWarn` is called (Review Focus 4).
  - `{{studio_logo}}` with branding `logoUrl` set → `<img`.
  - merge-tags test: both tags are registered with `offered: false`, and `applyMergeTags('{{app_download_links}}', {}, {})` → `''`.
- [ ] **Step 2:** Run `npx vitest run src/lib/sequences/steps src/lib/merge-tags src/lib/postmark`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun; expect PASS. Run `npm run check:select-columns`.
- [ ] **Step 5:** Commit `UN1TWELCOME.3 — account-stream lane and app/logo merge tags`.

### Task 4: Migration 790, account email app section, and the `account_email_sent_at` stamp

**Files:**
- Create: `supabase/migrations/790_un1t_welcome.sql`
- Modify: `src/lib/un1t-online-funnel-emails.js` (+ test), `src/lib/un1t-online-account.js` (`runSetPasswordStep`, + test)

**Interfaces:**
- Consumes: `renderAppSection`, `un1tWriteSettingsFrom(...).appLinks` (Task 1).
- Produces:
  - Migration: `ALTER TABLE public.un1t_clients ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS welcome_checked_at timestamptz, ADD COLUMN IF NOT EXISTS account_email_sent_at timestamptz;` then `UPDATE public.un1t_clients SET welcome_checked_at = now() WHERE welcome_checked_at IS NULL;` then a partial index `un1t_clients_welcome_due ON (location_id, first_seen_at) WHERE welcome_checked_at IS NULL`, plus `COMMENT ON COLUMN` for each (UN1TWELCOME.1) and the line `-- column-grant: n/a (un1t_clients is service-role only, mig 726)`. A closing `DO` block raises if any row has `welcome_checked_at IS NULL` after the UPDATE.
  - `sendUn1tAccountEmail(db, { ..., appLinks })`: when `renderAppSection(appLinks)` is non-empty, it is appended after `confirmEmailHtml(body)`, inside the same wrapper if `confirmEmailHtml` allows, else directly after. Kinds `account` and `trial_purchase` only, never `trial_used`.
  - `runSetPasswordStep` passes `appLinks: settings?.appLinks` into the email args. When `sent?.sent` is true, it runs `db.from('un1t_clients').update({ account_email_sent_at: new Date().toISOString() }).eq('location_id', locationId).eq('un1t_user_id', un1tUserId).select('id')`. On an error → `logError`; on 0 rows → `logWarn('un1t-account', 'account email sent but no un1t_clients row to stamp', { locationId })`. Neither changes the step's return value.

- [ ] **Step 1: Failing tests:**
  - funnel-emails: `kind` account with `appLinks` holding an iOS link → `sendTransactionalEmail`'s `htmlBody` contains the default heading and `Download on the App Store`. With no links → no heading. `trial_used` with links → no heading.
  - account: a sent explanation → the `un1t_clients` update is called with `account_email_sent_at` for `(locationId, un1tUserId)`. A not-sent explanation → no update. An update returning `[]` → `logWarn` and the step result is unchanged. An update error → `logError` and the step result is unchanged (Review Focus 5).
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-funnel-emails src/lib/un1t-online-account`; expect FAIL.
- [ ] **Step 3:** Write the migration and the code.
- [ ] **Step 4:** Rerun; expect PASS. Run `npm run check:select-columns`, and arm `src/lib/un1t-online-account.js` in `no-unchecked-supabase-write` if `npm run check:guardrails` passes with it armed. Otherwise leave it unarmed and note why in the commit.
- [ ] **Step 5:** Commit `UN1TWELCOME.4 — mig 790, account email app section, sent stamp`.

### Task 5: The welcome sweep and its cron arm

**Files:**
- Create: `src/lib/un1t-online-welcome.js`, `src/lib/un1t-online-welcome.test.js`
- Create: `supabase/migrations/791_un1t_welcome_sweep_heartbeat.sql` (applied AFTER deploy)
- Modify: `src/app/api/cron/un1t-online-sync/route.js` (+ its test), `src/lib/cron-arm-health.js` (header list), `eslint.guardrails.config.mjs` (arm the new file)

**Interfaces:**
- Consumes: `triggerSequencesForUn1tAccountCreated` (Task 2); columns from Task 4.
- Produces:
  - `sweepUn1tWelcomes(db, locationId, { now = () => new Date(), trigger = triggerSequencesForUn1tAccountCreated } = {}) -> Promise<{ ok: boolean, skipped_no_sequence: boolean, checked: number, enrolled: number, crm_made: number, waiting: number, no_contact: number, no_email: number, failed: number }>`. `ok: false` only when the sweep's own reads or stamps failed.
  - Algorithm:
    1. Count active `email_sequences` at the location with `trigger_type = 'un1t_account_created'` (`select('id', { count: 'exact', head: true })`). If there are none → `{ ok: true, skipped_no_sequence: true, ... }`. Nothing is read or stamped. If the read errors → `ok: false`.
    2. Page `un1t_clients` (`id, un1t_user_id, contact_id, first_seen_at, account_email_sent_at`), `welcome_checked_at IS NULL`, ordered by `first_seen_at, id`, 500 per page, until a short page arrives, capped at 10 pages per tick. Stamped rows drop out of the filter, so the next page's `.range()` offset is the number of rows left **unstamped** so far (waiting plus stamp failures), never page × 500. Otherwise the sweep either skips rows or re-reads waiting rows in a loop. Test: 3 waiting rows plus 500 due rows → every due row is processed once.
    3. Load the page's contacts (`id, email`) in one `.in()`.
    4. For each row: no `contact_id` and age < 48 h → `waiting` (no stamp). No `contact_id` and older → stamp, `no_contact`. Contact email blank → stamp, `no_email`. Otherwise call `trigger(db, { contactId, locationId, crmMade: !!row.account_email_sent_at, un1tUserId: row.un1t_user_id })`, then stamp whatever it answered (`failed++` and `logError` on `ok: false`).
    5. Stamp = `update({ welcome_checked_at: now().toISOString() }).eq('id', row.id).is('welcome_checked_at', null)`, with the error checked. A stamp error → `ok: false`, `logError`, and the sweep continues with the next row.
    6. One `logInfo('un1t-welcome', 'sweep done', counts)` per location (counts only, no PII).
  - Cron route: after `stampHeartbeat(CRON_NAME, …)` and **before** the reclassify loop, for each `okLocationIds` entry it calls `sweepUn1tWelcomes` raced against `min(30_000, TOTAL_DEADLINE_MS - elapsed)` in its own try/catch (the reclassify pattern). Then `stampHeartbeat('un1t-welcome-sweep', summedCounts)` under its own `.catch`, **only if** no location's sweep returned `ok: false`, threw, or timed out. Zero eligible locations still stamps.
  - Migration 791: the mig 633 pattern, `INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes) VALUES ('un1t-welcome-sweep', now(), 900, 1800, '<what it is, when it stamps, where to look>') ON CONFLICT (name) DO UPDATE SET …`, with the self-check `DO` block.

- [ ] **Step 1: Failing tests** in `un1t-online-welcome.test.js` (a supabase mock that records filters):
  - No active sequence → `skipped_no_sequence: true`, and no `un1t_clients` read or update (Review Focus 2).
  - The select filters `welcome_checked_at IS NULL` and orders by `first_seen_at`.
  - A row with no contact, 1 h old → `waiting: 1`, not stamped; 49 h old → stamped, `no_contact: 1`.
  - A contact with email `''` → stamped, `no_email: 1`, trigger not called (Review Focus 1).
  - `account_email_sent_at` set → trigger called with `crmMade: true`; null → `false`.
  - Trigger `{ ok: false }` → row still stamped, `failed: 1`, and the sweep's `ok` stays true.
  - Stamp update error → `ok: false`, and the next row is still processed.
  - Route test: a sweep returning `ok: false` → no `un1t-welcome-sweep` stamp, while `un1t-online-sync` still stamps; all ok → both stamp; a sweep that throws doesn't change the sync response.
- [ ] **Step 2:** Run `npx vitest run src/lib/un1t-online-welcome src/app/api/cron/un1t-online-sync`; expect FAIL.
- [ ] **Step 3:** Implement the module, the route arm, migration 791, the `cron-arm-health.js` header entry, and the guardrails arming.
- [ ] **Step 4:** Rerun; expect PASS. Run `npm run check:guardrails && npm run check:select-columns && npm run check:route-guards`.
- [ ] **Step 5:** Commit `UN1TWELCOME.5 — welcome sweep arm on un1t-online-sync`.

### Task 6: The sequence template, changelog, and full verification

**Files:**
- Create: `src/lib/sequences/templates/un1t-account-welcome.js` (exports `UN1T_ACCOUNT_WELCOME_HTML`)
- Modify: `src/lib/sequence-templates.js` (+ `sequence-templates.test.js`)
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)

**Interfaces:**
- Produces: a `SEQUENCE_TEMPLATES` entry `{ id: 'un1t_account_welcome', category: 'Onboarding', name: 'Welcome: new un1t.online account', description: <what it does; that CRM-made accounts whose account email sent skip step 1; that it sends as an account email; that if "New Lead – First Class Booking Nudge" is switched on at the same studio, its first wait should be raised to about a day so the welcome lands first>, trigger_type: 'un1t_account_created', trigger_config: {}, goal_config: null, send_window: { start_hour: 8, end_hour: 21, skip_days: [] }, steps: [{ step_type: 'email', delay_minutes: 0, subject: 'Welcome to {{location_name}}, {{first_name}}', html_content: UN1T_ACCOUNT_WELCOME_HTML }] }`. Match the existing entries' step field names exactly.
- `UN1T_ACCOUNT_WELCOME_HTML` is the mockup file verbatim, except:
  - the logo `<img>` and its "Hatch Street" line become `{{studio_logo}}`
  - "Sarah" becomes `{{first_name}}`
  - "UN1T Hatch Street" becomes `{{location_name}}`
  - the store-button table becomes `{{app_download_links}}`
  - the `<title>` becomes "Welcome"
  - the footer's "Champ Fitness Limited, Dublin, Ireland" line stays

- [ ] **Step 1: Failing test:** the template exists with `trigger_type: 'un1t_account_created'`, one email step, a subject containing `{{first_name}}`, and html containing `{{studio_logo}}`, `{{app_download_links}}` and `{{location_name}}`, with no `—`, no `–`, no `Sarah` and no `unsubscribe`.
- [ ] **Step 2:** Run `npx vitest run src/lib/sequence-templates`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full CI mirror from CLAUDE.md, then `npm run build`; expect all green.
- [ ] **Step 5:** Commit, push, `gh pr create --base main --fill`, then add `docs/changelog/entries/<PR>.md` and commit it to the PR.

### Task 7: Go live (operator steps, after the PR is green)

These touch production. Do them in order, and confirm each with Richard before running it.

- [ ] **Step 1:** Apply migration 790 via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj` **before** merging. Verify with `select count(*) from un1t_clients where welcome_checked_at is null` → 0. Then `get_advisors` (security).
- [ ] **Step 2:** Merge the PR; wait for the Vercel deploy.
- [ ] **Step 3:** Apply migration 791. Check that `cron_heartbeats` has the `un1t-welcome-sweep` row, and that it stamps on the next tick (`last_ok_at` moves).
- [ ] **Step 4:** Set Hatch Street's logo through `/api/settings/branding` to the UN1T logo Stillorgan uses (`branding/a0000000-0000-0000-0000-000000000001/logo.png`).
- [ ] **Step 5:** Ask Richard for the un1t.online App Store and Google Play URLs, and save them on Hatch's un1t.online card.
- [ ] **Step 6:** Create the sequence at Hatch Street from template `un1t_account_welcome` as a **draft**. Send Richard a test send of step 1 to his own address and wait for his look.
- [ ] **Step 7:** Richard switches the sequence on. The next sync tick welcomes every account first seen since migration 790. Check `sequence_enrollments` for `source_type = 'un1t_account_created'` and the `email_sends` rows on `postmark_stream = 'outbound'`.
