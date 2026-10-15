# WAHOMESTUDIO — WhatsApp threads filed at the customer's real studio

**Date:** 2026-10-15 · **Status:** design approved in chat, spec awaiting review
**Phase 1 of 3** of "Mia at organisation level" (see §8).

## 1. Problem

UN1T Group has one WhatsApp number (Stillorgan, +353 1 578 9401). Hatch Street
has none. WANUMBERLESS.1 (#1940) files a thread at the studio whose number the
customer wrote to whenever the contact's home studio has no number, because a
thread filed at a number-less studio could be read but never answered. So:

- ~120 threads for Hatch-home contacts sit in the **Stillorgan** inbox.
- Outbound broadcasts and sequences file the same way
  (`getOrCreateConversation(db, contact, broadcast.location_id)`), so a
  Stillorgan broadcast to a Hatch contact also opens a Stillorgan thread.
- Mia reads the thread's studio, so switching her on at Stillorgan would also
  switch her on for every Hatch customer, with Stillorgan's knowledge and
  Glofox.

## 2. Goal

A thread for a contact whose home studio is a **number-less sibling in the
same organisation** is filed at that home studio and replies through the
organisation number the customer wrote to (or was sent from). Hatch threads sit
in the Hatch inbox; Hatch staff answer them there; Mia at Stillorgan never
sees them.

Success:
1. A Hatch-home contact messaging the Stillorgan number lands in a Hatch
   thread; a staff reply, reaction, carousel, template and media fetch in that
   thread all work, sent from +353 1 578 9401.
2. A Stillorgan broadcast to a Hatch-home contact files in the Hatch thread
   (no split thread when they reply).
3. The existing ~120 threads are moved to Hatch with their messages and agent
   rows; none remain mis-filed.
4. Staff can move a thread between studios of the same organisation from the
   inbox (needed for unknown senders, and the seam Phase 2 uses).
5. Nothing changes for a studio that owns a number, or across organisations.

## 3. Rules (the contract)

**R1 — the filing rule.** One helper, `numberlessHomeStudio(db, contact,
numberLocationId)` in `src/lib/whatsapp-thread-location.js`, returns the
contact's home `location_id` when ALL hold, else `null`:
- the contact has a home studio and it differs from `numberLocationId`;
- both studios are in the same organisation;
- the home studio has no active `whatsapp_numbers` row.

A failed lookup returns `null`, logged: the thread files where it does today
(answerable beats lost). Callers: `getOrCreateConversation` (broadcasts,
sequences, every outbound that opens a thread) and the coexistence ingest. The
inbound webhook applies R2 directly (its contact match is already
organisation-fenced).

**R2 — the webhook.** An inbound from a matched contact files at the contact's
home studio (contact matching is already org-fenced, `orgLocationIdsFor`). The
WANUMBERLESS.1 fallback is removed. An unknown sender still files at the
receiving studio.

**R3 — the number stamp.** `whatsapp_conversations.whatsapp_number_id` records
the organisation number the thread talks through. The webhook stamps the
receiving number when the thread is at the receiving studio (as today) **or**
the thread's studio has no number of its own. `getOrCreateConversation`
stamps the sending studio's default number when it files at a number-less
home studio and no stamp exists.

**R4 — the reply number.** `getConversationNumberConfig(locationId,
conversationId)` returns the stamped number when it is active and either
(a) owned by the thread's studio (today), or (b) owned by a studio in the same
organisation **and** the thread's studio has no active number of its own.
A number in another organisation is never used. For templates,
`getConversationReplyConfig` uses the thread number when the thread's studio
has no default to compare against (instead of throwing).

**R5 — templates in a thread.** Templates are synced per studio from that
studio's default number's WABA. The template a thread sends, and the template
list its picker shows, come from the studio that **owns the thread's number**
(`templateLocationIdFor(conversation)`), authorised against the thread's
studio. A studio with its own number is unchanged.

**R6 — other in-thread sends that refuse today.** Inbound media re-hosting
(`whatsapp-media-server.js`), the STOP/START acknowledgement
(`whatsapp-consent.js`) and block (`conversations/[id]/block`) resolve their
number through the thread (R4), not the studio's own number.

**R7 — move.** One SQL function, `public.move_whatsapp_conversation(
p_conversation_id uuid, p_target_location_id uuid)`, atomic:
- refuses a target in another organisation, or the same studio;
- if the target has no thread for that `wa_phone`: re-files the conversation;
- if it has one: **merges** into it (re-points messages, keeps the target's
  row, newest `last_message_at`, summed unread) and deletes the emptied source
  row;
- re-files `whatsapp_messages.location_id` and the `channel='whatsapp'` rows of
  `agent_decisions`, `agent_conversation_reviews` (a same-day review clash keeps
  the target's), `agent_membership_requests`, `agent_message_feedback`;
- stamps the source studio's default number when the thread has no stamp;
- EXECUTE for `service_role` only (`REVOKE EXECUTE … FROM PUBLIC, anon,
  authenticated` stated, per mig 667).

The backfill (migration 724) calls it for every thread whose contact's home
studio is a number-less same-organisation sibling of the thread's studio.
`POST /api/whatsapp/conversations/[id]/move { location_id }` calls it for staff
with access to both studios; the inbox thread header gets a "Move to studio"
menu listing the caller's other studios in the same organisation.

## 4. Out of scope (Phase 1)

- Sends that start from a **contact**, not a thread: contact page WhatsApp,
  cancellation form, churn/lead radar, campaign audiences. They keep refusing at
  a number-less studio (409, as today).
- Mia's follow-ups and first-class check-ins (`followups.js`) send with
  `{ locationId }`, not through the thread. Mia stays OFF at Hatch, so they
  never run there; Phase 3 routes them through the thread.
- WhatsApp Flows at Hatch (`settings.whatsapp_flow` is per studio, a Flow
  belongs to one WABA).
- **Mobile** template picker (`mobile/lib/whatsapp-api.js`) — a mobile change is
  an OTA publish and the fleet is frozen on 2.3.x; Hatch threads on mobile show
  an empty template list. Free text works.
- Instagram (Hatch owns its own IG connection already).

## 5. Rollout

Two migrations, because CLAUDE.md applies a migration *before* the code that
depends on it, while moving threads to Hatch before the code can reply from a
sibling number would strand them:

1. Apply **723** (`move_whatsapp_conversation` function only; inert, nothing
   calls it yet).
2. Merge the web PR (R1–R7 code, the move route).
3. Dry run: count threads the backfill will move/merge.
4. Apply **724** (the backfill) right after deploy; move/merge absorbs any Hatch
   thread the new webhook opened in between.
5. Verify: zero mis-filed threads; a Hatch contact's message lands in the Hatch
   inbox and a reply arrives from +353 1 578 9401.
6. Then (Richard's call) Mia can be switched on at Stillorgan without reaching
   Hatch customers.

**Invariant update (same PR).** CLAUDE.md's WACONFIGFALLBACK.1 line ("a
location with no active number CANNOT send") gains its one exception: a reply
INTO a thread filed at a number-less studio goes from the stamped number of a
studio in the SAME organisation (R4). The rule's original harm, a customer's
reply landing in another studio's inbox and Mia, cannot recur: the thread is
filed at the customer's own studio. Every send that does not start from a
thread still refuses.

Rollback: revert the PR; threads already at Hatch become unanswerable until
moved back with the same function (`move_whatsapp_conversation(id,
stillorgan)`), so revert means "move back", scripted in the PR description.

## 6. Testing

- Unit: `numberlessHomeStudio` (home numberless same org → home; home with
  number → null; other org → null; lookup failure → null + log).
- Webhook: Hatch contact → Hatch thread + receiving-number stamp; unknown
  sender → receiving studio; studio-with-number contact unchanged
  (`route.reply-number.test.js` WANUMBERLESS.1 cases rewritten).
- Reply number: same-org sibling stamp used when the thread's studio has no
  number; ignored when it has one; other-org never; template path at a
  number-less studio (`whatsapp-reply-number.test.js`).
- `tests/whatsapp-config-callers.test.js` caller table updated for the changed
  callers (webhook, media server, consent, block, send route).
- `getOrCreateConversation`: files at numberless home + stamps.
- Templates: send route reads the number owner's templates; picker endpoint.
- Move route: auth (both studios), cross-org 400, existing-thread merge, success.
- Migration static test (function body, grant, backfill predicate), like
  `tests/migration-696-*.test.js`.
- Live: §5 step 4.

## 7. Risks

- **Split threads** if any path opening a thread bypasses R1. Mitigated by R1
  living in `getOrCreateConversation`, which every outbound path uses; the
  backfill's merge cleans up anything that slips through.
- **A sibling's stamp on a studio that later gets its own number:** R4(b) stops
  applying the moment the studio has an active number, so replies switch to the
  studio's own number. Accepted (that is what owning a number means).
- **Hatch staff need the Hatch inbox**, not Stillorgan access — that is the
  point; moving a thread needs access to both studios.

## 8. Later phases (not in this spec)

- **Phase 2 — new senders:** resolve an unknown sender's studio from the CTWA
  ad, the template replied to, or a studio named; else Mia asks once; then
  `move_whatsapp_conversation`.
- **Phase 3 — org config + Hatch-capable Mia:** `org_settings.customer_agent`
  defaults merged under per-studio overrides by one `resolveAgentSettings`; the
  on/off switch stays per studio, default off, never inherited; booking and
  membership tools off where `membership_source` is not Glofox; un1t.online
  link for booking; follow-ups/check-ins sent through the thread.
