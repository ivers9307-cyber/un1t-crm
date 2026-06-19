# champ-app Design Refresh — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the dark-only UN1T design foundation in champ-app — token system, Poppins, primitive components, and a persistent bottom-tab shell — so Phase 2/3 can restyle each surface on top of it.

**Architecture:** A single dark palette in CSS variables (`globals.css`) surfaced as `un1t.*` Tailwind colours; Poppins via `next/font/google`; Tailwind `darkMode: 'class'` + `<html class="dark">` so the app reads coherently dark immediately (every surface is already `dark:`-paired); a `'use client'` `AppShell` (gated by `usePathname`) renders a `TopBar` + fixed bottom `TabBar` on authenticated pages and bare children on `/login` + `/share/*`. New presentational primitives live in `src/components/ui/`.

**Tech Stack:** Next.js 14.2 (App Router), Tailwind 3.4, `next/font/google`, lucide-react, Vitest (node env — pure helpers only; components verified by `next build`). Repo: **champ-app** (`/Users/richardivers/code/champ-app`).

**Spec:** `un1t-crm/docs/superpowers/specs/2026-06-19-champ-app-design-refresh-design.md`

---

## File structure

**champ-app — create:**
- `src/lib/format.js` — pure display formatters (`sourceLabel`, `durationMinutes`, `sessionDate`).
- `src/lib/format.test.js` — unit tests.
- `src/components/ui/Card.jsx`, `Button.jsx`, `StatNumber.jsx`, `EffortNumber.jsx`, `ZoneBar.jsx`, `Chip.jsx`, `EmptyState.jsx`, `index.js` — presentational primitives.
- `src/components/TopBar.jsx`, `TabBar.jsx`, `AppShell.jsx` — the shell.
- `src/app/account/page.jsx` — minimal Account index (the Account tab target).

**champ-app — modify:**
- `src/app/globals.css` — dark-only tokens + body + motion util (full rewrite).
- `tailwind.config.js` — `darkMode:'class'`, `un1t.*` colours, radius/font, drop `champ` (full rewrite).
- `src/app/layout.jsx` — Poppins, `<html class="dark">`, wrap children in `AppShell` (full rewrite).

**Not touched in P1** (restyled in P2/P3): the dashboard/sessions/account surface bodies, login, share-page chrome, the Slice-4 `opengraph-image.jsx`. They inherit the dark body + shell and render correctly (all `dark:`-paired); only a few `hover:text-neutral-900` link hovers look off until their surface is restyled — cosmetic, mobile-irrelevant, no P1 action.

---

### Task 1: Pure formatters (`src/lib/format.js`)

**Files:** Create `src/lib/format.js` + `src/lib/format.test.js`

- [ ] **Step 1: Branch off champ-app main**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b champ-ui-p1-foundation
```

- [ ] **Step 2: Write the failing test**

`src/lib/format.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { sourceLabel, durationMinutes, sessionDate } from './format.js'

describe('sourceLabel', () => {
  it('maps known sources to friendly labels', () => {
    expect(sourceLabel('ble_bridge')).toBe('In-studio')
    expect(sourceLabel('apple_health')).toBe('Apple Health')
    expect(sourceLabel('whoop')).toBe('Whoop')
  })
  it('passes through an unknown source; falls back when empty', () => {
    expect(sourceLabel('strava')).toBe('strava')
    expect(sourceLabel(null)).toBe('Session')
  })
})

describe('durationMinutes', () => {
  it('rounds to whole minutes, minimum 1', () => {
    expect(durationMinutes('2026-06-19T10:00:00Z', '2026-06-19T10:45:30Z')).toBe(46)
    expect(durationMinutes('2026-06-19T10:00:00Z', '2026-06-19T10:00:10Z')).toBe(1)
  })
  it('returns null when an endpoint is missing', () => {
    expect(durationMinutes('2026-06-19T10:00:00Z', null)).toBeNull()
    expect(durationMinutes(null, '2026-06-19T10:45:00Z')).toBeNull()
  })
})

describe('sessionDate', () => {
  it('formats a weekday + day + month in Dublin time', () => {
    // 2026-06-19 is a Friday
    expect(sessionDate('2026-06-19T10:00:00Z')).toBe('Fri, 19 Jun')
  })
  it('empty input → empty string', () => {
    expect(sessionDate(null)).toBe('')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/format.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`src/lib/format.js`:
```js
// Pure display formatters for champ-app surfaces. No IO.
// heart_rate_sessions.started_at / ended_at are real timestamptz instants
// (from the bridge / providers), so Date parsing + Dublin formatting is correct
// here — unlike bookings, which store wall-clock strings.

const SOURCE_LABELS = {
  ble_bridge: 'In-studio',
  apple_health: 'Apple Health',
  fitbit: 'Fitbit',
  whoop: 'Whoop',
  garmin: 'Garmin',
  manual: 'Manual',
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || 'Session'
}

/** Whole minutes between two ISO instants, minimum 1; null if either is missing. */
export function durationMinutes(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const ms = new Date(endedAt) - new Date(startedAt)
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.round(ms / 60000))
}

/** "Fri, 19 Jun" in Europe/Dublin; '' for empty/invalid input. */
export function sessionDate(startedAt) {
  if (!startedAt) return ''
  try {
    return new Intl.DateTimeFormat('en-IE', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin',
    }).format(new Date(startedAt))
  } catch {
    return ''
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/format.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.js src/lib/format.test.js
git commit -m "CHAMP-UI.1 P1 — pure display formatters (sourceLabel/durationMinutes/sessionDate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Dark token system (`globals.css` + `tailwind.config.js`)

**Files:** Modify (full rewrite) `src/app/globals.css` + `tailwind.config.js`

- [ ] **Step 1: Rewrite `src/app/globals.css`**

Replace the entire file with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --un1t-bg: #0B0B0C;
  --un1t-surface: #161618;
  --un1t-surface-2: #1F1F23;
  --un1t-border: #1F1F23;
  --un1t-text: #FFFFFF;
  --un1t-text-2: #8A8A93;
  --un1t-text-3: #5A5A61;
}

html, body { height: 100%; }

body {
  background: var(--un1t-bg);
  color: var(--un1t-text);
  font-family: var(--font-poppins), ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-reduced-motion: no-preference) {
  .u-rise { animation: u-rise 0.4s ease both; }
  @keyframes u-rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
}
```
(Removes the old `--background/--foreground` light vars + the `prefers-color-scheme` branch — the app is dark-only now.)

- [ ] **Step 2: Rewrite `tailwind.config.js`**

Replace the entire file with:
```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        un1t: {
          bg: 'var(--un1t-bg)',
          surface: 'var(--un1t-surface)',
          'surface-2': 'var(--un1t-surface-2)',
          border: 'var(--un1t-border)',
          text: 'var(--un1t-text)',
          'text-2': 'var(--un1t-text-2)',
          'text-3': 'var(--un1t-text-3)',
        },
      },
      borderRadius: { card: '20px' },
      fontFamily: {
        sans: ['var(--font-poppins)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
```
(`darkMode:'class'` lets the existing `dark:` utilities activate from the `dark` class added in Task 5; the red `champ` placeholder is gone.)

- [ ] **Step 3: Commit** (build is verified after the shell is wired, in Task 5)

```bash
git add src/app/globals.css tailwind.config.js
git commit -m "CHAMP-UI.1 P1 — dark-only token system (un1t.* + CSS vars; drop champ placeholder)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: UI primitives (`src/components/ui/`)

**Files:** Create `Card.jsx`, `Button.jsx`, `StatNumber.jsx`, `EffortNumber.jsx`, `ZoneBar.jsx`, `Chip.jsx`, `EmptyState.jsx`, `index.js` under `src/components/ui/`

- [ ] **Step 1: Create `src/components/ui/Card.jsx`**

```jsx
export default function Card({ children, className = '' }) {
  return (
    <section className={`rounded-card border border-un1t-border bg-un1t-surface p-5 ${className}`}>
      {children}
    </section>
  )
}
```

- [ ] **Step 2: Create `src/components/ui/Button.jsx`**

```jsx
const VARIANTS = {
  primary: 'bg-white text-un1t-bg hover:bg-white/90',
  ghost: 'border border-un1t-border text-un1t-text hover:bg-un1t-surface-2',
}

// Renders a <button> by default, or an <a> when `href` is given (styled CTAs).
export default function Button({ variant = 'primary', href, className = '', children, ...props }) {
  const cls = `inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${VARIANTS[variant] || VARIANTS.primary} ${className}`
  if (href) {
    return <a href={href} className={cls} {...props}>{children}</a>
  }
  return <button className={cls} {...props}>{children}</button>
}
```

- [ ] **Step 3: Create `src/components/ui/StatNumber.jsx`**

```jsx
// Big tabular hero number + optional unit label. The signature stat treatment.
export default function StatNumber({ value, unit, className = '' }) {
  return (
    <span className={`inline-flex items-end gap-1.5 ${className}`}>
      <span className="text-4xl font-extrabold leading-none tracking-tight tabular-nums">{value}</span>
      {unit && <span className="mb-1 text-xs font-medium text-un1t-text-2">{unit}</span>}
    </span>
  )
}
```

- [ ] **Step 4: Create `src/components/ui/EffortNumber.jsx`**

```jsx
import StatNumber from './StatNumber'

// Convenience preset: the UN1T-points hero used on sessions + the dashboard.
export default function EffortNumber({ points, className = '' }) {
  return <StatNumber value={points} unit="UN1T pts" className={className} />
}
```

- [ ] **Step 5: Create `src/components/ui/ZoneBar.jsx`**

```jsx
import { zoneBreakdown } from '@/lib/heart-rate'

// The 5-segment HR-zone bar — the only colour in the app. Reuses the canonical
// zoneBreakdown (zone ids + colours) so it never drifts from the rest of the app.
export default function ZoneBar({ zonesSeconds, className = '', height = 7 }) {
  const zones = zoneBreakdown(zonesSeconds)
  return (
    <div
      className={`flex overflow-hidden rounded-full bg-un1t-surface-2 ${className}`}
      style={{ height }}
    >
      {zones.map((z) => (z.percent > 0 ? (
        <div key={z.id} style={{ width: `${z.percent * 100}%`, backgroundColor: z.color }} />
      ) : null))}
    </div>
  )
}
```

- [ ] **Step 6: Create `src/components/ui/Chip.jsx`**

```jsx
export default function Chip({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-un1t-surface-2 px-2.5 py-1 text-xs font-medium text-un1t-text-2 ${className}`}>
      {children}
    </span>
  )
}
```

- [ ] **Step 7: Create `src/components/ui/EmptyState.jsx`**

```jsx
// icon is a lucide component (pass the component, not an element).
export default function EmptyState({ icon: Icon, title, children, className = '' }) {
  return (
    <div className={`flex flex-col items-center gap-2 py-8 text-center ${className}`}>
      {Icon && <Icon size={28} className="text-un1t-text-3" aria-hidden="true" />}
      {title && <p className="text-sm font-semibold text-un1t-text">{title}</p>}
      {children && <p className="max-w-xs text-xs text-un1t-text-2">{children}</p>}
    </div>
  )
}
```

- [ ] **Step 8: Create the barrel `src/components/ui/index.js`**

```js
export { default as Card } from './Card'
export { default as Button } from './Button'
export { default as StatNumber } from './StatNumber'
export { default as EffortNumber } from './EffortNumber'
export { default as ZoneBar } from './ZoneBar'
export { default as Chip } from './Chip'
export { default as EmptyState } from './EmptyState'
```

- [ ] **Step 9: Commit**

```bash
git add src/components/ui
git commit -m "CHAMP-UI.1 P1 — dark UI primitives (Card/Button/StatNumber/EffortNumber/ZoneBar/Chip/EmptyState)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Shell components (`TopBar`, `TabBar`, `AppShell`)

**Files:** Create `src/components/TopBar.jsx`, `src/components/TabBar.jsx`, `src/components/AppShell.jsx`

- [ ] **Step 1: Create `src/components/TopBar.jsx`**

```jsx
import Link from 'next/link'
import { User } from 'lucide-react'

export default function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-un1t-border bg-un1t-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-center justify-between px-5 py-3.5">
        <Link href="/" className="text-[15px] font-extrabold tracking-[0.18em] text-un1t-text">
          UN1T
        </Link>
        <Link
          href="/account"
          aria-label="Account"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-un1t-surface-2 text-un1t-text-2 transition hover:text-un1t-text"
        >
          <User size={18} aria-hidden="true" />
        </Link>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: Create `src/components/TabBar.jsx`**

```jsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Activity, User } from 'lucide-react'

const TABS = [
  { href: '/', label: 'Home', icon: Home, match: (p) => p === '/' },
  { href: '/sessions', label: 'Sessions', icon: Activity, match: (p) => p.startsWith('/sessions') },
  { href: '/account', label: 'Account', icon: User, match: (p) => p.startsWith('/account') },
]

export default function TabBar() {
  const pathname = usePathname() || '/'
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-un1t-border bg-un1t-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-stretch justify-around px-2">
        {TABS.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition ${active ? 'text-un1t-text' : 'text-un1t-text-3 hover:text-un1t-text-2'}`}
            >
              <Icon size={22} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
```

- [ ] **Step 3: Create `src/components/AppShell.jsx`**

```jsx
'use client'

import { usePathname } from 'next/navigation'
import TopBar from './TopBar'
import TabBar from './TabBar'

// Authenticated app surfaces get the TopBar + bottom TabBar chrome.
// Bare surfaces (login + the public share pages) render without it.
export default function AppShell({ children }) {
  const pathname = usePathname() || ''
  const bare = pathname === '/login' || pathname.startsWith('/login/') || pathname === '/share' || pathname.startsWith('/share/')
  if (bare) return <>{children}</>
  return (
    <>
      <TopBar />
      <div className="pb-24">{children}</div>
      <TabBar />
    </>
  )
}
```
(`AppShell` does not render its own `<main>` — each page keeps its `<main>`, so no nested-main and no double width constraint during the P1→P2 transition. The fixed `TabBar` is cleared by the `pb-24` on the content wrapper.)

- [ ] **Step 4: Commit**

```bash
git add src/components/TopBar.jsx src/components/TabBar.jsx src/components/AppShell.jsx
git commit -m "CHAMP-UI.1 P1 — app shell (TopBar + fixed bottom TabBar + pathname-gated AppShell)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the shell (`layout.jsx` + Poppins) + Account index

**Files:** Modify (full rewrite) `src/app/layout.jsx`; Create `src/app/account/page.jsx`

- [ ] **Step 1: Rewrite `src/app/layout.jsx`**

Replace the entire file with:
```jsx
import './globals.css'
import { Poppins } from 'next/font/google'
import AppShell from '@/components/AppShell'

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-poppins',
  display: 'swap',
})

export const metadata = {
  title: 'UN1T',
  description: 'Your heart-rate sessions, training, and account at UN1T.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`dark ${poppins.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
```

- [ ] **Step 2: Create `src/app/account/page.jsx` (the Account tab target)**

```jsx
import Link from 'next/link'
import { Activity, Target, Trophy, PlugZap, ChevronRight } from 'lucide-react'
import SignOutButton from '../SignOutButton'
import Card from '@/components/ui/Card'

export const dynamic = 'force-dynamic'

const LINKS = [
  { href: '/account/devices', label: 'Devices', icon: Activity },
  { href: '/account/goals', label: 'Goals', icon: Target },
  { href: '/account/achievements', label: 'Achievements', icon: Trophy },
  { href: '/account/integrations', label: 'Integrations', icon: PlugZap },
]

export default function AccountPage() {
  return (
    <main className="mx-auto max-w-2xl p-5 sm:p-6">
      <h1 className="text-2xl font-bold">Account</h1>
      <Card className="mt-5 divide-y divide-un1t-border p-0">
        {LINKS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-3 px-5 py-4 text-un1t-text transition hover:bg-un1t-surface-2"
          >
            <Icon size={18} className="text-un1t-text-2" aria-hidden="true" />
            <span className="flex-1 text-sm font-medium">{label}</span>
            <ChevronRight size={18} className="text-un1t-text-3" aria-hidden="true" />
          </Link>
        ))}
      </Card>
      <div className="mt-6">
        <SignOutButton />
      </div>
    </main>
  )
}
```
(`SignOutButton` lives at `src/app/SignOutButton.jsx` → relative import `../SignOutButton` from `src/app/account/page.jsx`. It's unstyled-for-dark today but inherits fine; P3 polishes it.)

- [ ] **Step 3: Build (the real gate — exercises Poppins fetch, the shell, primitives, alias)**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: compiles; route list includes `/account` and the existing routes. `next/font` fetches Poppins at build time (needs network — fine on the dev machine + Vercel).

- [ ] **Step 4: Run the full suite (regression guard)**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run`
Expected: PASS (existing 110 + the 6 new format tests = 116).

- [ ] **Step 5: Commit**

```bash
git add src/app/layout.jsx 'src/app/account/page.jsx'
git commit -m "CHAMP-UI.1 P1 — Poppins + dark <html> + AppShell wrap; Account index (tab target)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Ship Phase 1

**Files:** none (release).

- [ ] **Step 1: Full local checks**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run && npm run lint && npm run build
```
Expected: all green (116 tests; lint clean; build renders `/account` + all routes).

- [ ] **Step 2: Push + open the PR (base=main)**

```bash
git push -u origin champ-ui-p1-foundation
gh pr create --base main --head champ-ui-p1-foundation -R ivers9307-cyber/champ-app \
  --title "CHAMP-UI.1 P1 — dark performance foundation (tokens + Poppins + shell + primitives)" \
  --body "Phase 1 of the champ-app design refresh (CHAMP-UI.1). Lays the foundation; surfaces are restyled in P2/P3.

- Dark-only token system: CSS vars + \`un1t.*\` Tailwind colours; \`darkMode:'class'\` + \`<html class=dark>\` so the app reads coherently dark (every surface is already \`dark:\`-paired). Dropped the red \`champ\` placeholder.
- Poppins via \`next/font/google\` (self-hosted, no layout shift).
- \`src/components/ui/\` primitives: Card, Button, StatNumber, EffortNumber, ZoneBar (reuses zoneBreakdown — HR zone colours are the only colour), Chip, EmptyState.
- App shell: \`TopBar\` + fixed bottom \`TabBar\` (Home/Sessions/Account) via a pathname-gated \`AppShell\` (login + /share render bare). New minimal \`/account\` index.
- \`src/lib/format.js\` (+ tests).

Verified: 116 vitest pass, lint clean, \`next build\` green. No new deps beyond next/font (built-in). Slice-4 share card untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Watch the Vercel build (the remote gate — champ-app has no GitHub Actions), then merge**

```bash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch --interval 20
gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash --delete-branch
```
Confirm the squash landed on `origin/main`. champ-app auto-deploys to `app.champfitness.ie`.

---

## Self-review notes

- **Spec coverage (P1 scope):** token system + drop `champ` (Task 2) ✓; Poppins via next/font (Task 5) ✓; dark-only `globals.css` + dark body (Task 2/5) ✓; `src/components/ui/` primitives — Card/Button/StatNumber/EffortNumber/ZoneBar/Chip/EmptyState (Task 3) ✓; `src/lib/format.js` + tests (Task 1) ✓; the shell with bottom tab bar + login/share bare (Task 4/5) ✓. P2 (core surfaces) + P3 (remaining + dead-link fix) are deliberately out of this plan.
- **Deviation from spec mechanism (intentional, lower-risk):** the spec suggested an `(app)/` route group; this plan uses a pathname-gated `AppShell` instead — same outcome (chrome on authenticated pages, bare on login/share) with **no file moves / no import breakage**. Noted for the reviewer.
- **Placeholder scan:** every step has concrete code/commands. No TBD/"handle edge cases".
- **Type/name consistency:** tokens `un1t.{bg,surface,surface-2,border,text,text-2,text-3}` are defined once (Task 2) and used identically in every component; `radius-card` defined in Task 2, used in `Card` (Task 3); `--font-poppins` set in Task 5, referenced in `globals.css` body (Task 2) + Tailwind `sans` (Task 2); primitives' prop names (`zonesSeconds`, `points`, `value/unit`, `icon`) are consistent between definition and the Account-index usage of `Card`.
- **Dark-flip safety (verified):** every surface is `dark:`-paired and there are zero unpaired `bg-white` cards, so forcing `class="dark"` renders correctly. The only blemish — `hover:text-neutral-900` on a few muted links going dark-on-dark on hover — is cosmetic, mobile-irrelevant, and removed when each surface is restyled in P2/P3. No P1 action.
- **Repo conventions honoured:** vitest is node-env (no RTL) → TDD only for the pure `format.js`; components verified by `next build`. champ-app has no GitHub Actions → the Vercel PR build is the gate (real `next build` before merge). `next/font` adds no package dep. Bracketed paths quoted in git commands.
