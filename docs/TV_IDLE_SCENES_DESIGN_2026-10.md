# TV idle scenes — design (TVSCENE.1)

**Status:** approved design, not yet built.
**Date:** 2026-10-15.
**Surface:** `/tv/live/[token]` (`LiveTvClient.jsx`) — the Stillorgan studio kiosks.

---

## Problem

The board is empty most of the day. When no band is connected it renders
`EmptyBoard` — "Waiting for class to start" over an otherwise black 1280×720 screen.
That is roughly 80% of the day, and it is often class time too: only 112 bridge sessions
exist in the last 30 days, so a class where nobody wears a strap shows the same empty
screen as an empty studio.

Nothing rotates. The kiosks point at `/tv/live/[token]?kiosk=1&device=…` and nothing
else. Two surfaces that could fill the gap already exist and are never shown:
`/tv/cast/[token]` (operator-pushed images and text-zone templates) and
`/tv/live/[token]/challenges`.

## Goal

Give the idle stretch something worth looking at, serving atmosphere, retention and
brand — without touching the live tile path, and without ever delaying the live board
when a class starts.

## Non-goals

- **Strap adoption as a screen message.** Members own their own straps; the studio
  supplies none. The lever is a board worth wearing one for, not a nag scene.
- **Challenges.** One challenge has ever existed and it ended 2026-07-04, so the
  challenges board would show only its monthly-points fallback. Reviving challenges is
  its own piece of work.
- **The class finish.** `OutroPodium` already exists (top three on effort points, room
  total, app nudge, `OUTRO_MS` 40s). Whether it fires in practice is a separate check,
  not a redesign.
- **Band linking.** Out of scope, but the design must not block it (see Forward
  compatibility).

---

## Hard constraints

1. 🔴 **No aggregate studio metrics, ever.** Richard cut a "room this month" scene that
   showed 2,402 sessions / 369 members / 276 milestones: that is studio volume and
   membership size on a screen anyone can photograph. This is the existing
   "never surface class capacity to customers" rule scaled up. **Individual member
   moments yes; a count of them never.** A scene may say "Saoirse M. — 50 classes"; it
   may never say "80 first classes this month".
2. 🔴 **Unlinked bands stay visible and compete on equal terms.** A band with no linked
   member is a first-class participant identified by its masked number
   (`maskStrapLabel`). Nothing in this work may hide one. This is already how
   `live-board.js` behaves (null-contact sessions are always kept, line 12) — the rule
   is written here so a later change does not quietly reverse it.
3. 🔴 **1280×720 CSS px.** The kiosks run Chromium at `--force-device-scale-factor=1.5`
   on a 1080p panel, so the page sees 720px of height. `main` is `h-screen
   overflow-hidden`; every new row is `shrink-0` and budgeted at 720, or it eats the
   tiles. See `tv-kiosk-viewport-720` and TV-FIT.1 (#1939). jsdom cannot see layout:
   verify at 1280×720 in a real browser.
4. **Customer-facing copy stays operator-editable**, not hard-coded (standing
   invariant). Scene 3 exists partly to satisfy this.
5. **A deploy does not reach a kiosk until the page reloads.** There is no auto-reload
   in `LiveTvClient`, so a kiosk can run one bundle for days. **Scene content must be
   data-driven, never deploy-driven** — otherwise changing what the room sees needs a
   Chromium restart.

---

## Architecture

```
LiveTvClient
├── tiles.length > 0  ──→ existing tile grid          (UNTOUCHED)
│                         + OutroPodium on class end  (UNTOUCHED)
└── tiles.length === 0 ─→ <IdleStage scenes={…} />    (NEW)
                            └── scheduler → one <Scene/> at a time
```

The live/idle switch is **exactly today's condition**, `tiles.length === 0`, which is
also what gates `EmptyBoard` and the hero `TimerBanner` now. One band connects and the
scene layer yields in the same render pass — no URL change, no second page, no flicker.
This is the whole reason for building the rotation inside the board rather than as a
separate app, so it gets a test rather than a comment.

Ordering inside the idle branch, highest priority first:

1. `data.timer` running → existing hero `TimerBanner` (unchanged — a countdown beats a scene)
2. otherwise → `IdleStage`, if any scene has content
3. otherwise → existing `EmptyBoard`

So the floor is never worse than today.

### Scene contract

Every scene is a self-contained component exporting:

| Export | Meaning |
|---|---|
| `key` | stable id, used for dedupe and dwell tracking |
| `hasContent(payload)` | pure predicate — false means the scheduler skips it entirely |
| `<Scene payload />` | renders inside a fixed 720px-budgeted frame |

`hasContent` is pure and lives in `src/lib/tv-scenes.js` so it is unit-testable without
a DOM. **No scene renders an "empty" state** — no "no milestones this week" card. A
scene with nothing to say is not shown.

### Scheduler

- Fixed dwell per scene of **30s** (Richard's call, 2026-10-15), cross-faded.
- Derived from **elapsed time**, not a timer — the board already re-renders every second
  for its header clock, so `sceneAt` advances itself and there is no dwell timeout to be
  reset by a re-render (the TVTOAST.1 / #2066 failure shape).
- 🔴 **CORRECTION (2026-10-16).** This section originally said "the poll already backs off
  when idle … so the idle cadence is ample", and used that to argue the three reads needed
  no cache. **That was false.** TV-POLL-FAST.1 made the back-off **overnight-only**
  (`src/lib/live-poll.js`): during opening hours an idle board polls every **4 seconds**,
  so the reads ran ~14,400×/day per kiosk. `readEarned` carries no `location_id` predicate
  and `contact_achievements` has no index on `earned_at` alone, so each poll full-scanned
  and sorted the whole estate's achievements — for content this same section calls
  "slow-changing". Caught by the final whole-branch review. `up_next` and `earned` are now
  cached per location for `IDLE_CACHE_TTL_MS` (60s); the operator read stays **uncached**,
  because it is a primary-key lookup and it is the one an operator watches after pushing a
  card. **The lesson: a claim about cadence is a claim about the code, and this one was
  never checked against `live-poll.js`.**
- Rotation order is the scene list order, filtered by `hasContent`. One eligible scene
  means it simply stays up.
- 🔴 **The dwell timer uses the `onDone`-in-a-ref pattern from TVTOAST.1 (#2066).** That
  bug — a timer effect depending on a callback identity that changes every second —
  came from this exact file, and a naive dwell timer would reproduce it. The
  regression test for the scheduler asserts advancement survives parent re-renders.

---

## Scenes

### 1. Up next — `scene-up-next`

The studio's remaining classes today; tomorrow morning's once today's are done.

- **Source:** `class_occurrences`, the same table the live board already resolves the
  current class from (`resolveCurrentClassForTv`).
- **Shows:** start time + class name, next one accented.
- 🔴 **Time and name only. No capacity, no headcount, no booked count.**
- `hasContent`: at least one future occurrence inside the window.

### 2. Earned this week — `scene-earned`

Recent member milestones, one row each.

- **Source:** `contact_achievements` joined to `achievement_rules` (name, tier) and
  `contacts` (name, `location_id`, `hr_leaderboard_opt_out`).
- **Shows:** `First name + last initial` — the board's existing privacy floor, same as
  `live-board.js` — plus the achievement name. Tier 4 takes the volt fill.
- **Scoping:** `contact_achievements` has no `location_id`; it must be scoped through
  `contacts.location_id` to the board's own location, or Hatch milestones would appear
  on a Stillorgan screen.
- **Opt-out:** rows for contacts with `hr_leaderboard_opt_out` are excluded, matching
  the live board.
- 🔴 Renders individual rows only — **never a count**.
- `hasContent`: at least one non-opted-out achievement in the window.
- Volume justifying this as the backbone: 1,414 achievements by 585 people, newest
  today, ~9/day over the last 30 days against 24 active rules.

### 3. Operator card — `scene-operator`

Whatever the operator has pushed to this display.

- **Source:** the existing `tv_content` row for the display (`tv_displays`,
  `tv_templates`), the same data `/tv/cast/[token]` renders today via
  `/api/public/tv/[token]/content`.
- **Shows:** a pushed image, or a text-zone template rendered through the existing
  `TemplateCanvas`.
- **Why:** it makes the board's copy operator-editable without a deploy, satisfying
  constraint 4, and reuses a system that already has an admin UI and a push flow.
- `hasContent`: a current, non-expired content row exists for this display.

---

## Data flow

The idle payload rides the **existing** `/api/public/tv-live/[token]` response rather
than new endpoints — one poll, one cache story, one rate limit.

`buildLiveBoardPayload` gains an `idle` block, built **only when there are no open
sessions** (it already early-returns in that branch at line ~107, which is the natural
seam):

```
idle: {
  up_next:   [{ starts_at, starts_at_label, class_name, program }],
  earned:    [{ display_name, achievement, tier, earned_at }],
  operator:  { source_type, … } | null
}
```

Built only in the idle branch, so a live class pays nothing for it. Three reads behind
one existing route, at the idle poll cadence.

**Reuse, do not re-derive:** `timeLabelIn` for times, `maskStrapLabel` for any band
label, the display-name split already in `live-board.js`, `TemplateCanvas` for the
operator card.

---

## Error handling

Each of the three reads is independent and **fails to absent, never to an error
screen**: a failed read means that scene has no content and the scheduler skips it.
A board that silently loses one scene is correct; a board showing a stack trace to a
studio floor is not. Failures log through the existing structured logger, never free
text, and never throw out of the payload builder — an idle-block failure must not take
down the live board path with it.

`.select()` column names are schema claims: every column named here must survive
`check:select-columns`, which replays the migrations.

---

## Testing

| Level | What |
|---|---|
| Pure | `hasContent` for each scene — empty, populated, opted-out, wrong location |
| Pure | scheduler ordering, skip-empty, single-eligible-scene, wrap |
| Component | **a band connecting mid-rotation yields to the live tiles immediately** — the load-bearing guarantee of approach A |
| Component | dwell advances across parent re-renders (the TVTOAST.1 regression shape) |
| Payload | `idle` absent when sessions exist; present and correctly scoped when not |
| Scoping | a Hatch achievement never appears on a Stillorgan board |
| Privacy | an opted-out contact never appears; no scene renders an aggregate count |
| Layout | 1280×720 in a real browser — each scene fits with the header, footer and any timer row. jsdom cannot see layout |

Component tests move the fake clock **inside `act()`** per the repo invariant
(`tests/fake-timer-act.test.js`).

---

## Forward compatibility — band linking

Band linking is not built, and the design must light up the day it is, with no rebuild:

- Scene 2 already keys on `contacts`, so a newly-linked member's milestones appear with
  no change.
- The live board already renders a name when `sess.contacts` exists and a masked band
  number when it does not — linking flips that per session with no board change.
- Nothing in this work may add a filter of the form "only show linked members", which
  would both break constraint 2 today and silently change meaning after linking.

## Open questions

None. All three settled 2026-10-15.

**Settled 2026-10-15:**

- ~~Scene dwell~~ — **30s**, Richard's call. With three eligible scenes that is a 90s
  cycle, so someone in the studio for a few minutes sees every scene without any of
  them feeling frozen. Keep it one named constant so it can be retuned from the wall.

- ~~Window for "earned this week"~~ — **7 days stands.** Scoped to Stillorgan with
  opt-outs excluded: **65 achievements in the last 7 days across 61 distinct people**
  (34 in 3 days, 276 in 30). A five-row scene draws from 65 with almost no repeated
  name, so the window needs no narrowing and certainly no count to pad it.
- ~~Does `OutroPodium` include anonymous bands?~~ — **Yes, no code blocker.**
  `selectPodium` (`src/lib/tv-theatre.js:195`) maps on `displayName` and filters only
  `points > 0`, so a band labelled `Strap 49931` places exactly like a named member —
  already consistent with the unlinked-bands constraint. `classDidEnd` fires on
  `current_class` present → absent, or on the timer reporting finished.
  **Still unobserved:** whether a podium has ever actually been seen on the floor. With
  112 bridge sessions in 30 days it would fire rarely, and a stuck toast used to cover
  the screen (TVTOAST.1, #2066) — worth watching for after that fix deploys, rather
  than designing against.
