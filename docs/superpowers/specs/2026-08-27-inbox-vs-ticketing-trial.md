# Inbox vs ticketing — how the trial runs

**Status:** design. Build in progress on `inbox-surface`.
**Decided by:** Richard, 2026-08-27 — "run one on each and see which I prefer."

Not a migration. Two real mailboxes, two surfaces, one operator, one decision at
the end. This document exists so the decision is made against criteria chosen
**before** the trial rather than after it.

## The setup

| Mailbox | Surface | Traffic |
|---|---|---|
| `accounts@hatchstreetfitness.com` | ticketing (`/communications/tickets`) | suppliers, billing, the rates office |
| `hatchstreet@un1t.com` | mail (`/communications/mail`) | customer enquiries + franchisor/head-office + suppliers |

`email_mailboxes.surface` (mig 575) decides which UI a mailbox appears in. Each
appears in exactly one — if both showed everything there would be no trial.

🔴 **The new surface lives at `/communications/mail`, not `/communications/inbox`.**
`/communications/inbox` was already taken, by the live unified WhatsApp/Instagram
queue, which even has a documented `?ch=em` redirect into tickets. Building the
mail surface there would have collided with a working feature and sent anyone
following that redirect somewhere new without warning. The DATA value is still
`surface='inbox'` — the column names the concept, the route names the page.

🔴 **Blocked on one operator step:** an app password for `hatchstreet@un1t.com`.
Until it is connected that arm has no mail and the trial cannot start.

## 🔴 The confound, and how to control it

**The two mailboxes do not carry the same mail.** `accounts@` is suppliers and
billing; `hatchstreet@` is mixed customer/franchisor/supplier traffic. So a
preference formed in week one might be a preference for the *mail*, not the
*surface* — the busier, more conversational mailbox will feel better to work in
whichever UI it happens to be wearing.

**Control it by swapping.** `surface` is a per-mailbox switch in Settings →
Locations → Hatch Street → Email, so this costs one click each:

- **Week 1** — `hatchstreet@` on inbox, `accounts@` on ticketing
- **Week 2** — swap them

If the same surface wins both weeks, that is a real result. If the preference
follows the mailbox rather than the surface, the honest answer is that it does
not matter much and the tiebreak should be maintenance cost, not taste.

## What to judge it on — decide now, not afterwards

Five questions, answered at the end of week two. They are deliberately about
*work*, not features:

1. **Did anyone get answered twice, or not at all?** The 17-day baseline is 30
   inbound and 12 outbound — most inbound mail got no reply. Which surface moved
   that number?
2. **Where did you go first** when you sat down to deal with mail?
3. **Which one did you leave unread at the end of a day**, and did that bother you?
4. **When something needed a colleague** — did you reach for assignment, or just
   forward it and say so? (Assignment has been used **zero** times in 17 days.)
5. **Which one would you put in front of a franchisee** who has never seen either?

Deliberately NOT measured: clicks, time-on-page, feature counts. One operator
for two weeks cannot produce a significant number, and a number that looks
objective would carry more weight than it earns.

## The failure this exists to prevent

Both surfaces alive for ever. Two thread renderers, two lifecycles, two sets of
tests, every future email fix done twice — which is exactly the drift that put
two copies of `deliveryMeta` out of step within a week of each other.

**So: a decision date, and the loser is deleted.** Not deprecated, not left
behind a flag. If the trial ends without a decision, that is a decision to keep
ticketing, because it is the one already carrying real mail.

## What is shared, and stays shared whichever wins

- Ingestion: the IMAP poller, OAuth, SMTP send, attachments, threading. All of it
  is surface-agnostic and none of it is part of this comparison.
- `email_tickets` / `email_inbox_messages`: **one data model.** The inbox is a
  different presentation of the same rows, not a second store. Archive is
  `status='closed'` wearing a different word.
- **Needs-reply** — `status='open' AND last_message_direction='inbound'`. The one
  thing a plain mail client cannot tell you, and one predicate to carry. It lives
  in both surfaces regardless of the outcome.

## Consequence worth stating plainly

The inbox surface makes the connector **write to the real mailbox** — mark
`\Seen`, move to Archive — for `surface='inbox'` mailboxes only. Everything before
this was strictly read-only, and that was a deliberate safety property. Delete is
never in scope; Archive is recoverable from All Mail.

Mark-unread is part of that write path, and it nearly did not ship. It was cut
during the build on correct reasoning — a CRM-only unread mark is converged away
within fifteen minutes, and a button that silently undoes itself is worse than a
missing one — but the remedy was the paired IMAP write, not a permanently missing
verb. The ticket queue has *reopen*; a mail surface with no defer verb at all
would have gone into the trial missing its main triage tool and biased the very
comparison the trial exists to settle.

**And the read state flows BOTH ways.** Mail read in Gmail reads as read in the
CRM, and mail marked unread in Gmail comes back unread here. That is what makes
the mailbox the source of truth rather than a copy, and it is the difference
between one triage and two — but it also means the CRM's own "mark read" has to
write the IMAP flag, not just the column, or the mailbox converges it away within
fifteen minutes. The mirror is bounded twice (a recent-UID window and a cadence)
so it can never become a full-mailbox scan every five minutes.

If ticketing wins, that write path should go with the inbox rather than linger as
an unused capability pointed at customers' mailboxes.

## One thing the audit changed, worth knowing

The connector's stated promise was that it contains no delete. That was true of
its own source and **false at the wire**: `messageMove()` silently emulates a move
on any server that does not advertise RFC 6851 MOVE, as copy-then-flag-deleted-
then-expunge, with the delete running even when the copy failed. Gmail and
Microsoft 365 both advertise MOVE, so the trial's own mailboxes were never
exposed — but the "Other IMAP host" option is, and this module already expects
such servers. Archiving now refuses outright when the capability is absent.

The general lesson, since it will outlive this trial: **"our code contains no
delete" is a claim about our source, not about what reaches the server.** Wherever
a library sits between the two, the guarantee has to be re-established at the
boundary.

## Known bounds, stated rather than discovered later

- **Mail is web-only.** The staff phone app reads the ticket queue, so while an
  account is on Mail its correspondence does not appear there at all. The move
  control in Settings says so.
- **Un-archive does not reach the mailbox.** There is no move-out-of-Archive, so
  bringing a conversation back in the CRM leaves the message archived in Gmail.
- **Long conversations archive partially.** At most five messages move per click,
  newest first; nothing converges archive state, so the remainder stays in the
  real inbox and the notice names it as work to finish in the mail app.
