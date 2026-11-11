# CRM platform functionality and improvement audit

Date: 21 October 2026. Reviewed baseline: `origin/main` at `2550b98c`.

## Overall assessment

The CRM has substantial business functionality. It connects acquisition, contact management, communications, bookings, member engagement, team operations, accounting and car processing. Much of it has thoughtful permission checks, focused regression tests and operational monitoring. This is a working business platform with a reliability problem at particular boundaries, rather than a platform short of features.

The highest-value next investment is **reliable completion and recovery**: an operation should not look complete when its task, attachment, permission lookup or financial record failed. Several independently implemented workflows make this mistake. A second priority is consistent tenant and feature permissions in helpers and alternate entry points, including the staff assistant.

This review records **24 findings**, grouped by remediation unit: 13 P1 findings and 11 P2 findings. Some entries contain related failure modes. P1 means address promptly because the path can affect access, money, customer records or a core promised operation. P2 means a material reliability, reporting or verification weakness. These are audit priorities, not claims of observed production incidents.

## Scope and confidence

The audit inventoried the web platform and reviewed implementation and existing tests across the feature families below. Repository checks identify 205 pages and 895 API routes. Deep review sampled consequential workflows within each family; it did not individually execute every route or every configuration combination.

Evidence labels:

- **Source trace:** a concrete input, database error or concurrency sequence follows the cited implementation to the stated result. This establishes a code defect but does not establish production frequency.
- **Local reproduction:** the actual function was run against isolated mock state or an in-memory database. No production customer data or provider was used.
- **Product opportunity:** a proposed improvement, not a claim that an existing feature is broken.

No authenticated browser session was available. The public sign-in page at `crm.repset.ie/login` rendered its email-link form and password-mode control; no sign-in was submitted. No live messages, payments, refunds, door commands, imports or customer changes were made. No credentials or `.env` files were read or copied. Production database settings, deployed schema, provider configuration, delivery rates, performance under real load and authenticated-screen usability remain unverified. The schema findings use the migration history checked into this repository. This is an engineering and workflow audit, not a legal-compliance certification.

Mobile implementation was not audited; web/mobile parity checks do not certify the phone's workflows. No application code, permissions, allowlists or migrations were changed by this review.

## Recommended order of work

| Order | Work package | Why it comes first | Completion evidence |
|---|---|---|---|
| 1 | Access and tenant boundaries: A01–A05 | Public event data, other tenants' records, physical access and disabled features must remain protected through alternate paths and errors. | Adversarial two-tenant tests; restricted users tested through direct routes and assistant tools; failed permission reads cannot grant access. |
| 2 | Money and accounting: A06, A07, A16 | Provider success and CRM state can diverge, leaving paid deposits unrecorded, duplicate refund risk or bills without evidence. | Duplicate delivery, ambiguous provider timeout, failed local write and concurrent-refund tests for each provider; reconciliation of an interrupted attempt. |
| 3 | Recoverable core operations: A08–A13 | Imports, policies, maintenance and sequence tasks must not lose recoverability or silently stop doing their job. | Inject a failure at every persistence boundary, retry, and verify the business result and history. |
| 4 | Sending and operator trust: A14, A15, A17–A24 | Quiet hours, approvals, displays, awards, exports and monitoring need accurate outcomes. | Tests assert the customer/operator-visible result, including partial and unavailable states. |
| 5 | Product improvements | Improve daily operator throughput once outcomes are trustworthy. | Measure time to complete work, unresolved items and recovery time before and after each change. |

The packages are suggested scopes, not implementation approval. Any fix requiring a migration, new permission or allowlist change needs a separate brief and the repository's required decision before it is written.

## Feature-by-feature review

“Implemented” below means supported by source and existing tests; it does not mean live-provider acceptance was performed in this audit. File paths are entry points for the evidence, not an exhaustive list of files read.

### Contacts, sales and acquisition

| Feature | Functionality reviewed | Assessment and worthwhile next improvement | Evidence entry points |
|---|---|---|---|
| Contacts and member record | CRUD, linked memberships, timeline, notes, consultations, goals, devices, account links, merge/duplicates and export. | Broad operational record. Close assistant permission bypass A05. Add a clear field/source freshness view where staff must distinguish Glofox, imported and manually maintained facts. | `src/app/api/contacts/`, `src/components/ContactActions.jsx` |
| CSV imports | Preview, validation, conflict choices, duplicate matching, tags, queued execution, row outcomes, error exports and master rollback. | Useful workflow, but rollback assurance is undermined by A08–A09. Show durable row-level partial/retry states before expanding import functionality. | `src/lib/contact-import-runner.js`, `src/lib/contact-import-queue.js`, `src/app/api/contacts/imports/` |
| Pipeline and deals | Classifier-derived stages, multiple flows, board-specific card data and lazy column loading. | Stage placement is intentionally derived; manual drag-to-stage is retired. Improve explanation of why a contact is in a stage and when source data last refreshed, rather than reintroducing manual overrides. | `src/app/api/pipeline/deals/route.js`, `src/components/KanbanBoard.jsx` |
| Tasks and activities | Lists/boards, statuses, priorities, projects, assignees, due dates, contact linkage and integration API. | Current task routes have dedicated operation gates. Sequence-created tasks are broken (A12), and assistant writes bypass those gates (A05). Make all writers use one task operation. | `src/lib/activity-web-writes.js`, `src/lib/activity-write-gate.js`, `src/app/api/activities/` |
| Dashboards | Today, studio, business and advertising views; operational queues and summaries. | Useful breadth. Make the source, as-of time and unavailable signals explicit; avoid a failed read being indistinguishable from a zero. | `src/app/dashboard/`, `src/components/dashboard/` |
| Lead and churn radars | Scoring, snooze/action history, winback and arrears actions; membership-source adapters. | Paginated core reads are a strength. Lead action read errors currently become an empty list, so snoozed/contacted people can reappear without warning. Show an incomplete-data state and measure outcomes after operator actions. | `src/lib/lead-radar-data.js:61`, `src/app/dashboard/churn-radar/` |
| Landing pages and lead capture | Location-specific blocks, branding, media, editable copy, visibility controls and class/lead funnels. | Real editing and funnel functionality exists. Add funnel completion measurements tied to the actual booking/trial outcome, with source freshness and drop-off reasons. | `src/components/landing-page/`, `src/app/settings/landing-page/`, `src/app/start/` |

### Communications and automation

| Feature | Functionality reviewed | Assessment and worthwhile next improvement | Evidence entry points |
|---|---|---|---|
| Unified inbox | WhatsApp/Instagram queues, unread handling, takeover/handoff, search beyond the initial lists and contact linkage. | Substantial staff workflow. Prioritise clear ownership, waiting-on-customer/provider states and unresolved-age measures. Email has its own mail surface. | `src/components/UnifiedInbox.jsx`, `src/app/communications/(hub)/inbox/` |
| Email inbox and tickets | Compose, reply/reply-all, forwarding, internal notes, signatures, attachments, archive/spam and contact linking. | Mature implementation. Use recoverable delivery/filing states consistently and retain the difference between an internal note and a customer message. | `src/components/mail/`, `src/app/api/email/`, `src/lib/mail/` |
| WhatsApp | Conversations, template/media/carousel/Flow handling, reactions, consent, organisation numbers, studio routing, broadcasts and agent handoff. | Extensive implementation and focused tests. A single operational view of paused/failed/suppressed sends, with a safe next action, is more valuable than another send surface. | `src/lib/whatsapp.js`, `src/app/api/whatsapp/` |
| SMS | Legacy sequence compatibility and historical references. | Retired, not an active communication channel. Do not present it as a missing current capability; legacy sequence SMS steps explicitly skip. | `src/lib/sequences/steps.js:652` |
| Marketing composer, campaigns and templates | Unified send, email/WhatsApp templates, scheduling, sent views and reporting. | Good feature coverage. Measure attributable conversion and distinguish selected audience, eligible audience, attempted delivery and provider-confirmed outcome. | `src/app/communications/`, `src/lib/campaign-sender.js` |
| Saved audiences and consent | Saved segments, tag vocabulary/counts, per-location preferences and audited consent changes. | Whitelisted filters and studio-specific consent are strengths. Add a plain explanation of why a sampled person is included or excluded and preview the final eligible audience. | `src/lib/audience-filter.js`, `src/components/AudienceBuilder.jsx`, `src/app/api/contacts/segments/` |
| Sequences | Visual graph, publish validation, triggers, branches, goals/exits, email/WhatsApp, tags, tasks, webhooks, retries and resume/history. | Breadth exceeds failure-path assurance: A12–A15 affect task execution, termination, send windows and duplicates. Prioritise explicit sent/skipped/deferred/failed outcomes and durable execution identity. | `src/lib/sequences/`, `src/components/SequenceSettings.jsx` |
| Mia customer agent | Channel adapters, knowledge, booking/account/event/purchase tools, autonomy settings, takeover, rate limits and decision traces. | A substantive agent system. No additional independently confirmed Mia defect emerged from sampled paths. Prioritise a repeatable acceptance set for correct booking, refusal, ambiguity, escalation and source/provider outage. | `src/lib/agent/`, `src/app/settings/customer-agent/` |
| Staff assistant | Contact/task/shift tools, schedule/leave/allowance reads, reports and streaming responses. | Tenant scoping is present, but tool permissions are too coarse (A05). Display the specific change performed and enforce each destination operation's actual gate. | `src/app/api/assistant/chat/route.js`, `src/lib/assistant-prompt.js` |

### Bookings, events and member services

| Feature | Functionality reviewed | Assessment and worthwhile next improvement | Evidence entry points |
|---|---|---|---|
| Appointment bookings | Event types, availability, slots, staff/public creation, reminders, outcomes and token-managed cancellation/rescheduling. | Meaningful end-to-end implementation. Acceptance testing should cover the last slot, simultaneous booking, expired manage token, timezone boundary and provider refusal. | `src/app/api/public/book/`, `src/app/api/public/booking-manage/`, `src/app/api/bookings/` |
| Events and checkout | Multiple event types, waves/teams, member pricing, promo codes, waitlists, payment resume and confirmations. | Fix public team identity A01 and capacity A24 before promoting high-demand team events. Make reservation expiry and payment recovery visible to operators. | `src/app/api/public/events/[slug]/register/route.js`, `src/lib/race-payments.js` |
| Race control and check-in | Manual/bulk/QR check-in, control board, starts, timing and penalties. | Genuine event-day workflow. Add large-event/connection-loss rehearsal; consider changed-state responses instead of repeatedly transferring the full roster. | `src/app/api/events/[id]/`, `src/lib/race-control.js` |
| Host portal | Separate host auth, event drafting/submission, attendee moves/exports, promo codes, contacts/signup QR, campaigns, statements and payouts. | Broad marketplace workflow with organisation checks. Prioritise a single per-event settlement/reconciliation view and clear approval/payment next actions. | `src/lib/host-auth.js`, `src/app/api/host/` |
| Challenges | Individual/collective challenges, points/classes/zone metrics, standings and flagship transformations. | Paginated calculations and edit restrictions are strengths. Improve explanation of qualifying activity, data freshness and why a disputed result counted or did not count. | `src/lib/challenges-io.js`, `src/app/api/challenges/` |
| Achievements | Catalogue, configurable detector rules, session evaluation and retroactive awards. | Historical backfill can omit qualifying activity (A19). Correct historical evaluation and completeness before adding more awards. | `src/lib/achievements.js`, `src/app/api/admin/achievements/` |
| Pulse and onboarding | First-90-day pace, worst-first prioritisation, latest coach touch and shared action history. | A focused operator lane. Measure contact-to-action-to-attendance outcomes, and explain the next useful intervention rather than expanding the number of scores. | `src/lib/onboarding-journey-data.js`, `src/app/api/pulse/journey/` |
| Hyrox programming | Blocks, generated sessions, exemplars/settings, regeneration, approval, week expansion, publishing and reminders. | Substantial planning workflow. Add a publish-readiness checklist using existing validation and a clear explanation of what regeneration will replace. | `src/lib/hyrox/`, `src/app/api/hyrox/` |
| InBody and body metrics | Account/bridge ingestion, queue/backfill, parsing, phone matching and canonical weight observations. | Tenant matching is unsafe (A03). After correcting it, offer an auditable unmatched/ambiguous scan queue with deliberate linking. | `src/lib/inbody-ingest.js`, `src/app/api/bridge/inbody/` |

### Team and operations

| Feature | Functionality reviewed | Assessment and worthwhile next improvement | Evidence entry points |
|---|---|---|---|
| Staff, roles and invitations | Invitations, per-location roles, sparse overrides, compensation, reactivation/deactivation and login state. | Detailed permission and safe-column handling. Invitation email can precede completed assignment provisioning; add an explicit recoverable setup state instead of manual delete/recreate recovery. | `src/app/api/staff/`, `src/lib/staff-write.js`, `src/lib/staff-login-access.js` |
| Studio-device access | PIN sessions, paired-device/session machinery and device administration. | Existing source shows shipped PIN/session functionality; older plans must not be mistaken for current gaps. Rehearse lost-device revocation, idle lock and reauthentication in the actual device UI. | `src/lib/studio-session.js`, `src/app/api/auth/pin-login/`, `src/app/admin/studio-devices/` |
| Scheduling and rosters | Templates, block edits, bulk assignment, copy, drafts, publishing, budget approval, snapshots/history and horizon extension. | Strong operational coverage. Prioritise clear publication/change summaries and completion evidence for any partially failed bulk action. | `src/lib/roster-publish.js`, `src/app/api/schedule/rosters/` |
| Availability, cover and swaps | Recurring/dated availability, candidate ranking, offers, first-claim handling and cover/drop/replacement. | Race handling and degraded side-read states are thoughtful. Improve explanation of candidate rejection and unresolved cover escalation. | `src/lib/candidates-data.js`, `src/app/api/schedule/offers/`, `src/app/api/schedule/swaps/` |
| Time off and holidays | Entitlements, approvals, clashes, contractor restrictions and controlled cancellation. | Detailed guards. Advisory warnings and the choice not to silently rewrite published rosters are deliberate. Show remaining staffing action next to the leave decision. | `src/app/api/schedule/time-off/`, `src/lib/bank-holidays.js` |
| Attendance and qualifications | Geofence evidence, attendance reports, expiry/types/records, template requirements and candidate gaps. | Missing evidence is appropriately distinguished from proof of absence in documented policy. Keep “not checked” distinct from qualified/present and rehearse denied-device-permission cases. | `src/app/api/attendance/`, `src/lib/qualifications-server.js` |
| Hours, costs and reports | Weekly overtime, hours/cost/utilisation/leave/coverage reports, schedules and WRC pack. | Rate/report access uses target-studio checks. Validate payroll outputs against representative approved rosters, employment types and date boundaries before operational reliance. | `src/lib/payroll.js`, `src/lib/report-generator.js`, `src/app/api/schedule/reports/` |
| Contracts | Draft, issue/resend, recipient signing, impersonation refusal, frozen content, PDF/backfill and notifications. | Good separation of signed result from secondary PDF/email failure. Surface any outstanding artefact/delivery repair as an actionable state. | `src/app/api/contracts/`, `src/app/account/contracts/` |
| Policies | Organisation-scoped versions, view/dwell evidence and compliance screens. | Publication and reading-evidence defects A10/A23 need correction. Show the effective/current version clearly and preserve the old version through failed publishing. | `src/lib/policies.js`, `src/app/api/policies/` |
| Approvals | Registered providers, category permissions/bundles, studio scope and retryable execution. | A useful shared inbox; unavailable providers currently look empty (A17). Keep available categories usable while clearly flagging incomplete totals. | `src/lib/approvals/registry.js`, `src/components/ApprovalsInbox.jsx` |
| Checklists | Weekday/role templates, immutable instance snapshots, ticking, overdue/compliance sweeps. | Conditional transitions protect concurrent completion. Improve missed-item escalation and recurring-failure trends before adding more template controls. | `src/lib/checklist-sweep.js`, `src/app/api/checklists/` |
| Maintenance and equipment | Assets/types, schedules/due dates, draft inspections, photos/issues and service status. | Submission can leave equipment safety state inconsistent (A11). Make partial submissions and failed service-state updates visible and recoverable in the existing maintenance/issues views. | `src/lib/equipment-db.js`, `src/app/api/equipment/` |
| Doors | User-specific lists, remote unlock, widget auth and audit trail. | Fix failed allowlist reads A04. Rehearse revoked access and unavailable permission storage before device-control convenience changes. | `src/lib/studio-doors.js`, `src/app/api/studio-management/unlock/` |
| Sonos and Shelly | Music control/schedules; relay control, overrides, schedules, freshness and energy. | Implemented with explicit product boundaries. Sonos reconcile has a fixed 200-item batch worth reviewing for fair progress. Shelly outage alerts are an optional product decision, not a missing promised feature. | `src/app/api/sonos/`, `src/lib/shelly/`, `docs/BACKLOG.md` |
| TVs and presentations | Tokenised displays, templates/media, deck authoring, public playback and live states. | Persistence/read errors can leave stale or empty screens (A18). Preserve last good display state and show content-version acknowledgement. | `src/app/api/admin/tv-displays/`, `src/app/api/presentations/`, `src/app/api/public/presentations/` |

### Finance, cars and platform administration

| Feature | Functionality reviewed | Assessment and worthwhile next improvement | Evidence entry points |
|---|---|---|---|
| Supplier invoices and card receipts | OCR/capture, review, suppliers/accounts/tax, draft Xero bills, attachments and signed receipt uploads. | Practical AP workflow. Bulk processing loses attachment failure state (A16); share single/bulk outcome handling and expose repair without recreating the bill. | `src/lib/invoices-queue/`, `src/app/api/invoices-inbox/`, `src/app/api/card-receipts/` |
| Accounting hub | Coverage/exceptions, mailbox hunting, health, event fees and aged payables. | Useful reconciliation scaffolding. Link unresolved exceptions directly to the durable action that repairs them; measure age and value of unmatched work. | `src/app/api/accounting/`, `src/app/(money)/accounting/` |
| Orders, offers and refunds | Generic order ledger, abandonment/recovery, cancellations, cumulative refunds, timed offers and server pricing. | Fix tenant recovery A02 and refund consistency A07. Use one provider-independent acceptance contract for repeated/ambiguous/concurrent attempts. | `src/lib/orders.js`, `src/app/api/orders/`, `src/app/api/public/offers/` |
| Cars, deposits and BCA | Inventory, margins/FX snapshots, buyers, documents, signed uploads/finalisation, Xero invoices/PDFs, deposits/terms and BCA packs/history. | End-to-end workflow exists. Deposit reconciliation A06 is the priority. Preserve EUR-only deposits and the decision against a car-detail refund UI. | `src/app/api/cars/`, `src/components/cars/`, `src/lib/bca*.js` |
| Tenancy, permissions and API keys | Organisations/locations, per-location roles/overrides/bundles, organisation integration keys and service-role route checks. | Strong defensive intent and structural checks, but helper/alternate-path gaps A02–A05 remain. Test actual business operations across two tenants instead of relying solely on guard presence. | `src/lib/auth.js`, `src/lib/permissions.js`, `src/lib/api-auth.js`, `src/lib/with-auth.js` |
| Health, queues and integrations | Cron heartbeats, connection health, tenant health, dead-letter triage/replay and usage/billing. | Considerably better than logs alone. Extend “unknown is not healthy” consistently to approvals/radars. Review unpaged estate-wide health reads before scale makes totals incomplete. | `src/lib/tenant-health.js`, `src/app/api/admin/webhook-dead-letter/`, `src/lib/connection-health.js` |
| Privacy tools and audit | Contact export/erasure, consent evidence, privacy entity resolution, retention jobs and audit search/CSV. | Useful tooling; export audit category and CSV completeness are defective (A20–A21). Present partial export sections clearly and test source/schema contracts. | `src/lib/contact-export.js`, `src/lib/audit.js`, `src/app/api/admin/audit-log/` |
| Quality and release checks | Unit/component/route tests, guardrails, tenant/schema checks, build and scheduled browser smoke. | Broad checks do not prove provider or failure-path behaviour. Browser assertions are particularly weak for invoices/pipeline (A22). Add business-result assertions in an isolated test tenant. | `vitest.config.js`, `playwright.config.mjs`, `e2e/smoke.spec.mjs`, `.github/workflows/` |

The following additional surfaces received a shallower inventory and gate review, rather than the deeper failure-path review above:

| Feature | Functionality and boundary | Worthwhile next improvement | Evidence entry points |
|---|---|---|---|
| Organisation portfolio | Organisation-admin/master studio rollups and drill-in: members, recent bookings, churn snapshot, approvals and membership-source status. | Make snapshot freshness and representative count coverage explicit. | `src/app/portfolio/page.js`, `src/lib/account-home.js` |
| Billing, plans and wallets | Plan/add-on pinnings, usage/allowances, per-studio wallet/ledger, monthly expiry, invoices, spend gates and master adjustments. Unpinned studios bypass plan constraints; no live pinning state was inspected. | Distinguish unreadable usage from zero; verify commercial enforcement/reconciliation before expanding tenant billing. Transactional-send fail-open behaviour is deliberate. | `src/lib/billing-page.js`, `src/lib/plans.js`, `src/lib/wallet-enforcement.js` |
| Wallet top-ups | Fixed-denomination Stripe Checkout, target-organisation admin guard, dedicated signed webhook, invoice/session binding, paid-state transition and wallet credit. Auto-top-up configuration exists; automatic off-session charging is explicitly not implemented. | Make config-only automatic recharge status unambiguous. Paid-but-uncredited top-ups currently need manual recovery; add reconciliation/alerting. | `src/lib/wallet-topup.js`, `src/app/api/webhooks/stripe-wallet/route.js` |
| Tenant onboarding/admin | Master roster/detail, wallets/usage/health, guided organisation/studio/owner invitation/branding/domain creation. Trial analytics are explicitly placeholder count/live fields. | Recover partial wizard provisioning; do not present placeholder trial metrics as measured data. | `src/lib/admin-tenants.js`, `src/lib/tenant-wizard.js` |
| Tenant domains | Protected hostname registry, organisation/optional-studio binding, brand/active state and proxy cache. | Separate a saved mapping from verified DNS/hosting/TLS readiness; the registry is not evidence that the domain serves correctly. | `src/app/api/admin/tenant-domains/route.js`, `src/lib/tenant-domains-edge.js` |
| Fleet | Device inventory/health/history and named actions with separate restart/admin permissions; device-token polling, expiry/claims/results/screenshots. | Show unavailable inventory/health separately from no devices; retain the limited named-action model. | `src/lib/fleet-commands.js`, `src/app/api/admin/fleet/`, `src/app/api/fleet/` |
| HR bridges | Master bridge registration/status, hardware/studio association and hashed token issuance/rotation. | Keep never-seen/stale/offline distinct and expose deployment compatibility; physical connectivity was not checked. | `src/app/admin/bridges/page.js`, `src/app/api/admin/bridges/` |
| Staff-reported issues | Photo-supported reports, own issue views, handler inbox, claim/progress/resolution, reporter notification and approvals integration. | Add ageing/response measures and failed-notification visibility in the existing workflow. | `src/lib/issues.js`, `src/lib/issues-access.js`, `src/app/api/issues/` |
| Givers public site | Deliberate dealership coming-soon page with phone/maps and validated, rate-limited interest capture; not an inventory storefront. Hard-coded placeholder copy is an approved exception. | Measure enquiry handling and conversion when replacing the placeholder; do not treat missing inventory browsing as a current implementation defect. | `src/app/givers/`, `src/app/api/public/givers-enquiry/route.js` |
| Technical/public information pages | Public Repset service explanation and business-verification copy, plus privacy/legal/status-related settings surfaces. `/technical` is marketing/business information, not a technical monitoring dashboard. | Keep claims consistent with deployed capabilities and configured tenant identity; rendering and external verification were not exercised. | `src/app/technical/page.js`, `src/app/privacy/`, `src/app/legal/`, `src/app/settings/status-page/` |

## Detailed findings

### A01 — P1: Public event registration can overwrite another team's identity and roster

**Source trace.** [Registration](../../src/app/api/public/events/[slug]/register/route.js#L390) finds a team by studio and caller-supplied display name, then changes its size/captain before registration-state checks. A submission using an already-paid team's name can receive the duplicate refusal at line 496 after the mutation. Reusing the name for a different event at the same studio reaches the roster replacement at line 614, affecting the shared team on the original event. No ownership/booking-token proof guards these writes.

**Action:** establish authorised booking/team identity before mutations; an editable name cannot authorise access to an existing team. **Acceptance:** a stranger's duplicate submission leaves the paid team's captain, size and members unchanged; same-named teams at distinct events do not overwrite one another.

### A02 — P1: Successful purchases can recover another tenant's failed orders

**Source trace; also reproduced in isolated mock state.** [detectRetryRecovery](../../src/lib/orders.js#L235) selects earlier orders by buyer email/type/status/time without organisation or studio scope, then updates their IDs at line 253. A purchase at A can mark B's same-email failed order recovered and link their IDs.

**Action:** scope both candidate selection and writes to the intended tenant/business boundary; do not use email as estate-wide transaction identity. **Acceptance:** A's completed order never mutates or references B's same-email order.

### A03 — P1: InBody ingestion can link and write health metrics across tenants

**Source trace.** [matchContactId](../../src/lib/inbody-ingest.js#L19) searches all contacts by phone tail. Ingestion receives `locationId` but omits it from matching at line 48, then updates the matched contact's weight at line 68. A scan at A can attach to B's only matching contact; duplicate phones across businesses also defeat otherwise valid matching. The external ID at line 46 omits account/studio identity.

**Action:** match within the explicitly intended member-identity boundary and include source-account identity in ingestion deduplication. **Acceptance:** organisation A cannot attach scans to or update contacts owned by organisation B; permitted same-organisation cross-studio matching remains explicit. Identical phone/timestamp scans from separate accounts remain distinct. This may need a separately approved schema decision.

### A04 — P1: Failed door-permission lookup grants unrestricted door access

**Source trace.** [Unlock](../../src/app/api/studio-management/unlock/route.js#L56) discards the assignment query error. Missing data becomes `undefined`, which line 63 treats like the intentional legacy `NULL` unrestricted allowlist. A user holding Studio Management but restricted to selected doors can submit another door ID during this failure. [Door listing](../../src/lib/studio-doors.js#L51) repeats the pattern.

**Action:** distinguish an explicitly unrestricted assignment from a missing/failed lookup; refuse commands when authorisation cannot be established. **Acceptance:** failed lookup never invokes the controller; explicit unrestricted `NULL`, empty lists and restricted lists retain their intended differences.

### A05 — P1: Staff assistant bypasses destination feature permissions

**Source trace.** [Assistant tools](../../src/app/api/assistant/chat/route.js#L58) use role tiers. The route gates `assistant` at line 482; filtering at line 537 and execution at line 95 do not enforce Contacts, Tasks or Scheduling permissions. A manager whose Contacts/Tasks are disabled still receives search/create tools backed by the service-role client. This conflicts with [the task write gate](../../src/lib/activity-write-gate.js#L36). Prompt instructions are not an access barrier.

**Action:** reuse each operation's server-side permission and validation decision with the trusted user; filter tools and recheck on execution. **Acceptance:** disabling a feature blocks the same operation through UI API and assistant, including per-location overrides and bundles.

### A06 — P1: Deposit payment events can be permanently lost after a temporary failure

**Source trace.** [Revolut webhook](../../src/app/api/webhooks/revolut/route.js#L98) records permanent dedup before processing. A failed authoritative order fetch returns success at line 138; a repeat then exits as deduped. The unchecked car update at line 156 creates a related gap. The return page rereads CRM state rather than repairing it.

**Action:** keep receipt separate from completed processing, or safely release/retry the claim using existing primitives; provide reconciliation for captured-but-unrecorded payments. **Acceptance:** first lookup/write fails, later retry succeeds, and deposit/order/customer confirmation reach the correct terminal state without duplicate side effects.

### A07 — P1: Refund retries and concurrent partial refunds are not safely recorded

**Source trace.** [Refund route](../../src/app/api/orders/[id]/refund/route.js#L172) supplies an idempotency key, but [the Revolut adapter](../../src/lib/payments/revolut.js#L57) drops it and [transport](../../src/lib/revolut.js#L143) sends no key. The route also ignores its order update result at line 212. A successful provider refund followed by an ambiguous response or failed write can be retried against stale totals. Different-sized concurrent partial refunds read the same prior total, use different keys and can overwrite each other's cumulative record. Stripe carrying the key does not by itself solve this concurrency case. [Stripe's webhook](../../src/app/api/webhooks/stripe/route.js#L187) does reconcile cumulative refund amounts, but the staff route's unconditional stale-total writes can still race with it; the reviewed Revolut refund path has no equivalent reconciliation.

**Action:** durable per-order refund attempt/claim, provider idempotency where supported, checked writes and reconciliation of ambiguous outcomes. Verify provider semantics before implementation. **Acceptance:** identical retries, different-sized concurrent requests and provider-success/local-failure cannot exceed the remaining balance or lose the cumulative total. This is reliability of existing refunds, not a proposal for a new car refund UI.

### A08 — P1: Imports can complete after losing rollback history

**Source trace.** [Runner](../../src/lib/contact-import-runner.js#L223) logs and discards outcome-ledger insert failures. [Queue](../../src/lib/contact-import-queue.js#L66) then marks completion and removes the CSV payload. Existing-contact restoration depends on the lost `before_snapshot` rows; new-contact deletion by import ID does not fix that gap.

**Action:** make recoverable outcomes durable before declaring completion; preserve retry/repair inputs after outcome persistence fails. **Acceptance:** a failed ledger chunk cannot produce an apparently fully recoverable completed import.

### A09 — P1: Partial import rollback is labelled complete and cannot be retried

**Source trace.** [Rollback](../../src/app/api/contacts/imports/[id]/rollback/route.js#L145) counts failed individual restores/deletes but marks every created/updated outcome rolled back at line 167 and the batch rolled back at line 179. The next attempt is refused at line 58. Its initial claim also does not verify returned affected rows.

**Action:** stamp successful rows individually, retain a retryable partial state and require a successful exclusive claim. **Acceptance:** one forced restore failure remains honestly pending and a second attempt repairs only unfinished work.

### A10 — P1: Failed policy publishing removes the current policy

**Local reproduction with actual publish function and injected insert failure.** [publishVersion](../../src/lib/policies.js#L391) clears current flags before inserting the replacement in a separate call. Failure leaves no current policy. The [route schema](../../src/app/api/admin/policies/[slug]/versions/route.js#L27) also accepts date-shaped impossible dates, which can trigger rejection after the clear. A uniqueness index does not make two requests atomic.

**Action:** atomic replacement and valid-calendar-date validation. **Acceptance:** invalid input or failed/concurrent publication always preserves one correct current version. An atomic database operation may require a separately authorised migration.

### A11 — P1: Inspection submission can leave unsafe equipment marked in service

**Source trace.** [Submit](../../src/app/api/equipment/inspections/[id]/submit/route.js#L265) commits the submitted inspection before updating equipment at line 281. A failed second write leaves old service status/due dates and refuses resubmission because the inspection is already submitted. [updateInspection](../../src/lib/equipment-db.js#L160) also lacks a draft-state condition, permitting concurrent submissions to race and create duplicate issues.

**Action:** atomic or explicitly resumable submission with an exclusive state transition. **Acceptance:** out-of-service decisions reach the asset even after an interrupted attempt; simultaneous submission produces one inspection result and one intended issue set.

### A12 — P1: Sequence task nodes resolve successfully without creating tasks

**Local reproduction with actual handler and rejected insert; schema source trace.** [internalTaskStep](../../src/lib/sequences/steps.js#L1103) writes `assigned_to`/`due_at`; checked-in activities definitions and current task writers use `assignee_id`/`due_date`/`due_time`. It ignores the resolved database error, so the scheduler advances. Existing tests mock insertion success and do not enforce the column contract.

**Action:** use the existing task operation and validate the assignee/target studio; judge the insert result. **Acceptance:** a sequence-created task appears in the correct queue with intended due time and assignment; rejected inserts cannot complete the node.

### A13 — P1: A transient sequence read can permanently end an enrolment

**Local reproduction of actual next-step helper; downstream source trace.** [nextStepForEnrollment](../../src/lib/sequences/scheduler.js#L65) ignores a read error and returns `null`, which the scheduler interprets as completion at line 507. Sequence/contact reads at line 416 similarly turn failures into permanent “deleted” exits.

**Action:** separate successful absence from unavailable reads and use retry/backoff for the latter. **Acceptance:** injecting one read failure leaves the run recoverable and does not mark it completed/deleted.

### A14 — P2: Sequence quiet hours protect the next cursor, not the current send

**Source trace.** [Enrol](../../src/lib/sequences/enrol.js#L225) and [resume](../../src/lib/sequences/resume.js#L18) schedule immediately. [Scheduler](../../src/lib/sequences/scheduler.js#L629) applies quiet hours/send windows after dispatch, when calculating the following step. First sends, late cron execution and retries can therefore occur outside configured hours.

**Action:** enforce the applicable window immediately before external dispatch. **Acceptance:** enrol, resume, late processing and retries during quiet hours make no provider call until the permitted window.

### A15 — P2: Pause during a send can duplicate the step on resume

**Source trace; acknowledged in the implementation.** [Cursor update](../../src/lib/sequences/scheduler.js#L701) requires active status. If paused while the provider call is pending, the successful send cannot advance the cursor; [resume](../../src/lib/sequences/resume.js#L16) schedules the old step again. Lines 713–717 describe the remaining failure.

**Action:** durable per-enrolment/per-step delivery identity independent of pause state, including ambiguous provider results. **Acceptance:** pause during provider response, resume, and observe one delivered message with an accurately advanced cursor.

### A16 — P2: Bulk Xero sending hides missing invoice attachments

**Source trace.** [Xero push](../../src/lib/invoices-queue/push-xero.js#L439) returns `attachmentError`, but [bulk send](../../src/app/api/invoices-inbox/bulk-send/route.js#L129) stamps forwarded, clears errors and reports success without inspecting it. [Single-row approval](../../src/app/api/invoices-inbox/[id]/data-approve/route.js#L123) deliberately preserves a retryable state for the same outcome. The early Xero bill-ID persistence at push line 423 also needs its write result judged to uphold retry protection.

**Action:** share outcome handling and persist the external bill identity before attachment retries. **Acceptance:** failed attachment remains visible/retryable; repairing it attaches to the existing bill rather than creating a duplicate.

### A17 — P2: An unavailable approvals category looks empty

**Source trace.** [Registry](../../src/lib/approvals/registry.js#L207) converts rejected providers into zero count and empty items, without an unavailable marker. Count-only failures likewise become zero. The inbox can therefore show “Nothing pending” when a category query failed.

**Action:** preserve working categories but mark unavailable buckets and incomplete totals. **Acceptance:** a failed leave-provider read produces a visible warning rather than an all-clear.

### A18 — P2: Presentation writes/read failures can produce stale or empty screens

**Source trace.** [Reorder](../../src/app/api/presentations/[id]/slides/reorder/route.js#L34) ignores update/version-bump errors and accepts incomplete/duplicate/foreign IDs. Upload/deletion also ignore version-bump results. [Public state](../../src/app/api/public/presentations/[token]/state/route.js#L38) converts slide-read failure into successful `slides: []`. If this coincides with a changed version, [the viewer](../../src/app/present/[token]/PresentViewer.jsx#L27) accepts the empty deck and records that version; later successful same-version polls do not restore it. A failed read at an unchanged version does not replace already loaded playback.

**Action:** validate complete deck membership/order, persist order/version together and preserve last good playback on read failure. **Acceptance:** failed reorder cannot report saved; transient reads cannot replace a valid deck with an empty one.

### A19 — P2: Achievement backfill omits historical qualifying sessions

**Source trace.** [Backfill](../../src/app/api/admin/achievements/[id]/backfill/route.js#L84) reads sessions for up to 200 contacts without paging, despite paging candidate/earned lists. At the normal 1,000-row PostgREST cap, larger histories truncate. At line 109 it also evaluates only the latest session; [first-event rules](../../src/lib/achievements.js#L176) can depend on an earlier session's class/zone properties, so even complete history in memory does not fix the second problem.

**Action:** paginated, resumable historical evaluation using rule-appropriate “ever qualified” or chronological context. **Acceptance:** >1,000 sessions across a batch and an earlier-only Z5/class qualification award correctly, without repeated awards on retry.

### A20 — P2: Contact exports never record their intended audit event on the checked-in schema

**Local reproduction using actual log function and an in-memory PostgreSQL CHECK copied from migration 180.** [Export](../../src/app/api/contacts/[id]/export/route.js#L60) logs category `privacy`, while the [audit table](../../supabase/migrations/180_audit_events.sql#L29) accepts only `auth`, `business`, `mutation`, `assignment`. No later category-constraint change was found. [Logger](../../src/lib/audit.js#L101) returns `logged:false`; the route ignores that result and still downloads the export.

**Action:** use a supported category/action contract and test this sensitive action against the actual schema. **Acceptance:** an export produces one searchable audit event; an audit failure is observable and recoverable. Expanding categories would be a separate migration/UI decision, not necessary to fix this mismatch.

### A21 — P2: Audit CSV silently truncates to the server's row cap

**Source trace, conditional on the normal 1,000-row API cap documented by this repo.** [CSV branch](../../src/app/api/admin/audit-log/route.js#L135) requests one range of 5,000 and labels it the full filtered set up to that ceiling. A single request does not page through the server cap; the response omits count/truncation information. Even a higher configured cap still silently cuts off results above 5,000.

**Action:** page deliberately, define the export ceiling and disclose omitted rows. **Acceptance:** a 1,500-row filtered set exports all rows under a 1,000-row request cap; a true export ceiling produces an explicit incomplete warning.

### A22 — P2: Browser smoke tests can pass without proving key screens work

**Source trace.** [Invoice/pipeline smoke](../../e2e/smoke.spec.mjs#L80) asserts a visible body and no observed server 5xx. A redirect, permission page, JavaScript-rendered error or API 4xx can satisfy this. The inbox test waits only for the WhatsApp list despite its broader title. The [scheduled job](../../.github/workflows/e2e-smoke.yml) intentionally exits green when credentials are absent; this audit did not inspect secrets or establish whether the live job is configured.

**Action:** assert correct URL, screen-specific loaded state, expected API outcomes and uncaught page errors; distinguish unconfigured/skipped from passed in monitoring. Add write journeys only in a named isolated test tenant with safe providers. **Acceptance:** a wrong redirect, client crash, API 403 or missing core list causes a deterministic failure.

### A23 — P2: Concurrent policy dwell updates can lose reading evidence

**Source trace.** [View update](../../src/app/api/policies/[slug]/views/route.js#L127) reads a prior duration, computes a maximum locally, then updates unconditionally. Parallel 30s/60s updates can leave 30s if written last. Shorter maps/null can also replace existing section evidence.

**Action:** merge monotonically in one atomic operation or use a checked version. **Acceptance:** out-of-order and concurrent updates preserve the longest valid total and section evidence.

### A24 — P2: Team-capacity checkout does not reserve pending payments

**Source trace.** [Team-capacity count](../../src/app/api/public/events/[slug]/register/route.js#L325) counts confirmed registrations only. The people-capacity branch includes live pending payments. With one team place remaining, multiple buyers can start payment before any confirmation; confirmation has no equivalent final capacity protection in the reviewed path.

**Action:** align reservation/expiry semantics and use atomic capacity enforcement. **Acceptance:** simultaneous paid checkouts cannot sell the last team place twice, and abandoned reservations eventually release capacity.

## Product improvements worth considering after the defects

| Improvement | Operator/member value | Suggested first scope | Measure |
|---|---|---|---|
| Recoverable integration work | Staff can repair a provider-success/CRM-failure without asking a developer or risking duplicates. | One queue for deposits, refund attempts and missing Xero attachments, linking existing detail screens. | Unresolved value/count/age; recovery time; duplicate external objects. |
| Explain decisions and source freshness | Staff understand pipeline stages, radar scores, audience exclusion and member metrics. | “Why this result?” on the highest-use contact/radar/audience views, using existing decision inputs. | Support questions; time to choose an action; stale-source incidents. |
| Close the intervention loop | Radars and Pulse become measurable retention/acquisition workflows. | Record next action, owner and resulting attendance/booking/conversion using existing actions. Audit current outreach integration before adding any new sender. | Action completion and cohort outcomes, with attribution limitations explicit. |
| Audience and send readiness | Reduces mistakes before high-volume communications. | Final eligible-audience explanation, suppressions and sample recipients next to existing send confirmation. | Avoidable failed/suppressed sends and corrections after launch. |
| Publish readiness | Reduces uncertainty around rosters, programmes, policies and TV content. | Consistent validated/saved/published/acknowledged states, reusing each feature's current checks. | Failed publications, stale displays and manual rechecks. |
| Daily exceptions and handover | Gives operators a manageable next-action list instead of another dashboard. | Build from approvals, cover gaps, failed sends and accounting exceptions already present; preserve permissions. | Overdue exceptions and handover completion time. |
| Historical job progress | Large imports/backfills are inspectable and restartable. | Correct achievement backfill first, then reuse progress/cursor/retry conventions. | Completion time, recoverable failures and skipped records. |

Three engineering investments support these product outcomes: reuse one permission/validation decision for each business operation; extend schema-contract checking to literal mutation payloads as well as selected columns/RPC names; and add failure-injection/concurrency tests at external-success/local-persistence boundaries. Existing per-path write guardrails should be extended deliberately after each area is corrected, rather than assuming a green repository-wide command already examines every write.

Avoid speculative new modules before measuring demand. Referrals, feedback, reviews and broader BI appear in an older roadmap, but this audit does not establish that they are the best next investment or currently absent across every companion system.

## Deliberate decisions to preserve

- No new car-detail refund UI and no GBP/multi-currency deposit project: explicitly rejected in `docs/BACKLOG.md`.
- Do not move the campaign runner to per-recipient QStash delivery merely for architectural consistency: the documented cost/schedule decision remains relevant.
- Do not reintroduce manual pipeline-stage movement; it conflicts with the classifier.
- SMS is retired. Email's own mail surface is intentional.
- Shelly Gen1, other device classes, Integrator transport, on-device scheduling, continuous desired/actual enforcement and outage alerts are deferred product choices. Unmanaged overrides holding until changed are approved behaviour.
- Missing geofence evidence is not reliable proof of absence. Manager assignment conflict warnings and leave/roster separation include deliberate advisory behaviour.
- Future-device plans are not a current implementation inventory; existing PIN/session code must be taken into account.

## Verification record

Passing these checks does not invalidate the findings: the identified failure cases are mostly outside the assertions or mock/schema contracts currently exercised.

| Check | Result |
|---|---|
| Full unit/component/route suite | Passed: `npm test -- --maxWorkers=2`, 2,536 files and 52,521 tests, exit 0. Every test and original timeout remained enabled. |
| Main lint | Passed, exit 0; 67 existing warnings, no errors. No application code changed. |
| Eleven remaining CI-mirror checks | Passed: mobile parity/imports/lint, route guards, location scoping, restrictive RLS, guardrails, selected columns, RPC names, bundle SQL and OTA paths. |
| Production build | Passed, exit 0. |
| Isolated reproductions | Five observed behaviours reproduced: failed sequence-task insert resolves normally; failed policy replacement clears current state; failed sequence-step read returns end-of-sequence null; unsupported export audit category rejected by PostgreSQL; audit CSV emits formula-like strings unchanged. The last observation is an export-hardening opportunity, not separately counted as a production exploit. |
| Browser/provider acceptance | Public sign-in page rendered. No authenticated journey or provider acceptance performed. |

The initial default-worker suite ran concurrently with build/lint/structural checks and produced five timeouts across three files (migration 740, migration 743 and the TV bucket scanner), with 52,516 tests passing and no assertion failures. The complete rerun with two workers and no competing build/lint passed all 52,521 tests without source changes or longer timeouts. This is evidence consistent with resource contention in the first run, not evidence that the default-worker configuration is universally reliable.

The isolated checks load the actual named functions from this checkout, replace only external dependencies, and use an in-memory PostgreSQL instance for the audit-category constraint. They demonstrate the specified behaviour; they are not a substitute for an eventual regression test of the fixed full workflow. Order-recovery cross-tenant mutation was additionally reproduced in isolated mock state during the review.

## Live acceptance still required

For a full operational sign-off, use a named isolated test tenant and test identities with representative owner, manager, coach, staff and restricted-feature roles. Confirm each feature's normal journey, validation/refusal, failed dependency, interrupted retry and cross-tenant rejection. Start with the 24 findings' acceptance criteria; then rehearse booking/checkout, communications/consent, roster publication/cover, invoice-to-Xero, contract signing and device lock/revocation in their actual interfaces.

Production-wide read-only observation could then establish integration freshness, delivery/recovery rates and job backlog; it should not be confused with exercising customer-impacting writes. Real-world frequency, business impact totals, visual accessibility and measured performance cannot be inferred from green unit tests or source alone.
