# champ-app Native App — Phase 1 (Core Screens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the P0 placeholder tabs with the real **Home (dashboard)**, **Sessions list**, and **Session detail** (HR chart) screens — native RN, dark, reading the member's own data.

**Architecture:** Home + Sessions read **directly from Supabase** (customer-self RLS via the JWT) mirroring the web server-component queries. Session detail consumes the **existing `GET /api/sessions/[id]/report`** endpoint (purpose-built for the native app — returns the assembled report: summary, comparisons, highlight, next_action) via the `api()` helper, and reads `hr_samples` + `contact_achievements` directly. All three reuse `shared/heart-rate` (`zoneBreakdown`) + `shared/format`. The HR chart is the web `HrChart` math ported to `react-native-svg`.

**Tech Stack:** Expo/RN, expo-router, NativeWind dark tokens, react-native-svg, the `shared/` seam. Repo: **champ-app** (`mobile/`). Branch off main (has P0).

**Reference (read for content/data shape — do NOT import from src/):** the web screens `champ-app/src/app/page.jsx` (dashboard), `src/app/sessions/page.jsx` (list), `src/app/sessions/[id]/page.jsx` (detail + `HrChart`/`downsample` maths). Translate their JSX → RN + NativeWind; reuse their query column sets verbatim.

> **Gate:** `npx expo export --platform all` (headless bundle) + web `vitest+lint+build` stays green. No device here.

---

## Shared conventions for this phase

- **Data:** use the `supabase` client from `mobile/lib/supabase` for direct reads; `api()` from `mobile/lib/api` for the report endpoint. RLS scopes to the member automatically — just `.select(...).order(...)` (no manual contact filter needed; the web does the same).
- **Reuse:** `import { zoneBreakdown } from '../../shared/heart-rate'` and `import { sourceLabel, durationMinutes, sessionDate } from '../../shared/format'` (paths relative to the screen file — verify depth). NEVER import from `../../src/lib`.
- **Styling:** NativeWind dark classes (`bg-un1t-bg`, `bg-un1t-surface`, `text-un1t-text`, `text-un1t-text-2`, `text-un1t-text-3`, `border-un1t-border`, `bg-un1t-surface-2`). Reuse the P0 `mobile/components/ui/{Screen,Card,Button}.jsx`; add small RN components as needed (a `ZoneBar` RN component, a `StatTile`).
- **Zone bar (RN):** a flex `<View className="flex-row h-1.5 rounded-full overflow-hidden bg-un1t-surface-2">` with child `<View style={{ flex: z.percent, backgroundColor: z.color }}>` per zone where `percent>0` (use `flex` proportional widths, not `%` strings — RN handles flex). Build a `mobile/components/ui/ZoneBar.jsx` taking `zonesSeconds`.
- **Loading/empty/error:** each screen shows an `ActivityIndicator` while loading, a dark empty state when no data, and a graceful message on error (never a raw error).
- **Money/number rounding:** round any displayed number.

---

### Task 1: ZoneBar primitive + Home + Sessions screens

**Files:** Create `mobile/components/ui/ZoneBar.jsx`; rewrite `mobile/app/(tabs)/index.jsx` (Home) + `mobile/app/(tabs)/sessions.jsx` (list).

- [ ] **Step 1: Branch**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b champ-native-p1-core-screens
```

- [ ] **Step 2: `mobile/components/ui/ZoneBar.jsx`**

```jsx
import { View } from 'react-native'
import { zoneBreakdown } from '../../../shared/heart-rate'

export default function ZoneBar({ zonesSeconds, height = 6, className = '' }) {
  const zones = zoneBreakdown(zonesSeconds)
  return (
    <View className={`flex-row overflow-hidden rounded-full bg-un1t-surface-2 ${className}`} style={{ height }}>
      {zones.map((z) => (z.percent > 0 ? (
        <View key={z.id} style={{ flex: z.percent, backgroundColor: z.color }} />
      ) : null))}
    </View>
  )
}
```
(Verify the relative depth to `shared/` from `mobile/components/ui/` is `../../../shared` — `ui`→`components`→`mobile`→repo root→`shared`. Adjust if `expo export` can't resolve it; metro watches `../shared`.)

- [ ] **Step 3: Home — `mobile/app/(tabs)/index.jsx`**

Read `src/app/page.jsx` for the exact queries + sections. Rebuild in RN:
- Load on mount (a `load()` in `useEffect`, with `useFocusEffect` from `expo-router` for refresh-on-return): the member's `contact` (already on `useAuth()`), the 3 most-recent sessions (`heart_rate_sessions.select('id, started_at, ended_at, source, peak_hr_bpm, zones_seconds, effort_points').order('started_at',{ascending:false}).limit(3)`), active goals + 35d goal sessions (mirror the web's `contact_goals` + sessions query), and achievement counts (mirror the web's two `count` queries + latest 3). Keep the SAME columns/filters as the web.
- Render with `Screen`/`Card`: a `Hi, {firstName}` header, a "Recent sessions" card (rows: `sessionDate` + `durationMinutes` + `sourceLabel`, the effort number, `<ZoneBar>`), each row `Pressable` → `router.push('/sessions/'+id)`; a "Connect a device" card (a `Button` → for now a no-op or `router.push` to a placeholder — devices screen is P2; use a disabled/"coming soon" note); achievements card (`X / Y` + recent badge chips using `@expo/vector-icons` Ionicons); goals card (progress bars: track `bg-un1t-surface-2`, fill `bg-white`/`bg-un1t-text-3`). Use `computeProgress`/`GOAL_DEFS` from `../../../shared/goals` for goal progress.
- Empty/loading/error states per the conventions.

- [ ] **Step 4: Sessions list — `mobile/app/(tabs)/sessions.jsx`**

Read `src/app/sessions/page.jsx`. Rebuild in RN:
- Load all sessions (`heart_rate_sessions.select('id, started_at, ended_at, source, avg_hr_bpm, peak_hr_bpm, zones_seconds, effort_points').order('started_at',{ascending:false}).limit(100)`).
- Render a `FlatList` (or mapped `ScrollView`) of session cards: each a `Pressable` `Card` → `router.push('/sessions/'+id)`, showing `sessionDate`, the time + `durationMinutes` + `sourceLabel` sub-line, the effort number, the "Mostly {topZone}" line (compute `topZone` from `zoneBreakdown`, keep `style={{color: topZone.color}}`), avg/peak, and `<ZoneBar>`.
- Empty state → a `Card` with an Ionicon + "No sessions yet" + a note (devices screen is P2).

- [ ] **Step 5: Verify + commit**

```bash
cd /Users/richardivers/code/champ-app/mobile && npx expo export --platform all && rm -rf dist
```
(Long timeout. Must bundle clean.) Then:
```bash
cd /Users/richardivers/code/champ-app
noglob git add 'mobile/app/(tabs)/index.jsx' 'mobile/app/(tabs)/sessions.jsx' mobile/components/ui/ZoneBar.jsx
git commit -m "CHAMP-NATIVE.1 P1 — Home + Sessions screens (direct Supabase reads; shared zones/format; ZoneBar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Session detail + HR chart

**Files:** Create `mobile/app/sessions/[id].jsx` (detail, a root-stack route reached from the lists) + `mobile/components/HrChart.jsx`; register the route's header in `mobile/app/_layout.jsx`.

- [ ] **Step 1: `mobile/components/HrChart.jsx`** — port the web `HrChart` to react-native-svg

Read the `HrChart` function in `src/app/sessions/[id]/page.jsx`. Port verbatim maths (`W/H/PAD`, `t0/t1/tSpan`, `yMin/yMax/ySpan`, the points mapping, the zone-band rects) but render with `react-native-svg`:
```jsx
import { View } from 'react-native'
import Svg, { Rect, Polyline } from 'react-native-svg'

export default function HrChart({ samples, maxHr }) {
  const W = 700, H = 180, PAD = 12
  const t0 = new Date(samples[0].recorded_at).getTime()
  const t1 = new Date(samples[samples.length - 1].recorded_at).getTime()
  const tSpan = Math.max(1, t1 - t0)
  const yMin = 50
  const yMax = Math.max((maxHr || 0) + 10, 180)
  const ySpan = yMax - yMin
  const pts = samples.map((s) => {
    const x = PAD + ((new Date(s.recorded_at).getTime() - t0) / tSpan) * (W - 2 * PAD)
    const y = H - PAD - ((Math.max(yMin, Math.min(yMax, s.bpm)) - yMin) / ySpan) * (H - 2 * PAD)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const bands = [
    { from: 0, to: 0.60, color: '#9CA3AF' }, { from: 0.60, to: 0.70, color: '#3B82F6' },
    { from: 0.70, to: 0.80, color: '#10B981' }, { from: 0.80, to: 0.90, color: '#F59E0B' },
    { from: 0.90, to: 1.10, color: '#EF4444' },
  ].map((b) => {
    const yTop = H - PAD - ((Math.max(yMin, Math.min(yMax, b.to * (maxHr || 0))) - yMin) / ySpan) * (H - 2 * PAD)
    const yBot = H - PAD - ((Math.max(yMin, Math.min(yMax, b.from * (maxHr || 0))) - yMin) / ySpan) * (H - 2 * PAD)
    return { ...b, y: Math.min(yTop, yBot), height: Math.abs(yBot - yTop) }
  })
  return (
    <View className="mt-3 rounded-lg overflow-hidden">
      <Svg viewBox={`0 0 ${W} ${H}`} width="100%" height={176}>
        {bands.map((b, i) => (
          <Rect key={i} x={PAD} y={b.y} width={W - 2 * PAD} height={b.height} fill={b.color} fillOpacity={0.12} />
        ))}
        <Polyline points={pts} fill="none" stroke="#FFFFFF" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </View>
  )
}
```
Add a `downsample(samples, max)` helper (copy from the web file) inline in the detail screen before passing to `HrChart`.

- [ ] **Step 2: `mobile/app/sessions/[id].jsx`** — the detail screen

- `useLocalSearchParams()` for `id`. On mount: `const out = await api('/api/sessions/' + id + '/report')` → the report (check the route's response shape in `src/app/api/sessions/[id]/report/route.js` and read `out.report` or `out` accordingly). In parallel, direct Supabase: `hr_samples.select('recorded_at, bpm').eq('session_id', id).order('recorded_at',{ascending:true}).limit(3600)` → `downsample(...,600)`; and `contact_achievements.select('id, earned_at, rule:achievement_rules(name, icon)').eq('source_session_id', id)`.
- Render (read `src/app/sessions/[id]/page.jsx` for the exact sections + the comparison text logic — port that logic verbatim): a back affordance (a `Pressable` "‹ Back" → `router.back()`, top-left), the effort hero (`report.summary.effort_points` + "UN1T Points"), the highlight (monochrome Card + Ionicon star), "How this compares" (the three comparison blocks — `vs_this_class`/`vs_category`/`vs_recent` — ported verbatim from the web), a 3-up stat row (duration/avg/peak), achievements unlocked (Cards/chips), the `<HrChart>` (or a "no per-second data" note when `samples.length<=1`), the zone breakdown (rows: swatch + label + `<ZoneBar single>`-style bar + min·%), and the `next_action` CTA (`report.next_action` → a `Button` that opens the URL via `Linking.openURL` / `expo-web-browser`). Use the report payload's field names exactly (match the web's `report.summary.*`, `report.comparisons.*`, `report.highlight`, `report.next_action`).
- Native share: add a "Share my session" `Button` (only when the session is ended) that calls the existing mint endpoint via `api('/api/sessions/'+id+'/share',{method:'POST'})` then RN `Share.share({ url })`. (Mirror the web `ShareSessionButton` logic; the mint route already gates on `ended_at`.)

- [ ] **Step 3: Register the detail route header** — in `mobile/app/_layout.jsx`, add inside the `<Stack>` a screen so the detail gets a dark header (or rely on the in-screen back affordance). Add:
```jsx
<Stack.Screen name="sessions/[id]" options={{ headerShown: false }} />
```
(Header hidden; the screen draws its own SafeAreaView + back. This avoids the cross-navigator auto-back gap.)

- [ ] **Step 4: Verify + commit**

```bash
cd /Users/richardivers/code/champ-app/mobile && npx expo export --platform all && rm -rf dist
cd /Users/richardivers/code/champ-app
noglob git add 'mobile/app/sessions/[id].jsx' mobile/components/HrChart.jsx mobile/app/_layout.jsx
git commit -m "CHAMP-NATIVE.1 P1 — session detail (report API + samples) + HR chart (react-native-svg)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Ship Phase 1

- [ ] **Step 1: Final checks**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run && npm run lint && npm run build           # web unaffected
cd mobile && npx expo export --platform all && rm -rf dist  # mobile bundles
```

- [ ] **Step 2: Push + PR**

```bash
cd /Users/richardivers/code/champ-app
git push -u origin champ-native-p1-core-screens
gh pr create --base main --head champ-native-p1-core-screens -R ivers9307-cyber/champ-app \
  --title "CHAMP-NATIVE.1 P1 — core screens (Home / Sessions / Session detail + HR chart)" \
  --body "Phase 1 of the native app. Real screens replace the P0 placeholders.

- Home + Sessions read direct from Supabase (customer RLS) mirroring the web; reuse shared zoneBreakdown/format; new RN ZoneBar.
- Session detail consumes GET /api/sessions/[id]/report (the report API built for the native app) for comparisons/highlight/next_action, reads hr_samples + achievements direct, renders the HR chart in react-native-svg (web HrChart maths ported), and offers native share via the existing mint endpoint.
- Dark NativeWind throughout; loading/empty/error states.

Verified: web vitest+lint+build green; \`expo export --platform all\` bundles clean. Device QA deferred (needs eas init + OTP email template).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Watch Vercel (web gate) + merge**

```bash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch --interval 20
gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash --delete-branch
```

---

## Self-review notes

- **Spec coverage (P1):** Home, Sessions, Session detail (HR chart) — the three "read screens" ✓. Account screens = P2; push = P3; store = P4.
- **Report reuse:** the detail screen consumes the existing report API (the documented native-app hook) rather than re-implementing the loader — the only place comparisons/next_action are assembled, kept server-side; RN reuses only the pure `zoneBreakdown`/`format` from `shared/`.
- **No src/lib imports from mobile:** all shared reuse goes through `../../../shared/*`; verify the relative depth at `expo export` time.
- **Chart:** web `HrChart` maths ported verbatim to react-native-svg (`Rect` bands + white `Polyline`); `downsample` copied.
- **Navigation:** detail is a root-stack route (`app/sessions/[id].jsx`) with an in-screen back (avoids the cross-navigator auto-back gap noted in the staff app).
- **Gate:** `expo export` headless bundle + the web build; device QA deferred until eas init + the OTP template are set up.
- **Field-name risk:** the report payload's exact keys (`report.summary.*` etc.) + the `/report` route's response envelope must be confirmed against the actual files while implementing (the plan says to read them) — not guessed.
