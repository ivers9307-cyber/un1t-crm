# ENVELOPE-ONE.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `messageRecipients()` with `messageEnvelope()` — one builder that returns a message's whole envelope (From, To, Cc, Bcc) — and delete `envelopeLines()` from `TicketThread.jsx`, so the `to_emails` legacy fallback lives in a tested lib rather than in JSX.

**Architecture:** `src/lib/ticket-display.js` gains `messageEnvelope(message)`, returning the same `{ key, label, addresses, staffOnly, note? }` line shape as before but with From and an *unconditional* To prepended. `TicketThread.jsx`'s `MessageEnvelope` component drops its private `envelopeLines()` helper and calls the lib directly, keeping only the `staffOnly` render split. No migration, no API change, no new dependency.

**Tech Stack:** Next.js 16, React, vitest, ESLint (plus the repo's separate guardrails config).

**Spec:** `docs/superpowers/specs/2026-08-12-message-envelope-one-builder-design.md`

---

## File Structure

| File | Responsibility after this change |
|---|---|
| `src/lib/ticket-display.js` | **Modify.** Owns the whole envelope: From, To (unconditional), Cc, Bcc, the legacy `to_email` fallback, and the Bcc `staffOnly` flag + note sentence. |
| `src/components/tickets/TicketThread.jsx` | **Modify.** Renders only. Owns the collapsed/always-on split on `staffOnly`, the accent colour sets, and the toggle's accessible name. No line construction. |
| `src/lib/ticket-display.test.js` | **Modify.** The `messageRecipients` describe block becomes `messageEnvelope`; two tests invert; three added. |
| `src/lib/email-recipients.js`, `src/lib/email-recipients.test.js`, `src/lib/email-tickets.js`, `src/lib/email-tickets.test.js` | **Modify (comments only).** Four references to the renamed symbol; two also name the wrong file. |

**Untouched:** everything under `mobile/`. `ticketMessageRecipients()` is a deliberate re-statement across the `shared/` seam, still consumed, and its conditional To is still correct on that screen.

---

### Task 1: Invert and extend the tests

**Files:**
- Test: `src/lib/ticket-display.test.js:290-326` (the whole `describe('messageRecipients', …)` block)

- [ ] **Step 1: Replace the describe block with the failing tests**

Replace lines 290-326 (the `// ── EMAIL-CC.1 …` comment through the closing `})` of the block) with:

```js
// ── The message envelope (EMAIL-CC.1 → ENVELOPE-ONE.1) ───────────────
describe('messageEnvelope', () => {
  it('leads with From — the line that says who actually sent it', () => {
    const [line] = messageEnvelope({ from_email: 'ada@example.com' })
    expect(line).toMatchObject({ key: 'from', label: 'From', staffOnly: false })
    expect(line.addresses).toEqual(['ada@example.com'])
  })

  // INVERTED BY ENVELOPE-ONE.1. This used to assert the opposite — a lone To
  // was dropped because the bubble's own "Sent to …" line already said it.
  // EMAIL-PARTICIPANTS.8 is why that was wrong: with no From and no
  // single-recipient To to read, a reply from a different person at the same
  // organisation looks identical to one from the requester.
  it('renders a single To — an envelope that sometimes omits it is not one', () => {
    const [line] = messageEnvelope({ to_emails: ['ada@example.com'] })
    expect(line).toMatchObject({ key: 'to', label: 'To', staffOnly: false })
    expect(line.addresses).toEqual(['ada@example.com'])
  })

  it('renders every address on a multi-party To', () => {
    const [line] = messageEnvelope({ to_emails: ['ada@example.com', 'bob@example.com'] })
    expect(line.addresses).toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('shows Cc, which every recipient of the email could see', () => {
    const lines = messageEnvelope({ to_emails: ['ada@x.com'], cc_emails: ['bob@x.com'] })
    expect(lines.map(l => l.key)).toEqual(['to', 'cc'])
    expect(lines[1]).toMatchObject({ key: 'cc', staffOnly: false })
  })

  // BCC MUST BE MARKED. Rendered beside To and Cc with no distinction it
  // implies the other recipients saw it. They did not, and never will.
  it('marks Bcc staffOnly and explains why', () => {
    const lines = messageEnvelope({ to_emails: ['a@x.com'], bcc_emails: ['secret@x.com'] })
    const line = lines.find(l => l.key === 'bcc')
    expect(line).toMatchObject({ key: 'bcc', staffOnly: true })
    expect(line.note).toMatch(/only staff/i)
  })

  it('puts the lines in header order', () => {
    const lines = messageEnvelope({
      from_email: 'ada@x.com',
      to_emails: ['bob@x.com'],
      cc_emails: ['cara@x.com'],
      bcc_emails: ['dan@x.com'],
    })
    expect(lines.map(l => l.key)).toEqual(['from', 'to', 'cc', 'bcc'])
  })

  // INVERTED BY ENVELOPE-ONE.1: this used to expect [] for a lone scalar To.
  it('reads the scalar to_email on a row written before mig 499', () => {
    const [line] = messageEnvelope({ to_email: 'ada@x.com' })
    expect(line).toMatchObject({ key: 'to' })
    expect(line.addresses).toEqual(['ada@x.com'])
  })

  // EMAIL-PARTICIPANTS.12 — a NON-EMPTY array of nothing is still nothing.
  // Four readers of to_emails must agree about this row, and this one could
  // not be asserted while it lived in TicketThread.jsx.
  it('takes the scalar fallback for a to_emails array holding nothing usable', () => {
    const [line] = messageEnvelope({ to_emails: [null], to_email: 'ada@x.com' })
    expect(line.addresses).toEqual(['ada@x.com'])
  })

  it('omits empty lists rather than rendering a blank Cc', () => {
    expect(messageEnvelope({ to_emails: ['a@x.com'], cc_emails: [], bcc_emails: [] }))
      .toEqual([{ key: 'to', label: 'To', addresses: ['a@x.com'], staffOnly: false }])
  })

  it('is empty when there is no envelope to show', () => {
    expect(messageEnvelope({})).toEqual([])
    expect(messageEnvelope(null)).toEqual([])
  })
})
```

Then update the import at `src/lib/ticket-display.test.js:18`: change `messageRecipients,` to `messageEnvelope,`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/ticket-display.test.js`
Expected: FAIL — `messageEnvelope is not a function` on every test in the new block. The rest of the file still passes.

- [ ] **Step 3: Do not commit yet**

The tree does not build. Task 2 makes it green.

---

### Task 2: Replace `messageRecipients()` with `messageEnvelope()`

**Files:**
- Modify: `src/lib/ticket-display.js:246-287`

- [ ] **Step 1: Replace the docblock and function**

Replace lines 246-287 in full:

```js
/**
 * A message's envelope, in header order: From, To, Cc, Bcc.
 *
 * THE To IS UNCONDITIONAL, and that is a correction. EMAIL-CC.1 rendered it
 * only when it had more than one address, on the reasoning that a single To
 * was already stated by the bubble's own "Sent to …" line. That reasoning
 * held right up until the address on the far end CHANGED: with no From and no
 * single-recipient To to read, a reply arriving from a different person at the
 * same organisation looked identical to one from the requester. That is how a
 * thread moved to somebody nobody noticed (EMAIL-PARTICIPANTS.8). An envelope
 * that sometimes omits the To is not an envelope.
 *
 * BCC IS MARKED `staffOnly` AND MUST BE RENDERED AS SUCH. The list is real —
 * the sender is staff on this ticket and seeing who they blind-copied is the
 * point of recording it — but it never went on the delivered message, so a
 * surface that shows it beside To and Cc with no distinction implies the other
 * recipients saw it. They did not, and never will. The sentence saying so is
 * attached here and nowhere else, so it cannot drift between renderers.
 *
 * Empty lists are omitted rather than rendered blank: "Cc:" with nothing after
 * it reads as a Cc that failed. A message with neither a From nor a To yields
 * nothing at all, and the caller renders no envelope.
 *
 * `to_emails` IS FILTERED BEFORE IT IS MEASURED. A row carrying `to_emails:
 * [null]` has no addresses, so it must fall back to the scalar rather than
 * count a hole — the same rule ticketParticipants() and mobile's
 * ticketMessageRecipients() follow. Readers of this field disagreeing about
 * one row is the defect (EMAIL-PARTICIPANTS.12), whatever writes it today.
 *
 * @param {object|null} message
 * @returns {{ key: string, label: string, addresses: string[], staffOnly: boolean, note?: string }[]}
 */
export function messageEnvelope(message) {
  if (!message) return []
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  // Pre-EMAIL-CC.1 rows carry only the scalar to_email.
  const to = list(message.to_emails).length
    ? list(message.to_emails)
    : (message.to_email ? [message.to_email] : [])

  const out = []
  if (message.from_email) {
    out.push({ key: 'from', label: 'From', addresses: [message.from_email], staffOnly: false })
  }
  if (to.length) out.push({ key: 'to', label: 'To', addresses: to, staffOnly: false })
  const cc = list(message.cc_emails)
  if (cc.length) out.push({ key: 'cc', label: 'Cc', addresses: cc, staffOnly: false })
  const bcc = list(message.bcc_emails)
  if (bcc.length) {
    out.push({
      key: 'bcc',
      label: 'Bcc',
      addresses: bcc,
      staffOnly: true,
      note: 'Only staff on this ticket can see this — no recipient of the email could.',
    })
  }
  return out
}
```

Also update the section banner at `src/lib/ticket-display.js:222`: change
`// ── Recipients (EMAIL-CC.1) ──────────────────────────────────────────`
to
`// ── Recipients and the envelope (EMAIL-CC.1, ENVELOPE-ONE.1) ─────────`

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ticket-display.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 3: Do not commit yet**

`TicketThread.jsx` still imports `messageRecipients` and the build would fail. Task 3 closes it.

---

### Task 3: Delete `envelopeLines()` from the component

**Files:**
- Modify: `src/components/tickets/TicketThread.jsx:75` (import), `:818-843` (the helper), `:869-871` + `:880` (the docblock line and the call)

- [ ] **Step 1: Update the import**

At `src/components/tickets/TicketThread.jsx:75`, change `messageRecipients,` to `messageEnvelope,`.

- [ ] **Step 2: Delete the `envelopeLines` helper**

Remove lines 818-843 entirely — the docblock beginning `/**\n * The envelope lines for one message, in header order: From, To, then whatever` through the closing `}` of `function envelopeLines(message) { … }`. Nothing replaces it.

- [ ] **Step 3: Point the component at the lib**

In `MessageEnvelope`, change:

```js
  const lines = envelopeLines(message)
```

to:

```js
  const lines = messageEnvelope(message)
```

- [ ] **Step 4: Update the component docblock**

Inside `MessageEnvelope`'s docblock, the paragraph beginning `What was here before showed a Cc list, and a To only when it had more than one address` explains why the To is unconditional. That reasoning now lives on `messageEnvelope()` in the lib. Replace that paragraph with a pointer, so it is stated once:

```
 * The lines themselves come from messageEnvelope() (src/lib/ticket-display.js),
 * which is where the rules about what an envelope contains live — including
 * why the To is unconditional, and the sentence attached to a Bcc. This
 * component decides only how they are shown.
```

Leave the rest of the docblock as it is: the *collapsed by default* paragraph, the *BCC IS THE EXCEPTION* paragraph, and the `staffOnly`-not-`'bcc'` paragraph are all about rendering and belong here. In the last of those, change `which messageRecipients() already sets` to `which messageEnvelope() already sets`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — 936 files, 13814 tests, 0 failures (the count is unchanged; the envelope block gained tests and `describe` names changed, so a small increase in the test total is expected and fine).

- [ ] **Step 6: Commit**

```bash
git add src/lib/ticket-display.js src/lib/ticket-display.test.js src/components/tickets/TicketThread.jsx
git commit -m "ENVELOPE-ONE.1 — one envelope builder, not one-and-a-half"
```

---

### Task 4: Fix the four comments that name the old symbol

**Files:**
- Modify: `src/lib/email-recipients.js:261`, `src/lib/email-recipients.test.js:471`, `src/lib/email-tickets.js:126`, `src/lib/email-tickets.test.js:274`

Two of these also name the wrong file: `messageRecipients` was never in `src/lib/email-tickets.js`.

- [ ] **Step 1: `src/lib/email-recipients.js`**

In the `toAddresses` comment, change:

```
  // counting a hole as an address — which is what the three renderers of the
  // same field (envelopeLines, messageRecipients, ticketMessageRecipients)
  // already do, and four readers disagreeing about one row is a defect
```

to:

```
  // counting a hole as an address — which is what the other readers of the
  // same field (messageEnvelope in src/lib/ticket-display.js, and mobile's
  // ticketMessageRecipients) already do, and readers disagreeing about one
  // row is a defect
```

- [ ] **Step 2: `src/lib/email-recipients.test.js`**

Change:

```
  // The three places that render a message's To (TicketThread's envelopeLines,
  // src/lib/email-tickets.js's messageRecipients, mobile's
  // ticketMessageRecipients) all filter the array before asking whether it has
  // anything in it, so `to_emails: [null]` takes the scalar fallback there.
  // This one asked `.length` of the raw array, took the [null] branch, and
  // dropped the address the other three show. No current writer produces the
  // shape; four readers disagreeing about the same row is the defect.
```

to:

```
  // The other places that render a message's To (messageEnvelope in
  // src/lib/ticket-display.js, mobile's ticketMessageRecipients) filter the
  // array before asking whether it has anything in it, so `to_emails: [null]`
  // takes the scalar fallback there. This one asked `.length` of the raw
  // array, took the [null] branch, and dropped the address the others show.
  // No current writer produces the shape; readers disagreeing about the same
  // row is the defect.
```

- [ ] **Step 3: `src/lib/email-tickets.js`**

Change:

```
    // The legacy scalar fallback, mirroring messageRecipients() and
    // envelopeLines() (src/lib/ticket-display.js, TicketThread.jsx). Migrations
```

to:

```
    // The legacy scalar fallback, mirroring messageEnvelope()
    // (src/lib/ticket-display.js). Migrations
```

- [ ] **Step 4: `src/lib/email-tickets.test.js`**

Change:

```
      // A pre-EMAIL-CC.1 row: only the scalar. envelopeLines() and
      // messageRecipients() both read it, and this must agree with them.
```

to:

```
      // A pre-EMAIL-CC.1 row: only the scalar. messageEnvelope() reads it too,
      // and this must agree with it.
```

- [ ] **Step 5: Verify no reference to the old names survives**

Run: `grep -rn "messageRecipients\|envelopeLines" --include='*.js' --include='*.jsx' src/ shared/`
Expected: no output. (`mobile/` legitimately still mentions `messageRecipients` in `mobile/lib/email-tickets.js`'s header, describing the web equivalent it re-states — see Step 6.)

- [ ] **Step 6: Update the one mobile comment that names the web symbol**

`mobile/lib/email-tickets.js:139` reads `A re-statement of src/lib/ticket-display.js's messageRecipients`. The file and the sentence are correct; only the symbol name changed. Change `messageRecipients` to `messageEnvelope` in that one line and change nothing else in `mobile/`. Its `ticketMessageRecipients()` keeps its conditional To and its own Bcc wording.

- [ ] **Step 7: Commit**

```bash
git add src/lib/email-recipients.js src/lib/email-recipients.test.js src/lib/email-tickets.js src/lib/email-tickets.test.js mobile/lib/email-tickets.js
git commit -m "ENVELOPE-ONE.1 — point the four to_emails-reader comments at the renamed builder"
```

---

### Task 5: Repo CI mirror

**Files:** none

- [ ] **Step 1: Tests**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean exit. A `no-unused-vars` on a leftover import from Task 3 is the likely failure here; fix it if it appears.

- [ ] **Step 3: Guardrails**

Run: `npm run check:guardrails`
Expected: clean exit.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build completes.

- [ ] **Step 5: Confirm the rendered result changed as intended**

Read `MessageEnvelope` once more and confirm: `collapsible` now contains From, To and Cc; `alwaysOn` contains only Bcc; the note renders on the Bcc line and nowhere else.

---

## Self-Review

**Spec coverage.** `messageEnvelope` with unconditional To → Task 2. Legacy fallback moved into the lib → Task 2 Step 1. Bcc flag + note kept, one home → Task 2 Step 1 (the only literal in the tree). `envelopeLines()` deleted → Task 3. Prose moved not copied → Task 2 Step 1 and Task 3 Step 4. Two inverted tests → Task 1. Added tests (From, header order, `[null]` fallback) → Task 1. Four comment references → Task 4. Mobile untouched apart from one symbol name in a comment about the web file → Task 4 Step 6, and stated in File Structure. CI mirror → Task 5.

**Placeholder scan.** No TBD/TODO. Every code step carries the code. Task 4 shows both sides of each comment edit rather than saying "update the references".

**Type consistency.** `messageEnvelope(message)` is the name in Tasks 1, 2, 3, 4 and in both files' comments. The line shape `{ key, label, addresses, staffOnly, note? }` is identical to what `messageRecipients()` returned, so `MessageEnvelope`'s `renderLine`, its `staffOnly` filters and its `line.note` branch need no change — only the call site does.
