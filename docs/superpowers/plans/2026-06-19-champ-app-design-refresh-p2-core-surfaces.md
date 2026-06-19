# champ-app Design Refresh — Phase 2 (Core Surfaces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the three showcase surfaces — dashboard, sessions list, session-report view (+ the Share button) — onto the P1 dark token system and primitives, **preserving every bit of data-loading and Slice 1–4 logic** (it's a presentational restyle, not a behaviour change).

**Architecture:** Replace inline neutral Tailwind with `un1t.*` tokens; wrap card `<section>`s in the `Card` primitive; use `EffortNumber`/`ZoneBar`/`EmptyState`/`Button`/`Chip` from `@/components/ui` and the `sourceLabel`/`durationMinutes`/`sessionDate` helpers from `@/lib/format`. Honour the monochrome rule: the **only colour is the HR zone palette** (zone bars, the HR-chart bands, zone-breakdown swatches) — recolour the emerald "highlight" and amber "achievements" boxes to neutral `un1t` surfaces with a white lucide icon.

**Tech Stack:** Next.js 14.2 App Router, Tailwind 3.4, lucide-react, the P1 primitives. Repo: **champ-app** (`/Users/richardivers/code/champ-app`). Branch off main (which has P1).

**Spec:** `un1t-crm/docs/superpowers/specs/2026-06-19-champ-app-design-refresh-design.md` · **Builds on:** P1 (`…-p1-foundation.md`).

---

## Shared restyle rules (apply on every surface)

**Token mapping** (old → new):
| Old (inline neutral) | New (`un1t`) |
|---|---|
| `bg-white dark:bg-neutral-900` (card) | `bg-un1t-surface` (or wrap in `<Card>`) |
| `border-neutral-200 dark:border-neutral-800` | `border-un1t-border` |
| `text-neutral-500` / muted | `text-un1t-text-2` |
| `text-neutral-700 dark:text-neutral-300` (emphasis-muted) | `text-un1t-text-2` (or `text-un1t-text` if it's a value) |
| `text-neutral-900` / default heading | `text-un1t-text` |
| bar track `bg-neutral-100 dark:bg-neutral-800` | `bg-un1t-surface-2` |
| primary button `bg-neutral-900 … dark:bg-white …` | `<Button>` (white primary) or `<Button variant="ghost">` |
| `rounded-2xl border …` card | `<Card>` (which is `rounded-card border-un1t-border bg-un1t-surface p-5`) |

**Primitives:** import from `@/components/ui` — `Card, Button, StatNumber, EffortNumber, ZoneBar, Chip, EmptyState`. **Formatters:** import from `@/lib/format` — `sourceLabel, durationMinutes, sessionDate`. Remove each file's local `SOURCE_LABEL` map + inline duration/date math and call the helpers (DRY). Keep the per-file `ZoneBar`/`Stat`/etc. *only* where the primitive doesn't cover it (the session view's `ZoneRow` + `HrChart` stay local — they're surface-specific; just restyle their classes).

**Monochrome rule:** the only colour anywhere is `z.color` (zone colours from `zoneBreakdown`) on zone bars, the HR-chart zone bands, and the zone-breakdown swatches. Everything else is `un1t` ink + white. Recolour the emerald highlight box and amber achievement boxes to `un1t-surface` with a white lucide icon (see per-surface notes).

**Navigation cleanup:** the bottom `TabBar` (P1) now owns top-level nav, so remove redundant in-page nav: the dashboard header's `SignOutButton` (sign-out now lives on `/account`) and the sessions-list "← Dashboard" link. Keep the session-detail "← All sessions" link (intra-section back for deep links), restyled to `text-un1t-text-2`.

**Dead-link fix:** `/account/connections` does not exist. Repoint both "Connect a device" CTAs (dashboard `ConnectDeviceCard`, sessions-list `EmptyState`) to **`/account/devices`** (the strap/watch registration surface).

**Width:** set each page's `<main>` to `mx-auto max-w-2xl p-5 sm:p-6` (matches the P1 `TopBar`/`TabBar` max-width).

**Motion (optional, subtle):** add `className="u-rise"` (the P1 globals.css entrance util) to the top-level page wrapper or first card. Reduced-motion-safe by construction.

**PRESERVE VERBATIM (do not touch the logic):** all Supabase queries + their `select` columns; `loadSessionReport` usage + the `report?.highlight` / `comparisons.{vs_this_class,vs_category,vs_recent}` / `next_action` IIFE text logic; the achievements query + `Icons[u.rule.icon]` resolution; `downsample()` + the `HrChart` math (x/y mapping, zone-band math); the `session.ended_at &&` gate on the Share button; `notFound()`/`redirect()`/error + no-contact states (restyle their classes only).

---

### Task 1: Restyle the dashboard

**Files:** Modify `src/app/page.jsx`

- [ ] **Step 1: Branch + imports**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b champ-ui-p2-core-surfaces
```
At the top of `src/app/page.jsx`: keep the data imports; add `import { Card, Button, EffortNumber, ZoneBar, EmptyState, Chip } from '@/components/ui'` and `import { sourceLabel, durationMinutes, sessionDate } from '@/lib/format'`. Remove the local `SOURCE_LABEL` const and the `import SignOutButton from './SignOutButton'`.

- [ ] **Step 2: Restyle the surface (preserve all queries + the `contact`/`recent`/`activeGoals`/`goalSessions`/`latestAch`/counts logic)**

Apply the shared rules across the component + its cards. Concretely:
- **Header:** drop the `<SignOutButton/>` and the email line; keep `Hi, {firstName}` as `text-2xl font-bold text-un1t-text`, add a muted subtitle (e.g. `text-sm text-un1t-text-2` with a short greeting). Page wrapper → `<main className="mx-auto max-w-2xl p-5 sm:p-6 u-rise">`.
- **Error + no-contact states:** restyle their `<main>` + text to `un1t` tokens (keep the messages; `text-un1t-text` heading, `text-un1t-text-2` body). The no-contact state keeps a way to sign out — render `<Button href="/account" variant="ghost">Account</Button>` instead of the removed inline `SignOutButton` (sign-out is on `/account`).
- **`RecentSessionsCard`:** wrap in `<Card className="sm:col-span-2">`; header row "Recent sessions" (`text-base font-semibold text-un1t-text`) + a `See all →` `Link` (`text-xs font-medium text-un1t-text-2 hover:text-un1t-text`); empty → `<EmptyState icon={Icons.HeartPulse} title="No sessions yet">…</EmptyState>`. Each `RecentSessionItem`: use `sessionDate(session.started_at)` + `durationMinutes(...)` + `sourceLabel(...)`; the effort number → `<EffortNumber points={session.effort_points} className="text-base" />` (or keep the small inline number styled `text-un1t-text`); replace the inline zone bar with `<ZoneBar zonesSeconds={session.zones_seconds} height={4} className="mt-2" />`; row container → `border-un1t-border bg-un1t-surface hover:border-un1t-surface-2`.
- **`ConnectDeviceCard`:** `<Card>`; copy in `un1t` tokens; CTA → `<Button href="/account/devices" className="mt-5 w-full">Connect →</Button>`; "Coming soon …" → `text-un1t-text-3`.
- **`AchievementsCard`:** `<Card>`; monochrome — `Icons.Trophy` in `text-un1t-text` (not amber); the `{unlocked}/{total}` number `text-un1t-text`; recent badges as `<Chip>` (drop the amber bg) each with its `Icon`.
- **`GoalsCard`:** `<Card>`; `Icons.Target` in `text-un1t-text`; progress track `bg-un1t-surface-2`, fill `bg-white` when complete else `bg-un1t-text-3` (monochrome — progress is not HR data, so no zone colour); labels `text-un1t-text-2`.

- [ ] **Step 3: Build + commit**

```bash
cd /Users/richardivers/code/champ-app && npm run build
```
Expected: compiles; `/` renders. Then:
```bash
git add 'src/app/page.jsx'
git commit -m "CHAMP-UI.1 P2 — restyle dashboard on dark primitives (monochrome; format helpers; fix connect link)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Restyle the sessions list

**Files:** Modify `src/app/sessions/page.jsx`

- [ ] **Step 1: Imports**

Add `import { Card, Button, EffortNumber, ZoneBar, EmptyState } from '@/components/ui'` + `import { sourceLabel, durationMinutes, sessionDate } from '@/lib/format'`. Remove the local `SOURCE_LABEL` const and the local `ZoneBar` function (use the primitive). Keep `zoneBreakdown` import ONLY if still needed for `topZone` (it is — see below).

- [ ] **Step 2: Restyle (preserve the query + `topZone` logic)**

- Page `<main>` → `mx-auto max-w-2xl p-5 sm:p-6 u-rise`. Header: keep "Your sessions" (`text-2xl font-bold text-un1t-text`) + subtitle (`text-un1t-text-2`); **remove the "← Dashboard" link**.
- Error state → `un1t` tokens; recolour the `red-*` error box to `border-un1t-border bg-un1t-surface text-un1t-text-2` (keep the message).
- `EmptyState` → use the primitive: `<EmptyState icon={Icons.HeartPulse} title="No sessions yet">Connect a device, or pair a chest strap at the studio…</EmptyState>` with a `<Button href="/account/devices">Connect a device</Button>` below (import `* as Icons from 'lucide-react'`). **Fix the dead link** (`/account/connections` → `/account/devices`).
- `SessionRow`: row `<Link>` container → `<Card>`-like via `block rounded-card border border-un1t-border bg-un1t-surface p-4 transition hover:border-un1t-surface-2`; date via `sessionDate(...)` (`text-un1t-text`); the time/duration/source sub-line via `durationMinutes(...)` + `sourceLabel(...)` (`text-un1t-text-2`); effort number `text-un1t-text` with `UN1T` in `text-un1t-text-2`; the "Mostly {topZone.label}" keeps `style={{ color: topZone.color }}` (zone colour is allowed); avg/peak line `text-un1t-text-2` with the values in `text-un1t-text`; the inline zone bar → `<ZoneBar zonesSeconds={session.zones_seconds} className="mt-3" height={6} />`. Keep computing `topZone` from `zoneBreakdown(session.zones_seconds)`.

- [ ] **Step 3: Build + commit**

```bash
cd /Users/richardivers/code/champ-app && npm run build
git add 'src/app/sessions/page.jsx'
git commit -m "CHAMP-UI.1 P2 — restyle sessions list (ZoneBar/EmptyState primitives; format helpers; fix connect link)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Restyle the session-report view + Share button

**Files:** Modify `src/app/sessions/[id]/page.jsx` + `src/components/ShareSessionButton.jsx`

- [ ] **Step 1: Imports**

In `sessions/[id]/page.jsx` add `import { Card, Button, StatNumber, Chip } from '@/components/ui'` + `import { sourceLabel, durationMinutes, sessionDate } from '@/lib/format'`. Remove the local `SOURCE_LABEL` const. Keep `import * as Icons from 'lucide-react'`, `zoneBreakdown`, `loadSessionReport`, `ShareSessionButton`, both supabase clients.

- [ ] **Step 2: Restyle the page (PRESERVE all queries, `loadSessionReport`, the comparison IIFEs, achievements, `downsample`, `HrChart` math, the `session.ended_at` gate)**

- `<main>` → `mx-auto max-w-2xl p-5 sm:p-6`. Back link → `text-sm font-medium text-un1t-text-2 hover:text-un1t-text`.
- **Header:** date/time/source line via `sessionDate(...)` + a time string + `sourceLabel(...)` in `text-un1t-text-2`. The effort hero → `<StatNumber value={Number.isFinite(session.effort_points) ? session.effort_points : '—'} unit="UN1T Points" className="mt-1" />`.
- **Highlight** (`report?.highlight`): recolour to monochrome — `<Card className="mt-4 flex items-center gap-2"><Icons.Star size={16} className="shrink-0 text-un1t-text" /><span className="text-sm font-medium text-un1t-text">{report.highlight.message}</span></Card>`.
- **"How this compares"** (`report &&`): wrap in `<Card className="mt-6">`; heading `text-sm font-semibold text-un1t-text`; **keep the three comparison `<li>` IIFEs byte-for-byte**, only swap their `text-neutral-700 dark:text-neutral-300` → `text-un1t-text-2` and the no-data `text-neutral-500` → `text-un1t-text-3`.
- **Stat row:** restyle the local `Stat` component (Step 4) — keep the 3-up grid.
- **Achievements unlocked** (`unlocked.length > 0`): recolour to monochrome — `<Card className="mt-6">` with heading `<Icons.Sparkles size={14} className="text-un1t-text" /> Unlocked in this session` (`text-un1t-text`); each item → a bordered pill on `un1t-surface-2`: `flex shrink-0 items-center gap-2 rounded-xl border border-un1t-border bg-un1t-surface-2 px-3 py-2`, icon circle `bg-un1t-surface text-un1t-text`, name `text-un1t-text`. Keep the `Icons[u.rule.icon] || Icons.Award` logic.
- **HR chart section:** `<Card className="mt-8">`; heading `text-un1t-text`; no-data copy `text-un1t-text-2`. In `HrChart` (Step 4) change the polyline class to `text-un1t-text` (white line on dark); keep the zone-band rects (zone colours at low opacity — they're the allowed colour).
- **Zone breakdown:** `<Card className="mt-6">`; heading `text-un1t-text`; footer note `text-un1t-text-2` with the max-HR value in `text-un1t-text`. Restyle `ZoneRow` (Step 4).
- **next_action CTA:** `{report?.next_action && (<section className="mt-6 text-center"><Button href={report.next_action.url} target="_blank" rel="noreferrer">{report.next_action.label}</Button></section>)}`.
- **Share button:** unchanged wiring `{session.ended_at && <ShareSessionButton sessionId={session.id} />}` (restyle the component itself in Step 5).

- [ ] **Step 3: Restyle the local helper components in `sessions/[id]/page.jsx`**

`Stat`:
```jsx
function Stat({ label, value, unit }) {
  return (
    <div className="rounded-card border border-un1t-border bg-un1t-surface p-4">
      <p className="text-xs uppercase tracking-wide text-un1t-text-3">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-un1t-text">
        {value}
        {unit && <span className="ml-1 text-xs font-medium text-un1t-text-2">{unit}</span>}
      </p>
    </div>
  )
}
```
`ZoneRow` (keep `min`/`percent` math; restyle):
```jsx
function ZoneRow({ zone }) {
  const min = Math.round(zone.seconds / 60)
  return (
    <li className="flex items-center gap-3">
      <div className="flex w-20 shrink-0 items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: zone.color }} />
        <span className="text-xs font-semibold text-un1t-text">{zone.label}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-un1t-surface-2">
          <div className="h-full rounded-full" style={{ width: `${zone.percent * 100}%`, backgroundColor: zone.color }} />
        </div>
      </div>
      <div className="w-20 shrink-0 text-right text-xs tabular-nums text-un1t-text-2">
        {min} min · {Math.round(zone.percent * 100)}%
      </div>
    </li>
  )
}
```
`HrChart`: keep ALL the math (`W/H/PAD`, `t0/t1/tSpan`, `yMin/yMax/ySpan`, `pts`, `zoneBands`) byte-for-byte; change ONLY the polyline's `className="text-neutral-700 dark:text-neutral-300"` → `className="text-un1t-text"`. The container `rounded-lg` is fine.

- [ ] **Step 4: Restyle `src/components/ShareSessionButton.jsx`** (keep ALL the client logic — `share()`, `navigator.share`/clipboard, `AbortError` handling, the `busy/done/error` state)

Change only the button + message classes to `un1t`:
- button → `inline-flex items-center gap-2 rounded-xl border border-un1t-border px-5 py-3 text-sm font-semibold text-un1t-text transition hover:bg-un1t-surface-2 disabled:opacity-50`
- "Link copied" → `text-xs text-un1t-text-2`; error → keep a readable error colour `text-xs text-red-400` (an error message is a legitimate semantic exception to monochrome; red-400 is readable on dark).

- [ ] **Step 5: Build + commit**

```bash
cd /Users/richardivers/code/champ-app && npm run build
noglob git add 'src/app/sessions/[id]/page.jsx' src/components/ShareSessionButton.jsx
git commit -m "CHAMP-UI.1 P2 — restyle session-report view + Share button (monochrome; preserve Slice 1-4 logic)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Ship Phase 2

**Files:** none (release).

- [ ] **Step 1: Full local checks**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run && npm run lint && npm run build
```
Expected: 116 tests pass (no test changes — pure restyle); lint clean; build green (all routes).

- [ ] **Step 2: Push + PR**

```bash
git push -u origin champ-ui-p2-core-surfaces
gh pr create --base main --head champ-ui-p2-core-surfaces -R ivers9307-cyber/champ-app \
  --title "CHAMP-UI.1 P2 — restyle core surfaces (dashboard / sessions / session report)" \
  --body "Phase 2 of the champ-app design refresh. Pure presentational restyle of the three showcase surfaces onto the P1 dark primitives — no data/logic change.

- Dashboard, sessions list, session-report view + ShareSessionButton restyled to \`un1t\` tokens + Card/Button/ZoneBar/EmptyState/StatNumber/Chip primitives + the \`format\` helpers.
- Monochrome honoured: HR zone colours are the only colour (zone bars, HR-chart bands, breakdown swatches); the old emerald 'highlight' + amber 'achievements' boxes are now neutral surfaces with white icons.
- Nav cleanup (TabBar owns top-level nav): dropped the dashboard sign-out + sessions back-link. Fixed the dead \`/account/connections\` CTA → \`/account/devices\`.
- All Slice 1–4 logic preserved verbatim (report comparisons, next_action, achievements, HR chart, the ended_at share gate).

Verified: 116 vitest, lint clean, \`next build\` green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Watch Vercel (only remote gate) + merge**

```bash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch --interval 20
gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash --delete-branch
```

---

## Self-review notes

- **Spec coverage (P2):** dashboard ✓ (Task 1), sessions list ✓ (Task 2), session-report view ✓ (Task 3) — the three "core surfaces" from the spec's P2. Account pages / login / share-page chrome are P3.
- **Logic preservation:** the preserve-verbatim list (queries, `loadSessionReport`, comparison IIFEs, achievements resolution, `downsample`/`HrChart` math, the `ended_at` share gate, redirect/notFound/error states) is called out globally + per task; restyle changes classes/primitives only.
- **Monochrome consistency:** the only colour is `z.color` (zone palette) on zone bars / chart bands / breakdown swatches; highlight + achievements de-coloured; the one semantic exception is the Share error message (`text-red-400`) — documented.
- **DRY:** local `SOURCE_LABEL` maps + inline duration/date math removed in favour of `@/lib/format`; inline zone bars replaced by the `ZoneBar` primitive (the sessions-list local `ZoneBar` fn is deleted; the session-view `ZoneRow`/`HrChart` stay local as they're surface-specific).
- **Type/name consistency:** primitive prop names match P1 (`zonesSeconds`, `points`, `value`/`unit`, `href`, `icon`); `format` exports (`sourceLabel`/`durationMinutes`/`sessionDate`) match their P1 signatures.
- **Dead-link fix** applied on both P2 surfaces that carried it (dashboard + sessions empty state) → `/account/devices`.
- **Gate:** champ-app has no GitHub Actions → Vercel build is the remote gate; `next build` run after every task locally.
