# Inbox Inline Agent Approvals — Design

**Date:** 2026-07-03
**Status:** Approved by Richard (chat, 2026-07-03)
**Branch:** `feat/inbox-inline-approvals`

## Problem

Mia's gated actions (class/event bookings, cancellations, pauses, consultations) create rows in `agent_membership_requests`, but staff can only review them on separate pages (`/approvals`, `/settings/customer-agent/requests`) — away from the conversation that produced them. Staff lose the customer's context when deciding, and after deciding they get no guidance on what to do next (offer alternatives, retention follow-up, etc.).

## Goal

Surface approval requests inline in the unified inbox thread (`/communications/inbox`), decidable in place by anyone with inbox access, with rule-based recommended next steps shown after each approve/decline — then bring the same experience to the mobile CRM app, and layer AI-generated suggestions on top.

## Decisions made (with Richard)

1. **Next steps are rule-based** — a deterministic playbook keyed by request kind + outcome. AI suggestions come later as an additive layer (Wave 3), never replacing the playbook.
2. **Step actions are mixed per type** — message-type steps prefill the composer (staff edits + sends); action-type steps deep-link into existing UI (Command Centre Book tab, sequence enrol). Nothing auto-executes from a next-step click.
3. **Decline messages are staff-reviewed** — declining prefills a Mia-voiced explanation (built from the chosen decline reason) into the composer. Nothing customer-facing goes out unreviewed on decline. (Approve keeps today's behaviour: the PATCH route executes the Glofox action and Mia auto-confirms in-thread.)
4. **Not manager-gated in the inbox** — decision rights follow the surface: anyone with access to the communications platform can see and decide approvals there, same as they can send messages and book. `decided_by`/`decided_at` audit trail unchanged.
5. **Nothing out of scope** — mobile parity and AI suggestions are planned waves, not future maybes.

## Architecture

### Existing pieces (unchanged behaviour, reused)

- `agent_membership_requests` (mig 234, extended 258/264): already carries `conversation_id` (UUID of `whatsapp_conversations` / `instagram_conversations` row), `channel` (`whatsapp|instagram`), `contact_id`, `kind`, `details` jsonb, `customer_note`, `status` (`pending|approved|declined|actioned|saved|failed`), `retention_flagged`, `decided_by`, `decided_at`, `decision_note`. **No new tables; no new columns expected.**
- `PATCH /api/agent/membership-requests/[id]` (`src/app/api/agent/membership-requests/[id]/route.js`): the single decision endpoint. On approve for executable kinds it performs the Glofox action, marks `actioned`/`failed`, stores `details.result`, and sends Mia's confirmation via `sendAgentThreadMessage()` (`src/lib/agent/notify.js`). Inline cards call this same route — deciding from the inbox is identical to deciding from the approvals page.
- Unified inbox: `src/components/UnifiedInbox.jsx` (queue + realtime), `src/components/WAInbox.jsx` / `src/components/IGInbox.jsx` (embedded thread renderers), `src/components/CommandCentre.jsx` (right rail: profile / activity / book tabs).

### New / modified pieces

**1. Conversation-scoped fetch.** Extend `GET /api/agent/membership-requests` with a `conversation_id` filter returning all requests (pending + decided) for that conversation. Auth check for this filtered form = inbox access (location staff), not manager.

**2. Timeline merge.** In WAInbox/IGInbox embedded mode, fetch the conversation's requests alongside messages and merge into one timeline sorted by timestamp (`sent_at` vs `created_at`), items tagged `type: 'message' | 'approval'`. The render loop gains one branch for the new type.

**3. `ApprovalActionCard.jsx`** (new, shared by WA + IG threads):
- *Pending:* kind icon + title, human summary built from `details` (e.g. "Class booking — Core Fusion, Wed 9:30"), customer's verbatim note, buttons: Approve / Decline (+ Save for retention-flagged cancellations). Decline opens inline reason picker (Not eligible / Already booked / Class full / Other + free-text note) → PATCH with `status: 'declined'`, `decision_note`.
- *Decided:* compact status line ("Approved by Richard · booked ✅" / "Declined · class full"), preserving the thread as an audit trail.
- *Post-decision:* renders the next-steps row (see playbook). Approve-executed bookings show confirmation state only (Mia already auto-confirms).

**4. Next-steps playbook** (`src/lib/approvals/next-steps.js`, new): pure function `getNextSteps(kind, outcome, context) → [{ label, type: 'composer' | 'navigate', payload }]`.
- `composer` steps produce Mia-voiced draft text → thread component drops it into the composer.
- `navigate` steps deep-link (open Command Centre Book tab, sequence enrol, contact record).
- Initial matrix (refine during planning): declined booking → "Offer alternative slots" (Book tab) + "Send apology with options" (composer); approved cancellation → "Enrol in win-back sequence" + "Book retention call"; approved pause → "Confirm pause dates" (composer); saved cancellation → "Log what saved them" (decision note). Approved+executed bookings → none.
- Pure module ⇒ unit-testable in isolation. Lives in the `shared/` seam from day one (`shared/approvals-next-steps.js`) so Wave 2 mobile imports it verbatim; `src/lib/approvals/next-steps.js` is a thin re-export for web ergonomics.

**5. Realtime.** Add `agent_membership_requests` to the realtime publication (forward-only migration via Supabase MCP; run `get_advisors` after DDL) and subscribe in the inbox filtered by location/conversation — new cards appear the moment Mia creates a request; cards update live when a colleague decides elsewhere.

**6. Queue badge.** Conversation list items show a small "Approval" badge when the thread has a pending request. The WA/IG conversations list APIs each add a `pending_approval` flag, computed via one batched query over the returned page's conversation IDs (no per-row queries; respects the 1k-row cap invariant).

**7. Permission widening.** RLS read policy on `agent_membership_requests` widens from managers to location staff; PATCH route check drops MANAGER_ROLES in favour of the same access check the inbox APIs use. Follow the advisor-consolidated single-permissive-policy pattern. The `/approvals` dashboard + settings page keep manager-only *visibility* (registry `isVisible`), but the underlying capability is staff-wide.

**8. Deep links.** Approvals page cards gain "Open conversation" → `/communications/inbox?c=<conversation_id>&ch=<wa|ig>` (param format already supported by the inbox page).

## Waves (each independently shippable)

- **Wave 1 — web inbox core:** items 1–8 above.
- **Wave 2 — mobile parity:** approval cards + decisions + next steps in the mobile CRM app inbox. Staff writes via the tested `shared/staff-write.js` seam; playbook shared. Composer prefill + deep-links adapted to mobile navigation. JS-only ⇒ ships OTA (auto-publish on push to `mobile/**`+`shared/**`).
- **Wave 3 — AI-layer suggestions (hybrid):** playbook renders instantly; on decision, an async call (Anthropic Messages API — no OpenAI, per standing rule) reads conversation + contact context and appends a bespoke suggested message/step beside the rule-based ones. AI drafts land in the composer only — never auto-send. Degrades silently to playbook-only on error/timeout.

## Error handling

- PATCH failure (Glofox error) → card shows `failed` state with the stored `details.result` error, retry available (existing route semantics).
- Realtime drop → existing 60s safety poll in UnifiedInbox covers approvals too once they're part of the thread fetch.
- Concurrent decisions (inbox vs approvals page) → PATCH already validates current status; loser gets a "already decided" state and the card refreshes to the decided view.
- WA 24h window closed when a composer step is used → existing composer behaviour (template picker / read-only) applies unchanged.

## Testing

- Unit: next-steps playbook matrix; timeline merge/sort; card state machine (pending → deciding → decided/failed).
- API: `conversation_id` filter auth (staff allowed, cross-location denied); PATCH permission widening.
- Vitest with `--pool=threads` (established gotcha).
- Manual smoke on live inbox with a test conversation before enabling anything customer-visible; Wave 2 device-verify per mobile pattern.

## Out of scope

Nothing — per Richard, all formerly-out-of-scope items are scheduled as Waves 2–3. Changes to Mia's own behaviour (what she requests, her contract) remain untouched throughout.
