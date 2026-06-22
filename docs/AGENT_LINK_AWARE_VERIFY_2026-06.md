# Agent identity verification — link-aware + primary-account + sticky verification

**Status:** Design approved 2026-06-22 (Richard). Awaiting spec review → implementation plan.
**Area:** Customer WhatsApp/Instagram agent ("Mia") — identity verification path.
**Files in scope:** `src/lib/agent/core.js` (pure), `src/lib/agent/auto-reply.js` (IO), `src/lib/agent/prompt.js` (prompt), `src/lib/person-links.js` (group reads), tests in `src/lib/agent/core.test.js`.

## Problem

A verified member (Richard) was asked to re-verify (email + surname) when he tried to book, even though his number is on his account. Investigation found **two independent causes**:

1. **Phone auto-verify needs an _exactly-one_ contact match.** `autoVerifyContactId` (core.js) only trusts the SIM-bound sender number when it maps to exactly one contact. Richard's number `+353873147675` is on **three** contact records at Stillorgan (richard@richardivers.com [primary thread link], richard.ivers3@gmail.com, a typo "ivers"/"ivets"). The match query (`auto-reply.js`, `.limit(2)`) returns ≥2 → ambiguous → it skips the shortcut and runs the quiz. **It counts raw contact rows; it does not collapse linked/duplicate records into one Person** — so even though all three are already grouped into one Person (`person_groups` id `3199dbb2…`), the verifier still sees "multiple, ambiguous."

2. **A prior quiz verification is never surfaced to the model.** Richard verified on this thread on 14 Jun; `VERIFY_TTL_MS` is 30 days, so it was still fresh. But the "already verified — don't ask" instruction in `prompt.js` is only emitted when `identityPreverified` is true, and that flag is set **only** for phone-preverification (`!!preverifiedContactId`). A quiz verification is trusted by the tools (`toolCtx.verifiedContactId` via `isVerificationFresh`) but the **model is never told**, so it re-asks at the next booking request.

## Design

Three coordinated changes, all in the agent layer.

### 1. Link-aware phone verification
When the sender's number matches more than one contact, resolve each match's Person group (`person_group_members` → `group_id`). **If every match — and this thread's contact — belongs to one and the same Person group, treat as verified.** Trust the group at any link confidence (Richard's call; groups are operator-reviewable and auto-linking is high-confidence-only by policy). If matches span more than one group, or any match is ungrouped, it stays ambiguous → quiz. The exactly-one-match path is unchanged. Instagram has no phone, so this branch never runs there.

### 2. Act on the Person group's primary account
Whenever the agent is verified — by phone, by link, **or** by the email + surname quiz — the acting account for every tool (book class, book event, consultation, account lookups, `save_lead_details`, cancel) resolves to the Person group's `primary_contact_id`, not whichever duplicate the thread is linked to. Mechanism: all agent tools already key off `toolCtx.verifiedContactId` (falling back to `contactId`), so this is a **single resolution point** — set `verifiedContactId = resolveActingContactId(verifiedId)` where `resolveActingContactId` returns the contact's group primary if grouped, else the contact itself.

### 3. Sticky verification (stop re-quizzing within the TTL)
Surface a still-fresh prior verification to the prompt so Mia doesn't re-ask. Generalize the prompt to an "identity is confirmed for this conversation — do not ask for email/surname, do not call verify_identity" instruction emitted when **either** the phone pre-verify fired **or** there is a fresh stored `agent_verified_contact_id` (within the existing 30-day `VERIFY_TTL_MS`). Wording becomes provenance-neutral (no longer claims "messaging from the phone number on their membership"). No change to the TTL.

## Structure & boundaries

- **Pure logic → `core.js`** (unit-tested in `core.test.js`, same as existing helpers):
  - A decision function: given the match set, each match's `group_id`, the thread contact's `group_id`, and per-group `primary_contact_id`, return `{ verified: bool, actingContactId }`.
  - `resolveActingContactId(contactId, groupInfo)` → group primary or self.
  - The "identity confirmed" flag = phone-preverified **or** fresh stored verification.
- **IO → `auto-reply.js`**: replace the `.limit(2)` id-only match query with one that also yields group membership for the matches + the thread contact (via a `person-links.js` helper); compute the verdict + acting contact; set `toolCtx.verifiedContactId` to the acting (primary) contact; set the prompt flag. Applies on every channel (WhatsApp + Instagram via the adapter).
- **Group reads → `person-links.js`**: reuse / add a small helper to fetch, for a set of contact ids, their `group_id` and the group's `primary_contact_id` in one round-trip. No schema changes.
- **Prompt → `prompt.js`**: generalize the `identityPreverified` branch to the provenance-neutral "already verified" instruction described in change 3.

## Security reasoning

The exactly-one rule exists to avoid auto-verifying the wrong human when a number is shared by **different** people (couple/family). Link-awareness preserves that guarantee: it only collapses matches that are **the same Person** (one group). Two different people sharing a number would be two different groups (or ungrouped) → still ambiguous → quiz. Trusting any in-group link is acceptable because a wrong link would be a same-number/same-person data error that the operator can review and unlink; it cannot silently verify a *stranger*. Sticky verification (change 3) is bounded to the same thread and the same 30-day window already in use.

## Non-goals (YAGNI)

- No operator UI changes.
- No changes to the linking / dedup / suggestion engine.
- No new tables or migrations.
- No change to `VERIFY_TTL_MS`.

## Data note (separate from this code change)

The Person group `3199dbb2…` currently has its `primary_contact_id` set to the **dormant** `richard.ivers3@gmail.com` record, not `richard@richardivers.com`. After change #2, bookings route to that primary. If a different record should be canonical, set the primary on the contact page — a data setting, independent of this change.

## Testing

- Unit-test the pure decision + `resolveActingContactId` + the confirmed-flag logic in `core.test.js`: exactly-one match; multi-match all-one-group; multi-match split groups; multi-match with an ungrouped straggler; ungrouped single; grouped single; acting-contact resolves to primary; fresh vs stale stored verification.
- Existing agent tests continue to pass (the `identityPreverified` rename/generalization touches `prompt.test.js` cache-stability tests).
- Manual: Richard re-texts the Stillorgan number → no verification prompt → "book" acts against the group primary.

## Rollout

Branch + PR per repo convention. TDD (tests first for the pure logic). Run the full CI mirror + `next build` before pushing. Default-safe: agent stays in test mode; no behaviour change for unverified or single-contact senders.
