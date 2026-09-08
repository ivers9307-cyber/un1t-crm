# Per-location pipelines + the Hatch waitlist board — design

**Date:** 2026-09-08
**Status:** design approved (Richard, 2026-09-08)
**Scope:** make pipelines a per-location concept, and ship UN1T Hatch Street a manual waitlist board as the first board built on it

---

## 1. Problem

The pipeline has **one hardcoded taxonomy and one hardcoded signal source**, and both need to become per-location.

Verified against the live database on 2026-09-08:

| Location | Contacts | Open deals | What its board says |
| --- | --- | --- | --- |
| UN1T Stillorgan | 8,594 | 8,601 | Correct — Glofox-fed |
| UN1T Hatch Street | 99 | 101 | **98 filed as `dormant`** |
| CCF Autos | — | 0 | 11 unused gym stages incl. "1st Class", "ClassPass" |
| SourceIt | — | 0 | same 11 unused gym stages |
| Test Studio | — | 1 | same 11 unused gym stages |
| Pride Training Club | — | 0 | no stages |

Three concrete defects fall out of that single taxonomy:

1. **Hatch's board is false.** All 99 Hatch contacts are website waitlist leads with phone and email, 83 of them created in the last 60 days, and the board calls 98 of them dormant. Not a rules bug: `classifyContact()` reads Glofox fields (`glofox_membership_status`, `recent_bookings`, `trial_credits_remaining`, `gympass_member_id`) that Hatch contacts do not have, and `dormant` is its fallthrough. **The function cannot abstain** — it returns a slug for every contact it is handed.

2. **Stage rows are blanket-seeded by CROSS JOIN** (migs 147, 150, 350), so every location in the database gets the gym stage set whether or not it is a gym. A car dealership has a "Trial Done" column.

3. **The one existing second board is empty.** Stillorgan's `returning` board (mig 558, shipped 21 Aug) holds **0 deals**, and cannot fill — see §7.

Goal: each location runs its own boards, defined for its own situation, and a location can run more than one.

Non-goals:
- A board builder in the UI. Boards are code, written as needed (Richard, 2026-09-08).
- A DB rules engine. Same reason.
- Migrating Stillorgan off Glofox.
- Any change to Stillorgan's funnel behaviour. This is a refactor there, not a redesign.

---

## 2. Decisions taken

| Decision | Value | Source |
| --- | --- | --- |
| Scope | Platform-aware rules + per-location stage sets + support for several boards per location | Richard, 2026-09-08 |
| Board occupancy | Boards evaluated **independently** — a contact may sit on more than one | Richard, 2026-09-08 |
| Rule definition | Code modules, written per situation. No builder UI, no rules engine. | Richard, 2026-09-08 |
| `pack_renewal` board | **No** | Richard, 2026-09-08 |
| `returning` board | **No for now** — park it, do not port | Richard, 2026-09-08 |
| First board to build | Hatch waitlist | Richard, 2026-09-08 |
| Waitlist re-signup | Bumps back to New Enquiry | Richard, 2026-09-08 |

---

## 3. Architecture

### 3.1 A board is a row, owned by a location

```sql
create table pipelines (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references locations(id),
  key           text not null,           -- 'acquisition' | 'waitlist'
  name          text not null,           -- tab label
  module        text,                    -- code module for derived boards; null when manual
  mode          text not null default 'derived'
                check (mode in ('derived','manual')),
  -- a derived board must name its module; a manual board must not have one
  constraint pipelines_module_matches_mode check (
    (mode = 'derived' and module is not null) or
    (mode = 'manual'  and module is null)
  ),
  is_primary    boolean not null default false,
  display_order int  not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (location_id, key)
);

-- exactly one primary board per location
create unique index pipelines_one_primary_per_location
  on pipelines (location_id) where is_primary;
```

`key` is identity, `module` is the code binding. The pair lets Stillorgan's `acquisition` run the Glofox module while another location's `acquisition` runs a different one under the same tab name.

**Locations are separated by construction:** a location has the pipelines it was given and no others. CCF Autos, SourceIt and Test Studio get none.

### 3.2 `mode` is the classifier fence

`mode = 'manual'` means the classifier **never touches this board** — the reclassify orchestrator and the webhook path both skip it entirely: they do not read its deals and never write them.

This is not a convenience flag. FUNNEL.1 removed drag-drop from the pipeline specifically because the nightly classifier overwrites manual moves, and the board comment still records it: *"a manual drag would be overwritten by the next classify pass"*. A manual board that the cron can see is a manual board whose every staff action is silently reverted overnight. The fence is what makes manual boards possible at all.

### 3.3 Schema changes

| Change | Why |
| --- | --- |
| `pipeline_stages.pipeline_id` (fk, not null after backfill) replaces `board` | Stages belong to a board; boards belong to a location. Retires the CROSS JOIN seeding. |
| `deals.pipeline_id` (fk, not null after backfill) | Derivable from `stage_id` today, but a partial unique index cannot span a join, and retrofitting it once two boards hold 8,700 deals is worse than adding it now. |
| `unique (contact_id, pipeline_id) where status='open'` | One open deal per person **per board**. |

`pipeline_stages.board` is dropped only after `pipeline_id` is backfilled and verified (§8).

`deals.status` is **not** extended in this phase. A terminal "left the board" value is only needed when a derived board abstains for a contact that already has a deal; the only derived board shipping here (Stillorgan `acquisition`) always returns a slug. Deferred until a second derived board needs it.

### 3.4 Board modules

Derived boards are pure modules in `shared/pipelines/`, one file per board, written for their situation. `shared/` because mobile cannot import `src/lib` (repo invariant) and the mobile pipeline screen needs the taxonomy — the same reason `shared/pipeline-classifier.js` already lives there.

```js
export const stages = [ /* this board's columns */ ]
export const requiredFields = ['glofox_membership_status', 'recent_bookings', /* … */]
export function classify(contact, now) { /* → slug | null */ }
```

Two properties this buys:

- **`null` is the abstain the current classifier lacks.** A board can say "this person is not mine" instead of being forced to name a column.
- **`requiredFields` retires the hand-maintained `SELECT_COLS` list** in `pipeline-reclassify.js`. That list carries five separate war-story comments warning that omitting a field makes the nightly cron re-classify on nulls and drag webhook-placed deals back overnight (PIPELINE-FLAP). The orchestrator unions each enabled board's declared fields instead of a human remembering to.

**No normalised signal layer.** Each module reads the contact fields it needs directly. Inventing a cross-platform shape before the `un1t.online` sync that defines it exists would be guessing; it can be extracted once two boards actually want it.

---

## 4. Board catalogue at cutover

| Location | Board | Mode | Primary | Status |
| --- | --- | --- | --- | --- |
| UN1T Stillorgan | `acquisition` | derived | yes | Existing, unchanged |
| UN1T Hatch Street | `waitlist` | manual | yes | **New — this spec** |
| CCF Autos, SourceIt, Test Studio, Pride Training Club | — | — | — | No pipelines; stages archived |

No location has two boards at cutover. The engine supports N; nothing exercises N until a second board is wanted.

---

## 5. The Hatch waitlist board

### 5.1 What it is

A manual board for managing waitlist enquiries at Hatch Street. Entry is automatic; **all movement after that is by hand**. It is deliberately not a funnel: Hatch runs on `un1t.online`, so a lead who books a class books over there, invisibly to the CRM. A "Booked" or "Converted-by-attendance" column would be a guess. `waitlist_converted` is a column a human moves someone into, not a derived state.

### 5.2 Columns

All five are visible columns (`is_dormant = false`), in the order Richard specified.

| # | Column | Slug |
| --- | --- | --- |
| 1 | New Enquiry | `waitlist_new_enquiry` |
| 2 | No Answer | `waitlist_no_answer` |
| 3 | Interested in membership | `waitlist_interested` |
| 4 | Not interested | `waitlist_not_interested` |
| 5 | Converted | `waitlist_converted` |

**Column semantics (Richard, 2026-09-08).** "No Answer" means *we called and got no answer* — it is the recorded outcome of an attempt, not a holding pen for people nobody has tried yet. So **New Enquiry means "not yet worked"**, and a card only leaves it once a human has actually attempted contact.

Two consequences. The §5.7 backfill of all 99 existing contacts into New Enquiry is correct precisely because none of them have been worked. And the board's honest read is "New Enquiry is the to-do list" — column 1 growing is a staffing signal, not a marketing one.

The `waitlist_` prefix is required: Hatch's archived gym stages still hold `new_lead` and `converted`, and `pipeline_stages_location_slug_unique` is per location. Same reason the returning board used `returning_`. Mig 559's lesson applies to the seed insert — conflict-target the slug explicitly so a collision on anything else raises rather than silently dropping a row.

### 5.3 Auto-entry

The entry point **already exists and is live**. `POST /api/public/leads` is the public waitlist capture (`src/app/api/public/leads/route.js`, comment line 1), running since 2026-06-08, 99 Hatch contacts through it, most recent 2026-09-08. It already opens a deal on submit (line ~118) — pointed at `new_lead` on the gym funnel.

Change: the route resolves the submitting location's **primary pipeline** and inserts into its first column. No location id is hardcoded — Hatch resolves to the waitlist board's `waitlist_new_enquiry`, every other location resolves to `acquisition` and lands on `new_lead` exactly as today. This follows the same rule the `un1t.online` integration spec sets for the studio id: resolve it, never hardcode it.

### 5.4 Re-signup bumps to New Enquiry

Today the route skips deal creation when an open deal exists, so a person parked in "Not interested" who submits the form again stays there, unseen.

New behaviour, **on manual boards only**: a re-submission moves the existing deal back to column 1. Derived boards are unchanged — a re-submission there stamps `last_lead_source_at` and the classifier decides, exactly as today, so Stillorgan's behaviour does not move.

This mirrors RETURNPIPE.3, where re-entering a public funnel form already revokes a Cold dismissal on the reasoning that *being dismissed is a judgement about someone who went quiet, and filling the form in again is that person answering*. Same shape, same reasoning.

### 5.5 Manual moves

`PATCH /api/deals/[id]` already implements this: it validates the target stage is scoped to the caller's location, writes `stage_id`, and fires the STAGETRIG.1 stage-change trigger. **No API work needed.**

What is missing is the UI. `src/components/KanbanBoard.jsx` is 146 lines with the drag handlers removed and only a comment where they were. Drag-drop is rebuilt there, enabled **only when the board's pipeline is `mode='manual'`**. Derived boards stay read-only, for the original FUNNEL.1 reason.

### 5.6 Knock-ons

- **The Cold button is hidden at Hatch.** Column 4 *is* "not interested"; `pipeline_dismissed_at` would be a second, invisible way to express the same thing.
- **Stage-change sequences work for free.** Manual moves fire `pipeline_stage_change`, so a sequence can later hang off "Interested in membership" with no further work. The only sequence using that trigger today ("New member welcome") is still `draft`.
- **`contacts.pipeline_stage_slug`** becomes the Hatch board's slug for Hatch contacts, which is correct — it is their only board, and it is `is_primary`. See §6.1.

### 5.7 Backfill of the existing 99

Their 101 open deals currently sit in `dormant` (98), `member` (2) and `new_lead` (1) on a gym funnel that does not apply to them. All are moved to **New Enquiry**: none have been triaged, so column 1 is the truthful starting point. Hatch's gym stage rows are then archived.

---

## 6. What this does to Stillorgan

On screen, nothing. The acquisition module is today's `classifyContact()` lifted into `shared/pipelines/` unchanged — same five funnel columns, same six off-funnel piles, same thresholds, same Funnel / Off-funnel sub-tabs. The 8,601 deals are **backfilled, not reclassified**: `pipeline_id` is stamped on existing rows, no `stage_id` is touched, `stage_entered_at` is preserved, nobody changes column.

Splitting boards means the acquisition module drops its internal returning-reroute. Normally a real behaviour change — but 0 deals sit on returning stages, which is direct evidence the reroute claims nobody. Removing it moves no one.

### 6.1 Three sites assume one open deal per contact

All three must be fixed in this pass. None are load-bearing at cutover (no location has two boards), but leaving them means the *first* second board breaks the live public lead form.

| # | Site | Failure with two open deals |
| --- | --- | --- |
| 1 | `sync_contacts_pipeline_stage_slug()` (mig 155) | Picks `ORDER BY d.created_at DESC LIMIT 1` — the newest open deal on **any** board. A second board would silently redefine `contacts.pipeline_stage_slug`, which the audience builder and campaign filters read. **Fix:** scope the trigger to the location's `is_primary` pipeline. |
| 2 | `public/leads/route.js:118`, `public/class-booking/route.js:148` | Both `.eq('status','open').maybeSingle()` — **errors** on a second row. These are the live website lead form and `/start` class booking. **Fix:** scope the lookup to the target pipeline. |
| 3 | `glofox-sync.js:417` `getOpenDealWithStage()` | `.limit(1)`, no ordering — an arbitrary row, driving `ensureDealForContact` on the webhook path. **Fix:** take a pipeline argument. |

Live exposure of #1 today is low and was checked rather than assumed: the two active sequences are `3-Class Trial Booking Nudge` (audience filters `glofox_membership_status`, not the stage slug) and `New Lead – First Class Booking Nudge` (no audience filter). The only `pipeline_stage_change` sequence is draft. The column is still exposed in the audience builder, and sequence auto-exit is a *continuing* condition, so a wrong value there unenrols people quietly.

### 6.2 Smaller effects

- **Contact profile** shows one deal card per board rather than one total. Visible on 8,573 profiles; arguably an improvement once a second board exists.
- **`person-aggregate.js:116`** counts deals per person — a multi-board contact would read "3 deals". Count distinct pipelines, or filter to primary.
- **`contact-crossovers.js` is safe** — checked, not assumed. Both paths tolerate multiple deals: line 90 is existence-only (`.limit(1)` → boolean), and the `crossover_contact_ids` RPC (mig 251) is `select distinct d.contact_id`. No double counting.
- **Mobile** (`mobile/lib/pipeline-api.js`, `mobile/app/(staff)/pipeline/[dealId].jsx`) uses `splitStagesByFunnel` and needs the pipeline dimension.
- **`location-seed.js`** seeds stages for new locations; must seed pipelines instead, or nothing.
- **Nightly cron** goes from one evaluation per contact to one per enabled derived board. Manual boards are skipped entirely.
- **Not affected** (absent from the `deals` / `pipeline_stages` consumer sweep): churn radar, Mia, KPI scorecard, arrears.

---

## 7. Considered and rejected

| Proposal | Why not |
| --- | --- |
| Port the `returning` board | Cannot fill. Only **581 of 8,594** Stillorgan contacts (6.8%) have `last_attended_at` at all and **602** have any `recent_bookings` — both signals the module needs. Contacts lapsed 90–540 days: **15**. Its entry column needs lapsed-plus-future-booking: **0**. Stages archived; module left in the repo unregistered, ready if attendance coverage improves. |
| `pack_renewal` board | Rejected by Richard, 2026-09-08. (315 pack customers, 2,042 credit holders — revisitable.) |
| Renewals / expiring memberships | Only **195 of 1,054** members have `glofox_membership_expiry` at all. A board showing 133 would imply the other 82% are safe. |
| Win-back / ex-members | `ex_member` count at Stillorgan is **0**. Empty on day one. |
| Arrears / overdue | No arrears field on `contacts`; Glofox invoices are stale and the reconciliation is open. Blocked on data truth, not on pipelines. |
| Hatch `acquisition` board | Blocked on franchise credentials. Designed in `2026-09-01-un1t-online-hatch-integration-design.md`; that spec never mentions the pipeline, which is the gap this one closes. |
| A "Contacted" stamp / `lead_contacted_at` | Superseded. The waitlist board's "No Answer" column carries this by hand. |

---

## 8. Rollout

Forward-only migrations, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj`.

1. **Migration A** — create `pipelines`; add nullable `pipeline_id` to `pipeline_stages` and `deals`; seed Stillorgan `acquisition` (primary, derived) and Hatch `waitlist` (primary, manual) with its 5 stage rows; backfill `pipeline_id` on both tables from `(location_id, board)`.
2. **Code** — board modules in `shared/pipelines/`; orchestrator reads enabled derived pipelines and unions `requiredFields`; the three §6.1 fixes; `KanbanBoard` drag-drop for manual boards; waitlist routing and re-signup bump in `public/leads`; pipeline tab/param in web and mobile.
3. **Verify** — dry-run reclassify at Stillorgan must report **`deals_moved: 0`**. That is the pass/fail gate for "no behaviour change".
4. **Migration B** — Hatch's 101 deals to New Enquiry; archive Hatch's gym stages and all stage rows at CCF Autos / SourceIt / Test Studio; `pipeline_id` set `not null`; add the partial unique index; drop `pipeline_stages.board`.

Migration B is guarded and runs only after step 3 passes, following the mig 350 → 351 precedent.

### Risks

- **Backfill correctness on 8,601 Stillorgan deals.** A wrong `pipeline_id` blanks the board. Mitigated by the step-3 gate and by B being separate and guarded.
- **PIPELINE-FLAP, multiplied.** The webhook path and the cron must agree per board or deals oscillate. `requiredFields` removes the historical cause (a hand-maintained field list); parity still needs a test.
- **Silent seed loss.** Mig 559's lesson: `on conflict do nothing` on a seed insert turns a schema disagreement into a missing row and a green checkmark. Conflict-target the slug and count rows afterwards.
- **Manual moves are unrecoverable if the fence leaks.** If a manual pipeline is ever read by the classifier, staff work is overwritten overnight with no audit trail. Needs an explicit test that the orchestrator skips `mode='manual'`.

---

## 9. Open items for the plan

- Decide whether the Hatch board needs per-column count badges given only ~99 cards.
- Decide whether `waitlist_not_interested` should stay a visible column or become `is_dormant` once it accumulates. Shipping visible, as specified.

Closed during review, both by checking the live database rather than deferring:

- **RLS is clear.** No policy on `deals` or `pipeline_stages` references `board`, so dropping the column in Migration B touches no policy.
- **Crossovers are safe.** See §6.2.
