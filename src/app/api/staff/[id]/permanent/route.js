// /api/staff/[id]/permanent — permanent delete that KEEPS HISTORY (STAFFDELETE.1).
//
//   GET    → what a permanent delete WOULD do (a dry run of the same function,
//            plus what will happen to their login: `auth`).
//   DELETE → do it.
//
// WHAT IT DOES
//   1. Auth: master only; never yourself.
//   2. Pre-flight: the profile must already be deactivated (active=false) and
//      not already deleted.
//   3. Revokes any straggling UniFi door access (best-effort).
//   4. Calls public.tombstone_staff_profile (mig 622), ONE transaction that:
//        • removes the person from UPCOMING shifts only, writing a
//          roster_change_log row for each published one. "Upcoming" means NOT
//          STARTED on the Dublin wall clock: a later date, or today with a
//          start time still ahead. A shift in progress or finished today is
//          HISTORY and stays (the summary lists those as kept_today_shifts).
//          The function reads the clock itself (p_now defaults to the
//          database's now()), so the date and the time of day come from one
//          instant — this route passes no "today";
//        • cancels open swaps they are on either side of, and pending leave
//          that is still ahead;
//        • deletes their access rows and tokens (profile_locations,
//          profile_organizations, device_tokens, widget_tokens,
//          email_mailbox_access, mobile_bar_prefs);
//        • strips PII from the profile (email scrambled; avatar, PIN, door id,
//          signature cleared) and stamps deleted_at / deleted_by;
//        • DEMOTES the role: the role they held is copied to deleted_role and
//          `role` is set to plain 'staff'. RLS reads profiles.role live
//          (private.auth_is_master() and many inline policies), so a deleted
//          master who kept role='master' would still be a master to the
//          browser/mobile client whenever their login survives (step 5's
//          kept_* outcomes, a failed ban, or an access token not yet expired).
//          Role HISTORY is deleted_role — roleAtDeletion() in staff-tombstone;
//        • redacts the PII the audit trigger captured along the way.
//   5. Bans + scrambles the auth user — unless the same login is also a member
//      or a host, in which case it is left alone and the response says so.
//      This step runs AFTER the transaction, so it can fail. Its FINAL outcome
//      is recorded on the tombstone (auth_disposition + auth_completed_at); a
//      tombstone with auth_completed_at NULL is a half-finished delete, and
//      DELETE on it re-runs ONLY this step (GET still 404s a tombstone, and
//      an id that never existed is 404 on both verbs). Until it finishes, the
//      person cannot use staff access anyway: getCurrentUser() refuses a
//      tombstone, their role is 'staff' and they hold no profile_locations.
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
//     every report stay, and stay under the person's NAME (full_name,
//     employment type and pay are kept on the tombstone — staff_cost costs
//     past shifts from the rate; the role they held is kept as deleted_role).
//     A shift that has already STARTED today is history too.
//   • NULL any attribution column. The old hand-written FK list is gone: a row
//     that stays needs nothing nulled.
//
// Reversibility: NONE for the personal data and the upcoming shifts, and the
// database enforces it (mig 622): once deleted_at is set, a BEFORE UPDATE
// trigger (profiles_tombstone_frozen) refuses any change to deleted_at,
// deleted_by, deleted_role, role, active, email or permissions — so a
// tombstone cannot be un-deleted, reactivated or re-promoted by ANY writer —
// and triggers on profile_locations / profile_organizations refuse to give one
// a role. The CHECK profiles_tombstone_is_inactive is the second lock. Calling
// the function again on a tombstone is safe: it answers already_tombstoned
// and writes nothing.

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getUnifiConfig, revokeUnifiUserPolicies, UnifiError } from '@/lib/unifi-access'
import { logAuditEvent } from '@/lib/audit'
import { notifyUsersOnce, notifyUsersAtRolesOnce } from '@/lib/push-dedup'
import { MANAGER_ROLES } from '@/lib/schemas'
import {
  isTombstone, tombstoneEmail, tombstoneErrorStatus,
  coverNoticesByLocation, swapCounterparties, AUTH_BAN_DURATION,
} from '@/lib/staff-tombstone'
import { readLoginDisposition } from '@/lib/staff-login-access'

export const runtime = 'nodejs'

const AUTH_WARNINGS = {
  kept_member_login: 'Their login was NOT disabled: the same account is also a gym member. Staff access is gone; their member app still works.',
  kept_host_login: 'Their login was NOT disabled: the same account is also an event host. Staff access is gone; their host portal still works.',
  kept_unverified: 'Their login was NOT disabled because we could not check whether it is also a member or host account. Staff access is gone. Check it in the Supabase dashboard and ban the user if it is staff-only.',
}

/**
 * Shared by GET and DELETE: caller is a master, target exists and is inactive.
 * An existing tombstone is "not found" — EXCEPT to DELETE (allowTombstone),
 * which may still owe it the login step (see finishTombstoneAuth).
 */
async function loadTarget(id, { allowTombstone = false } = {}) {
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
    .select('id, full_name, role, active, deleted_at, auth_disposition, auth_completed_at, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()
  // An id that never existed is 404. So is a tombstone, to every surface but
  // the DELETE retry.
  if (error || !profile || (isTombstone(profile) && !allowTombstone)) {
    return { fail: NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 }) }
  }
  if (isTombstone(profile)) return { user, db, profile, tombstone: true }
  if (profile.active) {
    return { fail: NextResponse.json({ success: false, error: 'Profile must be deactivated first. Soft-archive (set Active off) before permanent delete.' }, { status: 400 }) }
  }
  return { user, db, profile }
}

// ACTIVEUSER.1 — "is this login ALSO a member or a host?" moved to
// @/lib/staff-login-access: deactivate now bans a login too, and the two must
// never disagree about whose login is safe to ban.
const readAuthDisposition = readLoginDisposition

/**
 * The LOGIN step, for a profile that is ALREADY a tombstone: ban + scramble a
 * staff-only login, or deliberately keep a member's / host's. It runs after
 * the SQL transaction committed, so it can fail or never run — which is why it
 * is (a) recorded on the tombstone ONLY when it reached a FINAL outcome
 * (auth_disposition + auth_completed_at, mig 622: NULL -> value, once), so a
 * half-finished delete stays visible as auth_completed_at NULL, and (b) safe
 * to run again: DELETE on an existing tombstone re-runs this and nothing else.
 * 'kept_unverified' (we could not tell) is NOT final and is never recorded.
 * Never throws; never turns an existing tombstone into a reported failure.
 *
 * @returns {Promise<{ disposition: string, completed: boolean, completedAt: string|null, warnings: string[] }>}
 */
async function finishTombstoneAuth(db, id) {
  const warnings = []
  const disposition = await readAuthDisposition(db, id)
  let final = false
  if (disposition === 'ban') {
    const { error: authErr } = await db.auth.admin.updateUserById(id, {
      email: tombstoneEmail(id),
      email_confirm: true,
      password: randomBytes(32).toString('hex'),
      ban_duration: AUTH_BAN_DURATION,
      user_metadata: { full_name: null },
    })
    if (authErr) {
      warnings.push(`Staff access is removed, but disabling the login failed: ${authErr.message}. Retry from the delete dialog (it re-runs only this step), or ban the user in the Supabase dashboard (Authentication → Users).`)
    } else {
      final = true
    }
  } else {
    warnings.push(AUTH_WARNINGS[disposition])
    final = disposition !== 'kept_unverified'
  }
  if (!final) return { disposition, completed: false, completedAt: null, warnings }

  const completedAt = new Date().toISOString()
  const { data: recorded, error: recErr } = await db
    .from('profiles')
    .update({ auth_disposition: disposition, auth_completed_at: completedAt })
    .eq('id', id)
    .is('auth_completed_at', null)
    .select('id')
  if (recErr) {
    warnings.push(`The login step finished but could not be recorded (${recErr.message}), so this delete still shows as unfinished. Retry from the delete dialog to record it.`)
    return { disposition, completed: false, completedAt: null, warnings }
  }
  // Zero rows = someone else recorded it first. The step IS finished either way.
  return { disposition, completed: true, completedAt: (recorded || []).length > 0 ? completedAt : null, warnings }
}

function retryResponse(profile, auth) {
  return NextResponse.json({
    success: true,
    data: {
      profile_id: profile.id, full_name: profile.full_name, already_deleted: true,
      auth: auth.disposition, auth_completed: auth.completed, auth_completed_at: auth.completedAt, changed: true,
    },
    ...(auth.warnings.length > 0 ? { warning: auth.warnings.join(' ') } : {}),
  })
}

// p_now is deliberately NOT passed: the function defaults it to the database's
// now() and derives Dublin date + time of day from that single instant.
function runTombstone(db, { id, actorId, dryRun }) {
  return db.rpc('tombstone_staff_profile', {
    p_profile_id: id, p_actor_id: actorId, p_dry_run: dryRun,
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
  // What will happen to their LOGIN — read-only (no ban, nothing recorded), by
  // the same rules DELETE applies, so the dialog never promises "their login
  // is removed" to someone whose member or host login will be kept.
  const auth = await readAuthDisposition(t.db, id)
  return NextResponse.json({ success: true, data: { ...data, auth } })
}

export async function DELETE(request, props) {
  const { id } = await props.params
  const t = await loadTarget(id, { allowTombstone: true })
  if (t.fail) return t.fail
  const { user, db, profile } = t

  // RETRY. The person is already a tombstone: nothing is removed, logged or
  // notified again — only the login step, and only if it never finished.
  if (t.tombstone) {
    if (profile.auth_completed_at) {
      return NextResponse.json({
        success: true,
        data: {
          profile_id: profile.id, full_name: profile.full_name, already_deleted: true,
          auth: profile.auth_disposition, auth_completed: true, auth_completed_at: profile.auth_completed_at, changed: false,
        },
      })
    }
    const auth = await finishTombstoneAuth(db, id)
    await logAuditEvent({
      category: 'business',
      action: 'profile.permanent_delete_login_step_retried',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { id, label: profile.full_name, resource: `profiles/${id}` },
      details: { auth: auth.disposition, auth_completed: auth.completed },
      request,
    })
    return retryResponse(profile, auth)
  }

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

  // The irreversible step — one transaction (mig 622).
  const { data: summary, error: rpcError } = await runTombstone(db, { id, actorId: user.id, dryRun: false })
  if (rpcError || !summary) {
    const mapped = tombstoneErrorStatus(rpcError?.message || 'no summary returned')
    return NextResponse.json({ success: false, error: mapped.error }, { status: mapped.status })
  }

  // Two masters at once: the other request won, and the function (safe to call
  // twice) changed nothing. Its side effects are the other request's; this one
  // only makes sure the login step is finished.
  if (summary.already_tombstoned) {
    return retryResponse(profile, await finishTombstoneAuth(db, id))
  }

  // From here the tombstone EXISTS. Nothing below may turn that into a
  // reported failure: each step is best-effort and reports as a warning.
  const auth = await finishTombstoneAuth(db, id)
  const disposition = auth.disposition
  const warnings = [...auth.warnings]

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
      role: profile.role, // read BEFORE the function demoted it; also kept in profiles.deleted_role
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
      kept_today_shifts: summary.kept_today_shifts?.length || 0,
      role_was: profile.role,
      auth: disposition,
      auth_completed: auth.completed,
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
    data: { ...summary, auth: disposition, auth_completed: auth.completed },
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  })
}
