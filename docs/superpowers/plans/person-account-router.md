# PERSON-ACCT — Person-Account Router (reads aggregate, writes elect, conflicts escalate)

Design chosen 2026-08-25 by a 13-agent review (3 designs, unanimous judge verdict, 2 adversarial
passes). Problem: one person routinely has 2–3 CRM contacts, each linked to a DIFFERENT Glofox
account (879 of 887 person_groups are divergent; ClassPass mints shadow accounts). The agent
currently swaps the verified contact for the person-group PRIMARY (a display-oriented ranking),
so it reads/books the wrong Glofox account whenever the activity lives elsewhere (the Julie Cross
incident); staff approvals execute on the REQUEST row's contact, a different rule again.

Fix: the agent acts as the PERSON. Reads fan out across ALL linked Glofox accounts. Writes elect
ONE account by an explicit activity→entitlement→recency rule (ClassPass shadows never
write-elected). Genuine conflicts escalate to staff. No DB migration for PR1/PR2;
`primary_contact_id` keeps its display/outreach meaning everywhere else.

## House rules every task MUST respect (from CLAUDE.md — violations have shipped outages)
- supabase-js builders are thenables: `try/await/catch`, never `.catch()`; every write destructures
  `{ error }` and handles it; `.single()` without a pk filter is banned — use `.maybeSingle()`.
- Every `.in()` list chunks at ≤150 ids.
- Removing a silent failure must never create a louder one: an UNREADABLE external read never
  becomes a customer-visible "you have nothing" — degrade to the explicit failure copy instead.
- Never surface class/event capacity counts to customers (time + name only).
- Customer-facing copy is operator-editable (settings key + code default), never hard-coded.
- Fire-and-forget side effects run in their own try/catch.
- Tests are vitest, co-located `*.test.js`, mocked supabase double per existing files' idiom;
  pure helpers exported and unit-tested. TDD: write the failing test first.
- No new `console.log` in prod paths.

## PR1 — reads aggregate (branch person-accounts-pr1)

### Task 1.1 — src/lib/person-accounts.js (new) + tests
`linkedAccountsForContact(db, contactId)` [IO]: person_group_members lookup for contactId →
group id (or none) → all member contact ids (chunked .in) → contact rows selecting
`id, name, glofox_member_id, glofox_membership_status, glofox_membership_state,
trial_credits_remaining, last_attended_at, phone, wa_phone, email, updated_at`.
Ungrouped contact → singleton of its own row. Returns
`{ anchorContactId, contacts, accounts }` where `accounts` = the rows carrying a non-null
glofox_member_id, DEDUPED by glofox_member_id (two contacts pointing at the same account appear
once; keep the row whose id === anchor if present, else first by id sort). On any DB error return
`{ anchorContactId, contacts: [], accounts: [], readFailed: true }` — callers treat readFailed as
"fall back to single-account behaviour", never as "no accounts".
`corroborated(anchorRow, otherRow)` [pure]: true when the rows share a normalised phone
(strip non-digits, compare last 9) across phone/wa_phone, or an exact trim+lowercase email.
Anchor row is always corroborated with itself.
`findBookingAcrossAccounts(creds, accounts, bookingId, fetchImpl)` [IO]:
Promise.allSettled over `fetchImpl(creds, memberId, { windowDays: 0, limit: 100 })` per account
(fetchImpl injected for tests; production callers pass fetchUserBookingsResult). Returns
`{ owner, unreadable }` — owner = the account whose bookings contain bookingId (match on the
booking id field the existing cancel path uses), unreadable = accounts whose read failed
(rejected or ok:false). A member-not-found style empty ok read is EMPTY, not unreadable.
Tests: dedupe rule, singleton short-circuit, chunking (>150 member group — synthetic), readFailed
posture, corroborated truth table, findBookingAcrossAccounts owner/unreadable/none.

### Task 1.2 — booking-tools reads fan out
`list_my_upcoming_bookings` (src/lib/agent/booking-tools.js:647-671): today reads ONE account
(the acting contact's glofox_member_id). Change: load linkedAccountsForContact(db,
verifiedContactId); fan out fetchUserBookingsResult across all accounts (allSettled); merge +
sort by start time; DEDUPE by booking id. Partial-failure rule: ALL reads failed OR
linkedAccounts readFailed with the single fallback read also failing → existing list_failed
copy. SOME failed but bookings found → return the merged list PLUS `incomplete: true` and a
message telling the model to caveat that the list may be missing items. Empty-and-all-readable →
existing none-found behaviour. Each returned booking carries which glofox_member_id owns it
(internal field `_member` fine) so cancel can use it.
`cancel_class_booking` (:673+): locate the booking's owner via findBookingAcrossAccounts. Rules:
owner is the anchor's own account → cancel exactly as today. Owner is a SIBLING account that is
corroborated (shares phone/email with anchor) AND not classpass_payg → cancel against THAT
member id (log the owning contact id in the audit row details). Owner is classpass_payg OR
non-corroborated → do NOT execute: return
`{ cancelled: false, needs_staff: true, message: 'This booking is managed outside the direct
account (or on a linked account we could not confirm). Tell the customer the team will sort the
cancellation now and hand off.' }` — the model's existing handoff behaviour covers the thread.
Booking not found anywhere with zero unreadable accounts → honest not-found; not found with ANY
unreadable → treat as list_failed-style uncertainty (never claim it does not exist).
Tests: extend booking-tools-audit.test.js style with a two-account group double: cross-account
list merge + dedupe + incomplete flag; cancel on sibling corroborated (executes with sibling
member id), classpass sibling (needs_staff), non-corroborated sibling (needs_staff), not-found
vs unreadable distinction.

### Task 1.3 — account-tools reads aggregate
`get_my_membership` (src/lib/agent/account-tools.js:503-529): read ALL group contact rows via
linkedAccountsForContact; report the BEST live membership (state/status active first, else
trial with credits, else most recently updated row's status); if TWO OR MORE non-classpass rows
hold a live membership, include `note_for_staff: 'double_membership'` in the tool result (the
model is told to answer normally; the flag is for the decision log).
`get_my_next_class` / `get_my_recent_attendance` (:530-545): these read DB tables keyed by
contact_id — widen each query to the group's contact ids (chunked .in), keep result shapes.
`request_pause` / `request_cancellation` (:546+): UNCHANGED in PR1 (PR2 elects).
Tests: group-widened queries hit .in with all ids; best-live selection; double-membership flag.

### Task 1.4 — event-tools reads span the group
`get_my_event_registrations` (src/lib/agent/event-tools.js): query race_registrations across ALL
group contact ids (chunked .in) instead of the single acting contact.
`cancel_event_registration` / `reschedule_event_wave`: accept ownership when the registration's
contact_id is ANY member of the group (today: must equal acting contact) — corroboration rule NOT
required here (registrations are CRM rows, not Glofox accounts; the group link is the CRM's own
assertion and the person verified their identity).
`book_event`: where it gates on "is a member" / member pricing off the acting contact row,
consider the group's rows (any live membership counts).
Tests: registration visible via sibling contact; cancel accepted for sibling-owned registration;
member gate satisfied by sibling membership.

## PR2 — writes elect + conflicts escalate (branch person-accounts-pr2)

### Task 2.1 — electWriteAccount [pure] in person-accounts.js
Input: accounts (from linkedAccountsForContact) + optional `concernsMemberIds` (accounts holding
the bookings this action concerns, e.g. from a fan-out read). Rules in order:
1. Exclude classpass_payg rows and rows whose contact fails `corroborated` with the anchor
   (unless the row IS the anchor). 0 candidates → `{ outcome: 'none' }`.
2. If concernsMemberIds intersects candidates → prefer those.
3. Live membership (status 'active') → then trial_credits_remaining > 0 → then most recent
   last_attended_at/updated_at. Deterministic final tie-break: contact id ascending.
4. If ≥2 candidates hold live entitlement at the same rank → `{ outcome: 'conflict',
   candidates }`. Else `{ outcome: 'elected', account }`.
Unit tests for every rule incl. determinism and anchor-fallback.

### Task 2.2 — acting id = raw verified contact (drop the primary remap)
core.js resolveAutoVerify (:590-620): return the conversation's contact id itself (the security
check — every phone match same person — UNCHANGED). auto-reply.js: the stored-stamp path and the
post-quiz hook stop remapping through resolveActingContactId; the phone lane stamps the RAW
contact. knownContact/display blocks KEEP using pickPrimary (display and acting are different
questions). A stored stamp whose contact no longer exists or has left the group → treat as
unverified, normal re-verify. Update auto-reply verify tests accordingly; add a regression test:
verified thread on contact A in a group with primary B → toolCtx.verifiedContactId is A.

### Task 2.3 — book_class elects; account_conflict escalates deterministically
book_class: electWriteAccount over linkedAccounts (+concernsMemberIds from a bookings fan-out
that ALSO backstops cross-account double-booking: same event id already booked on ANY account →
alreadyBooked success path). Credits pre-flight (MIA-CREDITS.1) runs against the ELECTED account;
if it is confirmed-empty but a corroborated sibling candidate has credits, re-elect to it before
escalating no_credits. `outcome none` → existing not_linked/no_credits lanes.
`outcome conflict` → LIVE-verify: fan fetchUserCreditsResult over the candidates (allSettled);
≥2 live-confirmed entitled → file a pending class_booking approval with
`details.reason='account_conflict'` and `details.candidates=[{contact_id, glofox_member_id,
membership_status, credits}]` (NEVER in details.reason free-text) against the TOP candidate's
contact id, return `{ account_conflict: true }`, and auto-reply hands off deterministically
(mirror the no_credits block: new settings key `account_conflict_handoff_text` — contract +
DEFAULTS + zod + builder + settings UI field — default copy: "You have more than one account
with us so I want to get this booking exactly right. I'll get a team member to sort it for you
now."). <2 live-confirmed → elect the live one and proceed.
Approval rows: EVERY booking-shaped row Mia files now stamps `details.elected_glofox_member_id`.
Executor cross-check (membership-requests/[id]/route.js class_booking branch): if
details.elected_glofox_member_id is present and differs from the row contact's CURRENT
glofox_member_id → do NOT execute; land failed with message_code 'ACCOUNT_MISMATCH' (fix &
retry lane picks it up; failureExplanation gets a plain-English entry).
whyFlagged gains `account_conflict` copy. Web card renders the candidate list on
account_conflict rows (name/status/credits per candidate, read from details.candidates).
Tests: election consumed, conflict files + flags, live-verify demotes stale conflicts,
sibling-credit re-election, already-booked-on-sibling backstop, executor mismatch refusal,
settings key write-through (settings-contract test), auto-reply deterministic handoff test
(mirror auto-reply-no-credits.test.js).

### Task 2.4 — pause/cancel-membership target the elected account
request_pause / request_cancellation (account-tools): elect via electWriteAccount; file the
approval row against the elected contact id; on conflict (≥2 live non-classpass memberships)
file with `details.candidates` (reason field on these kinds is THE CUSTOMER'S WORDS — never
overwrite it) and proceed pending as usual (staff decide; no thread handoff needed — these are
already staff-manual kinds). Card shows candidates when present.
Tests: elected filing; conflict candidates without touching reason; customer_note preserved.

## PR3 — funnel + group substrate (branch person-accounts-pr3)

### Task 3.1 — funnel processor person-wide judgment
class-booking-processor.js: before findOrCreateGlofoxMember(createIfMissing:true), search the
location's contacts for siblings by normalised phone (last-9 match on phone/wa_phone; and exact
normalised email) — any sibling with a glofox_member_id or attendance blocks minting a NEW
Glofox account: reuse the sibling account when corroborated (book against it; record
`details.executing_contact_id` + the member id on the approval/queue rows so Fix & retry and
the executor cross-check stay coherent — class_booking_requests.contact_id stays the funnel
row for attribution) or route to review 'account_ambiguous' when not corroborated.
Returner/attendance judgment spans the person-group + phone-siblings (attended on ANY linked
account = attended). Balance gate (AGENT-FUNNEL-CREDITS.1) evaluates the accounts person-wide:
credits/active membership on any corroborated non-classpass account counts, and booking executes
against THAT account. Tests: sibling-reuse, block-minting, person-wide attendance, person-wide
balance, executing_contact_id recorded.

### Task 3.2 — person-wide approval dedupe
pendingBookingApprovalId (booking-tools) and the funnel's reuse-existing lookup: match pending
class_booking rows for the SAME event across ALL group contact ids (chunked .in). Accepted
limitation: still SELECT-then-INSERT (no DB constraint) — note it in a comment.
Tests: sibling pending row deduplicates.

### Task 3.3 — duplicate-detection on a cron
Find the existing person-detect scan entrypoint (src/lib/person-detect.js — the high-confidence
auto-link path with operator-reversible semantics). New cron route
src/app/api/cron/person-detect-scan/route.js (Bearer CRON_SECRET) running the high-confidence
commit scan for each active location, + vercel.json schedule (daily, off-peak), + migration
adding the cron_heartbeats row (forward-only; the controller applies it via Supabase MCP before
merge), + stampHeartbeat on success. Scan must be bounded (existing batch semantics) and
NEVER auto-link on name-only evidence — reuse the existing high-confidence rules exactly.
Tests: route guard test pattern + a pure-scan invocation test with mocked db.

### Task 3.4 — eval scenarios
Add reachable eval cases to the agent eval harness (find it via package.json `eval:agent`):
divergent-group list (booking on sibling account is listed), cancel located on sibling,
account_conflict escalation (script sent verbatim). Follow the harness's existing scenario
format; scenarios must run in CI-safe mode if the harness supports it, else document how to run.

## Ship discipline (controller)
Per PR: full CI mirror + `npm run build`; changelog entry; PR; update-branch/merge cycle.
PR2 and PR3 branch off updated main after the previous PR merges. No mobile/ or shared/ paths
are touched anywhere above (no OTA) EXCEPT: card candidate rendering in PR2 is WEB-only
(mobile shows the precomputed `why` line, no candidate list — deliberate).
