# ENVELOPE-ONE.1 — one envelope builder, not one-and-a-half

**Date:** 2026-08-12
**Follows:** [EMAIL-PARTICIPANTS](2026-08-12-email-thread-participants-design.md) (.8 in particular), EMAIL-CC.1
**Scope:** `src/lib/ticket-display.js`, `src/components/tickets/TicketThread.jsx`, their tests, and four comments that name the renamed symbol.

## The problem

EMAIL-PARTICIPANTS.8 (`d8a5456e`) replaced `TicketThread.jsx`'s always-open `RecipientLines` with a
collapsible `MessageEnvelope`. To do it, it added a second builder — `envelopeLines()` — inside the
component, which constructs its own From and To lines, calls `messageRecipients()` for the rest, and
throws away that helper's To:

```js
for (const line of messageRecipients(message)) {
  if (line.key !== 'to') out.push(line)
}
```

`TicketThread.jsx` is the only production consumer of `messageRecipients()`. So the helper's
conditional To branch — "only when `to.length > 1`, because a single To is already stated by the
bubble's own *Sent to …* line" — is dead. Nothing renders it. It is still tested, and two of those
tests assert precisely the behaviour no longer reachable, which is worse than untested: they read as
a live contract.

The result is one-and-a-half builders. A message's envelope is assembled half in a pure, tested lib
and half in JSX.

### Why that half matters more than it looks

`src/lib/email-recipients.js` and its test record an invariant with a name and a scar
(EMAIL-PARTICIPANTS.12): **four readers of the same `to_emails` field must agree** about the legacy
fallback, and they must filter the array *before* asking whether it has anything in it, so a row
carrying `to_emails: [null]` takes the scalar `to_email` rather than counting a hole as an address.
The comment is explicit that four readers disagreeing about one row is the defect, whatever writes
it today.

One of those four readers is `envelopeLines()`, sitting in a `.jsx` file that
`src/lib/ticket-display.test.js` cannot reach. The invariant is asserted for the other three.

## Decision

**Move From and To into the helper.** One builder, in the lib.

The alternative considered was narrowing `messageRecipients()` to the Cc/Bcc lines it is actually
consumed for and renaming it to match. That is a smaller diff and it does make the name honest, but
it settles for the split: the To fallback stays in JSX as an untested fourth reader, and the
component keeps assembling an envelope it should only be rendering. `ticket-display.js`'s own header
says why the file exists — *these are the decisions that get quietly wrong in a component and are
then invisible until an operator is looking at the wrong thing.* The To fallback is one of those.

## Design

### `messageEnvelope(message)` — `src/lib/ticket-display.js`

Replaces `messageRecipients()`. Same line shape, whole envelope, header order:

```
{ key: 'from', label: 'From', addresses: [...], staffOnly: false }
{ key: 'to',   label: 'To',   addresses: [...], staffOnly: false }
{ key: 'cc',   label: 'Cc',   addresses: [...], staffOnly: false }
{ key: 'bcc',  label: 'Bcc',  addresses: [...], staffOnly: true, note: '…' }
```

- **To is unconditional.** The `to.length > 1` gate is deleted, not relocated. EMAIL-PARTICIPANTS.8
  already established that omitting a single To is how a reply from a different person at the same
  organisation renders identically to one from the requester — that is how a thread moved to
  somebody nobody noticed. An envelope that sometimes omits the To is not an envelope.
- **Empty lists stay omitted.** "Cc:" with nothing after it reads as a Cc that failed. A message with
  no `from_email` and no To yields `[]`, and the component renders nothing.
- **The legacy scalar fallback moves here**, filtering before the emptiness test, joining the other
  three readers of that field under test.
- **Bcc keeps `staffOnly` and its note verbatim.** The sentence
  `'Only staff on this ticket can see this — no recipient of the email could.'` has exactly one home
  and this is it.
- Null-safe: `messageEnvelope(null)` is `[]`.

### `MessageEnvelope` — `src/components/tickets/TicketThread.jsx`

`envelopeLines()` is deleted. The component calls `messageEnvelope(message)` and keeps only what a
component should own: the `staffOnly` split (collapsible vs always-on), the two colour sets for the
accent bubble, the toggle and its per-message accessible name.

The prose splits on the same seam. *Why the envelope contains what it contains* — including the
unconditional To and the reason the old gate was wrong — moves to the lib. *Why it is collapsed by
default, and why Bcc escapes the toggle* stays in the component. Moved, not copied.

### Tests — `src/lib/ticket-display.test.js`

The `messageRecipients` block becomes `messageEnvelope`. Two tests invert, because the behaviour they
assert is the dead one:

| Was | Becomes |
|---|---|
| omits a single To | renders a single To (with the EMAIL-PARTICIPANTS.8 reason) |
| scalar `to_email` yields `[]` | scalar `to_email` yields a To line |

Retained: multi-address To, Cc, Bcc `staffOnly` + note wording, empty lists omitted, null message.

Added — coverage the old shape could not have had:

- the From line
- header order is From, To, Cc, Bcc
- **`to_emails: [null]` takes the scalar fallback** — the EMAIL-PARTICIPANTS.12 invariant, now
  assertable for this reader because it left the JSX. This test is the reason the option was chosen.

### Comment references

Four sites name the old symbol and are updated. Two of them are also wrong about where it lives
today — they say `src/lib/email-tickets.js's messageRecipients`, but it is and always was in
`src/lib/ticket-display.js`:

- `src/lib/email-recipients.js` (~261) — the four-readers comment
- `src/lib/email-recipients.test.js` (~471) — same, in the test
- `src/lib/email-tickets.js` (~126) — correct file, renamed symbol
- `src/lib/email-tickets.test.js` (~274) — same

The count stays four readers. One of them gets a new name and a correct address.

## Out of scope

**Mobile is untouched.** `mobile/lib/email-tickets.js`'s `ticketMessageRecipients()` is a deliberate
re-statement across the `shared/` seam (mobile cannot import `src/lib`), it is still consumed by
`mobile/app/email/[ticketId].jsx`, and its conditional To remains correct there: that screen kept
EMAIL-CC.1's always-open lines and its bubble still carries the "Sent to …" line the gate refers to.
Its Bcc wording is its own and stays its own.

Worth recording rather than fixing: mobile therefore still has the EMAIL-PARTICIPANTS.8 defect — no
From line, and a single To suppressed — so a reply from a new address at the same organisation looks
the same as one from the requester. That is a mobile change, needs device QA, and is not this task.

## Verification

Repo CI mirror, in order: `npm test`, `npm run lint`, `npm run check:guardrails`, `npm run build`.
No migration. No API change. No behaviour change on any surface other than the web thread's envelope,
where a single-recipient To and a From now appear behind the existing Details toggle.
