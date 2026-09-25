## PR REPLACE.1 — replace a coach in one action, and offer an unfilled shift to the team

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two manager actions that each replace a slow, noisy sequence today.
- **(a) Replace coach.** On an assigned coach of a shift (draft or published), one action hands the shift from coach A to coach B. One change-log pair, and one notice each: A "You're no longer on the roster for Tue 29 Sep at 06:00", B "You're now on the roster for Tue 29 Sep at 06:00". Today it takes six clicks (open, remove, confirm, add coach, pick, assign) and sends two unrelated notices.
- **(b) Offer to team.** On an unfilled or short PUBLISHED shift, the manager posts it to every coach who could take it (default 6: studio members who are free at that time across the organisation's studios, not on approved leave, not unavailable). One push each, only between 07:00 and 22:00 studio time; the offer itself is live at once. The first to claim gets the shift (a database lock decides), and the managers are told who took it. The offer closes when the shift starts, when a manager withdraws it, or when the shift gets its coach another way.

**Why:** the 19 Sep scheduler product review, item "fewer clicks to fix one". Replace is the commonest edit on a published week (sick coach, swap by phone), and "offer to team" is what managers do today by WhatsApp group.

**Split, merge order:** this is too big for one PR. It ships as two, in this order:
1. **REPLACE.1a — Replace coach.** M. **No migration.** OTA (phone Manage mode). Tasks 1a-0 to 1a-9.
2. **REPLACE.1b — Offer to team.** M. **Mig 640.** OTA (`shared/`, phone Dashboard and Manage mode, notification routing). Tasks 1b-0 to 1b-12. Merges after 1a because mig 640 also seeds the heartbeat row for 1a's held-notice arm and 1b wires that stamp (1b Task 7).

One phone update at a time: after 1a merges, wait for its EAS Update run to go green before merging 1b, and before GRID.1 (this batch's partner) if GRID.1 publishes.

**Depends on:**
- **13 SHIFTTYPE.1, merged** (#1759, mig 628): `shift_templates.kind`, `shared/shift-kind.js`, admin min = 0.
- **19 CANDIDATES.1, soft.** The replace picker IS the assign picker in single-select mode (web `AssignCoachModal`, phone `CoachPickerSheet`), so whatever ranking CANDIDATES.1 puts into those two pickers is what the manager sees. REPLACE adds no ranking or filtering of its own. If CANDIDATES.1 has not merged, both pickers work exactly as today. **No `19-CANDIDATES.1.md` existed when this was written**, so there was no eligibility module to reuse; see 1b Task 0 for how 1b adopts it if it exists at build time.
- **16 AVAIL.1a, HARD for 1b only** (mig 630 `staff_unavailability`, `shared/availability.js` `unavailableFor`). 1a does not read availability.
- **14 BLOCKEDIT.1:** not a dependency, but it rewrites `BlockDetailModal` and adds an arm to the same cron. Find every anchor below by its quoted text, not its line number.

**Anchors** are verified against `origin/main` `d11e6971` (#1760). Batch 4 and 5 PRs (BLOCKEDIT.1, ICSFEED.1, AVAIL.2, CANDIDATES.1) will have moved lines by build time; the quoted text is the anchor.

**Worktree:** one fresh worktree per PR, off fresh `origin/main`:
```bash
git fetch origin main && git worktree add ../un1t-crm-replace1a -b replace-1a origin/main && cd ../un1t-crm-replace1a && npm ci
# later, after 1a has merged:
git fetch origin main && git worktree add ../un1t-crm-replace1b -b replace-1b origin/main && cd ../un1t-crm-replace1b && npm ci
```
Never `git stash`. Run single files with `npx vitest run <file>`. Do not run the whole suite or `npm run build` until the PR gate (8GB machine).

**Rules that bite here (read `CLAUDE.md` Invariants first):**
- **Service-role routes get no RLS.** Every new route loads its row, then `assertLocationAccessOr404(user, <row's location>)`, then `hasRoleAtLocation(user, <row's location>, MANAGER_ROLES)` for manager actions. A foreign id is 404, a member who is not a manager there is 403 (the SCHEDROLES.1 posture of `DELETE /api/schedule/assignments/[id]`).
- **A bare supabase write resolves, it does not throw.** Every write destructures `error`; a guarded UPDATE judges `.select('id')` rows (zero rows = someone got there first). Both PRs arm their new write paths in `eslint.guardrails.config.mjs`.
- **Quiet hours gate the notice, never the state** (`src/lib/staff-push-hours.js` header: a push that is not a reply to the recipient's own action goes out only 07:00-22:00 studio time). The replace and the offer happen at once; their pushes wait for the band.
- **A send-once claim taken before the send needs a lease** (invariant (c)). Offer notices lease on the offer row and send under attempt-numbered ledger keys: a crash costs a duplicate, never the notice. Replace notices are stamped only after delivery; the arm re-sends an unstamped one.
- **A new bulk writer of `shift_assignments` must drop non-members.** Neither PR writes in bulk, but both single writers refuse a non-member or non-rosterable coach, in the route AND (1b) in the claim function.
- **Push `category` is the bare name.** Both PRs use the registered `swap` (offers) and `shift_adjusted` (replace, via NOTIFY.1's `notifyRosterChanges`). No new category, so no `MOBILE_PERMISSIONS` change and no parity entry.
- **`shared/` is the seam; mobile decisions live in `mobile/lib`** with vitest tables beside them. There is no RN component test runner; `.jsx` files only render.
- **OTA:** anything under `shared/**`, `mobile/lib/**`, `mobile/components/**`, `mobile/app/**` publishes a phone update at 100% on merge (`.github/workflows/eas-update.yml:156`, `:199`). Both PR bodies say so.
- **The repo is PUBLIC.** Fixtures use `Coach A`, `Coach B`, `Studio North`, never real names.

---

### Decisions

#### REPLACE.1a

**D1. A replace is ONE guarded UPDATE of A's assignment row. No migration, no RPC.** One statement is atomic on its own: the row goes from A to B, or nothing happens.
```
UPDATE shift_assignments SET profile_id = B, status = 'scheduled', <clears>, assigned_by = <manager>, assigned_at = now()
 WHERE id = <A's row> AND profile_id = A AND status <> 'cancelled' AND arrived_at IS NULL
```
- Zero rows means the row changed since it was read (someone removed A, A arrived, another replace won): 409 `changed`, "This shift has just changed. Refresh and try again."
- `23505` on the `(block_id, profile_id)` key (mig 067) means B is already on the block: 409 `already_on_shift`. The route checks that first; the key is the race-proof half.
- B's cancelled tombstone on the block, if any, is deleted first. The assign route does the same (`src/app/api/schedule/blocks/[id]/assignments/route.js:209-221`), because the unique key does not care that the old row is cancelled.
- Why not DELETE A + INSERT B inside an RPC: it needs a migration and a function for no gain, and moving the row keeps its id. Every FK into `shift_assignments` is `ON DELETE SET NULL` (swap rows, `staff_attendance_events.matched_assignment_id`, `schedule_notifications.shift_id`), so a delete would work too, but it would orphan those rows for nothing.
- The mig 604 overlap trigger fires on `UPDATE OF profile_id`. It only WARNS (`604_shift_assignment_overlap_guard.sql` header), so it never refuses a replace.

**D2. Nothing carries from A to B.** The five `SWAP_MOVE_CLEARS` columns (`src/lib/swap-lifecycle.js:23`: both time overrides, the partial reason, the arrival stamp and its source) and `notes` are cleared; `status` becomes `'scheduled'`. This is SWAPS.2's rule, "a shift that changes hands starts clean": an override was A's paid window ("left at 11, sick"), and `notes` is a manager's note about A. If B should work a partial window, the manager adjusts B afterwards (one more tap). Flagged as review note 1.

**D3. When a replace is refused.**
- **A's row is not live** (cancelled): 409 `not_live`.
- **B is A:** 400 `same_coach`.
- **A has arrived** (`arrived_at` set): 409 `already_arrived`. The shift is being worked; this is history now (the mig 622 rule for tombstones, applied here).
- **The shift has started**: 409 `shift_started`. "Started" is `swapShiftHasStarted` (`src/lib/swap-cover.js:254`), the ONE predicate the swap PUT and the cover sweep use, on the studio's clock, asked twice: at the block's start (B works the block's window) and at A's own effective start (A may have started early on an override). Either one refuses. A past shift is covered by this: its start has passed.
- **B is not a member of the block's studio**: 400 `not_at_studio`. **B is deactivated or deleted:** 400 with `notRosterableError`'s words (`src/lib/roster-write.js:322`). Same rules and same order as the assign route (`blocks/[id]/assignments/route.js:101-144`). B's profile is read only once B is a proven member, so a foreign id never leaks a name.
- **B is already on the block** (live): 409 `already_on_shift`.
- Draft and published rosters are both allowed. On a draft nothing is logged or told (below).

**D4. Leave and overlap are a confirm step, not a wall.** Before writing, the route runs `findSwapConflicts` (`src/lib/swap-conflicts.js:27`) for B as a `taker` move onto the block, the SAME check a swap approval runs (SWAPS.2). Any conflict answers 409 `{ code: 'swap_conflicts', conflicts: [...] }` with the server's sentences, unless the body carries `confirm_conflicts: true`. A read failure is a `check_failed` conflict, so the manager is asked rather than waved through. The phone already has the reader for this answer (`mobile/lib/swap-conflicts.js:35` `isSwapConflictRefusal`, `:59` `swapConflictLines`), so the same code value is reused. Working-time and availability advisories are CANDIDATES.1's picker badges; the route does not repeat them.

**D5. Open swaps on A's shift are closed in the same request.** After the move, any `pending`/`awaiting_approval` swap whose `requester_shift_id` or `target_shift_id` is that row would describe a shift A no longer holds. They are set `cancelled` with `reviewed_by` = the manager and `review_note` = `REPLACE_SWAP_CLOSE_NOTE` ("Closed: a manager gave this shift to another coach."). With a reviewer set, the cover sweep's pass 2 (`src/lib/swap-cover-server.js:238-245`, which reads only rows with NO reviewer) never mistakes it for a system close that owes a notice. Nobody else is told: A gets the "no longer on the roster" notice, and a colleague who had claimed it sees the card disappear. If this update fails it is logged with `logError` and the replace stands: the swap approval RPCs refuse such a swap anyway (`swap_stale`, mig 615). Flagged as review note 3.

**D6. The change log: exactly two rows, on a published roster only.** `A unassigned` and `B assigned`, both `details: { via: 'replace' }`, through `logRosterChange` (`src/lib/roster-change-log.js:30`), which no-ops on a draft (a draft edit rides the first publish). The drawer prints them "Removed Coach A from Tue 29 Sep 6am (coach replaced)" / "Assigned Coach B to Tue 29 Sep 6am (coach replaced)" (`VIA_NOTE`, `src/lib/roster-change-format.js:84`).

**D7. One notice each, through NOTIFY.1's path, inside quiet hours.**
- The path is `notifyRosterChanges` (`src/lib/roster-change-notify.js:115`): per coach, `shift_adjusted`, email fallback, skips the actor and past dates, stamps `notified_at` only on delivery, leaves an opted-out coach for the re-publish safety net. A replace is two changes for two DIFFERENT coaches, so it is exactly one message each.
- Its single-change message gains the shift's start time when the change carries one (`startTime`): "You're now on the roster for Tue 29 Sep at 06:00." Callers that pass no time keep their exact words (every existing caller).
- **In band (07:00-22:00 studio time):** the route sends from `after()`.
- **Out of band:** the route sends nothing; the two rows stay unstamped. A new arm, `runReplaceNotices` (`src/lib/shift-replace-notify.js`), on every tick of the `*/5` `send-push-reminders` cron, sends every unstamped `via: 'replace'` row that is older than 2 minutes, younger than 48 hours, for a shift today or later, once its studio is in band. The 2-minute gap is the route's own lease on a fresh row; after it, the arm is also the recovery for an `after()` that died.
- **Net zero is silent.** Replaced and put back overnight (A off, B on, B off, A on) nets to nothing per coach and shift: those rows are stamped with no message.
- The response says which: `notice: 'now' | 'morning' | 'none'` (`none` = draft). The web toast and the phone alert say "Coach A and Coach B are told after 7am; if the shift is before then, ring them." That is BLOCKEDIT.1's posture for a shift edited overnight (index default 22).
- Why an arm and not "send anyway": `staff-push-hours.js` states the band as absolute, and BLOCKEDIT.1 already moved its notices to this cron for the same reason. The existing single assign/remove still sends at any hour (NOTIFY.1 predates the rule); review note 2.

**D8. The picker is the assign picker in single-select mode.** Web: `AssignCoachModal` gains `mode="replace"` (radio, one pick, "Replace Coach A", submit "Replace with Coach B"). Phone: Manage mode's coach press menu gains "Replace coach", which opens `CoachPickerSheet` titled "Replace Coach A". Both exclude everyone already live on the block (A included) as they do today. CANDIDATES.1's ranking comes along for free.

**D9. Who may replace:** a manager (`MANAGER_ROLES`: master, owner, manager, head_coach) AT the block's studio. Coarse pre-check `hasRoleAtAnyLocation` (403 "Only a manager can replace a coach"), then 404 for a non-member of the studio, 403 for a member who is not a manager there.

#### REPLACE.1b

**E1. A new table, `shift_offers` (mig 640), not the swap table.** An "open shift" does not fit `shift_swap_requests`:
- A swap is about an ASSIGNMENT (`requester_shift_id`), and an unfilled shift has none. The column is nullable since mig 603, but a NULL there is exactly how the cover sweep recognises a swap whose shift was DELETED: `dueAction` returns `expire / shift_removed` on the first tick (`src/lib/swap-cover.js:302`). Every offer would be closed within 15 minutes.
- `requester_id` is `NOT NULL` (mig 010): an offer has no giver.
- A swap claim is `awaiting_approval` until a manager approves (`resolveSwapTransition`, the approvals provider, the approvals badge, the T-48/T-12 nudges all count it). An offer is first-come, no approval. Reusing the table would put every offer into the approvals inbox and the nudge sweep.
- The open-pool GET (`src/app/api/schedule/swaps/route.js:83,99`: `target_id IS NULL AND status = 'pending'`) would list offers as "X needs cover" with no shift.
What IS reused: `swapShiftHasStarted` (start predicate), `evaluateSwapMoveConflicts` + the open pool's half-day rule (who is free), `shiftWhenLabel` (copy), `notifyUsersOnce` (ledger), the COVERLOOP audience posture (a failed read shrinks or delays the audience, never widens it), and the phone's open-swaps card pattern.

**E2. One open offer per shift, one place per offer.** A partial unique index `(block_id) WHERE status = 'open'` makes a second open offer impossible (race-proof; the route maps `23505` to 409 "already offered"). An offer fills ONE place. A class shift two coaches short is offered, claimed, then offered again. Flagged as review note 5.

**E3. What may be offered** (`offerRefusal` in `shared/offer-to-team.js`, the ONE rule for the web button, the phone button and the route):
- the roster is published (coaches never see drafts, D1 of ROSTER-FIX.2);
- the shift is today or later and has not started (the route asks `swapShiftHasStarted` on the studio clock; the buttons pass `started: false` and let the route have the last word);
- there is no open offer for it;
- it still needs someone: live coaches below the target and below `max_coaches`. **Target: a class shift's `min_coaches` (at least 1); an admin shift: 1.** An admin shift has no minimum (SHIFTTYPE.1), so "short" never applies to it: it can be offered only while EMPTY. Index default 20 already keeps a posted admin swap nobody takes escalating; an admin offer follows the same logic.

**E4. Who is offered it (default 6), one predicate:** `offerEligibility` in `src/lib/shift-offer-notice.js`. A person is eligible for a shift when they are:
- a member of the shift's studio (`profile_locations`), active, not deleted (`isRosterableProfile`'s rule);
- not already live on the shift;
- not on APPROVED leave covering the date, whole day (a half-day request passes, as in the open pool, `src/lib/swap-cover.js:81`: which half is not recorded);
- not on another LIVE shift overlapping the window at any studio of the same organisation (`evaluateSwapMoveConflicts`, `src/lib/swap-lifecycle.js:428`; the organisation boundary via `siblingLocationIds`, `src/lib/sibling-locations.js`);
- not unavailable for the window (`unavailableFor`, AVAIL.1a `shared/availability.js`).
The audience is every eligible member except the manager who posted it. **Managers and head coaches are included** (they coach classes); the open-pool rule excluded them only because they were already told by `swap_open`. The SAME predicate decides the coach's list (a coach sees an offer only if it would have been pushed to them) and, minus `unavailable`, the claim (below).

**E5. The claim is decided in the database.** `claim_shift_offer(p_offer_id, p_profile_id)` (mig 640, service_role only) locks the offer row `FOR UPDATE`, so two coaches claiming at once serialise on it: the first sees `open` and wins, the second waits, then sees `claimed` and gets `offer_not_open` (409 "Someone else has just taken this shift."). Inside the same transaction it locks the shift, re-checks membership and activity, "already on it", the roster still published, and still needed (a manager may have filled it meanwhile: then the offer closes as `filled` and the claim is refused), clears the claimant's cancelled tombstone, inserts the assignment and closes the offer. **The route** checks, before calling it: the shift has not started (the one predicate), and the claimant is not on approved leave that day or on an overlapping shift (they cannot be in two places). **Unavailability does not block a claim**: the coach claiming is telling us they are free.

**E6. Notices.**
- **Broadcast**: one push per eligible coach, category `swap` (registered, email fallback), `data.type: 'shift_offer'`. "A shift is up for grabs: Morning, Tue 29 Sep, 06:00 to 07:00 at Studio North. First to claim it gets it. Tap to take it."
- **Taken**: the studio's managers (`MANAGER_ROLES`, `resolveRoleRecipientIds`), minus the claimant, category `swap`, `data.type: 'shift_offer_taken'`. "Coach B took Morning, Tue 29 Sep, 06:00 to 07:00."
- **Both only 07:00-22:00 studio time.** The offer is live the moment it is posted (web Today, phone Dashboard, the manager's own screens); only the push waits.
- **Exactly once, never lost:** the sender first takes a LEASE on the offer row (a guarded UPDATE setting `notice_lease_until = now + 10 min` and `notice_attempts + 1`), sends under the ledger key `shift_offer_<kind>:<offer id>:a<attempt>`, then stamps (`broadcast_at` / `taken_notified_at`). A process killed after the send and before the stamp leaves an expired lease; the next tick takes attempt n+1 under a NEW key and sends again: a duplicate, never a loss. A read failure or a send that failed outright releases the lease. After 5 attempts it gives up loudly (`logError`, `broadcast_outcome = 'gave_up'`, which the manager's screens show as "the notification couldn't be sent").
- One sender for both paths: the route's `after()` and the cron arm both call `processOffer`, so there is no route-vs-cron race beyond the lease.
- **No notice when an offer expires or is withdrawn.** The coaches' cards simply go; the manager sees the gap on the calendar as before. Review note 6.

**E7. How an offer closes** (`status`): `claimed` (the RPC); `withdrawn` (a manager); `filled` (the shift no longer needs anyone: the RPC at claim time, the sweep every 5 minutes, and every list filters on it live, so a card disappears the moment a manager assigns someone); `expired` (the shift started, or its roster is no longer published: the sweep).

**E8. The arm:** `runShiftOfferSweep` on every tick of `*/5` `send-push-reminders`, with its own heartbeat row `shift-offer-sweep` (mig 640, the HEARTBEAT.1 posture). Mig 640 also seeds `replace-notices` for 1a's arm, and 1b adds that stamp. `*/5`, not the `*/15` checklist sweep where the swap cover arm lives: a 07:00 broadcast and an expiry at start want the finer tick.

**E9. Surfaces.** Manager: the web block dialog ("Offer to team" button, or the offer's state and "Withdraw"), phone Manage mode (the same on the block card). Coach: a "Shifts up for grabs" section on web Today and on the phone Dashboard, above the open swaps, with Claim. A coach sees date, times, shift name and studio name only; never counts or minimums (COACHSCOPE.1's posture).

**E10. Who may post or withdraw:** a manager at the block's studio (same gate as assign). Who may claim: any rosterable member of the studio (the RPC re-checks).

---

### File map

**REPLACE.1a**

| File | Change | OTA |
|---|---|---|
| `src/lib/roster-change-notify.js` | Modify: single-change message carries the start time | |
| `src/lib/roster-change-notify.test.js` | Modify: tests for the time | |
| `src/lib/roster-change-format.js` | Modify: `VIA_NOTE.replace` | |
| `src/lib/roster-change-format.test.js` | Modify: one sentence test | |
| `src/lib/shift-replace.js` | Create: pure rules, copy, net-change planner | |
| `src/lib/shift-replace.test.js` | Create | |
| `src/lib/scripted-db.test-helpers.js` | Create: scripted supabase fake (test only; 1b reuses it) | |
| `src/lib/shift-replace-server.js` | Create: context read, the guarded move, closing open swaps | |
| `src/lib/shift-replace-server.test.js` | Create | |
| `src/app/api/schedule/assignments/[id]/replace/route.js` | Create: `POST` | |
| `src/app/api/schedule/assignments/[id]/replace/route.test.js` | Create | |
| `src/lib/openapi.js`, `src/lib/openapi.test.js` | Modify: register the route | |
| `src/lib/shift-replace-notify.js` | Create: the held-notice arm | |
| `src/lib/shift-replace-notify.test.js` | Create | |
| `src/app/api/cron/send-push-reminders/route.js` | Modify: the arm, isolated | |
| `src/app/api/cron/send-push-reminders/route.test.js` | Modify: mock + tests | |
| `eslint.guardrails.config.mjs` | Modify: arm the two write paths | |
| `src/components/ScheduleCalendar.jsx` | Modify: Replace button, `AssignCoachModal mode="replace"`, handler | |
| `mobile/lib/schedule-api.js`, `mobile/lib/schedule-api.test.js` | Modify: `replaceAssignment` | yes |
| `mobile/lib/schedule-manage.js`, `mobile/lib/schedule-manage.test.js` | Modify: `coachPressActions`, `replacePickerTitle`, `replaceResultAlert` | yes |
| `mobile/components/schedule/ManageMode.jsx` | Modify: menu item, second picker, flow | yes |
| `src/lib/notifications-registry.js` | Modify: `shift_adjusted` description mentions replace | |

**REPLACE.1b**

| File | Change | OTA |
|---|---|---|
| `supabase/migrations/640_shift_offers.sql` | Create: table, claim RPC, two heartbeat rows | |
| `tests/migration-640-shift-offers.test.js` | Create (PGlite) | |
| `shared/offer-to-team.js`, `shared/offer-to-team.test.js` | Create: offerability, target, labels | yes |
| `src/lib/swap-cover.js` | Modify: `export` `isHalfDayLeave` (one word) | |
| `src/lib/shift-offer-notice.js`, `.test.js` | Create: eligibility, audience, sweep decision, payloads, RPC error map | |
| `src/lib/shift-offer-server.js`, `.test.js` | Create: reads, lease + deliver + stamp, sweep, create/withdraw/claim/list | |
| `src/app/api/schedule/blocks/[id]/offer/route.js`, `.test.js` | Create: `POST` | |
| `src/app/api/schedule/offers/route.js`, `.test.js` | Create: `GET` (coach view, manager view) | |
| `src/app/api/schedule/offers/[id]/route.js`, `.test.js` | Create: `DELETE` (withdraw) | |
| `src/app/api/schedule/offers/[id]/claim/route.js`, `.test.js` | Create: `POST` | |
| `src/lib/openapi.js`, `src/lib/openapi.test.js` | Modify: four paths | |
| `src/lib/cron-arm-health.js`, `.test.js` | Modify: two heartbeat names, two health rules | |
| `src/app/api/cron/send-push-reminders/route.js`, `.test.js` | Modify: offer arm, both stamps | |
| `src/lib/notifications-registry.js` | Modify: `swap` description + recipients | |
| `mobile/lib/notification-nav.js`, `.test.js` | Modify: `shift_offer`, `shift_offer_taken` | yes |
| `src/components/schedule/useShiftOffers.js`, `.test.js` | Create: the manager's offers for the visible period | |
| `src/components/schedule/OfferToTeamControl.jsx`, `.test.jsx` | Create | |
| `src/components/ScheduleCalendar.jsx` | Modify: load offers, pass to `BlockDetailModal` | |
| `src/components/dashboard/OfferedShifts.jsx`, `.test.jsx` | Create: web Today section | |
| `src/app/dashboard/today/page.js` | Modify: mount it | |
| `mobile/lib/schedule-api.js`, `.test.js` | Modify: four wrappers | yes |
| `mobile/lib/offer-cards.js`, `.test.js` | Create: coach card + manager control decisions | yes |
| `mobile/components/dashboard/PersonalDashboard.jsx` | Modify: "Shifts up for grabs" | yes |
| `mobile/components/schedule/ManageMode.jsx`, `BlockCard.jsx` | Modify: offer control | yes |
| `eslint.guardrails.config.mjs` | Modify: arm the write paths | |

---

## REPLACE.1a — Replace coach

### Task 1a-0: Preconditions (no commit)

- [ ] **Step 1: Fresh worktree and a clean base.**

```bash
cd ../un1t-crm-replace1a && git log --oneline -1 && git status --short | wc -l
```
Expected: the tip of `origin/main`, `0`.

- [ ] **Step 2: Which batch-4/5 PRs are in, and where the anchors moved.**

```bash
git log origin/main --oneline -40 | grep -E 'CANDIDATES.1|BLOCKEDIT.1|ICSFEED.1|AVAIL.2|GRID.1'
grep -n "function AssignCoachModal\|function BlockDetailModal\|function AssignmentRow\|onUnassign={async\|const \[rowBusy\|function showToast\|const todayStr\|const isManager = " src/components/ScheduleCalendar.jsx
grep -n "function onCoachPress\|<CoachPickerSheet\|setPickerBlock(null)" mobile/components/schedule/ManageMode.jsx
grep -n "runShiftReminders\|SHIFT_REMINDERS_HEARTBEAT\|shift_arm_failed: 0" src/app/api/cron/send-push-reminders/route.js
```
Write the line numbers into the task notes. If CANDIDATES.1 restructured `AssignCoachModal` or `CoachPickerSheet`, Task 1a-7/1a-8 apply the same four changes to its version (single select, title, submit label, no capacity line); do not reintroduce the old code.

- [ ] **Step 3: The functions this PR builds on still say what it assumes.**

```bash
grep -n "export const SWAP_MOVE_CLEARS" -A7 src/lib/swap-lifecycle.js
grep -n "export const SWAP_CONFLICTS_CODE" src/lib/swap-lifecycle.js
grep -n "export function swapShiftHasStarted\|export const OPEN_SWAP_STATUSES" src/lib/swap-cover.js
grep -n "export async function findSwapConflicts" src/lib/swap-conflicts.js
grep -n "export function buildRosterChangeMessage\|export async function notifyRosterChanges" src/lib/roster-change-notify.js
grep -n "export function inStaffPushHours\|export function resolveStaffTimeZone" src/lib/staff-push-hours.js
grep -n "export function isRosterableProfile\|export function notRosterableError" src/lib/roster-write.js
```
Expected: every line found; `SWAP_MOVE_CLEARS` lists `start_time_override, end_time_override, partial_reason, arrived_at, arrival_source`.

---

### Task 1a-1: The roster-change notice carries the shift's time; the drawer names a replace

**Files:** Modify `src/lib/roster-change-notify.js`, `src/lib/roster-change-notify.test.js`, `src/lib/roster-change-format.js`, `src/lib/roster-change-format.test.js`.

- [ ] **Step 1: Write the failing tests.** In `src/lib/roster-change-notify.test.js`, inside `describe('buildRosterChangeMessage', …)` (after the `'one removal'` case), add:

```js
  // REPLACE.1a — a change may carry the shift's start ('HH:MM:SS'); a single
  // change then names it. Every caller that passes none keeps its words.
  it('one addition with its start time', () => {
    expect(buildRosterChangeMessage([{ ...change('c1', '2026-09-29'), startTime: '06:00:00' }])).toEqual({
      title: 'Added to a shift',
      body: "You're now on the roster for Tue 29 Sep at 06:00.",
    })
  })

  it('one removal with its start time', () => {
    expect(buildRosterChangeMessage([{ ...change('c1', '2026-09-29', 'unassigned'), startTime: '17:30' }])).toEqual({
      title: 'Removed from a shift',
      body: "You're no longer on the roster for Tue 29 Sep at 17:30.",
    })
  })

  it('an unreadable start time is left out, never printed', () => {
    for (const startTime of [null, '', '25:00:00', '6am', undefined]) {
      expect(buildRosterChangeMessage([{ ...change('c1', '2026-09-29'), startTime }]).body)
        .toBe("You're now on the roster for Tue 29 Sep.")
    }
  })
```

In `src/lib/roster-change-format.test.js`, next to the other `rosterChangeSentence` via-note cases, add:

```js
  it('REPLACE.1a — a replace names itself on both rows', () => {
    const base = { block_date: '2026-09-29', start_time: '06:00:00', details: { via: 'replace' } }
    expect(rosterChangeSentence({ ...base, action: 'assigned', coach_name: 'Coach B' }))
      .toBe('Assigned Coach B to Tue 29 Sep 6am (coach replaced)')
    expect(rosterChangeSentence({ ...base, action: 'unassigned', coach_name: 'Coach A' }))
      .toBe('Removed Coach A from Tue 29 Sep 6am (coach replaced)')
  })
```

- [ ] **Step 2: Run them, expect failure.**

```bash
npx vitest run src/lib/roster-change-notify.test.js src/lib/roster-change-format.test.js
```
Expected: the three new `buildRosterChangeMessage` cases and the replace sentence FAIL (no time; no note); every other case passes.

- [ ] **Step 3: Implement.** In `src/lib/roster-change-notify.js`, directly above `const shifts = (n) =>` (line 33), add:

```js
// REPLACE.1a — 'HH:MM(:SS)' -> 'HH:MM'; '' for anything else, so a bad value
// is left out of the sentence rather than printed.
function shiftStartLabel(t) {
  const m = String(t ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/)
  return m ? `${m[1]}:${m[2]}` : ''
}
```

Replace the single-change branch of `buildRosterChangeMessage` (the block starting `if (changes.length === 1) {`) with:

```js
  if (changes.length === 1) {
    const day = formatShiftDate(first)
    // REPLACE.1a — a change that carries its start names it: a replace tells
    // the outgoing and the incoming coach about the same 06:00 shift.
    const at = shiftStartLabel(changes[0].startTime)
    const when = at ? `${day} at ${at}` : day
    return added === 1
      ? { title: 'Added to a shift', body: `You're now on the roster for ${when}.` }
      : { title: 'Removed from a shift', body: `You're no longer on the roster for ${when}.` }
  }
```

In the JSDoc of `notifyRosterChanges`, change the `opts.changes` type to
`Array<{coachId: string, blockId: string, blockDate: string, action: string, startTime?: string|null}>`.

In `src/lib/roster-change-format.js`, add to `VIA_NOTE` (line 84) after `swap_drop: 'dropped shift approved',`:

```js
  replace: 'coach replaced', // REPLACE.1a
```

- [ ] **Step 4: Run, expect pass.** Same command. Expected: `0 failed`.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/roster-change-notify.js src/lib/roster-change-notify.test.js src/lib/roster-change-format.js src/lib/roster-change-format.test.js
git commit -m "REPLACE.1a — a single roster-change notice names the shift's start time; the drawer names a replace

buildRosterChangeMessage reads an optional startTime on the change; callers
that pass none keep their exact words. VIA_NOTE.replace = 'coach replaced'.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-2: `src/lib/shift-replace.js`, the pure rules

**Files:** Create `src/lib/shift-replace.js`, `src/lib/shift-replace.test.js`.

- [ ] **Step 1: Write the failing test.**

```js
// src/lib/shift-replace.test.js
// REPLACE.1a — the pure half of "replace coach": may this assignment go from
// coach A to coach B now, what the log and the notices say, and what the held
// notice arm sends.
import { describe, it, expect } from 'vitest'
import {
  replaceRefusal, replaceRefusalResponse, replaceShiftStarted, replaceChanges,
  replaceNoticeWhen, replaceResponseOutcome, replacePickerCopy, netReplaceChanges,
  REPLACE_VIA, REPLACE_SWAP_CLOSE_NOTE,
} from './shift-replace'

// Tue 29 Sep 2026, Dublin summer time (UTC+1): 06:00 Dublin = 05:00Z.
const BLOCK = { id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00' }
const A = { id: 'as-1', profile_id: 'coach-a', block_id: 'b1', status: 'scheduled', arrived_at: null, start_time_override: null }
const B_OK = { toIsMember: true, toProfile: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null }, liveOnBlockIds: ['coach-a'] }
const TZ = 'Europe/Dublin'

describe('replaceRefusal', () => {
  const ask = (over = {}) => replaceRefusal({ assignment: A, block: BLOCK, toProfileId: 'coach-b', started: false, ...B_OK, ...over })

  it('allows a live, unstarted shift to go to a rosterable member of the studio', () => {
    expect(ask()).toBeNull()
  })

  it('refuses, first thing a manager can act on first', () => {
    expect(ask({ assignment: { ...A, status: 'cancelled' } }).code).toBe('not_live')
    expect(ask({ assignment: null }).code).toBe('not_live')
    expect(ask({ toProfileId: 'coach-a' }).code).toBe('same_coach')
    expect(ask({ assignment: { ...A, arrived_at: '2026-09-29T04:58:00Z' } }).code).toBe('already_arrived')
    expect(ask({ started: true }).code).toBe('shift_started')
    expect(ask({ toIsMember: false }).code).toBe('not_at_studio')
    expect(ask({ liveOnBlockIds: ['coach-a', 'coach-b'] }).code).toBe('already_on_shift')
  })

  it('a deactivated or deleted coach is refused in the assign route\'s words', () => {
    expect(ask({ toProfile: { id: 'coach-b', full_name: 'Coach B', active: false } }))
      .toEqual({ code: 'profile_not_rosterable', status: 400, error: expect.stringMatching(/^Coach B is deactivated/) })
    expect(ask({ toProfile: { id: 'coach-b', full_name: 'Coach B', active: false, deleted_at: '2026-09-01' } }).error)
      .toMatch(/permanently deleted/)
  })

  it('a non-member is refused BEFORE their profile is judged (nothing foreign is described)', () => {
    expect(ask({ toIsMember: false, toProfile: null }).code).toBe('not_at_studio')
  })

  it('carries a status and the words', () => {
    expect(ask({ started: true })).toEqual({ code: 'shift_started', status: 409, error: expect.stringMatching(/already started/) })
    expect(ask({ toProfileId: 'coach-a' }).status).toBe(400)
  })
})

describe('replaceRefusalResponse', () => {
  it('maps a code from the write to its status and words', () => {
    expect(replaceRefusalResponse('changed')).toEqual({ status: 409, body: { success: false, code: 'changed', error: 'This shift has just changed. Refresh and try again.' } })
    expect(replaceRefusalResponse('already_on_shift').status).toBe(409)
  })
})

describe('replaceShiftStarted: the one predicate, on the block start and on the outgoing coach\'s own start', () => {
  it('not started before the block starts', () => {
    expect(replaceShiftStarted({ block: BLOCK, assignment: A }, Date.parse('2026-09-29T04:59:00Z'), TZ)).toBe(false)
  })
  it('started at the block start, studio clock', () => {
    expect(replaceShiftStarted({ block: BLOCK, assignment: A }, Date.parse('2026-09-29T05:00:00Z'), TZ)).toBe(true)
  })
  it('an outgoing coach who started EARLIER on an override counts', () => {
    const early = { ...A, start_time_override: '05:30:00' }
    expect(replaceShiftStarted({ block: BLOCK, assignment: early }, Date.parse('2026-09-29T04:45:00Z'), TZ)).toBe(true)
  })
  it('a LATER override does not delay it: the incoming coach works the block', () => {
    const late = { ...A, start_time_override: '06:30:00' }
    expect(replaceShiftStarted({ block: BLOCK, assignment: late }, Date.parse('2026-09-29T05:10:00Z'), TZ)).toBe(true)
  })
  it('a past day has started', () => {
    expect(replaceShiftStarted({ block: { ...BLOCK, block_date: '2026-09-20' }, assignment: A }, Date.parse('2026-09-29T04:00:00Z'), TZ)).toBe(true)
  })
  it('an unreadable date is NOT started: never refuse on a guess', () => {
    expect(replaceShiftStarted({ block: { ...BLOCK, block_date: 'nope' }, assignment: A }, Date.parse('2026-09-29T09:00:00Z'), TZ)).toBe(false)
  })
})

describe('replaceChanges', () => {
  it('two entries, A off and B on, each with the shift start', () => {
    expect(replaceChanges({ block: BLOCK, fromProfileId: 'coach-a', toProfileId: 'coach-b' })).toEqual([
      { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: 'coach-a', action: 'unassigned' },
      { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: 'coach-b', action: 'assigned' },
    ])
  })
})

describe('replaceNoticeWhen', () => {
  it('a draft tells nobody now; a published shift tells now in band, from 07:00 out of it', () => {
    expect(replaceNoticeWhen({ published: false, inBand: true })).toBe('none')
    expect(replaceNoticeWhen({ published: true, inBand: true })).toBe('now')
    expect(replaceNoticeWhen({ published: true, inBand: false })).toBe('morning')
  })
})

describe('replaceResponseOutcome (the web toast)', () => {
  const names = { fromName: 'Coach A', toName: 'Coach B' }
  it('a conflicts refusal asks to confirm, in the server\'s sentences', () => {
    const body = { success: false, code: 'swap_conflicts', error: 'x', conflicts: [{ message: 'Coach B has approved holiday on 2026-09-29, which covers the shift on 2026-09-29.' }] }
    expect(replaceResponseOutcome(409, body, names)).toEqual({ kind: 'confirm', message: body.conflicts[0].message })
  })
  it('any other failure is an error in the server\'s words', () => {
    expect(replaceResponseOutcome(409, { success: false, code: 'shift_started', error: 'This shift has already started.' }, names))
      .toEqual({ kind: 'error', message: 'This shift has already started.' })
    expect(replaceResponseOutcome(500, {}, names)).toEqual({ kind: 'error', message: 'Could not replace the coach.' })
  })
  it('success says who is told and when', () => {
    const done = (notice) => replaceResponseOutcome(200, { success: true, data: { notice } }, names)
    expect(done('now')).toEqual({ kind: 'done', tone: 'success', message: 'Coach B is on the shift. Coach A and Coach B have been told.' })
    expect(done('morning')).toEqual({ kind: 'done', tone: 'warning', message: 'Coach B is on the shift. Coach A and Coach B are told after 7am; if the shift is before then, ring them.' })
    expect(done('none')).toEqual({ kind: 'done', tone: 'success', message: 'Coach B is on the shift. The roster is a draft, so nobody is told until it is published.' })
  })
})

describe('replacePickerCopy', () => {
  it('titles the picker after the coach going off, and the button after the pick', () => {
    expect(replacePickerCopy({ fromName: 'Coach A' })).toEqual({ title: 'Replace Coach A', label: 'Pick the coach who takes this shift', submit: 'Pick a coach' })
    expect(replacePickerCopy({ fromName: 'Coach A', pickedName: 'Coach B' }).submit).toBe('Replace with Coach B')
    expect(replacePickerCopy({ fromName: null, pickedName: 'Coach B', saving: true })).toMatchObject({ title: 'Replace coach', submit: 'Replacing…' })
  })
})

describe('netReplaceChanges (the held-notice arm)', () => {
  const row = (id, coach, action, at, over = {}) => ({
    id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-29', actor_id: 'mgr-1',
    coach_id: coach, action, created_at: `2026-09-28T22:${at}:00Z`, shift_blocks: { start_time: '06:00:00' }, ...over,
  })

  it('one replace: one change per coach, with the shift start and every row id', () => {
    const { send, silent } = netReplaceChanges([row('r1', 'coach-a', 'unassigned', '10'), row('r2', 'coach-b', 'assigned', '10')])
    expect(silent).toEqual([])
    expect(send).toEqual([
      { locationId: 'loc-1', actorId: 'mgr-1', coachId: 'coach-a', blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', action: 'unassigned', rowIds: ['r1'] },
      { locationId: 'loc-1', actorId: 'mgr-1', coachId: 'coach-b', blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', action: 'assigned', rowIds: ['r2'] },
    ])
  })

  it('replaced and put back overnight nets to nothing: silent, every row listed for stamping', () => {
    const rows = [
      row('r1', 'coach-a', 'unassigned', '10'), row('r2', 'coach-b', 'assigned', '10'),
      row('r3', 'coach-b', 'unassigned', '40'), row('r4', 'coach-a', 'assigned', '40'),
    ]
    const { send, silent } = netReplaceChanges(rows)
    expect(send).toEqual([])
    expect(silent.flatMap((s) => s.rowIds).sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('the LAST action wins for an uneven pile, and its actor is the one told about', () => {
    const rows = [
      row('r1', 'coach-a', 'unassigned', '10'),
      row('r2', 'coach-a', 'assigned', '20', { actor_id: 'mgr-2' }),
      row('r3', 'coach-a', 'unassigned', '30', { actor_id: 'mgr-2' }),
    ]
    expect(netReplaceChanges(rows).send).toEqual([
      expect.objectContaining({ coachId: 'coach-a', action: 'unassigned', actorId: 'mgr-2', rowIds: ['r1', 'r2', 'r3'] }),
    ])
  })

  it('a row with no coach, no block or no date is ignored', () => {
    expect(netReplaceChanges([row('r1', null, 'assigned', '10'), row('r2', 'coach-a', 'assigned', '10', { block_id: null })]))
      .toEqual({ send: [], silent: [] })
  })
})

describe('constants', () => {
  it('the via label and the swap close note are fixed strings (matched elsewhere)', () => {
    expect(REPLACE_VIA).toBe('replace')
    expect(REPLACE_SWAP_CLOSE_NOTE).toBe('Closed: a manager gave this shift to another coach.')
  })
})
```

- [ ] **Step 2: Run, expect failure.** `npx vitest run src/lib/shift-replace.test.js` → fails to import `./shift-replace`.

- [ ] **Step 3: Implement.**

```js
// src/lib/shift-replace.js
//
// REPLACE.1a — the PURE half of "replace coach": hand one assignment from
// coach A to coach B in one action. May it happen now, what the change log
// records, what the manager is told, and what the held-notice arm sends.
//
// The DB half is ./shift-replace-server.js; the route is
// src/app/api/schedule/assignments/[id]/replace/route.js; the arm is
// ./shift-replace-notify.js. Decisions D1-D9 are in
// docs/superpowers/plans/2026-09-25-scheduler-wave2-3/20-REPLACE.1.md.

import { swapShiftHasStarted } from './swap-cover'
import { SWAP_CONFLICTS_CODE } from './swap-lifecycle'
import { isLiveAssignment } from './roster'
import { isRosterableProfile, notRosterableError } from './roster-write'

/** roster_change_log.details.via on both rows of a replace. The held-notice arm filters on it. */
export const REPLACE_VIA = 'replace'

/**
 * shift_swap_requests.review_note on an open swap closed because a manager
 * gave its shift to someone else (D5). reviewed_by is set to that manager, so
 * the cover sweep's pass 2, which reads only rows with NO reviewer, never
 * takes it for a system close that owes an expiry notice.
 */
export const REPLACE_SWAP_CLOSE_NOTE = 'Closed: a manager gave this shift to another coach.'

// The route's after() owns a fresh replace notice for this long; after it the
// */5 arm may send it (the arm is also the recovery for an after() that died).
export const REPLACE_NOTICE_ROUTE_OWNS_MS = 2 * 60 * 1000
// Older than this, a row is left to the re-publish safety net.
export const REPLACE_NOTICE_MAX_AGE_MS = 48 * 60 * 60 * 1000

const REFUSALS = Object.freeze({
  not_live: { status: 409, error: 'This coach is no longer on this shift. Refresh and try again.' },
  same_coach: { status: 400, error: 'Pick a different coach: this one is already on the shift.' },
  already_arrived: { status: 409, error: 'This coach has already arrived for the shift, so it cannot be handed on. Add the new coach and adjust the times instead.' },
  shift_started: { status: 409, error: 'This shift has already started, so it cannot be handed on. Add the new coach and adjust the times instead.' },
  not_at_studio: { status: 400, error: 'This coach is not on the staff of this studio.' },
  already_on_shift: { status: 409, error: 'That coach is already on this shift.' },
  changed: { status: 409, error: 'This shift has just changed. Refresh and try again.' },
})

const refusal = (code) => ({ code, ...REFUSALS[code] })

/** A refusal code (from replaceRefusal or the write) -> the route's answer. */
export function replaceRefusalResponse(code) {
  const r = REFUSALS[code] || { status: 400, error: 'Could not replace the coach.' }
  return { status: r.status, body: { success: false, code, error: r.error } }
}

/**
 * Has the shift started, for a replace (D3)? The incoming coach works the
 * BLOCK's window (nothing carries, D2), and the outgoing coach may have begun
 * earlier on an override: either start having passed refuses. The ONE
 * predicate (swapShiftHasStarted: studio wall clock, DST-exact, an unreadable
 * date or time is NOT started).
 */
export function replaceShiftStarted({ block, assignment }, nowMs, tz) {
  if (!block?.block_date) return false
  const atBlock = { block_date: block.block_date, start_time: block.start_time }
  const atOwn = { ...atBlock, start_time_override: assignment?.start_time_override ?? null }
  return swapShiftHasStarted(atBlock, nowMs, tz) || swapShiftHasStarted(atOwn, nowMs, tz)
}

/**
 * May `assignment` go to `toProfileId` right now? Pure. The order is the
 * order a manager can act on, and a non-member is refused BEFORE their profile
 * is judged, so nothing about a foreign profile is described.
 *
 * @param {object} a
 * @param {object|null} a.assignment    shift_assignments row (id, profile_id, status, arrived_at)
 * @param {string} a.toProfileId
 * @param {boolean} a.started           replaceShiftStarted(...)
 * @param {boolean} a.toIsMember        B has a profile_locations row at the block's studio
 * @param {object|null} a.toProfile     B's profiles row (read only when a member)
 * @param {string[]} a.liveOnBlockIds   profile ids live on the block now
 * @returns {null | { code: string, status: number, error: string }}
 */
export function replaceRefusal({ assignment, toProfileId, started, toIsMember, toProfile, liveOnBlockIds = [] }) {
  if (!assignment || !isLiveAssignment(assignment)) return refusal('not_live')
  if (toProfileId === assignment.profile_id) return refusal('same_coach')
  if (assignment.arrived_at) return refusal('already_arrived')
  if (started) return refusal('shift_started')
  if (!toIsMember) return refusal('not_at_studio')
  if (!isRosterableProfile(toProfile)) {
    const e = notRosterableError(toProfile)
    return { code: e.code, status: 400, error: e.message }
  }
  if (liveOnBlockIds.includes(toProfileId)) return refusal('already_on_shift')
  return null
}

/** The two changes (logRosterChange + notifyRosterChanges shapes), A off then B on. */
export function replaceChanges({ block, fromProfileId, toProfileId }) {
  const base = { blockId: block.id, blockDate: block.block_date, startTime: block.start_time ?? null }
  return [
    { ...base, coachId: fromProfileId, action: 'unassigned' },
    { ...base, coachId: toProfileId, action: 'assigned' },
  ]
}

/** 'none' (draft: the first publish tells them) | 'now' | 'morning' (quiet hours: the arm sends from 07:00). */
export function replaceNoticeWhen({ published, inBand }) {
  if (!published) return 'none'
  return inBand ? 'now' : 'morning'
}

function conflictMessage(body) {
  const lines = (Array.isArray(body?.conflicts) ? body.conflicts : []).map((c) => c?.message).filter(Boolean)
  return [...new Set(lines)].join(' ') || body?.error || 'This coach has a clash that day.'
}

/**
 * The web toast after POST /replace. { kind: 'confirm' } asks "Replace
 * anyway?" (resend with confirm_conflicts); { kind: 'error' } keeps the dialog
 * open; { kind: 'done', tone } closes it.
 */
export function replaceResponseOutcome(status, body, { fromName, toName } = {}) {
  const from = fromName || 'The coach'
  const to = toName || 'The new coach'
  if (status === 409 && body?.code === SWAP_CONFLICTS_CODE) return { kind: 'confirm', message: conflictMessage(body) }
  if (!(status >= 200 && status < 300) || body?.success !== true) {
    return { kind: 'error', message: body?.error || 'Could not replace the coach.' }
  }
  const notice = body?.data?.notice
  if (notice === 'morning') {
    return { kind: 'done', tone: 'warning', message: `${to} is on the shift. ${from} and ${to} are told after 7am; if the shift is before then, ring them.` }
  }
  if (notice === 'none') {
    return { kind: 'done', tone: 'success', message: `${to} is on the shift. The roster is a draft, so nobody is told until it is published.` }
  }
  return { kind: 'done', tone: 'success', message: `${to} is on the shift. ${from} and ${to} have been told.` }
}

/** The picker's words in replace mode (web AssignCoachModal). */
export function replacePickerCopy({ fromName, pickedName = null, saving = false } = {}) {
  return {
    title: fromName ? `Replace ${fromName}` : 'Replace coach',
    label: 'Pick the coach who takes this shift',
    submit: saving ? 'Replacing…' : pickedName ? `Replace with ${pickedName}` : 'Pick a coach',
  }
}

const byTime = (x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id))

/**
 * The held-notice arm's plan (D7). Rows are unstamped roster_change_log rows
 * with details.via = 'replace'. Per (coach, shift): if the assigned and
 * unassigned rows balance, the net change is nothing and every row is stamped
 * silently; otherwise the LAST row's action is the net change, told once, on
 * behalf of that row's actor.
 *
 * @returns {{ send: Array<{locationId, actorId, coachId, blockId, blockDate, startTime, action, rowIds}>,
 *             silent: Array<{ locationId, coachId, rowIds }> }}
 */
export function netReplaceChanges(rows) {
  const groups = new Map()
  for (const r of rows || []) {
    if (!r?.coach_id || !r.block_id || !r.block_date || !r.location_id) continue
    if (r.action !== 'assigned' && r.action !== 'unassigned') continue
    const key = `${r.location_id}|${r.coach_id}|${r.block_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const send = []
  const silent = []
  for (const list of groups.values()) {
    list.sort(byTime)
    const last = list[list.length - 1]
    const rowIds = list.map((r) => r.id)
    const on = list.filter((r) => r.action === 'assigned').length
    if (on * 2 === list.length) {
      silent.push({ locationId: last.location_id, coachId: last.coach_id, rowIds })
      continue
    }
    send.push({
      locationId: last.location_id,
      actorId: last.actor_id ?? null,
      coachId: last.coach_id,
      blockId: last.block_id,
      blockDate: last.block_date,
      startTime: last.shift_blocks?.start_time ?? null,
      action: last.action,
      rowIds,
    })
  }
  return { send, silent }
}
```

- [ ] **Step 4: Run, expect pass**, in both zones (the started rule is timezone code):

```bash
npx vitest run src/lib/shift-replace.test.js
TZ=America/Los_Angeles npx vitest run src/lib/shift-replace.test.js
```
Expected: `0 failed` twice.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/shift-replace.js src/lib/shift-replace.test.js
git commit -m "REPLACE.1a — shift-replace.js: when a coach may be replaced, the change pair, the notice timing, the held-notice planner

Pure. The started rule is swapShiftHasStarted (the one predicate), asked at the
block start and at the outgoing coach's own start. Refusal order and words
follow the assign route.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-3: The scripted db fake and `src/lib/shift-replace-server.js`

**Files:** Create `src/lib/scripted-db.test-helpers.js`, `src/lib/shift-replace-server.js`, `src/lib/shift-replace-server.test.js`.

- [ ] **Step 1: The test helper** (test-only; the `.test-helpers.js` suffix keeps vitest from collecting it, as `src/lib/like-escape.test-helpers.js` does):

```js
// src/lib/scripted-db.test-helpers.js
//
// REPLACE.1 — a scripted supabase fake for the DB halves of the replace and
// offer modules. Each db.from(table) takes the NEXT scripted answer for that
// table, in call order, and records the chain it was asked for, so a test
// asserts both the write and the guards that were on it. Not a query engine:
// filters are recorded, never applied. An answer may be a function of the
// recorded chain. A table with no answer left THROWS, so an unexpected query
// is a red test, not a silent null.
import { vi } from 'vitest'

const CHAIN = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'is', 'in', 'or', 'not',
  'gte', 'gt', 'lte', 'lt', 'like', 'order', 'limit', 'range']

export function scriptedDb(script = {}) {
  const queues = Object.fromEntries(Object.entries(script).map(([t, answers]) => [t, [...answers]]))
  const calls = []
  return {
    calls,
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from(table) {
      const queue = queues[table]
      if (!queue || queue.length === 0) throw new Error(`scriptedDb: no answer left for ${table}`)
      const answer = queue.shift()
      const chain = []
      calls.push({ table, chain })
      const settle = () => Promise.resolve(typeof answer === 'function' ? answer(chain) : answer)
      const b = {}
      for (const m of CHAIN) b[m] = (...args) => { chain.push([m, ...args]); return b }
      b.single = () => { chain.push(['single']); return settle() }
      b.maybeSingle = () => { chain.push(['maybeSingle']); return settle() }
      b.then = (resolve, reject) => settle().then(resolve, reject)
      return b
    },
  }
}

/** Recorded chains for one table, in call order. */
export const chainsFor = (db, table) => db.calls.filter((c) => c.table === table).map((c) => c.chain)

/** The arguments of the first `method` call in a chain (undefined when absent). */
export const argsOf = (chain, method) => chain.find(([m]) => m === method)?.slice(1)

/** Every argument list of `method` in a chain. */
export const allArgsOf = (chain, method) => chain.filter(([m]) => m === method).map((c) => c.slice(1))
```

- [ ] **Step 2: Write the failing test.**

```js
// src/lib/shift-replace-server.test.js
// REPLACE.1a — the reads and the one guarded move behind POST /replace.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { logError } = await import('./log')
const { readReplaceContext, replaceShiftAssignment } = await import('./shift-replace-server')

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  rosters: { status: 'published' }, shift_templates: { name: 'Morning' }, locations: { name: 'Studio North', timezone: 'Europe/Dublin' },
}
const A_ROW = { id: 'as-1', profile_id: 'coach-a', block_id: 'b1', status: 'scheduled', arrived_at: null, start_time_override: null, profiles: { full_name: 'Coach A' }, shift_blocks: BLOCK }

beforeEach(() => vi.clearAllMocks())

describe('readReplaceContext', () => {
  it('reads the assignment, then B only as a MEMBER, then who is live on the block', async () => {
    const db = scriptedDb({
      shift_assignments: [
        { data: A_ROW, error: null },
        { data: [{ id: 'as-1', profile_id: 'coach-a', status: 'scheduled' }, { id: 'as-0', profile_id: 'coach-c', status: 'cancelled' }], error: null },
      ],
      profile_locations: [{ data: [{ profile_id: 'coach-b' }], error: null }],
      profiles: [{ data: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null }, error: null }],
    })
    const ctx = await readReplaceContext(db, { assignmentId: 'as-1', toProfileId: 'coach-b' })
    expect(ctx).toEqual({
      error: null,
      assignment: A_ROW,
      block: BLOCK,
      toIsMember: true,
      toProfile: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null },
      liveOnBlockIds: ['coach-a'],
    })
    const [pl] = chainsFor(db, 'profile_locations')
    expect(allArgsOf(pl, 'eq')).toEqual([['location_id', 'loc-1'], ['profile_id', 'coach-b']])
  })

  it('a non-member\'s profile is never read', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: A_ROW, error: null }, { data: [], error: null }],
      profile_locations: [{ data: [], error: null }],
    })
    const ctx = await readReplaceContext(db, { assignmentId: 'as-1', toProfileId: 'coach-z' })
    expect(ctx.toIsMember).toBe(false)
    expect(ctx.toProfile).toBeNull()
    expect(chainsFor(db, 'profiles')).toEqual([])
  })

  it('no such assignment: nothing else is read', async () => {
    const db = scriptedDb({ shift_assignments: [{ data: null, error: null }] })
    expect(await readReplaceContext(db, { assignmentId: 'x', toProfileId: 'coach-b' }))
      .toEqual({ error: null, assignment: null, block: null, toIsMember: false, toProfile: null, liveOnBlockIds: [] })
  })

  it('any read error is returned, never read as "empty"', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: A_ROW, error: null }, { data: null, error: { message: 'boom' } }],
      profile_locations: [{ data: [{ profile_id: 'coach-b' }], error: null }],
      profiles: [{ data: { id: 'coach-b', active: true }, error: null }],
    })
    expect((await readReplaceContext(db, { assignmentId: 'as-1', toProfileId: 'coach-b' })).error).toEqual({ message: 'boom' })
  })
})

describe('replaceShiftAssignment', () => {
  const NOW = '2026-09-28T20:00:00.000Z'
  const run = (db) => replaceShiftAssignment(db, { assignment: A_ROW, toProfileId: 'coach-b', actorId: 'mgr-1', nowIso: NOW })

  it('clears B\'s tombstone, moves the row under all four guards, clears what described A, closes open swaps', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: null, error: null }, { data: [{ id: 'as-1' }], error: null }],
      shift_swap_requests: [{ data: [{ id: 'sw-1' }], error: null }],
    })
    expect(await run(db)).toEqual({ ok: true, closedSwapIds: ['sw-1'] })

    const [tomb, move] = chainsFor(db, 'shift_assignments')
    expect(argsOf(tomb, 'delete')).toEqual([])
    expect(allArgsOf(tomb, 'eq')).toEqual([['block_id', 'b1'], ['profile_id', 'coach-b'], ['status', 'cancelled']])

    expect(argsOf(move, 'update')[0]).toEqual({
      profile_id: 'coach-b', status: 'scheduled',
      start_time_override: null, end_time_override: null, partial_reason: null, arrived_at: null, arrival_source: null,
      notes: null, assigned_by: 'mgr-1', assigned_at: NOW,
    })
    expect(allArgsOf(move, 'eq')).toEqual([['id', 'as-1'], ['profile_id', 'coach-a']])
    expect(argsOf(move, 'neq')).toEqual(['status', 'cancelled'])
    expect(argsOf(move, 'is')).toEqual(['arrived_at', null])
    expect(argsOf(move, 'select')).toEqual(['id'])

    const [swaps] = chainsFor(db, 'shift_swap_requests')
    expect(argsOf(swaps, 'update')[0]).toEqual({ status: 'cancelled', reviewed_by: 'mgr-1', reviewed_at: NOW, review_note: 'Closed: a manager gave this shift to another coach.' })
    expect(argsOf(swaps, 'or')).toEqual(['requester_shift_id.eq.as-1,target_shift_id.eq.as-1'])
    expect(argsOf(swaps, 'in')).toEqual(['status', ['pending', 'awaiting_approval']])
  })

  it('zero rows moved = the shift changed underneath: no swap is touched', async () => {
    const db = scriptedDb({ shift_assignments: [{ data: null, error: null }, { data: [], error: null }] })
    expect(await run(db)).toEqual({ code: 'changed' })
    expect(chainsFor(db, 'shift_swap_requests')).toEqual([])
  })

  it('23505 = B is already on the block (the unique key is the race-proof half)', async () => {
    const db = scriptedDb({ shift_assignments: [{ data: null, error: null }, { data: null, error: { code: '23505', message: 'dup' } }] })
    expect(await run(db)).toEqual({ code: 'already_on_shift' })
  })

  it('a failed tombstone clear or move is an error; nothing after it runs', async () => {
    const db1 = scriptedDb({ shift_assignments: [{ data: null, error: { message: 'no' } }] })
    expect(await run(db1)).toEqual({ error: { message: 'no' } })
    const db2 = scriptedDb({ shift_assignments: [{ data: null, error: null }, { data: null, error: { message: 'down' } }] })
    expect(await run(db2)).toEqual({ error: { message: 'down' } })
    expect(chainsFor(db2, 'shift_swap_requests')).toEqual([])
  })

  it('a failed swap close is LOGGED and the replace stands (the approval RPC refuses a stale swap anyway)', async () => {
    const db = scriptedDb({
      shift_assignments: [{ data: null, error: null }, { data: [{ id: 'as-1' }], error: null }],
      shift_swap_requests: [{ data: null, error: { message: 'swap table down' } }],
    })
    expect(await run(db)).toEqual({ ok: true, closedSwapIds: [] })
    expect(logError).toHaveBeenCalledWith('shift-replace', expect.stringMatching(/open swaps/), expect.objectContaining({ assignmentId: 'as-1' }))
  })
})
```

- [ ] **Step 3: Run, expect failure** (module missing): `npx vitest run src/lib/shift-replace-server.test.js`.

- [ ] **Step 4: Implement.**

```js
// src/lib/shift-replace-server.js
//
// REPLACE.1a — the DB half of "replace coach". Decisions are in
// ./shift-replace.js (pure); this file reads the context and does the ONE
// guarded move. Service-role client: the CALLER has already authorised the
// block's studio (assertLocationAccessOr404 + a manager role there).

import { SWAP_MOVE_CLEARS } from './swap-lifecycle'
import { OPEN_SWAP_STATUSES } from './swap-cover'
import { isLiveAssignment } from './roster'
import { REPLACE_SWAP_CLOSE_NOTE } from './shift-replace'
import { logError } from './log'

// shift_assignments has two FKs to profiles (profile_id, assigned_by), so the
// name embed names its column. The block carries what the rules, the log, the
// notice and the started check need: date, times, roster status, studio clock.
const REPLACE_ASSIGNMENT_SELECT = `
  id, profile_id, block_id, status, arrived_at, start_time_override,
  profiles!profile_id(full_name),
  shift_blocks!block_id(id, location_id, block_date, start_time, end_time, rosters:roster_id(status), shift_templates(name), locations(name, timezone))
`

const EMPTY = Object.freeze({ error: null, assignment: null, block: null, toIsMember: false, toProfile: null, liveOnBlockIds: [] })

/**
 * Everything POST /replace decides on. Any read error comes back as `error`
 * (the route answers 500): an unreadable membership or block must never read
 * as "not a member" or "nobody on it". B's profile is read only once B is a
 * proven member of the block's studio (the assign route's rule), so a foreign
 * id never produces a name.
 */
export async function readReplaceContext(db, { assignmentId, toProfileId }) {
  const { data: assignment, error: aErr } = await db.from('shift_assignments')
    .select(REPLACE_ASSIGNMENT_SELECT)
    .eq('id', assignmentId)
    .maybeSingle()
  if (aErr) return { ...EMPTY, error: aErr }
  if (!assignment) return { ...EMPTY }
  const block = assignment.shift_blocks || null
  if (!block?.location_id) return { ...EMPTY, assignment, block }

  const { data: links, error: mErr } = await db.from('profile_locations')
    .select('profile_id')
    .eq('location_id', block.location_id)
    .eq('profile_id', toProfileId)
    .limit(1)
  if (mErr) return { ...EMPTY, assignment, block, error: mErr }
  const toIsMember = (links || []).length > 0

  let toProfile = null
  if (toIsMember) {
    const { data: p, error: pErr } = await db.from('profiles')
      .select('id, full_name, active, deleted_at')
      .eq('id', toProfileId)
      .maybeSingle()
    if (pErr) return { ...EMPTY, assignment, block, error: pErr }
    toProfile = p || null
  }

  const { data: onBlock, error: bErr } = await db.from('shift_assignments')
    .select('id, profile_id, status')
    .eq('block_id', block.id)
  if (bErr) return { ...EMPTY, assignment, block, error: bErr }
  const liveOnBlockIds = (onBlock || []).filter(isLiveAssignment).map((r) => r.profile_id)

  return { error: null, assignment, block, toIsMember, toProfile, liveOnBlockIds }
}

/**
 * The move (D1, D2, D5). Returns { ok: true, closedSwapIds } | { code } (a
 * refusal code for replaceRefusalResponse) | { error } (500).
 *
 *   1. B's cancelled tombstone on the block is deleted: the (block_id,
 *      profile_id) key (mig 067) does not care that it is cancelled.
 *   2. ONE UPDATE moves A's row to B under four guards: the id, A still owns
 *      it, it is live, A has not arrived. Zero rows = it changed since the read.
 *      23505 = B is on the block (the key is the race-proof half of the check).
 *      Everything that described A's shift is cleared (SWAP_MOVE_CLEARS +
 *      notes); B starts clean on the block's window.
 *   3. Open swaps about that row are closed as the manager's decision. A
 *      failure here is logged and the replace stands: the approval RPCs
 *      (mig 615) refuse such a swap as swap_stale.
 */
export async function replaceShiftAssignment(db, { assignment, toProfileId, actorId, nowIso }) {
  const { error: tombErr } = await db.from('shift_assignments')
    .delete()
    .eq('block_id', assignment.block_id)
    .eq('profile_id', toProfileId)
    .eq('status', 'cancelled')
  if (tombErr) return { error: tombErr }

  const { data: moved, error: moveErr } = await db.from('shift_assignments')
    .update({
      profile_id: toProfileId,
      status: 'scheduled',
      ...SWAP_MOVE_CLEARS,
      notes: null,
      assigned_by: actorId,
      assigned_at: nowIso,
    })
    .eq('id', assignment.id)
    .eq('profile_id', assignment.profile_id)
    .neq('status', 'cancelled')
    .is('arrived_at', null)
    .select('id')
  if (moveErr?.code === '23505') return { code: 'already_on_shift' }
  if (moveErr) return { error: moveErr }
  if (!moved || moved.length === 0) return { code: 'changed' }

  const { data: closed, error: swapErr } = await db.from('shift_swap_requests')
    .update({ status: 'cancelled', reviewed_by: actorId, reviewed_at: nowIso, review_note: REPLACE_SWAP_CLOSE_NOTE })
    .or(`requester_shift_id.eq.${assignment.id},target_shift_id.eq.${assignment.id}`)
    .in('status', [...OPEN_SWAP_STATUSES])
    .select('id')
  if (swapErr) {
    logError('shift-replace', 'replace: could not close the open swaps on the replaced shift; the swap approval refuses them as stale', {
      assignmentId: assignment.id, err: swapErr.message,
    })
    return { ok: true, closedSwapIds: [] }
  }
  return { ok: true, closedSwapIds: (closed || []).map((r) => r.id) }
}
```

- [ ] **Step 5: Run, expect pass.** `npx vitest run src/lib/shift-replace-server.test.js` → `0 failed`.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/scripted-db.test-helpers.js src/lib/shift-replace-server.js src/lib/shift-replace-server.test.js
git commit -m "REPLACE.1a — shift-replace-server.js: the context read and the one guarded move

One UPDATE moves A's row to B (id + A still owns it + live + not arrived);
zero rows = changed, 23505 = B already on it. SWAP_MOVE_CLEARS + notes cleared.
Open swaps on that row closed as the manager's decision (reviewed_by set, so the
cover sweep never owes a notice for them). Adds a scripted supabase fake for
the DB-half tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-4: `POST /api/schedule/assignments/[id]/replace`

**Files:** Create `src/app/api/schedule/assignments/[id]/replace/route.js`, `…/replace/route.test.js`. Modify `src/lib/openapi.js`, `src/lib/openapi.test.js`.

- [ ] **Step 1: Write the failing route test.**

```js
// src/app/api/schedule/assignments/[id]/replace/route.test.js
// REPLACE.1a — the route's contract: the manager-at-the-studio gate, the
// refusals, the conflicts confirm step, the log pair on a published roster,
// and ONE notice each, now in band or from 07:00 out of it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, after: vi.fn((fn) => fn()) } // SWAPNOTIFY.1 pattern
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal()
  return {
    getCurrentUser: vi.fn(),
    assertLocationAccessOr404: real.assertLocationAccessOr404,
    hasRoleAtLocation: real.hasRoleAtLocation,
    hasRoleAtAnyLocation: real.hasRoleAtAnyLocation,
  }
})
vi.mock('@/lib/shift-replace-server', () => ({ readReplaceContext: vi.fn(), replaceShiftAssignment: vi.fn() }))
vi.mock('@/lib/swap-conflicts', () => ({ findSwapConflicts: vi.fn(async () => []) }))
vi.mock('@/lib/roster-change-log', () => ({ logRosterChange: vi.fn(async () => ({ logged: true, id: 'log-1' })) }))
vi.mock('@/lib/roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 2 })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { after } = await import('next/server')
const { getCurrentUser } = await import('@/lib/auth')
const { readReplaceContext, replaceShiftAssignment } = await import('@/lib/shift-replace-server')
const { findSwapConflicts } = await import('@/lib/swap-conflicts')
const { logRosterChange } = await import('@/lib/roster-change-log')
const { notifyRosterChanges } = await import('@/lib/roster-change-notify')
const { POST } = await import('./route.js')

const MANAGER = { id: 'mgr-1', profileRole: 'manager', role: 'manager', rolesByLocation: { 'loc-1': 'manager' }, locations: [{ id: 'loc-1' }] }
const COACH = { id: 'coach-x', profileRole: 'staff', role: 'staff', rolesByLocation: { 'loc-1': 'staff' }, locations: [{ id: 'loc-1' }] }
const MIXED = { id: 'mix-1', profileRole: 'staff', role: 'manager', rolesByLocation: { 'loc-1': 'staff', 'loc-2': 'manager' }, locations: [{ id: 'loc-1' }, { id: 'loc-2' }] }
const OUTSIDER = { id: 'out-1', profileRole: 'manager', role: 'manager', rolesByLocation: { 'loc-9': 'manager' }, locations: [{ id: 'loc-9' }] }

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  rosters: { status: 'published' }, shift_templates: { name: 'Morning' }, locations: { name: 'Studio North', timezone: 'Europe/Dublin' },
}
const ctx = (over = {}) => ({
  error: null,
  assignment: { id: 'as-1', profile_id: 'coach-a', block_id: 'b1', status: 'scheduled', arrived_at: null, start_time_override: null, profiles: { full_name: 'Coach A' } },
  block: BLOCK,
  toIsMember: true,
  toProfile: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null },
  liveOnBlockIds: ['coach-a'],
  ...over,
})
const req = (body) => ({ json: () => Promise.resolve(body), headers: { get: () => '' } })
const PROPS = { params: Promise.resolve({ id: 'as-1' }) }
const B_ID = '10000000-0000-4000-8000-00000000000b'
const call = (body = { profile_id: B_ID }) => POST(req(body), PROPS)

// In band: 2026-09-28 10:00Z = 11:00 Dublin. Quiet: 22:30Z = 23:30 Dublin.
const IN_BAND = Date.parse('2026-09-28T10:00:00Z')
const QUIET = Date.parse('2026-09-28T22:30:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: IN_BAND, toFake: ['Date'] })
  getCurrentUser.mockResolvedValue(MANAGER)
  readReplaceContext.mockResolvedValue(ctx({ toProfile: { id: B_ID, full_name: 'Coach B', active: true } }))
  replaceShiftAssignment.mockResolvedValue({ ok: true, closedSwapIds: [] })
  findSwapConflicts.mockResolvedValue([])
})

describe('POST /replace — who may', () => {
  it('401 signed out, 403 for someone who manages nowhere, with nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
    getCurrentUser.mockResolvedValue({ ...COACH, rolesByLocation: { 'loc-1': 'staff' } })
    expect((await call()).status).toBe(403)
    expect(readReplaceContext).not.toHaveBeenCalled()
  })
  it('404 for a manager of another studio (the id is not confirmed)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await call()).status).toBe(404)
    expect(replaceShiftAssignment).not.toHaveBeenCalled()
  })
  it('403 for a member who manages a DIFFERENT studio (role at the block\'s studio decides)', async () => {
    getCurrentUser.mockResolvedValue(MIXED)
    expect((await call()).status).toBe(403)
  })
  it('404 when the assignment does not exist; 500 when the read failed', async () => {
    readReplaceContext.mockResolvedValue({ ...ctx(), assignment: null, block: null })
    expect((await call()).status).toBe(404)
    readReplaceContext.mockResolvedValue({ ...ctx(), error: { message: 'down' } })
    expect((await call()).status).toBe(500)
  })
  it('400 on a body without a profile id', async () => {
    expect((await call({})).status).toBe(400)
  })
})

describe('POST /replace — refusals come from the pure rule', () => {
  it('a started shift is 409 shift_started, nothing written', async () => {
    vi.setSystemTime(Date.parse('2026-09-29T05:01:00Z')) // 06:01 Dublin
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('shift_started')
    expect(replaceShiftAssignment).not.toHaveBeenCalled()
  })
  it('a coach from another studio is 400 not_at_studio', async () => {
    readReplaceContext.mockResolvedValue(ctx({ toIsMember: false, toProfile: null }))
    expect((await (await call()).json()).code).toBe('not_at_studio')
  })
  it('the write\'s own refusals map to 409', async () => {
    replaceShiftAssignment.mockResolvedValue({ code: 'changed' })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, code: 'changed', error: 'This shift has just changed. Refresh and try again.' })
  })
})

describe('POST /replace — leave and clashes are a confirm step', () => {
  it('a conflict answers 409 swap_conflicts with the sentences, and nothing is written', async () => {
    findSwapConflicts.mockResolvedValue([{ kind: 'leave', coachId: B_ID, message: 'Coach B has approved holiday on 2026-09-29, which covers the shift on 2026-09-29.' }])
    const res = await call()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, code: 'swap_conflicts', conflicts: [expect.objectContaining({ kind: 'leave' })] })
    expect(findSwapConflicts).toHaveBeenCalledWith(expect.anything(),
      [{ role: 'taker', coachId: B_ID, block: BLOCK, leavingAssignmentId: null }], { viewerId: 'mgr-1' })
    expect(replaceShiftAssignment).not.toHaveBeenCalled()
  })
  it('confirm_conflicts skips the check', async () => {
    const res = await call({ profile_id: B_ID, confirm_conflicts: true })
    expect(res.status).toBe(200)
    expect(findSwapConflicts).not.toHaveBeenCalled()
  })
})

describe('POST /replace — the log pair and ONE notice each', () => {
  it('published, in band: two log rows via replace, then notifyRosterChanges once with both changes and the start time', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ assignment_id: 'as-1', from_profile_id: 'coach-a', profile_id: B_ID, notice: 'now', closed_swaps: 0 })
    expect(logRosterChange.mock.calls.map((c) => [c[1].coachId, c[1].action, c[1].details])).toEqual([
      ['coach-a', 'unassigned', { via: 'replace' }],
      [B_ID, 'assigned', { via: 'replace' }],
    ])
    expect(after).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledWith(expect.anything(), {
      locationId: 'loc-1', actorId: 'mgr-1',
      changes: [
        { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: 'coach-a', action: 'unassigned' },
        { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: B_ID, action: 'assigned' },
      ],
    })
  })
  it('published, quiet hours: logged, NOT sent (the */5 arm sends from 07:00), notice morning', async () => {
    vi.setSystemTime(QUIET)
    const body = await (await call()).json()
    expect(body.data.notice).toBe('morning')
    expect(logRosterChange).toHaveBeenCalledTimes(2)
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
  it('a draft: nothing logged, nothing sent, notice none', async () => {
    readReplaceContext.mockResolvedValue(ctx({ block: { ...BLOCK, rosters: { status: 'draft' } }, toProfile: { id: B_ID, active: true } }))
    const body = await (await call()).json()
    expect(body.data.notice).toBe('none')
    expect(logRosterChange).not.toHaveBeenCalled()
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })
})
```

Note `vi.useFakeTimers({ toFake: ['Date'] })` fakes only `Date` (no React here, so the fake-timer-act rule does not apply); add `afterEach(() => vi.useRealTimers())` at the top of the file.

- [ ] **Step 2: Run, expect failure** (route missing): `npx vitest run 'src/app/api/schedule/assignments/[id]/replace/route.test.js'`.

- [ ] **Step 3: Implement the route.**

```js
// src/app/api/schedule/assignments/[id]/replace/route.js
//
// REPLACE.1a — POST: hand this assignment from its coach (A) to another coach
// (B) in ONE action. Body: { profile_id: B, confirm_conflicts?: true }.
//
// Mutation skeleton (CLAUDE.md): user -> coarse role check -> body -> the row
// -> the row's studio (404 outsider, 403 non-manager there) -> rules -> write
// -> log -> notice. Decisions D1-D9: docs/superpowers/plans/
// 2026-09-25-scheduler-wave2-3/20-REPLACE.1.md.
//
//   - Refusals are replaceRefusal (src/lib/shift-replace.js): started (the
//     one predicate), arrived, not a member, not rosterable, already on it.
//   - Leave / another shift that day for B: 409 swap_conflicts with the
//     sentences unless confirm_conflicts (the swap approval's step, SWAPS.2).
//   - The move is ONE guarded UPDATE (src/lib/shift-replace-server.js).
//   - Published roster: two change-log rows (via 'replace') and ONE notice
//     each through notifyRosterChanges, from after() inside 07:00-22:00
//     studio time; outside it the rows stay unstamped and the */5 arm
//     (src/lib/shift-replace-notify.js) sends them from 07:00. Draft: nothing.

import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { findSwapConflicts } from '@/lib/swap-conflicts'
import { SWAP_CONFLICTS_CODE } from '@/lib/swap-lifecycle'
import { logRosterChange } from '@/lib/roster-change-log'
import { notifyRosterChanges } from '@/lib/roster-change-notify'
import { inStaffPushHours } from '@/lib/staff-push-hours'
import { readReplaceContext, replaceShiftAssignment } from '@/lib/shift-replace-server'
import {
  replaceRefusal, replaceRefusalResponse, replaceShiftStarted, replaceChanges, replaceNoticeWhen, REPLACE_VIA,
} from '@/lib/shift-replace'
import { logError } from '@/lib/log'

const ReplaceSchema = z.object({
  profile_id: uuidLike,
  confirm_conflicts: z.boolean().optional(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // Coarse only (SCHEDROLES.1): the real decision is at the block's studio.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager can replace a coach' }, { status: 403 })
  }

  const validation = await validateBody(request, ReplaceSchema)
  if (!validation.ok) return validation.response
  const toProfileId = validation.data.profile_id
  const confirmConflicts = validation.data.confirm_conflicts === true

  const db = createServerClient()
  const ctx = await readReplaceContext(db, { assignmentId: params.id, toProfileId })
  if (ctx.error) return NextResponse.json({ success: false, error: 'Could not read the shift' }, { status: 500 })
  if (!ctx.assignment || !ctx.block?.location_id) {
    return NextResponse.json({ success: false, error: 'Assignment not found' }, { status: 404 })
  }
  const notHere = assertLocationAccessOr404(user, ctx.block.location_id)
  if (notHere) return notHere
  if (!hasRoleAtLocation(user, ctx.block.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Only a manager at this studio can replace a coach' }, { status: 403 })
  }

  const nowMs = Date.now()
  const tz = ctx.block.locations?.timezone ?? null
  const refused = replaceRefusal({ ...ctx, toProfileId, started: replaceShiftStarted(ctx, nowMs, tz) })
  if (refused) {
    return NextResponse.json({ success: false, code: refused.code, error: refused.error }, { status: refused.status })
  }

  if (!confirmConflicts) {
    const conflicts = await findSwapConflicts(db,
      [{ role: 'taker', coachId: toProfileId, block: ctx.block, leavingAssignmentId: null }],
      { viewerId: user.id })
    if (conflicts.length > 0) {
      return NextResponse.json({
        success: false, code: SWAP_CONFLICTS_CODE, error: conflicts.map((c) => c.message).join(' '), conflicts,
      }, { status: 409 })
    }
  }

  const write = await replaceShiftAssignment(db, {
    assignment: ctx.assignment, toProfileId, actorId: user.id, nowIso: new Date(nowMs).toISOString(),
  })
  if (write.error) return NextResponse.json({ success: false, error: 'Could not replace the coach' }, { status: 500 })
  if (write.code) {
    const { status, body } = replaceRefusalResponse(write.code)
    return NextResponse.json(body, { status })
  }

  const published = ctx.block.rosters?.status === 'published'
  const changes = replaceChanges({ block: ctx.block, fromProfileId: ctx.assignment.profile_id, toProfileId })
  if (published) {
    // Best-effort (logRosterChange never throws). Written after the move
    // succeeded, so the log never claims a replace that did not happen.
    for (const c of changes) {
      await logRosterChange(db, {
        isPublished: true,
        locationId: ctx.block.location_id,
        blockId: c.blockId,
        blockDate: c.blockDate,
        actorId: user.id,
        coachId: c.coachId,
        action: c.action,
        details: { via: REPLACE_VIA },
      })
    }
  }

  const notice = replaceNoticeWhen({ published, inBand: inStaffPushHours(nowMs, tz) })
  if (notice === 'now') {
    after(() => notifyRosterChanges(db, { locationId: ctx.block.location_id, actorId: user.id, changes })
      .catch((err) => logError('shift-replace', 'replace notice failed; the */5 arm re-sends unstamped rows', {
        assignmentId: ctx.assignment.id, err: err?.message,
      })))
  }

  return NextResponse.json({
    success: true,
    data: {
      assignment_id: ctx.assignment.id,
      from_profile_id: ctx.assignment.profile_id,
      profile_id: toProfileId,
      notice,
      closed_swaps: write.closedSwapIds.length,
    },
  })
}
```

- [ ] **Step 4: Register in OpenAPI.** In `src/lib/openapi.js`, directly after the `delete` `/api/schedule/assignments/{id}` registration (the block ending `404: { description: 'Assignment not found, or at a location you do not own', … } },\n})` right before `// BUDGETAPPROVE.1`), add:

```js
// REPLACE.1a — hand one assignment to another coach in one action.
registry.registerPath({
  method: 'post',
  path: '/api/schedule/assignments/{id}/replace',
  tags: ['Schedule'],
  security: [{ CookieAuth: [] }],
  summary: 'Replace the coach on a shift (manager-only)',
  description: "Moves one shift_assignments row from its coach to `profile_id` in a single guarded update: overrides, partial reason, arrival stamp and notes are cleared, status becomes scheduled. Manager at the shift's studio only (404 outside it, 403 for a non-manager there). Refused once the shift has started (studio clock) or the coach has arrived, for a coach who is not a rosterable member of the studio, or who is already on it. Approved leave or another shift that day answers 409 `swap_conflicts` with the sentences unless `confirm_conflicts: true`. Open swaps on the shift are closed. On a published roster: two change-log rows (via replace) and one notice to each coach, sent now inside 07:00-22:00 studio time and from 07:00 otherwise; `data.notice` is now, morning or none (draft).",
  request: {
    params: z.object({ id: uuidLike }),
    body: { content: { 'application/json': { schema: z.object({ profile_id: uuidLike, confirm_conflicts: z.boolean().optional() }) } } },
  },
  responses: {
    200: { description: 'Replaced; `data.notice` says when the coaches are told' },
    400: { description: 'Not a member of this studio, not rosterable, or the same coach', content: { 'application/json': { schema: ErrorResponse } } },
    403: { description: 'Forbidden — a manager at this studio only', content: { 'application/json': { schema: ErrorResponse } } },
    404: { description: 'Assignment not found, or at a location you do not own', content: { 'application/json': { schema: ErrorResponse } } },
    409: { description: 'Started, arrived, already on the shift, changed meanwhile, or `swap_conflicts` (confirm to proceed)', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

In `src/lib/openapi.test.js`, add inside the top-level `describe` (next to the `/api/schedule/assignments/{id}` case at line ~305):

```js
  it('REPLACE.1a — documents POST /api/schedule/assignments/{id}/replace', () => {
    const path = spec.paths['/api/schedule/assignments/{id}/replace']
    expect(path?.post?.responses).toHaveProperty('409')
    expect(path.post.description).toMatch(/swap_conflicts/)
  })
```
(Use the same `spec` variable the neighbouring tests use.)

- [ ] **Step 5: Run, expect pass.**

```bash
npx vitest run 'src/app/api/schedule/assignments/[id]/replace/route.test.js' src/lib/openapi.test.js
TZ=America/Los_Angeles npx vitest run 'src/app/api/schedule/assignments/[id]/replace/route.test.js'
npm run check:route-guards && npm run check:location-scoping
```
Expected: `0 failed` twice; both checks exit 0 (the route calls `getCurrentUser`; it queries no table itself).

- [ ] **Step 6: Commit.**

```bash
git add 'src/app/api/schedule/assignments/[id]/replace' src/lib/openapi.js src/lib/openapi.test.js
git commit -m "REPLACE.1a — POST /api/schedule/assignments/[id]/replace: one action, one change-log pair, one notice each

Manager at the shift's studio only. Started / arrived / not a member / not
rosterable / already on it refused; leave or a clash is the swap approval's
confirm step (swap_conflicts). Published: two rows via replace and one
notifyRosterChanges call, now in band, from 07:00 out of it (the */5 arm).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-5: The held-notice arm, `runReplaceNotices`, on the `*/5` cron

**Files:** Create `src/lib/shift-replace-notify.js`, `src/lib/shift-replace-notify.test.js`. Modify `src/app/api/cron/send-push-reminders/route.js`, `src/app/api/cron/send-push-reminders/route.test.js`.

- [ ] **Step 1: Write the failing arm test.**

```js
// src/lib/shift-replace-notify.test.js
// REPLACE.1a — replace notices held by quiet hours (or lost with a dead
// after()) go out from the */5 cron, once, inside 07:00-22:00 studio time.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'

vi.mock('./roster-change-notify', () => ({ notifyRosterChanges: vi.fn(async () => ({ notified: 1 })) }))
vi.mock('./roster-change-log', () => ({ markChangesNotified: vi.fn(async () => {}) }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { notifyRosterChanges } = await import('./roster-change-notify')
const { markChangesNotified } = await import('./roster-change-log')
const { logError } = await import('./log')
const { runReplaceNotices } = await import('./shift-replace-notify')

const IN_BAND = Date.parse('2026-09-29T06:05:00Z')  // 07:05 Dublin
const QUIET = Date.parse('2026-09-29T04:00:00Z')    // 05:00 Dublin
const row = (id, coach, action, over = {}) => ({
  id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-29', actor_id: 'mgr-1', coach_id: coach, action,
  created_at: '2026-09-28T22:10:00Z', shift_blocks: { start_time: '09:00:00' }, ...over,
})
const LOC = { data: [{ id: 'loc-1', timezone: 'Europe/Dublin' }], error: null }

beforeEach(() => vi.clearAllMocks())

describe('runReplaceNotices', () => {
  it('reads only unstamped replace rows, 2 min to 48 h old, for today or later', async () => {
    const db = scriptedDb({ roster_change_log: [{ data: [], error: null }] })
    await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    const [c] = chainsFor(db, 'roster_change_log')
    expect(argsOf(c, 'is')).toEqual(['notified_at', null])
    expect(argsOf(c, 'eq')).toEqual(['details->>via', 'replace'])
    expect(allArgsOf(c, 'gte')).toEqual([['created_at', '2026-09-27T06:05:00.000Z'], ['block_date', '2026-09-29']])
    expect(argsOf(c, 'lte')).toEqual(['created_at', '2026-09-29T06:03:00.000Z'])
  })

  it('in band: ONE notifyRosterChanges per studio and actor, with the net change and the start time', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned')], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
    expect(notifyRosterChanges).toHaveBeenCalledWith(db, {
      locationId: 'loc-1', actorId: 'mgr-1', todayStr: '2026-09-29',
      changes: [
        { coachId: 'coach-a', blockId: 'b1', blockDate: '2026-09-29', startTime: '09:00:00', action: 'unassigned' },
        { coachId: 'coach-b', blockId: 'b1', blockDate: '2026-09-29', startTime: '09:00:00', action: 'assigned' },
      ],
    })
    expect(stats).toMatchObject({ rows: 2, groups: 1, quiet: 0, silent: 0, errors: 0 })
  })

  it('quiet hours: nothing sent, nothing stamped; the next in-band tick sends', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned')], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).not.toHaveBeenCalled()
    expect(markChangesNotified).not.toHaveBeenCalled()
    expect(stats.quiet).toBe(1)
  })

  it('net zero (replaced and put back) is stamped with no message, at any hour', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [
        row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-a', 'assigned', { created_at: '2026-09-28T22:40:00Z' }),
      ], error: null }],
      locations: [LOC],
    })
    await runReplaceNotices(db, { nowMs: QUIET, todayStr: '2026-09-29' })
    expect(markChangesNotified).toHaveBeenCalledWith(db, ['r1', 'r2'])
    expect(notifyRosterChanges).not.toHaveBeenCalled()
  })

  it('an unreadable log is an error in the stats, logged, and nothing else runs', async () => {
    const db = scriptedDb({ roster_change_log: [{ data: null, error: { message: 'down' } }] })
    expect((await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })).errors).toBe(1)
    expect(logError).toHaveBeenCalled()
  })

  it('an unreadable timezone is Europe/Dublin, never a skipped studio', async () => {
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned')], error: null }],
      locations: [{ data: null, error: { message: 'x' } }],
    })
    await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(1)
  })

  it('one group throwing costs neither the others nor the arm', async () => {
    notifyRosterChanges.mockRejectedValueOnce(new Error('boom'))
    const db = scriptedDb({
      roster_change_log: [{ data: [row('r1', 'coach-a', 'unassigned'), row('r2', 'coach-b', 'assigned', { actor_id: 'mgr-2' })], error: null }],
      locations: [LOC],
    })
    const stats = await runReplaceNotices(db, { nowMs: IN_BAND, todayStr: '2026-09-29' })
    expect(notifyRosterChanges).toHaveBeenCalledTimes(2)
    expect(stats).toMatchObject({ groups: 1, errors: 1 })
  })
})
```

- [ ] **Step 2: Run, expect failure** (module missing).

- [ ] **Step 3: Implement the arm.**

```js
// src/lib/shift-replace-notify.js
//
// REPLACE.1a — the */5 arm that sends replace notices the route could not:
// those made outside 07:00-22:00 studio time (quiet hours gate the NOTICE,
// never the replace), and any whose after() died. It rides
// /api/cron/send-push-reminders beside the shift-reminder arm.
//
// It reads roster_change_log rows with details.via = 'replace' that are still
// unstamped, older than REPLACE_NOTICE_ROUTE_OWNS_MS (the route's own window),
// younger than REPLACE_NOTICE_MAX_AGE_MS (older ones belong to the re-publish
// safety net), for a shift today or later. netReplaceChanges nets each coach's
// rows per shift: a replace undone overnight is stamped with no message.
// Everything else goes through notifyRosterChanges, NOTIFY.1's one path,
// which stamps only on delivery and leaves an opted-out coach for the safety
// net. A crash between its send and its stamp re-sends next tick: a
// duplicate, never a loss.
//
// Never throws. Returns counts for the cron's response.

import { notifyRosterChanges } from './roster-change-notify'
import { markChangesNotified } from './roster-change-log'
import { inStaffPushHours } from './staff-push-hours'
import { dublinTodayStr } from './dublin-time'
import { logError, logWarn } from './log'
import { netReplaceChanges, REPLACE_VIA, REPLACE_NOTICE_ROUTE_OWNS_MS, REPLACE_NOTICE_MAX_AGE_MS } from './shift-replace'

// Literal: check:select-columns resolves only literal selects.
const HELD_SELECT = 'id, location_id, block_id, block_date, actor_id, coach_id, action, created_at, shift_blocks!block_id(start_time)'
// Replaces are a handful a night. A guard, not a page size: past it the
// oldest are sent and the rest wait a tick.
const HELD_LIMIT = 500

const iso = (ms) => new Date(ms).toISOString()

export async function runReplaceNotices(db, { nowMs = Date.now(), todayStr = dublinTodayStr() } = {}) {
  const stats = { rows: 0, groups: 0, silent: 0, quiet: 0, errors: 0 }
  let rows
  try {
    const { data, error } = await db.from('roster_change_log')
      .select(HELD_SELECT)
      .is('notified_at', null)
      .eq('details->>via', REPLACE_VIA)
      .gte('created_at', iso(nowMs - REPLACE_NOTICE_MAX_AGE_MS))
      .lte('created_at', iso(nowMs - REPLACE_NOTICE_ROUTE_OWNS_MS))
      .gte('block_date', todayStr)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(HELD_LIMIT)
    if (error) throw new Error(error.message)
    rows = data || []
  } catch (e) {
    logError('shift-replace-notify', 'could not read held replace notices; the next tick retries', { err: e?.message })
    stats.errors++
    return stats
  }
  stats.rows = rows.length
  if (!rows.length) return stats

  const tzById = new Map()
  try {
    const ids = [...new Set(rows.map((r) => r.location_id).filter(Boolean))]
    const { data, error } = await db.from('locations').select('id, timezone').in('id', ids)
    if (error) throw new Error(error.message)
    for (const l of data || []) tzById.set(l.id, l.timezone)
  } catch (e) {
    logWarn('shift-replace-notify', 'studio timezones unreadable; using Europe/Dublin', { err: e?.message })
  }

  const { send, silent } = netReplaceChanges(rows)
  if (silent.length) {
    // markChangesNotified never throws (it logs its own error).
    await markChangesNotified(db, silent.flatMap((s) => s.rowIds))
    stats.silent += silent.length
  }

  const groups = new Map()
  for (const s of send) {
    if (!inStaffPushHours(nowMs, tzById.get(s.locationId) ?? null)) { stats.quiet++; continue }
    const key = `${s.locationId}|${s.actorId ?? ''}`
    if (!groups.has(key)) groups.set(key, { locationId: s.locationId, actorId: s.actorId, changes: [] })
    groups.get(key).changes.push({ coachId: s.coachId, blockId: s.blockId, blockDate: s.blockDate, startTime: s.startTime, action: s.action })
  }
  for (const g of groups.values()) {
    try {
      await notifyRosterChanges(db, { locationId: g.locationId, actorId: g.actorId, changes: g.changes, todayStr })
      stats.groups++
    } catch (e) {
      stats.errors++
      logError('shift-replace-notify', 'a held replace notice failed; its rows stay unstamped for the next tick', { locationId: g.locationId, err: e?.message })
    }
  }
  return stats
}
```

- [ ] **Step 4: Run the arm test, expect pass.** `npx vitest run src/lib/shift-replace-notify.test.js`.

- [ ] **Step 5: Wire it into the cron (failing test first).** In `src/app/api/cron/send-push-reminders/route.test.js`, next to `vi.mock('@/lib/shift-reminders', …)` (line 33), add:

```js
vi.mock('@/lib/shift-replace-notify', () => ({ runReplaceNotices: vi.fn() }))
```
after the existing `const { runShiftReminders } = …` import add `const { runReplaceNotices } = await import('@/lib/shift-replace-notify')`, and in `beforeEach` add
`runReplaceNotices.mockResolvedValue({ rows: 0, groups: 0, silent: 0, quiet: 0, errors: 0 })`. Then add:

```js
describe('GET /api/cron/send-push-reminders — REPLACE.1a held replace notices', () => {
  it('runs the arm with the tick clock and reports its counts', async () => {
    runReplaceNotices.mockResolvedValue({ rows: 2, groups: 1, silent: 0, quiet: 0, errors: 0 })
    const body = await (await GET(req())).json()
    expect(runReplaceNotices).toHaveBeenCalledWith(expect.anything(), { nowMs: expect.any(Number) })
    expect(body).toMatchObject({ replace_notices: { rows: 2, groups: 1 }, replace_arm_failed: 0 })
  })
  it('a throwing arm is VISIBLE and costs nothing else: 200, parent heartbeat stamped', async () => {
    runReplaceNotices.mockRejectedValue(new Error('boom'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).replace_arm_failed).toBe(1)
    expect(logError).toHaveBeenCalledWith('cron-push-reminders', 'replace notice arm threw', expect.anything())
    expect(stampHeartbeat).toHaveBeenCalledWith('send-push-reminders')
  })
  it('an arm that reports errors is flagged too', async () => {
    runReplaceNotices.mockResolvedValue({ rows: 0, groups: 0, silent: 0, quiet: 0, errors: 1 })
    expect((await (await GET(req())).json()).replace_arm_failed).toBe(1)
  })
})
```

Run: `npx vitest run src/app/api/cron/send-push-reminders/route.test.js` → the three new cases fail.

In `src/app/api/cron/send-push-reminders/route.js`:
- import after line 48 (`import { SHIFT_REMINDERS_HEARTBEAT, …`): `import { runReplaceNotices } from '@/lib/shift-replace-notify'`
- in `summary` (after `shift_arm_failed: 0, …`): `replace_arm_failed: 0, // 1 = the held replace-notice arm threw or reported errors (REPLACE.1a)`
- directly AFTER the `if (summary.shift_arm_failed === 0 && shiftReminderArmHealthy(shiftSummary)) { … }` block and BEFORE `// quiet_hours alone is not news`:

```js
  // -------------------------- HELD REPLACE NOTICES --------------------------
  // REPLACE.1a — replace notices made in quiet hours (or lost with a dead
  // after()) go out from here, from 07:00 studio time. The rule is in
  // src/lib/shift-replace-notify.js. Isolated like the arms above: it can cost
  // no reminder and no heartbeat. Its own heartbeat row, 'replace-notices',
  // arrives with mig 640 (REPLACE.1b); until then a failing arm is visible as
  // replace_arm_failed in the response, the tick log and logError.
  try {
    const replaceSummary = await runReplaceNotices(db, { nowMs })
    summary.replace_notices = replaceSummary
    if ((replaceSummary?.errors || 0) > 0) summary.replace_arm_failed = 1
  } catch (err) {
    summary.replace_arm_failed = 1
    logError('cron-push-reminders', 'replace notice arm threw', { err })
  }
```
Update the header comment's Routing list with one bullet: `- Held replace notices (REPLACE.1a): src/lib/shift-replace-notify.js.`

- [ ] **Step 6: Run, expect pass.** `npx vitest run src/app/api/cron/send-push-reminders/route.test.js src/lib/shift-replace-notify.test.js` → `0 failed`. The existing "quiet-hours tick does not write a tick log line" case must still pass: `replace_notices` is an object and `replace_arm_failed` is 0, so neither trips the `v > 0` test.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/shift-replace-notify.js src/lib/shift-replace-notify.test.js src/app/api/cron/send-push-reminders/route.js src/app/api/cron/send-push-reminders/route.test.js
git commit -m "REPLACE.1a — held replace notices go out from the */5 cron from 07:00

runReplaceNotices: unstamped via=replace rows, 2 min to 48 h old, today or
later; netted per coach and shift (undone overnight = stamped silently); sent
through notifyRosterChanges inside 07:00-22:00 studio time. Also the recovery
for a replace whose after() died. Isolated arm; replace_arm_failed visible.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-6: Arm the write rule on the new write paths

**Files:** Modify `eslint.guardrails.config.mjs`.

- [ ] **Step 1:** In the `no-unchecked-supabase-write` block's `files:` list, after `'src/lib/waitlist-entry.js',` (line 290 on `d11e6971`; after whatever BLOCKEDIT.1/AVAIL.1a appended there), add:

```js
      // REPLACE.1a — the replace move and the held-notice arm. Born clean,
      // armed on arrival: every write destructures error and judges its rows.
      'src/lib/shift-replace-server.js',
      'src/lib/shift-replace-notify.js',
      'src/app/api/schedule/assignments/[[]id]/replace/route.js',
```
(The bracketed path is a glob: `[[]id]` matches the literal `[id]`. Check how neighbouring entries spell a dynamic segment, e.g. `'src/app/api/shelly/**'`; if none does, use `'src/app/api/schedule/assignments/*/replace/route.js'`.)

- [ ] **Step 2:** `npm run check:guardrails` → exit 0.

- [ ] **Step 3: Commit.**

```bash
git add eslint.guardrails.config.mjs
git commit -m "REPLACE.1a — arm no-unchecked-supabase-write on the replace write paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-7: Web: "Replace" on a coach row, the picker in replace mode

**Files:** Modify `src/components/ScheduleCalendar.jsx`.

There is no RTL harness for the dialogs inside `ScheduleCalendar.jsx` (they are not exported); every decision here is `src/lib/shift-replace.js` (`replacePickerCopy`, `replaceResponseOutcome`), tested in Task 1a-2. The JSX is checked in the browser (Step 6).

- [ ] **Step 1: Imports.** Add `Repeat` to the `lucide-react` import (line 26) and:

```js
import { replacePickerCopy, replaceResponseOutcome } from '@/lib/shift-replace'
```

- [ ] **Step 2: State and handler** in `ScheduleCalendar`. Next to `const [assignTarget, setAssignTarget] = useState(null)` (line 201) add:

```js
  const [replaceTarget, setReplaceTarget] = useState(null) // REPLACE.1a — { block, assignment }
```

After `handleAssignCoaches` (the function ending with `showToast('Network error, please try again')\n    }\n  }` before the `// (handleUnassign was dead code` comment) add:

```js
  // REPLACE.1a — hand one coach's shift to another in one action. A clash
  // (leave, another shift that day) asks first, in the server's sentences,
  // and resends with confirm_conflicts. Words: replaceResponseOutcome.
  async function handleReplaceCoach(assignment, profileId, { confirmConflicts = false } = {}) {
    const toName = locationStaff.find((s) => s.id === profileId)?.full_name
    let res
    let data
    try {
      res = await fetch(`/api/schedule/assignments/${assignment.id}/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, ...(confirmConflicts ? { confirm_conflicts: true } : {}) }),
      })
      data = await res.json().catch(() => ({}))
    } catch {
      showToast('Network error, please try again')
      return
    }
    const outcome = replaceResponseOutcome(res.status, data, { fromName: assignment.profiles?.full_name, toName })
    if (outcome.kind === 'confirm') {
      if (confirm(`${outcome.message}\n\nReplace anyway?`)) {
        await handleReplaceCoach(assignment, profileId, { confirmConflicts: true })
      }
      return
    }
    if (outcome.kind === 'error') {
      showToast(outcome.message)
      return
    }
    showToast(outcome.message, outcome.tone)
    setReplaceTarget(null)
    refreshAfterMutation()
  }
```

- [ ] **Step 3: Render the picker in replace mode.** Directly after the `{assignTarget && ( <AssignCoachModal … /> )}` block (line 1403), add:

```jsx
      {/* REPLACE.1a — the same picker (and CANDIDATES.1's ranking), one pick. */}
      {replaceTarget && (
        <AssignCoachModal
          mode="replace"
          replacing={replaceTarget.assignment}
          block={replaceTarget.block}
          staff={locationStaff}
          blocks={blocks}
          timeOff={timeOff}
          unavailableReason={staffUnavailable}
          leaveMissing={leaveMissing}
          onAssign={(ids) => handleReplaceCoach(replaceTarget.assignment, ids[0])}
          onClose={() => setReplaceTarget(null)}
          restoreFocusRef={calendarRef}
        />
      )}
```
Change the `BlockDetailModal` mount condition from `{blockDetail && !assignTarget && (` to `{blockDetail && !assignTarget && !replaceTarget && (`, and pass (next to `onAddCoach=`):

```jsx
          onReplace={isManager && blockDetail.block_date >= todayStr
            ? (assignment) => setReplaceTarget({ block: blockDetail, assignment })
            : null}
```
(The date test only hides the button on a past day; the route has the last word on "started".)

- [ ] **Step 4: `AssignCoachModal` gains `mode` and `replacing`.** Change its signature (line 1673) to
`function AssignCoachModal({ block, staff, blocks, timeOff, unavailableReason = null, leaveMissing = false, onAssign, onClose, restoreFocusRef, mode = 'assign', replacing = null }) {`
and make these four changes inside it:

```js
  const isReplace = mode === 'replace'
```
(first line of the body), then in `toggle(id)`:

```js
  function toggle(id) {
    // REPLACE.1a — replace takes exactly one coach.
    if (isReplace) { setSelectedIds(new Set([id])); return }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
```
replace the `submitLabel` / `overCapacity` lines with:

```js
  const pickedName = isReplace ? available.find((s) => selectedIds.has(s.id))?.full_name : null
  const replaceCopy = isReplace ? replacePickerCopy({ fromName: replacing?.profiles?.full_name, pickedName, saving }) : null
  const overCapacity = !isReplace && selectedIds.size > slotsLeft
  const submitLabel = isReplace
    ? replaceCopy.submit
    : saving
      ? 'Assigning…'
      : selectedIds.size === 0
        ? 'Assign coaches'
        : `Assign ${selectedIds.size} coach${selectedIds.size === 1 ? '' : 'es'}`
```
and in the JSX: the `Modal` `title` becomes `title={isReplace ? replaceCopy.title : 'Assign coaches'}`; the summary line's `· {currentCount}/{block.max_coaches} assigned · {slotsLeft} slot…` part renders only when `!isReplace`; the label becomes `{isReplace ? replaceCopy.label : 'Pick one or more coaches'}`; the row input becomes `type={isReplace ? 'radio' : 'checkbox'}` with `name={isReplace ? 'replace-coach' : undefined}`. Every badge (leave, clash, working time, and CANDIDATES.1's) stays exactly as it is: those are the reason to reuse this picker.

- [ ] **Step 5: The row button.** `BlockDetailModal` takes `onReplace` (add it to the destructured props list after `onUnassign,`) and passes `onReplace={onReplace ? () => onReplace(a) : null}` to each `AssignmentRow`. `AssignmentRow` takes `onReplace` (after `onUnassign,`) and renders, directly BEFORE the "Remove coach" button (`title="Remove coach"`):

```jsx
          {canEdit && !editing && onReplace && (
            <button
              type="button"
              onClick={onReplace}
              disabled={busy}
              className="text-[11px] text-un1t-subtle hover:text-un1t-text disabled:opacity-50 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-un1t-border/40"
              aria-label={`Replace ${coachName} with another coach`}
              title="Replace coach"
            >
              <Repeat size={11} aria-hidden="true" />
            </button>
          )}
```

- [ ] **Step 6: Lint, build, browser check.**

```bash
npm run lint && npm run check:guardrails && npm run build
```
Expected: exit 0 each (`no-untyped-button-in-form` is satisfied: `type="button"`).

Browser check on the PR's **Vercel preview** (memory `local-dev-login`: local dev has no database; the preview reads PROD data, so **look, do not click Replace**): open `/schedule`, open a future published shift with a coach, confirm the Replace icon sits before the X with the tooltip "Replace coach", open it, confirm the picker title "Replace Coach …", radio rows, no capacity line, and the button "Pick a coach" → "Replace with …" after a pick; then Close. The first real replace is a handset/desk check with Richard (PR body).

- [ ] **Step 7: Commit.**

```bash
git add src/components/ScheduleCalendar.jsx
git commit -m "REPLACE.1a — web: Replace on a coach row opens the assign picker in single-select mode

One pick, 'Replace Coach A' / 'Replace with Coach B', every badge kept
(CANDIDATES.1's ranking comes along). A clash asks 'Replace anyway?' in the
server's sentences. Toast says who is told and when (after 7am in quiet hours).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-8: Phone: "Replace coach" in Manage mode (OTA)

**Files:** Modify `mobile/lib/schedule-api.js`, `mobile/lib/schedule-api.test.js`, `mobile/lib/schedule-manage.js`, `mobile/lib/schedule-manage.test.js`, `mobile/components/schedule/ManageMode.jsx`.

- [ ] **Step 1: Failing tests.** In `mobile/lib/schedule-api.test.js` add `'replaceAssignment',` to the sorted export list (between `'removeAssignment',` and `'respondToSwap',`), and add:

```js
describe('REPLACE.1a — replaceAssignment', () => {
  it('POSTs the new coach to /assignments/:id/replace, confirm only when asked', () => {
    schedule.replaceAssignment('as-1', { profileId: 'p2', locationId: LOC })
    expect(lastCall()).toEqual(['/api/schedule/assignments/as-1/replace', { method: 'POST', locationId: LOC, body: { profile_id: 'p2' } }])
    api.mockClear()
    schedule.replaceAssignment('as-1', { profileId: 'p2', confirmConflicts: true, locationId: LOC })
    expect(lastCall()[1].body).toEqual({ profile_id: 'p2', confirm_conflicts: true })
  })
})
```

In `mobile/lib/schedule-manage.test.js` add:

```js
import { coachPressActions, replacePickerTitle, replaceResultAlert } from './schedule-manage'

describe('REPLACE.1a — coachPressActions', () => {
  it('offers Replace on a shift today or later, never on a past one', () => {
    expect(coachPressActions({ block_date: '2026-09-29' }, '2026-09-29')).toEqual(['adjust', 'replace', 'remove'])
    expect(coachPressActions({ block_date: '2026-09-30' }, '2026-09-29')).toEqual(['adjust', 'replace', 'remove'])
    expect(coachPressActions({ block_date: '2026-09-28' }, '2026-09-29')).toEqual(['adjust', 'remove'])
    expect(coachPressActions({}, '2026-09-29')).toEqual(['adjust', 'remove'])
  })
})

describe('REPLACE.1a — replacePickerTitle', () => {
  it('names the coach going off', () => {
    expect(replacePickerTitle({ profiles: { full_name: 'Coach A' } })).toBe('Replace Coach A')
    expect(replacePickerTitle(null)).toBe('Replace coach')
  })
})

describe('REPLACE.1a — replaceResultAlert', () => {
  const names = { fromName: 'Coach A', toName: 'Coach B' }
  it('a clash asks to confirm, in the server\'s sentences', () => {
    const res = { success: false, status: 409, code: 'swap_conflicts', conflicts: [{ kind: 'leave', message: 'Coach B has approved holiday on 2026-09-29, which covers the shift on 2026-09-29.' }] }
    expect(replaceResultAlert(res, names)).toEqual({ kind: 'confirm', title: 'Check before replacing', message: 'Coach B has approved holiday on 2026-09-29, which covers the shift on 2026-09-29.' })
  })
  it('any other refusal is an error in the server\'s words', () => {
    expect(replaceResultAlert({ success: false, status: 409, code: 'shift_started', error: 'This shift has already started.' }, names))
      .toEqual({ kind: 'error', title: 'Could not replace', message: 'This shift has already started.' })
    expect(replaceResultAlert({ success: false, transport: true, error: 'Network error: x' }, names).kind).toBe('error')
  })
  it('done says who is told and when', () => {
    const done = (notice) => replaceResultAlert({ success: true, data: { notice } }, names)
    expect(done('now')).toEqual({ kind: 'done', title: 'Coach replaced', message: 'Coach B is on the shift. Coach A and Coach B have been told.' })
    expect(done('morning').message).toBe('Coach B is on the shift. Coach A and Coach B are told after 7am; if the shift is before then, ring them.')
    expect(done('none').message).toBe('Coach B is on the shift. The roster is a draft, so nobody is told until it is published.')
  })
})
```

Run: `npx vitest run mobile/lib/schedule-api.test.js mobile/lib/schedule-manage.test.js` → the new cases fail.

- [ ] **Step 2: Implement the lib.** In `mobile/lib/schedule-api.js`, after `removeAssignment` (line 198):

```js
// REPLACE.1a — hand this assignment to another coach in one action.
// MANAGER-ONLY (at the shift's studio). A 409 { code: 'swap_conflicts' }
// asks the manager to confirm (leave or another shift that day): resend with
// confirmConflicts. Read the answer with replaceResultAlert (schedule-manage).
export function replaceAssignment(assignmentId, { profileId, confirmConflicts = false, locationId }) {
  const body = { profile_id: profileId }
  if (confirmConflicts) body.confirm_conflicts = true
  return api(`/api/schedule/assignments/${assignmentId}/replace`, { method: 'POST', locationId, body })
}
```

In `mobile/lib/schedule-manage.js`, add the import at the top and these exports after `canAdjustShiftTimes`:

```js
import { isSwapConflictRefusal, swapConflictLines } from './swap-conflicts'
```

```js
// REPLACE.1a — what a manager's press on a coach in Manage mode offers, in
// order. 'replace' only on a shift today or later: a past one is history (the
// route also refuses a started shift, on the studio clock).
export function coachPressActions(block, todayIso) {
  const out = ['adjust']
  if (block?.block_date && todayIso && block.block_date >= todayIso) out.push('replace')
  out.push('remove')
  return out
}

export function replacePickerTitle(assignment) {
  const name = assignment?.profiles?.full_name
  return name ? `Replace ${name}` : 'Replace coach'
}

/**
 * The Alert after POST /replace (api() envelope). 'confirm' = a clash the
 * manager may override (resend with confirmConflicts); 'error' = refused or
 * no answer; 'done' = replaced, and when the coaches hear. Same words as the
 * web (src/lib/shift-replace.js replaceResponseOutcome).
 */
export function replaceResultAlert(res, { fromName, toName } = {}) {
  const from = fromName || 'The coach'
  const to = toName || 'The new coach'
  if (isSwapConflictRefusal(res)) {
    return { kind: 'confirm', title: 'Check before replacing', message: swapConflictLines(res).join('\n') }
  }
  if (!res?.success) return { kind: 'error', title: 'Could not replace', message: res?.error || 'Unknown error' }
  const notice = res?.data?.notice
  const tail = notice === 'morning'
    ? `${from} and ${to} are told after 7am; if the shift is before then, ring them.`
    : notice === 'none'
      ? 'The roster is a draft, so nobody is told until it is published.'
      : `${from} and ${to} have been told.`
  return { kind: 'done', title: 'Coach replaced', message: `${to} is on the shift. ${tail}` }
}
```
(Check `swapConflictLines` returns an array; if it returns a string in the merged code, drop the `.join('\n')`.)

Run the two test files → `0 failed`.

- [ ] **Step 3: Wire `ManageMode.jsx`** (`mobile/components/schedule/ManageMode.jsx`).
- Imports: add `replaceAssignment` to the `../../lib/schedule-api` import; add `coachPressActions, replacePickerTitle, replaceResultAlert` to the `../../lib/schedule-manage` import; add `import { dublinTodayIso } from '../../lib/dates'`.
- State, after `const [pickerBlock, setPickerBlock] = useState(null)`: `const [replaceTarget, setReplaceTarget] = useState(null) // REPLACE.1a — { block, assignment }`.
- In the `useEffect` keyed on `[locationId]` that ends `setPickerBlock(null)`, also `setReplaceTarget(null)` (a studio switch closes this picker too).
- Replace `onCoachPress` with:

```js
  function onCoachPress(block, assignment) {
    const buttons = {
      adjust: { text: 'Adjust times', onPress: () => onAdjust(adjustTargetFor(block, assignment)) },
      replace: { text: 'Replace coach', onPress: () => openReplace(block, assignment) },
      remove: { text: 'Remove from shift', style: 'destructive', onPress: () => confirmRemove(block, assignment) },
    }
    Alert.alert(
      assignment.profiles?.full_name || 'Coach',
      `${block.shift_templates?.name || 'Shift'} · ${block.block_date}`,
      [...coachPressActions(block, dublinTodayIso()).map((k) => buttons[k]), { text: 'Cancel', style: 'cancel' }],
    )
  }

  // REPLACE.1a — the Add-coach picker, titled for the coach going off. The
  // pick IS the confirmation (as for Add coach); an Alert is only shown after
  // the network answer, so it never tries to present over the dismissing sheet.
  async function openReplace(block, assignment) {
    setReplaceTarget({ block, assignment })
    if (staff === null && !staffLoading) await loadStaff()
  }

  async function runReplace(target, coach, confirmConflicts = false) {
    setBusyId(target.block.id)
    const res = await replaceAssignment(target.assignment.id, { profileId: coach.id, confirmConflicts, locationId })
    setBusyId(null)
    const out = replaceResultAlert(res, { fromName: target.assignment.profiles?.full_name, toName: coach.full_name })
    if (out.kind === 'confirm') {
      Alert.alert(out.title, out.message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace anyway', onPress: () => runReplace(target, coach, true) },
      ])
      return
    }
    Alert.alert(out.title, out.message)
    if (out.kind === 'done') { load(); refreshStaffIfLoaded() }
  }
```
- Render a second picker directly after the existing `<CoachPickerSheet … />`:

```jsx
      <CoachPickerSheet visible={!!replaceTarget} block={replaceTarget?.block ?? null} locationId={locationId}
        staff={staff} loading={staffLoading} error={staff === null ? staffError : null} onRetry={loadStaff}
        title={replaceTarget ? replacePickerTitle(replaceTarget.assignment) : ''}
        emptyText="No other coaches at this studio."
        onPick={(coach) => { const t = replaceTarget; setReplaceTarget(null); if (t) runReplace(t, coach) }}
        onClose={() => setReplaceTarget(null)} />
```
(`CoachPickerSheet` already excludes everyone live on the block, the outgoing coach included; CANDIDATES.1's ranking in it comes along.)

- [ ] **Step 4: Checks.**

```bash
npx vitest run mobile/lib/schedule-api.test.js mobile/lib/schedule-manage.test.js
npm run check:mobile-imports && npm run check:mobile-lint && npm run check:ota-paths
```
Expected: `0 failed`; each check exits 0 (no new top-level `mobile/` entry).

- [ ] **Step 5: Commit.**

```bash
git add mobile/lib/schedule-api.js mobile/lib/schedule-api.test.js mobile/lib/schedule-manage.js mobile/lib/schedule-manage.test.js mobile/components/schedule/ManageMode.jsx
git commit -m "REPLACE.1a — phone: Replace coach in Manage mode (OTA)

Coach press menu gains 'Replace coach' on a shift today or later; the Add-coach
picker opens titled 'Replace Coach A'; the pick posts /replace; a clash asks
'Replace anyway?' in the server's sentences; the result says when coaches hear.
Decisions in mobile/lib/schedule-manage.js (tested).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1a-9: The notification registry says so

**Files:** Modify `src/lib/notifications-registry.js`.

- [ ] **Step 1:** In the `category: 'shift_adjusted'` entry (line ~241), append to its `description` string: ` A manager replacing one coach with another tells each of them once, with the shift's day and start time; outside 07:00-22:00 studio time that notice waits for 07:00.` If there is a registry test that snapshots descriptions (`grep -rn "shift_adjusted" src/lib/notifications-registry.test.js`), update it in the same commit.

- [ ] **Step 2:** `npx vitest run src/lib/notifications-registry.test.js tests/push-category-literals.test.js` → `0 failed`.

- [ ] **Step 3: Commit.**

```bash
git add src/lib/notifications-registry.js
git commit -m "REPLACE.1a — the shift_adjusted registry entry describes the replace notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### REPLACE.1a gate

Close the dev server and any other worktree's watchers first (8GB machine).

- [ ] **Focused tests, both zones:**

```bash
npx vitest run src/lib/shift-replace.test.js src/lib/shift-replace-server.test.js src/lib/shift-replace-notify.test.js \
  'src/app/api/schedule/assignments/[id]/replace/route.test.js' src/app/api/cron/send-push-reminders/route.test.js \
  src/lib/roster-change-notify.test.js src/lib/roster-change-format.test.js src/lib/openapi.test.js \
  mobile/lib/schedule-api.test.js mobile/lib/schedule-manage.test.js tests/ota-trigger-paths.test.js
for tz in Europe/Dublin America/Los_Angeles; do
  TZ=$tz npx vitest run src/lib/shift-replace.test.js src/lib/shift-replace-notify.test.js 'src/app/api/schedule/assignments/[id]/replace/route.test.js'
done
```
Expected: `0 failed` every time.

- [ ] **The 12-command CI mirror:**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: all exit 0. `check:select-columns` resolves `roster_change_log` (`details->>via` reads as `details`), `shift_assignments`, `profile_locations`, `profiles`, `shift_swap_requests`, `locations`.

- [ ] **The build:** `npm run build` → `✓ Compiled successfully` (a new route and a new import).

- [ ] **On the PR:** Test & lint and Next build green on the final rebase; Mobile bundle export green.

- [ ] **Independent review.** Point the reviewer at: D1 (the four WHERE guards, and that 23505/zero-rows map to 409 not 500); D3 (both starts asked; arrived refused); D5 (closed swaps get a reviewer so the sweep never owes a notice); D7 (in band from `after()`, out of band from the arm; the arm's 2-minute window vs the route; net zero silent); the web picker in replace mode keeps every badge.

### REPLACE.1a merge steps

1. Rebase on `origin/main` (conflict hotspots: `ScheduleCalendar.jsx` with GRID.1, `ManageMode.jsx`, `send-push-reminders/route.js` + its test with BLOCKEDIT.1's arm, `openapi.js`, `docs/CHANGELOG.md`). Keep every arm and every mock.
2. Required checks green on the final rebase; merge.
3. **Watch the EAS Update run** (`eas-update.yml`). One phone update at a time: nothing else OTA merges until it is green.
4. No migration. Nothing to apply.

### REPLACE.1a PR

**Title:** `REPLACE.1a — replace a coach in one action: one change-log pair, one notice each`

**Body, in order:**
1. What: web block dialog (Replace icon on a coach row) and phone Manage mode (coach press → Replace coach) hand a shift from coach A to coach B in one action. Today: six clicks and two unrelated notices.
2. How: one guarded UPDATE of A's row (id, A still owns it, live, not arrived); overrides, partial reason, arrival stamp and notes cleared (SWAPS.2 "a shift that changes hands starts clean"); open swaps on it closed as the manager's decision. **No migration.**
3. Refused: started (studio clock, the one predicate, at the block start and at A's own start), arrived, not a member / not rosterable, already on it. Leave or a clash for B is the swap approval's confirm step (`swap_conflicts`).
4. Log and notices: two change-log rows via `replace` (drawer: "(coach replaced)"); one `shift_adjusted` notice each via NOTIFY.1's `notifyRosterChanges`, now naming the start time ("… for Tue 29 Sep at 06:00"). Inside 07:00-22:00 studio time it goes at once; outside, a new `*/5` arm sends it from 07:00 (also the recovery for a dead `after()`); undone overnight = no message. Draft: nothing, the first publish tells them.
5. The picker is the assign picker in single-select mode, so CANDIDATES.1's ranking (#<19 PR>) comes along.
6. **🔴 This merge publishes an OTA at 100%** (`mobile/lib/**`, `mobile/components/**`). No native dependency, no `runtimeVersion` bump.
7. Heartbeat: the new arm's own row (`replace-notices`) arrives with mig 640 in REPLACE.1b; until then a failing arm shows as `replace_arm_failed` in the response, the tick log and `logError`.
8. **Handset/desk checks** (after the update lands; the first real replace on a test coach or with Richard alongside):
   - [ ] Web: a future published shift → Replace on Coach A → picker "Replace Coach A", radio, badges → pick Coach B → toast "Coach B is on the shift. Coach A and Coach B have been told."; both phones get one notice each with the day and start time; the drawer shows the pair "(coach replaced)".
   - [ ] Phone Manage mode: press a coach → "Replace coach" → the picker title names them → pick → "Coach replaced".
   - [ ] Pick a coach on approved leave that day → "Check before replacing" with the sentence → Replace anyway works.
   - [ ] After 22:00: replace → the message says "told after 7am"; at 07:0x both notices arrive once.
   - [ ] A draft week: replace works, no notice, no drawer row.
   - [ ] A shift that has started (or a coach with an arrival stamp): refused with the words.
   - [ ] A shift with an open swap posted by Coach A: after the replace the swap is gone from the open pool and from Approvals.
9. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### REPLACE.1a CHANGELOG

After `gh pr create`, add ONE row directly under the table header of `docs/CHANGELOG.md`, commit, push. Never edit another row (`merge=union`).

```
| #<PR> | REPLACE.1a — replace a coach in one action: one change-log pair, one notice each | 2026-09-2x. Wave 2 PR 20a. No migration; **OTA** (mobile/lib, mobile/components). POST /api/schedule/assignments/[id]/replace (manager at the shift's studio): one guarded UPDATE moves A's row to B (id + A owns it + live + not arrived; 0 rows = changed, 23505 = already on it), SWAP_MOVE_CLEARS + notes cleared, open swaps on the row closed as the manager's decision (reviewed_by set). Refused when started (swapShiftHasStarted at the block start and at A's own start) / arrived / not a member / not rosterable; leave or a clash = swap_conflicts confirm step. Published: two roster_change_log rows via 'replace' ("(coach replaced)") and one notifyRosterChanges call (single-change message now names the start time); in band from after(), else the new */5 arm runReplaceNotices (src/lib/shift-replace-notify.js) sends from 07:00 and nets undone replaces silently. Web: Replace icon on a coach row → AssignCoachModal mode="replace" (single pick, badges kept). Phone: Manage mode coach press → Replace coach. Decisions in src/lib/shift-replace.js and mobile/lib/schedule-manage.js (tested). |
```

---

## REPLACE.1b — Offer to team

### Task 1b-0: Preconditions (no commit)

- [ ] **Step 1: 1a is merged and its phone update is out.**

```bash
git log origin/main --oneline -30 | grep 'REPLACE.1a'
gh run list --workflow eas-update.yml --limit 3
```
Expected: the 1a merge commit; its EAS Update run `completed success`.

- [ ] **Step 2: AVAIL.1a is merged and mig 630 is applied** (HARD dependency).

```bash
git log origin/main --oneline -60 | grep 'AVAIL.1a'
grep -n "export function unavailableFor" shared/availability.js
ls supabase/migrations | grep -E '^63[0-9]_'
```
Via Supabase MCP `execute_sql` on `iyvtbjjxdggiadzwwvdj`: `SELECT to_regclass('public.staff_unavailability') IS NOT NULL AS ok;` → `true`. If AVAIL.1a is not merged, STOP: 1b waits (its audience and its coach list read `staff_unavailability`, and shipping a read of a missing table 500s the GET and fails the sweep every tick).

- [ ] **Step 3: 640 is still free.** `ls supabase/migrations | grep '^640_'` → nothing. `list_migrations` (MCP) has no `640`. If BLOCKEDIT's heartbeat took 639 as planned, 640 is ours; if anything else took 640, take the next free number and rename everywhere (file, test, header, this plan's commands).

- [ ] **Step 4: CANDIDATES.1's eligibility, if it exists.** No `19-CANDIDATES.1.md` existed when this plan was written.

```bash
git log origin/main --oneline -40 | grep 'CANDIDATES.1'
grep -rln "candidate" src/lib shared --include='*.js' | grep -v test
```
If CANDIDATES.1 merged a PURE per-person fact builder or predicate ("free", "on leave", "unavailable" for a shift), `offerEligibility` (Task 1b-3) must CALL it for those three facts instead of composing them, and keep `not_member`, `inactive`, `on_block` and the `CLAIM_BLOCKING` split here. Keep every test in `shift-offer-notice.test.js` unchanged: they pin default 6 whichever module computes it. If CANDIDATES.1's rule disagrees with a test (e.g. it treats half-day leave as a whole day), stop and raise it: one rule must win, and the offer audience follows the picker.

- [ ] **Step 5: anchors.**

```bash
grep -n "export function isHalfDayLeave\|^function isHalfDayLeave" src/lib/swap-cover.js
grep -n "replace_arm_failed\|runReplaceNotices\|SHIFT_REMINDERS_HEARTBEAT" src/app/api/cron/send-push-reminders/route.js
grep -n "export const SHIFT_REMINDERS_HEARTBEAT\|export function shiftReminderArmHealthy" src/lib/cron-arm-health.js
grep -n "case 'swap_decision'" mobile/lib/notification-nav.js
grep -n "Open swaps you can take" mobile/components/dashboard/PersonalDashboard.jsx src/components/dashboard/SwapActions.jsx
grep -n "<SwapActions" src/app/dashboard/today/page.js
```

---

### Task 1b-1: Migration 640 and its PGlite test

**Files:** Create `supabase/migrations/640_shift_offers.sql`, `tests/migration-640-shift-offers.test.js`.

- [ ] **Step 1: Write the failing test.**

```js
// tests/migration-640-shift-offers.test.js
// REPLACE.1b — behavioural test for migration 640.
//
// No local Supabase stack, so this boots an in-process Postgres (PGlite),
// recreates the minimum tables the function touches (column names as in prod:
// mig 010/067 blocks + assignments + the (block_id, profile_id) key, mig 177
// min_coaches, mig 628 kind, mig 622 deleted_at, mig 626's active), applies
// the REAL mig 053 (cron_heartbeats), mig 604 (overlap guard) and 640, then
// drives claim_shift_offer the way the route does (service_role, the only
// role granted EXECUTE). PGlite is one connection, so the two-claimers race is
// proven by what the lock leaves behind: the second claim reads 'claimed'.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { SHIFT_OFFER_SWEEP_HEARTBEAT, REPLACE_NOTICES_HEARTBEAT } from '../src/lib/cron-arm-health'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_053 = mig('053_cron_heartbeats.sql')
const MIG_604 = mig('604_shift_assignment_overlap_guard.sql')
const MIG_640 = mig('640_shift_offers.sql')

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const LOC_OTHER = 'a0000000-0000-4000-8000-00000000000b'
const MGR = '10000000-0000-4000-8000-000000000009'
const C1 = '10000000-0000-4000-8000-000000000001'
const C2 = '10000000-0000-4000-8000-000000000002'
const OUT = '10000000-0000-4000-8000-000000000003' // member of another studio only
const GONE = '10000000-0000-4000-8000-000000000004' // deactivated
const ROSTER_PUB = '60000000-0000-4000-8000-000000000001'
const ROSTER_DRAFT = '60000000-0000-4000-8000-000000000002'
const TPL_CLASS = '40000000-0000-4000-8000-000000000001'
const TPL_ADMIN = '40000000-0000-4000-8000-000000000002'
const BLK = '20000000-0000-4000-8000-000000000001'
const BLK_ADMIN = '20000000-0000-4000-8000-000000000002'
const BLK_DRAFT = '20000000-0000-4000-8000-000000000003'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, timezone text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid REFERENCES public.profiles(id), location_id uuid REFERENCES public.locations(id), role text, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text);
  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, name text, kind text NOT NULL DEFAULT 'class');
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id),
    template_id uuid REFERENCES public.shift_templates(id),
    block_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    min_coaches smallint NOT NULL DEFAULT 1,
    max_coaches smallint NOT NULL DEFAULT 15,
    roster_id uuid REFERENCES public.rosters(id)
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id),
    status text NOT NULL DEFAULT 'scheduled',
    notes text,
    assigned_by uuid REFERENCES public.profiles(id),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    start_time_override time,
    end_time_override time,
    CONSTRAINT shift_assignments_block_id_profile_id_key UNIQUE (block_id, profile_id)
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}', 'Studio North', 'Europe/Dublin'), ('${LOC_OTHER}', 'Studio South', 'Europe/Dublin');
  INSERT INTO public.profiles (id, full_name, active) VALUES
    ('${MGR}', 'Manager', true), ('${C1}', 'Coach A', true), ('${C2}', 'Coach B', true), ('${OUT}', 'Coach C', true), ('${GONE}', 'Coach D', false);
  INSERT INTO public.profile_locations VALUES
    ('${MGR}', '${LOC}', 'manager'), ('${C1}', '${LOC}', 'staff'), ('${C2}', '${LOC}', 'staff'),
    ('${OUT}', '${LOC_OTHER}', 'staff'), ('${GONE}', '${LOC}', 'staff');
  INSERT INTO public.rosters VALUES ('${ROSTER_PUB}', 'published'), ('${ROSTER_DRAFT}', 'draft');
  INSERT INTO public.shift_templates VALUES ('${TPL_CLASS}', 'Morning', 'class'), ('${TPL_ADMIN}', 'Front desk', 'admin');
  INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time, min_coaches, max_coaches, roster_id) VALUES
    ('${BLK}', '${LOC}', '${TPL_CLASS}', '2099-01-01', '06:00', '07:00', 2, 3, '${ROSTER_PUB}'),
    ('${BLK_ADMIN}', '${LOC}', '${TPL_ADMIN}', '2099-01-01', '09:00', '12:00', 0, 2, '${ROSTER_PUB}'),
    ('${BLK_DRAFT}', '${LOC}', '${TPL_CLASS}', '2099-01-02', '06:00', '07:00', 1, 3, '${ROSTER_DRAFT}');
`

let db
const runSql = (text) => db.exec(text) // PGlite's multi-statement runner (a SQL call, no shell)

/** One statement as service_role in its own committed tx; a raise rolls it back. */
async function asService(sql, params = []) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE service_role')
    const res = await db.query(sql, params)
    await runSql('COMMIT')
    return res.rows
  } catch (e) {
    await runSql('ROLLBACK')
    throw e
  }
}
const offer = async (block, status = 'open') => (await asService(
  `INSERT INTO public.shift_offers (location_id, block_id, offered_by, status, closed_at) VALUES ($1, $2, $3, $4::text, CASE WHEN $4::text = 'open' THEN NULL ELSE now() END) RETURNING id`,
  [LOC, block, MGR, status],
))[0].id
const claim = async (offerId, who) => (await asService('SELECT public.claim_shift_offer($1, $2) AS r', [offerId, who]))[0].r
const offerRow = async (id) => (await db.query('SELECT * FROM public.shift_offers WHERE id = $1', [id])).rows[0]
const liveOn = async (block) => (await db.query(`SELECT profile_id FROM public.shift_assignments WHERE block_id = $1 AND status <> 'cancelled' ORDER BY profile_id`, [block])).rows.map((r) => r.profile_id)

beforeEach(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_053)
  await runSql(MIG_604)
  await runSql(SEED)
  await runSql(MIG_640)
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 640 — the table', () => {
  it('RLS on, no policy, and the browser roles hold NOTHING (service role only)', async () => {
    expect((await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shift_offers'::regclass`)).rows).toEqual([{ relrowsecurity: true }])
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'shift_offers'`)).rows[0].n).toBe(0)
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect((await db.query(`SELECT has_table_privilege($1, 'public.shift_offers', $2) AS ok`, [role, priv])).rows[0].ok).toBe(false)
      }
    }
    expect((await db.query(`SELECT has_table_privilege('service_role', 'public.shift_offers', 'UPDATE') AS ok`)).rows[0].ok).toBe(true)
  })

  it('ONE open offer per shift (race-proof), any number of closed ones', async () => {
    await offer(BLK)
    await expect(offer(BLK)).rejects.toThrow(/shift_offers_one_open_per_block|duplicate key/)
    await asService(`UPDATE public.shift_offers SET status = 'withdrawn', closed_at = now() WHERE block_id = $1`, [BLK])
    await expect(offer(BLK)).resolves.toBeTruthy()
  })

  it('refuses a status it does not know, an open offer with a closed_at, a claim with no time', async () => {
    await expect(asService(`INSERT INTO public.shift_offers (location_id, block_id, status, closed_at) VALUES ($1, $2, 'bogus', now())`, [LOC, BLK])).rejects.toThrow(/shift_offers_status/)
    await expect(asService(`INSERT INTO public.shift_offers (location_id, block_id, status, closed_at) VALUES ($1, $2, 'open', now())`, [LOC, BLK])).rejects.toThrow(/shift_offers_closed_pair/)
    await expect(asService(`INSERT INTO public.shift_offers (location_id, block_id, status, closed_at) VALUES ($1, $2, 'claimed', now())`, [LOC, BLK])).rejects.toThrow(/shift_offers_claim_pair/)
  })

  it('a deleted shift takes its offers with it', async () => {
    await offer(BLK)
    await runSql(`DELETE FROM public.shift_blocks WHERE id = '${BLK}'`)
    expect((await db.query('SELECT count(*)::int AS n FROM public.shift_offers')).rows[0].n).toBe(0)
  })
})

describe('mig 640 — claim_shift_offer', () => {
  it('the first claim wins: an assignment for the claimant, the offer closed as claimed', async () => {
    const id = await offer(BLK)
    const r = await claim(id, C1)
    expect(r).toMatchObject({ outcome: 'claimed', offer_id: id, block_id: BLK, block_date: '2099-01-01', location_id: LOC })
    expect(await liveOn(BLK)).toEqual([C1])
    const row = await offerRow(id)
    expect(row).toMatchObject({ status: 'claimed', claimed_by: C1, claimed_assignment_id: r.assignment_id, notice_attempts: 0, notice_lease_until: null })
    expect(row.closed_at).not.toBeNull()
    expect(row.claimed_at).not.toBeNull()
    const a = (await db.query('SELECT assigned_by, status FROM public.shift_assignments WHERE id = $1', [r.assignment_id])).rows[0]
    expect(a).toEqual({ assigned_by: C1, status: 'scheduled' })
  })

  it('the second claimer reads the first one\'s lock: offer_not_open, nothing inserted', async () => {
    const id = await offer(BLK)
    await claim(id, C1)
    await expect(claim(id, C2)).rejects.toThrow(/^offer_not_open: offer is already claimed/)
    expect(await liveOn(BLK)).toEqual([C1])
  })

  it('only a rosterable member of the offer\'s studio may claim', async () => {
    const id = await offer(BLK)
    await expect(claim(id, OUT)).rejects.toThrow(/^offer_not_eligible/)
    await expect(claim(id, GONE)).rejects.toThrow(/^offer_not_eligible/)
    await runSql(`UPDATE public.profiles SET deleted_at = now() WHERE id = '${C2}'`)
    await expect(claim(id, C2)).rejects.toThrow(/^offer_not_eligible/)
    expect((await offerRow(id)).status).toBe('open')
  })

  it('someone already on the shift cannot claim it again', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK}', '${C1}')`)
    const id = await offer(BLK)
    await expect(claim(id, C1)).rejects.toThrow(/^offer_already_on/)
  })

  it('a shift on a draft roster cannot be claimed', async () => {
    const id = await offer(BLK_DRAFT)
    await expect(claim(id, C1)).rejects.toThrow(/^offer_not_published/)
  })

  it('filled meanwhile: the offer closes as filled, the claim is refused (no raise, so the close sticks)', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK}', '${MGR}'), ('${BLK}', '${C2}')`)
    const id = await offer(BLK)
    expect(await claim(id, C1)).toEqual({ outcome: 'filled', offer_id: id })
    expect((await offerRow(id)).status).toBe('filled')
    expect(await liveOn(BLK)).toEqual([MGR, C2].sort())
  })

  it('a class shift short by one: one claim fills the place (target = its minimum)', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ('${BLK}', '${MGR}')`)
    const id = await offer(BLK)
    expect((await claim(id, C1)).outcome).toBe('claimed')
  })

  it('an admin shift (minimum 0) can be claimed only while EMPTY', async () => {
    const id = await offer(BLK_ADMIN)
    expect((await claim(id, C1)).outcome).toBe('claimed')
    const again = await offer(BLK_ADMIN)
    expect(await claim(again, C2)).toEqual({ outcome: 'filled', offer_id: again })
  })

  it('a cancelled tombstone of the claimant is cleared, not a unique-key error', async () => {
    await runSql(`INSERT INTO public.shift_assignments (block_id, profile_id, status) VALUES ('${BLK}', '${C1}', 'cancelled')`)
    const id = await offer(BLK)
    expect((await claim(id, C1)).outcome).toBe('claimed')
    expect(await liveOn(BLK)).toEqual([C1])
  })

  it('EXECUTE is service_role only', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query(`SELECT has_function_privilege($1, 'public.claim_shift_offer(uuid, uuid)', 'EXECUTE') AS ok`, [role])).rows[0].ok).toBe(false)
    }
    expect((await db.query(`SELECT has_function_privilege('service_role', 'public.claim_shift_offer(uuid, uuid)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(true)
  })
})

describe('mig 640 — heartbeats, replay', () => {
  it('seeds both arm rows under the names the code stamps, on the */5 cadence', async () => {
    const rows = (await db.query(`SELECT name, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name = ANY($1) ORDER BY name`,
      [[SHIFT_OFFER_SWEEP_HEARTBEAT, REPLACE_NOTICES_HEARTBEAT]])).rows
    expect(rows).toEqual([
      { name: REPLACE_NOTICES_HEARTBEAT, expected_interval_seconds: 300, grace_seconds: 900 },
      { name: SHIFT_OFFER_SWEEP_HEARTBEAT, expected_interval_seconds: 300, grace_seconds: 900 },
    ])
  })

  it('replaying the file is safe and RE-ARMS the heartbeats', async () => {
    await runSql(`UPDATE public.cron_heartbeats SET last_ok_at = now() - interval '2 hours' WHERE name = '${SHIFT_OFFER_SWEEP_HEARTBEAT}'`)
    await runSql(MIG_640)
    const age = (await db.query(`SELECT EXTRACT(EPOCH FROM (now() - last_ok_at))::int AS s FROM public.cron_heartbeats WHERE name = $1`, [SHIFT_OFFER_SWEEP_HEARTBEAT])).rows[0].s
    expect(age).toBeLessThan(5)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'shift_offers_one_open_per_block'`)).rows[0].n).toBe(1)
  })
})
```

- [ ] **Step 2: Run, expect failure:** `npx vitest run tests/migration-640-shift-offers.test.js` → cannot read `640_shift_offers.sql` (and the two heartbeat names do not exist yet; Task 1b-7 adds them to `cron-arm-health.js`. Add the two `export const`s now, ahead of Task 1b-7, so this test can import them: `export const REPLACE_NOTICES_HEARTBEAT = 'replace-notices'` and `export const SHIFT_OFFER_SWEEP_HEARTBEAT = 'shift-offer-sweep'` after `ROSTER_RUNWAY_HEARTBEAT` in `src/lib/cron-arm-health.js`).

- [ ] **Step 3: Write the migration.**

```sql
-- 640 — REPLACE.1b: "Offer to team". A manager posts an unfilled or short
-- PUBLISHED shift to every coach who is free for it; the first to claim it
-- gets it. This adds the offer table, the ONE function that decides a claim,
-- and heartbeat rows for the two */5 arms that ride send-push-reminders.
--
-- WHY A TABLE OF ITS OWN (not shift_swap_requests)
-- ───────────────────────────────────────────────
-- A swap is about an ASSIGNMENT, and an unfilled shift has none. A swap row
-- with requester_shift_id NULL is how the cover sweep recognises a swap whose
-- shift was DELETED (it closes it on the next tick), requester_id is NOT NULL
-- (an offer has no giver), and a swap claim waits for a manager's approval
-- (inbox, badge, T-48/T-12 nudges). An offer is first-come, no approval.
--
-- WHAT
-- ────
-- 1. public.shift_offers — one row per offer.
--    status: open -> claimed | withdrawn | expired | filled. One OPEN offer per
--    shift (partial unique index). The notice columns carry a LEASE
--    (notice_lease_until + notice_attempts) so the sender can never lose a
--    notice: it leases, sends under a ledger key numbered by the attempt,
--    then stamps broadcast_at / taken_notified_at. A crash after the send
--    costs a duplicate on the next attempt, never the notice.
-- 2. public.claim_shift_offer(p_offer_id, p_profile_id) RETURNS jsonb.
--    Locks the offer FOR UPDATE: two claimers serialise on that lock, and the
--    second reads 'claimed'. Then locks the shift and re-checks, in the same
--    transaction, everything a claim depends on: the roster is published, the
--    claimant is an active, undeleted member of the offer's studio and not
--    already on the shift, and the shift still needs someone (live coaches
--    below its target and below max_coaches; target = min_coaches, at least 1,
--    for a class shift, and 1 for an admin shift, which has no minimum
--    (SHIFTTYPE.1, mig 628) and is offered only while empty). If it no longer
--    needs anyone the offer closes as 'filled' and the function RETURNS
--    { outcome: 'filled' } rather than raising, so that close is kept.
--    Otherwise it clears the claimant's cancelled tombstone (the mig 067
--    (block_id, profile_id) key does not care about status), inserts the
--    assignment and closes the offer as claimed.
--    Errors: P0001 with a message prefix the route maps: offer_bad_request,
--    offer_not_found, offer_not_open, offer_not_published,
--    offer_not_eligible, offer_already_on.
--    The route checks, BEFORE calling it: the shift has not started (the one
--    predicate, swapShiftHasStarted, on the studio clock), and the claimant is
--    not on approved leave or on an overlapping shift.
-- 3. cron_heartbeats rows 'shift-offer-sweep' (the offer arm) and
--    'replace-notices' (REPLACE.1a's held-notice arm), both */5: 300 + 900,
--    the 'shift-reminders' cadence (mig 633). ON CONFLICT DO UPDATE re-arms.
--
-- SECURITY
-- ────────
-- RLS ON with NO policy, and the browser roles hold no grant at all: every
-- read and write is a service-role route or cron that scopes in code (the
-- mig 632 posture). The advisor reports rls_enabled_no_policy (INFO) for it,
-- by design. The function is SECURITY INVOKER, search_path pinned empty,
-- every name schema-qualified, EXECUTE for service_role only.
--
-- APPLY
-- ─────
-- BEFORE the REPLACE.1b code deploys (its routes and its arm read
-- shift_offers). The heartbeat rows start their clock at apply: apply right
-- before merging, and if the production deploy has not landed within ~15
-- minutes, re-run this file (a replay re-arms both rows and changes nothing
-- else), or the health-check pages for an arm that is not deployed yet.
-- AFTER APPLYING: get_advisors (type=security).
--
-- REPLAYING THIS FILE IS SAFE (IF NOT EXISTS / CREATE OR REPLACE / REVOKE +
-- GRANT / ON CONFLICT DO UPDATE); it re-arms the two heartbeat rows.

CREATE TABLE IF NOT EXISTS public.shift_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  block_id              uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
  offered_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  claimed_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  claimed_at            timestamptz,
  claimed_assignment_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
  broadcast_at          timestamptz,
  broadcast_count       integer,
  broadcast_outcome     text,
  taken_notified_at     timestamptz,
  notice_lease_until    timestamptz,
  notice_attempts       smallint NOT NULL DEFAULT 0,
  CONSTRAINT shift_offers_status CHECK (status IN ('open', 'claimed', 'withdrawn', 'expired', 'filled')),
  CONSTRAINT shift_offers_closed_pair CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT shift_offers_claim_pair CHECK ((status = 'claimed') = (claimed_at IS NOT NULL)),
  CONSTRAINT shift_offers_broadcast_outcome CHECK (broadcast_outcome IS NULL OR broadcast_outcome IN ('sent', 'no_recipients', 'gave_up')),
  CONSTRAINT shift_offers_notice_attempts CHECK (notice_attempts BETWEEN 0 AND 20)
);

COMMENT ON TABLE public.shift_offers IS
  'REPLACE.1b (mig 640) — "Offer to team": a manager offers an unfilled/short published shift to every coach free for it; the first claim (claim_shift_offer) gets it. One OPEN offer per shift. notice_lease_until + notice_attempts lease the broadcast / taken notices (attempt-numbered ledger keys: a crash duplicates, never loses). Service-role only (RLS on, no policy, no browser grants).';

CREATE UNIQUE INDEX IF NOT EXISTS shift_offers_one_open_per_block
  ON public.shift_offers (block_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS shift_offers_block_idx ON public.shift_offers (block_id);
CREATE INDEX IF NOT EXISTS shift_offers_location_status_idx ON public.shift_offers (location_id, status);
-- The arm's second read: claimed offers whose managers are still owed the notice.
CREATE INDEX IF NOT EXISTS shift_offers_taken_owed_idx
  ON public.shift_offers (claimed_at) WHERE status = 'claimed' AND taken_notified_at IS NULL;
-- Cover the three nullable FKs (advisor unindexed_foreign_keys).
CREATE INDEX IF NOT EXISTS shift_offers_offered_by_idx ON public.shift_offers (offered_by) WHERE offered_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_offers_claimed_by_idx ON public.shift_offers (claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_offers_claimed_assignment_idx ON public.shift_offers (claimed_assignment_id) WHERE claimed_assignment_id IS NOT NULL;

ALTER TABLE public.shift_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_offers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_offers TO service_role;

CREATE OR REPLACE FUNCTION public.claim_shift_offer(p_offer_id uuid, p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_offer  public.shift_offers;
  v_block  record;
  v_live   integer;
  v_target integer;
  v_assignment_id uuid;
BEGIN
  IF p_offer_id IS NULL OR p_profile_id IS NULL THEN
    RAISE EXCEPTION 'offer_bad_request: an offer and a profile are required';
  END IF;

  -- 1. Lock the offer. This is where two claimers are serialised.
  SELECT * INTO v_offer FROM public.shift_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found: offer % does not exist', p_offer_id;
  END IF;
  IF v_offer.status <> 'open' THEN
    RAISE EXCEPTION 'offer_not_open: offer is already %', v_offer.status;
  END IF;

  -- 2. Lock the shift and read what the claim depends on.
  SELECT b.id, b.location_id, b.block_date, b.min_coaches, b.max_coaches,
         r.status AS roster_status,
         COALESCE(t.kind, 'class') AS kind
    INTO v_block
    FROM public.shift_blocks b
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
   WHERE b.id = v_offer.block_id
   FOR UPDATE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found: the shift no longer exists';
  END IF;
  IF v_block.roster_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'offer_not_published: the shift is not on a published roster';
  END IF;

  -- 3. The claimant: an active, undeleted member of the offer's studio
  --    (mig 626's staff predicate: a NULL active still counts).
  IF NOT EXISTS (
    SELECT 1
      FROM public.profile_locations pl
      JOIN public.profiles p ON p.id = pl.profile_id
     WHERE pl.profile_id = p_profile_id
       AND pl.location_id = v_offer.location_id
       AND p.active IS NOT FALSE
       AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'offer_not_eligible: the claimant is not an active member of this studio';
  END IF;

  -- 4. Not already on it.
  IF EXISTS (
    SELECT 1 FROM public.shift_assignments a
     WHERE a.block_id = v_block.id AND a.profile_id = p_profile_id
       AND COALESCE(a.status, 'scheduled') <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'offer_already_on: the claimant is already on this shift';
  END IF;

  -- 5. Still needed? Filled meanwhile closes the offer and RETURNS (a raise
  --    would roll the close back).
  SELECT count(*) INTO v_live
    FROM public.shift_assignments a
   WHERE a.block_id = v_block.id AND COALESCE(a.status, 'scheduled') <> 'cancelled';
  v_target := CASE WHEN v_block.kind = 'admin' THEN 1 ELSE GREATEST(COALESCE(v_block.min_coaches, 1), 1) END;
  IF v_live >= v_target OR v_live >= v_block.max_coaches THEN
    UPDATE public.shift_offers
       SET status = 'filled', closed_at = now(), notice_lease_until = NULL
     WHERE id = v_offer.id;
    RETURN jsonb_build_object('outcome', 'filled', 'offer_id', v_offer.id);
  END IF;

  -- 6. The claimant's cancelled tombstone would trip the (block, profile) key.
  DELETE FROM public.shift_assignments a
   WHERE a.block_id = v_block.id AND a.profile_id = p_profile_id AND a.status = 'cancelled';

  -- 7. Put them on the shift. assigned_by = the claimant: they did it.
  INSERT INTO public.shift_assignments (block_id, profile_id, status, assigned_by)
  VALUES (v_block.id, p_profile_id, 'scheduled', p_profile_id)
  RETURNING id INTO v_assignment_id;

  -- 8. Close the offer. The lease resets: the managers' "taken" notice is a
  --    new phase with its own attempts.
  UPDATE public.shift_offers
     SET status = 'claimed', claimed_by = p_profile_id, claimed_at = now(), closed_at = now(),
         claimed_assignment_id = v_assignment_id, notice_lease_until = NULL, notice_attempts = 0
   WHERE id = v_offer.id;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'offer_id', v_offer.id,
    'assignment_id', v_assignment_id,
    'block_id', v_block.id,
    'block_date', to_char(v_block.block_date, 'YYYY-MM-DD'),
    'location_id', v_block.location_id
  );
END;
$$;

COMMENT ON FUNCTION public.claim_shift_offer(uuid, uuid) IS
  'REPLACE.1b (mig 640) — claims an open shift offer atomically: locks the offer (second claimer reads claimed), locks the shift, re-checks published / active member / not already on it / still needed (else closes the offer as filled and returns outcome filled), clears the claimant''s cancelled tombstone, inserts the assignment and closes the offer. P0001 with an offer_* message prefix. service_role only.';

REVOKE ALL ON FUNCTION public.claim_shift_offer(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_shift_offer(uuid, uuid) TO service_role;

INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES
  ('shift-offer-sweep', now(), 300, 900,
   'REPLACE.1b — the offer arm (src/lib/shift-offer-server.js runShiftOfferSweep) of the */5 Vercel cron /api/cron/send-push-reminders. Closes offers whose shift started / was filled / left a published roster, and sends the owed broadcast and taken notices inside 07:00-22:00 studio time. Stamped only when the arm ran with errors: 0; quiet-hours ticks stamp. STALE = the arm threw or reported errors on every tick for 20 minutes: see last_outcome and the shift-offer logError lines.'),
  ('replace-notices', now(), 300, 900,
   'REPLACE.1a — the held replace-notice arm (src/lib/shift-replace-notify.js runReplaceNotices) of the */5 Vercel cron /api/cron/send-push-reminders. Sends replace notices held by quiet hours or lost with a dead after(). Stamped only when the arm ran with errors: 0. STALE = it failed on every tick for 20 minutes: see last_outcome and replace_arm_failed in the tick log.')
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- Self-check against the catalog, not this text (the mig 153b habit). A RAISE
-- aborts the whole file, so nothing half-applies.
DO $$
DECLARE
  n int;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shift_offers'::regclass) THEN
    RAISE EXCEPTION 'mig 640: RLS is not enabled on shift_offers';
  END IF;
  IF has_table_privilege('authenticated', 'public.shift_offers', 'SELECT')
     OR has_table_privilege('anon', 'public.shift_offers', 'SELECT') THEN
    RAISE EXCEPTION 'mig 640: a browser role can read shift_offers';
  END IF;
  IF has_function_privilege('authenticated', 'public.claim_shift_offer(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 640: authenticated can execute claim_shift_offer';
  END IF;
  SELECT count(*) INTO n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'shift_offers_one_open_per_block';
  IF n <> 1 THEN
    RAISE EXCEPTION 'mig 640: expected the one-open-offer-per-shift index, found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.cron_heartbeats WHERE name IN ('shift-offer-sweep', 'replace-notices');
  IF n <> 2 THEN
    RAISE EXCEPTION 'mig 640: expected 2 heartbeat rows, found %', n;
  END IF;
END $$;
```

- [ ] **Step 4: Run, expect pass.** `npx vitest run tests/migration-640-shift-offers.test.js` → `0 failed`. If PGlite rejects `FOR UPDATE OF b` with the outer joins, change step 2 of the function to lock first (`PERFORM 1 FROM public.shift_blocks WHERE id = v_offer.block_id FOR UPDATE;`) and then read with the joins without a lock clause; rerun.

- [ ] **Step 5: Commit** (the file is committed now and APPLIED only at merge time, "Migration apply steps" below).

```bash
git add supabase/migrations/640_shift_offers.sql tests/migration-640-shift-offers.test.js src/lib/cron-arm-health.js
git commit -m "REPLACE.1b — mig 640: shift_offers, claim_shift_offer, heartbeat rows for the two */5 arms

One open offer per shift (partial unique index); a lease on the row for the
notices. claim_shift_offer locks the offer (second claimer reads claimed),
re-checks published / active member / not on it / still needed (else closes as
filled and returns), clears a tombstone, inserts, closes. Service-role only.
PGlite test drives the function as service_role.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1b-2: `shared/offer-to-team.js` — what may be offered, and what it reads as (OTA)

**Files:** Create `shared/offer-to-team.js`, `shared/offer-to-team.test.js`.

- [ ] **Step 1: Write the failing test.**

```js
// shared/offer-to-team.test.js
// REPLACE.1b — the ONE rule the web button, the phone button and
// POST /api/schedule/blocks/[id]/offer ask: may this shift be offered?
import { describe, it, expect } from 'vitest'
import {
  offerTargetCount, offerStillNeeded, offerRefusal, OFFER_REFUSALS,
  offerStateLabel, offerWhenLine, indexOffersByBlock, offerPostResultText, offerClaimResultText,
} from './offer-to-team.js'

const TODAY = '2026-09-28'
const live = (n) => Array.from({ length: n }, (_, i) => ({ profile_id: `p${i}`, status: 'scheduled' }))
const cls = (over = {}) => ({ block_date: '2026-09-29', min_coaches: 2, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { kind: 'class' }, shift_assignments: [], ...over })
const admin = (over = {}) => cls({ min_coaches: 0, shift_templates: { kind: 'admin' }, ...over })

describe('offerTargetCount', () => {
  it('a class shift wants its minimum (at least 1); an admin shift, 1', () => {
    expect(offerTargetCount(cls())).toBe(2)
    expect(offerTargetCount(cls({ min_coaches: 0 }))).toBe(1)
    expect(offerTargetCount(admin())).toBe(1)
    expect(offerTargetCount({ min_coaches: 3 })).toBe(3) // unreadable kind = class (shared/shift-kind.js)
  })
})

describe('offerStillNeeded', () => {
  it('class: needed while live coaches are below the minimum; cancelled rows are not coaches', () => {
    expect(offerStillNeeded(cls())).toBe(true)
    expect(offerStillNeeded(cls({ shift_assignments: live(1) }))).toBe(true)
    expect(offerStillNeeded(cls({ shift_assignments: live(2) }))).toBe(false)
    expect(offerStillNeeded(cls({ shift_assignments: [...live(1), { profile_id: 'x', status: 'cancelled' }] }))).toBe(true)
  })
  it('admin: needed only while EMPTY (no minimum, so never "short")', () => {
    expect(offerStillNeeded(admin())).toBe(true)
    expect(offerStillNeeded(admin({ shift_assignments: live(1) }))).toBe(false)
  })
  it('never past max_coaches', () => {
    expect(offerStillNeeded(cls({ min_coaches: 3, max_coaches: 2, shift_assignments: live(2) }))).toBe(false)
  })
})

describe('offerRefusal', () => {
  it('an empty or short published future class shift, or an empty admin one, may be offered', () => {
    expect(offerRefusal(cls(), { todayIso: TODAY })).toBeNull()
    expect(offerRefusal(cls({ shift_assignments: live(1) }), { todayIso: TODAY })).toBeNull()
    expect(offerRefusal(admin(), { todayIso: TODAY })).toBeNull()
    expect(offerRefusal(cls({ block_date: TODAY }), { todayIso: TODAY })).toBeNull()
  })
  it('refuses in order: draft, past, started, already offered, staffed', () => {
    expect(offerRefusal(cls({ rosters: { status: 'draft' } }), { todayIso: TODAY })).toBe('not_published')
    expect(offerRefusal(cls({ rosters: null }), { todayIso: TODAY })).toBe('not_published')
    expect(offerRefusal(cls({ block_date: '2026-09-27' }), { todayIso: TODAY })).toBe('past')
    expect(offerRefusal(cls(), { todayIso: TODAY, started: true })).toBe('started')
    expect(offerRefusal(cls(), { todayIso: TODAY, hasOpenOffer: true })).toBe('already_offered')
    expect(offerRefusal(cls({ shift_assignments: live(2) }), { todayIso: TODAY })).toBe('staffed')
    expect(offerRefusal(admin({ shift_assignments: live(1) }), { todayIso: TODAY })).toBe('staffed')
    expect(offerRefusal(null, { todayIso: TODAY })).toBe('unknown')
  })
  it('every refusal has words', () => {
    for (const key of ['not_published', 'past', 'started', 'already_offered', 'staffed', 'unknown']) expect(OFFER_REFUSALS[key]).toMatch(/\w/)
  })
})

describe('offerStateLabel (the manager\'s line)', () => {
  it('says whether and how the team was told', () => {
    expect(offerStateLabel({ notice_state: 'sent', broadcast_count: 4 })).toBe('Offered to the team · sent to 4 coaches')
    expect(offerStateLabel({ notice_state: 'sent', broadcast_count: 1 })).toBe('Offered to the team · sent to 1 coach')
    expect(offerStateLabel({ notice_state: 'nobody', broadcast_count: 0 })).toBe('Offered to the team · nobody is free to ask')
    expect(offerStateLabel({ notice_state: 'sending' })).toBe('Offered to the team · telling coaches now')
    expect(offerStateLabel({ notice_state: 'morning' })).toBe('Offered to the team · coaches are told from 7am')
    expect(offerStateLabel({ notice_state: 'failed' })).toBe("Offered to the team · the notification couldn't be sent")
    expect(offerStateLabel({})).toBe('Offered to the team')
  })
})

describe('offerWhenLine (the coach\'s card)', () => {
  it('weekday, date and times, from the date\'s own parts (no timezone moves it)', () => {
    expect(offerWhenLine({ block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00' })).toBe('Tue 29 Sep · 06:00-07:00')
    expect(offerWhenLine({ block_date: '2026-02-30', start_time: '06:00:00', end_time: '07:00:00' })).toBe('06:00-07:00')
    expect(offerWhenLine({})).toBe('')
  })
})

describe('indexOffersByBlock', () => {
  it('open offers keyed by shift; junk dropped', () => {
    expect(indexOffersByBlock([{ id: 'o1', block_id: 'b1' }, null, { id: 'o2' }])).toEqual({ b1: { id: 'o1', block_id: 'b1' } })
    expect(indexOffersByBlock(null)).toEqual({})
  })
})

describe('result words (web toast and phone alert)', () => {
  it('posting', () => {
    expect(offerPostResultText(201, { success: true, data: { notice: 'now' } })).toEqual({ tone: 'success', text: 'Offered to the team. Coaches who are free are being told now.' })
    expect(offerPostResultText(201, { success: true, data: { notice: 'morning' } })).toEqual({ tone: 'warning', text: 'Offered to the team. Coaches see it on Today now and get a notification from 7am.' })
    expect(offerPostResultText(409, { success: false, error: 'This shift is already offered to the team.' })).toEqual({ tone: 'error', text: 'This shift is already offered to the team.' })
    expect(offerPostResultText(0, null)).toEqual({ tone: 'error', text: 'Could not offer the shift.' })
  })
  it('claiming', () => {
    expect(offerClaimResultText(200, { success: true })).toEqual({ tone: 'success', text: "It's yours. It is on your roster now." })
    expect(offerClaimResultText(409, { success: false, error: 'Someone else has just taken this shift.' })).toEqual({ tone: 'error', text: 'Someone else has just taken this shift.' })
  })
})
```

- [ ] **Step 2: Run, expect failure** (module missing): `npx vitest run shared/offer-to-team.test.js`.

- [ ] **Step 3: Implement.**

```js
// shared/offer-to-team.js
//
// REPLACE.1b — "Offer to team": may a manager offer this shift, how many
// coaches it still needs, and what an offer reads as. Pure and dependency-
// light (shared/ is the phone seam). The web block dialog, the phone Manage
// card and POST /api/schedule/blocks/[id]/offer all ask offerRefusal, so the
// button a manager sees and the answer the route gives cannot disagree.
// claim_shift_offer (mig 640) re-derives offerTargetCount in SQL: keep the two
// in step (tests/migration-640-shift-offers.test.js pins the SQL side).

import { isAdminShift } from './shift-kind.js'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Live = not cancelled (a swap-drop tombstone), same rule as isLiveAssignment.
const liveCount = (block) => (Array.isArray(block?.shift_assignments) ? block.shift_assignments : [])
  .filter((a) => a && a.status !== 'cancelled').length

/**
 * How many live coaches the shift should have before nobody else is needed.
 * A class shift: its minimum, at least 1. An admin shift: 1. It has no
 * minimum (SHIFTTYPE.1), so it is offered only while empty.
 */
export function offerTargetCount(block) {
  if (isAdminShift(block)) return 1
  return Math.max(Number(block?.min_coaches) || 0, 1)
}

/** Does the shift still need a coach? Below its target and below max_coaches. */
export function offerStillNeeded(block) {
  const live = liveCount(block)
  const max = Number(block?.max_coaches)
  if (Number.isFinite(max) && max > 0 && live >= max) return false
  return live < offerTargetCount(block)
}

export const OFFER_REFUSALS = Object.freeze({
  not_published: 'Publish the roster first: coaches only see published shifts.',
  past: 'This shift is in the past.',
  started: 'This shift has already started.',
  already_offered: 'This shift is already offered to the team.',
  staffed: 'This shift already has the coaches it needs.',
  unknown: 'This shift could not be read.',
})

/**
 * null when the shift may be offered, else a key of OFFER_REFUSALS. `started`
 * is the caller's answer: the route asks swapShiftHasStarted on the studio's
 * clock; the buttons pass false and let the route have the last word.
 *
 * @param {object|null} block  shift_blocks row with rosters.status, shift_templates.kind, min/max, shift_assignments[]
 * @param {{ todayIso: string, started?: boolean, hasOpenOffer?: boolean }} opts
 */
export function offerRefusal(block, { todayIso, started = false, hasOpenOffer = false } = {}) {
  if (!block || !block.block_date) return 'unknown'
  if (block.rosters?.status !== 'published') return 'not_published'
  if (todayIso && block.block_date < todayIso) return 'past'
  if (started) return 'started'
  if (hasOpenOffer) return 'already_offered'
  if (!offerStillNeeded(block)) return 'staffed'
  return null
}

/** The manager's one-line state of an open offer (GET ?view=manage row). */
export function offerStateLabel(offer) {
  const base = 'Offered to the team'
  const n = Number(offer?.broadcast_count) || 0
  switch (offer?.notice_state) {
    case 'sent': return `${base} · sent to ${n} ${n === 1 ? 'coach' : 'coaches'}`
    case 'nobody': return `${base} · nobody is free to ask`
    case 'sending': return `${base} · telling coaches now`
    case 'morning': return `${base} · coaches are told from 7am`
    case 'failed': return `${base} · the notification couldn't be sent`
    default: return base
  }
}

function dayLabel(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return ''
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[mo - 1]}`
}
const hhmm = (t) => (/^\d{2}:\d{2}/.test(String(t ?? '')) ? String(t).slice(0, 5) : '')

/** A coach card's when-line: 'Tue 29 Sep · 06:00-07:00'. */
export function offerWhenLine(offer) {
  const day = dayLabel(offer?.block_date)
  const s = hhmm(offer?.start_time)
  const e = hhmm(offer?.end_time)
  const times = s && e ? `${s}-${e}` : ''
  return [day, times].filter(Boolean).join(' · ')
}

/** GET ?view=manage rows keyed by block_id. */
export function indexOffersByBlock(rows) {
  const out = {}
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.block_id) out[r.block_id] = r
  }
  return out
}

/** Words after POST /blocks/[id]/offer. status 0 = no answer. */
export function offerPostResultText(status, body) {
  if (status >= 200 && status < 300 && body?.success === true) {
    return body?.data?.notice === 'morning'
      ? { tone: 'warning', text: 'Offered to the team. Coaches see it on Today now and get a notification from 7am.' }
      : { tone: 'success', text: 'Offered to the team. Coaches who are free are being told now.' }
  }
  return { tone: 'error', text: body?.error || 'Could not offer the shift.' }
}

/** Words after POST /offers/[id]/claim. */
export function offerClaimResultText(status, body) {
  if (status >= 200 && status < 300 && body?.success === true) {
    return { tone: 'success', text: "It's yours. It is on your roster now." }
  }
  return { tone: 'error', text: body?.error || 'Could not claim the shift.' }
}
```

- [ ] **Step 4: Run, expect pass**, both zones:

```bash
npx vitest run shared/offer-to-team.test.js
TZ=America/Los_Angeles npx vitest run shared/offer-to-team.test.js
npx vitest run tests/shared-pair-sync.test.js
```
Expected: `0 failed`. No `src/lib/offer-to-team.js` exists, so the pair-sync manifest needs no entry.

- [ ] **Step 5: Commit.**

```bash
git add shared/offer-to-team.js shared/offer-to-team.test.js
git commit -m "REPLACE.1b — shared/offer-to-team.js: what may be offered, the target count, the words (OTA)

One rule for the web button, the phone button and the route: published, today
or later, not started, no open offer, still needed (class: min, at least 1;
admin: 1, so only while empty).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1b-3: `src/lib/shift-offer-notice.js` — who, when, and what is said

**Files:** Modify `src/lib/swap-cover.js` (export `isHalfDayLeave`). Create `src/lib/shift-offer-notice.js`, `src/lib/shift-offer-notice.test.js`.

- [ ] **Step 1:** In `src/lib/swap-cover.js` line 81, change `function isHalfDayLeave(t) {` to `export function isHalfDayLeave(t) {` and add one line to its comment: `// Exported for REPLACE.1b (the offer audience applies the same half-day rule).`

- [ ] **Step 2: Write the failing test.**

```js
// src/lib/shift-offer-notice.test.js
// REPLACE.1b — default 6 (who an offer goes to), the claim check, the sweep's
// decision for one offer, and the words.
import { describe, it, expect } from 'vitest'
import {
  offerEligibility, offerAudience, offerClaimRefusal, offerSweepAction, offerNoticeState,
  offerBroadcastPayload, offerTakenPayload, offerNoticeKey, offerClaimRpcError, coachOfferRow, managerOfferRow,
  OFFER_MAX_ATTEMPTS,
} from './shift-offer-notice'

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [],
}
const member = (id, over = {}) => ({ profile_id: id, location_id: 'loc-1', role: 'staff', profiles: { id, active: true, deleted_at: null }, ...over })
const FACTS = {
  members: [member('mgr', { role: 'manager' }), member('c1'), member('c2'), member('c3'), member('c4'), member('c5'), member('gone', { profiles: { id: 'gone', active: false } })],
  orgLocationIds: ['loc-1', 'loc-2'],
  liveOnBlockIds: ['c5'],
  timeOff: [
    { profile_id: 'c2', status: 'approved', type: 'holiday', start_date: '2026-09-28', end_date: '2026-09-30', total_days: '3' },
    { profile_id: 'c3', status: 'approved', type: 'other', start_date: '2026-09-29', end_date: '2026-09-29', total_days: '0.5' },
  ],
  assignments: [
    { id: 'x1', profile_id: 'c3', block_id: 'b9', status: 'scheduled', shift_blocks: { id: 'b9', location_id: 'loc-2', block_date: '2026-09-29', start_time: '06:30:00', end_time: '08:00:00' } },
    { id: 'x2', profile_id: 'c1', block_id: 'b8', status: 'scheduled', shift_blocks: { id: 'b8', location_id: 'loc-OTHER-ORG', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00' } },
  ],
  unavailability: [{ profile_id: 'c4', kind: 'weekly', weekday: 'tue', all_day: false, start_time: '05:00', end_time: '09:00' }],
}

describe('offerEligibility — default 6, one predicate', () => {
  const ask = (id) => offerEligibility(id, FACTS, BLOCK)
  it('a free member is eligible; managers are coaches too', () => {
    expect(ask('c1')).toEqual({ eligible: true, reasons: [] })
    expect(ask('mgr').eligible).toBe(true)
  })
  it('each reason, on its own', () => {
    expect(ask('c2').reasons).toEqual(['leave'])        // whole-day approved leave
    expect(ask('c3').reasons).toEqual(['overlap'])      // half-day leave passes; the other studio's shift does not
    expect(ask('c4').reasons).toEqual(['unavailable'])  // AVAIL: Tuesdays 5-9
    expect(ask('c5').reasons).toEqual(['on_block'])
    expect(ask('gone').reasons).toEqual(['inactive'])
    expect(ask('stranger').reasons).toEqual(['not_member'])
  })
  it('a shift at a studio OUTSIDE the organisation is never read as a clash (tenancy re-check)', () => {
    expect(ask('c1').reasons).not.toContain('overlap')
  })
  it('unreadable availability (null) is not a reason', () => {
    expect(offerEligibility('c4', { ...FACTS, unavailability: null }, BLOCK).eligible).toBe(true)
  })
})

describe('offerAudience', () => {
  it('every eligible member except the poster, once each, in member order', () => {
    expect(offerAudience(FACTS, BLOCK, 'mgr')).toEqual(['c1'])
    expect(offerAudience({ ...FACTS, members: [...FACTS.members, member('c1')] }, BLOCK, 'nobody')).toEqual(['mgr', 'c1'])
  })
  it('only members of THIS studio', () => {
    expect(offerAudience({ ...FACTS, members: [member('c9', { location_id: 'loc-2' })] }, BLOCK, 'mgr')).toEqual([])
  })
})

describe('offerClaimRefusal — what blocks a claim (unavailability does NOT: claiming says you are free)', () => {
  it('maps the first blocking reason', () => {
    expect(offerClaimRefusal([])).toBeNull()
    expect(offerClaimRefusal(['unavailable'])).toBeNull()
    expect(offerClaimRefusal(['leave'])).toEqual({ status: 409, code: 'leave', error: "You're on approved leave that day, so you can't take this shift." })
    expect(offerClaimRefusal(['overlap']).error).toBe("You're already on another shift at that time.")
    expect(offerClaimRefusal(['on_block']).status).toBe(409)
    expect(offerClaimRefusal(['not_member']).status).toBe(403)
    expect(offerClaimRefusal(['inactive']).status).toBe(403)
  })
})

// Tue 29 Sep 2026 06:00 Dublin = 05:00Z.
const TZ = 'Europe/Dublin'
const IN_BAND = Date.parse('2026-09-28T10:00:00Z')
const QUIET = Date.parse('2026-09-28T22:30:00Z')
const open = (over = {}) => ({ id: 'o1', status: 'open', broadcast_at: null, notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK, ...over })

describe('offerSweepAction', () => {
  it('open and owed a broadcast: notify in band, wait in quiet hours', () => {
    expect(offerSweepAction(open(), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'notify', kind: 'broadcast' })
    expect(offerSweepAction(open(), { nowMs: QUIET, tz: TZ })).toEqual({ action: 'none', reason: 'quiet_hours' })
  })
  it('closes: started = expired, left a published roster = expired, got its coach = filled (at ANY hour)', () => {
    expect(offerSweepAction(open(), { nowMs: Date.parse('2026-09-29T05:00:00Z'), tz: TZ })).toEqual({ action: 'close', status: 'expired' })
    expect(offerSweepAction(open({ shift_blocks: { ...BLOCK, rosters: { status: 'superseded' } } }), { nowMs: QUIET, tz: TZ })).toEqual({ action: 'close', status: 'expired' })
    expect(offerSweepAction(open({ shift_blocks: { ...BLOCK, shift_assignments: [{ profile_id: 'c1', status: 'scheduled' }] } }), { nowMs: QUIET, tz: TZ })).toEqual({ action: 'close', status: 'filled' })
    expect(offerSweepAction(open({ shift_blocks: null }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'close', status: 'expired' })
  })
  it('a live lease waits; too many attempts gives up', () => {
    expect(offerSweepAction(open({ notice_lease_until: '2026-09-28T10:05:00Z' }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none', reason: 'leased' })
    expect(offerSweepAction(open({ notice_lease_until: '2026-09-28T09:55:00Z' }), { nowMs: IN_BAND, tz: TZ }).action).toBe('notify')
    expect(offerSweepAction(open({ notice_attempts: OFFER_MAX_ATTEMPTS }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'give_up', kind: 'broadcast' })
  })
  it('already broadcast: nothing', () => {
    expect(offerSweepAction(open({ broadcast_at: '2026-09-28T09:00:00Z' }), { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none' })
  })
  it('claimed and the managers not yet told: notify taken in band; past 24 h gives up', () => {
    const claimed = { id: 'o1', status: 'claimed', claimed_at: '2026-09-28T09:00:00Z', taken_notified_at: null, notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK }
    expect(offerSweepAction(claimed, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'notify', kind: 'taken' })
    expect(offerSweepAction(claimed, { nowMs: QUIET, tz: TZ })).toEqual({ action: 'none', reason: 'quiet_hours' })
    expect(offerSweepAction({ ...claimed, claimed_at: '2026-09-27T09:00:00Z' }, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'give_up', kind: 'taken' })
    expect(offerSweepAction({ ...claimed, taken_notified_at: '2026-09-28T09:01:00Z' }, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none' })
  })
  it('withdrawn / expired / filled: nothing', () => {
    for (const status of ['withdrawn', 'expired', 'filled']) expect(offerSweepAction({ status }, { nowMs: IN_BAND, tz: TZ })).toEqual({ action: 'none' })
  })
})

describe('offerNoticeState (manager view)', () => {
  it('reads the broadcast columns and the band', () => {
    expect(offerNoticeState({ broadcast_at: 'x', broadcast_count: 3, broadcast_outcome: 'sent' }, { nowMs: IN_BAND, tz: TZ })).toBe('sent')
    expect(offerNoticeState({ broadcast_at: 'x', broadcast_count: 0, broadcast_outcome: 'no_recipients' }, { nowMs: IN_BAND, tz: TZ })).toBe('nobody')
    expect(offerNoticeState({ broadcast_at: 'x', broadcast_outcome: 'gave_up' }, { nowMs: IN_BAND, tz: TZ })).toBe('failed')
    expect(offerNoticeState({ broadcast_at: null }, { nowMs: IN_BAND, tz: TZ })).toBe('sending')
    expect(offerNoticeState({ broadcast_at: null }, { nowMs: QUIET, tz: TZ })).toBe('morning')
  })
})

describe('payloads and keys', () => {
  it('the broadcast: shift, when, studio; category swap; tap opens the Dashboard', () => {
    expect(offerBroadcastPayload({ offer: { id: 'o1' }, block: BLOCK, studioName: 'Studio North' })).toEqual({
      title: 'A shift is up for grabs',
      body: 'Morning, Tue 29 Sep, 06:00 to 07:00 at Studio North. First to claim it gets it. Tap to take it.',
      category: 'swap',
      emailSubject: 'A shift is up for grabs at Studio North: Tue 29 Sep, 06:00 to 07:00',
      data: { type: 'shift_offer', offer_id: 'o1', block_date: '2026-09-29' },
    })
  })
  it('taken: who and which shift; tap opens Manage mode on that day', () => {
    expect(offerTakenPayload({ offer: { id: 'o1' }, block: BLOCK, claimerName: 'Coach B' })).toEqual({
      title: 'Offered shift taken',
      body: 'Coach B took Morning, Tue 29 Sep, 06:00 to 07:00.',
      category: 'swap',
      emailSubject: 'Coach B took the offered shift: Tue 29 Sep, 06:00 to 07:00',
      data: { type: 'shift_offer_taken', offer_id: 'o1', block_date: '2026-09-29' },
    })
    expect(offerTakenPayload({ offer: { id: 'o1' }, block: BLOCK, claimerName: null }).body).toMatch(/^A coach took/)
  })
  it('the ledger key is numbered by the attempt (a crash re-sends under a NEW key)', () => {
    expect(offerNoticeKey('broadcast', 'o1', 1)).toBe('shift_offer_broadcast:o1:a1')
    expect(offerNoticeKey('taken', 'o1', 2)).toBe('shift_offer_taken:o1:a2')
  })
})

describe('offerClaimRpcError', () => {
  const e = (message, code = 'P0001') => ({ code, message })
  it('maps each prefix', () => {
    expect(offerClaimRpcError(e('offer_not_open: offer is already claimed'))).toEqual({ status: 409, error: 'Someone else has just taken this shift.' })
    expect(offerClaimRpcError(e('offer_not_open: offer is already withdrawn'))).toEqual({ status: 409, error: 'This shift is no longer on offer.' })
    expect(offerClaimRpcError(e('offer_not_found: x')).status).toBe(404)
    expect(offerClaimRpcError(e('offer_not_published: x')).status).toBe(409)
    expect(offerClaimRpcError(e('offer_not_eligible: x')).status).toBe(403)
    expect(offerClaimRpcError(e('offer_already_on: x'))).toEqual({ status: 409, error: 'You are already on this shift.' })
    expect(offerClaimRpcError(e('dup', '23505'))).toEqual({ status: 409, error: 'You are already on this shift.' })
    expect(offerClaimRpcError(e('boom', 'XX000'))).toEqual({ status: 500, error: 'Could not claim the shift.' })
  })
})

describe('API rows', () => {
  const row = { id: 'o1', block_id: 'b1', location_id: 'loc-1', created_at: 'c', broadcast_at: null, broadcast_count: null, broadcast_outcome: null, shift_blocks: BLOCK, locations: { name: 'Studio North', timezone: TZ } }
  it('a coach sees when, what and where: never counts or minimums', () => {
    expect(coachOfferRow(row)).toEqual({ id: 'o1', block_id: 'b1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning', studio_name: 'Studio North' })
  })
  it('a manager sees the notice state', () => {
    expect(managerOfferRow(row, { nowMs: QUIET })).toEqual({ id: 'o1', block_id: 'b1', block_date: '2026-09-29', created_at: 'c', notice_state: 'morning', broadcast_count: 0 })
  })
})
```

- [ ] **Step 3: Run, expect failure** (module missing).

- [ ] **Step 4: Implement.**

```js
// src/lib/shift-offer-notice.js
//
// REPLACE.1b — the PURE half of "Offer to team" on the server: who an offer
// goes to (default 6), what blocks a claim, what the */5 sweep does with one
// offer, and every word the pushes say. The DB half is ./shift-offer-server.js;
// what may be offered at all is shared/offer-to-team.js.
//
// Default 6 (scheduler Wave 2 index): studio members who are free at that time
// across the organisation's studios, not on approved leave, not unavailable.
// ONE predicate (offerEligibility) decides the push audience, the coach's list
// and, minus 'unavailable', the claim. Each fact reuses the rule that already
// decides it elsewhere: leave and clashes are evaluateSwapMoveConflicts (the
// swap claim warning and the approval check), half-day leave passes as in the
// open pool (isHalfDayLeave), availability is AVAIL.1a's unavailableFor.

import { evaluateSwapMoveConflicts } from './swap-lifecycle'
import { isHalfDayLeave, shiftWhenLabel, swapShiftHasStarted } from './swap-cover'
import { inStaffPushHours } from './staff-push-hours'
import { unavailableFor } from '@shared/availability'
import { offerStillNeeded } from '@shared/offer-to-team'

export const OFFER_NOTICE_LEASE_MS = 10 * 60 * 1000
export const OFFER_MAX_ATTEMPTS = 5
export const OFFER_TAKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Is `profileId` eligible for this shift? Pure.
 * @param {string} profileId
 * @param {object} facts  readOfferFacts: { members, orgLocationIds, liveOnBlockIds, timeOff, assignments, unavailability }
 *   unavailability: null when it was not read (then it is not a reason).
 * @param {object} block  shift_blocks row: id, location_id, block_date, start_time, end_time
 * @returns {{ eligible: boolean, reasons: string[] }}
 *   reasons ⊆ not_member | inactive | on_block | leave | overlap | unavailable
 */
export function offerEligibility(profileId, facts, block) {
  const reasons = []
  const link = (facts?.members || []).find((m) => m?.profile_id === profileId && m.location_id === block?.location_id)
  if (!link) reasons.push('not_member')
  else if (link.profiles?.active === false || link.profiles?.deleted_at) reasons.push('inactive')
  if ((facts?.liveOnBlockIds || []).includes(profileId)) reasons.push('on_block')

  // Tenancy: a row is only USED if its studio is in this organisation (the
  // DB half never reads outside it; this is the belt to that brace).
  const org = new Set([block?.location_id, ...(facts?.orgLocationIds || [])])
  const assignments = (facts?.assignments || []).filter((a) => a && org.has(a.shift_blocks?.location_id))
  const wholeDay = (facts?.timeOff || []).filter((t) => t && !isHalfDayLeave(t))
  const move = { role: 'taker', coachId: profileId, block, leavingAssignmentId: null }
  for (const c of evaluateSwapMoveConflicts(move, { timeOff: wholeDay, assignments })) {
    if (!reasons.includes(c.kind)) reasons.push(c.kind)
  }

  if (Array.isArray(facts?.unavailability)) {
    const mine = facts.unavailability.filter((r) => r?.profile_id === profileId)
    if (unavailableFor(mine, block?.block_date, block?.start_time, block?.end_time)) reasons.push('unavailable')
  }
  return { eligible: reasons.length === 0, reasons }
}

/** Every eligible member of the shift's studio except the poster, once each, in member order. */
export function offerAudience(facts, block, posterId) {
  const out = []
  const seen = new Set()
  for (const m of facts?.members || []) {
    const id = m?.profile_id
    if (!id || seen.has(id) || m.location_id !== block?.location_id) continue
    seen.add(id)
    if (id === posterId) continue
    if (offerEligibility(id, facts, block).eligible) out.push(id)
  }
  return out
}

// What blocks a CLAIM, first match wins. 'unavailable' is not here: a coach
// claiming is telling us they are free.
const CLAIM_BLOCKERS = [
  ['not_member', 403, 'You are not on the staff of this studio.'],
  ['inactive', 403, 'You are not on the staff of this studio.'],
  ['on_block', 409, 'You are already on this shift.'],
  ['leave', 409, "You're on approved leave that day, so you can't take this shift."],
  ['overlap', 409, "You're already on another shift at that time."],
]

export function offerClaimRefusal(reasons) {
  for (const [code, status, error] of CLAIM_BLOCKERS) {
    if ((reasons || []).includes(code)) return { status, code, error }
  }
  return null
}

function noticeStep(offer, kind, nowMs, tz) {
  if ((offer.notice_attempts || 0) >= OFFER_MAX_ATTEMPTS) return { action: 'give_up', kind }
  const leaseMs = Date.parse(offer.notice_lease_until)
  if (Number.isFinite(leaseMs) && leaseMs > nowMs) return { action: 'none', reason: 'leased' }
  if (!inStaffPushHours(nowMs, tz)) return { action: 'none', reason: 'quiet_hours' }
  return { action: 'notify', kind }
}

/**
 * What the sweep (or the route's after()) does with ONE offer right now. Pure.
 * Closing is STATE and happens at any hour; a notice is a MESSAGE and waits
 * for 07:00-22:00 studio time.
 *
 * @param {object} offer  OFFER_SELECT row (shift_blocks embed with rosters,
 *   shift_templates.kind, min/max, shift_assignments)
 * @param {{ nowMs: number, tz: string|null }} opts  tz = the studio's locations.timezone
 * @returns {{action:'none', reason?:string} | {action:'close', status:'expired'|'filled'}
 *   | {action:'notify'|'give_up', kind:'broadcast'|'taken'}}
 */
export function offerSweepAction(offer, { nowMs, tz }) {
  if (offer?.status === 'open') {
    const b = offer.shift_blocks
    if (!b) return { action: 'close', status: 'expired' }
    if (swapShiftHasStarted({ block_date: b.block_date, start_time: b.start_time }, nowMs, tz)) return { action: 'close', status: 'expired' }
    if (b.rosters?.status !== 'published') return { action: 'close', status: 'expired' }
    if (!offerStillNeeded(b)) return { action: 'close', status: 'filled' }
    if (offer.broadcast_at) return { action: 'none' }
    return noticeStep(offer, 'broadcast', nowMs, tz)
  }
  if (offer?.status === 'claimed' && !offer.taken_notified_at) {
    const claimedMs = Date.parse(offer.claimed_at)
    if (!Number.isFinite(claimedMs) || nowMs - claimedMs > OFFER_TAKEN_MAX_AGE_MS) return { action: 'give_up', kind: 'taken' }
    return noticeStep(offer, 'taken', nowMs, tz)
  }
  return { action: 'none' }
}

/** The manager view's notice state of an OPEN offer (shared/offer-to-team.js offerStateLabel words it). */
export function offerNoticeState(offer, { nowMs, tz }) {
  if (offer?.broadcast_outcome === 'gave_up') return 'failed'
  if (offer?.broadcast_at) return offer.broadcast_outcome === 'no_recipients' || !(Number(offer.broadcast_count) > 0) ? 'nobody' : 'sent'
  return inStaffPushHours(nowMs, tz) ? 'sending' : 'morning'
}

const STUDIO_NAME_MAX = 30
const shortStudio = (n) => {
  const s = String(n ?? '').trim()
  return s.length <= STUDIO_NAME_MAX ? s : `${s.slice(0, STUDIO_NAME_MAX).trimEnd()}…`
}
const whatWhen = (block) => {
  const when = shiftWhenLabel(block)
  const name = block?.shift_templates?.name
  return name ? `${name}, ${when}` : when
}

export function offerBroadcastPayload({ offer, block, studioName }) {
  const studio = shortStudio(studioName)
  const at = studio ? ` at ${studio}` : ''
  return {
    title: 'A shift is up for grabs',
    body: `${whatWhen(block)}${at}. First to claim it gets it. Tap to take it.`,
    category: 'swap',
    emailSubject: `A shift is up for grabs${at}: ${shiftWhenLabel(block)}`,
    data: { type: 'shift_offer', offer_id: offer.id, block_date: block?.block_date ?? null },
  }
}

export function offerTakenPayload({ offer, block, claimerName }) {
  const who = claimerName || 'A coach'
  return {
    title: 'Offered shift taken',
    body: `${who} took ${whatWhen(block)}.`,
    category: 'swap',
    emailSubject: `${who} took the offered shift: ${shiftWhenLabel(block)}`,
    data: { type: 'shift_offer_taken', offer_id: offer.id, block_date: block?.block_date ?? null },
  }
}

/** push_event_sends key, numbered by attempt: a crashed attempt's claim never dedups the retry. */
export const offerNoticeKey = (kind, offerId, attempt) => `shift_offer_${kind}:${offerId}:a${attempt}`

/** claim_shift_offer error -> { status, error }. */
export function offerClaimRpcError(err) {
  if (err?.code === '23505') return { status: 409, error: 'You are already on this shift.' }
  const msg = String(err?.message || '')
  const prefix = msg.split(':')[0]
  switch (prefix) {
    case 'offer_not_open':
      return { status: 409, error: /claimed/.test(msg) ? 'Someone else has just taken this shift.' : 'This shift is no longer on offer.' }
    case 'offer_not_found': return { status: 404, error: 'Offer not found' }
    case 'offer_not_published': return { status: 409, error: 'This shift is no longer on offer.' }
    case 'offer_not_eligible': return { status: 403, error: 'You are not on the staff of this studio.' }
    case 'offer_already_on': return { status: 409, error: 'You are already on this shift.' }
    default: return { status: 500, error: 'Could not claim the shift.' }
  }
}

/** A coach's list row: when, what, where. No counts, no minimums (COACHSCOPE.1). */
export function coachOfferRow(offer) {
  const b = offer.shift_blocks || {}
  return {
    id: offer.id,
    block_id: offer.block_id,
    block_date: b.block_date ?? null,
    start_time: b.start_time ?? null,
    end_time: b.end_time ?? null,
    shift_name: b.shift_templates?.name ?? null,
    studio_name: offer.locations?.name ?? null,
  }
}

/** A manager's list row. */
export function managerOfferRow(offer, { nowMs }) {
  return {
    id: offer.id,
    block_id: offer.block_id,
    block_date: offer.shift_blocks?.block_date ?? null,
    created_at: offer.created_at ?? null,
    notice_state: offerNoticeState(offer, { nowMs, tz: offer.locations?.timezone ?? null }),
    broadcast_count: Number(offer.broadcast_count) || 0,
  }
}
```

- [ ] **Step 5: Run, expect pass**, both zones:

```bash
npx vitest run src/lib/shift-offer-notice.test.js src/lib/swap-cover.test.js
TZ=America/Los_Angeles npx vitest run src/lib/shift-offer-notice.test.js
```
Expected: `0 failed`.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/swap-cover.js src/lib/shift-offer-notice.js src/lib/shift-offer-notice.test.js
git commit -m "REPLACE.1b — shift-offer-notice.js: default 6 as one predicate, the claim check, the sweep decision, the words

Eligibility reuses evaluateSwapMoveConflicts (leave, clash in the org), the open
pool's half-day rule and AVAIL's unavailableFor. Closing is state (any hour);
notices wait for 07:00-22:00 and lease with attempt-numbered keys.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1b-4: `src/lib/shift-offer-server.js` — reads, the leased sender, the sweep

**Files:** Create `src/lib/shift-offer-server.js`, `src/lib/shift-offer-server.test.js`.

- [ ] **Step 1: Write the failing test.**

```js
// src/lib/shift-offer-server.test.js
// REPLACE.1b — the DB half: facts for default 6, the leased sender (never
// loses a notice, duplicates at worst), closing, the */5 sweep.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scriptedDb, chainsFor, argsOf, allArgsOf } from './scripted-db.test-helpers'

vi.mock('./push-dedup', () => ({ notifyUsersOnce: vi.fn(async () => ({ sent: 1, emailed: 0, failed: 0 })) }))
vi.mock('./push', () => ({ resolveRoleRecipientIds: vi.fn(async () => ['mgr', 'c1']) }))
vi.mock('./sibling-locations', () => ({ siblingLocationIds: vi.fn(async () => ({ ids: ['loc-2'], error: null })) }))
vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const { notifyUsersOnce } = await import('./push-dedup')
const { siblingLocationIds } = await import('./sibling-locations')
const { logError } = await import('./log')
const { readOfferFacts, processOffer, runShiftOfferSweep, createOffer, withdrawOffer } = await import('./shift-offer-server')

const BLOCK = {
  id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00',
  min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { name: 'Morning', kind: 'class' }, shift_assignments: [],
}
const IN_BAND = Date.parse('2026-09-28T10:00:00Z')
const QUIET = Date.parse('2026-09-28T22:30:00Z')
const OFFER = {
  id: 'o1', location_id: 'loc-1', block_id: 'b1', status: 'open', offered_by: 'mgr', broadcast_at: null,
  notice_attempts: 0, notice_lease_until: null, shift_blocks: BLOCK, locations: { name: 'Studio North', timezone: 'Europe/Dublin' },
}
const MEMBERS = { data: [
  { profile_id: 'mgr', location_id: 'loc-1', role: 'manager', profiles: { id: 'mgr', active: true } },
  { profile_id: 'c1', location_id: 'loc-1', role: 'staff', profiles: { id: 'c1', active: true } },
  { profile_id: 'c2', location_id: 'loc-1', role: 'staff', profiles: { id: 'c2', active: true } },
], error: null }
const FACT_READS = {
  profile_locations: [MEMBERS],
  time_off_requests: [{ data: [{ profile_id: 'c2', status: 'approved', start_date: '2026-09-29', end_date: '2026-09-29', total_days: '1' }], error: null }],
  shift_assignments: [{ data: [], error: null }],
  staff_unavailability: [{ data: [], error: null }],
}
const ok = { data: [{ id: 'o1' }], error: null }

beforeEach(() => {
  vi.clearAllMocks()
  notifyUsersOnce.mockResolvedValue({ sent: 1, emailed: 0, failed: 0 })
  siblingLocationIds.mockResolvedValue({ ids: ['loc-2'], error: null })
})

describe('readOfferFacts', () => {
  it('members of the shift\'s studio; leave, that day\'s shifts in the ORG, availability for them', async () => {
    const db = scriptedDb(FACT_READS)
    const facts = await readOfferFacts(db, { block: BLOCK })
    expect(facts.error).toBeNull()
    expect(facts.orgLocationIds).toEqual(['loc-1', 'loc-2'])
    expect(facts.members.map((m) => m.profile_id)).toEqual(['mgr', 'c1', 'c2'])
    const [sa] = chainsFor(db, 'shift_assignments')
    expect(argsOf(sa, 'in')).toEqual(['profile_id', ['mgr', 'c1', 'c2']])
    expect(allArgsOf(sa, 'in')[1]).toEqual(['shift_blocks.location_id', ['loc-1', 'loc-2']])
    expect(argsOf(sa, 'eq')).toEqual(['shift_blocks.block_date', '2026-09-29'])
    const [un] = chainsFor(db, 'staff_unavailability')
    expect(argsOf(un, 'or')).toEqual(['kind.eq.weekly,and(start_date.lte.2026-09-29,end_date.gte.2026-09-29)'])
  })
  it('narrowed to given people (the coach view and the claim read only the caller)', async () => {
    const db = scriptedDb({ ...FACT_READS, profile_locations: [{ data: [MEMBERS.data[1]], error: null }] })
    await readOfferFacts(db, { block: BLOCK, profileIds: ['c1'] })
    expect(allArgsOf(chainsFor(db, 'profile_locations')[0], 'in')).toEqual([['profile_id', ['c1']]])
  })
  it('any failed read is an error, never "nobody is busy" (an unreadable org is too)', async () => {
    const db = scriptedDb({ ...FACT_READS, time_off_requests: [{ data: null, error: { message: 'down' } }] })
    expect((await readOfferFacts(db, { block: BLOCK })).error).toEqual({ message: 'down' })
    siblingLocationIds.mockResolvedValue({ ids: [], error: { message: 'x' } })
    expect((await readOfferFacts(scriptedDb(FACT_READS), { block: BLOCK })).error).toEqual({ message: 'x' })
  })
})

describe('processOffer — the broadcast', () => {
  it('lease (guarded), audience, send under the attempt key, stamp (guarded on the attempt)', async () => {
    const db = scriptedDb({ shift_offers: [ok, ok], ...FACT_READS })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    const [lease, stamp] = chainsFor(db, 'shift_offers')
    expect(argsOf(lease, 'update')[0]).toEqual({ notice_lease_until: '2026-09-28T10:10:00.000Z', notice_attempts: 1 })
    expect(allArgsOf(lease, 'eq')).toEqual([['id', 'o1'], ['status', 'open'], ['notice_attempts', 0]])
    expect(argsOf(lease, 'or')).toEqual(['notice_lease_until.is.null,notice_lease_until.lt.2026-09-28T10:00:00.000Z'])
    // c2 is on leave, mgr posted it: only c1.
    expect(notifyUsersOnce).toHaveBeenCalledWith(db, 'shift_offer_broadcast:o1:a1', ['c1'], expect.objectContaining({ category: 'swap', data: expect.objectContaining({ type: 'shift_offer' }) }))
    expect(argsOf(stamp, 'update')[0]).toEqual({ broadcast_at: '2026-09-28T10:00:00.000Z', broadcast_count: 1, broadcast_outcome: 'sent', notice_lease_until: null })
    expect(allArgsOf(stamp, 'eq')).toEqual([['id', 'o1'], ['notice_attempts', 1]])
  })
  it('someone else holds the lease: nothing is sent', async () => {
    const db = scriptedDb({ shift_offers: [{ data: [], error: null }] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('busy')
    expect(notifyUsersOnce).not.toHaveBeenCalled()
  })
  it('quiet hours: no write at all', async () => {
    const db = scriptedDb({})
    expect(await processOffer(db, OFFER, { nowMs: QUIET })).toBe('quiet_hours')
  })
  it('an unreadable fact releases the lease and sends nothing (retried next tick)', async () => {
    const db = scriptedDb({ shift_offers: [ok, ok], ...FACT_READS, time_off_requests: [{ data: null, error: { message: 'down' } }] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('retry')
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    const release = chainsFor(db, 'shift_offers')[1]
    expect(argsOf(release, 'update')[0]).toEqual({ notice_lease_until: null })
    expect(allArgsOf(release, 'eq')).toEqual([['id', 'o1'], ['notice_attempts', 1]])
  })
  it('a send that failed outright releases the lease; a partial one stamps', async () => {
    notifyUsersOnce.mockResolvedValueOnce({ sent: 0, emailed: 0, failed: 1 })
    const db = scriptedDb({ shift_offers: [ok, ok], ...FACT_READS })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('retry')
    expect(argsOf(chainsFor(db, 'shift_offers')[1], 'update')[0]).toEqual({ notice_lease_until: null })
  })
  it('nobody eligible: stamped no_recipients, count 0, nothing sent', async () => {
    const db = scriptedDb({ shift_offers: [ok, ok], ...FACT_READS, profile_locations: [{ data: [MEMBERS.data[0]], error: null }] })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    expect(notifyUsersOnce).not.toHaveBeenCalled()
    expect(argsOf(chainsFor(db, 'shift_offers')[1], 'update')[0]).toMatchObject({ broadcast_count: 0, broadcast_outcome: 'no_recipients' })
  })
  it('a lost stamp is logged; the expired lease re-sends under a NEW key (duplicate, never loss)', async () => {
    const db = scriptedDb({ shift_offers: [ok, { data: null, error: { message: 'stamp failed' } }], ...FACT_READS })
    expect(await processOffer(db, OFFER, { nowMs: IN_BAND })).toBe('sent')
    expect(logError).toHaveBeenCalledWith('shift-offer', expect.stringMatching(/stamp/), expect.anything())
  })
  it('too many attempts: gives up loudly, stamped gave_up', async () => {
    const db = scriptedDb({ shift_offers: [ok] })
    expect(await processOffer(db, { ...OFFER, notice_attempts: 5 }, { nowMs: IN_BAND })).toBe('gave_up')
    expect(argsOf(chainsFor(db, 'shift_offers')[0], 'update')[0]).toEqual({ broadcast_at: '2026-09-28T10:00:00.000Z', broadcast_outcome: 'gave_up', notice_lease_until: null })
    expect(logError).toHaveBeenCalled()
  })
})

describe('processOffer — closing and the taken notice', () => {
  it('a started shift closes as expired, guarded on still open, at any hour', async () => {
    const db = scriptedDb({ shift_offers: [ok] })
    expect(await processOffer(db, OFFER, { nowMs: Date.parse('2026-09-29T05:00:00Z') })).toBe('expired')
    const [c] = chainsFor(db, 'shift_offers')
    expect(argsOf(c, 'update')[0]).toEqual({ status: 'expired', closed_at: '2026-09-29T05:00:00.000Z', notice_lease_until: null })
    expect(allArgsOf(c, 'eq')).toEqual([['id', 'o1'], ['status', 'open']])
  })
  it('a close that lost the race reports raced', async () => {
    const db = scriptedDb({ shift_offers: [{ data: [], error: null }] })
    expect(await processOffer(db, { ...OFFER, shift_blocks: { ...BLOCK, shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] } }, { nowMs: QUIET })).toBe('raced')
  })
  it('claimed: the studio\'s managers minus the claimant, taken payload, stamped taken_notified_at', async () => {
    const claimed = { ...OFFER, status: 'claimed', claimed_by: 'c1', claimed_at: '2026-09-28T09:59:00Z', taken_notified_at: null, claimer: { full_name: 'Coach B' } }
    const db = scriptedDb({ shift_offers: [ok, ok] })
    expect(await processOffer(db, claimed, { nowMs: IN_BAND })).toBe('sent')
    expect(notifyUsersOnce).toHaveBeenCalledWith(db, 'shift_offer_taken:o1:a1', ['mgr'], expect.objectContaining({ title: 'Offered shift taken' }))
    expect(allArgsOf(chainsFor(db, 'shift_offers')[0], 'eq')).toEqual([['id', 'o1'], ['status', 'claimed'], ['notice_attempts', 0]])
    expect(argsOf(chainsFor(db, 'shift_offers')[1], 'update')[0]).toEqual({ taken_notified_at: '2026-09-28T10:00:00.000Z', notice_lease_until: null })
  })
})

describe('runShiftOfferSweep', () => {
  it('open offers and claimed ones owed a notice; each processed; counts by outcome', async () => {
    const db = scriptedDb({
      shift_offers: [
        { data: [OFFER, { ...OFFER, id: 'o2', broadcast_at: 'x' }], error: null },
        { data: [], error: null },
        ok, ok,
      ],
      ...FACT_READS,
    })
    const stats = await runShiftOfferSweep(db, { nowMs: IN_BAND })
    expect(stats).toMatchObject({ open: 2, claimed_owed: 0, sent: 1, none: 1, errors: 0 })
    const [openRead, owedRead] = chainsFor(db, 'shift_offers')
    expect(argsOf(openRead, 'eq')).toEqual(['status', 'open'])
    expect(allArgsOf(owedRead, 'eq')).toEqual([['status', 'claimed']])
    expect(argsOf(owedRead, 'is')).toEqual(['taken_notified_at', null])
    expect(argsOf(owedRead, 'gte')).toEqual(['claimed_at', '2026-09-27T10:00:00.000Z'])
  })
  it('an unreadable list is an error (the heartbeat is not stamped)', async () => {
    const db = scriptedDb({ shift_offers: [{ data: null, error: { message: 'down' } }, { data: [], error: null }] })
    expect((await runShiftOfferSweep(db, { nowMs: IN_BAND })).errors).toBe(1)
  })
  it('one offer throwing costs the others nothing', async () => {
    const db = scriptedDb({ shift_offers: [{ data: [OFFER, { ...OFFER, id: 'o2' }], error: null }, { data: [], error: null }, { data: null, error: { message: 'lease write failed' } }, { data: [], error: null }] })
    const stats = await runShiftOfferSweep(db, { nowMs: IN_BAND })
    expect(stats.errors).toBe(1)
    expect(stats.busy).toBe(1)
  })
})

describe('createOffer / withdrawOffer', () => {
  it('create inserts location, shift and poster; 23505 = already offered', async () => {
    const db = scriptedDb({ shift_offers: [{ data: { id: 'o1' }, error: null }, { data: null, error: { code: '23505' } }] })
    expect(await createOffer(db, { block: BLOCK, actorId: 'mgr' })).toEqual({ offer: { id: 'o1' } })
    expect(argsOf(chainsFor(db, 'shift_offers')[0], 'insert')[0]).toEqual({ location_id: 'loc-1', block_id: 'b1', offered_by: 'mgr' })
    expect(await createOffer(db, { block: BLOCK, actorId: 'mgr' })).toEqual({ code: 'already_offered' })
  })
  it('withdraw is guarded on still open; zero rows = it changed', async () => {
    const db = scriptedDb({ shift_offers: [ok, { data: [], error: null }] })
    expect(await withdrawOffer(db, { offerId: 'o1', nowIso: 'T' })).toEqual({ closed: true })
    expect(allArgsOf(chainsFor(db, 'shift_offers')[0], 'eq')).toEqual([['id', 'o1'], ['status', 'open']])
    expect(await withdrawOffer(db, { offerId: 'o1', nowIso: 'T' })).toEqual({ closed: false })
  })
})
```

- [ ] **Step 2: Run, expect failure** (module missing).

- [ ] **Step 3: Implement.**

```js
// src/lib/shift-offer-server.js
//
// REPLACE.1b — the DB half of "Offer to team". Decisions are in
// ./shift-offer-notice.js and shared/offer-to-team.js; this file reads, sends
// and writes. Service-role client: callers (routes) have authorised the
// studio; the */5 arm fans out across studios by design.
//
// THE SENDER (processOffer) is the ONE path for both the route's after() and
// the arm, so there is no route-vs-cron race beyond the lease:
//   1. lease: a guarded UPDATE (id + status read + attempts read + lease free)
//      sets notice_lease_until = now + 10 min and notice_attempts + 1;
//      zero rows = someone else holds it ('busy');
//   2. recipients: the audience (broadcast) or the studio's managers minus
//      the claimant (taken); an unreadable fact RELEASES the lease ('retry');
//   3. send: notifyUsersOnce under shift_offer_<kind>:<id>:a<attempt>; a send
//      that failed outright releases the lease ('retry');
//   4. stamp, guarded on the attempt. A process killed between 3 and 4 leaves
//      an expired lease: the next attempt uses a NEW key and sends again. A
//      duplicate, never a loss (CLAUDE.md invariant (c)).
// Never throws to the route's after(): the route wraps it; the arm catches.

import { notifyUsersOnce } from './push-dedup'
import { resolveRoleRecipientIds } from './push'
import { siblingLocationIds } from './sibling-locations'
import { MANAGER_ROLES } from './schemas'
import { logError, logWarn } from './log'
import {
  offerAudience, offerSweepAction, offerBroadcastPayload, offerTakenPayload, offerNoticeKey,
  OFFER_NOTICE_LEASE_MS, OFFER_TAKEN_MAX_AGE_MS,
} from './shift-offer-notice'

// Literal selects: check:select-columns resolves only literals. shift_offers has
// two FKs to profiles (offered_by, claimed_by), so the embed names its column.
export const OFFER_SELECT = `
  id, location_id, block_id, status, offered_by, created_at, closed_at, claimed_by, claimed_at,
  broadcast_at, broadcast_count, broadcast_outcome, taken_notified_at, notice_lease_until, notice_attempts,
  shift_blocks!block_id(id, location_id, block_date, start_time, end_time, min_coaches, max_coaches, rosters:roster_id(status), shift_templates(name, kind), shift_assignments(profile_id, status)),
  locations(name, timezone),
  claimer:profiles!claimed_by(full_name)
`
const BLOCK_SELECT = 'id, location_id, block_date, start_time, end_time, min_coaches, max_coaches, rosters:roster_id(status), shift_templates(name, kind), shift_assignments(profile_id, status), locations(name, timezone)'
const MEMBER_SELECT = 'profile_id, location_id, role, profiles!inner(id, active, deleted_at)'
const DAY_ASSIGNMENT_SELECT = 'id, profile_id, block_id, status, start_time_override, end_time_override, shift_blocks!inner(id, location_id, block_date, start_time, end_time, shift_templates(name), locations(name))'
const UNAVAILABILITY_SELECT = 'id, profile_id, kind, weekday, start_date, end_date, all_day, start_time, end_time'
// Open offers are single digits. A guard, not a page size.
const SWEEP_LIMIT = 200

const iso = (ms) => new Date(ms).toISOString()
const delivered = (r) => ((r?.sent || 0) + (r?.emailed || 0)) > 0

/** One offer with its shift and studio, or null. */
export async function readOffer(db, offerId) {
  const { data, error } = await db.from('shift_offers').select(OFFER_SELECT).eq('id', offerId).maybeSingle()
  return { offer: data || null, error: error || null }
}

/** A shift as POST /blocks/[id]/offer needs it, or null. */
export async function readOfferBlock(db, blockId) {
  const { data, error } = await db.from('shift_blocks').select(BLOCK_SELECT).eq('id', blockId).maybeSingle()
  return { block: data || null, error: error || null }
}

/** Open offers at one studio (the location filter IS the tenant boundary). */
export async function listOpenOffers(db, { locationId }) {
  const { data, error } = await db.from('shift_offers')
    .select(OFFER_SELECT)
    .eq('location_id', locationId)
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  return { offers: data || [], error: error || null }
}

/**
 * The facts default 6 is decided on, for one shift. `profileIds` narrows to
 * those people (the coach view and the claim read only the caller). Any read
 * error comes back as `error`: nothing here may read "unreadable" as "free".
 * The organisation boundary (siblingLocationIds) is a read too; failing it is
 * an error, never "this studio only", because a coach busy at the other studio
 * would then be offered a shift they cannot work.
 *
 * @returns {{ error, members, orgLocationIds, liveOnBlockIds, timeOff, assignments, unavailability }}
 */
export async function readOfferFacts(db, { block, profileIds = null }) {
  const empty = { members: [], orgLocationIds: [], liveOnBlockIds: [], timeOff: [], assignments: [], unavailability: [] }
  let q = db.from('profile_locations').select(MEMBER_SELECT).eq('location_id', block.location_id)
  if (profileIds) q = q.in('profile_id', profileIds)
  const { data: members, error: mErr } = await q
  if (mErr) return { ...empty, error: mErr }

  const { ids: siblings, error: sErr } = await siblingLocationIds(db, block.location_id)
  if (sErr) return { ...empty, error: sErr }
  const orgLocationIds = [block.location_id, ...siblings]

  const liveOnBlockIds = (block.shift_assignments || []).filter((a) => a && a.status !== 'cancelled').map((a) => a.profile_id)
  const ids = [...new Set((members || []).map((m) => m.profile_id).filter(Boolean))]
  if (ids.length === 0) return { ...empty, error: null, members: members || [], orgLocationIds, liveOnBlockIds }
  const d = block.block_date

  const [leave, day, rules] = await Promise.all([
    db.from('time_off_requests')
      .select('id, profile_id, type, start_date, end_date, total_days, status')
      .in('profile_id', ids)
      .eq('status', 'approved')
      .lte('start_date', d)
      .gte('end_date', d),
    db.from('shift_assignments')
      .select(DAY_ASSIGNMENT_SELECT)
      .in('profile_id', ids)
      .eq('shift_blocks.block_date', d)
      .in('shift_blocks.location_id', orgLocationIds),
    db.from('staff_unavailability')
      .select(UNAVAILABILITY_SELECT)
      .in('profile_id', ids)
      .or(`kind.eq.weekly,and(start_date.lte.${d},end_date.gte.${d})`),
  ])
  const err = leave.error || day.error || rules.error
  if (err) return { ...empty, error: err }
  return {
    error: null,
    members: members || [],
    orgLocationIds,
    liveOnBlockIds,
    timeOff: leave.data || [],
    assignments: day.data || [],
    unavailability: rules.data || [],
  }
}

/** Insert an open offer. 23505 = the shift already has one (the partial unique index). */
export async function createOffer(db, { block, actorId }) {
  const { data, error } = await db.from('shift_offers')
    .insert({ location_id: block.location_id, block_id: block.id, offered_by: actorId })
    .select(OFFER_SELECT)
    .single()
  if (error?.code === '23505') return { code: 'already_offered' }
  if (error) return { error }
  return { offer: data }
}

/** Withdraw an OPEN offer. closed:false = it was no longer open. */
export async function withdrawOffer(db, { offerId, nowIso }) {
  const { data, error } = await db.from('shift_offers')
    .update({ status: 'withdrawn', closed_at: nowIso, notice_lease_until: null })
    .eq('id', offerId)
    .eq('status', 'open')
    .select('id')
  if (error) return { error }
  return { closed: (data || []).length > 0 }
}

/** The one claim decision (mig 640). */
export async function claimOffer(db, { offerId, profileId }) {
  const { data, error } = await db.rpc('claim_shift_offer', { p_offer_id: offerId, p_profile_id: profileId })
  return { result: data || null, error: error || null }
}

async function closeOffer(db, offer, status, nowMs) {
  const { data, error } = await db.from('shift_offers')
    .update({ status, closed_at: iso(nowMs), notice_lease_until: null })
    .eq('id', offer.id)
    .eq('status', 'open')
    .select('id')
  if (error) throw new Error(error.message)
  return (data || []).length > 0
}

async function releaseLease(db, offerId, attempt) {
  const { error } = await db.from('shift_offers')
    .update({ notice_lease_until: null })
    .eq('id', offerId)
    .eq('notice_attempts', attempt)
    .select('id')
  // Not fatal: the lease expires on its own in OFFER_NOTICE_LEASE_MS.
  if (error) logWarn('shift-offer', 'lease release failed; it expires on its own', { offerId, err: error.message })
}

async function giveUp(db, offer, kind, nowMs) {
  const patch = kind === 'broadcast'
    ? { broadcast_at: iso(nowMs), broadcast_outcome: 'gave_up', notice_lease_until: null }
    : { taken_notified_at: iso(nowMs), notice_lease_until: null }
  const { error } = await db.from('shift_offers')
    .update(patch)
    .eq('id', offer.id)
    .is(kind === 'broadcast' ? 'broadcast_at' : 'taken_notified_at', null)
    .select('id')
  logError('shift-offer', `gave up sending the ${kind} notice for an offer`, { offerId: offer.id, attempts: offer.notice_attempts, err: error?.message })
}

async function deliver(db, offer, kind, nowMs) {
  const attempt = (offer.notice_attempts || 0) + 1
  const { data: leased, error: leaseErr } = await db.from('shift_offers')
    .update({ notice_lease_until: iso(nowMs + OFFER_NOTICE_LEASE_MS), notice_attempts: attempt })
    .eq('id', offer.id)
    .eq('status', offer.status)
    .eq('notice_attempts', offer.notice_attempts || 0)
    .or(`notice_lease_until.is.null,notice_lease_until.lt.${iso(nowMs)}`)
    .select('id')
  if (leaseErr) throw new Error(leaseErr.message)
  if (!leased || leased.length === 0) return 'busy'

  const block = offer.shift_blocks
  let ids
  if (kind === 'broadcast') {
    const facts = await readOfferFacts(db, { block: { ...block, location_id: offer.location_id } })
    if (facts.error) {
      logWarn('shift-offer', 'offer audience unreadable; nobody told yet, retried next tick', { offerId: offer.id, err: facts.error.message })
      await releaseLease(db, offer.id, attempt)
      return 'retry'
    }
    ids = offerAudience(facts, { ...block, location_id: offer.location_id }, offer.offered_by)
  } else {
    ids = (await resolveRoleRecipientIds(db, offer.location_id, MANAGER_ROLES)).filter((id) => id && id !== offer.claimed_by)
  }

  if (ids.length > 0) {
    const payload = kind === 'broadcast'
      ? offerBroadcastPayload({ offer, block, studioName: offer.locations?.name })
      : offerTakenPayload({ offer, block, claimerName: offer.claimer?.full_name })
    const result = await notifyUsersOnce(db, offerNoticeKey(kind, offer.id, attempt), ids, payload)
    if (!delivered(result) && (result?.failed || 0) > 0) {
      await releaseLease(db, offer.id, attempt)
      return 'retry'
    }
  }

  const patch = kind === 'broadcast'
    ? { broadcast_at: iso(nowMs), broadcast_count: ids.length, broadcast_outcome: ids.length ? 'sent' : 'no_recipients', notice_lease_until: null }
    : { taken_notified_at: iso(nowMs), notice_lease_until: null }
  const { error: stampErr } = await db.from('shift_offers')
    .update(patch)
    .eq('id', offer.id)
    .eq('notice_attempts', attempt)
    .select('id')
  if (stampErr) {
    logError('shift-offer', 'offer notice sent but the stamp failed; the lease expires and the next attempt re-sends (a duplicate, never a loss)', { offerId: offer.id, kind, err: stampErr.message })
  }
  return 'sent'
}

/**
 * Do what one offer needs right now (offerSweepAction). Returns an outcome:
 * none | quiet_hours | leased | expired | filled | raced | busy | retry | sent | gave_up.
 * Throws only on a failed write the caller must count (the arm catches).
 */
export async function processOffer(db, offer, { nowMs = Date.now() } = {}) {
  const tz = offer?.locations?.timezone ?? null
  const step = offerSweepAction(offer, { nowMs, tz })
  if (step.action === 'none') return step.reason || 'none'
  if (step.action === 'close') return (await closeOffer(db, offer, step.status, nowMs)) ? step.status : 'raced'
  if (step.action === 'give_up') { await giveUp(db, offer, step.kind, nowMs); return 'gave_up' }
  return deliver(db, offer, step.kind, nowMs)
}

/**
 * The */5 arm (send-push-reminders). Never throws. errors > 0 means the arm
 * itself failed somewhere (an unreadable list, a failed write): its heartbeat
 * is not stamped. A 'retry' (an unreadable audience, a failed send) is not an
 * arm fault: the lease is released and the next tick retries.
 */
export async function runShiftOfferSweep(db, { nowMs = Date.now() } = {}) {
  const stats = { open: 0, claimed_owed: 0, none: 0, quiet_hours: 0, leased: 0, expired: 0, filled: 0, raced: 0, busy: 0, retry: 0, sent: 0, gave_up: 0, errors: 0 }
  const [openRes, owedRes] = await Promise.all([
    db.from('shift_offers').select(OFFER_SELECT).eq('status', 'open').order('created_at', { ascending: true }).limit(SWEEP_LIMIT),
    db.from('shift_offers').select(OFFER_SELECT).eq('status', 'claimed').is('taken_notified_at', null)
      .gte('claimed_at', iso(nowMs - OFFER_TAKEN_MAX_AGE_MS)).order('claimed_at', { ascending: true }).limit(SWEEP_LIMIT),
  ])
  if (openRes.error) { stats.errors++; logError('shift-offer', 'sweep could not read open offers', { err: openRes.error.message }) }
  if (owedRes.error) { stats.errors++; logError('shift-offer', 'sweep could not read claimed offers owed a notice', { err: owedRes.error.message }) }
  const offers = [...(openRes.error ? [] : openRes.data || []), ...(owedRes.error ? [] : owedRes.data || [])]
  stats.open = openRes.error ? 0 : (openRes.data || []).length
  stats.claimed_owed = owedRes.error ? 0 : (owedRes.data || []).length
  for (const offer of offers) {
    try {
      const outcome = await processOffer(db, offer, { nowMs })
      stats[outcome] = (stats[outcome] || 0) + 1
    } catch (e) {
      stats.errors++
      logError('shift-offer', 'sweep failed on an offer; the next tick retries it', { offerId: offer?.id, err: e?.message })
    }
  }
  return stats
}
```

Note on the sweep test "one offer throwing": the first offer's lease write returns `{ data: null, error }` → `deliver` throws → `errors: 1`; the second offer's lease returns `{ data: [] }` → `busy`. The scripted answers are consumed in call order (`open` read, `owed` read, then the leases), which is why `Promise.all` order matters: the open read is created first.

- [ ] **Step 4: Run, expect pass**, both zones:

```bash
npx vitest run src/lib/shift-offer-server.test.js
TZ=America/Los_Angeles npx vitest run src/lib/shift-offer-server.test.js
```
Expected: `0 failed`. If a scripted-answer order assumption fails because `readOfferFacts`'s `Promise.all` creates its three builders in a different order, fix the TEST's script (each table has its own queue, so only same-table order matters).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/shift-offer-server.js src/lib/shift-offer-server.test.js
git commit -m "REPLACE.1b — shift-offer-server.js: facts for default 6, the leased sender, the */5 sweep

One sender for the route's after() and the arm: lease, recipients, send under
an attempt-numbered key, stamp guarded on the attempt. An unreadable fact or a
failed send releases the lease; a lost stamp re-sends (duplicate, never loss).
Closing (expired / filled) is state and happens at any hour.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

