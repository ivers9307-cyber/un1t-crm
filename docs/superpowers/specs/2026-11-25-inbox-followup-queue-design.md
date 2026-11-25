# Inbox follow-up queue: design

25 November 2026. Status: awaiting Richard's approval.

## Intent

The WhatsApp and Instagram inbox (`/communications/inbox`, and the Messages
tab in the staff app) loses leads at one specific point. Once a member of
staff replies to a thread, it leaves "Needs reply", and if the customer goes
quiet nothing ever brings it back. Mia chases her own quiet threads
(`src/lib/agent/followups.js`), but she deliberately skips any thread a human
has replied in. So the threads with no follow-up at all are the ones staff
took over.

A comparison with other shared inboxes (respond.io, Chatwoot, Intercom,
Crisp, Wati, Superchat, GoHighLevel, Podium) showed the same four things
missing here: a waiting-on-customer state, snooze, a longest-waiting sort,
and the WhatsApp 24-hour window shown as a state on the row.

This change makes the inbox answer two questions at a glance: whose turn is
it, and how long have they been waiting. It also makes sure a quiet thread
comes back without anyone having to remember it.

## Goals

1. A thread staff replied to is never forgotten: it comes back by itself
   after a quiet period, and Mia can send one nudge first.
2. "Needs reply" shows the customer who has waited longest at the top, with
   the wait on the row.
3. Every WhatsApp row shows the state of the 24-hour window.
4. "Mia needs help" contains only threads where Mia asked for a human.
5. The "Handled by" control tells the truth about who is handling a thread.
6. Staff can snooze a thread to a date, with a note.

## Non-goals

- Composer changes (saved replies, internal notes, multi-line, emoji).
- Reply-time reporting. This design adds the timestamp that reporting will
  need, and nothing else.
- Tags, bulk actions, collision warnings, round-robin, teams, priorities.
- Merging one person's WhatsApp and Instagram threads into one row.
- Any change to the Mail surface.

## Anti-goals

- **Mia answering in a coach's thread.** When a customer replies to Mia's
  nudge, Mia sends nothing: no answer and no "passing you to the team"
  holding message. The reply appears in the coach's "Needs reply" and that
  is all the customer-facing behaviour there is.
- **A lost customer message.** No new state may hide an inbound message.
  Any inbound message clears snooze and waiting and puts the thread in
  "Needs reply".
- **A queue that depends on pressing a button.** Snooze is an override. The
  default path needs no staff action.

## Approaches considered

- **A. Snooze only.** A "Remind me" button. Smallest build, but a reply sent
  in a hurry still disappears.
- **B. A Waiting queue plus snooze.** Queues redrawn around whose turn it
  is; a quiet thread returns to staff by itself.
- **C. B, plus Mia nudges the quiet threads staff took over.** Chosen by
  Richard. Least staff effort. Its risk is Mia speaking in a conversation a
  coach owns, which is why the anti-goal above exists and why a reply to her
  nudge goes back to the coach silently (Richard's decision).

## What staff see

Queue chips, in this order:

```
Needs reply 4   Mia needs help 1   Waiting 12   Approvals 1   All

Needs reply (longest wait first)
  A. M.   "is there parking?"            waiting 2h 10m   closes in 21h
  D. S.   "can I move to Thursday?"      waiting 35m      closes in 23h
  O. N.   No reply after nudge           quiet 4 days     template only

Waiting
  E. R.   You: "want me to book it?"     quiet 1 day      template only
  P. K.   Mia nudged Tue 10:02           quiet 2 days     template only
  I. W.   Snoozed until Fri 09:00 · "back from holiday"
```

- **Needs reply** (the default): unresolved threads where it is our turn.
  That is: the customer spoke last; or a waiting thread whose quiet period
  ran out (see the ladder below). Sorted by how long the customer has been
  waiting, longest first. Threads that came back from Waiting sort by when
  they came back.
- **Mia needs help**: unresolved threads where Mia herself handed off and no
  human has replied or resolved since. Renamed from "Handoff". A staff reply
  no longer puts a thread here.
- **Waiting**: unresolved threads where a member of staff sent the last
  message and the quiet period has not run out, plus every snoozed thread.
  Automated sends (class reminders, broadcasts, booking confirmations) do
  not put a thread in Waiting.
- **Approvals** and **All**: unchanged.
- The owner filter (Anyone / Mine / Unassigned) and search work as today.
- The sidebar and tab badge keep counting "needs action": Needs reply plus
  Mia needs help. Waiting and snoozed threads are not counted.

Row additions:

- **Wait chip.** "waiting 2h 10m" when it is our turn; "quiet 2 days" when
  it is theirs.
- **Window chip, WhatsApp only.** "closes in 3h" while the window is open
  (amber under 4 hours), "template only" once it has closed. Instagram rows
  show no window chip in this version (my call: `instagram_conversations`
  has no window column, and an estimate that is sometimes wrong is worse
  than none).
- **State line.** "Snoozed until …" with the note, "Mia nudged …", or "No
  reply after nudge" replaces the message preview when it applies.

Thread header:

- **Snooze** button beside Resolve: Later today (3 hours), Tomorrow 09:00,
  In 3 days 09:00, Next week (Monday 09:00), or pick a date and time, on the
  studio's clock. Optional note, 140 characters. A snoozed thread shows
  "Snoozed until … · Unsnooze".
- **Handled by** shows one of these states:
  - **Mia**: she will answer the next message.
  - **A named person**: a human has taken the thread over (the assignee if
    there is one, otherwise whoever sent the last staff message). Mia is
    silent. Choosing "Mia" hands the thread back to her.
  - **Mia paused**: the existing sticky pause. WhatsApp only (my call):
    Instagram has no sticky pause and this design does not add one, so an
    Instagram thread shows Mia or a named person.
  - **Waiting for a person**: Mia handed the thread off and nobody has
    replied yet. Mia is silent and no one owns it (my call: a fourth state,
    because none of the other three is true here).
  Today the WhatsApp control reads "Mia" after a staff reply has already
  switched her off; that is the fault this fixes.

## The follow-up ladder for a thread staff took over

Clock starts when a member of staff replies in the thread and the customer
has not replied. `Q` is the studio's quiet period.

Only a reply sent from the inbox thread starts the ladder (my call): typed
text, a photo or PDF, a card set, a booking flow, or a template the staff
member picks in the thread. Payment links, cancellation forms, sends from a
contact's page and broadcasts do not, even though they take Mia off the
thread today.

1. **0 to Q**: the thread sits in Waiting.
2. **At Q, Mia's nudge switched on, WhatsApp only**: Mia sends one nudge.
   - Outside the 24-hour window (the normal case): one approved template,
     named in the studio's settings, sent only with marketing consent,
     exactly as her existing stage-2 follow-up does.
   - Inside the window (possible when `Q` is under 24 hours): one short
     free-text message she composes from the thread, as her existing
     stage-1 nudge does.
   - The thread stays in Waiting, marked "Mia nudged".
   A nudge may go out from `Q` until `Q` + 24 hours (my call). That covers
   a nudge that fell due at night or on a day the cap was reached. During
   that day the thread stays in Waiting. If the day passes with no nudge,
   the thread goes to step 3 un-nudged.
3. **`Q` after the nudge was sent; or at `Q` when the studio has nudges
   off; or at `Q` + 24 hours when a nudge was due but never sent**: the
   thread returns to "Needs reply" once, marked "No reply after nudge" or "Gone
   quiet". Staff complete it (which gives it back to Mia), reply
   again (which restarts the ladder), or snooze it. It stays there until
   one of them does. It is not counted as a second inbound message and sends no
   push.

Any inbound message at any point ends the ladder: the thread goes to "Needs
reply" as a normal customer message, with the normal staff push.

A nudge is not sent, and the thread goes straight to step 3 at `Q`, when:

- the nudge is switched off for the studio, or no template is configured or
  approved;
- the thread is on Instagram (no templates exist there);
- the contact has no marketing consent, has opted out, or is blocked;
- the thread has no linked contact;
- the studio's daily follow-up cap is reached;
- the studio has no WhatsApp number switched on;
- the thread is about a pause or a cancellation (the existing follow-up
  ladder's `intentFlags` exclusion applies here too).

Consent (my call, matching the existing ladder): the template nudge needs
marketing consent. The free-text nudge inside the 24-hour window does not,
but an opted-out or blocked contact gets neither.

A nudge is never sent, and nothing else happens either, while a thread is
snoozed, resolved, or has Mia paused. Snooze is a coach saying "I have
this": the ladder is suspended until the snooze ends, then resumes from
where the clock now stands (a thread past `Q` when its snooze ends goes
straight to "Needs reply"; it is not nudged late).

Nudges go out only in the studio's daytime and outside the operator's quiet
hours, using the same checks as the existing follow-ups
(`proactiveWindowOpen`). A nudge that falls due at night waits for morning.

One nudge per quiet spell. A new staff message after the nudge starts a new
spell.

### When the customer replies to the nudge

Mia sends nothing. No answer, no holding message, no handoff notice. The
thread is still the coach's:

- it moves to "Needs reply";
- the usual inbound push goes to the assignee, or to managers when there is
  none;
- "Handled by" still shows the coach;
- it does not enter "Mia needs help".

The existing reply gate (`shouldAgentReply`, `src/lib/agent/core.js`) lets
Mia re-arm when the 12-hour handoff cooldown has passed and the last
outbound message was not a human's. Mia's nudge would be that non-human last
message, so as the code stands she would answer. The build must close this:
a thread a human took over stays human-owned through a nudge, until someone
resolves it or hands it back to Mia. This needs its own test.

## The coach keeps the thread for the whole ladder

Richard's decision. Today `runHandoffAutoResolve`
(`src/lib/agent/handoff-sla.js`) resolves a thread 8 hours after a staff
reply if the customer stays quiet, and hands it back to Mia; a second rule
resolves any handed-off thread after 48 hours of nothing. Neither studio
overrides those defaults. Left alone, the first rule would resolve every
staff thread before the ladder starts. So:

- A thread on the ladder (`staff_waiting_since` set) is exempt from the
  8-hour after-reply auto-resolve.
- Mia stays off that thread until a coach completes it. The
  12-hour cooldown re-arm in `shouldAgentReply` does not apply to it, with
  or without a nudge as the last outbound message. Every customer reply in
  that time goes to the coach, and Mia sends nothing.
- The accepted cost: a customer who writes out of hours to a thread a coach
  is running waits for a person, where today Mia would answer after 8
  hours.
- Only a coach marking the thread completed (Resolve, or "Mark handled" on
  the row) gives it back to Mia. Richard's decision. No timer does it: a
  thread a coach replied in is exempt from the 48-hour stale auto-resolve
  as well, before and after it comes back to "Needs reply". Choosing "Mia"
  in "Handled by" is the same deliberate act by another route and also
  hands it back.
- The accepted cost: a thread that comes back as "Gone quiet" or "No reply
  after nudge" stays in "Needs reply", and counts on the badge, until a
  coach completes it.
- This exemption follows the thread, not the ladder: it lasts from the first
  staff reply in the thread until the thread is completed, including while
  the customer and coach are going back and forth.
- The 8-hour rule still applies to staff sends that do not start the ladder
  (payment links, cancellation forms, contact-page sends).
- The handoff alert sweep (60 minutes with no human reply) is unchanged.

## Settings

Per studio, under the existing customer agent follow-up settings
(`settings.customer_agent.followups`), in the same settings screen:

- **Quiet period** for threads staff are waiting on: default 48 hours,
  allowed 4 hours to 14 days. Applies whether or not Mia nudges.
- **Mia nudges quiet threads staff took over**: off by default.
- **Nudge template**: an approved WhatsApp template, chosen from the
  studio's list. Separate from the existing follow-up template, because the
  wording differs (the customer was talking to a person).

Nudges count toward the existing daily follow-up cap.

Richard submits the new template to Meta. Until one is approved and chosen,
the switch can be on and the ladder simply skips the nudge.

## Data

New columns on both `whatsapp_conversations` and `instagram_conversations`
(one forward-only migration, applied before the code deploys):

| Column | Meaning | Set | Cleared |
|---|---|---|---|
| `customer_waiting_since` | First inbound message not yet answered | On an inbound message when null | On any outbound reply (staff or Mia), and on resolve |
| `staff_waiting_since` | Staff sent the last message | On a manual staff send | On an inbound message, and on resolve |
| `staff_nudged_at` | Mia nudged this quiet spell | When the nudge is sent | On an inbound message, on a manual staff send, on resolve |
| `handoff_requested_at` | Mia asked for a human | In Mia's `handoff()` only | On a manual staff send, on resolve, on hand-back to Mia |
| `snoozed_until`, `snoozed_by`, `snooze_note` | Snooze | By the snooze route | On an inbound message, on unsnooze, on resolve, or when the time passes |

`agent_handed_off_at` keeps its present meaning and both of its present
writers; the handoff alert sweep keeps working from it. Only the queue stops
reading it.

Backfill in the migration: `handoff_requested_at` = `agent_handed_off_at`
for unresolved threads whose last outbound message is Mia's;
`customer_waiting_since` = `last_message_at` for unresolved threads whose
last message is inbound. `staff_waiting_since` is not backfilled (my call):
backfilling would start the ladder on every old thread at once and, with
nudges on, send a burst of templates. Old threads join the ladder the next
time staff reply in them.

Automated outbound sends (reminders, broadcasts, confirmations) do not touch
`customer_waiting_since` (my call): a class reminder is not an answer to a
question.

## Rules that bind the build

- The queue rules stay in one place and are shared by web, the badge count
  and the phone app. The phone cannot import `src/lib`, so the rules move to
  `shared/` and `src/lib/inbox-queues.js` re-exports them.
- The queue rules are pure: they take the thread, the current time and the
  studio's follow-up settings (quiet period, nudges on or off). "Quiet
  period ran out" needs no stored flag and no sweep to move a thread between
  queues. Only the nudge send needs a scheduled job.
- The nudge runs inside the existing `agent-followups` cron, not a new one,
  and uses its machinery: per-studio settings, daytime gate, daily cap,
  consent gate, `recordProactiveMessage`, structured skip reasons.
- The list route caps at 50 threads per channel with no paging. Waiting can
  exceed that. Queue membership and chip counts must not be silently cut off
  by the cap.
- Snooze, unsnooze and hand-back are service-role routes built with
  `withAuth`, scoped to the conversation's own studio, answering 404 for a
  thread the user cannot see. Client sessions never write these columns.
- The phone app reads `whatsapp_conversations` directly under column grants,
  so each new column needs an explicit grant decision, and a `role-access`
  test case. `snoozed_by` is exposed as an id only; never embed `profiles`
  in a phone-direct select.
- Snooze times are computed on the studio's clock through
  `@/lib/location-time` / `shared/zoned-time`.
- Every write destructures `error`. The WhatsApp pause route currently
  ignores its update error and always answers success; fix it while that
  route is being changed for hand-back.
- A failed nudge never blocks the thread from returning to staff at 2 × Q
  or Q.

## Phone app

Same queues, chips, sort and row states as web. Snooze and unsnooze in the
thread. "Handled by" shows the same three states. The phone list has no live
updates today; that is unchanged here. This ships as an over-the-air update
on merge, to every phone.

## Left to the builder

- Column types, index choice, and whether the list route filters by queue on
  the server or returns more rows.
- How the reply gate records that a thread is human-owned through a nudge.
- Exact chip colours and wording within the `un1t-*` tokens and the
  `bg-<c>-500/10 text-<c>-700` chip convention.
- How the work is split into pull requests. A sensible split: (1) migration,
  shared queue rules, web queues and row; (2) snooze and Handled by;
  (3) Mia's nudge and settings; (4) phone app.

## How it is checked

- Unit tests for the queue rules over time: each state, each transition,
  the cap, snooze suspending the ladder.
- A gate test: staff reply, cooldown passes, Mia nudges, customer replies,
  Mia stays silent and sends no holding message.
- Skip-reason tests for every "nudge is not sent" case.
- `role-access` cases for the new columns.
- The CI mirror in `CLAUDE.md`, and `npm run build`.
- A live pass at Test Studio before the nudge is switched on at a real
  studio: staff reply, short quiet period, nudge arrives, reply lands in
  "Needs reply" with no message from Mia.
