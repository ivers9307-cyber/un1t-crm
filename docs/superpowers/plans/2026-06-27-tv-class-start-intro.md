# Studio TV class-start intro card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Play a short branded intro card on `/tv/[locationId]` when a class starts — class name + Dublin time + program, auto-filled from `class_occurrences`, fired once at scheduled start, then dissolving to the HR leaderboard.

**Architecture:** A pure trigger (`shouldPlayIntro`) + a pure time formatter, both unit-tested; a feed reader that exposes the live class on the public TV feed; and a React overlay on the TV page that plays the animated card. No migration, un1t-crm only.

**Spec:** `docs/superpowers/specs/2026-06-27-tv-class-start-intro-design.md`

**Working directory:** `~/code/un1t-crm-tv` (branch `tv-class-start-intro`, off `origin/main`).

**Facts (confirmed):**
- `/api/public/live/[locationId]/route.js` (unauth TV feed) returns `{ ok, server_time, location, bridge, sessions, timer, available_straps }` from two return statements (early no-sessions + final).
- `src/lib/class-occurrences.js` `resolveCurrentOccurrence` returns only `{ glofox_event_id, class_name, ends_at }` (no `starts_at`/`program`) — so we add a dedicated TV reader. `occurrenceIsLive(occ, nowMs)` + `OCC_PRE_MS` exist there.
- `src/lib/dublin-time.js` has `dublinTodayStr`/`dublinNowMinutes`/`addDaysISO` but NO time-of-day formatter.
- `src/app/tv/[locationId]/LiveTvClient.jsx` polls the feed every 2 s, renders a black leaderboard (`bg-black text-white`, `border-neutral-800`, `text-red-500` — raw Tailwind, NOT `un1t-*` tokens) + a `TimerBanner`.
- Repo invariants: `.select()` ≤1000 rows; no `new Date(\`${d}T${t}Z\`)`; new route/page changes need `npm run build`; CI mirror before push.

---

## File structure
| File | Change |
|---|---|
| `src/lib/tv-class-intro.js` *(new)* | Pure `shouldPlayIntro` + `INTRO_WINDOW_MS`/`INTRO_DURATION_MS` |
| `src/lib/tv-class-intro.test.js` *(new)* | Unit tests |
| `src/lib/dublin-time.js` | + pure `dublinTimeLabel(iso)` (Dublin `HH:MM`) |
| `src/lib/dublin-time.test.js` | + tests for `dublinTimeLabel` |
| `src/lib/class-occurrences.js` | + `resolveCurrentClassForTv` reader |
| `src/app/api/public/live/[locationId]/route.js` | + `current_class` block |
| `src/app/tv/[locationId]/LiveTvClient.jsx` | `<ClassStartIntro>` overlay |
| `docs/CHANGELOG.md` | Done entry |

---

## Task 1: Pure trigger + Dublin time label

**Files:** Create `src/lib/tv-class-intro.js`, `src/lib/tv-class-intro.test.js`; modify `src/lib/dublin-time.js` + `src/lib/dublin-time.test.js`.

- [ ] **Step 1: Write the failing tests**

`src/lib/tv-class-intro.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { shouldPlayIntro, INTRO_WINDOW_MS, INTRO_DURATION_MS } from './tv-class-intro.js'

const start = '2026-06-27T17:00:00Z'
const startMs = Date.parse(start)
const cls = { glofox_event_id: 'e1', class_name: 'TEMPO', starts_at: start }

describe('shouldPlayIntro', () => {
  it('plays right at the scheduled start (new occurrence)', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs + 1000 })).toBe(true)
  })
  it('does NOT play before the scheduled start', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs - 60_000 })).toBe(false)
  })
  it('does NOT play past the window (e.g. a mid-class page load)', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: null, nowMs: startMs + INTRO_WINDOW_MS + 1000 })).toBe(false)
  })
  it('does NOT replay for the same occurrence key', () => {
    expect(shouldPlayIntro({ currentClass: cls, lastPlayedKey: 'e1', nowMs: startMs + 1000 })).toBe(false)
  })
  it('plays again for a different occurrence key', () => {
    const next = { glofox_event_id: 'e2', class_name: 'RIDE', starts_at: start }
    expect(shouldPlayIntro({ currentClass: next, lastPlayedKey: 'e1', nowMs: startMs + 1000 })).toBe(true)
  })
  it('false for null / malformed current class', () => {
    expect(shouldPlayIntro({ currentClass: null, lastPlayedKey: null, nowMs: startMs })).toBe(false)
    expect(shouldPlayIntro({ currentClass: { glofox_event_id: 'e1' }, lastPlayedKey: null, nowMs: startMs })).toBe(false)
  })
  it('exposes sane constants', () => {
    expect(INTRO_WINDOW_MS).toBe(120_000)
    expect(INTRO_DURATION_MS).toBe(8_000)
  })
})
```

Add to `src/lib/dublin-time.test.js` (it exists; import `dublinTimeLabel`):
```js
describe('dublinTimeLabel', () => {
  it('formats a UTC instant as Dublin HH:MM (BST = +1 in summer)', () => {
    expect(dublinTimeLabel('2026-06-27T17:00:00Z')).toBe('18:00')
  })
  it('formats a winter instant (GMT = +0)', () => {
    expect(dublinTimeLabel('2026-01-15T09:30:00Z')).toBe('09:30')
  })
  it('returns null for a bad input', () => {
    expect(dublinTimeLabel('nope')).toBeNull()
    expect(dublinTimeLabel(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/tv-class-intro.test.js src/lib/dublin-time.test.js`.

- [ ] **Step 3: Implement**

Create `src/lib/tv-class-intro.js`:
```js
// Pure trigger for the studio TV class-start intro card. No DOM/IO.
// The TV page passes the live class + the last-played key + the server clock.

export const INTRO_WINDOW_MS = 120_000  // only fire within 2 min of scheduled start
export const INTRO_DURATION_MS = 8_000  // how long the card holds before dissolving

/**
 * Should the intro card play right now?
 * Plays once, at scheduled start, within a 2-min window, per occurrence.
 * @param {{ currentClass: {glofox_event_id?:string, starts_at?:string}|null, lastPlayedKey: string|null, nowMs: number, windowMs?: number }} args
 */
export function shouldPlayIntro({ currentClass, lastPlayedKey, nowMs, windowMs = INTRO_WINDOW_MS }) {
  const key = currentClass?.glofox_event_id
  const startMs = currentClass?.starts_at ? Date.parse(currentClass.starts_at) : NaN
  if (!key || !Number.isFinite(startMs) || !Number.isFinite(nowMs)) return false
  if (key === lastPlayedKey) return false
  const since = nowMs - startMs
  return since >= 0 && since <= windowMs
}
```

Add to `src/lib/dublin-time.js`:
```js
/**
 * Format a UTC instant (ISO string) as a Dublin wall-clock HH:MM (24h, DST-safe
 * via Intl). Returns null for an unparseable input.
 */
export function dublinTimeLabel(iso) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(t))
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/tv-class-intro.test.js src/lib/dublin-time.test.js`, then `npm test`.

- [ ] **Step 5: Commit**
```bash
git add src/lib/tv-class-intro.js src/lib/tv-class-intro.test.js src/lib/dublin-time.js src/lib/dublin-time.test.js
git commit -m "TV-INTRO.1 — pure intro trigger + Dublin time label"
```

---

## Task 2: Feed exposes the live class

**Files:** Modify `src/lib/class-occurrences.js`, `src/app/api/public/live/[locationId]/route.js`.

- [ ] **Step 1: Add the reader** to `src/lib/class-occurrences.js` (mirror `resolveCurrentOccurrence` but project `starts_at` + `program`):
```js
/**
 * IO: the class running at a location right now, with the fields the TV
 * class-start intro card needs. Same "most-recently-started live occurrence"
 * resolution as resolveCurrentOccurrence. Returns null when nothing is live.
 * @returns {Promise<null | { glofox_event_id:string, class_name:string|null, program:string|null, starts_at:string }>}
 */
export async function resolveCurrentClassForTv(db, { locationId, nowMs = Date.now() } = {}) {
  if (!db || !locationId) return null
  const sinceIso = new Date(nowMs - 3 * 60 * 60_000).toISOString()
  const untilIso = new Date(nowMs + OCC_PRE_MS).toISOString()
  const { data } = await db
    .from('class_occurrences')
    .select('glofox_event_id, name, program, starts_at, ends_at')
    .eq('location_id', locationId)
    .gte('starts_at', sinceIso)
    .lte('starts_at', untilIso)
    .order('starts_at', { ascending: false })
  for (const occ of data || []) {
    if (occurrenceIsLive(occ, nowMs)) {
      return { glofox_event_id: occ.glofox_event_id, class_name: occ.name || null, program: occ.program || null, starts_at: occ.starts_at }
    }
  }
  return null
}
```

- [ ] **Step 2: Expose `current_class` on the feed.** In `src/app/api/public/live/[locationId]/route.js`:
1. Imports:
```js
import { resolveCurrentClassForTv } from '@/lib/class-occurrences'
import { dublinTimeLabel } from '@/lib/dublin-time'
```
2. After the location is confirmed (and near the timer fetch), compute:
```js
  const liveClass = await resolveCurrentClassForTv(db, { locationId, nowMs })
  const currentClass = liveClass
    ? { class_name: liveClass.class_name, program: liveClass.program, starts_at: liveClass.starts_at, starts_at_label: dublinTimeLabel(liveClass.starts_at), glofox_event_id: liveClass.glofox_event_id }
    : null
```
   (Use the route's existing `nowMs` — it defines `const nowMs = Date.now()` near the top; if not, add it.)
3. Add `current_class: currentClass,` to BOTH `NextResponse.json({...})` payloads (the early no-sessions return AND the final return).

- [ ] **Step 3: Verify**
- `npm test` — full suite green (no behavioural change to existing fields).
- `npm run build` — compiles.
- `npm run check:route-guards` — unchanged (public route already exempt).

- [ ] **Step 4: Commit**
```bash
git add src/lib/class-occurrences.js 'src/app/api/public/live/[locationId]/route.js'
git commit -m "TV-INTRO.2 — public TV feed exposes current_class (name/program/time)"
```

---

## Task 3: The intro overlay on the TV

**Files:** Modify `src/app/tv/[locationId]/LiveTvClient.jsx`.

- [ ] **Step 1: Read** `LiveTvClient.jsx` — note the default export component, the polled `data` state (`data.server_time`, `data.current_class`), and the `useEffect`/`useState` imports + the `<main className="min-h-screen bg-black text-white">` root.

- [ ] **Step 2: Implement** a `ClassStartIntro` component and render it inside the root `<main>` (as the LAST child, so it overlays). It uses the pure trigger + `sessionStorage` for the last-played key, shows the animated card, and auto-hides after `INTRO_DURATION_MS`.
```jsx
import { shouldPlayIntro, INTRO_DURATION_MS } from '@/lib/tv-class-intro'
// ...
function ClassStartIntro({ current, serverTime }) {
  const [visible, setVisible] = useState(false)
  const [shown, setShown] = useState(false) // drives the fade-in transition
  const cls = current

  useEffect(() => {
    if (!cls?.glofox_event_id || !serverTime) return
    const nowMs = Date.parse(serverTime)
    let lastPlayedKey = null
    try { lastPlayedKey = sessionStorage.getItem('tvIntroLastKey') } catch {}
    if (!shouldPlayIntro({ currentClass: cls, lastPlayedKey, nowMs })) return
    try { sessionStorage.setItem('tvIntroLastKey', cls.glofox_event_id) } catch {}
    setVisible(true)
    const inT = setTimeout(() => setShown(true), 30)
    const outT = setTimeout(() => setShown(false), INTRO_DURATION_MS - 600)
    const hideT = setTimeout(() => setVisible(false), INTRO_DURATION_MS)
    return () => { clearTimeout(inT); clearTimeout(outT); clearTimeout(hideT) }
  }, [cls?.glofox_event_id, serverTime])

  if (!visible || !cls) return null
  const meta = [cls.starts_at_label, cls.program].filter(Boolean).join('  ·  ')
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: '#08080A',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      opacity: shown ? 1 : 0, transition: 'opacity .6s ease' }}>
      <span style={{ position: 'absolute', top: 24, left: 28, fontWeight: 700, letterSpacing: 6, color: '#fff' }}>UN1T</span>
      <span style={{ position: 'absolute', top: 24, right: 28, fontSize: 14, fontWeight: 700, letterSpacing: 3, color: '#EF4444' }}>● LIVE</span>
      <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: 8, color: '#7a7a82',
        opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'all .6s ease .1s' }}>NOW STARTING</span>
      <span style={{ fontSize: '11vw', lineHeight: 1, fontWeight: 800, color: '#fff', letterSpacing: 2, marginTop: 8,
        opacity: shown ? 1 : 0, transform: shown ? 'scale(1)' : 'scale(.92)', transition: 'all .7s cubic-bezier(.2,.7,.2,1) .25s' }}>{cls.class_name || 'CLASS'}</span>
      <span style={{ height: 4, width: shown ? 160 : 0, background: '#EF4444', borderRadius: 2, margin: '22px 0 14px', transition: 'width .7s cubic-bezier(.4,0,.1,1) .5s' }} />
      {meta ? <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: 2, color: '#b8b8be',
        opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(8px)', transition: 'all .6s ease .7s' }}>{meta}</span> : null}
    </div>
  )
}
```
Then, inside the root `<main>` return (as the last child), add:
```jsx
<ClassStartIntro current={data?.current_class} serverTime={data?.server_time} />
```
(Confirm `useState`/`useEffect` are imported at the top — they are; `LiveTvClient` already uses them.)

- [ ] **Step 3: Verify**
- `npm run build` — compiles (this is the real gate for the page).
- `npm run lint` and `npx next lint` — clean (no internal `<a>`; this overlay uses no `<Link>`/buttons).
- `npm test` — full suite green.

- [ ] **Step 4: Commit**
```bash
git add 'src/app/tv/[locationId]/LiveTvClient.jsx'
git commit -m "TV-INTRO.3 — class-start intro overlay on the studio TV"
```

---

## Task 4: Docs + ship

- [ ] **Step 1: CHANGELOG** entry — the TV now plays a class-start intro card (class name + Dublin time + program, auto-filled from the schedule spine, fired once at scheduled start, dissolves to the leaderboard). Cite spec/plan. Note: un1t-crm only, no migration; instructor deliberately omitted (Glofox trainer data unreliable); shows only where a class is live (Stillorgan).
- [ ] **Step 2: CI mirror** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails` + `npm run build`. All green.
- [ ] **Step 3: Push + PR** — `git push -u origin HEAD && gh pr create --base main --fill`. Report URL. Device-verify on the studio TV: watch a class hit its scheduled start.

---

## Self-review (plan author)
**Spec coverage:** trigger (scheduled start, 2-min window, once-per-occurrence, server-clock) → T1 `shouldPlayIntro`; Dublin time label → T1 `dublinTimeLabel`; feed `current_class` → T2; the animated overlay (class name + time + program, dissolves after 8 s) → T3; degrades to null where no class is live → T2/T3. **Placeholders:** pure tasks (T1) full code+tests; the overlay (T3) is concrete code matching the approved mockup, using the TV page's raw-Tailwind/inline-style idiom (not `un1t-*` tokens). **Type consistency:** `shouldPlayIntro({ currentClass, lastPlayedKey, nowMs })` identical T1/T3; the `current_class` block fields (`class_name, program, starts_at, starts_at_label, glofox_event_id`) are exactly what T3 reads and what `resolveCurrentClassForTv` + `dublinTimeLabel` produce. **No migration; un1t-crm only.**
