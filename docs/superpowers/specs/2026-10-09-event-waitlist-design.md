# Event waitlist (EVENT-WAITLIST.1)

**Date:** 2026-10-09 · **Status:** built on branch `event-waitlist` (PR pending) · **Repo:** un1t-crm, Events applet.

## Problem

When an event sells out, nothing captures the people who still want in. When a
spot frees (a cancellation, a move away, an abandoned payment), nobody is told
and the spot often stays empty.

## Decisions (Richard, 9 Oct 2026)

| Question | Decision |
|---|---|
| Unit | **Per event**, any time. People join the event, not a time slot. |
| Offer | **Everyone at once.** When any time has room, every waiting person is told; the first to complete a booking gets the spot. The register route's existing capacity gate is the arbiter. |
| Mine, to keep it small | One offer per person per 24 hours; email always, WhatsApp only when the row has a phone and the location holds an APPROVED template `event_waitlist_offer`; the list expires when the event date passes; no Mia tool; no per-time preference. |

## Data

`event_waitlist` (mig 713): one row per `(race_event_id, email)` with name,
phone, `headcount`, `status` (`waiting | offered | claimed | expired | removed`),
`source` (`public | staff | host | agent`), `marketing_consent`,
`last_offered_at`, `offer_count`, `claimed_registration_id`, `removed_by_name`.
Service role only (RLS on, no client grant). Two operator-editable copy
columns on `race_events`: `waitlist_email_subject/intro`. A `cron_heartbeats`
row for `event-waitlist-offers`.

## Flow

1. **Join.** On a sold-out public event page (`registration_state === 'full'`)
   the signup widget shows a short form (name, email, phone, team size,
   marketing consent). `POST /api/public/events/[slug]/waitlist` is
   rate-limited like registration, refuses when the event has room
   (`has_room`), is not published or public, or is past; it finds or creates
   the contact the way registration does, upserts the row (a removed or
   expired row re-joins as waiting) and sends a short fixed "you're on the
   waitlist" email. The public never sees how many are waiting, nor any
   capacity.
2. **Offer.** Cron `event-waitlist-offers` (every 10 min, heartbeat) finds
   published upcoming events with waiting people where any time has room
   (confirmed-only arithmetic, the same as the public `is_full`). Everyone
   not offered in the last 24 hours gets the offer email
   (`resolveEventEmail({ kind: 'waitlist' })`, merge tag `{{claim_url}}`,
   administrative consent; the cron re-runs, so the gate is the normal one) and, when possible, the WhatsApp
   template. Rows move to `offered`; the event's passing expires them. One
   failed send never stops the round.
3. **Claim.** The claim link opens the event's normal signup page with a
   signed 14-day token; the register route accepts `waitlist_token` and, on
   a successful registration, marks that row `claimed` with the registration
   id. It also claims by the lead email (lower-cased, trimmed) with no token,
   so someone who books from the normal page or another device leaves the
   list too, and each round marks any waiting row that matches a live
   registration (by contact or email) as claimed. First to pay (or to
   confirm a free entry) wins; the rest stay offered and are told again when
   room appears. A claim is made at pending payment; a round re-opens a
   claimed row whose registration is since cancelled, a no-show, gone, or
   moved to another event (a still-pending one is left alone), so an
   abandoned checkout returns to the list. Events with no date never expire
   or re-open rows. A studio with no WhatsApp number skips that leg quietly.
4. **Staff and hosts.** The teams page and the host event page list the
   event's waitlist (name, email, phone, size, joined, last offered, status),
   let staff remove a person, and let staff or the host run an offer round
   now ("Offer now (everyone)": it ignores the 24-hour rule and is limited to
   three runs an hour per event, shared between staff and host). Counts are
   fine on these operator surfaces.

## Non-goals

Per-time waitlists; guaranteed holds or claim windows; a Mia tool; automatic
re-ordering; self-removal links (a reply to the email reaches the inbox).

## Richard owes

Create the WhatsApp template `event_waitlist_offer` (body params: name, event
name, claim link) at each studio that should send the WhatsApp leg; until
then the offer goes by email only.
