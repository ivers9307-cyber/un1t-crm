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
// Reversibility: NONE for the personal data and the upcoming shifts. The
// database refuses to reactivate a tombstone (CHECK profiles_tombstone_is_inactive).

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getUnifiConfig, revokeUnifiUserPolicies, UnifiError } from '@/lib/unifi-access'
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
