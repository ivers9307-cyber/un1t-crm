# Contracts Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One worktree subagent per PR below. Fable 5 orchestrator audits every diff, runs the build, creates the PR, applies migrations via Supabase MCP, and merges. Subagents NEVER push or touch migrations-apply.

**Goal:** Remove the issuing/adjustment friction in the contracts feature (per-contract edits, drafts, re-issue, bulk, defaults), render contracts as real documents (markdown → HTML/PDF), and close lifecycle gaps (reminders, resend, version history, gate drift).

**Architecture:** The existing freeze-at-issue model (`contracts.body_rendered`) is kept and leaned on: per-contract edits happen pre-issue and freeze as usual. All new admin behavior replicates org scoping in app code (service role bypasses RLS — repo invariant #1). Work ships as 9 PRs in 3 waves; each PR branches off fresh `origin/main` after the previous dependent PR merges.

**Tech Stack:** Next.js 16 App Router, Supabase (migrations via MCP, forward-only), Postmark, Vitest, Expo/RN mobile (`shared/` seam), `react-markdown` (web, renders via React elements, no raw-HTML injection surface), `react-native-markdown-display` (mobile, OTA-safe), `@react-pdf/renderer` (Wave C).

**Ground rules for every implementing subagent (non-negotiable):**
1. Read `CLAUDE.md` invariants first. Service-role = no RLS; scope by `user.activeOrganization?.id` / `getOwnerOrganizationIds(user)` exactly as the existing contracts routes do. Detail routes 404, never 403, for foreign ids.
2. TDD where there's logic: failing test → minimal code → pass. Pure logic goes in `src/lib/` with vitest coverage. UI-only changes need no new test harness but must not break existing tests.
3. Before finishing: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`. Do NOT run `npm run build` (orchestrator runs it once per PR — 8GB machine).
4. Every non-submit `<button>` inside a `<form>` gets `type="button"`.
5. Commit locally in the worktree with clear messages (`CONTRACTS-<TAG>.N — summary`). Do NOT push, do NOT create PRs, do NOT run migrations, do NOT touch `.env`.
6. New/changed routes get registered in `src/lib/openapi.js`. Add a `docs/CHANGELOG.md` entry.
7. Migration FILES are written into `supabase/migrations/` but NEVER applied by the agent. Check the current highest migration number in the directory first and take the next free one. Live-schema verification (`information_schema`) is the ORCHESTRATOR's job before merge.
8. Contracts recipients are staff, so hard-coded email copy matching the existing `contracts-email.js` style is acceptable (consistent with the feature's existing emails).
9. No em-dashes in any email copy or recipient-facing strings (house style).

---

## Wave A — foundations (A1 ∥ A2, then A3)

### PR-A1: Render contract markdown as a real document (web + mobile)

**Problem:** `body_rendered` is markdown but every surface renders it via `whitespace-pre-wrap` plain text — recipients sign documents showing literal `#`, `##`, `**`, `---`. No markdown lib exists in `package.json`.

**Files:**
- Create: `src/components/ContractBody.jsx` — single shared renderer. Client-safe, takes `markdown` string prop. Use `react-markdown` (outputs React elements — no HTML-string injection path) with `skipHtml` so raw HTML in a body renders inert. Support headings, lists, emphasis, hr; skip GFM tables unless trivial. Style with a scoped `contract-prose` class: serif, print-friendly heading hierarchy and list indentation — match the existing `bg-white text-gray-900 … font-serif` article styling.
- Modify: `src/app/admin/contracts/[id]/page.js` (line ~112), `src/app/account/contracts/[id]/page.js` (line ~95) — replace the `whitespace-pre-wrap` div with `<ContractBody markdown={c.body_rendered} />`. Keep the signature blocks untouched.
- Modify: `src/components/ContractTemplateForm.jsx` preview pane and `src/components/ContractIssueWizard.jsx` step-3 preview — render via `ContractBody`. The wizard's unfilled-placeholder highlight must survive: keep the existing `renderPreviewWithHighlights` raw view when `stillUnfilled.length > 0`, and show the `ContractBody` formatted view when everything resolves (or add a Raw/Formatted toggle — both states must be reachable).
- Modify: `mobile/app/contracts/[id].jsx` — render `body_rendered` with `react-native-markdown-display` (pure JS, OTA-safe; no runtimeVersion bump). Add dep to `mobile/package.json` then `cd mobile && npm install --package-lock-only` to re-sync the lock (EAS invariant).
- Modify: `package.json` — add `react-markdown`.
- Tests: check whether `src/components/*.test.*` files exist; if the repo has no component-test convention, do not invent one — rely on lint + orchestrator build. Any pure helper extracted gets a vitest file.
- Print check: the `@media print` styles on both detail pages must still produce a clean document.

**Definition of done:** `# Heading` renders as a heading on admin detail, account detail, template preview, wizard preview, and mobile. A `<script>` tag placed in a template body renders inert text, never executes.

### PR-A2: Unsigned-contract reminders + awaiting-days indicator

**Files:**
- Create: `supabase/migrations/<next>_contract_reminders.sql` — add to `contracts`: `last_reminded_at timestamptz`, `reminder_count integer not null default 0`. Comment both. Insert a `cron_heartbeats` row named `contract-reminders` in the same migration (repo convention).
- Create: `src/app/api/cron/contract-reminders/route.js` — Bearer `CRON_SECRET` guard. Copy the NEWEST existing cron's auth + scheduling registration pattern exactly (check whether recent crons register via QStash push or `vercel.json`; mirror it and report which to the orchestrator). Logic: select contracts `status in ('issued','viewed')` where (`reminder_count = 0` and `issued_at < now()-3d`) or (`reminder_count = 1` and `issued_at < now()-7d`). Cap at 2 reminders. Paginate with `.range()` + `.order()` (1k-cap invariant). Per contract: reminder email via new `sendContractReminderEmail` in `src/lib/contracts-email.js` (mirrors issued-email style, subject "Reminder: … awaiting your signature") + push (mirror the issue route's push block, category `contract_issued`), then update `last_reminded_at`/`reminder_count`. Row failures logged, never abort the batch. `stampHeartbeat('contract-reminders')` on success.
- Modify: `src/app/admin/contracts/page.js` — issued/viewed rows show subtle "awaiting Nd" (days since `issued_at`; no `new Date(\`…Z\`)` construction — diff the ISO timestamps directly).
- Test: extract the due-predicate into `src/lib/contracts.js` as pure `reminderDue(contract, now)`; vitest pins: <3d no; ≥3d count 0 yes; ≥3d count 1 no; ≥7d count 1 yes; count 2 never; signed/declined/revoked/draft never.
- Register the cron per existing convention (most cron routes are exempt in `check:route-guards` EXEMPT map only if token-public — CRON_SECRET routes follow the standard pattern; check the script).

### PR-A3: Gate alignment (small)

**Decision (Richard can veto at PR):** read surfaces follow the grantable `contracts` permission; write surfaces stay owner/master.

**Files:**
- Modify: `src/app/admin/contracts/[id]/page.js` — replace `isOwnerOrMaster` redirect with `hasPermission(user, 'contracts')` (import from `@/lib/permissions`); keep org scoping exactly as-is. Render `ContractRevokeButton` only for owner/master. Check `/api/contracts/[id]/revoke` has a server-side owner/master check; add one if missing.
- Leave `/admin/contracts/issue`, `/admin/contracts/templates*`, POST `/api/contracts`, and template routes owner/master.
- Modify: `src/app/admin/contracts/page.js` — hide "Issue contract" / "Templates" buttons for permission-granted users who are not owner/master (compute server-side), so granted users don't click into redirects.
- Test: if the revoke route gains a role check, extend its test file accordingly.

---

## Wave B — issuing flow (strictly sequential; each branches after the prior merges)

### PR-B1: Editable body at step 3 + surface email warning + resend

**Files:**
- Modify: `src/lib/schemas.js` — `contractIssueSchema` gains `body_override: z.string().min(1).optional()`.
- Modify: `src/app/api/contracts/route.js` POST — after rendering, if `body_override` present: `extractPlaceholders(body_override)` must be empty (else 400 with the keys); use it as `body_rendered`; add `body_edited: true` to audit `details`. `variables_data` stores the merged map either way.
- Modify: `src/components/ContractIssueWizard.jsx` step 3 — "Edit text" toggle: textarea seeded with the rendered preview; edits held in `bodyOverride` state; Formatted/Raw preview of the override via `ContractBody`; a visible "edited" chip; "Reset to template" reverts to null. POST includes `body_override` only when edited. Navigating back to steps 1–2 discards the override after a confirm.
- Warning surfacing: `handleIssue` currently discards `json.warning` (email failure — issuer never learns the recipient wasn't notified). Persist it across the redirect (query param or sessionStorage) and render a dismissible amber banner on `/admin/contracts/[id]`.
- Create: `src/app/api/contracts/[id]/resend/route.js` — POST, owner/master, org-scoped read (mirror the revoke route's scoping precisely), only for `issued`/`viewed`; re-fires `sendContractIssuedEmail` + push; `{success, warning?}`. Register in openapi.js.
- Modify: `src/app/admin/contracts/[id]/page.js` — "Resend email" button (client component mirroring `ContractRevokeButton` structure) for issued/viewed.
- Tests: issue-route tests for `body_override` (accepted; rejected with leftover placeholders; audit flag set) following `src/app/api/contracts/route.test.js` conventions; resend route tests (403 non-owner, 404 foreign org, 409 signed, success).

### PR-B2: Draft status + re-issue prefill

**Files:**
- Modify: `src/lib/schemas.js` — `contractIssueSchema` gains `save_as_draft: z.boolean().optional()`.
- Modify: `src/app/api/contracts/route.js` POST — when `save_as_draft`: insert `status: 'draft'`, SKIP email + push, audit action `contract.drafted`.
- Create: `src/app/api/contracts/[id]/send/route.js` — POST, owner/master, org-scoped, draft→issued via `canTransition`, stamp `issued_at: now()`, then email + push + audit `contract.issued`. Extract the shared notify logic from the issue route into `src/lib/contracts-notify.js` (`notifyContractIssued({db, contract, user})`) so it isn't duplicated. Register in openapi.js.
- Create: `src/app/api/contracts/[id]/discard/route.js` — POST, owner/master, org-scoped, draft→revoked WITHOUT the recipient email (recipient never knew). Keep `canTransition` authoritative. Register in openapi.js.
- Modify: `src/components/ContractIssueWizard.jsx` step 3 — secondary "Save as draft" button.
- Create: `src/components/ContractDraftActions.jsx` — "Send now" / "Discard draft" buttons for the admin detail page.
- Modify: `src/app/admin/contracts/[id]/page.js` — draft banner "Draft, not sent yet" + `ContractDraftActions`.
- Re-issue prefill: wizard accepts `?from=<contractId>`; fetch GET `/api/contracts/[id]` (verify it returns `template_id`, `profile_id`, `variables_data` to an admin caller with org scoping intact; extend its select if needed). Prefill recipient, template, and custom vars only — never the body (edited bodies get re-created via B1's editor; show hint "Variables restored from the previous contract"). Custom vars = `variables_data` minus `profileVariables(recipient)` keys minus `today` — implement as pure `customVariablesFrom(variablesData, recipientProfile)` in `src/lib/contracts.js`.
- Modify: `src/app/admin/contracts/[id]/page.js` — revoked/declined: "Re-issue" link → `/admin/contracts/issue?from=<id>`; issued/viewed: second "Revoke & re-issue" action that revokes then redirects to the prefilled wizard.
- Tests: draft→issued via send route; draft→revoked via discard; sign route 409s on a draft (add case); `customVariablesFrom` vitest (strips profile-derived + today, keeps custom).

### PR-B3: Variable defaults + expanded auto-fill vocabulary

**Files:**
- Modify: `src/components/ContractTemplateForm.jsx` — each custom-variable row gains an optional `default` input; persisted on `variables_schema` rows as `default`. No migration (JSONB). Add "Location" group rows to `PROFILE_VAR_HELP`.
- Modify: `src/components/ContractIssueWizard.jsx` — selecting a template initializes `vars` from each row's `default` (issuer can overwrite); re-selecting resets to that template's defaults.
- Modify: `src/lib/schemas.js` — extend `contractTemplateSchema`'s `variables_schema` row shape with optional `default` if it validates rows.
- New pure `locationVariables({ location, branding })` in `src/lib/contracts.js` → `location_name`, `company_name`, plus `location_address` ONLY if address fields exist on `locations` (orchestrator verifies live schema before merge; write the function defensively off whatever it's passed — only emit keys that resolve to non-empty).
- Issue route: extend the recipient select's `location` embed with the verified fields; fetch branding via `getLocationBranding(db, locationId)`; merge order profile < location < custom.
- Wizard parity: export `LOCATION_VAR_KEYS` from `src/lib/contracts.js`; `unresolvedPlaceholders` gains an optional arg to treat those keys as resolvable — used identically client- and server-side so the two never disagree. Client preview substitutes bracketed placeholders like `[location name]`.
- Tests: `locationVariables` (only-resolving-keys behavior pinned), merge precedence, `unresolvedPlaceholders` new-arg behavior.

### PR-B4: Bulk issue

**Files:**
- Modify: `src/components/ContractIssueWizard.jsx` — step 1 recipient picker becomes a searchable checkbox multi-select (single-recipient UX stays visually equivalent). Template list filters to templates compatible with EVERY selected recipient. Step 2: shared custom variables (B3 defaults apply). Step 3: per-recipient preview pager, ONE countersign, body editing disabled when >1 recipient (hint shown), "Issue N contracts" loops the existing POST sequentially client-side with per-recipient results + retry-failures-only. "Save as draft" loops the same way.
- No new endpoint. A mid-loop failure leaves earlier contracts validly issued and visibly reported.
- Tests: pure `eligibleTemplatesFor(recipients, templates)` in `src/lib/contracts.js` (mixed fte+contractor → only 'both'; unknown employment_type → only 'both'; empty selection → all).

---

## Wave C — records & artifacts

### PR-C1: Template version history

**Files:**
- Create: `supabase/migrations/<next>_contract_template_versions.sql` — table `contract_template_versions (id uuid pk default gen_random_uuid(), template_id uuid not null references contract_templates(id) on delete cascade, version integer not null, body_markdown text not null, variables_schema jsonb not null default '[]', changed_by uuid references profiles(id), created_at timestamptz not null default now(), unique(template_id, version))`. RLS: enable; ONE SELECT policy `TO authenticated` ORing master + org-owner populations (copy mig 106's template-read predicates, `(select auth.uid())` wrapped). No client-write policies (service-role writes only).
- Modify: `src/app/api/contract-templates/[id]/route.js` PATCH — the existing body-change preflight already SELECTs `version`; extend to `version, body_markdown, variables_schema` and archive the OLD row via `.upsert(..., { onConflict: 'template_id,version', ignoreDuplicates: true })` before updating. Archive failure fails the PATCH.
- Create: `src/app/api/contract-templates/[id]/versions/route.js` — GET, same guard + org scoping as template GET, ordered version desc. Register in openapi.js.
- Modify: `src/app/admin/contracts/templates/[id]/page.js` — "History" section: version, date, changed-by, expandable read-only body (raw `<pre>` is fine here).
- Tests: PATCH with body change archives; name-only PATCH doesn't; versions GET 404s foreign org (mirror `contract-templates/[id]/route.test.js`).

### PR-C2: Signed PDF artifact

**Riskiest PR — orchestrator audits hardest, verifies serverless bundle size in the build.**

**Files:**
- Add dep: `@react-pdf/renderer`.
- Create: `src/lib/contract-pdf.js` — `renderContractPdf({ contract, issuerName, recipientName, templateName, branding })` → Buffer. Export `parseContractBlocks(markdown)` separately: split into headings (#/##/###), paragraphs, `-` list items, `---` rules, `**bold**` inline; anything unrecognized falls back to a literal paragraph. Map blocks to react-pdf primitives; serif; dual signature block matching the web layout (names, Dublin-formatted timestamps, IP).
- Modify: `src/app/api/contracts/[id]/sign/route.js` — after the status flip, before emails: generate PDF, upload via service client to bucket `contracts` at `${contract.id}/signed.pdf` (`contentType: 'application/pdf'`, `upsert: true`), set `signed_pdf_path`. PDF failure = warning, never blocks the sign (DB row stays the legal record).
- Modify: `src/lib/contracts-email.js` — attach the PDF to both signed-confirmation emails. Check `src/lib/postmark.js` `sendEmail` for attachment support; if absent, add an `attachments` passthrough (Postmark shape `{ Name, Content: base64, ContentType }`). Missing buffer → send without attachment.
- Create: `src/app/api/contracts/[id]/pdf/route.js` — GET; authorize recipient OR owner/master org-scoped (same population as page access; 404 for foreign); redirect to a 60-second `createSignedUrl` for the storage object. Never a public URL. Register in openapi.js.
- Modify: both detail pages — "Download PDF" button when `signed_pdf_path` is set.
- Tests: `parseContractBlocks` vitest; pdf route authz (recipient ok, foreign staff 404, org owner ok).

---

## Orchestrator protocol (Fable 5, per PR)

1. Launch ONE worktree subagent (`isolation: "worktree"`, background) with the PR brief + ground rules. Max 2 concurrent agents (8GB RAM); wizard-touching PRs strictly sequential.
2. On completion: read the diff (`git diff main`) in the worktree; audit against repo invariants (scoping/404s, thenables, awaits, button types, 1k cap, heartbeat), this plan's DoD, and scope creep. Bounce fixes back to the same agent via SendMessage unless trivial.
3. Run the full CI mirror + `npm run build` in the worktree (never two builds concurrently).
4. Migrations: verify live schema assumptions via Supabase MCP (`information_schema`, project `iyvtbjjxdggiadzwwvdj`), then `apply_migration` + `get_advisors` (security) BEFORE merging the code PR.
5. Push `HEAD` to a descriptive branch, `gh pr create --base main --fill` (body cites plan section, decisions, migs), verify checks green, merge, delete branch. Next dependent agent branches off the NEW origin/main.
6. Audit that the PR includes its `docs/CHANGELOG.md` entry.

## PR → dependency map

| PR | Depends on | Parallel-safe with |
|----|-----------|-------------------|
| A1 markdown | — | A2 |
| A2 reminders | — | A1 |
| A3 gates | — | (runs when a slot frees) |
| B1 edit body + resend | A1 merged | — |
| B2 draft + re-issue | B1 merged | — |
| B3 defaults + autofill | B2 merged | — |
| B4 bulk | B3 merged | — |
| C1 version history | A wave merged | C2 |
| C2 PDF | A1 merged | C1 |
