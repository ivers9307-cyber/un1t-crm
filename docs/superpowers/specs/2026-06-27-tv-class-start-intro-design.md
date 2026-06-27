# Studio TV class-start intro card

**Date:** 2026-06-27
**Status:** Design — pending spec review
**Area:** un1t-crm in-studio TV display (`/tv/[locationId]`)

## Problem / goal

The studio TV (`/tv/[locationId]`) shows the live HR leaderboard. Richard wants a short branded **intro graphic that plays at the start of each class** — a title card that names the class, then dissolves to the leaderboard. It should feel tailored to each class (Option C from brainstorming) without anyone designing per-class assets, and run automatically with no coach action.

## Decisions (from brainstorming, confirmed)

- **One animated template, auto-filled from the schedule** (`class_occurrences`): **class name** (hero) + **start time** (Dublin) + **program**. **No instructor** — the Glofox trainer data is only opaque IDs with no reliable names, so we deliberately omit it.
- **Trigger = scheduled start (Option A):** auto-plays once when the clock reaches the class's scheduled `starts_at`. No coach action, no timer dependency, no manual button.
- **Plays once per class**, ~8 s, then dissolves to the leaderboard. Mid-class page loads must NOT replay it.
- **un1t-crm only** — the TV page + its public feed. No champ-app, no new asset uploads, no migration.

## Design

### Data — expose the current class on the public feed
`/api/public/live/[locationId]` (the unauth TV feed) gains a `current_class` block:
```
current_class: { class_name, program, starts_at, starts_at_label } | null
```
- Sourced from `class_occurrences` (the Glofox schedule spine). Reuse the "currently-live occurrence" resolution (the most-recently-started occurrence within the live window) and project the fields the card needs: `name` → `class_name`, `program`, `starts_at` (raw ISO, for the trigger window), and `starts_at_label` (Dublin `HH:MM` via the existing dublin-time helper, so the client needs no TZ logic).
- `null` when no class is live (and for non-Glofox locations, which have no `class_occurrences` rows — so the intro simply never fires there).
- No PII; safe on the unauthenticated TV feed (class name/time/program only).

### Trigger logic — pure + testable
New pure module `src/lib/tv-class-intro.js`:
```
INTRO_WINDOW_MS   = 120_000   // only fire within 2 min of scheduled start
INTRO_DURATION_MS = 8_000     // how long the card holds before dissolving

shouldPlayIntro({ currentClass, lastPlayedKey, nowMs }) → boolean
```
Plays when **all** hold:
- `currentClass` exists and has a `starts_at` + a stable key (`glofox_event_id`),
- `nowMs >= starts_at` AND `nowMs - starts_at <= INTRO_WINDOW_MS` (it genuinely *just* started),
- `currentClass`'s key !== `lastPlayedKey` (not already played this occurrence).

The 2-minute window is what makes a **mid-class page refresh not replay** it (by then `now - starts_at > window`), and the per-occurrence key prevents re-firing on every 2 s poll during that window.

### TV rendering
`src/app/tv/[locationId]/LiveTvClient.jsx` gains a `<ClassStartIntro current={data?.current_class} serverTime={data?.server_time} />`:
- Tracks `lastPlayedKey` in `sessionStorage` (survives the 2 s poll re-renders and a same-session refresh; a brand-new TV session that loads mid-class still won't fire because of the time window).
- On each poll, computes `shouldPlayIntro({ currentClass, lastPlayedKey, nowMs: Date.parse(serverTime) })` (use the **server** time from the feed to avoid TV-clock drift). When true: record the key, show the card, and auto-hide after `INTRO_DURATION_MS`.
- The card is a full-screen overlay above the leaderboard (absolute, black), animating in (kicker → class name scale-in → accent-line sweep → time·program) then fading out — monochrome UN1T identity, the existing red "live" accent, mirroring the approved mockup. Pure CSS/transition; no new deps.
- Degrades to nothing when `current_class` is null.

## Components / files

| File | Change |
|---|---|
| `src/lib/tv-class-intro.js` *(new)* | Pure `shouldPlayIntro` + `INTRO_WINDOW_MS`/`INTRO_DURATION_MS` |
| `src/lib/tv-class-intro.test.js` *(new)* | Unit tests |
| `src/lib/class-occurrences.js` | A reader returning the current occurrence with `starts_at` + `program` (or the feed queries it directly) |
| `src/app/api/public/live/[locationId]/route.js` | + `current_class` block (Dublin-labelled time) |
| `src/app/tv/[locationId]/LiveTvClient.jsx` | `<ClassStartIntro>` overlay |
| `docs/CHANGELOG.md` | Done entry |

## Testing

- **Pure (`tv-class-intro.test.js`):** plays exactly once at start; does NOT play before `starts_at`; does NOT play past the 2-min window (mid-class load); does NOT replay for the same occurrence key; plays again for a *new* occurrence key; null `currentClass` → false.
- **Feed:** `current_class` is present when a class is live, null otherwise; `starts_at_label` is Dublin `HH:MM`; non-Glofox location → null.
- TV overlay verified on the device (the studio TV) — it's a public display, so the real check is watching one class start.

## Out of scope / future

- **Per-class bespoke graphic** (Option B — operator uploads a custom card for a specific class, overriding the template) — a later add on the existing `tv_templates` infra.
- **On/off toggle** — v1 is on wherever a class is live (i.e. Stillorgan); a per-location setting is a trivial fast-follow if a location wants it off.
- **Instructor name** — blocked on a reliable source (Glofox gives only IDs); revisit if a clean coach-per-class assignment exists later.
- Class timer (Option B trigger) is intentionally not used.
