# champ-app Design Refresh — Phase 3 (Remaining Surfaces) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish CHAMP-UI.1 — restyle the remaining surfaces (the four account sub-pages + their manager components, the login screen, and the public share-page chrome) onto the dark monochrome system, and complete the dead-link audit.

**Architecture:** Same proven restyle as P2 — replace inline neutral Tailwind with `un1t.*` tokens + the `@/components/ui` primitives + `@/lib/format` helpers, preserving all data/logic/state. The share-card OG image (`opengraph-image.jsx`) is NOT touched.

**Tech Stack:** Next.js 14.2 App Router, Tailwind 3.4, lucide-react, the P1 primitives. Repo: **champ-app**. Branch off main (which has P1+P2).

**Spec:** `…specs/2026-06-19-champ-app-design-refresh-design.md` · **Builds on:** P1 + P2.

---

## Shared restyle rules (identical to P2 — apply on every file)

**Token map:** `bg-white dark:bg-neutral-900`→`bg-un1t-surface` (or wrap in `<Card>`); `border-neutral-200 dark:border-neutral-800`→`border-un1t-border`; `text-neutral-500`→`text-un1t-text-2`; `text-neutral-700 dark:text-neutral-300`→`text-un1t-text-2` (value→`text-un1t-text`); `text-neutral-900`/default→`text-un1t-text`; track `bg-neutral-100 dark:bg-neutral-800`→`bg-un1t-surface-2`; `bg-neutral-50`→`bg-un1t-surface-2`; primary CTA `bg-neutral-900 … dark:bg-white …`→`<Button>`.

**Primitives** from `@/components/ui`: `Card, Button, StatNumber, EffortNumber, ZoneBar, Chip, EmptyState`. **Helpers** from `@/lib/format`: `sourceLabel, durationMinutes, sessionDate` (use them where a file does inline source/duration/date formatting; remove local `SOURCE_LABEL` maps).

**Monochrome rule:** the ONLY colour is the HR zone palette (`z.color`). De-colour amber/emerald/blue accents to `un1t` ink/white + a white lucide icon. Two **semantic exceptions allowed** (readable on dark): destructive/error text `text-red-400`, and a genuine success confirmation `text-emerald-400` if a form needs one — use sparingly, only where the original conveyed status.

**Nav cleanup:** the bottom TabBar owns top-level nav — **remove the "← Home"/"← Dashboard" back links** at the top of each account page (they're redundant). Keep page `<h1>` headers.

**Width:** each account/login page `<main>` → `mx-auto max-w-2xl p-5 sm:p-6`.

**PRESERVE VERBATIM:** every Supabase query + columns; every client-component state hook, handler, fetch, and effect in the manager components (`AchievementsGrid`, `GoalsManager`, `DevicesManager`, `ScanForStraps`, `IntegrationsManager`); the login magic-link submit logic; the share page's `loadShareCard`/`generateMetadata`/`notFound`. **Restyle classes/markup only.** If a manager has logic you're unsure about, leave the logic exactly as-is and only touch className strings.

**Dead-link audit:** after restyling, run `grep -rn 'account/connections' src/` → must be empty (P2 fixed the two known ones; confirm none remain). Also verify every `<Link href>`/`Button href` on these pages points at a real route (`/`, `/sessions`, `/account`, `/account/{devices,goals,achievements,integrations}`).

---

### Task 1: Account — achievements + goals

**Files:** Modify `src/app/account/achievements/page.jsx`, `src/app/account/achievements/AchievementsGrid.jsx`, `src/app/account/goals/page.jsx`, `src/app/account/goals/GoalsManager.jsx`

- [ ] **Step 1: Branch**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b champ-ui-p3-remaining
```

- [ ] **Step 2: Restyle** — Read each file, then apply the shared rules:
  - **`achievements/page.jsx`** (server): remove the "← Home" back link; `<h1>`→`text-2xl font-bold text-un1t-text`; any intro copy→`text-un1t-text-2`; `<main>` width rule.
  - **`AchievementsGrid.jsx`** (client): keep ALL state/filtering/logic. Restyle the badge cards to `un1t` — earned badges on `bg-un1t-surface border-un1t-border` with the icon + name in `text-un1t-text`; locked/unearned badges dimmed via `text-un1t-text-3` + `bg-un1t-surface-2` (NOT amber/grey neutral); category headers `text-un1t-text-2`. De-colour the amber "earned" treatment to white/surface (monochrome).
  - **`goals/page.jsx`** (server): same header treatment + drop back link.
  - **`GoalsManager.jsx`** (client): keep ALL state/handlers (add/edit/cancel/save goal). Restyle: cards→`bg-un1t-surface border-un1t-border`; inputs/selects→dark (`bg-un1t-surface-2 border-un1t-border text-un1t-text` with `placeholder:text-un1t-text-3`); progress bars→track `bg-un1t-surface-2`, fill `bg-white` (complete) / `bg-un1t-text-3` (in progress); primary actions→`<Button>`, secondary/cancel→`<Button variant="ghost">` (or a `text-un1t-text-2 hover:text-un1t-text` text button); labels→`text-un1t-text-2`.

- [ ] **Step 3: Build + commit**

```bash
cd /Users/richardivers/code/champ-app && npm run build
git add 'src/app/account/achievements' 'src/app/account/goals'
git commit -m "CHAMP-UI.1 P3 — restyle account achievements + goals (dark monochrome)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Account — devices + integrations

**Files:** Modify `src/app/account/devices/page.jsx`, `src/app/account/devices/DevicesManager.jsx`, `src/app/account/devices/ScanForStraps.jsx`, `src/app/account/integrations/page.jsx`, `src/app/account/integrations/IntegrationsManager.jsx`

- [ ] **Step 1: Restyle** — Read each file, then apply the shared rules:
  - **`devices/page.jsx`** + **`integrations/page.jsx`** (server): drop the "← Home" back links; `<h1>`→`text-2xl font-bold text-un1t-text`; intro copy→`text-un1t-text-2`; width rule.
  - **`DevicesManager.jsx`** + **`ScanForStraps.jsx`** (client): keep ALL scan/pairing/registration state + handlers + fetches. Restyle device/strap cards→`bg-un1t-surface border-un1t-border`, device labels→`text-un1t-text`, sub-text→`text-un1t-text-2`, status chips→`<Chip>`, primary actions→`<Button>`, the scan/connect buttons→`<Button>`/ghost; any "scanning…" spinner/intro→`text-un1t-text-2`. The Watch/Chest-strap selector + Garmin broadcast instruction card → `bg-un1t-surface-2 border-un1t-border text-un1t-text-2`.
  - **`IntegrationsManager.jsx`** (client): keep ALL OAuth-connect state/handlers. Restyle provider rows (Fitbit/Whoop/Apple/Garmin)→`bg-un1t-surface border-un1t-border`; provider name→`text-un1t-text`; "Connect"/"Coming soon" → `<Button>` / `text-un1t-text-3`; connected status → `<Chip>` (or `text-emerald-400` only if the original showed a green "connected" status).

- [ ] **Step 2: Build + commit**

```bash
cd /Users/richardivers/code/champ-app && npm run build
git add 'src/app/account/devices' 'src/app/account/integrations'
git commit -m "CHAMP-UI.1 P3 — restyle account devices + integrations (dark monochrome)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Login + public share-page chrome + dead-link audit

**Files:** Modify `src/app/login/page.jsx`, `src/app/share/[token]/page.jsx`

- [ ] **Step 1: Login** — Read `src/app/login/page.jsx` (a magic-link form; **keep ALL submit/state logic**). Restyle to a centred dark-branded screen: a vertically-centred container (`min-h` flex column, `mx-auto max-w-sm`), a `UN1T` wordmark on top (`text-xl font-extrabold tracking-[0.18em] text-un1t-text`), the email input dark (`bg-un1t-surface-2 border-un1t-border text-un1t-text placeholder:text-un1t-text-3 rounded-xl`), submit → `<Button className="w-full">`, helper/confirmation copy → `text-un1t-text-2`, any error → `text-red-400`. (Login renders bare — no TabBar — because `AppShell` gates `/login`.)

- [ ] **Step 2: Share-page chrome** — In `src/app/share/[token]/page.jsx` (**keep `loadShareCard`, `generateMetadata`, `notFound`, the `params.token` opengraph-image `<img>` src**), restyle the chrome:
```jsx
  return (
    <main className="mx-auto max-w-2xl p-6 sm:p-10">
      <div className="mb-6 text-center text-lg font-extrabold tracking-[0.18em] text-un1t-text">UN1T</div>
      <div className="overflow-hidden rounded-card border border-un1t-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/share/${params.token}/opengraph-image`} alt={`${card.name} — ${card.points} UN1T Points`} className="w-full" />
      </div>
      {cta && (
        <div className="mt-6 text-center">
          <Button href={cta.url} target="_blank" rel="noreferrer">{cta.label}</Button>
        </div>
      )}
      <p className="mt-6 text-center text-sm text-un1t-text-2">Tracked with heart-rate at UN1T.</p>
    </main>
  )
```
Add `import Button from '@/components/ui/Button'` (or `import { Button } from '@/components/ui'`). Keep the rest of the file unchanged.

- [ ] **Step 3: Dead-link audit + build**

```bash
cd /Users/richardivers/code/champ-app
grep -rn 'account/connections' src/ || echo "no dead connections link ✓"
npm run build
```
Expected: the grep prints the ✓ line (no matches); build green.

- [ ] **Step 4: Commit**

```bash
noglob git add 'src/app/login/page.jsx' 'src/app/share/[token]/page.jsx'
git commit -m "CHAMP-UI.1 P3 — dark-branded login + share-page chrome; dead-link audit clean

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Ship Phase 3 (completes CHAMP-UI.1)

**Files:** none (release).

- [ ] **Step 1: Full checks**

```bash
cd /Users/richardivers/code/champ-app
npx vitest run && npm run lint && npm run build
```
Expected: 116 tests pass (pure restyle, no test changes); lint clean; build green.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin champ-ui-p3-remaining
gh pr create --base main --head champ-ui-p3-remaining -R ivers9307-cyber/champ-app \
  --title "CHAMP-UI.1 P3 — restyle account pages, login + share chrome (completes the refresh)" \
  --body "Final phase of the champ-app design refresh. Restyles the remaining surfaces onto the dark monochrome system — pure presentational change, all logic/state preserved.

- Account sub-pages + managers: achievements (+AchievementsGrid), goals (+GoalsManager), devices (+DevicesManager, ScanForStraps), integrations (+IntegrationsManager).
- Login → dark-branded magic-link screen; public \`/share/[token]\` chrome → dark (the OG card image is unchanged).
- Removed the redundant per-page back links (the bottom TabBar owns nav). Dead-link audit clean (\`/account/connections\` gone everywhere).

Monochrome enforced (HR zone colours the only colour; amber/emerald accents de-coloured). Verified: 116 vitest, lint clean, \`next build\` green. CHAMP-UI.1 (P1+P2+P3) complete.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Watch Vercel + merge**

```bash
gh pr checks <champ-app#> -R ivers9307-cyber/champ-app --watch --interval 20
gh pr merge <champ-app#> -R ivers9307-cyber/champ-app --squash --delete-branch
```

---

## Self-review notes

- **Spec coverage (P3):** account sub-pages (achievements/devices/goals/integrations) ✓ (Tasks 1–2); login ✓ (Task 3); public share-page chrome ✓ (Task 3); dead-link audit ✓ (Task 3). With P1+P2 this completes every surface in the spec.
- **Logic preservation:** the global PRESERVE-VERBATIM rule + per-file "keep all state/handlers/queries; restyle classes only" notes; the share-page `loadShareCard`/`generateMetadata`/`notFound` + OG-image `<img>` are explicitly kept; the OG image module is untouched.
- **Monochrome consistency:** amber achievements + any emerald/blue accents de-coloured; only zone colours remain; the two documented semantic exceptions (error `red-400`, optional success `emerald-400`) are scoped to genuine status text.
- **No placeholders:** the share-page restyle is given as full code; the manager restyles are concrete class-mapping directives over read-the-file (appropriate — they're large client components whose logic must stay byte-identical, so full reproduction would risk transcription error; the directive is "apply the token map + primitives, change classes only").
- **Type/name consistency:** primitive prop names + `format` signatures match P1/P2 usage; `Button href` forwards `target`/`rel` (used on the share CTA).
- **Gate:** champ-app has no GitHub Actions → Vercel build is the remote gate; `next build` after each task.
