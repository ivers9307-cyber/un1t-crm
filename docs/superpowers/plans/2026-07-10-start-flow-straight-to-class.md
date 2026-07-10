# `/start` straight-to-class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the consult/class choice from the `/start` funnel — send leads straight to a class, then offer a free consult as a skippable post-booking upsell. Same cut on the WhatsApp `book_first_visit` Flow.

**Architecture:** Front-end reflow of one React component (`StartFunnel.jsx`) — no new steps, the consult steps are re-entered from the class success screen. A pure-lib telemetry model change (`ads/funnel.js`). Then a second, gated PR for the WhatsApp Flow handler + a Meta-side republish. No backend, API, DB, or auth changes.

**Tech Stack:** Next.js 16 (App Router), React 19, Vitest (pure-lib), WhatsApp Flows (Meta v7.3 Flow JSON).

**Spec:** [docs/superpowers/specs/2026-07-10-start-flow-straight-to-class-design.md](../specs/2026-07-10-start-flow-straight-to-class-design.md)

**Two PRs:**
- **PR 1 (Tasks 1–4)** — `/start` web funnel + telemetry. Ships first. Front-end only.
- **PR 2 (Tasks 5–9)** — WhatsApp Flow. Gated on PR 1 shipping + a Meta Flow republish + smoke.

---

## File Structure

**PR 1**
- Modify: `src/lib/ads/funnel.js` — drop `path` stage; `booked` = `booked_class` only.
- Modify: `src/lib/ads/funnel.test.js` — update expectations to the 4-stage model.
- Modify: `src/components/StartFunnel.jsx` — class-only entry, consult upsell, stop firing `path_*`.
- (No change needed to `AdsFunnelPanel.jsx` — it renders `stages` generically.)
- (No change to `src/lib/funnel-events.js` — keep `path_*` in `VALID_STEPS` for historical rows.)

**PR 2**
- Modify: `src/lib/whatsapp-flow/handler.js` — `INIT` → class Day screen; remove PATH branch.
- Modify: `src/lib/whatsapp-flow/handler.test.js` — update INIT/PATH expectations.
- Modify: `src/lib/whatsapp-flow/screens.js` — remove PATH from `FLOW_JSON` + routing; drop `pathScreen`.
- Modify: `src/lib/whatsapp-flow/screens.test.js` — four screens, DAY entry.
- Modify: `scripts/build-flow-json.mjs` — attach the header image to DAY (was PATH).
- Modify: `src/lib/agent/prompt.js` — Mia offers a free consult after a Flow class booking.
- Ops: republish the Flow to Meta + smoke-test.

---

# PR 1 — `/start` web funnel + telemetry

## Task 1: Telemetry model — collapse to 4 stages

**Files:**
- Modify: `src/lib/ads/funnel.js:8-14`
- Test: `src/lib/ads/funnel.test.js`

- [ ] **Step 1: Update the failing test first**

Replace the first test in `src/lib/ads/funnel.test.js` (`collapses path/booked variants…`) and the stage-count assertions so they expect the 4-stage model with `booked` = `booked_class` only:

```js
import { describe, it, expect } from 'vitest'
import { shapeFunnel, FUNNEL_STAGES } from './funnel.js'

describe('shapeFunnel', () => {
  it('is a 4-stage class funnel and computes conversion + drop-off', () => {
    const counts = [
      { step: 'view', sessions: 100 },
      { step: 'path_class', sessions: 40 },   // legacy rows still land here…
      { step: 'path_consult', sessions: 20 }, // …but no longer form a stage
      { step: 'details', sessions: 30 },
      { step: 'slots_view', sessions: 28 },
      { step: 'booked_class', sessions: 9 },
      { step: 'booked_consult', sessions: 4 }, // upsell adds — NOT counted in the funnel
    ]
    const s = shapeFunnel(counts)
    expect(s.map((x) => [x.key, x.sessions])).toEqual([
      ['view', 100], ['details', 30], ['slots', 28], ['booked', 9],
    ])
    expect(s[0].pctOfTop).toBe(100)
    expect(s[1].pctOfTop).toBe(30) // 30 / 100
    expect(s[3].pctOfTop).toBe(9)  // 9 / 100 — booked_class only, no double-count
    expect(s[1].dropFromPrev).toBe(70) // 1 - 30/100
    expect(s[3].dropFromPrev).toBe(68) // 1 - 9/28 → 0.678 → 68
  })

  it('handles no traffic yet (empty)', () => {
    const s = shapeFunnel([])
    expect(s).toHaveLength(4)
    expect(s.every((x) => x.sessions === 0)).toBe(true)
    expect(s[0].pctOfTop).toBe(0)
    expect(s[1].dropFromPrev).toBe(0)
  })

  it('handles a null argument', () => {
    expect(shapeFunnel(null)).toHaveLength(4)
  })

  it('exposes the ordered stages', () => {
    expect(FUNNEL_STAGES[0].key).toBe('view')
    expect(FUNNEL_STAGES[3].key).toBe('booked')
    expect(FUNNEL_STAGES[3].steps).toEqual(['booked_class'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/ads/funnel.test.js`
Expected: FAIL — current `FUNNEL_STAGES` has 5 entries incl. `path`, and `booked` sums both.

- [ ] **Step 3: Update `FUNNEL_STAGES`**

In `src/lib/ads/funnel.js`, replace lines 6-14 (the comment + array) with:

```js
// The four funnel stages, in order. Every completed funnel is a class booking
// (the consult is a post-booking upsell, not a funnel stage — see the spec), so
// `booked` counts `booked_class` only; summing in `booked_consult` would
// double-count a session that added a consult after its class.
export const FUNNEL_STAGES = [
  { key: 'view', label: 'Landed on page', steps: ['view'] },
  { key: 'details', label: 'Entered details', steps: ['details'] },
  { key: 'slots', label: 'Saw the times', steps: ['slots_view'] },
  { key: 'booked', label: 'Booked', steps: ['booked_class'] },
]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/ads/funnel.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/funnel.js src/lib/ads/funnel.test.js
git commit -m "STARTFLOW.1 — collapse /start funnel to 4 stages (booked = class only)

The consult/class choice is going away, so the 'Chose a path' stage is
meaningless. And the consult now fires after a class in the same session, so
'booked' must count booked_class only — summing both would double-count.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `StartFunnel` — class-only entry

**Files:**
- Modify: `src/components/StartFunnel.jsx` (state init, remove `choose` step + handlers, hero onto details, stop firing `path_*`)

No unit test — it's a client component (the suite is pure-lib, no React renderer). Verified by `npm run build` + manual walkthrough in Task 4.

- [ ] **Step 1: Change the initial state**

`src/components/StartFunnel.jsx:16-17` — change:

```js
  const [step, setStep] = useState('choose') // choose | details | calendar | classpick | done | classdone
  const [path, setPath] = useState(null)     // 'consultation' | 'class'
```

to:

```js
  const [step, setStep] = useState('details') // details | calendar | classpick | done | classdone
  const [path, setPath] = useState('class')   // 'class' (default) | 'consultation' (upsell only)
```

- [ ] **Step 2: Replace the path handlers with the upsell handler**

`src/components/StartFunnel.jsx:146-147` — replace:

```js
  function chooseConsult() { fireStep('path_consult'); setPath('consultation'); setError(null); setStep('details') }
  function chooseClass() { fireStep('path_class'); setPath('class'); setError(null); setStep('details') }
```

with:

```js
  // Consult upsell (from the class success screen). Details are already captured;
  // flipping path→consultation loads the consult event, step→calendar loads its days.
  function addConsult() { setError(null); setPath('consultation'); setStep('calendar') }
```

- [ ] **Step 3: Stop tagging `details` with a dead path param**

`src/components/StartFunnel.jsx:158-159` — inside `detailsNext`, change:

```js
    fireStep('details', { path })
    setStep(path === 'class' ? 'classpick' : 'calendar')
```

to (details is now always the class entry):

```js
    fireStep('details')
    setStep('classpick')
```

- [ ] **Step 4: Delete the `choose` step and lead the details step with the hero copy**

Delete the whole `{step === 'choose' && (…)}` block (`src/components/StartFunnel.jsx:224-237`).

Then replace the `details` step's heading (`src/components/StartFunnel.jsx:240-241`):

```jsx
        <form onSubmit={detailsNext} className="space-y-3.5">
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Your details</h1>
```

with the hero value-prop leading the form (moved off the deleted choose screen):

```jsx
        <form onSubmit={detailsNext} className="space-y-3.5">
          <div className="mb-4">
            <h1 className="font-display font-extrabold uppercase text-3xl mb-2">Your first 3 classes are free</h1>
            <p className="text-white/60 text-sm">Book your first class now — pop in your details to start.</p>
          </div>
```

- [ ] **Step 5: Commit**

```bash
git add src/components/StartFunnel.jsx
git commit -m "STARTFLOW.1 — /start opens straight on class booking

Land on the details form (path defaults to 'class'); delete the consult/class
choice screen and move the hero value prop onto the details step. Stop firing
the path_* funnel steps (no choice to make).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `StartFunnel` — consult-after upsell

**Files:**
- Modify: `src/components/StartFunnel.jsx` (`classdone` block + consult slot-button guard)

- [ ] **Step 1: Add the upsell CTA to the class success screen**

`src/components/StartFunnel.jsx:218-223` — replace the `classdone` block:

```jsx
      {step === 'classdone' && (
        <div className="text-center py-6">
          <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re being booked in 🎉</p>
          <p className="text-white/70">That&apos;s the first of your 3 free classes — watch for a WhatsApp confirming it. See you at UN1T Stillorgan!</p>
        </div>
      )}
```

with (add a skippable consult upsell below the confirmation):

```jsx
      {step === 'classdone' && (
        <div className="py-6">
          <div className="text-center mb-6">
            <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re being booked in 🎉</p>
            <p className="text-white/70">That&apos;s the first of your 3 free classes — watch for a WhatsApp confirming it. See you at UN1T Stillorgan!</p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-5">
            <div className="font-bold text-lg">Want a coach in your corner?</div>
            <div className="text-white/60 text-sm mt-1 mb-4">Add a free consult — meet a coach, talk goals, get a plan. On us.</div>
            <button type="button" onClick={addConsult} className="lp-btn w-full">Add a free consult →</button>
          </div>
        </div>
      )}
```

- [ ] **Step 2: Guard the consult slot buttons against the event-load race**

`src/components/StartFunnel.jsx:276-277` — change the consult slot button's disabled condition:

```jsx
                  <button key={s.start} disabled={submitting} onClick={() => book(s)}
                    className="px-3 py-3 rounded-xl border-2 border-white/20 hover:border-white text-sm disabled:opacity-50">
```

to (the consult `event` loads off the `path` effect, the days off the `step` effect — days can resolve first; `book()` needs `event`):

```jsx
                  <button key={s.start} disabled={!event || submitting} onClick={() => book(s)}
                    className="px-3 py-3 rounded-xl border-2 border-white/20 hover:border-white text-sm disabled:opacity-50">
```

- [ ] **Step 3: Verify the upsell path by reading the flow**

Confirm by reading `src/components/StartFunnel.jsx` that: `addConsult` sets `path='consultation'` → the effect at the original lines 95-101 fetches the consult event → `step='calendar'` → the effect at the original lines 122-135 fetches days + fires `slots_view` → tapping a slot calls `book()` → `fireStep('booked_consult')` → `step='done'`. No code change in this step — it is a read-through check.

- [ ] **Step 4: Commit**

```bash
git add src/components/StartFunnel.jsx
git commit -m "STARTFLOW.1 — offer a free consult after the class is booked

Skippable upsell on the class success screen; reuses the existing consult
calendar/slot flow with the details already captured (nothing re-entered).
Guard consult slot taps until the consult event has loaded.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Verify PR 1 and open it

**Files:** none (verification + PR)

- [ ] **Step 1: Run the CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
Expected: all pass. (`no-low-contrast-chip` does not apply — `/start` is a deliberately dark surface; the new CTA uses `lp-btn` + `text-white/60`, no `bg-*/10 text-*` chip.)

- [ ] **Step 2: Production build (component + import surface changed)**

Run: `npm run build`
Expected: build succeeds (Turbopack resolves the edited component).

- [ ] **Step 3: Manual walkthrough (dev server)**

Run: `npm run dev`, open `http://localhost:3000/start`. Verify:
- Lands on **"Your first 3 classes are free"** + the details form (no choose screen).
- Details → **Pick a class** (day tabs + time·name, no capacity shown).
- Book a class → **"You're being booked in 🎉"** + the **"Add a free consult"** card.
- Tap **Add a free consult** → consult calendar → pick a time → **"You're booked 🎉"**.
- Repeat, but **ignore** the upsell — the class booking is complete on its own.

- [ ] **Step 4: Push and open the PR**

```bash
[ "$(git branch --show-current)" = "start-flow-straight-to-class" ] || { echo "WRONG BRANCH"; exit 1; }
git push -u origin HEAD
gh pr create --base main --title "STARTFLOW.1 — /start straight to class + consult upsell" --fill
```
Report the PR URL. **Do not merge** — the Fable 5 oversight review runs first (see Handoff).

---

# PR 2 — WhatsApp Flow straight-to-class (gated)

> Start only after PR 1 has merged. This touches a **live, Meta-hosted** Flow asset —
> the code change is small, but it requires a Flow republish + smoke-test that cannot be
> done blind. Read `scripts/build-flow-json.mjs` in full before Task 7.

Branch: `git fetch origin main && git checkout -b start-flow-whatsapp origin/main`

## Task 5: Flow handler — `INIT` goes straight to the class Day screen

**Files:**
- Modify: `src/lib/whatsapp-flow/handler.js`
- Test: `src/lib/whatsapp-flow/handler.test.js`

- [ ] **Step 1: Update the handler tests**

In `src/lib/whatsapp-flow/handler.test.js`, replace the "INIT returns the PATH screen" test and drop the two PATH-branch tests (`class PATH…`, `consult PATH…`), replacing them with an INIT-goes-to-class-DAY test:

```js
  it('INIT returns the class DAY screen directly (no PATH step)', async () => {
    const res = await handleDataExchange(db, { decryptedBody: { action: 'INIT' }, contact, locationId: 'loc1', config })
    expect(res.screen).toBe(SCREEN.DAY)
    expect(res.data.path).toBe('class')
    expect(Array.isArray(res.data.days)).toBe(true)
  })
```

(Keep the existing `DAY`/`SLOT`/`DETAILS` tests — those screens are unchanged. Ensure the test's `db` mock returns classes for `listPublicClasses`; mirror the mock already used by the "class PATH returns DAY" test being removed.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow/handler.test.js`
Expected: FAIL — INIT currently returns `SCREEN.PATH`.

- [ ] **Step 3: Extract a class-day helper and rewire INIT + catch-all**

In `src/lib/whatsapp-flow/handler.js`, add a helper after `resolveConsultEvent` (near line 17):

```js
async function classDayScreen(db, locationId) {
  const classes = await listPublicClasses(db, locationId)
  const seen = new Map()
  for (const c of classes) {
    const day = c.starts_at.slice(0, 10)
    if (!seen.has(day)) seen.set(day, { id: day, title: dayLabel(day) })
  }
  return dayScreen([...seen.values()], 'class')
}
```

Change `INIT` (line 30) from `if (action === 'INIT') return pathScreen()` to:

```js
  if (action === 'INIT') return classDayScreen(db, locationId)
```

Delete the entire `if (screen === SCREEN.PATH) { … }` block (lines 32-46).

Change the catch-all `return pathScreen()` (line 71) to:

```js
  return classDayScreen(db, locationId)
```

Update the DAY handler's class branch (lines 55-58) to reuse nothing new — it already handles `path` (always `'class'` now); leave the `path === 'consult'` branch in place as dead-but-harmless (a defensive fallback; no PATH screen can produce it). Update the import on line 8 to drop `pathScreen`:

```js
import { SCREEN, dayScreen, slotScreen, detailsScreen, confirmScreen } from './screens.js'
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/whatsapp-flow/handler.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-flow/handler.js src/lib/whatsapp-flow/handler.test.js
git commit -m "STARTFLOW.2 — WA Flow: INIT straight to the class Day screen

Skip the PATH (class/consult) screen; path is always 'class'. Consult on
WhatsApp is offered conversationally by Mia after completion (Task 8).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 6: Flow JSON — remove the PATH screen

**Files:**
- Modify: `src/lib/whatsapp-flow/screens.js`
- Test: `src/lib/whatsapp-flow/screens.test.js`

- [ ] **Step 1: Update the screens tests**

In `src/lib/whatsapp-flow/screens.test.js`: change the "declares all five screens" test to expect four (`DAY, SLOT, DETAILS, CONFIRM`, no `PATH`), and assert `FLOW_JSON.routing_model` has `DAY` as the entry (first key) with no `PATH` key. Remove any `pathScreen` import/usage.

```js
  it('FLOW_JSON declares the four booking screens, DAY entry, CONFIRM terminal', () => {
    const ids = FLOW_JSON.screens.map((s) => s.id)
    expect(ids).toEqual([SCREEN.DAY, SCREEN.SLOT, SCREEN.DETAILS, SCREEN.CONFIRM])
    expect(Object.keys(FLOW_JSON.routing_model)[0]).toBe(SCREEN.DAY)
    expect(FLOW_JSON.routing_model.PATH).toBeUndefined()
    expect(FLOW_JSON.screens.find((s) => s.id === SCREEN.CONFIRM).terminal).toBe(true)
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/whatsapp-flow/screens.test.js`
Expected: FAIL — PATH still present.

- [ ] **Step 3: Remove PATH from `screens.js`**

In `src/lib/whatsapp-flow/screens.js`:
- Delete the `pathScreen` export (lines 9-11).
- Remove `PATH` from `SCREEN` (line 7) → `export const SCREEN = { DAY: 'DAY', SLOT: 'SLOT', DETAILS: 'DETAILS', CONFIRM: 'CONFIRM' }`.
- In `FLOW_JSON`: set `routing_model` to `{ DAY: ['SLOT'], SLOT: ['DETAILS'], DETAILS: ['CONFIRM'], CONFIRM: [] }` (line 37) and delete the PATH screen object (lines 39-47) so `screens` starts at DAY.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/whatsapp-flow/screens.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-flow/screens.js src/lib/whatsapp-flow/screens.test.js
git commit -m "STARTFLOW.2 — WA Flow JSON: drop the PATH screen, DAY is the entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 7: Republish the Flow to Meta (ops — cannot be done blind)

**Files:**
- Modify: `scripts/build-flow-json.mjs` (attach header image to DAY, was PATH)

- [ ] **Step 1: Read the build script fully**

Run: `sed -n '1,80p' scripts/build-flow-json.mjs`
Understand where it injects the base64 header `Image` (currently onto the PATH screen). Change that target to the DAY screen (`SCREEN.DAY`), since PATH is gone.

- [ ] **Step 2: Rebuild the publishable JSON**

Run: `node scripts/build-flow-json.mjs --header <the-existing-header-image.jpg> --out /tmp/flow.json`
(Use the same header asset the current live Flow uses.) Inspect `/tmp/flow.json`: DAY is first, carries the header Image, and there is no PATH screen.

- [ ] **Step 3: Publish + version-bump at Meta**

In WhatsApp Flow Builder (or via the Graph API `POST /{flow-id}/assets`) upload `/tmp/flow.json` to Flow `book_first_visit` (`1343015528022374`), then **publish a new version**. The data-exchange endpoint is unchanged (`/api/whatsapp/flow`).

- [ ] **Step 4: Smoke-test end to end**

Trigger the Meta-ad WhatsApp welcome to a test number (or resend the FLOW-button template), tap the button, and confirm the Flow opens **on the Day screen** (no path choice), books a class, and the confirmation fires. Verify a `whatsapp_messages` row + the booking landed.

- [ ] **Step 5: Commit the script change**

```bash
git add scripts/build-flow-json.mjs
git commit -m "STARTFLOW.2 — build-flow-json: header image onto DAY (PATH removed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 8: Mia offers the consult after a Flow class booking

**Files:**
- Modify: `src/lib/agent/prompt.js`

- [ ] **Step 1: Locate the booking-behaviour section**

Run: `grep -n "book\|consult\|first class\|class booked\|follow" src/lib/agent/prompt.js | head -40`
Find the section describing what Mia does after a booking / for new leads.

- [ ] **Step 2: Add the nudge**

Add one instruction, in the surrounding prose style, e.g.:

> When a lead has just booked their first class (including via the "Book your first visit" flow), warmly offer a **free 1:1 consultation** as an optional next step — meet a coach, talk goals, get a plan. Offer once; if they decline or ignore it, don't push.

- [ ] **Step 3: Verify tests + guardrails**

Run: `npm test && npm run lint`
Expected: pass. (No structural change — a prompt-string edit.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/prompt.js
git commit -m "STARTFLOW.2 — Mia offers a free consult after a first class booking

The WhatsApp analog of the /start post-booking upsell. Offer once, no push.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Task 9: Verify PR 2 and open it

- [ ] **Step 1: CI mirror + build**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build
```
Expected: all pass.

- [ ] **Step 2: Push + PR**

```bash
[ "$(git branch --show-current)" = "start-flow-whatsapp" ] || { echo "WRONG BRANCH"; exit 1; }
git push -u origin HEAD
gh pr create --base main --title "STARTFLOW.2 — WhatsApp Flow straight to class + Mia consult offer" --fill
```
Report the PR URL. Note in the PR body that the Meta Flow republish (Task 7) is a manual step that must be done at deploy time.

---

## Self-Review (done at authoring)

- **Spec coverage:** Part 1 → Tasks 2–3; Part 2 (telemetry) → Task 1; Part 3 (WhatsApp) → Tasks 5–8; rollout/verification → Tasks 4, 9. All spec sections mapped.
- **Placeholder scan:** none — every code step shows the exact before/after. Task 7 (Meta publish) and Task 8 (prompt prose) are inherently operational/edit-in-place and give exact commands + the text to add.
- **Type/name consistency:** `addConsult`, `classDayScreen`, `FUNNEL_STAGES` (4 entries, `booked` = `['booked_class']`), `SCREEN` without `PATH` — used consistently across tasks.
- **Known deviation from spec (intentional, spec updated):** `booked` counts `booked_class` only (not both) to avoid double-counting the post-class consult in the same session.
