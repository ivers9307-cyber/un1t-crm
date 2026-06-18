# Garmin / ANT+ wearables on the live TV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a member register a Garmin / ANT+ watch once in the member app and have it appear on the in-studio TV leaderboard as their named tile, the same as a chest strap.

**Architecture:** All changes are in the **champ-app** repo (`/Users/richardivers/code/champ-app`, a Next.js app, separate Vercel project). The live pipeline, the `contact_devices` registry, the `scan_straps_for_contact` RPC, and the bridge auto-routing already exist and are unchanged. This slice adds a member-app onboarding flow: a device-kind selector that records a watch as `device_type:'watch'` (instead of the current hardcoded `'chest_strap'`), per-kind broadcast-mode instructions, and watch labelling on the device list. No migration, no API route, no un1t-crm code change.

**Tech Stack:** Next.js (App Router) + React client components, Tailwind, `@supabase/supabase-js` browser client (RLS customer-self), Vitest for the pure helper. Spec: `un1t-crm/docs/superpowers/specs/2026-06-18-garmin-ant-wearables-live-tv-design.md`.

**Working directory for ALL tasks:** `/Users/richardivers/code/champ-app` (the champ-app git repo). Branch off `main` before Task 1:
```bash
cd /Users/richardivers/code/champ-app && git checkout main && git pull && git checkout -b garmin-ant-wearables
```

**Testing posture (matches champ-app convention):** champ-app tests cover **pure lib helpers** only (co-located `*.test.js`, run by `vitest`) — there is no component-test harness. So the TDD test coverage lives in Task 1 (the pure helper); the component edits (Tasks 2–4) are verified by `npm run build` + the real-hardware acceptance run in Task 5. Do not add React Testing Library — it isn't in the repo.

---

### Task 1: Pure device-onboarding helper

The kind→`device_type` mapping and the per-kind broadcast instructions. Pure and dependency-free so it unit-tests with no DB/DOM.

**Files:**
- Create: `src/lib/device-onboarding.js`
- Test: `src/lib/device-onboarding.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/device-onboarding.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { DEVICE_KINDS, deviceTypeForKind, broadcastGuide } from './device-onboarding.js'

describe('DEVICE_KINDS', () => {
  it('offers exactly chest_strap + watch, in that order', () => {
    expect(DEVICE_KINDS.map((k) => k.key)).toEqual(['chest_strap', 'watch'])
    expect(DEVICE_KINDS.every((k) => typeof k.label === 'string' && k.label.length > 0)).toBe(true)
  })
})

describe('deviceTypeForKind', () => {
  it('maps the known kinds through unchanged', () => {
    expect(deviceTypeForKind('watch')).toBe('watch')
    expect(deviceTypeForKind('chest_strap')).toBe('chest_strap')
  })
  it('falls back to chest_strap for unknown/missing input', () => {
    expect(deviceTypeForKind('phone')).toBe('chest_strap')
    expect(deviceTypeForKind(undefined)).toBe('chest_strap')
    expect(deviceTypeForKind(null)).toBe('chest_strap')
  })
})

describe('broadcastGuide', () => {
  it('watch + garmin → Garmin-specific steps and a per-class caveat', () => {
    const g = broadcastGuide('watch', 'garmin')
    expect(g.title).toMatch(/Garmin/)
    expect(g.steps.join(' ')).toMatch(/Sensors & Accessories/)
    expect(g.steps.join(' ')).toMatch(/broadcast/i)
    expect(g.caveat).toMatch(/each class/i)
  })
  it('watch + non-garmin → generic broadcast steps, still with a caveat', () => {
    const g = broadcastGuide('watch', 'coros')
    expect(g.title).not.toMatch(/Garmin/)
    expect(g.steps.join(' ')).toMatch(/broadcast/i)
    expect(g.caveat).toBeTruthy()
  })
  it('chest_strap → simple guide with no caveat', () => {
    const g = broadcastGuide('chest_strap', null)
    expect(Array.isArray(g.steps)).toBe(true)
    expect(g.steps.length).toBeGreaterThan(0)
    expect(g.caveat).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/device-onboarding.test.js`
Expected: FAIL — `Failed to resolve import "./device-onboarding.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/device-onboarding.js`:

```js
// Pure helpers for the member device-onboarding flow
// (account/devices). Maps the member's chosen device "kind" to a
// contact_devices.device_type and supplies the per-kind broadcast
// instructions shown before they scan/register.
//
// Pure + dependency-free so it unit-tests without a DB or DOM,
// mirroring the lib-test convention shared with un1t-crm.

export const DEVICE_KINDS = [
  { key: 'chest_strap', label: 'Chest strap' },
  { key: 'watch', label: 'Watch / wearable' },
]

const VALID_KINDS = DEVICE_KINDS.map((k) => k.key)

/**
 * Map a chosen device kind to a contact_devices.device_type.
 * Unknown / missing kinds fall back to 'chest_strap' — the safe
 * default, and what the form did before this flow existed.
 */
export function deviceTypeForKind(kind) {
  return VALID_KINDS.includes(kind) ? kind : 'chest_strap'
}

/**
 * Per-kind onboarding guide shown before scan/registration.
 * Returns { title, steps: string[], caveat: string | null }.
 *
 * The watch path is Garmin-led (the most common ANT+ wearable);
 * other manufacturers get the same shape with generic wording. The
 * caveat is load-bearing: a watch only broadcasts with a live pulse
 * lock + broadcast mode ON, and most re-disable it per class.
 */
export function broadcastGuide(kind, manufacturer) {
  if (deviceTypeForKind(kind) === 'watch') {
    const isGarmin = String(manufacturer || '').toLowerCase() === 'garmin'
    return {
      title: isGarmin
        ? 'Turn on Broadcast Heart Rate (Garmin)'
        : 'Turn on Broadcast Heart Rate',
      steps: isGarmin
        ? [
            'On your watch: Settings → Sensors & Accessories → Wrist Heart Rate → Broadcast During Activity (or hold the menu and choose Broadcast HR).',
            'Wear the watch snugly so it has a steady pulse reading.',
            'Then tap Scan below — your watch appears within a few seconds.',
          ]
        : [
            "Turn on your watch's \"Broadcast heart rate\" mode (look under its heart-rate or sensor settings).",
            'Wear it snugly so it has a steady pulse reading.',
            'Then tap Scan below — your watch appears within a few seconds.',
          ],
      caveat:
        'Most watches need broadcast switched on again before each class, and it uses a little extra battery. Off the wrist or with broadcast off, the watch sends nothing.',
    }
  }
  return {
    title: 'Using a chest strap',
    steps: [
      "Wet the strap's contacts and put it on.",
      'Walk into the studio, then tap Scan below to pick it.',
    ],
    caveat: null,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/device-onboarding.test.js`
Expected: PASS (4 test cases, all green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/device-onboarding.js src/lib/device-onboarding.test.js
git commit -m "feat(devices): pure device-onboarding helper (kind → device_type + broadcast guide)"
```

---

### Task 2: Device-kind selector + device_type wiring in the add form

Add a "Chest strap / Watch" selector to `AddDeviceForm` and stop hardcoding `device_type:'chest_strap'`. The selector smart-defaults to "Watch" when a scan detected a Garmin.

**Files:**
- Modify: `src/app/account/devices/DevicesManager.jsx` (import line ~10; `AddDeviceForm` lines 188–215)

- [ ] **Step 1: Add the import**

In `src/app/account/devices/DevicesManager.jsx`, add to the imports (after the `heart-rate-devices` import on line 10):

```js
import { DEVICE_KINDS, deviceTypeForKind, broadcastGuide } from '@/lib/device-onboarding'
```

- [ ] **Step 2: Add `kind` state to AddDeviceForm**

In `AddDeviceForm` (currently starting line 188), add a `kind` state alongside the existing `useState` lines. Insert it right after the `const [protocol, setProtocol] = useState(...)` line (line 189):

```js
  const [kind, setKind] = useState(
    String(prefill?.manufacturer || '').toLowerCase() === 'garmin' ? 'watch' : 'chest_strap',
  )
```

- [ ] **Step 3: Use the kind in the submit payload**

In `AddDeviceForm`'s `submit()` (lines 198–215), replace the hardcoded `device_type: 'chest_strap',` (line 204) with:

```js
        device_type: deviceTypeForKind(kind),
```

- [ ] **Step 4: Render the kind selector at the top of the form**

In `AddDeviceForm`'s returned JSX, immediately after the opening `<form …>` tag (after line 221, before the `{!fromScan && (` connection-type block on line 222), insert:

```jsx
      <div className="mb-3">
        <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
          What are you adding?
        </label>
        <div className="mt-1 flex gap-2">
          {DEVICE_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKind(k.key)}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                kind === k.key
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                  : 'border-neutral-300 bg-white text-neutral-700 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-300'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: build succeeds (no type/JSX/import errors). `device-onboarding` resolves; `DevicesManager` compiles.

- [ ] **Step 6: Commit**

```bash
git add src/app/account/devices/DevicesManager.jsx
git commit -m "feat(devices): device-kind selector; record watches as device_type=watch"
```

---

### Task 3: Broadcast-mode instruction card in the add form

Show the per-kind `broadcastGuide` content above the identifier field so the member knows to enable Broadcast HR before scanning.

**Files:**
- Modify: `src/app/account/devices/DevicesManager.jsx` (`AddDeviceForm` JSX)

- [ ] **Step 1: Render the guide card**

In `AddDeviceForm`'s JSX, immediately after the kind-selector block added in Task 2 (and before the `{!fromScan && (` connection-type block), insert a guide card driven by the pure helper:

```jsx
      {(() => {
        const guide = broadcastGuide(kind, manufacturer)
        return (
          <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950">
            <p className="text-xs font-semibold text-blue-900 dark:text-blue-200">{guide.title}</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-blue-900 dark:text-blue-200">
              {guide.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {guide.caveat && (
              <p className="mt-2 text-[11px] text-blue-800 dark:text-blue-300">{guide.caveat}</p>
            )}
          </div>
        )
      })()}
```

(`manufacturer` is already in scope — it's an existing `useState` in `AddDeviceForm`, line 192.)

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds. Adding a device now shows the kind selector + the matching instruction card; switching kind/brand swaps the card text.

- [ ] **Step 3: Commit**

```bash
git add src/app/account/devices/DevicesManager.jsx
git commit -m "feat(devices): broadcast-mode instruction card in the add flow"
```

---

### Task 4: Watch labelling on the device list

Show whether each registered device is a watch or strap, and a one-line broadcast reminder on watches.

**Files:**
- Modify: `src/app/account/devices/DevicesManager.jsx` (device list `<li>`, lines 110–151)

- [ ] **Step 1: Add a device-type chip + watch reminder**

In the device list, inside the `<li>` (lines 115–147), within the `min-w-0 flex-1` `<div>` (after the name `<p>` that ends at line 133, before the identifier `<p>` on line 134), insert a kind chip and a conditional reminder:

```jsx
                  {d.device_type === 'watch' && (
                    <span className="ml-2 inline-block rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                      Watch
                    </span>
                  )}
```

Place that chip inside the existing name `<p>` (lines 121–133), right after the `{!d.is_active && (…)}` block (before the closing `</p>` on line 133), so it sits inline with the protocol/inactive chips.

Then, after that name `<p>` closes (line 133) and before the identifier `<p>` (line 134), insert the reminder:

```jsx
                  {d.device_type === 'watch' && d.is_active && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      Enable Broadcast HR on your watch before class.
                    </p>
                  )}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds. A registered watch row shows a "Watch" chip and the amber reminder; chest-strap rows are unchanged.

- [ ] **Step 3: Run the full pure-test suite + commit**

```bash
npx vitest run
```
Expected: PASS (existing suite + the Task 1 helper tests).

```bash
git add src/app/account/devices/DevicesManager.jsx
git commit -m "feat(devices): label watches + show broadcast reminder on the device list"
```

---

### Task 5: Real-hardware acceptance (manual)

This is the validation gate, not a code change. The ANT+ ingestion half is already proven (a Garmin watch lands as `ant:45075`); this confirms the register → named-tile half, which is the currently-unverified link.

- [ ] **Step 1: Register a Garmin via the new flow**

On a phone signed in to champ-app (`app.champfitness.ie`) as a test member with a Garmin watch:
1. Enable Broadcast Heart Rate on the watch (per the in-app card), wear it with a pulse lock.
2. champ-app → account → devices → **Scan** → confirm the watch appears (name detected as garmin, an `ant:<number>`).
3. Pick it → the add form opens with **kind defaulted to Watch** and the Garmin instruction card showing → **Add**.
4. Confirm the device list shows it with the **Watch** chip + the broadcast reminder, and `device_type='watch'` (spot-check in Supabase `contact_devices` if needed).

- [ ] **Step 2: Confirm the live tile**

1. With broadcast still on, have the member present during a live class at Stillorgan (`location_id a0000000-0000-0000-0000-000000000001`).
2. Open `https://crm.un1tdublin.com/tv/a0000000-0000-0000-0000-000000000001`.
3. Expected: within ~10s the member appears as a **named** tile (not an anonymous device-id walk-in), with live BPM.

- [ ] **Step 3: Record the result**

Note the outcome in the bridge memory file (`champ-bridge-hr-live.md`) — this is the first end-to-end register→named-tile confirmation, which that file currently lists as still-untested.

---

### Task 6: Ship

**Files:** none (verification + PR)

- [ ] **Step 1: Final verification**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run        # all pure tests green
npm run build         # production build clean
```

- [ ] **Step 2: Push + open the PR (champ-app repo)**

```bash
git push -u origin garmin-ant-wearables
gh pr create -R ivers9307-cyber/champ-app --base main --head garmin-ant-wearables \
  --title "feat(devices): register Garmin / ANT+ watches for the live TV" \
  --body "Adds a device-kind selector + broadcast-mode onboarding to account/devices so a member can register a Garmin/ANT+ watch as device_type=watch and appear on the live TV as a named tile. Pure helper in src/lib/device-onboarding.js (unit-tested); the live pipeline + registry + scan flow are unchanged. Spec: un1t-crm docs/superpowers/specs/2026-06-18-garmin-ant-wearables-live-tv-design.md. Verified: vitest + next build green; real-hardware acceptance per plan Task 5."
```

- [ ] **Step 3: Merge after CI green**

champ-app auto-deploys to `app.champfitness.ie` on merge to `main` (separate Vercel project). Confirm CI/Vercel checks pass, then squash-merge.

---

## Notes for the executor

- **One repo: champ-app.** No un1t-crm code, no migration, no API route. The spec lives in un1t-crm (paired with this plan) but the code is entirely champ-app.
- **Why so little code:** `contact_devices` already supports `device_type:'watch'`, the scan/claim flow already exists and auto-detects Garmin, and the bridge already routes any registered `device_key` to the live tile. This slice is the missing member-facing onboarding only.
- **Deferred (do NOT pull in):** Whoop/BLE (needs Pi BLE enablement + an address-rotation spike + connection-ceiling work), Apple Watch (needs a watchOS/HealthKit app), and any post-class cloud sync. Each is its own future slice.
