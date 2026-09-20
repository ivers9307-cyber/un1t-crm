## PR STAFFDELETE.1 — permanent delete keeps history (migration 622)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Permanently delete" a staff member removes them from UPCOMING shifts and strips their personal data, while every past shift, leave request, allowance, invoice and report row stays and stays reportable BY NAME.

**Owner's decision (do not reopen):** permanent delete removes the person from upcoming shifts only and must NOT change history; past shifts, leave, invoices and reports stay look-up-able and reportable by name.

**Why (evidence, read 2026-09-19):** `src/app/api/staff/[id]/permanent/route.js:24-25` claims *"financial records (rosters, shifts, payroll history) — attribution becomes NULL but the rows stay"*. It is false: line 187 runs `db.from('profiles').delete()`, and the profile delete CASCADES (see the FK catalog below) through `shift_assignments`, `time_off_requests`, `staff_allowances`, `schedule_notifications`, `contractor_invoices`, `profile_compensation`, `fte_expense_claims`, `card_receipts`, `policy_acknowledgements`, `checklist_instances` and more. Irreversible loss of records the business must keep.

**Ships:** migration 622 + web deploy. No OTA (nothing under `mobile/` or `shared/` changes; `check:ota-paths` confirms).
**DEPLOY ORDER — migration FIRST, then merge:**
1. The operator applies `supabase/migrations/622_staff_tombstone.sql` to project `iyvtbjjxdggiadzwwvdj` through the Supabase tool, after running the PRE-APPLY queries in its header (Task 2), and runs `get_advisors` (security) after.
2. Only then merge the PR.
- *Migration alone is SAFE:* two nullable columns, a CHECK every existing row passes (`deleted_at` is NULL everywhere), one partial index, one function nobody calls yet.
- *Code alone is NOT SAFE:* every read wrapped in `excludeTombstones()` sends `deleted_at=is.null` to PostgREST, which 400s on a column that does not exist — `/settings/staff`, the Settings index and all three impersonation pickers would break. Do not merge before step 1.

**Worktree:** `git fetch origin main && git worktree add ../un1t-crm-staffdelete -b staffdelete-1 origin/main`. Run every command from there. Never `git stash`. Tests: `npx vitest run <file>` one file at a time (8GB machine); the full suite only at the PR gate.

---

### Investigation — what the code and migrations actually say

#### 1. `profiles.id` → `auth.users` is `ON DELETE CASCADE`

`supabase/migrations/004_auth_multi_tenant.sql:36` — `id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`. No later migration alters it (`grep -rniE "drop constraint.*profiles" supabase/migrations` finds only two CHECK constraints, migs 070 and 209).

**Consequence:** the auth user can NEVER be deleted for a retained profile — `auth.admin.deleteUser(id)` would cascade-delete the tombstone and, through it, all the history this PR exists to keep. The auth user is **banned and scrambled** instead (Task 3).

#### 2. Every FK into `profiles` (and `auth.users`), from the migrations

Method: `grep -rniE "references\s+(public\.)?profiles|references\s+auth\.users" supabase/migrations` → **141 lines** (133 into `profiles` — 25 CASCADE, 49 NO ACTION, 2 RESTRICT, 57 SET NULL, two of them on the since-dropped `shifts` — and 6 into `auth.users`; the rest are comments), each resolved to its enclosing `CREATE/ALTER TABLE`. No FK into `profiles` has been dropped or re-created by a later migration (checked: the only `DROP CONSTRAINT … _fkey` statements are in migs 083, 094, 237, 238, 494, 603 — none target `profiles`), so the creating migration is the last word for every row. Task 2's PRE-APPLY query (a) re-derives this from `pg_constraint` on the live database; trust that over this table if they differ.

| ON DELETE | table.column (migration) | What a HARD delete does to it | Under the tombstone |
|---|---|---|---|
| **CASCADE** — history | `shift_assignments.profile_id` (067) · `time_off_requests.profile_id` (011) · `staff_allowances.profile_id` (011) · `schedule_notifications.profile_id` (010) · `contractor_invoices.contractor_id` (101:19) · `profile_compensation.profile_id` (152) · `fte_expense_claims.profile_id` (183) · `card_receipts.submitter_id` (266) · `policy_acknowledgements.profile_id` (178) · `policy_views.profile_id` (179) · `checklist_instances.profile_id` (215) · `assignment_change_log.target_profile_id` (080) · `impersonation_log.master_user_id`/`target_user_id` (035) · `support_sessions.master_user_id` (431) · `agent_message_feedback.created_by` (265) · `push_reminder_sends.recipient_id` (169) · `push_event_sends.recipient_id` (349) | **rows destroyed** | never fires — the row stays |
| **CASCADE** — access/credentials | `profile_locations.profile_id` (004) · `profile_organizations.profile_id` (417) · `device_tokens.user_id` (023) · `widget_tokens.profile_id` (607) · `email_mailbox_access.profile_id` (485) · `mobile_bar_prefs.profile_id` (246) | rows destroyed | **deleted explicitly** by the function (that is the point: no access, no tokens) |
| **RESTRICT** | `contracts.profile_id` · `contracts.issued_by` (106) | delete REFUSED | irrelevant — nothing is deleted |
| **NO ACTION** (default) | `consent_log.performed_by` · `email_templates.created_by` · `campaigns.created_by` · `email_sequences.created_by` (005) · `whatsapp_templates.created_by` · `whatsapp_broadcasts.created_by` · `whatsapp_conversations.assigned_to` · `whatsapp_messages.sent_by` (007) · `shift_swap_requests.requester_id` **(NOT NULL)** · `.target_id` · `.reviewed_by` (010) · `time_off_requests.reviewed_by` (011) · `scheduled_reports.created_by` · `generated_reports.generated_by` (012) · `company_settings.updated_by` (013) · `xero_connections.connected_by` (029) · `car_documents.xero_sent_by` (030) · `sms_broadcasts.created_by` (060) · `shift_blocks.created_by` · `shift_assignments.assigned_by` (067) · `rosters.published_by`/`over_budget_approval_by`/`created_by` (072) · `contract_templates.created_by` · `contracts.revoked_by` (106) · `location_trusted_ips.created_by` · `studio_devices.paired_by` (209) · `google_business_connections.connected_by` (249) · `person_groups.created_by` · `person_group_members.added_by` (270) · `person_link_suggestions.decided_by` (271) · `consultations.coach_id`/`created_by` · `consultation_photos.created_by` · `coaching_goals.created_by` (272) · `location_automations.updated_by` (276) · `race_checkins.checked_in_by` (281) · `presentations.created_by` (291) · `challenges.created_by` (299) · `org_settings.updated_by` (317) · `recon_bank_lines.ignored_by` (367) · `recon_mailboxes.created_by` (370) · `contract_template_versions.changed_by` (446) · `fleet_commands.issued_by` (475) · `offer_purchases.fulfilled_by` (503) · `email_bounce_escalations.released_by` (515) · `email_hygiene_releases.released_by` (535) · `email_tickets.merged_by` (536) | delete REFUSED while any row points at the profile | attribution stays, **by name** |
| **SET NULL** | `location_holidays.created_by` (017) · `cars.created_by` · `car_documents.uploaded_by` (025) · `contact_segments.created_by` (043) · `car_notes.created_by` (047) · `assignment_change_log.actor_id` (080) · `contact_imports.actor_user_id`/`rolled_back_by` (095) · `contractor_invoices.reviewed_by` (101) · `ac_sessions.started_by`/`ended_by` (103) · `staff_attendance_events.profile_id` (120) · `race_penalties.applied_by` (124) · `landing_page_settings.updated_by` (126) · `glofox_push_events.reviewed_by` (143) · `pipeline_classification_runs.created_by` (149) · `profile_compensation.updated_by` (152) · `activities.assignee_id` (159) · `tv_content.pushed_by` (160) · `password_overrides_audit.target_profile_id`/`performed_by` (161) · `car_bca_submissions.submitted_by` (163) · `car_documents.extracted_by`/`xero_pushed_by` (175) · `policy_versions.published_by` (178) · `audit_events.actor_id`/`target_profile_id` (180) · `fte_expense_claims.reviewed_by` (183) · `inbound_invoices.quality_reviewed_by`/`data_reviewed_by` (184) · `tv_templates.created_by` (190) · `pin_login_attempts.matched_profile` (209) · `issues.submitter_id`/`claimed_by`/`resolved_by` · `issue_attachments.uploaded_by` (213) · `api_keys.created_by` (217) · `roster_change_log.actor_id`/`coach_id` (236) · `card_receipts.reviewed_by` (266) · `class_timer_templates.created_by` · `class_timer_runs.started_by` (290) · `coach_kudos.sender_profile_id` (355) · `location_role_permissions.updated_by` (364) · `support_sessions.impersonated_user_id` (431) · `hyrox_sessions.approved_by` (440) · `equipment_inspections.inspector_id` (467) · `email_mailbox_access.granted_by` (485) · `zoom_sync_runs.triggered_by` (491) · `email_inbox_messages.author_profile_id` (493) · `sonos_connections.linked_by` (560) · `shelly_connections.linked_by` · `shelly_devices.adopted_by` (562) · `email_mailbox_credentials.created_by` (572) · `cancellation_form_links.issued_by` (585) · `shift_block_removals.removed_by` (613) · `time_off_requests.created_by` (616) | attribution silently lost (incl. **attendance** and the **roster change log**) | attribution stays, by name |
| → `auth.users` | `profiles.id` **CASCADE** (004) · `host_users.auth_user_id` **CASCADE** (386) · `contacts.user_id` SET NULL (110) · `contact_devices.added_by_user_id` SET NULL (112) · `churn_radar_actions.actor_id` · `lead_radar_actions.actor_id` SET NULL (194, 197) | deleting the auth user also deletes the person's HOST login and detaches their MEMBER account | auth user is never deleted |

`shifts.profile_id` CASCADE and `shifts.created_by` NO ACTION (mig 010) are omitted: **`public.shifts` was dropped by mig 238:38**.

#### 3. Three findings that change the scope

**(a) The current route has very probably not completed a delete since mig 238 shipped.** Its hand-written `AUDIT_FK_NULLOUT` (lines 45-70) contains `{ table: 'shifts', column: 'created_by' }` — a table that no longer exists. PostgREST errors on an unknown relation, so the loop at lines 164-172 returns 500 *"Failed to anonymize shifts.created_by … Aborted before deletion"* — but only AFTER it has already written the `permanent_delete` audit row (line 142) and nulled the 21 columns listed before `shifts`. Two entries earlier, `shift_swap_requests.requester_id` is `NOT NULL` (mig 010:88), so the null-out fails there first for anyone who ever requested a swap. And the list covers only **23 of the 48** live NO ACTION columns in the catalog (its 24th entry is the dropped table) — `consultations.coach_id`, `fleet_commands.issued_by`, `contract_templates.created_by` and twenty-two more would each have refused the delete. *A hand-listed FK list rots; this PR deletes the list, because a row that stays needs nothing nulled.* PRE-APPLY query (c) shows the operator whether any half-run attempts exist in prod. **Not verified against prod** — read from code and migrations only.

**(b) `staff_cost` and `utilisation` already drop every leaver.** `src/lib/report-generator.js:192-195` and `:381-384` read profiles with `.eq('active', true)` from a `profile_locations` membership list, and `:207` skips any shift whose profile is missing. So a coach deactivated on the 20th vanishes from that month's cost report today — before anyone deletes anything — and a tombstone (inactive, no memberships) would too. `staff_hours` and `time_off_summary` are fine (they read the name off the row's own `profiles` embed). Task 6 fixes the two that are not, or the owner's "reportable by name" fails on day one.

**(c) `getCurrentUser()` never checks `profiles.active`.** `src/lib/auth.js:281-285` returns null only when the row is missing; nothing in `auth.js`, `proxy.js` or the app reads `user.active`. The Danger Zone copy says deactivating "prevents sign-in" — for the web/mobile session path it does not (PIN login and password reset do check it). **Out of scope here and deliberately NOT fixed** (changing it could lock out a live account whose `active` is NULL — the column is nullable, mig 004:41); this PR makes the TOMBSTONE path safe on its own (ban + explicit `deleted_at` guard). Raise it as a separate ticket.

#### 4. Who reads `profiles` for a display name

Every one of these joins by id and reads `full_name`, so a retained row keeps them working; a hard delete blanks or destroys them:

| Reader | Where | Survives a tombstone? |
|---|---|---|
| `staff_hours`, `time_off_summary` | `report-generator.js:20, 289, 322` (row embeds) | yes |
| `staff_cost`, `utilisation` | `report-generator.js:192, 381` | **only after Task 6** |
| week cost / roster summary | `roster-week-cost.js:85`, `roster-summary-server.js:96` (`.in('id', ids-from-shifts)`, no active filter) | yes — **needs the pay columns kept** |
| contractor invoices | `contractor-invoices.js:102` + list embeds on `contractor_id` | yes |
| time-off lists | `api/schedule/time-off/route.js:55-56` (`profiles!profile_id`, `reviewer:profiles!reviewed_by`) | yes |
| roster change log, swap history, attendance | embeds on `coach_id` / `requester_id` / `profile_id` | yes (a hard delete NULLs or blocks them) |
| audit log, mail authors, consultations, zoom actors | `audit-log/page.js:38`, `email/mail/[id]/route.js:347`, `consultations/me/route.js:40`, `zoom-contacts/page.js:97` | yes |

#### 5. What "active staff" means today, and where a retained row could leak

There is one flag: `profiles.active` (boolean, mig 004:41). There is no `status` column and **no seat count anywhere** (`grep -rln "seat" src/lib src/app/api` hits only events code). The route already refuses to delete an ACTIVE profile (line 106), so a tombstone is always `active = false` — mig 622 makes that a CHECK. That alone removes it from every `.eq('active', true)` reader: notification fan-outs (`push.js:156, 413`, `time-off-leave.js:107`), PIN login (`studio-pin.js:133`), policies, the launcher, the assistant, audit-log filters, staff-devices.

What is left is exactly the set of reads that list profiles WITHOUT an id, active or email filter. A scripted sweep of all 88 `from('profiles')` sites in `src/` (the same heuristic Task 5 turns into a test, run against this tree on 2026-09-19) finds **seven**:

```
src/app/settings/page.js:133                     staff-count badge (counts everyone)
src/app/settings/staff/page.js:73                master's unrestricted staff list
src/app/settings/staff/page.js:78                estate-wide id/active set
src/app/settings/impersonate/page.js:28          impersonation picker (web page)
src/app/api/impersonate/users/route.js:29        impersonation picker (web API)
src/app/api/mobile/impersonate/users/route.js:36 impersonation picker (mobile)
src/app/api/cron/fleet-health/route.js:528       masters to alert (no active filter; would email the scrambled address)
```

Location-scoped lists (`/api/staff` → `src/lib/staff.js:50-66`, the non-master `/settings/staff` branch, `getLocationMemberIds`, `resolveRoleRecipientIds`) take their ids from `profile_locations`, which the function deletes — a tombstone cannot be in those sets. That invariant is pinned in the PGlite test rather than by editing those files.

### Design

**The profile row is RETAINED as a tombstone.** `deleted_at timestamptz`, `deleted_by uuid`, and `CHECK (deleted_at IS NULL OR active IS FALSE)` so the database itself refuses a reactivation.

One transactional SQL function, `public.tombstone_staff_profile(p_profile_id, p_actor_id, p_today, p_dry_run)` (service_role only, the mig 612 posture), does everything that must be atomic. `p_dry_run = true` returns the same summary without writing — the confirmation dialog shows the operator exactly what WILL happen from the same code that does it.

| Thing | Decision | Why |
|---|---|---|
| `full_name`, `role`, `employment_type`, `created_at` | **keep** | history by name; role history |
| `email` | scramble to `deleted+<id>@deleted.invalid` | `NOT NULL`; `.invalid` can never be mailed; unique per row |
| `avatar_url`, `pin_hash` (+ `pin_set_at`, counters), `unifi_user_id`, `email_signature`, `email_signature_rich` | NULL; `permissions` → `{}`; `unifi_door_access`/`two_factor_enabled` → false; `home_screen_path` → default | PII / credentials / external ids. (`profiles` has NO phone, address, DOB or emergency-contact columns — checked against the schema replayed from the migrations; nothing to strip there.) |
| `profile_compensation` row **and** the deprecated pay columns on `profiles` | **KEEP** | Only contractor invoices snapshot a rate (`hourly_rate_at_review`). `staff_cost` (`report-generator.js:193`), `roster-week-cost.js:88` and `roster-summary-server.js:99` cost PAST shifts from the person's CURRENT rate; deleting it turns their history into €0 — a changed report, which the owner ruled out. `annual_leave_entitlement` likewise explains their allowance history. The retention basis (payroll records) is the owner's call and already made; the UI copy states it. |
| Future live assignments (`block_date >= Dublin today`) | **deleted**, one `roster_change_log` row (`unassigned`, `details.reason = 'staff_permanent_delete'`) per PUBLISHED one, `notified_at` stamped | the log is the audit; stamping stops the re-publish safety net (`collectUnnotifiedChanges`) from "re-notifying" someone who is gone. Managers at each affected studio are pushed "N shifts need cover"; the calendar's existing under-staffed markers do the rest |
| Past assignments | untouched | history |
| Open swaps (`pending`, `awaiting_approval`) where they are requester OR target | `cancelled` + note; the other party is told | since mig 603 both shift pointers are `ON DELETE SET NULL`, so the swap rows survive the assignment delete |
| Pending time off with `end_date >= today` | `cancelled` + note | pending → cancelled does not touch the allowance (trigger mig 011/616 only reacts to `approved`). Expired-pending and decided rows are history: untouched |
| `profile_locations`, `profile_organizations`, `device_tokens`, `widget_tokens`, `email_mailbox_access`, `mobile_bar_prefs` | **deleted** | access, tokens, door ids, face ids. Role history is preserved first in `assignment_change_log.before.assignments` (that row now survives, since nothing cascades) |
| `audit_events` | mutation rows for this profile / its memberships get `details` replaced by `{redacted}`; `actor_label`/`target_label` reduced to the name; `email` removed from their `auth` rows | mig 191's `audit_mutation` trigger fires on the strip itself and would re-save the old email and `pin_hash` in `details.before` |
| `auth.users` | **banned + scrambled**, never deleted (finding 1). If the same auth user is also a MEMBER (`contacts.user_id`) or a HOST (`host_users.auth_user_id`), it is left alone and the response says so | banning would lock a paying member out of the member app; the staff side is already dead because `getCurrentUser()` refuses a tombstone |
| signature photo in the PUBLIC `branding` bucket (`signatures/<id>/…`, `api/me/signature-photo/route.js:46`) | removed, best-effort | a public URL of a person's face |

Exact admin call (supabase-js v2, on the service-role client the route already has — the same client the old code called `db.auth.admin.deleteUser` on):

```js
await db.auth.admin.updateUserById(id, {
  email: tombstoneEmail(id),        // 'deleted+<id>@deleted.invalid'
  email_confirm: true,              // apply the change without a confirmation mail
  password: randomBytes(32).toString('hex'),
  ban_duration: '876000h',          // 100 years; GoTrue refuses refresh + sign-in for a banned user
  user_metadata: { full_name: null },
})
```

`auth.admin.signOut()` is NOT used: it takes a JWT, not a user id. An access token already issued lives ≤ 1 hour; during that hour `getCurrentUser()` returns null for a tombstone (Task 4) and RLS gives an account with no `profile_locations` nothing to read.

---

### File map

| File | Responsibility |
|---|---|
| `src/lib/staff-tombstone.js` (create) | the shared predicate + every pure decision |
| `src/lib/staff-tombstone.test.js` (create) | tests |
| `supabase/migrations/622_staff_tombstone.sql` (create) | columns, CHECK, index, the function |
| `tests/migration-622-staff-tombstone.test.js` (create) | PGlite behavioural test against the REAL file |
| `src/app/api/staff/[id]/permanent/route.js` (rewrite) | GET = dry-run preview, DELETE = tombstone |
| `src/app/api/staff/[id]/permanent/route.test.js` (create) | route tests |
| `src/lib/auth.js` (modify 285, ~316) · `src/lib/auth.getCurrentUser.test.js` (modify) | a tombstone never resolves a user |
| `src/lib/impersonation.js` (modify 103-108) | cannot impersonate a tombstone |
| `src/app/api/staff/[id]/route.js` (modify 99-107) | PUT 404s a tombstone (no reactivation) |
| `src/app/settings/page.js`, `src/app/settings/staff/page.js`, `src/app/settings/staff/[id]/page.js`, `src/app/settings/impersonate/page.js`, `src/app/api/impersonate/users/route.js`, `src/app/api/mobile/impersonate/users/route.js`, `src/app/api/cron/fleet-health/route.js` (modify) | the seven unfiltered lists + the detail page |
| `tests/staff-tombstone-readers.test.js` (create) | the sweep: a NEW unfiltered `profiles` list fails CI |
| `src/lib/report-generator.js` (modify 183-199, 373-388) · `src/lib/report-generator.test.js` (modify) | leavers stay in `staff_cost` / `utilisation` |
| `src/components/StaffForm.jsx` (modify 1174-1176, 1311-1360) | honest copy + impact preview |
| `CLAUDE.md`, `docs/CHANGELOG.md` (modify) | one invariant line; one changelog row |

---

### Task 1: `src/lib/staff-tombstone.js` — the shared predicate and the pure decisions

**Files:** Create `src/lib/staff-tombstone.js`, `src/lib/staff-tombstone.test.js`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/staff-tombstone.test.js
import { describe, it, expect, vi } from 'vitest'
import {
  isTombstone, excludeTombstones, tombstoneEmail, authDisposition, tombstoneErrorStatus,
  coverNoticesByLocation, swapCounterparties, describeTombstoneImpact,
} from './staff-tombstone.js'

const ID = '10000000-0000-0000-0000-000000000001'

describe('isTombstone / excludeTombstones', () => {
  it('a profile is a tombstone iff deleted_at is set', () => {
    expect(isTombstone({ id: ID, deleted_at: '2026-09-19T10:00:00Z' })).toBe(true)
    expect(isTombstone({ id: ID, deleted_at: null })).toBe(false)
    expect(isTombstone({ id: ID, active: false })).toBe(false) // deactivated is NOT deleted
    expect(isTombstone(null)).toBe(false)
  })
  it('excludeTombstones adds exactly one filter and hands the builder back', () => {
    const q = { is: vi.fn(function is() { return this }) }
    expect(excludeTombstones(q)).toBe(q)
    expect(q.is).toHaveBeenCalledTimes(1)
    expect(q.is).toHaveBeenCalledWith('deleted_at', null)
  })
})

describe('tombstoneEmail', () => {
  it('is unique per profile, lower-case, and on a domain that can never receive mail', () => {
    expect(tombstoneEmail(ID)).toBe(`deleted+${ID}@deleted.invalid`)
    expect(tombstoneEmail('ABCDEF00-0000-0000-0000-000000000001')).toBe('deleted+abcdef00-0000-0000-0000-000000000001@deleted.invalid')
  })
})

describe('authDisposition', () => {
  it('bans a staff-only login', () => {
    expect(authDisposition({ memberContact: null, hostUser: null, readFailed: false })).toBe('ban')
  })
  it('keeps the login when the same person is a member or a host', () => {
    expect(authDisposition({ memberContact: { id: 'c1' }, hostUser: null, readFailed: false })).toBe('kept_member_login')
    expect(authDisposition({ memberContact: null, hostUser: { host_id: 'h1' }, readFailed: false })).toBe('kept_host_login')
  })
  it('an unreadable answer KEEPS the login — locking a paying member out is the worse mistake', () => {
    expect(authDisposition({ memberContact: null, hostUser: null, readFailed: true })).toBe('kept_unverified')
  })
})

describe('tombstoneErrorStatus', () => {
  it('maps the function\'s message prefixes to HTTP', () => {
    expect(tombstoneErrorStatus('staff_not_found: no profile x')).toEqual({ status: 404, error: 'Profile not found' })
    expect(tombstoneErrorStatus('staff_already_deleted: x').status).toBe(409)
    expect(tombstoneErrorStatus('staff_still_active: x').status).toBe(400)
    expect(tombstoneErrorStatus('staff_self_delete: x').status).toBe(400)
    expect(tombstoneErrorStatus('deadlock detected')).toEqual({ status: 500, error: 'Permanent delete failed: deadlock detected' })
  })
})

describe('coverNoticesByLocation', () => {
  it('one notice per studio, PUBLISHED shifts only, with the earliest date', () => {
    expect(coverNoticesByLocation([
      { location_id: 'loc-1', block_date: '2026-10-07', roster_status: 'published' },
      { location_id: 'loc-1', block_date: '2026-10-05', roster_status: 'published' },
      { location_id: 'loc-1', block_date: '2026-10-06', roster_status: 'draft' },
      { location_id: 'loc-2', block_date: '2026-10-09', roster_status: 'published' },
    ])).toEqual([
      { locationId: 'loc-1', count: 2, firstDate: '2026-10-05' },
      { locationId: 'loc-2', count: 1, firstDate: '2026-10-09' },
    ])
    expect(coverNoticesByLocation(null)).toEqual([])
  })
})

describe('swapCounterparties', () => {
  it('the OTHER person on each cancelled swap; open-pool swaps have nobody to tell', () => {
    expect(swapCounterparties([
      { id: 's1', requester_id: ID, target_id: 'peer-1' },
      { id: 's2', requester_id: 'peer-2', target_id: ID },
      { id: 's3', requester_id: ID, target_id: null },
    ], ID)).toEqual([{ swapId: 's1', notifyId: 'peer-1' }, { swapId: 's2', notifyId: 'peer-2' }])
  })
})

describe('describeTombstoneImpact', () => {
  it('says exactly what goes and what stays', () => {
    expect(describeTombstoneImpact({
      removed_shifts: [{}, {}, {}], cancelled_swaps: [{}], cancelled_time_off: [],
      kept: { past_shifts: 212, time_off_requests: 9, contractor_invoices: 4 },
    })).toEqual({
      removes: [
        'Removed from 3 upcoming shifts. These will need cover.',
        '1 open swap request cancelled.',
      ],
      keeps: 'Kept, under their name: 212 past shifts, 9 leave requests, 4 invoices, their allowance and pay records, and every report.',
    })
  })
  it('nothing upcoming reads as nothing upcoming', () => {
    const d = describeTombstoneImpact({ removed_shifts: [], cancelled_swaps: [], cancelled_time_off: [{}, {}], kept: {} })
    expect(d.removes).toEqual(['They are on no upcoming shifts.', '2 pending leave requests cancelled.'])
    expect(d.keeps).toBe('Kept, under their name: their allowance and pay records, and every report.')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/staff-tombstone.test.js`
Expected: fails to load — `Failed to resolve import "./staff-tombstone.js"`.

- [ ] **Step 3: Implement**

```js
// src/lib/staff-tombstone.js
// STAFFDELETE.1 — a permanently deleted staff member is a TOMBSTONE, not a
// missing row.
//
// profiles.id → auth.users is ON DELETE CASCADE (mig 004:36) and ~25 tables
// cascade off profiles (shift_assignments, time_off_requests,
// staff_allowances, contractor_invoices, …), so deleting the row — or the
// auth user — destroys the history the business must keep. Instead the row
// stays with `deleted_at` set (mig 622), PII stripped and `full_name` kept, so
// every past shift, leave request, invoice and report still names the person.
//
// THE RULE FOR READERS: a tombstone is always active=false (DB CHECK), has no
// profile_locations and no tokens. So `.eq('active', true)` readers and
// location-scoped lists exclude it structurally. Any read that lists profiles
// WITHOUT an id / active / email filter must go through excludeTombstones();
// any code that ACTS on one profile by id must refuse isTombstone().
// tests/staff-tombstone-readers.test.js fails CI on a new unfiltered list.

export const TOMBSTONE_EMAIL_DOMAIN = 'deleted.invalid'
export const AUTH_BAN_DURATION = '876000h' // 100 years

/** Pure. Deactivated (active=false) is NOT deleted; only deleted_at is. */
export function isTombstone(profile) {
  return !!profile?.deleted_at
}

/** Narrow a `profiles` query to rows that are not tombstones. Returns the builder. */
export function excludeTombstones(query) {
  return query.is('deleted_at', null)
}

/** The address a tombstone (and its banned auth user) carries. `.invalid` is reserved: it can never receive mail. */
export function tombstoneEmail(profileId) {
  return `deleted+${String(profileId).toLowerCase()}@${TOMBSTONE_EMAIL_DOMAIN}`
}

/**
 * What to do with the auth user. It can never be DELETED (the cascade above).
 * It is banned unless the same login is also a member or a host — and when we
 * cannot tell, it is kept: the staff side is dead either way (getCurrentUser
 * refuses a tombstone), while a wrong ban locks a paying member out.
 */
export function authDisposition({ memberContact, hostUser, readFailed }) {
  if (readFailed) return 'kept_unverified'
  if (memberContact) return 'kept_member_login'
  if (hostUser) return 'kept_host_login'
  return 'ban'
}

const ERROR_MAP = [
  ['staff_not_found', 404, 'Profile not found'],
  ['staff_already_deleted', 409, 'This staff member has already been permanently deleted.'],
  ['staff_still_active', 400, 'Profile must be deactivated first. Soft-archive (set Active off) before permanent delete.'],
  ['staff_self_delete', 400, 'You cannot permanently delete your own account.'],
]

/** tombstone_staff_profile raises P0001 with a `staff_*:` prefix (mig 622). */
export function tombstoneErrorStatus(message) {
  const msg = String(message || '')
  const hit = ERROR_MAP.find(([prefix]) => msg.startsWith(prefix))
  return hit ? { status: hit[1], error: hit[2] } : { status: 500, error: `Permanent delete failed: ${msg}` }
}

/** One "shifts need cover" notice per studio — published shifts only (a draft is nobody's plan yet). */
export function coverNoticesByLocation(removedShifts) {
  const by = new Map()
  for (const s of removedShifts || []) {
    if (s?.roster_status !== 'published' || !s.location_id) continue
    const cur = by.get(s.location_id) || { locationId: s.location_id, count: 0, firstDate: s.block_date }
    cur.count += 1
    if (s.block_date < cur.firstDate) cur.firstDate = s.block_date
    by.set(s.location_id, cur)
  }
  return [...by.values()]
}

/** The other person on each cancelled swap. */
export function swapCounterparties(cancelledSwaps, profileId) {
  return (cancelledSwaps || [])
    .map((s) => ({ swapId: s.id, notifyId: s.requester_id === profileId ? s.target_id : s.requester_id }))
    .filter((x) => x.notifyId && x.notifyId !== profileId)
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** The confirmation dialog's copy, from a dry-run (or real) summary. */
export function describeTombstoneImpact(summary) {
  const shifts = (summary?.removed_shifts || []).length
  const swaps = (summary?.cancelled_swaps || []).length
  const leave = (summary?.cancelled_time_off || []).length
  const removes = [
    shifts > 0
      ? `Removed from ${plural(shifts, 'upcoming shift', 'upcoming shifts')}. These will need cover.`
      : 'They are on no upcoming shifts.',
  ]
  if (swaps > 0) removes.push(`${plural(swaps, 'open swap request', 'open swap requests')} cancelled.`)
  if (leave > 0) removes.push(`${plural(leave, 'pending leave request', 'pending leave requests')} cancelled.`)
  const k = summary?.kept || {}
  const kept = [
    k.past_shifts > 0 && plural(k.past_shifts, 'past shift', 'past shifts'),
    k.time_off_requests > 0 && plural(k.time_off_requests, 'leave request', 'leave requests'),
    k.contractor_invoices > 0 && plural(k.contractor_invoices, 'invoice', 'invoices'),
  ].filter(Boolean)
  return {
    removes,
    keeps: `Kept, under their name: ${[...kept, 'their allowance and pay records', 'and every report'].join(', ')}.`,
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/staff-tombstone.test.js`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/staff-tombstone.js src/lib/staff-tombstone.test.js
git commit -m "STAFFDELETE.1 — staff-tombstone lib: the shared predicate + pure decisions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 622 — columns, CHECK, and `tombstone_staff_profile`

House style for a migration that ships a function (`tests/migration-613/614/615-*.test.js`): boot an in-process Postgres (PGlite), recreate the minimum tables with their REAL column names and **REAL FK actions**, apply the REAL migration file, and drive the function as `service_role`. The CASCADE FKs below are copied from the catalog on purpose — they are what make "history survived" a meaningful assertion.

**Files:** Create `tests/migration-622-staff-tombstone.test.js`, `supabase/migrations/622_staff_tombstone.sql`.

- [ ] **Step 1: Write the failing test**

```js
// tests/migration-622-staff-tombstone.test.js
// STAFFDELETE.1 — behavioural test for migration 622, against the REAL file.
// Fixture names are invented (the repo is public).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_622 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/622_staff_tombstone.sql'), 'utf8')

const TODAY = '2026-09-19'
const LOC = 'a0000000-0000-0000-0000-00000000000a'
const GONE = '10000000-0000-0000-0000-000000000001'   // deactivated coach being deleted
const PEER = '10000000-0000-0000-0000-000000000002'
const MASTER = '10000000-0000-0000-0000-000000000009'
const TPL = '40000000-0000-0000-0000-000000000001'
const R_PUB = '60000000-0000-0000-0000-000000000001'
const R_DRAFT = '60000000-0000-0000-0000-000000000002'
const B_PAST = '20000000-0000-0000-0000-000000000001'
const B_PUB = '20000000-0000-0000-0000-000000000002'
const B_DRAFT = '20000000-0000-0000-0000-000000000003'
const A_PAST = '30000000-0000-0000-0000-000000000001'
const A_PUB = '30000000-0000-0000-0000-000000000002'
const A_DRAFT = '30000000-0000-0000-0000-000000000003'
const A_PEER = '30000000-0000-0000-0000-000000000004'
const S_MINE = '50000000-0000-0000-0000-000000000001'   // GONE asked PEER
const S_THEIRS = '50000000-0000-0000-0000-000000000002' // PEER asked GONE
const S_OLD = '50000000-0000-0000-0000-000000000003'    // approved long ago
const T_PAST = '70000000-0000-0000-0000-000000000001'
const T_PENDING = '70000000-0000-0000-0000-000000000002'
const T_EXPIRED = '70000000-0000-0000-0000-000000000003'
const T_APPROVED = '70000000-0000-0000-0000-000000000004'
const INV = '80000000-0000-0000-0000-000000000001'

// FK actions are the catalog's (mig 004, 010, 011, 023, 067, 101, 152, 236, 417,
// 485, 603, 607) — CASCADE where prod cascades, so a DELETE would show.
const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL, full_name text NOT NULL, role text NOT NULL DEFAULT 'staff',
    avatar_url text, active boolean DEFAULT true, permissions jsonb DEFAULT '{"dashboard": true}'::jsonb,
    two_factor_enabled boolean DEFAULT false, updated_at timestamptz DEFAULT now(),
    employment_type text NOT NULL DEFAULT 'fte', hourly_rate numeric,
    unifi_door_access boolean NOT NULL DEFAULT false, unifi_user_id text,
    pin_hash text UNIQUE, pin_set_at timestamptz, pin_failed_count int NOT NULL DEFAULT 0, pin_locked_until timestamptz,
    home_screen_path text NOT NULL DEFAULT '/dashboard', email_signature text, email_signature_rich jsonb
  );
  CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE, hourly_rate numeric);
  CREATE TABLE public.profile_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, location_id uuid NOT NULL REFERENCES public.locations(id), role text);
  CREATE TABLE public.profile_organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.device_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, expo_push_token text);
  CREATE TABLE public.widget_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, token_hash text);
  CREATE TABLE public.email_mailbox_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE);
  CREATE TABLE public.mobile_bar_prefs (profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, location_id uuid NOT NULL, PRIMARY KEY (profile_id, location_id));

  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, name text, start_time time, end_time time);
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text NOT NULL);
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id), template_id uuid REFERENCES public.shift_templates(id),
    block_date date NOT NULL, start_time time NOT NULL, end_time time NOT NULL, roster_id uuid REFERENCES public.rosters(id)
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY, block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    status text DEFAULT 'scheduled', start_time_override time, end_time_override time
  );
  CREATE TABLE public.shift_swap_requests (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    requester_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    requester_id uuid NOT NULL REFERENCES public.profiles(id),
    target_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    target_id uuid REFERENCES public.profiles(id),
    status text DEFAULT 'pending', reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz,
    review_note text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    type text, start_date date NOT NULL, end_date date NOT NULL, total_days numeric,
    status text NOT NULL DEFAULT 'pending', review_note text, updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.staff_allowances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, year int, total_days numeric, used_days numeric);
  CREATE TABLE public.schedule_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, type text);
  CREATE TABLE public.contractor_invoices (id uuid PRIMARY KEY, contractor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, invoice_amount numeric);
  CREATE TABLE public.roster_change_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, block_id uuid, block_date date,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL, coach_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    action text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, notified_at timestamptz
  );
  CREATE TABLE public.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category text NOT NULL, action text NOT NULL,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL, actor_label text,
    target_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL, target_label text,
    target_resource text, details jsonb
  );
  -- Stand-in for mig 191's audit_mutation trigger: it copies the OLD values
  -- (email, pin_hash) into audit_events on every profiles UPDATE, which is why
  -- the function must redact AFTER it strips.
  CREATE FUNCTION public.test_audit_profiles() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    INSERT INTO public.audit_events (category, action, target_resource, details)
    VALUES ('mutation', 'profiles.updated', 'profiles/' || NEW.id::text,
            jsonb_build_object('before', jsonb_build_object('email', OLD.email, 'pin_hash', OLD.pin_hash)));
    RETURN NULL;
  END $fn$;
  CREATE TRIGGER audit_mutation AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.test_audit_profiles();
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}', 'Studio One');
  INSERT INTO auth.users VALUES ('${GONE}', 'former.coach@example.test'), ('${PEER}', 'peer@example.test'), ('${MASTER}', 'master@example.test');
  INSERT INTO public.profiles (id, email, full_name, role, active, avatar_url, hourly_rate, unifi_user_id, pin_hash, email_signature) VALUES
    ('${GONE}', 'former.coach@example.test', 'Former Coach', 'staff', false, 'https://example.test/a.png', 25, 'unifi-1', 'hash-1', 'Sent from my phone'),
    ('${PEER}', 'peer@example.test', 'Peer Coach', 'staff', true, NULL, 22, NULL, NULL, NULL),
    ('${MASTER}', 'master@example.test', 'Master One', 'master', true, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO public.profile_compensation VALUES ('${GONE}', 25);
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${GONE}', '${LOC}', 'staff'), ('${PEER}', '${LOC}', 'staff');
  INSERT INTO public.profile_organizations (profile_id) VALUES ('${GONE}');
  INSERT INTO public.device_tokens (user_id, expo_push_token) VALUES ('${GONE}', 'ExponentPushToken[x]');
  INSERT INTO public.widget_tokens (profile_id, token_hash) VALUES ('${GONE}', 'h');
  INSERT INTO public.email_mailbox_access (profile_id) VALUES ('${GONE}');
  INSERT INTO public.mobile_bar_prefs VALUES ('${GONE}', '${LOC}');
  INSERT INTO public.shift_templates VALUES ('${TPL}', 'Morning', '06:00', '07:00');
  INSERT INTO public.rosters VALUES ('${R_PUB}', 'published'), ('${R_DRAFT}', 'draft');
  INSERT INTO public.shift_blocks VALUES
    ('${B_PAST}', '${LOC}', '${TPL}', '2026-09-01', '06:00', '09:00', '${R_PUB}'),
    ('${B_PUB}', '${LOC}', '${TPL}', '2026-10-05', '06:00', '09:00', '${R_PUB}'),
    ('${B_DRAFT}', '${LOC}', '${TPL}', '2026-10-06', '06:00', '09:00', '${R_DRAFT}');
  INSERT INTO public.shift_assignments (id, block_id, profile_id, start_time_override) VALUES
    ('${A_PAST}', '${B_PAST}', '${GONE}', NULL),
    ('${A_PUB}', '${B_PUB}', '${GONE}', '07:00'),
    ('${A_DRAFT}', '${B_DRAFT}', '${GONE}', NULL),
    ('${A_PEER}', '${B_PUB}', '${PEER}', NULL);
  INSERT INTO public.shift_swap_requests (id, location_id, requester_shift_id, requester_id, target_shift_id, target_id, status) VALUES
    ('${S_MINE}', '${LOC}', '${A_PUB}', '${GONE}', NULL, '${PEER}', 'pending'),
    ('${S_THEIRS}', '${LOC}', '${A_PEER}', '${PEER}', NULL, '${GONE}', 'awaiting_approval'),
    ('${S_OLD}', '${LOC}', '${A_PAST}', '${GONE}', NULL, '${PEER}', 'approved');
  INSERT INTO public.time_off_requests (id, profile_id, type, start_date, end_date, total_days, status) VALUES
    ('${T_PAST}', '${GONE}', 'holiday', '2026-06-01', '2026-06-05', 5, 'approved'),
    ('${T_PENDING}', '${GONE}', 'holiday', '2026-10-12', '2026-10-16', 5, 'pending'),
    ('${T_EXPIRED}', '${GONE}', 'sick', '2026-03-02', '2026-03-02', 1, 'pending'),
    ('${T_APPROVED}', '${GONE}', 'holiday', '2026-11-02', '2026-11-03', 2, 'approved');
  INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days) VALUES ('${GONE}', 2026, 20, 7);
  INSERT INTO public.schedule_notifications (profile_id, type) VALUES ('${GONE}', 'shift_published');
  INSERT INTO public.contractor_invoices VALUES ('${INV}', '${GONE}', 480);
  INSERT INTO public.audit_events (category, action, actor_id, actor_label, details) VALUES
    ('business', 'contract.issued', '${GONE}', 'Former Coach <former.coach@example.test>', '{}'),
    ('auth', 'auth.sign_in', '${GONE}', 'Former Coach <former.coach@example.test>', '{"ok": true, "email": "former.coach@example.test"}');
`

let db
// PGlite's multi-statement SQL runner (PGlite#exec — a SQL call, no shell).
const runSql = (text) => db.exec(text)
const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const count = async (table, where) => Number((await rows(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n)

/** Call the function as service_role in its own tx; a raise rolls back. */
async function tombstone(id = GONE, { actor = MASTER, dryRun = false } = {}) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE service_role')
    const res = await db.query('SELECT public.tombstone_staff_profile($1, $2, $3, $4) AS summary', [id, actor, TODAY, dryRun])
    await runSql('COMMIT')
    return res.rows[0].summary
  } catch (e) {
    await runSql('ROLLBACK')
    throw e
  }
}

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_622)
  await runSql('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role')
}, 60_000)

beforeEach(async () => {
  await runSql('DROP TRIGGER IF EXISTS fail_strip ON public.profiles')
  await runSql('TRUNCATE auth.users, public.locations, public.shift_templates, public.rosters, public.audit_events, public.roster_change_log CASCADE')
  await runSql(SEED)
})

afterAll(async () => { await db?.close() })

describe('mig 622 — why the auth user is never deleted', () => {
  it('deleting auth.users cascades through profiles and takes the history with it', async () => {
    // The NO ACTION swap FKs would refuse the delete outright — the old route
    // nulled such columns first, which is what opened the door to the cascade.
    await runSql('DELETE FROM public.shift_swap_requests')
    await runSql(`DELETE FROM auth.users WHERE id = '${GONE}'`)
    expect(await count('public.contractor_invoices', `id = '${INV}'`)).toBe(0)
    expect(await count('public.shift_assignments', `id = '${A_PAST}'`)).toBe(0)
    expect(await count('public.time_off_requests', `id = '${T_PAST}'`)).toBe(0)
  })
})

describe('mig 622 — tombstone_staff_profile', () => {
  it('dry run reports what would happen and writes nothing', async () => {
    const s = await tombstone(GONE, { dryRun: true })
    expect(s.dry_run).toBe(true)
    expect(s.removed_shifts.map((x) => x.assignment_id)).toEqual([A_PUB, A_DRAFT])
    expect(s.removed_shifts[0]).toMatchObject({ block_date: '2026-10-05', start_time: '07:00:00', end_time: '09:00:00', template_name: 'Morning', location_name: 'Studio One', roster_status: 'published' })
    expect(s.cancelled_swaps.map((x) => x.id).sort()).toEqual([S_MINE, S_THEIRS])
    expect(s.cancelled_time_off.map((x) => x.id)).toEqual([T_PENDING])
    expect(s.kept).toMatchObject({ past_shifts: 1, time_off_requests: 4, staff_allowances: 1, contractor_invoices: 1 })
    expect(await count('public.shift_assignments', `profile_id = '${GONE}'`)).toBe(3)
    expect((await rows(`SELECT deleted_at, email FROM public.profiles WHERE id = '${GONE}'`))[0]).toEqual({ deleted_at: null, email: 'former.coach@example.test' })
  })

  it('removes UPCOMING shifts only (published and draft); past shifts and other people are untouched', async () => {
    await tombstone()
    expect((await rows('SELECT id FROM public.shift_assignments ORDER BY id')).map((r) => r.id)).toEqual([A_PAST, A_PEER])
  })

  it('logs one roster change per PUBLISHED removal, already stamped notified', async () => {
    await tombstone()
    const log = await rows('SELECT block_id, block_date::text AS block_date, actor_id, coach_id, action, details, notified_at FROM public.roster_change_log')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ block_id: B_PUB, block_date: '2026-10-05', actor_id: MASTER, coach_id: GONE, action: 'unassigned', details: { reason: 'staff_permanent_delete' } })
    expect(log[0].notified_at).not.toBeNull()
  })

  it('cancels open swaps on either side; decided swaps are history', async () => {
    await tombstone()
    const swaps = Object.fromEntries((await rows('SELECT id, status, reviewed_by, review_note, requester_shift_id FROM public.shift_swap_requests')).map((r) => [r.id, r]))
    expect(swaps[S_MINE]).toMatchObject({ status: 'cancelled', reviewed_by: MASTER, requester_shift_id: null })
    expect(swaps[S_MINE].review_note).toContain('permanently deleted')
    expect(swaps[S_THEIRS]).toMatchObject({ status: 'cancelled', requester_shift_id: A_PEER })
    expect(swaps[S_OLD]).toMatchObject({ status: 'approved', reviewed_by: null, review_note: null })
  })

  it('cancels pending leave that is still ahead; expired-pending and decided leave are history', async () => {
    await tombstone()
    const leave = Object.fromEntries((await rows('SELECT id, status FROM public.time_off_requests')).map((r) => [r.id, r.status]))
    expect(leave).toEqual({ [T_PAST]: 'approved', [T_PENDING]: 'cancelled', [T_EXPIRED]: 'pending', [T_APPROVED]: 'approved' })
    expect((await rows(`SELECT used_days::int AS used FROM public.staff_allowances WHERE profile_id = '${GONE}'`))[0].used).toBe(7)
  })

  it('HISTORY STAYS, BY NAME — every cascading table still has its row and still joins to the name', async () => {
    const before = (await tombstone(GONE, { dryRun: true })).kept
    const after = (await tombstone()).kept
    expect(after).toEqual(before)
    const named = await rows(`
      SELECT 'invoice' AS what, p.full_name FROM public.contractor_invoices i JOIN public.profiles p ON p.id = i.contractor_id
      UNION ALL SELECT 'shift', p.full_name FROM public.shift_assignments a JOIN public.profiles p ON p.id = a.profile_id WHERE a.id = '${A_PAST}'
      UNION ALL SELECT 'leave', p.full_name FROM public.time_off_requests t JOIN public.profiles p ON p.id = t.profile_id WHERE t.id = '${T_PAST}'
      UNION ALL SELECT 'allowance', p.full_name FROM public.staff_allowances s JOIN public.profiles p ON p.id = s.profile_id
      UNION ALL SELECT 'notification', p.full_name FROM public.schedule_notifications n JOIN public.profiles p ON p.id = n.profile_id
      UNION ALL SELECT 'pay', p.full_name FROM public.profile_compensation c JOIN public.profiles p ON p.id = c.profile_id`)
    expect(named.map((r) => r.what).sort()).toEqual(['allowance', 'invoice', 'leave', 'notification', 'pay', 'shift'])
    expect(new Set(named.map((r) => r.full_name))).toEqual(new Set(['Former Coach']))
  })

  it('strips PII and credentials, keeps name / role / employment / pay, stamps who and when', async () => {
    await tombstone()
    const p = (await rows(`SELECT * FROM public.profiles WHERE id = '${GONE}'`))[0]
    expect(p).toMatchObject({
      email: `deleted+${GONE}@deleted.invalid`, full_name: 'Former Coach', role: 'staff', employment_type: 'fte',
      active: false, avatar_url: null, pin_hash: null, unifi_user_id: null, unifi_door_access: false,
      email_signature: null, email_signature_rich: null, permissions: {}, deleted_by: MASTER,
    })
    expect(Number(p.hourly_rate)).toBe(25)
    expect(p.deleted_at).not.toBeNull()
  })

  it('deletes every access row and token — so no location-scoped list can contain a tombstone', async () => {
    const s = await tombstone()
    for (const [table, col] of [['profile_locations', 'profile_id'], ['profile_organizations', 'profile_id'], ['device_tokens', 'user_id'], ['widget_tokens', 'profile_id'], ['email_mailbox_access', 'profile_id'], ['mobile_bar_prefs', 'profile_id']]) {
      expect(await count(`public.${table}`, `${col} = '${GONE}'`)).toBe(0)
    }
    expect(s.deleted).toEqual({ profile_locations: 1, profile_organizations: 1, device_tokens: 1, widget_tokens: 1, email_mailbox_access: 1, mobile_bar_prefs: 1 })
    expect(await count('public.profile_locations', `profile_id = '${PEER}'`)).toBe(1)
  })

  it('redacts what the audit trigger re-saved, and the email in older audit rows', async () => {
    await tombstone()
    const all = JSON.stringify(await rows('SELECT actor_label, target_label, details FROM public.audit_events'))
    expect(all).not.toContain('former.coach@example.test')
    expect(all).not.toContain('hash-1')
    expect(await count('public.audit_events', `actor_id = '${GONE}' AND actor_label = 'Former Coach'`)).toBe(2)
    expect(await count('public.audit_events', `category = 'mutation' AND details = '{"redacted": "staff_permanent_delete"}'::jsonb`)).toBe(1)
  })

  it('refuses an active profile, a second delete, a missing profile and a self-delete', async () => {
    await expect(tombstone(PEER)).rejects.toThrow(/staff_still_active/)
    await tombstone()
    await expect(tombstone()).rejects.toThrow(/staff_already_deleted/)
    await expect(tombstone('10000000-0000-0000-0000-0000000000ff')).rejects.toThrow(/staff_not_found/)
    await expect(tombstone(MASTER, { actor: MASTER })).rejects.toThrow(/staff_self_delete/)
  })

  it('is atomic — a failure at the strip rolls the shift removals back', async () => {
    await runSql(`
      CREATE OR REPLACE FUNCTION public.fail_strip_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'strip failed'; END $fn$;
      CREATE TRIGGER fail_strip BEFORE UPDATE ON public.profiles
        FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION public.fail_strip_fn();`)
    await expect(tombstone()).rejects.toThrow(/strip failed/)
    expect(await count('public.shift_assignments', `profile_id = '${GONE}'`)).toBe(3)
    expect(await count('public.profile_locations', `profile_id = '${GONE}'`)).toBe(1)
  })

  it('the database refuses to reactivate a tombstone', async () => {
    await tombstone()
    await expect(runSql(`UPDATE public.profiles SET active = true WHERE id = '${GONE}'`)).rejects.toThrow(/profiles_tombstone_is_inactive/)
  })

  it('EXECUTE is service_role only', async () => {
    const sig = 'public.tombstone_staff_profile(uuid, uuid, date, boolean)'
    const p = (await rows(`SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') AS svc, has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS auth, has_function_privilege('anon', '${sig}', 'EXECUTE') AS anon`))[0]
    expect(p).toEqual({ svc: true, auth: false, anon: false })
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/migration-622-staff-tombstone.test.js`
Expected: the file fails to load — `ENOENT: no such file or directory, open '…/supabase/migrations/622_staff_tombstone.sql'`.

- [ ] **Step 3: Write the migration (full SQL)**

Create `supabase/migrations/622_staff_tombstone.sql`:

```sql
-- 622 — STAFFDELETE.1: a permanently deleted staff member becomes a TOMBSTONE.
--
-- WHY. DELETE /api/staff/[id]/permanent deleted the profiles row. profiles.id
-- is REFERENCES auth.users(id) ON DELETE CASCADE (mig 004:36), and these all
-- CASCADE off profiles: shift_assignments.profile_id (067),
-- time_off_requests.profile_id + staff_allowances.profile_id (011),
-- schedule_notifications.profile_id (010), contractor_invoices.contractor_id
-- (101:19), profile_compensation.profile_id (152), fte_expense_claims (183),
-- card_receipts (266), policy_acknowledgements (178), checklist_instances
-- (215), assignment_change_log.target_profile_id (080). So "permanent delete"
-- destroyed the payroll, leave and invoice history the business must keep,
-- while the route's own header promised the opposite.
--
-- OWNER'S DECISION: permanent delete removes the person from UPCOMING shifts
-- only and must NOT change history; past shifts, leave, invoices and reports
-- stay look-up-able and reportable BY NAME.
--
-- WHAT THIS FILE DOES
--   1. profiles.deleted_at / deleted_by, and a CHECK that a tombstone is never
--      active — so a reactivation is refused by the database, not just the UI.
--   2. public.tombstone_staff_profile(profile, actor, today, dry_run): ONE
--      transaction that removes upcoming assignments (logging the published
--      ones), cancels open swaps and still-ahead pending leave, deletes access
--      rows and tokens, strips PII from the profile while KEEPING full_name,
--      role, employment_type and pay, and redacts the PII that the mig 191
--      audit trigger re-saves while it does so. dry_run returns the same
--      summary and writes nothing.
--   It never deletes from profiles, and nothing here touches auth.users: the
--   route bans the auth user instead, because deleting it would cascade
--   straight back through profiles.
--
-- SAFE ALONE: yes. Nullable columns, a CHECK every existing row passes, one
-- partial index, a function nobody calls until the code deploys. Apply BEFORE
-- merging the code: excludeTombstones() filters on deleted_at and PostgREST
-- 400s on a column that does not exist.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; run them and keep the output)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) The FK truth, from the live catalog. Compare with the table in
--     docs/superpowers/plans/2026-09-19-scheduler-wave1/09-STAFFDELETE.1.md.
--     confdeltype: c=CASCADE n=SET NULL r=RESTRICT a=NO ACTION.
--
--       SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.confdeltype
--         FROM pg_constraint c
--         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
--        WHERE c.contype = 'f' AND c.confrelid = 'public.profiles'::regclass
--        ORDER BY c.confdeltype, 1, 2;
--     Expected: ~131 rows (24 CASCADE, 48 NO ACTION, 2 RESTRICT, 57 SET NULL by the migrations). Any CASCADE table NOT in the plan's table is a
--     history table this design already protects (nothing is deleted) — note
--     it, do not stop. A NEW access/credential table is worth adding to
--     section 7 of the function in a follow-up.
--
-- (b) profiles.id -> auth.users must read 'c' (CASCADE). That is the reason
--     the auth user is banned, never deleted:
--
--       SELECT confdeltype FROM pg_constraint
--        WHERE conrelid = 'public.profiles'::regclass AND contype = 'f'
--          AND confrelid = 'auth.users'::regclass;
--
-- (c) Has the OLD route half-run in prod? It writes its audit row and nulls
--     ~21 attribution columns BEFORE failing on the dropped public.shifts:
--
--       SELECT to_regclass('public.shifts') AS shifts_table;   -- expected NULL (mig 238)
--       SELECT l.created_at, l.actor_id, l.target_profile_id, (p.id IS NOT NULL) AS profile_still_exists
--         FROM public.assignment_change_log l
--         LEFT JOIN public.profiles p ON p.id = l.target_profile_id
--        WHERE l.action = 'permanent_delete' ORDER BY l.created_at DESC;
--     Expected: zero rows, or rows whose profile_still_exists = true (attempts
--     that aborted). A row cannot show profile_still_exists = false — the log
--     row cascades with the profile — so a COMPLETED old delete leaves no
--     trace here at all. Report what you see to the owner either way.
--
-- (d) Every table the function touches exists:
--
--       SELECT t, to_regclass('public.' || t) IS NOT NULL AS ok
--         FROM unnest(ARRAY['shift_assignments','shift_blocks','rosters','shift_templates','locations',
--           'shift_swap_requests','time_off_requests','staff_allowances','contractor_invoices',
--           'schedule_notifications','roster_change_log','profile_locations','profile_organizations',
--           'device_tokens','widget_tokens','email_mailbox_access','mobile_bar_prefs','audit_events']) AS t;
--     Expected: ok = true on every row. A false one makes the FUNCTION fail at
--     call time (not this file) — stop and fix the name.
--
-- (e) Baseline for the first real delete — run for the profile you are about
--     to delete and KEEP the numbers; (h) below must reproduce them:
--
--       SELECT (SELECT count(*) FROM public.shift_assignments a JOIN public.shift_blocks b ON b.id = a.block_id
--                WHERE a.profile_id = :id AND b.block_date <  (now() AT TIME ZONE 'Europe/Dublin')::date) AS past_shifts,
--              (SELECT count(*) FROM public.shift_assignments a JOIN public.shift_blocks b ON b.id = a.block_id
--                WHERE a.profile_id = :id AND b.block_date >= (now() AT TIME ZONE 'Europe/Dublin')::date) AS upcoming_shifts,
--              (SELECT count(*) FROM public.time_off_requests   WHERE profile_id = :id)    AS leave_rows,
--              (SELECT count(*) FROM public.staff_allowances    WHERE profile_id = :id)    AS allowance_rows,
--              (SELECT count(*) FROM public.contractor_invoices WHERE contractor_id = :id) AS invoices;
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (f) SELECT column_name FROM information_schema.columns
--      WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('deleted_at','deleted_by');  -- 2 rows
--     SELECT conname FROM pg_constraint WHERE conname = 'profiles_tombstone_is_inactive';                     -- 1 row
--     SELECT has_function_privilege('authenticated', 'public.tombstone_staff_profile(uuid, uuid, date, boolean)', 'EXECUTE');  -- false
--     SELECT count(*) FROM public.profiles WHERE deleted_at IS NOT NULL;                                      -- 0
-- (g) get_advisors (type = security). Expected: nothing new.
--
-- AFTER THE FIRST REAL DELETE (code deployed):
-- (h) Re-run (e): past_shifts, leave_rows, allowance_rows, invoices UNCHANGED;
--     upcoming_shifts = 0.
-- (i) SELECT full_name, email, active, deleted_at, deleted_by, avatar_url, pin_hash FROM public.profiles WHERE id = :id;
--     -- name intact, email 'deleted+<id>@deleted.invalid', active false, deleted_* set, the rest NULL
--     SELECT email, banned_until FROM auth.users WHERE id = :id;
--     -- scrambled + banned_until ~100 years out, UNLESS the response said auth = kept_*
--     SELECT count(*) FROM public.profile_locations WHERE profile_id = :id;   -- 0
--     SELECT p.full_name, count(*) FROM public.shift_assignments a JOIN public.profiles p ON p.id = a.profile_id
--      WHERE a.profile_id = :id GROUP BY 1;                                    -- their name, past_shifts

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.deleted_at IS
  'STAFFDELETE.1 (mig 622): set = TOMBSTONE. The person was permanently deleted: PII stripped, access rows gone, auth user banned, full_name kept so history stays reportable by name. Readers that list profiles must exclude these (src/lib/staff-tombstone.js). Never DELETE the row: ~25 tables cascade off it.';
COMMENT ON COLUMN public.profiles.deleted_by IS
  'STAFFDELETE.1 (mig 622): the master who ran the permanent delete.';

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_tombstone_is_inactive;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_tombstone_is_inactive CHECK (deleted_at IS NULL OR active IS FALSE);

CREATE INDEX IF NOT EXISTS idx_profiles_deleted_by
  ON public.profiles (deleted_by) WHERE deleted_by IS NOT NULL;

-- ERRORS (all P0001; the message prefix is the contract the route maps):
--   staff_bad_args, staff_self_delete, staff_not_found, staff_already_deleted,
--   staff_still_active.
-- SECURITY: SECURITY INVOKER, search_path pinned empty, every name
-- schema-qualified, EXECUTE for service_role only (mig 496/612 posture).
CREATE OR REPLACE FUNCTION public.tombstone_staff_profile(
  p_profile_id uuid,
  p_actor_id   uuid,
  p_today      date,
  p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_profile public.profiles;
  v_shifts  jsonb;
  v_swaps   jsonb;
  v_leave   jsonb;
  v_kept    jsonb;
  v_deleted jsonb := '{}'::jsonb;
  v_pl_res  text[];
  v_n       integer;
  v_now     timestamptz := now();
  v_note    constant text := 'Cancelled automatically: staff member permanently deleted';
BEGIN
  IF p_profile_id IS NULL OR p_actor_id IS NULL OR p_today IS NULL THEN
    RAISE EXCEPTION 'staff_bad_args: profile, actor and today are all required';
  END IF;
  IF p_profile_id = p_actor_id THEN
    RAISE EXCEPTION 'staff_self_delete: you cannot permanently delete your own account';
  END IF;

  -- 1. Lock the row and re-check the pre-flight inside the transaction.
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_not_found: no profile %', p_profile_id;
  END IF;
  IF v_profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'staff_already_deleted: profile % was deleted at %', p_profile_id, v_profile.deleted_at;
  END IF;
  IF v_profile.active IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'staff_still_active: deactivate the profile before deleting it';
  END IF;

  -- 2. What goes. Upcoming LIVE assignments, with the EFFECTIVE times
  --    (override, else block, else template) the calendar shows.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'assignment_id', a.id, 'block_id', b.id, 'block_date', b.block_date,
           'start_time', COALESCE(a.start_time_override, b.start_time, t.start_time),
           'end_time',   COALESCE(a.end_time_override,   b.end_time,   t.end_time),
           'template_name', t.name, 'location_id', b.location_id, 'location_name', l.name,
           'roster_status', r.status)
           ORDER BY b.block_date, COALESCE(a.start_time_override, b.start_time, t.start_time), a.id), '[]'::jsonb)
    INTO v_shifts
    FROM public.shift_assignments a
    JOIN public.shift_blocks b ON b.id = a.block_id
    LEFT JOIN public.rosters r ON r.id = b.roster_id
    LEFT JOIN public.shift_templates t ON t.id = b.template_id
    LEFT JOIN public.locations l ON l.id = b.location_id
   WHERE a.profile_id = p_profile_id
     AND b.block_date >= p_today
     AND a.status IS DISTINCT FROM 'cancelled';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', s.id, 'location_id', s.location_id, 'requester_id', s.requester_id,
           'target_id', s.target_id, 'status', s.status) ORDER BY s.id), '[]'::jsonb)
    INTO v_swaps
    FROM public.shift_swap_requests s
   WHERE s.status IN ('pending', 'awaiting_approval')
     AND (s.requester_id = p_profile_id OR s.target_id = p_profile_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', o.id, 'type', o.type, 'start_date', o.start_date, 'end_date', o.end_date) ORDER BY o.start_date, o.id), '[]'::jsonb)
    INTO v_leave
    FROM public.time_off_requests o
   WHERE o.profile_id = p_profile_id AND o.status = 'pending' AND o.end_date >= p_today;

  -- 3. What stays — counted so the caller can PROVE history did not move.
  v_kept := jsonb_build_object(
    'past_shifts', (SELECT count(*) FROM public.shift_assignments a JOIN public.shift_blocks b ON b.id = a.block_id
                     WHERE a.profile_id = p_profile_id AND b.block_date < p_today),
    'time_off_requests',      (SELECT count(*) FROM public.time_off_requests      WHERE profile_id = p_profile_id),
    'staff_allowances',       (SELECT count(*) FROM public.staff_allowances       WHERE profile_id = p_profile_id),
    'contractor_invoices',    (SELECT count(*) FROM public.contractor_invoices    WHERE contractor_id = p_profile_id),
    'schedule_notifications', (SELECT count(*) FROM public.schedule_notifications WHERE profile_id = p_profile_id));

  IF p_dry_run THEN
    RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', true,
      'removed_shifts', v_shifts, 'cancelled_swaps', v_swaps, 'cancelled_time_off', v_leave,
      'deleted', v_deleted, 'kept', v_kept);
  END IF;

  -- 4. Upcoming shifts. One change-log row per PUBLISHED removal (draft edits
  --    are never logged — SCHEDULE-CHANGE-LOG.1). notified_at is stamped: the
  --    re-publish safety net re-notifies the coach of any unstamped row, and
  --    this coach is gone.
  INSERT INTO public.roster_change_log (location_id, block_id, block_date, actor_id, coach_id, action, details, notified_at)
  SELECT (x->>'location_id')::uuid, (x->>'block_id')::uuid, (x->>'block_date')::date,
         p_actor_id, p_profile_id, 'unassigned', jsonb_build_object('reason', 'staff_permanent_delete'), v_now
    FROM jsonb_array_elements(v_shifts) AS x
   WHERE x->>'roster_status' = 'published' AND (x->>'location_id') IS NOT NULL;

  --    Swap history survives this delete: both shift pointers on
  --    shift_swap_requests are ON DELETE SET NULL since mig 603.
  DELETE FROM public.shift_assignments a
   USING public.shift_blocks b
   WHERE b.id = a.block_id AND a.profile_id = p_profile_id AND b.block_date >= p_today;

  -- 5. Open swaps they are on either side of.
  UPDATE public.shift_swap_requests
     SET status = 'cancelled', reviewed_by = p_actor_id, reviewed_at = v_now, updated_at = v_now,
         review_note = CASE WHEN COALESCE(review_note, '') = '' THEN v_note ELSE review_note || ' · ' || v_note END
   WHERE status IN ('pending', 'awaiting_approval')
     AND (requester_id = p_profile_id OR target_id = p_profile_id);

  -- 6. Pending leave that is still ahead. pending -> cancelled never touches
  --    the allowance (the mig 011/616 trigger only reacts to 'approved').
  UPDATE public.time_off_requests
     SET status = 'cancelled', updated_at = v_now,
         review_note = CASE WHEN COALESCE(review_note, '') = '' THEN v_note ELSE review_note || ' · ' || v_note END
   WHERE profile_id = p_profile_id AND status = 'pending' AND end_date >= p_today;

  -- 7. Access rows and tokens. profile_locations ids are remembered first:
  --    the mig 191 audit trigger logs each delete under that resource name.
  SELECT COALESCE(array_agg('profile_locations/' || pl.id::text), ARRAY[]::text[])
    INTO v_pl_res FROM public.profile_locations pl WHERE pl.profile_id = p_profile_id;

  DELETE FROM public.profile_locations WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('profile_locations', v_n);
  DELETE FROM public.profile_organizations WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('profile_organizations', v_n);
  DELETE FROM public.device_tokens WHERE user_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('device_tokens', v_n);
  DELETE FROM public.widget_tokens WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('widget_tokens', v_n);
  DELETE FROM public.email_mailbox_access WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('email_mailbox_access', v_n);
  DELETE FROM public.mobile_bar_prefs WHERE profile_id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('mobile_bar_prefs', v_n);

  -- 8. The tombstone. KEPT on purpose: full_name, role, employment_type,
  --    created_at, and the pay columns (+ the profile_compensation row, which
  --    is not touched) — staff_cost and the week-cost panels cost PAST shifts
  --    from the person's rate; clearing it would rewrite history as EUR 0.
  UPDATE public.profiles
     SET email = 'deleted+' || p_profile_id::text || '@deleted.invalid',
         avatar_url = NULL,
         permissions = '{}'::jsonb,
         two_factor_enabled = false,
         pin_hash = NULL, pin_set_at = NULL, pin_failed_count = 0, pin_locked_until = NULL,
         home_screen_path = '/dashboard',
         unifi_door_access = false, unifi_user_id = NULL,
         email_signature = NULL, email_signature_rich = NULL,
         deleted_at = v_now, deleted_by = p_actor_id, updated_at = v_now
   WHERE id = p_profile_id;

  -- 9. Redact what auditing captured. The mig 191 trigger has just written the
  --    OLD email / pin_hash / door ids into audit_events.details for the rows
  --    above; older rows carry "Name <email>" labels and sign-in emails. The
  --    rows stay (who did what, when) — the values go.
  UPDATE public.audit_events
     SET details = jsonb_build_object('redacted', 'staff_permanent_delete')
   WHERE category = 'mutation'
     AND (target_resource = 'profiles/' || p_profile_id::text OR target_resource = ANY (v_pl_res));
  UPDATE public.audit_events SET actor_label = v_profile.full_name
   WHERE actor_id = p_profile_id AND actor_label IS NOT NULL AND actor_label IS DISTINCT FROM v_profile.full_name;
  UPDATE public.audit_events SET target_label = v_profile.full_name
   WHERE target_profile_id = p_profile_id AND target_label IS NOT NULL AND target_label IS DISTINCT FROM v_profile.full_name;
  UPDATE public.audit_events SET details = details - 'email'
   WHERE category = 'auth' AND (actor_id = p_profile_id OR target_profile_id = p_profile_id) AND details ? 'email';

  RETURN jsonb_build_object('profile_id', p_profile_id, 'full_name', v_profile.full_name, 'dry_run', false,
    'removed_shifts', v_shifts, 'cancelled_swaps', v_swaps, 'cancelled_time_off', v_leave,
    'deleted', v_deleted, 'kept', v_kept);
END;
$$;

COMMENT ON FUNCTION public.tombstone_staff_profile(uuid, uuid, date, boolean) IS
  'STAFFDELETE.1 (mig 622) — permanent delete that keeps history. One transaction: removes UPCOMING assignments (logging published ones), cancels open swaps and still-ahead pending leave, deletes access rows/tokens, strips PII from the profile but keeps full_name/role/pay, redacts audit payloads. p_dry_run returns the same summary and writes nothing. Never deletes from profiles. Errors are P0001 with a staff_* prefix. service_role only.';

REVOKE ALL ON FUNCTION public.tombstone_staff_profile(uuid, uuid, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tombstone_staff_profile(uuid, uuid, date, boolean) TO service_role;
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run tests/migration-622-staff-tombstone.test.js`
Expected: 14 passed (this SQL and this test were run together under PGlite while writing the plan; the run takes about a second). If a `block_date` assertion fails showing a timestamp, a `date` column was typed `timestamptz` in `BASE_SCHEMA` by mistake — `jsonb_build_object` renders a `date` as `YYYY-MM-DD`.

- [ ] **Step 5: The schema checkers must accept the file**

Run: `npm run check:select-columns && npm run check:rls-restrictive && npm run check:bundle-sql`
Expected: all exit 0 (`check:select-columns` replays every migration, this one included; there are no policy changes here).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/622_staff_tombstone.sql tests/migration-622-staff-tombstone.test.js
git commit -m "STAFFDELETE.1 — mig 622: profiles tombstone columns + tombstone_staff_profile()

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Rewrite the route — GET previews, DELETE tombstones

**Files:** Create `src/app/api/staff/[id]/permanent/route.test.js`. Rewrite `src/app/api/staff/[id]/permanent/route.js` (whole file).

- [ ] **Step 1: Write the failing tests**

```js
// src/app/api/staff/[id]/permanent/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/unifi-access', () => ({
  getUnifiConfig: vi.fn(async () => ({ configured: false })),
  revokeUnifiUserPolicies: vi.fn(),
  UnifiError: class UnifiError extends Error {},
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', () => ({
  notifyUsersOnce: vi.fn(async () => ({})),
  notifyUsersAtRolesOnce: vi.fn(async () => ({})),
}))
vi.mock('@/lib/dublin-time', () => ({ dublinTodayStr: () => '2026-09-19' }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { notifyUsersOnce, notifyUsersAtRolesOnce } = await import('@/lib/push-dedup')
const { fakeDb, queriesOf } = await import('@/lib/time-off.test-helpers')
const { GET, DELETE } = await import('./route.js')

const ID = '10000000-0000-0000-0000-000000000001'
const MASTER = { id: 'master-1', isMaster: true, full_name: 'Master One', email: 'master@example.test' }
const PROFILE = {
  id: ID, email: 'former.coach@example.test', full_name: 'Former Coach', role: 'staff', active: false, deleted_at: null,
  profile_locations: [{ location_id: 'loc-1', role: 'staff', unifi_door_access: false, locations: { id: 'loc-1', name: 'Studio One' } }],
}
const SUMMARY = {
  profile_id: ID, full_name: 'Former Coach', dry_run: false,
  removed_shifts: [
    { assignment_id: 'a1', block_date: '2026-10-05', location_id: 'loc-1', roster_status: 'published' },
    { assignment_id: 'a2', block_date: '2026-10-06', location_id: 'loc-1', roster_status: 'draft' },
  ],
  cancelled_swaps: [{ id: 's1', requester_id: 'peer-1', target_id: ID, location_id: 'loc-1' }],
  cancelled_time_off: [],
  deleted: { profile_locations: 1 },
  kept: { past_shifts: 40, time_off_requests: 3, contractor_invoices: 2 },
}

function makeDb({ profile = PROFILE, rpcData = SUMMARY, rpcError = null, contact = null, hostUser = null, identityError = null, authError = null } = {}) {
  const db = fakeDb((q) => {
    if (q.table === 'profiles' && q.action === 'select') return { data: profile, error: profile ? null : { message: 'no rows' } }
    if (q.table === 'contacts') return { data: contact, error: identityError }
    if (q.table === 'host_users') return { data: hostUser, error: identityError }
    if (q.table === 'assignment_change_log' && q.action === 'insert') return { data: null, error: null }
    throw new Error(`unexpected ${q.action} on ${q.table}`)
  })
  db.rpc = vi.fn(async () => ({ data: rpcData, error: rpcError }))
  db.auth = { admin: { updateUserById: vi.fn(async () => ({ data: {}, error: authError })), deleteUser: vi.fn() } }
  const remove = vi.fn(async () => ({ error: null }))
  db.storage = { from: vi.fn(() => ({ list: async () => ({ data: [{ name: 'photo.jpg' }], error: null }), remove })) }
  db.__remove = remove
  return db
}

const req = () => new Request(`http://localhost/api/staff/${ID}/permanent`, { method: 'DELETE' })
const props = { params: Promise.resolve({ id: ID }) }

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(MASTER) })

describe('DELETE /api/staff/[id]/permanent — guards', () => {
  it('401 / 403 / 400-self, and nothing is called', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(null)
    expect((await DELETE(req(), props)).status).toBe(401)
    getCurrentUser.mockResolvedValue({ id: 'o', isMaster: false })
    expect((await DELETE(req(), props)).status).toBe(403)
    getCurrentUser.mockResolvedValue({ ...MASTER, id: ID })
    expect((await DELETE(req(), props)).status).toBe(400)
    expect(db.rpc).not.toHaveBeenCalled()
  })
  it('400 while still active; 404 for a missing profile AND for one already deleted', async () => {
    let db = makeDb({ profile: { ...PROFILE, active: true } }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(400)
    db = makeDb({ profile: null }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(404)
    db = makeDb({ profile: { ...PROFILE, deleted_at: '2026-09-01T00:00:00Z' } }); createServerClient.mockReturnValue(db)
    expect((await DELETE(req(), props)).status).toBe(404)
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/staff/[id]/permanent — the tombstone', () => {
  it('calls the function with the Dublin day, and NEVER deletes the profile or the auth user', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    const res = await DELETE(req(), props)
    expect(res.status).toBe(200)
    expect(db.rpc).toHaveBeenCalledWith('tombstone_staff_profile', {
      p_profile_id: ID, p_actor_id: 'master-1', p_today: '2026-09-19', p_dry_run: false,
    })
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled()
    expect(db.queries.filter((q) => q.action === 'delete')).toEqual([])
    // The hand-written FK null-out list is gone: no attribution column is touched.
    expect(db.queries.filter((q) => q.action === 'update')).toEqual([])
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { auth: 'ban', removed_shifts: SUMMARY.removed_shifts, kept: SUMMARY.kept } })
  })

  it('bans and scrambles a staff-only login', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    const [id, attrs] = db.auth.admin.updateUserById.mock.calls[0]
    expect(id).toBe(ID)
    expect(attrs).toMatchObject({ email: `deleted+${ID}@deleted.invalid`, email_confirm: true, ban_duration: '876000h', user_metadata: { full_name: null } })
    expect(attrs.password).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves the login alone when the same person is a member, a host, or we could not tell', async () => {
    for (const [opts, expected] of [
      [{ contact: { id: 'c1' } }, 'kept_member_login'],
      [{ hostUser: { host_id: 'h1' } }, 'kept_host_login'],
      [{ identityError: { message: 'boom' } }, 'kept_unverified'],
    ]) {
      const db = makeDb(opts); createServerClient.mockReturnValue(db)
      const body = await (await DELETE(req(), props)).json()
      expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
      expect(body.data.auth).toBe(expected)
      expect(body.warning).toBeTruthy()
    }
  })

  it('maps the function\'s errors and stops before touching auth, storage or the log', async () => {
    const db = makeDb({ rpcData: null, rpcError: { message: 'staff_still_active: deactivate the profile before deleting it' } })
    createServerClient.mockReturnValue(db)
    const res = await DELETE(req(), props)
    expect(res.status).toBe(400)
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
  })

  it('a failed ban is a WARNING, not a failure — the tombstone already exists', async () => {
    const db = makeDb({ authError: { message: 'gotrue down' } }); createServerClient.mockReturnValue(db)
    const body = await (await DELETE(req(), props)).json()
    expect(body.success).toBe(true)
    expect(body.warning).toContain('gotrue down')
  })

  it('records role history WITHOUT the email, after the function succeeded', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    const [log] = queriesOf(db, 'assignment_change_log', 'insert')
    expect(log.payload).toMatchObject({ actor_id: 'master-1', target_profile_id: ID, action: 'permanent_delete' })
    expect(log.payload.before).toEqual({ full_name: 'Former Coach', role: 'staff', assignments: [{ location_id: 'loc-1', location_name: 'Studio One', role: 'staff' }] })
    expect(JSON.stringify(log.payload)).not.toContain('example.test')
  })

  it('tells each studio\'s managers what needs cover (published only) and the other side of each cancelled swap', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    expect(notifyUsersAtRolesOnce).toHaveBeenCalledTimes(1)
    const [, key, locationId, , payload] = notifyUsersAtRolesOnce.mock.calls[0]
    expect(key).toBe(`staff_deleted_cover:${ID}:loc-1`)
    expect(locationId).toBe('loc-1')
    expect(payload.body).toBe('Former Coach was removed from 1 upcoming shift (from 2026-10-05). Open the roster to arrange cover.')
    expect(notifyUsersOnce).toHaveBeenCalledWith(db, 'swap_cancelled_staff_deleted:s1', ['peer-1'], expect.objectContaining({ category: 'swap' }))
  })

  it('removes the public signature photo', async () => {
    const db = makeDb(); createServerClient.mockReturnValue(db)
    await DELETE(req(), props)
    expect(db.storage.from).toHaveBeenCalledWith('branding')
    expect(db.__remove).toHaveBeenCalledWith([`signatures/${ID}/photo.jpg`])
  })
})

describe('GET /api/staff/[id]/permanent — impact preview', () => {
  it('master only; runs the SAME function as a dry run and changes nothing', async () => {
    const db = makeDb({ rpcData: { ...SUMMARY, dry_run: true } }); createServerClient.mockReturnValue(db)
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    expect(db.rpc).toHaveBeenCalledWith('tombstone_staff_profile', expect.objectContaining({ p_dry_run: true }))
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled()
    expect(queriesOf(db, 'assignment_change_log', 'insert')).toEqual([])
    expect((await res.json()).data.removed_shifts).toHaveLength(2)

    getCurrentUser.mockResolvedValue({ id: 'o', isMaster: false })
    expect((await GET(req(), props)).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run 'src/app/api/staff/[id]/permanent/route.test.js'`
Expected: `10 failed | 1 passed` (verified against the current route). Only `401 / 403 / 400-self` passes — the old route has those guards. Every DELETE test that reaches the work fails with `Error: unexpected update on campaigns` thrown from `makeDb` — that is the old hand-written null-out loop running — and the GET test fails with `TypeError: GET is not a function`.

- [ ] **Step 3: Rewrite `src/app/api/staff/[id]/permanent/route.js` (replace the whole file)**

```js
// /api/staff/[id]/permanent — permanent delete that KEEPS HISTORY (STAFFDELETE.1).
//
//   GET    → what a permanent delete WOULD do (a dry run of the same function).
//   DELETE → do it.
//
// WHAT IT DOES
//   1. Auth: master only; never yourself.
//   2. Pre-flight: the profile must already be deactivated (active=false) and
//      not already deleted.
//   3. Revokes any straggling UniFi door access (best-effort).
//   4. Calls public.tombstone_staff_profile (mig 622), ONE transaction that:
//        • removes the person from UPCOMING shifts only (block_date >= Dublin
//          today), writing a roster_change_log row for each published one;
//        • cancels open swaps they are on either side of, and pending leave
//          that is still ahead;
//        • deletes their access rows and tokens (profile_locations,
//          profile_organizations, device_tokens, widget_tokens,
//          email_mailbox_access, mobile_bar_prefs);
//        • strips PII from the profile (email scrambled; avatar, PIN, door id,
//          signature cleared) and stamps deleted_at / deleted_by;
//        • redacts the PII the audit trigger captured along the way.
//   5. Bans + scrambles the auth user — unless the same login is also a member
//      or a host, in which case it is left alone and the response says so.
//   6. Removes their public signature photo, records the role history, tells
//      each affected studio's managers which shifts need cover, and tells the
//      other party of any swap that was cancelled.
//
// WHAT IT NEVER DOES
//   • DELETE the profiles row, or the auth user. profiles.id → auth.users is
//     ON DELETE CASCADE (mig 004:36) and ~25 tables cascade off profiles —
//     shift_assignments, time_off_requests, staff_allowances,
//     contractor_invoices, profile_compensation, … — so either delete destroys
//     the records the business must keep. (The previous version of this file
//     did exactly that while its header promised "the rows stay".)
//   • Touch history: past shifts, decided leave, allowances, invoices and
//     every report stay, and stay under the person's NAME (full_name, role,
//     employment type and pay are kept on the tombstone — staff_cost costs
//     past shifts from the rate).
//   • NULL any attribution column. The old hand-written FK list is gone: a row
//     that stays needs nothing nulled.
//
// Reversibility: NONE for the personal data and the upcoming shifts. The
// database refuses to reactivate a tombstone (CHECK profiles_tombstone_is_inactive).

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getUnifiConfig, revokeUnifiUserPolicies, UnifiError } from '@/lib/unifi-access'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { MANAGER_ROLES } from '@/lib/schemas'
import {
  isTombstone, tombstoneEmail, authDisposition, tombstoneErrorStatus,
  coverNoticesByLocation, swapCounterparties, AUTH_BAN_DURATION,
} from '@/lib/staff-tombstone'

export const runtime = 'nodejs'

const AUTH_WARNINGS = {
  kept_member_login: 'Their login was NOT disabled: the same account is also a gym member. Staff access is gone; their member app still works.',
  kept_host_login: 'Their login was NOT disabled: the same account is also an event host. Staff access is gone; their host portal still works.',
  kept_unverified: 'Their login was NOT disabled because we could not check whether it is also a member or host account. Staff access is gone. Check it in the Supabase dashboard and ban the user if it is staff-only.',
}

/** Shared by GET and DELETE: caller is a master, target exists, is inactive, is not already a tombstone. */
async function loadTarget(id) {
  const user = await getCurrentUser()
  if (!user) return { fail: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!user.isMaster) {
    return { fail: NextResponse.json({ success: false, error: 'Only a master account can permanently delete staff.' }, { status: 403 }) }
  }
  if (id === user.id) {
    return { fail: NextResponse.json({ success: false, error: 'You cannot permanently delete your own account.' }, { status: 400 }) }
  }
  const db = createServerClient()
  const { data: profile, error } = await db
    .from('profiles')
    .select('id, full_name, role, active, deleted_at, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()
  // A tombstone is "not found" to every surface, this one included.
  if (error || !profile || isTombstone(profile)) {
    return { fail: NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 }) }
  }
  if (profile.active) {
    return { fail: NextResponse.json({ success: false, error: 'Profile must be deactivated first. Soft-archive (set Active off) before permanent delete.' }, { status: 400 }) }
  }
  return { user, db, profile }
}

function runTombstone(db, { id, actorId, dryRun }) {
  return db.rpc('tombstone_staff_profile', {
    p_profile_id: id, p_actor_id: actorId, p_today: dublinTodayStr(), p_dry_run: dryRun,
  })
}

export async function GET(_request, props) {
  const { id } = await props.params
  const t = await loadTarget(id)
  if (t.fail) return t.fail
  const { data, error } = await runTombstone(t.db, { id, actorId: t.user.id, dryRun: true })
  if (error) {
    const mapped = tombstoneErrorStatus(error.message)
    return NextResponse.json({ success: false, error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json({ success: true, data })
}

export async function DELETE(request, props) {
  const { id } = await props.params
  const t = await loadTarget(id)
  if (t.fail) return t.fail
  const { user, db, profile } = t

  // Defence in depth: the deactivate flow already revoked door access. A UniFi
  // failure does not stop the delete — the UniFi user is keyed on its own id
  // and the door flags are about to be deleted with profile_locations.
  for (const link of profile.profile_locations || []) {
    if (!link.unifi_door_access || !link.unifi_user_id || !link.locations) continue
    const cfg = await getUnifiConfig(db, link.locations)
    if (!cfg.configured) continue
    try {
      await revokeUnifiUserPolicies(cfg, link.unifi_user_id)
    } catch (e) {
      console.warn(`[permanent-delete] unifi revoke failed at ${link.locations.name}:`, e instanceof UnifiError ? e.message : e?.message || e)
    }
  }

  // Is this login ALSO a member or a host? Read before anything changes.
  const [contactRes, hostRes] = await Promise.all([
    db.from('contacts').select('id').eq('user_id', id).limit(1).maybeSingle(),
    db.from('host_users').select('host_id').eq('auth_user_id', id).limit(1).maybeSingle(),
  ])
  const disposition = authDisposition({
    memberContact: contactRes.data, hostUser: hostRes.data, readFailed: !!(contactRes.error || hostRes.error),
  })

  // The irreversible step — one transaction (mig 622).
  const { data: summary, error: rpcError } = await runTombstone(db, { id, actorId: user.id, dryRun: false })
  if (rpcError || !summary) {
    const mapped = tombstoneErrorStatus(rpcError?.message || 'no summary returned')
    return NextResponse.json({ success: false, error: mapped.error }, { status: mapped.status })
  }

  // From here the tombstone EXISTS. Nothing below may turn that into a
  // reported failure: each step is best-effort and reports as a warning.
  const warnings = []

  if (disposition === 'ban') {
    const { error: authErr } = await db.auth.admin.updateUserById(id, {
      email: tombstoneEmail(id),
      email_confirm: true,
      password: randomBytes(32).toString('hex'),
      ban_duration: AUTH_BAN_DURATION,
      user_metadata: { full_name: null },
    })
    if (authErr) {
      warnings.push(`Staff access is removed, but disabling the login failed: ${authErr.message}. Ban the user in the Supabase dashboard (Authentication → Users).`)
    }
  } else {
    warnings.push(AUTH_WARNINGS[disposition])
  }

  try {
    const bucket = db.storage.from('branding')
    const { data: files } = await bucket.list(`signatures/${id}`)
    const paths = (files || []).map((f) => `signatures/${id}/${f.name}`)
    if (paths.length > 0) await bucket.remove(paths)
  } catch (e) {
    console.warn('[permanent-delete] signature photo cleanup failed:', e?.message)
  }

  // Role history. Written AFTER the function succeeded (the old route wrote it
  // first and left a "deleted" record behind every failed attempt), from the
  // memberships read BEFORE it ran. No email: that is what we just erased.
  const { error: logErr } = await db.from('assignment_change_log').insert({
    actor_id: user.id,
    target_profile_id: id,
    location_id: null,
    action: 'permanent_delete',
    before: {
      full_name: profile.full_name,
      role: profile.role,
      assignments: (profile.profile_locations || []).map((l) => ({
        location_id: l.location_id, location_name: l.locations?.name, role: l.role,
      })),
    },
    after: null,
  })
  if (logErr) console.error('[permanent-delete] assignment_change_log insert failed:', logErr.message)

  await logAuditEvent({
    category: 'business',
    action: 'profile.permanently_deleted',
    actor: { id: user.id, full_name: user.full_name, email: user.email },
    target: { id, label: profile.full_name, resource: `profiles/${id}` },
    details: {
      removed_shifts: summary.removed_shifts?.length || 0,
      cancelled_swaps: summary.cancelled_swaps?.length || 0,
      cancelled_time_off: summary.cancelled_time_off?.length || 0,
      auth: disposition,
    },
    request,
  })

  try {
    for (const n of coverNoticesByLocation(summary.removed_shifts)) {
      await notifyUsersAtRolesOnce(db, `staff_deleted_cover:${id}:${n.locationId}`, n.locationId, MANAGER_ROLES, {
        title: 'Shifts need cover',
        body: `${profile.full_name} was removed from ${n.count} upcoming ${n.count === 1 ? 'shift' : 'shifts'} (from ${n.firstDate}). Open the roster to arrange cover.`,
        category: 'schedule',
        emailSubject: `${n.count} ${n.count === 1 ? 'shift needs' : 'shifts need'} cover`,
        data: { type: 'roster_gap', block_date: n.firstDate },
      })
    }
    for (const c of swapCounterparties(summary.cancelled_swaps, id)) {
      await notifyUsersOnce(db, `swap_cancelled_staff_deleted:${c.swapId}`, [c.notifyId], {
        title: 'Swap cancelled',
        body: `Your shift swap with ${profile.full_name} was cancelled because they no longer work here.`,
        category: 'swap',
        emailSubject: 'Your shift swap was cancelled',
        data: { type: 'swap_decision', swap_id: c.swapId, status: 'cancelled' },
      })
    }
  } catch (e) {
    console.error('[permanent-delete] notify failed:', e?.message)
  }

  return NextResponse.json({
    success: true,
    data: { ...summary, auth: disposition },
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  })
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run 'src/app/api/staff/[id]/permanent/route.test.js'`
Expected: all passed.

- [ ] **Step 5: Route + column gates**

Run: `npm run check:route-guards && npm run check:select-columns && npm run check:location-scoping && npm run check:guardrails`
Expected: all exit 0. `check:select-columns` proves `profiles.deleted_at`, `contacts.user_id` (mig 110) and `host_users.auth_user_id`/`host_id` (mig 386) against the replayed migrations — this is why mig 622 must be in the same PR. If `check:location-scoping` flags `contacts` or `host_users` here (both are read by `auth.users` id, not by location, behind a master-only guard), add the route to the script's `EXEMPT` map with exactly that reason — do not invent a location filter.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/staff/[id]/permanent/route.js' 'src/app/api/staff/[id]/permanent/route.test.js'
git commit -m "STAFFDELETE.1 — permanent delete tombstones the profile instead of deleting it (+ GET dry-run)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Quote bracketed paths: `[id]` is a zsh glob and an unquoted `git add` stages nothing, silently.)

---

### Task 4: A tombstone never resolves a user, cannot be impersonated, cannot be edited back to life

**Files:** Modify `src/lib/auth.js`, `src/lib/auth.getCurrentUser.test.js`, `src/lib/impersonation.js`, `src/app/api/staff/[id]/route.js`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/auth.getCurrentUser.test.js` (the harness — `setup`, `LOC_A1`, `ORG_A`, `link` — is defined at lines 58-136 of that file; the scenario shape is copied from the existing `rollout safety` tests at line 206):

```js
describe('getCurrentUser — a permanently deleted staff member (STAFFDELETE.1)', () => {
  const living = { id: 'coach-1', role: 'staff', full_name: 'Former Coach', email: 'coach@example.test', employment_type: 'fte', active: true }
  const scenario = (profile) => ({ profile, links: [link({ loc: LOC_A1, role: 'staff', is_default: true })], orgLinks: [], orgs: [ORG_A] })

  it('control: the same profile resolves while it is alive', async () => {
    setup(scenario(living))
    expect(await getCurrentUser()).not.toBeNull()
  })

  it('a tombstone resolves to null — an access token issued before the delete gets a 401 everywhere', async () => {
    setup(scenario({ ...living, active: false, email: 'deleted+coach-1@deleted.invalid', deleted_at: '2026-09-19T10:00:00Z' }))
    expect(await getCurrentUser()).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/auth.getCurrentUser.test.js`
Expected: `a tombstone resolves to null` fails — `expected { id: 'coach-1', … } to be null`. The control passes.

- [ ] **Step 3: Implement the three guards**

(a) `src/lib/auth.js` — add to the imports at the top of the file (after line 10):

```js
import { isTombstone } from './staff-tombstone.js'
```

Replace line 285 (`if (!realProfile) return null`) with:

```js
  // STAFFDELETE.1 — a permanently deleted staff member keeps a profiles row (a
  // tombstone, so history still names them) but is nobody: the auth user is
  // banned, and an access token issued before the ban dies here.
  if (!realProfile || isTombstone(realProfile)) return null
```

In the impersonation block below it, change the guard `if (target) {` (line ~316, directly after the long comment about the open `impersonation_log` row) to:

```js
      if (target && !isTombstone(target)) {
```

(b) `src/lib/impersonation.js` — add `import { isTombstone } from './staff-tombstone.js'` to the imports, extend the select at line 104 to `'id, full_name, role, active, deleted_at'`, and replace line 108 (`if (tErr || !target) throw new Error('Target user not found.')`) with:

```js
  // STAFFDELETE.1 — a tombstone is not a user; there is nothing to view as.
  if (tErr || !target || isTombstone(target)) throw new Error('Target user not found.')
```

(c) `src/app/api/staff/[id]/route.js` — add `import { isTombstone } from '@/lib/staff-tombstone'` and, in `PUT`, replace the check after the `targetBefore` read (lines 105-107):

```js
  // STAFFDELETE.1 — a tombstone cannot be edited back to life. (The database
  // refuses active=true on one too: CHECK profiles_tombstone_is_inactive.)
  if (!targetBefore || isTombstone(targetBefore)) {
    return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 })
  }
```

(`targetBefore` is a `select('*')`, so `deleted_at` is already on it.)

- [ ] **Step 4: Run them, expect PASS**

Run: `npx vitest run src/lib/auth.getCurrentUser.test.js src/lib/impersonation.test.js 'src/app/api/staff/[id]/route.test.js'`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.js src/lib/auth.getCurrentUser.test.js src/lib/impersonation.js 'src/app/api/staff/[id]/route.js'
git commit -m "STAFFDELETE.1 — a tombstone never resolves a user, cannot be impersonated or edited

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The read-side guard — seven unfiltered lists, and a sweep that keeps it that way

**Call sites changed (all seven from Investigation §5, plus the detail page):**

| # | File:line | Change |
|---|---|---|
| 1 | `src/app/settings/page.js:133` | count through `excludeTombstones` |
| 2 | `src/app/settings/staff/page.js:73` | master's unrestricted list |
| 3 | `src/app/settings/staff/page.js:78` | estate-wide id/active set |
| 4 | `src/app/settings/impersonate/page.js:28` | picker |
| 5 | `src/app/api/impersonate/users/route.js:29` | picker |
| 6 | `src/app/api/mobile/impersonate/users/route.js:36` | picker |
| 7 | `src/app/api/cron/fleet-health/route.js:528` | masters to alert |
| 8 | `src/app/settings/staff/[id]/page.js:104` | detail page `notFound()` for a tombstone |

(Task 4 already changed the three by-id ACT sites: `auth.js`, `impersonation.js`, `api/staff/[id]/route.js`.)

**Deliberately NOT changed, and why:** `src/lib/staff.js:50-66` (`/api/staff`, every coach picker) and the non-master branch of `/settings/staff` take their ids from `profile_locations`, which the function deletes — pinned by the PGlite test *"deletes every access row…"*. Every `.eq('active', true)` reader excludes a tombstone by the DB CHECK. By-id NAME lookups (mail authors, consultations, swap conflicts, reports) SHOULD keep resolving the name — that is the requirement. `password-override`, `org-admin` and `send-password-reset` act on one profile by id, are master/owner-only, are reachable only from the detail page (which now 404s), and target a banned auth user.

**Files:** Create `tests/staff-tombstone-readers.test.js`. Modify the eight files above.

- [ ] **Step 1: Write the failing test (the sweep)**

```js
// tests/staff-tombstone-readers.test.js
// STAFFDELETE.1 — a permanently deleted staff member keeps a `profiles` row.
// Any read that LISTS profiles with no id / active / email filter would show
// it in a picker or count it. This sweep finds every such read under src/ and
// fails unless it goes through excludeTombstones() — the same shape as
// check:ota-paths: a NEW unfiltered list cannot be added without deciding.
//
// A FLOOR, NOT A PROOF (same posture as check:select-columns): it reads one
// statement's text. A chain built across variables is judged on what it can
// see, and a list filtered only by something else (`.eq('role', …)`) does NOT
// count as safe — a deleted master keeps role='master'.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

// A read is safe when it cannot return a tombstone: pinned to ids the caller
// already holds, active-only (DB CHECK: a tombstone is never active), matched
// on an email (a tombstone's is scrambled), a write, or explicitly guarded.
const SAFE = /isTombstone\(|\.eq\('id'|\.in\('id'|\.neq\('id'|\.eq\('active', true\)|\.ilike\('email'|\.update\(|\.insert\(|\.upsert\(|\.delete\(/
const WRAPPED = /excludeTombstones\(\s*[\w.\s]*$/

// Reads that are allowed to see tombstones, each with a reason.
const ALLOW = {}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(name) && !/\.test\.|test-helpers/.test(name)) out.push(p)
  }
  return out
}

export function unguardedProfileLists(root) {
  const hits = []
  for (const file of walk(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8')
    let i = -1
    while ((i = src.indexOf("from('profiles')", i + 1)) !== -1) {
      if (WRAPPED.test(src.slice(Math.max(0, i - 60), i))) continue
      const tail = src.slice(i, i + 400)
      const next = tail.indexOf('.from(', 10)
      const chain = next === -1 ? tail : tail.slice(0, next)
      if (SAFE.test(chain)) continue
      const key = `${file.slice(root.length + 1)}:${src.slice(0, i).split('\n').length}`
      if (!ALLOW[key]) hits.push(key)
    }
  }
  return hits.sort()
}

describe('every unfiltered profiles list excludes tombstones', () => {
  it('no read of `profiles` can list a permanently deleted staff member', () => {
    expect(
      unguardedProfileLists(repo),
      'A `from(\'profiles\')` read has no id / active / email filter and is not wrapped in excludeTombstones() ' +
      '(src/lib/staff-tombstone.js). Wrap it — `excludeTombstones(db.from(\'profiles\').select(…))` — or add it to ALLOW with a reason.',
    ).toEqual([])
  })
  it('every ALLOW entry carries a reason', () => {
    for (const [key, why] of Object.entries(ALLOW)) expect(why, key).toMatch(/\S{10,}/)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run tests/staff-tombstone-readers.test.js`
Expected: the first test fails listing EXACTLY these seven (the same heuristic was run against this tree on 2026-09-19):

```
src/app/api/cron/fleet-health/route.js:528
src/app/api/impersonate/users/route.js:29
src/app/api/mobile/impersonate/users/route.js:36
src/app/settings/impersonate/page.js:28
src/app/settings/page.js:133
src/app/settings/staff/page.js:73
src/app/settings/staff/page.js:78
```

If the list differs, `main` has moved since this plan was written: treat every extra entry as a call site to fix (or ALLOW with a reason) — do not loosen `SAFE`.

- [ ] **Step 3: Wrap the seven reads**

Each file gets `import { excludeTombstones } from '@/lib/staff-tombstone'` and the change below. Keep `excludeTombstones(` and `db.from('profiles')` adjacent — that adjacency is what the sweep reads.

`src/app/settings/page.js:133`:
```js
    excludeTombstones(db.from('profiles').select('id', { count: 'exact', head: true })),
```
(`head`/`count` are read on the FIRST `.select()` after `.from()` — CLAUDE.md — and the filter is added after it, so the count still works.)

`src/app/settings/staff/page.js:72-78`:
```js
  const rosterQuery = visibleIds === null
    ? excludeTombstones(db.from('profiles').select(STAFF_COLUMNS)).order('created_at')
    : db.from('profiles').select(STAFF_COLUMNS).in('id', visibleIds).order('created_at')
  const [staffRes, devicesRes, activeRes] = await Promise.all([
    rosterQuery,
    db.from('device_tokens').select('id, user_id, app_version, last_seen_at, geofence_permission'),
    excludeTombstones(db.from('profiles').select('id, active')),
  ])
```

`src/app/settings/impersonate/page.js:28-30`:
```js
    excludeTombstones(db.from('profiles')
      .select('id, full_name, email, role, active, profile_locations(locations(id, name))'))
      .order('full_name'),
```

`src/app/api/impersonate/users/route.js:28-31`:
```js
  const { data, error } = await excludeTombstones(db.from('profiles')
    .select('id, full_name, email, role, active, profile_locations(locations(id, name))'))
    .order('full_name')
```

`src/app/api/mobile/impersonate/users/route.js:34-38` (a different shape — it builds `query` and may add a search filter below; only the head changes):
```js
  let query = excludeTombstones(db.from('profiles')
    .select('id, full_name, email, role, active, profile_locations(locations(id, name))'))
    .order('full_name')
    .limit(50)
```

`src/app/api/cron/fleet-health/route.js:527-530`:
```js
  // STAFFDELETE.1 — a deleted master keeps role='master' on the tombstone (role
  // history) with a scrambled address; never alert it.
  const { data: masters } = await excludeTombstones(db.from('profiles')
    .select('id, email'))
    .eq('role', 'master')
```

- [ ] **Step 4: The detail page**

`src/app/settings/staff/[id]/page.js` — add `import { isTombstone } from '@/lib/staff-tombstone'` and replace line 104 (`if (!profileRes.data) notFound()`) with:

```js
  // STAFFDELETE.1 — a permanently deleted staff member has no editable profile.
  if (!profileRes.data || isTombstone(profileRes.data)) notFound()
```

- [ ] **Step 5: Run it, expect PASS**

Run: `npx vitest run tests/staff-tombstone-readers.test.js`
Expected: 2 passed.

- [ ] **Step 6: Lint + scoping**

Run: `npm run lint && npm run check:location-scoping && npm run check:route-guards`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add tests/staff-tombstone-readers.test.js src/app/settings/page.js src/app/settings/staff/page.js 'src/app/settings/staff/[id]/page.js' src/app/settings/impersonate/page.js src/app/api/impersonate/users/route.js src/app/api/mobile/impersonate/users/route.js src/app/api/cron/fleet-health/route.js
git commit -m "STAFFDELETE.1 — unfiltered profiles lists exclude tombstones; a sweep fails CI on a new one

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Leavers stay in `staff_cost` and `utilisation`

The rule, kept as small as the owner's decision needs: **someone who is no longer active (deactivated or deleted) and WORKED a shift at this location in the period is in the report, by name.** Everything else stays as ROSTER-FIX.5 pinned it — an ACTIVE profile outside the location is still not enumerated, and an inactive profile with no shifts in the period adds no empty row.

**Files:** Modify `src/lib/report-generator.js`, `src/lib/report-generator.test.js`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/report-generator.test.js` add `reportableProfiles,` to the import from `'./report-generator'` (lines 9-17). Append:

```js
// STAFFDELETE.1 — history stays reportable BY NAME. A coach who left (active
// false — deactivated, or permanently deleted and now a tombstone with no
// profile_locations row) used to vanish from staff_cost and utilisation for
// the weeks they actually worked.
describe('reportableProfiles', () => {
  const p = (id, active) => ({ id, full_name: id, active })
  it('active members, plus anyone inactive who worked in the period', () => {
    const out = reportableProfiles(
      [p('member', true), p('member-left-worked', false), p('member-left-idle', false), p('deleted-worked', false), p('visitor-active', true)],
      { memberIds: ['member', 'member-left-worked', 'member-left-idle'], shiftProfileIds: ['member', 'member-left-worked', 'deleted-worked', 'visitor-active'] },
    )
    expect(out.map((x) => x.id)).toEqual(['member', 'member-left-worked', 'deleted-worked'])
  })
  it('a legacy row with active NULL counts as active', () => {
    expect(reportableProfiles([p('m', null)], { memberIds: ['m'], shiftProfileIds: [] }).map((x) => x.id)).toEqual(['m'])
  })
})

describe('generateReport — leavers keep their history (STAFFDELETE.1)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  const TOMBSTONE = {
    id: 'p-gone', full_name: 'Former Coach', role: 'staff', employment_type: 'contractor', active: false,
    deleted_at: '2026-05-20T10:00:00Z', contracted_hours_per_week: 10, annual_salary: null, hourly_rate: 20, overtime_rate: null,
  }

  it('staff_cost costs a permanently deleted coach\'s past shifts, under their name', async () => {
    const { db, captured } = makeReportDb({
      profile_locations: PL_ROWS,                       // p-here only — the tombstone has no membership
      profiles: [PROFILES[0], TOMBSTONE],
      shift_assignments: [assignmentRow('p-here'), assignmentRow('p-gone')],
    })
    createServerClient.mockReturnValue(db)
    await generateReport({ report_type: 'staff_cost', ...PERIOD })
    expect(captured['profiles.in']).toEqual({ col: 'id', vals: ['p-here', 'p-gone'] })
    const gone = captured.inserted.report_data.staff.find((s) => s.name === 'Former Coach')
    expect(gone).toMatchObject({ regular_hours: 3, total_cost: 60 })   // 09:00-12:00 at €20/h
  })

  it('utilisation lists a leaver who worked, not one who did not', async () => {
    const idle = { ...TOMBSTONE, id: 'p-idle', full_name: 'Idle Leaver', deleted_at: null }
    const { db, captured } = makeReportDb({
      profile_locations: [...PL_ROWS, { profile_id: 'p-idle' }],
      profiles: [PROFILES[0], TOMBSTONE, idle],
      shift_assignments: [assignmentRow('p-here'), assignmentRow('p-gone')],
    })
    createServerClient.mockReturnValue(db)
    await generateReport({ report_type: 'utilisation', ...PERIOD })
    expect(captured.inserted.report_data.staff.map((s) => s.name).sort()).toEqual(['Coach Here', 'Former Coach'])
  })
})
```

Then update the ONE existing assertion this changes — in `describe('generateReport — staff_cost')` → `restricts profiles to the location via profile_locations`, the profile read now also asks for whoever worked, and the pure filter (not the query) keeps the active outsider out. Replace:

```js
    expect(captured['profiles.in']).toEqual({ col: 'id', vals: ['p-here'] })
```
with:
```js
    // STAFFDELETE.1 — the read now covers members AND whoever worked, so a
    // leaver can be found; reportableProfiles() is what keeps an ACTIVE
    // outsider (p-away) out, exactly as before.
    expect(captured['profiles.in']).toEqual({ col: 'id', vals: ['p-here', 'p-away'] })
```
(The next assertion in that test — names equal `['Coach Here']` — must still pass unchanged. The `utilisation` twin of this test has only `p-here` on shift, so its `profiles.in` assertion is unaffected.)

- [ ] **Step 2: Run it, expect FAIL**

Run: `npx vitest run src/lib/report-generator.test.js`
Expected: the `reportableProfiles` tests fail with `reportableProfiles is not a function`; the two `leavers` tests fail (`gone` is undefined; names equal `['Coach Here']`); the edited assertion fails showing `vals: ['p-here']`.

- [ ] **Step 3: Implement**

In `src/lib/report-generator.js`, add after `fetchLocationProfileIds` (after line 43):

```js
// STAFFDELETE.1 — who a per-location staff report is about: the location's
// ACTIVE members, plus anyone no longer active (deactivated, or permanently
// deleted — a tombstone has no profile_locations row at all) who WORKED here
// in the period. Without the second half a coach who left on the 20th vanished
// from that month's cost report, and "reportable by name" failed.
// An ACTIVE profile outside the location stays out (ROSTER-FIX.5), and an
// inactive one with no shifts adds no empty row. active NULL = legacy = active.
export function reportableProfiles(profiles, { memberIds, shiftProfileIds }) {
  const members = new Set(memberIds || [])
  const worked = new Set(shiftProfileIds || [])
  return (profiles || []).filter((p) => (p.active === false ? worked.has(p.id) : members.has(p.id)))
}
```

`staff_cost` — replace the parallel read at lines 191-199 (from `const [{ data: profiles, error: profilesError }, …] = await Promise.all([` through `if (shiftsError) return …`) with a sequential one, because the profile read now depends on the shifts:

```js
      const { rows: shifts, error: shiftsError } = await fetchScheduledShiftRows(db, { locationId: locId, periodStart: period_start, periodEnd: period_end })
      if (shiftsError) return { success: false, error: shiftsError }
      const shiftProfileIds = [...new Set((shifts || []).map((s) => s.profile_id).filter(Boolean))]
      // STAFFDELETE.1 — no `.eq('active', true)`: reportableProfiles decides.
      const { data: profileRows, error: profilesError } = await db.from('profiles')
        .select('id, full_name, role, employment_type, active, annual_salary, hourly_rate, contracted_hours_per_week, overtime_rate')
        .in('id', [...new Set([...profileIds, ...shiftProfileIds])])
      if (profilesError) return { success: false, error: profilesError.message }
      const profiles = reportableProfiles(profileRows, { memberIds: profileIds, shiftProfileIds })
```

`utilisation` — the same replacement for lines 380-388, with its own column list:

```js
      const { rows: shifts, error: shiftsError } = await fetchScheduledShiftRows(db, { locationId: locId, periodStart: period_start, periodEnd: period_end })
      if (shiftsError) return { success: false, error: shiftsError }
      const shiftProfileIds = [...new Set((shifts || []).map((s) => s.profile_id).filter(Boolean))]
      const { data: profileRows, error: profilesError } = await db.from('profiles')
        .select('id, full_name, role, employment_type, active, contracted_hours_per_week')
        .in('id', [...new Set([...profileIds, ...shiftProfileIds])])
      if (profilesError) return { success: false, error: profilesError.message }
      const profiles = reportableProfiles(profileRows, { memberIds: profileIds, shiftProfileIds })
```

Leave everything after those blocks (`profileMap`, `byProfileWeek`, `staffUtil`) exactly as it is — they already iterate `profiles`.

- [ ] **Step 4: Run it, expect PASS**

Run: `npx vitest run src/lib/report-generator.test.js`
Expected: all passed, including the two pre-existing `no rows in profile_locations → fails closed` tests (that guard runs before the new code) and `a failed shift read fails the report`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/report-generator.js src/lib/report-generator.test.js
git commit -m "STAFFDELETE.1 — staff_cost + utilisation keep leavers who worked in the period, by name

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The confirmation says exactly what happens

**Files:** Modify `src/components/StaffForm.jsx` (Danger Zone copy ~1174-1176; `PermanentDeleteButton` 1311-1360). The copy logic is `describeTombstoneImpact`, tested in Task 1; this task renders it.

- [ ] **Step 1: Danger Zone sentence (line 1176)**

Replace the inactive-branch string with:

```js
            : "This account is deactivated. Reactivate to restore access, or permanently delete (master only). Permanent delete removes their personal details, login and upcoming shifts; their past shifts, leave, invoices and reports stay under their name."}
```

- [ ] **Step 2: Load the preview when the dialog opens**

Add to the imports at the top of `src/components/StaffForm.jsx`:

```js
import { describeTombstoneImpact } from '@/lib/staff-tombstone'
```

Inside `PermanentDeleteButton`, after `const [error, setError] = useState(null)` add:

```js
  // STAFFDELETE.1 — GET is a dry run of the very function DELETE calls, so
  // what this dialog promises is what will happen.
  const [impact, setImpact] = useState(null)

  async function openConfirm() {
    setState('confirming')
    setImpact(null)
    try {
      const res = await fetch(`/api/staff/${staffId}/permanent`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) setImpact(describeTombstoneImpact(data.data))
      else setError(data.error || `Could not load what this will remove (${res.status})`)
    } catch (e) {
      setError(e.message || 'Could not load what this will remove')
    }
  }
```

Change the idle button's handler (the last `<button>` in the component, `onClick={() => setState('confirming')}`) to `onClick={openConfirm}`.

- [ ] **Step 3: Replace the warning block and the success path**

Replace the `<div className="text-xs text-red-200">…</div>` block (lines 1345-1351) with:

```jsx
        <div className="text-xs text-un1t-text space-y-2">
          <strong className="block text-red-700">This cannot be undone.</strong>
          <p>
            Permanently deleting <span className="font-mono">{staffName}</span> removes their personal details
            (email, photo, PIN, door credentials, devices), their login and every studio assignment.
          </p>
          {impact ? (
            <>
              <ul className="list-disc pl-4 space-y-0.5">
                {impact.removes.map((line) => <li key={line}>{line}</li>)}
              </ul>
              <p>{impact.keeps}</p>
            </>
          ) : !error ? (
            <p className="text-un1t-subtle">Checking their upcoming shifts…</p>
          ) : null}
          <p className="text-un1t-subtle">
            Their name stays on those records so payroll, leave and invoice history remain reportable. They can never be reactivated.
          </p>
        </div>
```

In `run()`, replace the success tail (from the `// Hard delete — there's no profile…` comment through `router.push('/settings')`) with:

```js
      // The profile is a tombstone now — there is no page to return to. Tell
      // the operator what was removed (and any login caveat) before leaving.
      const done = describeTombstoneImpact(data.data)
      alert([...done.removes, done.keeps, data.warning].filter(Boolean).join('\n\n'))
      router.push('/settings')
```

Disable the confirm button until the preview has loaded — change its `disabled` to `disabled={!matches || !impact || state === 'working'}`.

- [ ] **Step 4: Lint (the guardrail rules run on this file)**

Run: `npm run lint && npm run check:guardrails`
Expected: exit 0. `no-untyped-button-in-form` — every `<button>` here already carries `type="button"`. The new copy uses `text-red-700` / `text-un1t-text`, not the old `text-red-200`, which is a dark-theme ramp and unreadable on the light cards.

- [ ] **Step 5: Commit**

```bash
git add src/components/StaffForm.jsx
git commit -m "STAFFDELETE.1 — permanent-delete dialog shows the real impact and says what is kept

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Record the rule

- [ ] **Step 1: One invariant line in `CLAUDE.md`**, under **Data access & security**, directly after the bullet that begins `**Creating an \`auth.users\` row MINTS A STAFF PROFILE`:

```md
- **A staff `profiles` row is NEVER deleted, and neither is its auth user.** `profiles.id → auth.users` is `ON DELETE CASCADE` (mig 004:36) and ~25 tables cascade off `profiles` (`shift_assignments`, `time_off_requests`, `staff_allowances`, `contractor_invoices`, `profile_compensation`, …), so either delete destroys payroll/leave/invoice history. Permanent delete is `public.tombstone_staff_profile()` (mig 622): the row stays with `deleted_at` set, PII stripped, `full_name` + pay kept, upcoming shifts removed, auth user **banned**. A tombstone is always `active=false` (DB CHECK) with no `profile_locations`; any read that LISTS profiles without an id/active/email filter must go through `excludeTombstones()` (`src/lib/staff-tombstone.js`) — `tests/staff-tombstone-readers.test.js` fails on a new one. Never hand-list FKs into `profiles`: the old route's list covered 23 of 48 and named a dropped table.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "STAFFDELETE.1 — CLAUDE.md: staff profiles are tombstoned, never deleted

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### PR gate

- [ ] **Focused tests:**

```bash
npx vitest run src/lib/staff-tombstone.test.js tests/migration-622-staff-tombstone.test.js \
  'src/app/api/staff/[id]/permanent/route.test.js' src/lib/auth.getCurrentUser.test.js src/lib/impersonation.test.js \
  'src/app/api/staff/[id]/route.test.js' tests/staff-tombstone-readers.test.js src/lib/report-generator.test.js
```
Expected: all passed.

- [ ] **Static gates:**

```bash
npm run lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive \
  && npm run check:guardrails && npm run check:select-columns && npm run check:bundle-sql && npm run check:ota-paths \
  && npm run check:mobile-parity
```
Expected: all exit 0. `check:ota-paths` — nothing under `mobile/` or `shared/` changed, so this merge publishes NO OTA. `check:mobile-parity` — no new permission key.

- [ ] **Build:** `npm run build` (new imports in three server pages and a route). Close other apps first.

- [ ] **Open the PR with the deploy order in the description**, verbatim: *"⚠️ Apply `supabase/migrations/622_staff_tombstone.sql` (PRE-APPLY checks a-e in its header, then `get_advisors`) BEFORE merging. The migration is safe alone; the code is not."* Then add the `docs/CHANGELOG.md` row keyed by the PR number, directly under the `|---|------|-------|` line; never edit a pushed row.

- [ ] **Operator, after deploy — first real delete:** run header query (e) for the person, delete them from `/settings/staff/<id>` (the dialog must list their upcoming shifts before you type the name), then run (h) and (i). Pass = past shifts / leave / allowance / invoice counts unchanged, `upcoming_shifts = 0`, name intact, email scrambled, auth user banned (or the response said `kept_*`), they are absent from `/settings/staff`, the roster coach picker and the impersonation picker, and a `staff_cost` report for a month they worked still lists them by name.

### Out of scope — raise separately

1. **`getCurrentUser()` ignores `profiles.active`** (Investigation §3c): a merely DEACTIVATED account still resolves a session.
2. **`src/app/api/admin/password-override/route.js:227`** calls `auth.admin.signOut(targetUserId, 'global')` — that API takes a JWT, not a user id, so "sessions invalidated" is very probably a silent no-op.
3. **Signed contracts** (`contracts.profile_id`, RESTRICT) hold the person's signature and any address typed into the template. They are legal records and are left untouched; whether to redact them after a retention period is a policy question.
