# Hyrox Training Club — AI 12-week block, auto-published to the gym TV — Design Spec

- **Date:** 2026-07-23
- **Status:** Draft for review (board mockup approved in session — portrait, Performance/Elite tiers)
- **Repo:** un1t-crm
- **Location:** Stillorgan only (the only Glofox-connected location today; a second location is Phase 2)
- **Visual reference:** portrait "Hyrox Training Club" board mockup shown in the brainstorming session (dark screen, 2 tiers, 45-min cap, no on-screen publish/approval tag).

> Line numbers below come from the 2026-07 current-state map (three Explore passes) and may drift — treat them as "find near here", verify before editing.

---

## 1. Goal & scope

Replace the **manual "write the Hyrox workout, then hand-publish it to the TV"** process with an AI-designed, coach-approved, auto-published **12-week Hyrox training block**. The AI plans one coherent periodised arc; a coach reviews each upcoming week and approves; approved sessions publish themselves to the in-gym TV at class time, on a purpose-built portrait board.

**Why now:** every piece of plumbing except the block itself already exists — the TV takes pushed content (`tv_content`), the system already knows when a HYROX class runs (`class_occurrences`, synced from Glofox), Mia already runs on the Anthropic API, and there is a proven "AI drafts → staff approve before live" pattern (the approvals inbox). The new work is the block model, the generator, and the timed auto-publish.

### In scope (v1 — Phase 1)
1. **Block data model** — `hyrox_blocks` (one 12-week arc per location/intake) + `hyrox_sessions` (each planned session, coach-facing detail + structured board + status). §3.
2. **AI generation** — a new Hyrox prompt module reusing the estate's Anthropic Messages API pattern. Generates the **12-week arc up front**, then **expands full sessions rolling ~2 weeks ahead**. Outputs validated structured JSON, governed by the **workout design charter** (§4.4). §4.
3. **Coach review + approve** — a new approvals provider (upcoming week surfaces in the inbox) plus a dedicated `/admin/hyrox` planner (12-week grid). Edit any field, swap a station, "regenerate this session", approve. Batch-approve a week. Permission-gated. **Nothing reaches the TV until approved.** §5.
4. **Auto-publish** — a cron reusing the class-climate scheduling pattern: find the HYROX `class_occurrences` starting within a configurable lead time, resolve the approved session for that week/slot, upsert `tv_content`. Idempotent, kill-switchable, degrades safely. §6.
5. **Purpose-built portrait TV board** — light up the dormant `tv_content.source_type = 'generated'` with a dedicated Hyrox board renderer on the cast page (portrait-native, Performance/Elite tier columns). §7.
6. **Difficulty: two tiers + block dial + auto-tune toggle** — every session carries Performance + Elite numbers; a per-block/intake dial sets baseline load/volume + progression steepness; a per-block `auto_tune_enabled` toggle (default **off**) gates whether the data signal feeds generation. The toggle + its wiring ship in v1; the signal *computation* is Phase 2. §8.

### Explicitly out of scope (YAGNI / later phases)
- **Auto-tune *signal computation* (Phase 2).** The attendance + champ-bridge HR-zone read and the nudge math. Note the **toggle itself ships in v1** — stored on the block, surfaced in the planner, and read by the generator (as a no-op signal until Phase 2). Only the data computation behind it is deferred. §8.3.
- **Second location (Phase 2).** Only Stillorgan is Glofox-connected today (Hatch `branch_id` is a placeholder), so only Stillorgan produces `class_occurrences` rows. Everything is `location_id`-scoped so a second location is config, not a rebuild.
- **Member-facing surface in the champ-app / Pulse (Phase 3).** Read-only session view + "log your tier/score" → fitness-hub points / leaderboard. Respects the `Pulse = engagement, no booking` product boundary.
- **Benchmark-week score capture (Phase 2).** Benchmark weeks are *authored* into the arc in v1 (they are just sessions flagged `is_benchmark`); capturing member results against them is later.
- **Manual per-session difficulty slider.** Deliberately excluded — difficulty is systematic (tiers + dial + later auto-tune), not hand-tuned per session. The coach review is for quality/correctness, not calibration.
- **No Foundation tier.** Performance + Elite only (confirmed).

---

## 2. Decisions locked (from the brainstorm)

| # | Decision | Choice |
|---|---|---|
| D1 | Block model | **Periodised, coach-reviewed** — one coherent 12-week arc (base → build → peak → taper), coach approves each week before publish. |
| D2 | Weekly shape | **Hybrid** — a common weekly stimulus/theme; sessions vary stations/format around it; progresses as a block. **Stillorgan: 2 sessions/week — Wednesday + Sunday** (stored as `sessions_per_week` + `session_weekdays`, so other cadences stay possible). |
| D3 | Difficulty levers | **Board tiers (Performance/Elite)** + **block/intake dial** + **auto-tune** (per-block toggle, default off; when on, feeds the data signal into generation — signal computation is Phase 2). No manual per-session slider. |
| D4 | Board scope | **Two views** — AI generates the full session (coach reviews that); the TV renders only the glanceable working board. |
| D5 | Board render | **Purpose-built** `generated` renderer, **portrait-native**. |
| D6 | Mockup specifics | Portrait; Performance + Elite only; 45-min cap; "HYROX TRAINING CLUB" wordmark; no on-screen publish/approval tag. |
| D7 | Workout quality bar | Every session must be **tough, challenging, but doable — and always fun**. Encoded as hard constraints in the generation prompt and as the coach-review checklist; operator-editable. §4.4. |

---

## 3. Data model (new)

Two new tables, both `location_id`-scoped (FK → `locations`, ON DELETE CASCADE), service-role writes only, `authenticated` SELECT via `private.auth_is_in_location(location_id)` — mirroring `class_occurrences` (mig `284_class_climate.sql`).

### `hyrox_blocks` — one 12-week arc
```
id                uuid PK
location_id       uuid NOT NULL → locations(id)
title             text            -- e.g. "Autumn intake 2026"
starts_on         date            -- week 1, Monday
weeks             int   NOT NULL DEFAULT 12
sessions_per_week int   NOT NULL DEFAULT 2       -- D2: Stillorgan runs 2/week
session_weekdays  smallint[] NOT NULL             -- ISO weekday per slot (Mon=1 .. Sun=7); Stillorgan = {3,7} = Wed, Sun
difficulty_dial   text  NOT NULL  -- 'beginner_heavy' | 'mixed' | 'competitive' (D3 block dial)
auto_tune_enabled boolean NOT NULL DEFAULT false  -- D3 toggle: when true, the auto-tune signal feeds generation (§8.3); signal computation is Phase 2
arc               jsonb NOT NULL  -- AI-designed periodisation skeleton (phase per week, weekly stimulus, benchmark weeks)
status            text  NOT NULL DEFAULT 'active'  -- 'active' | 'archived'
generated_by      text            -- model id + prompt version for provenance
created_at        timestamptz DEFAULT now()
```
`arc` is the coherent 12-week map generated up front (§4.1): for each week — its phase (`base|build|peak|taper`), the week's stimulus/theme, whether it is a benchmark week, and the progression targets the per-session expansion must honour.

### `hyrox_sessions` — each planned session
```
id               uuid PK
block_id         uuid NOT NULL → hyrox_blocks(id) ON DELETE CASCADE
location_id      uuid NOT NULL → locations(id)      -- denormalised for scoping/RLS
week_no          int  NOT NULL                       -- 1..12
slot             int  NOT NULL                       -- 1..sessions_per_week (the class slot in the week)
phase            text NOT NULL                        -- base|build|peak|taper (from arc)
focus            text                                 -- e.g. "Engine — compromised running"
is_benchmark     boolean NOT NULL DEFAULT false
full_session     jsonb NOT NULL   -- COACH-FACING: warmup, strength/skill, main piece, finisher, cues, standards, "why"
board            jsonb NOT NULL   -- TV-FACING: title/focus, format, cap, station rows w/ per-tier numbers, target (§7.1)
status           text NOT NULL DEFAULT 'draft'  -- 'draft' | 'approved' | 'published'
approved_by      uuid                            -- staff user
approved_at      timestamptz
published_at     timestamptz
created_at       timestamptz DEFAULT now()
UNIQUE (block_id, week_no, slot)
```

**How a planned session maps to a real class.** Hyrox is **not** a class type in the schema — a HYROX class is just a `class_occurrences` row whose `normalizeClassName(name) === 'hyrox'` (`src/lib/hr-analytics.js:40`). At publish time the cron resolves the *current* block for the location, computes `week_no` from `block.starts_on` and today, maps the occurrence's **weekday** to a `slot` via `block.session_weekdays` (Stillorgan: Wed → slot 1, Sun → slot 2), and matches to the `hyrox_sessions` row. No hard FK to `glofox_event_id` (per-occurrence and re-minted) — the join is `location_id` + `week_no` + `slot`. Multiple HYROX classes on the same weekday (e.g. a morning and evening Wednesday class) all resolve to that day's session — consistent with D2.

---

## 4. Generation (AI)

### 4.1 Strategy — arc up front, sessions rolling
- **Arc pass (once per block):** one AI call produces `hyrox_blocks.arc` — the 12-week periodisation skeleton from the inputs (weeks, sessions/week, difficulty dial, optional target race date, equipment constraints). Cheap, reviewable as a whole, keeps the block coherent.
- **Expansion pass (rolling):** a job expands full `hyrox_sessions` (both `full_session` and `board`) for weeks ~2 ahead of "now", honouring the arc's stimulus + progression targets for that week. Keeps each review digestible and leaves room for auto-tune to shape not-yet-expanded weeks. **When `block.auto_tune_enabled` is on, this pass also folds in the auto-tune signal (§8.3)** — that toggle is the single point where data changes how a workout is built.

### 4.2 Reuse the estate's Anthropic pattern
No SDK — the estate hand-rolls `fetch` to `https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`, `output_config.effort`, ephemeral `cache_control` on the stable prefix; canonical: `src/lib/agent/auto-reply.js:46-487`). A **new prompt module** beside `src/lib/agent/prompt.js` encodes the Hyrox domain: the 8 Hyrox stations (SkiErg, sled push, sled pull, burpee broad jump, row, farmers carry, sandbag lunge, wall balls) + running/compromised-running logic, periodisation principles, the two-tier scaling model, UN1T tone, and the **no-em-dashes** rule for any member-facing string.
- **Model:** open decision (§9). Block generation is **offline/batch**, not latency-critical, so a higher tier than Mia's `claude-sonnet-4-6` is affordable if it improves quality. Anthropic Messages API only (estate invariant; no OpenAI).
- **Structured output:** the model must return JSON validated against a fixed schema (arc schema; session schema) so the board renders deterministically and bad output is rejected/retried, not published.

### 4.3 "Why" per session
Each `full_session` carries a one-line rationale so a coach trusts it at a glance: it must state the **stimulus** *and* **what makes the session engaging** (the charter, §4.4). Cheap, high-trust — mirrors the "suggestion" ergonomics in `src/lib/agent/approval-suggest.js`.

### 4.4 Workout design charter — the quality bar
Every generated session must clear one bar: **tough, challenging, but doable — and always fun.** This is not a tagline; it is stated as hard constraints in the generation prompt (arc *and* expansion passes) and is the rubric the coach review (§5) checks against.

- **Tough & challenging.** A real stimulus for the week's phase and energy system — genuine Hyrox work (running + stations, compromised running), honest intensity, and week-on-week progressive overload so the block visibly builds. Never a token or filler session.
- **But doable.** Completable inside the **45-minute cap** by *both* tiers; movements safe and coachable for a mixed drop-in class; volume and pacing that let people **finish strong, not get buried**. The Performance/Elite split must be a genuine on-ramp — Performance achievable for a committed regular, Elite stretches the strong. Every session names a realistic target/stimulus (e.g. "sub-32:00").
- **Always fun.** This is the retention lever, so it is non-negotiable. Vary format and stations week to week (avoid the same grind); lean on formats that create energy in the room — partners/relays/teams, ladders, races against the clock, the occasional novelty station — and keep a competitive spark. A member should leave wanting the next one.

**How it's enforced:** (a) the prompt carries the charter as explicit constraints and asks the model to self-check each session against all three before returning it; (b) the per-session "why" (§4.3) must speak to both stimulus and engagement; (c) the coach review (§5) surfaces the charter as an at-a-glance **tough · doable · fun** checklist, so a human can catch anything brutal-but-not-doable or a joyless grind before it publishes. The charter text is **operator-editable** (a settings field with this as the default), not hard-coded — the coaching philosophy should be tunable without a deploy.

---

## 5. Coach review + approval

Reuse the approvals **provider registry** (`src/lib/approvals/registry.js` — `getPendingApprovals()` fans out across providers; add a file + register it and the inbox badge/tab pick it up). Template to copy: `src/lib/approvals/providers/agent-requests.js` (surfaces AI drafts as `pending` rows staff action).

- **New provider** `hyrox-sessions` — surfaces `hyrox_sessions` where `status='draft'` for the **upcoming week** at the viewer's active location. `permissionKey: 'approvals_hyrox'` (new key; per-category perms per `approvals-per-category`). `reviewBase: '/admin/hyrox'`.
- **Dedicated planner `/admin/hyrox`** — a 12-week grid (weeks × slots) showing status per session. Open a session → read the full coach-facing plan → **edit any field / swap a station / "regenerate this session" / approve**. **Batch-approve a week.** The review surfaces the **workout design charter (§4.4)** as a *tough · doable · fun* checklist, so the coach approves against an explicit bar and can reject a grind or an over-cooked session. Permission-gated (`hasPermission(user, 'hyrox_planner')` or reuse the approvals key).
- **Hard gate:** the auto-publish cron only ever reads `status='approved'`. Draft or absent → never on the wall.

---

## 6. Auto-publish (scheduling)

Mirror the existing schedule-driven automation pattern — `src/lib/class-climate-runner.js` + `automation_fire_log` (mig 284:59) + a Vercel cron. (There is **no absolute-time QStash scheduling in the estate**; the pattern is a poll cron + a DB lookup. Confirmed across the map.)

- **New cron** `GET /api/cron/publish-hyrox-board`, `Bearer ${CRON_SECRET}` inline gate, `stampHeartbeat('publish-hyrox-board', …)` on success (the estate convention). Runs every ~5 min (`vercel.json` crons).
- **Per location, each run:**
  1. Find HYROX `class_occurrences` (`cancelled_at IS NULL`) starting within a **configurable lead time** (e.g. `now .. now+10min`) — so the board is up as members walk in.
  2. Resolve the active `hyrox_blocks` for the location; compute `week_no` from `starts_on`; map the occurrence's **weekday** to `slot` via `session_weekdays` (Wed → 1, Sun → 2); load the `hyrox_sessions` row (`status='approved'`).
  3. Find the location's target `tv_displays` (the Hyrox screen(s)) and **upsert `tv_content`** (`onConflict: 'tv_display_id'`) with `source_type:'generated'`, `source_ref` = the session id, `template_values`/payload = the `board` JSON, bump `pushed_at`, `triggered_by:'hyrox-auto:<session>'`. The cast page reloads within ~6s (`TVDisplay.jsx`).
  4. Stamp `automation_fire_log` (idempotency) and `hyrox_sessions.published_at`.
- **Which TV(s):** a setting on the display or block naming the Hyrox screen(s) — don't hijack every TV at the location. (Open input §9.)
- **Safe degradation:** no approved session → the cron does nothing; staff can still hand-push exactly like today. Nothing is destructive.
- **Revert after class:** optional — clear/replace the board when the class ends (delete `tv_content` → idle, or restore prior content). v1 can simply leave the last board up until the next push (matches current behaviour). (Open input §9.)
- **Kill switch:** a settings flag (and/or unset the cron) disables auto-publish estate-wide; manual push is always available.

---

## 7. The TV board renderer

Reuse the cast pipeline but add a `generated` render path (the `source_type` is declared in mig `160_tv_displays.sql` but never implemented — "Phase 2 work"; this is that phase).

- **Read side:** `src/app/api/public/tv/[token]/content/route.js` already resolves a display's single `tv_content` row for the token. Extend it to return the `board` payload for `source_type:'generated'`.
- **Render side:** `src/app/tv/cast/[token]/TVDisplay.jsx` currently branches image / template / idle. Add a `<HyroxBoard>` branch that renders the structured `board` JSON — **portrait-native**, using the existing rotation support (`tv_displays.rotation`, mig 189) so a portrait-hung panel is handled. Poppins via `src/components/tv-font.js` (the existing TV font).
- **No change to the existing template push** — posters/marketing still use `source_type:'template'` and the runs editor.

### 7.1 `board` JSON shape (drives the renderer)
```
{
  "wordmark": "HYROX TRAINING CLUB",
  "location_label": "UN1T STILLORGAN",
  "week_label": "WEEK 5 / 12 · BUILD",
  "focus": "ENGINE — COMPROMISED RUNNING",
  "format": "4 ROUNDS FOR TIME",
  "cap_minutes": 45,
  "stations": [
    { "name": "Run", "performance": "400m", "elite": "500m" },
    { "name": "SkiErg", "performance": "500m", "elite": "500m" },
    { "name": "Sled push", "performance": "100kg", "elite": "150kg" },
    { "name": "Burpee broad jump", "performance": "12", "elite": "16" },
    { "name": "Wall balls", "performance": "9kg × 20", "elite": "9kg × 25" }
  ],
  "target": "Target sub-32:00 · scale runs to 300m if pacing breaks"
}
```
(Two tiers only. Renderer must degrade gracefully if a station omits a tier value.)

---

## 8. Difficulty model

### 8.1 Board tiers (Performance / Elite)
Every `hyrox_sessions.board.stations[]` row carries `performance` and `elite` values; the renderer shows both columns; members self-select in the room and the coach cues it.

### 8.2 Block dial
`hyrox_blocks.difficulty_dial` (`beginner_heavy | mixed | competitive`), set at generation, feeds the arc + expansion prompts: baseline loads/reps/volume and how steeply the block progresses.

### 8.3 Auto-tune — toggle in v1, signal in Phase 2
Gated by a per-block **`auto_tune_enabled`** toggle (default **off** — new automated behaviours ship opt-in, per the estate convention), stored on `hyrox_blocks` and surfaced in the `/admin/hyrox` planner.

- **Off (default):** the rolling expansion pass (§4.1) builds each week's difficulty from **arc + block dial only**. No data is consulted.
- **On:** the expansion pass **also factors the auto-tune signal** when building the next not-yet-expanded week — a weekly read of class attendance (`class_bookings` / attendance crediting) + champ-bridge HR-zone spread for the location's HYROX classes; if the room is redlining or coasting vs the phase target, difficulty for that week is nudged **before the sessions are drafted**. Because expansion is rolling, later weeks absorb the signal. Coach still approves.

**What ships when:** the toggle, its storage, its planner control, and the expansion pass *reading* it (with a no-op signal) ship in **v1** — so the operator control is real from day one and turning it on later needs no schema change. The **signal computation** (the attendance/HR read + the nudge math) is **Phase 2**. This is the whole reason difficulty is fed at *generation* time rather than applied to already-published boards: the toggle changes how the workout is **built**.

---

## 9. Open inputs / decisions (non-blocking)

- **Model tier** for generation (§4.2) — reuse `claude-sonnet-4-6`, or a higher tier since it's batch. Recommend deciding at build with a quick quality eval.
- **Which TV(s)** the Hyrox board targets at the location (§6) — a display flag vs block setting.
- **Post-class revert** behaviour (§6) — leave last board up (simplest) vs clear to idle vs restore prior.
- **Lead time** before class to publish (default 10 min).

## 10. Future ideas (captured, not scheduled)
- Benchmark weeks (weeks 1 / 6 / 12 = Hyrox simulation) baked into the arc; member score capture in Phase 2.
- Member-facing Pulse view + "log your tier/score" → fitness-hub points / straps leaderboard (Phase 3, engagement-only).
- Auto-restart: when a block ends, auto-draft the next intake carrying forward what the data learned.

## 11. Build order (Phase 1)
1. Migrations: `hyrox_blocks` + `hyrox_sessions` (+ advisors after DDL, via Supabase MCP against un1t-crm).
2. Prompt module + arc pass + expansion pass (structured-output validated).
3. `/admin/hyrox` planner + `hyrox-sessions` approvals provider + permission key.
4. `generated` render path: extend the public TV content route + `<HyroxBoard>` in `TVDisplay.jsx`.
5. `publish-hyrox-board` cron + `automation_fire_log` idempotency + kill switch + heartbeat.
6. Seed one real 12-week block for Stillorgan; dry-run publish to a test display before going live.
