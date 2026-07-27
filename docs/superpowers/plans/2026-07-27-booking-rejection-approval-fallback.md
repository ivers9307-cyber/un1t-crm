# Booking Rejection → Approval Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mia never claims a Glofox booking succeeded when it didn't; account-shaped rejections become pending approvals with a human summary and the customer is told a human will resolve it.

**Architecture:** One new pure interpreter (`interpretBookingResult` in `src/lib/glofox.js`) becomes the single source of truth for booking success, consumed by all three booking call-sites (agent tool, approval execution, /start funnel processor). The agent tool's auto path gains an approval-fallback branch reusing the existing `agent_membership_requests` pending-row machinery. Customer copy is a new operator-editable setting.

**Tech Stack:** Next.js 16 App Router, supabase-js (service role), Vitest (mocked DB/Glofox), Zod.

**Spec:** `docs/superpowers/specs/2026-07-27-booking-rejection-approval-fallback-design.md`
**Spec deviation (deliberate):** a superseded duplicate finalises as `failed` + `details.reason='superseded_duplicate'` (not `declined` — `declined` implies a human decision).

---

### Task 1: `interpretBookingResult` in glofox.js

**Files:**
- Modify: `src/lib/glofox.js` (after `createBooking`, ~line 1031)
- Test: `src/lib/glofox.test.js` (append)

- [x] **Step 1: Write the failing tests** (append to `src/lib/glofox.test.js`)

```js
describe('interpretBookingResult (MIA-BOOK.1)', () => {
  const call = (over) => interpretBookingResult({ ok: true, status: 200, body: {}, ...over })
  it('2xx with a booking id is a success (all harvest shapes)', () => {
    expect(call({ body: { id: 'b1' } })).toMatchObject({ success: true, bookingId: 'b1' })
    expect(call({ body: { _id: 'b2' } }).bookingId).toBe('b2')
    expect(call({ body: { booking_id: 'b3' } }).bookingId).toBe('b3')
    expect(call({ body: { data: { id: 'b4' } } }).bookingId).toBe('b4')
  })
  it('a clean 2xx with no code and no id still succeeds', () => {
    expect(call({ body: {} })).toMatchObject({ success: true, bookingId: null, messageCode: null })
    expect(call({ body: null })).toMatchObject({ success: true })
  })
  it('the live-observed 200 + YOU_HAVE_NO_CREDITS_LEFT shape is a FAILURE', () => {
    expect(call({ body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } }))
      .toMatchObject({ success: false, messageCode: 'YOU_HAVE_NO_CREDITS_LEFT' })
  })
  it('an unknown code on a 2xx without a booking id fails safe', () => {
    expect(call({ body: { message_code: 'SOME_NEW_CODE' } }).success).toBe(false)
  })
  it('a code accompanied by a booking id stays a success', () => {
    expect(call({ body: { message_code: 'ANYTHING', id: 'b1' } }).success).toBe(true)
  })
  it('already-booked is a success even on a non-2xx', () => {
    expect(call({ ok: false, status: 422, body: { message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } }))
      .toMatchObject({ success: true, alreadyBooked: true })
  })
  it('non-2xx / network shapes are failures', () => {
    expect(call({ ok: false, status: 500, body: { error: 'boom' } }).success).toBe(false)
    expect(interpretBookingResult({ ok: false, status: 0, body: { error: 'network error' } }).success).toBe(false)
    expect(interpretBookingResult(null).success).toBe(false)
  })
})
```

Add `interpretBookingResult` to the existing import from `'./glofox'` at the top of the test file.

- [x] **Step 2: Run to verify failure** — `npx vitest run src/lib/glofox.test.js` → FAIL (`interpretBookingResult` not exported).

- [x] **Step 3: Implement** (in `src/lib/glofox.js` directly after `createBooking`)

```js
export const GLOFOX_ALREADY_BOOKED_CODE = 'YOU_HAVE_BOOKED_FOR_THIS_EVENT'

/**
 * MIA-BOOK.1 — single source of truth for "did /2.0/bookings actually book?".
 * Glofox reports failures IN-BODY with an HTTP 200 (live-observed 2026-07-27:
 * 200 + YOU_HAVE_NO_CREDITS_LEFT booked nothing), so HTTP ok alone lies.
 * Rules: already-booked = success (Glofox dedupes member+event server-side);
 * non-2xx = failure; a clean 2xx (no message code) = success even without a
 * harvestable id (some success shapes carry none); a 2xx WITH a message code
 * only succeeds when a booking id came back too — otherwise it's the
 * 200-with-error shape, and unknown codes deliberately fail safe (a spurious
 * approval card beats another customer told a lie).
 * @param {{ok:boolean,status:number,body:any}|null} result createBooking's return
 * @returns {{success:boolean,bookingId:string|null,messageCode:string|null,alreadyBooked:boolean}}
 */
export function interpretBookingResult(result) {
  const body = result?.body || {}
  const messageCode = body.message_code || body.message || null
  const alreadyBooked = messageCode === GLOFOX_ALREADY_BOOKED_CODE
  const bookingId = body.id || body._id || body.booking_id || body.data?.id || null
  const success = alreadyBooked || (!!result?.ok && (!messageCode || !!bookingId))
  return { success, bookingId, messageCode, alreadyBooked }
}
```

- [x] **Step 4: Run to verify pass** — `npx vitest run src/lib/glofox.test.js` → PASS.
- [x] **Step 5: Commit** — `git add src/lib/glofox.js src/lib/glofox.test.js && git commit -m "MIA-BOOK.1 — interpretBookingResult: in-body Glofox failures are failures"`

---

### Task 2: Operator-editable handoff copy

**Files:**
- Modify: `src/lib/agent/notify.js` (constants block, ~line 22)
- Modify: `src/app/api/settings/customer-agent/route.js` (DEFAULTS ~24, schema ~62, persist ~187)
- Modify: `src/app/settings/customer-agent/page.js` (state init ~67, field block ~355)
- Test: `src/app/api/settings/customer-agent/route.test.js` (extend round-trip)

- [x] **Step 1: Add the default** to `notify.js` after `DEFAULT_CANCELLATION_CONFIRMATION_TEXT`:

```js
// MIA-BOOK.1 — what Mia tells the customer when Glofox rejects a booking for
// an account-shaped reason and the attempt becomes a pending approval.
// Operator-editable (settings.customer_agent.booking_issue_handoff_text).
export const DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT =
  "There seems to be an issue with your account, so I'm handing this over to the team to sort it out. You'll hear from them shortly once it's resolved."
```

- [x] **Step 2: Settings route** — in DEFAULTS after `cancellation_confirmation_text: null,` add `booking_issue_handoff_text: null,`; in `SettingsSchema` after the cancellation line add `booking_issue_handoff_text: z.string().max(500).nullable().optional(),`; in the persist block after the cancellation line add `booking_issue_handoff_text: v.data.booking_issue_handoff_text?.trim() || null,`.

- [x] **Step 3: Settings page** — in the state init after `cancellation_confirmation_text` add `booking_issue_handoff_text: settings.booking_issue_handoff_text || null,`; after the cancellation-confirmation field block add:

```jsx
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Booking issue handoff message</label>
          <input className={inputCls} maxLength={500} value={settings.booking_issue_handoff_text || ''}
            onChange={e => setField('booking_issue_handoff_text', e.target.value)}
            placeholder="There seems to be an issue with your account, so I'm handing this over to the team to sort it out. You'll hear from them shortly once it's resolved." />
          <p className="text-xs text-un1t-muted mt-1">What the agent tells the customer when the booking system rejects a booking (for example no credits left) and the request is sent to the team to fix. Leave blank to use the default shown.</p>
        </div>
```

- [x] **Step 4: Extend route test** round-trip (mirror how `booking_confirmation_text` is asserted) and run `npx vitest run src/app/api/settings/customer-agent/route.test.js` → PASS.
- [x] **Step 5: Commit** — `"MIA-BOOK.1 — operator-editable booking_issue_handoff_text"`

---

### Task 3: booking-tools auto-path approval fallback

**Files:**
- Modify: `src/lib/agent/booking-tools.js` (imports ~27, `logBookingRequest` ~379, new helpers after `finalizeBookingRequest` ~416, `book_class` executor 483–501)
- Test: `src/lib/agent/booking-tools-audit.test.js` (extend mock + new describe), `src/lib/agent/booking-tools.test.js` (pure `bookingRejectionRoute`)

- [x] **Step 1: Failing tests.** In `booking-tools-audit.test.js`: add `interpretBookingResult` + `GLOFOX_ALREADY_BOOKED_CODE` to the `vi.mock('@/lib/glofox', …)` factory via `const actual = await importOriginal()` spread (mock becomes `vi.mock('@/lib/glofox', async (importOriginal) => ({ ...(await importOriginal()), glofoxCredentialsForLocation: vi.fn(), … }))` keeping existing overrides); add `contains: () => b` to the mock builder. New tests:

```js
describe('MIA-BOOK.1 — in-body Glofox rejections', () => {
  it('a 200 + YOU_HAVE_NO_CREDITS_LEFT finalises the row PENDING (approval fallback), never booked:true', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID, class_name: 'SQUAD' }, ctx(trace))
    expect(res.booked).not.toBe(true)
    expect(res.requested).toBe(true)
    expect(res.message).toContain('handing this over to the team')
    expect(trace.map(t => t.step)).toEqual(['audit_insert', 'audit_update'])
    expect(trace[1]).toMatchObject({ status: 'pending' })
  })
  it('honours the operator handoff copy override', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const c = ctx(trace)
    c.settings = { booking_mode: 'auto', booking_issue_handoff_text: 'Account hiccup, the crew will ping you.' }
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, c)
    expect(res.message).toContain('Account hiccup, the crew will ping you.')
  })
  it('EVENT_HAS_BEEN_CANCELLED stays an honest in-chat failure (no approval)', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'EVENT_HAS_BEEN_CANCELLED' } })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))
    expect(res).toMatchObject({ booked: false, reason: 'EVENT_HAS_BEEN_CANCELLED' })
    expect(res.requested).toBeUndefined()
    expect(trace[1]).toMatchObject({ status: 'failed' })
  })
  it('already-booked reads as success', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_BOOKED_FOR_THIS_EVENT' } })
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))
    expect(res.booked).toBe(true)
    expect(trace[1]).toMatchObject({ status: 'actioned' })
  })
  it('a success stores the glofox booking id on the audit row', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { id: 'gfb-1' } })
    await executeBookingTool('book_class', { event_id: EVENT_ID }, ctx(trace))
    expect(trace[1]).toMatchObject({ status: 'actioned' })
  })
  it('a second rejection for the same contact+event supersedes instead of double-carding', async () => {
    const trace = []
    glofox.createBooking.mockResolvedValue({ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } })
    const db = auditDb(trace)
    const c = { ...ctx(trace), db }
    // the dedup lookup resolves one existing pending row with a different id
    db.pendingLookupRows = [{ id: 'req-existing' }]
    const res = await executeBookingTool('book_class', { event_id: EVENT_ID }, c)
    expect(res.requested).toBe(true)            // customer experience identical
    expect(trace[1]).toMatchObject({ status: 'failed' })  // no second pending card
  })
})
```

Extend `auditDb`'s builder: `contains: () => b`, and make its `then(resolve)` resolve `{ data: db.pendingLookupRows || null, error: null }` when the chain was a select on `agent_membership_requests` (simplest: track `mode = 'select'|'insert'|'update'` on the chain; `select()` sets it, `then` returns `pendingLookupRows` for selects).
In `booking-tools.test.js` add:

```js
describe('bookingRejectionRoute', () => {
  it('routes staff-fixable and unknown codes to approval, venue codes to reply', () => {
    expect(bookingRejectionRoute('YOU_HAVE_NO_CREDITS_LEFT')).toBe('approval')
    expect(bookingRejectionRoute('BRAND_NEW_CODE')).toBe('approval')
    expect(bookingRejectionRoute(null)).toBe('approval')
    expect(bookingRejectionRoute('EVENT_HAS_BEEN_CANCELLED')).toBe('reply')
  })
})
```

- [x] **Step 2: Run to verify failure** — `npx vitest run src/lib/agent/booking-tools-audit.test.js src/lib/agent/booking-tools.test.js` → FAIL.

- [x] **Step 3: Implement in `booking-tools.js`:**

(a) top import: `import { DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT } from './notify'`

(b) `logBookingRequest`: destructure `{ data, error }`, add `if (error) console.error(\`[agent][booking] audit insert failed: ${error.message}\`)` before the return.

(c) after `finalizeBookingRequest` add:

```js
// MIA-BOOK.1 — routing for a rejected booking. Codes staff cannot fix (the
// class itself is gone) stay in-chat as an honest reply + alternative;
// everything else — credits, membership, UNKNOWN codes — becomes a pending
// approval a human resolves (fail safe: a spurious card beats a false
// "you're booked"). Grow this set as real codes appear in
// agent_membership_requests.details.result.message_code.
const CUSTOMER_ANSWERABLE_CODES = new Set(['EVENT_HAS_BEEN_CANCELLED'])
export function bookingRejectionRoute(messageCode) {
  return CUSTOMER_ANSWERABLE_CODES.has(messageCode) ? 'reply' : 'approval'
}

// One pending approval per (contact, event): a retried tool call must not
// double-card staff. Best-effort — on lookup failure we'd rather risk a
// duplicate card than lose the fallback entirely.
async function pendingBookingApprovalId(db, ctx, eventId, excludeId) {
  try {
    const { data } = await db.from('agent_membership_requests')
      .select('id')
      .eq('contact_id', ctx.verifiedContactId || ctx.contactId)
      .eq('kind', 'class_booking')
      .eq('status', 'pending')
      .contains('details', { event_id: eventId })
      .limit(5)
    return (data || []).map((r) => r.id).find((id) => id && id !== excludeId) || null
  } catch { return null }
}
```

(d) replace the post-`createBooking` block (from `const messageCode =` through the final `return { booked: true … }`) with:

```js
    const { interpretBookingResult } = await import('@/lib/glofox')
    const outcome = interpretBookingResult(result)
    const resultDetails = {
      ok: outcome.success, status: result.status, message_code: outcome.messageCode,
      ...(outcome.bookingId ? { glofox_booking_id: outcome.bookingId } : {}),
    }
    if (outcome.success) {
      await finalizeBookingRequest(db, ctx, auditId, {
        kind: 'class_booking', status: 'actioned',
        details: { ...baseDetails, result: resultDetails },
      })
      return { booked: true, class_name: input.class_name || null, class_time: input.class_time || null }
    }
    if (bookingRejectionRoute(outcome.messageCode) === 'reply') {
      await finalizeBookingRequest(db, ctx, auditId, {
        kind: 'class_booking', status: 'failed',
        details: { ...baseDetails, result: resultDetails },
      })
      return {
        booked: false,
        reason: outcome.messageCode || 'BOOKING_FAILED',
        message: 'The booking did not go through — relay the reason honestly and offer an alternative or a handoff.',
      }
    }
    // MIA-BOOK.1 — account-shaped (or unknown) rejection: hand to a human.
    // The intent row becomes the approval card; approving re-runs the booking
    // after staff fix the account. Never tell the customer it's booked.
    const dupId = await pendingBookingApprovalId(db, ctx, input.event_id, auditId)
    const summary = `Glofox rejected this booking (${outcome.messageCode || `status_${result.status}`}). Fix the member's account (credits/membership), then Approve to retry the booking.`
    await finalizeBookingRequest(db, ctx, auditId, {
      kind: 'class_booking',
      status: dupId ? 'failed' : 'pending',
      details: {
        ...baseDetails,
        reason: dupId ? 'superseded_duplicate' : 'booking_rejected',
        ...(dupId ? { duplicate_of: dupId } : { summary }),
        result: resultDetails,
      },
    })
    const handoffText = String(settings?.booking_issue_handoff_text || '').trim() || DEFAULT_BOOKING_ISSUE_HANDOFF_TEXT
    return {
      requested: true,
      booked: false,
      reason: outcome.messageCode || 'BOOKING_FAILED',
      message: `There is an account issue the team has been asked to fix before this booking can go through. Tell the customer, staying close to this wording: "${handoffText}". Never say the booking is confirmed.`,
    }
```

- [x] **Step 4: Run** both test files → PASS (existing `{ ok: true, status: 200, body: {} }` success test must still pass).
- [x] **Step 5: Commit** — `"MIA-BOOK.1 — book_class: rejected bookings hand off to a pending approval"`

---

### Task 4: Approval-execution route adopts the interpreter

**Files:**
- Modify: `src/app/api/agent/membership-requests/[id]/route.js:225-258`

- [x] **Step 1:** Add `interpretBookingResult` to the dynamic glofox import; replace the result handling:

```js
      const result = await createBooking(creds, {
        user_id: contact.glofox_member_id,
        model: GLOFOX_BOOKING_MODEL,
        model_id: details.event_id,
      })
      const outcome = interpretBookingResult(result)
      executed = {
        ok: outcome.success, status: result.status, message_code: outcome.messageCode,
        ...(outcome.bookingId ? { glofox_booking_id: outcome.bookingId } : {}),
      }
      details = { ...details, result: executed }
      finalStatus = outcome.success ? 'actioned' : 'failed'

      // Close the loop with the customer in-thread — best-effort.
      if (outcome.success && row.conversation_id) {
```

- [x] **Step 2:** `npx vitest run src/lib/agent` (no route test exists; nearest suites green) + `npm run lint` on the file.
- [x] **Step 3: Commit** — `"MIA-BOOK.1 — approval execution: don't mark a rejected re-run actioned"`

---

### Task 5: /start funnel processor adopts the interpreter

**Files:**
- Modify: `src/lib/class-booking-processor.js:128-140` (+ import line 5)
- Test: `src/lib/class-booking-processor.test.js` (mock + one new case)

- [x] **Step 1: Failing test** — in the `vi.mock('@/lib/glofox', …)` factory add the real `interpretBookingResult` (switch factory to `async (importOriginal) => ({ ...(await importOriginal()), <existing overrides> })`). New case: `createBooking` resolves `{ ok: true, status: 200, body: { message_code: 'YOU_HAVE_NO_CREDITS_LEFT' } }` for a contact that passes the credit pre-gate → expect `routeToReview` outcome `needs_review` with `booking_failed:YOU_HAVE_NO_CREDITS_LEFT` (mirror the existing booking-failure case's assertions).
- [x] **Step 2:** Run → FAIL (currently returns `booked`).
- [x] **Step 3: Implement** — add `interpretBookingResult` to the import from `'@/lib/glofox'`; replace lines 128-140:

```js
  const result = await createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })
  // interpretBookingResult treats already-booked as success (a reaper re-run
  // whose first attempt booked but died before persisting) and catches
  // Glofox's 200-with-error shapes (MIA-BOOK.1).
  const outcome = interpretBookingResult(result)
  if (!outcome.success) {
    return routeToReview(db, request, `booking_failed:${outcome.messageCode || `status_${result?.status}`}`)
  }
  await setStatus(db, request.id, { status: 'booked', last_error: null, glofox_booking_id: outcome.bookingId })
```

- [x] **Step 4:** `npx vitest run src/lib/class-booking-processor.test.js` → PASS.
- [x] **Step 5: Commit** — `"MIA-BOOK.1 — funnel processor: same in-body rejection truth"`

---

### Task 6: Prompt nudge

**Files:**
- Modify: `src/lib/agent/prompt.js` (the "Relay the result honestly" bullet, ~line 92)

- [x] **Step 1:** Extend the bullet: after "say exactly that and never claim it's booked;" insert "if it reports an account issue the team has been asked to fix, tell the customer that in the tool's suggested wording and never claim it's booked;". Run `npx vitest run src/lib/agent/prompt.test.js` → PASS.
- [x] **Step 2: Commit** — `"MIA-BOOK.1 — prompt: relay account-issue handoffs honestly"`

---

### Task 7: CI mirror, changelog, PR

- [x] **Step 1:** `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails` → all green (no new route/page/import beyond existing patterns, but run the full mirror anyway).
- [x] **Step 2:** `npm run build` (imports changed in `glofox.js`/`booking-tools.js`/`notify.js`).
- [x] **Step 3:** `docs/CHANGELOG.md` entry (MIA-BOOK.1, cite the incident + migless).
- [x] **Step 4:** Push branch, `gh pr create --base main --fill`, report URL.
