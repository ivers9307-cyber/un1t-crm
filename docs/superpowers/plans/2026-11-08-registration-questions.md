# Registration questions (QUESTIONS.1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An event can ask up to ten questions at signup (dietary needs, experience level, t-shirt size), per entry or per person, and the answers travel with the attendees: export, host roster, staff roster.

**Architecture:** Questions are a jsonb list on `race_events.registration_questions`; answers are jsonb on `race_registrations.answers` (per entry) and `team_members.answers` (per person). One pure module validates and normalises answers against the questions; the widget renders the questions and the register route stores what the module returns. Rosters and the CSV read the stored answers back by question id, so a question edited after signups keeps old answers readable.

**Tech Stack:** Next.js 16, supabase-js (service role), Zod, Vitest (+ jsdom), PGlite.

**Spec:** `docs/superpowers/specs/2026-11-08-host-event-features-design.md` § 3.

## Global Constraints

- Branch `host-registration-questions`, stacked on `host-pricing-tiers` (PR #2323, auto-merge). Migration `819_registration_questions.sql` (817, 818 are PRs 1 and 2; re-check main before applying). Apply with the Supabase MCP before merge; `get_advisors` after.
- `team_members`, `race_registrations` and `race_events` have no client privilege (mig 682); the new columns are service-role reads. Nothing public exposes another person's answers: the widget only sends, the public event payload never carries answers.
- Mia's solo booking path asks no questions (`answers: null`; the rosters show "not asked"). Changing questions on a published host event does **not** re-review it.
- Answer text ≤500 chars, trimmed; a `choice` answer must be one of the options; `yes_no` is a boolean; a required question must be answered for the entry (entry-level) or for every person (person-level). Field error keys for the widget: `q_<id>` (entry) and `member_<i>_<id>` (person; `i` is the roster index, 0 = captain; ids are minted `q-…`), so the existing `fieldErrors` map and `inputCls` render them.
- CSV: one column per question, header = the question label; entry answers repeated on every person row; `yes_no` renders `Yes`/`No`; a question with no answer is blank.
- Every supabase write destructures `error`; `check:select-columns` learns the columns from the migration.
- Commit messages `QUESTIONS.1 — <what>`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A required per-person question with one blank member** must refuse the whole signup naming that member's field (Task 2 test "a required person question missing for one member").
2. **A choice answer that is not an option** (a stale cached form after the host edited the options) is refused, never stored (Task 2).
3. **An event with questions and a find-a-team solo**: the solo answers the person questions for themselves only (`people` has one entry) (Task 3 route test).
4. **Export of an event whose question was deleted after signups**: the stored answer keyed by a vanished id is dropped silently, not a crash (Task 4 test "an answer for a removed question is ignored").
5. **Answers never reach the public payload** (Task 3 asserts the public event route's select does not name `answers`; the readers guard pins which files do).

---

### Task 1: Migration 819

**Files:** Create `supabase/migrations/819_registration_questions.sql`, `tests/migration-819-registration-questions.test.js` (PGlite).

**Produces:** `race_events.registration_questions jsonb null`, `race_registrations.answers jsonb null`, `team_members.answers jsonb null`, each with a `comment on column`.

- [ ] Test: the three columns exist as nullable jsonb; a round trip stores and reads a question list and answers; re-applies cleanly. RED → write → GREEN; `check:select-columns`. Commit `QUESTIONS.1 — mig 819: registration_questions + answers`.

### Task 2: Questions lib

**Files:** Create `src/lib/registration-questions.js`, `src/lib/registration-questions.test.js`.

**Produces:**
- `RegistrationQuestionSchema = z.object({ id: z.string().min(1).max(40), label: z.string().trim().min(1).max(120), type: z.enum(['text','choice','yes_no']), options: z.array(z.string().trim().min(1).max(60)).max(10).optional(), required: z.boolean().default(false), per: z.enum(['entry','person']).default('entry') }).strict()` + refine: a `choice` needs ≥2 options. `RegistrationQuestionsSchema = z.array(...).max(10)` with unique ids. `MAX_QUESTIONS = 10`.
- `resolveRegistrationQuestions(race) → Question[]` ([] for null/invalid).
- `validateAnswers(questions, answers, { peopleCount }) → { ok: true, entry: Record<id, value>|null, people: Array<Record<id,value>|null> } | { ok: false, issues: Array<{ path: string, message: string }> }`: `answers` is the body's `{ entry?, people? }` (missing → `{}`/`[]`); per-entry questions read `answers.entry[id]`, per-person questions read `answers.people[i][id]` for `i < peopleCount`; normalisation: text trimmed, ≤500 → else issue; choice must be in options; yes_no accepts `true/false` (and `'yes'/'no'` strings); required missing → issue with path `q_<id>` / `member_<i>_q_<id>` and message `'${label} is required'` (or `'...for ${person #}'`); unknown ids ignored; with no questions → `{ ok: true, entry: null, people: Array(peopleCount).fill(null) }`. Empty answer objects become null.
- `answerColumns(questions) → [{ id, label }]` (CSV headers), `formatAnswer(question, value) → string` (`Yes`/`No`, text, option; `''` for none), `answersForDisplay(questions, entryAnswers, personAnswers) → [{ label, value }]` (skips blanks; ignores vanished ids).

- [ ] Tests: schema (choice needs options; 11 questions; duplicate ids), "a required person question missing for one member" → one issue at `member_1_q_<id>`, "a choice answer that is not an option" → issue, yes_no normalisation, text trimmed and capped, unknown ids dropped, no questions → nulls, `formatAnswer`, `answersForDisplay` with a vanished id. RED → GREEN. Commit `QUESTIONS.1 — registration-questions lib`.

### Task 3: Widget asks, register route stores

**Files:** Modify `src/app/api/public/events/[slug]/register/route.js` (select `registration_questions`; `RegisterSchema.answers: z.object({ entry: z.record(z.unknown()).optional(), people: z.array(z.record(z.unknown()).nullable()).max(50).optional() }).optional()`; after the roster is validated and before pricing: `validateAnswers(questions, body.answers, { peopleCount: validatedRoster.length })` → on `ok:false` discard a solo team and answer 400 `{ success:false, error: 'Please answer the required questions.', code: 'invalid_answers', issues }`; store `answers: result.entry` on the registration insert and `answers: result.people[idx]` on each `memberRows` entry), `src/components/RaceSignupWidget.jsx` (new `answers` state `{ entry: {}, people: [] }`; a `QuestionField` renderer for text / select / yes-no radios; entry questions rendered after the captain block, person questions under the captain and under each member row; `handleSubmit` runs a client copy of the required check and maps the server's `issues` into `fieldErrors` by `path`; body gains `answers`), `src/app/api/public/events/[slug]/route.js` (select + expose `registration_questions` on the public payload: the questions themselves are public copy; never answers).
- Tests: register route (new `route.questions.test.js`): stores entry and person answers, 400 `invalid_answers` with `issues` naming `member_1_q_<id>`, a find-team solo answers for one person; widget (`RaceSignupWidget.questions.test.jsx`): renders the fields, blocks submit on a missing required answer with the field error, posts `answers` in roster order; public route: payload carries `registration_questions` and never `answers`. Commit `QUESTIONS.1 — the signup form asks, the register route stores`.

### Task 4: Export and rosters show answers

**Files:** Modify `src/lib/attendee-csv.js` (`buildAttendeeCsv(event, regs, { includeMembership, questions = [] })`: header gains one column per question label; each person row appends `formatAnswer(q, person.answers?.[q.id] ?? reg.answers?.[q.id])` for per-person q and `formatAnswer(q, reg.answers?.[q.id])` for per-entry q; the member-less row too), `src/lib/attendee-export.js` (select `answers` on the registration and `team_members`), the two export routes (`src/app/api/events/[id]/teams/export/route.js`, `src/app/api/host/events/[id]/attendees/export/route.js`: select `registration_questions` on the race and pass `questions: resolveRegistrationQuestions(race)`), `src/app/api/events/[id]/teams/route.js` (select `answers` on both; the response's members carry `answers`), `src/app/host/(portal)/events/[id]/page.js` (entries gain `answers: answersForDisplay(...)` and `people[].answers`), `src/components/host/HostAttendeeTable.jsx` + `src/components/RaceTeamsManager.jsx` (a shared `src/components/AnswerList.jsx`: `<details>`-free inline list "Label: value" under the entry / member; nothing when empty), plus `tests/registration-questions-readers-guard.test.js` (the export routes, the teams route and the register route name `answers`/`registration_questions`; the public event route never selects `answers`).
- Tests: `attendee-csv.test.js` (header and cells; "an answer for a removed question is ignored"; `includeMembership:false` still right); `AnswerList` renders / renders nothing; HostAttendeeTable shows answers; readers guard. Commit `QUESTIONS.1 — answers in the export and on both rosters`.

### Task 5: Questions editor on both forms

**Files:** Create `src/components/RegistrationQuestionsEditor.jsx` (+ test): rows of label, type, options (comma-separated, choice only), required, per entry/person; add (≤10) / remove / reorder; ids `q-<random8>`. Modify `src/components/host/HostEventForm.jsx` (a "Questions" section; body `registration_questions`), `src/components/RaceEventForm.jsx` (a section after Find a team; payload `registration_questions`), `src/lib/host-events.js` (`HostEventSchema.registration_questions: RegistrationQuestionsSchema.nullable().optional()`; `computeEditTransition` ignores it), `src/lib/event-save-schemas.js` (both sets), host routes (write/read; GET returns it), `src/app/api/events/route.js` (write) + `[id]/route.js` (select), the host edit page, `src/lib/event-duplicate.js` (`DUPLICATE_COLUMNS` + `'registration_questions'`).
- Tests: editor emits the shape; host form posts it; schema accepts/rejects; a questions change on a published host event does NOT re-review; duplicate carries it. Commit `QUESTIONS.1 — questions editor on the host and staff forms`.

### Task 6: Gates, migration, review, PR

- [ ] Touched suites; full suite alone; the thirteen-command mirror; `npm run build`. Apply 819, `get_advisors`. Fresh whole-branch review → fix pass → push, PR against main (stacked note if #2323 has not merged), changelog entry, auto-merge (Richard: "merge when ready").
