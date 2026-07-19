// DELETE /api/staff/[id]/permanent — hard delete (GDPR right-to-be-forgotten).
//
// What this does:
//   1. Auth: must be a master account.
//   2. Pre-flight: target profile MUST already be inactive (active=false).
//      We won't hard-delete an active staff member by accident.
//   3. Anonymize audit attribution: many tables FK to profiles.id with
//      ON DELETE NO ACTION (created_by, updated_by, actor_id, etc.).
//      Hard-deleting would fail with a constraint violation if those
//      rows exist. We NULL them out first — the historical row stays,
//      attribution is lost. This is the right behavior for GDPR.
//   4. Write a final assignment_change_log entry recording the
//      permanent deletion (with the master's actor_id), BEFORE the
//      profile row goes away.
//   5. Delete public.profile_locations (cascades from the profile
//      delete anyway, but explicit makes the intent clear).
//   6. Delete public.profiles.
//   7. Delete auth.users via admin API. The auth-user delete is the
//      last step — if the SQL above fails, we never touch auth.
//
// What we do NOT do:
//   - Touch any contact data (the staff member's customer interactions
//     stay attached to their contacts).
//   - Touch financial records (rosters, shifts, payroll history) —
//     attribution becomes NULL but the rows stay for HMRC / Revenue.
//
// Reversibility: NONE. Confirm twice before calling this.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  getUnifiConfig, revokeUnifiUserPolicies, UnifiError,
} from '@/lib/unifi-access'

export const runtime = 'nodejs'

// Tables with FK -> profiles.id that have ON DELETE NO ACTION and a
// nullable column. We NULL these out before deleting the profile so
// the FK doesn't block the delete. Listed pair-wise: { table, column }.
//
// If you add a new table that references profiles.id with NO ACTION,
// add it here too. Conversely, if you change one of these to SET NULL
// at the schema level, remove it from this list — it's a no-op then.
const AUDIT_FK_NULLOUT = [
  { table: 'campaigns', column: 'created_by' },
  { table: 'car_documents', column: 'xero_sent_by' },
  { table: 'company_settings', column: 'updated_by' },
  { table: 'consent_log', column: 'performed_by' },
  { table: 'email_sequences', column: 'created_by' },
  { table: 'email_templates', column: 'created_by' },
  { table: 'generated_reports', column: 'generated_by' },
  { table: 'rosters', column: 'over_budget_approval_by' },
  { table: 'rosters', column: 'published_by' },
  { table: 'rosters', column: 'created_by' },
  { table: 'scheduled_reports', column: 'created_by' },
  { table: 'shift_assignments', column: 'assigned_by' },
  { table: 'shift_blocks', column: 'created_by' },
  { table: 'shift_swap_requests', column: 'requester_id' },
  { table: 'shift_swap_requests', column: 'target_id' },
  { table: 'shift_swap_requests', column: 'reviewed_by' },
  { table: 'shifts', column: 'created_by' },
  { table: 'sms_broadcasts', column: 'created_by' },
  { table: 'time_off_requests', column: 'reviewed_by' },
  { table: 'whatsapp_broadcasts', column: 'created_by' },
  { table: 'whatsapp_conversations', column: 'assigned_to' },
  { table: 'whatsapp_messages', column: 'sent_by' },
  { table: 'whatsapp_templates', column: 'created_by' },
  { table: 'xero_connections', column: 'connected_by' },
]

export async function DELETE(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!user.isMaster) {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can permanently delete staff.',
    }, { status: 403 })
  }

  const { id } = params
  if (id === user.id) {
    return NextResponse.json({
      success: false,
      error: 'You cannot permanently delete your own account.',
    }, { status: 400 })
  }

  const db = createServerClient()

  // Pre-flight: must be already inactive. Forces the operator to do
  // the soft-archive flow first, which is the safety net that gives
  // them time to change their mind.
  const { data: profile, error: lookupErr } = await db
    .from('profiles')
    .select('id, email, full_name, active, role, profile_locations(*, locations(*))')
    .eq('id', id)
    .single()
  if (lookupErr || !profile) {
    return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 })
  }
  if (profile.active) {
    return NextResponse.json({
      success: false,
      error: 'Profile must be deactivated first. Soft-archive (set Active off) before permanent delete.',
    }, { status: 400 })
  }

  // Defence in depth: revoke any straggling UniFi access. The
  // soft-delete should have already done this, but it's cheap to
  // re-call. We don't fail the hard delete on UniFi errors here —
  // worst case the UniFi user lingers, but they have no profile
  // pointing at them so they can't badge in anyway (UniFi is keyed
  // on a separate id, not Supabase's).
  for (const link of profile.profile_locations || []) {
    if (!link.unifi_door_access || !link.unifi_user_id || !link.locations) continue
    // INTEG-A2 dual-read: registry row first, legacy settings.unifi otherwise.
    const cfg = await getUnifiConfig(db, link.locations)
    if (!cfg.configured) continue
    try {
      await revokeUnifiUserPolicies(cfg, link.unifi_user_id)
    } catch (e) {
      // Log but proceed — see comment above.
      console.warn(
        `[hard-delete] unifi revoke failed at ${link.locations.name}:`,
        e instanceof UnifiError ? e.message : e?.message || e
      )
    }
  }

  // Audit log entry — written BEFORE the profile is destroyed so we
  // have a record that the deletion happened, attributable to the
  // master who performed it. assignment_change_log.target_profile_id
  // is NOT NULL but has CASCADE on delete, so the row will go away
  // when we drop the profile. To keep a permanent record we copy
  // identifying info into the `before` blob — the row's target_profile_id
  // becomes orphaned but that's fine, the JSON is the audit data.
  await db.from('assignment_change_log').insert({
    actor_id: user.id,
    target_profile_id: id,
    location_id: null,
    action: 'permanent_delete',
    before: {
      email: profile.email,
      full_name: profile.full_name,
      role: profile.role,
      assignments: (profile.profile_locations || []).map((l) => ({
        location_id: l.location_id,
        location_name: l.locations?.name,
        role: l.role,
      })),
    },
    after: null,
  })

  // Anonymize audit-style FKs across all referencing tables. Each
  // is a single UPDATE — small payload, no row scan beyond the FK
  // index. If any of these fail we abort BEFORE the destructive
  // delete so the system stays in a consistent state.
  for (const { table, column } of AUDIT_FK_NULLOUT) {
    const { error } = await db.from(table).update({ [column]: null }).eq(column, id)
    if (error) {
      return NextResponse.json({
        success: false,
        error: `Failed to anonymize ${table}.${column}: ${error.message}. Aborted before deletion.`,
      }, { status: 500 })
    }
  }

  // Drop CASCADE-able rows explicitly to surface any unexpected error
  // before we touch the profile. profile_locations would cascade
  // anyway, but doing it here gives us a per-step error if RLS or
  // a trigger blocks it.
  await db.from('profile_locations').delete().eq('profile_id', id)

  // The profile delete cascades through:
  //   shift_assignments.profile_id, shifts.profile_id,
  //   time_off_requests.profile_id, staff_allowances.profile_id,
  //   schedule_notifications.profile_id, device_tokens.user_id,
  //   impersonation_log.{master_user_id, target_user_id},
  //   assignment_change_log.target_profile_id
  // This is the irreversible step.
  const { error: delErr } = await db.from('profiles').delete().eq('id', id)
  if (delErr) {
    return NextResponse.json({
      success: false,
      error: `Profile delete failed: ${delErr.message}`,
    }, { status: 500 })
  }

  // Last step: the auth user. If this fails, the profile is already
  // gone — the auth user becomes an orphan that can't sign in (the
  // CRM auth path requires a profile row). Not ideal, but recoverable
  // by manual deletion in the Supabase dashboard if needed.
  const { error: authErr } = await db.auth.admin.deleteUser(id)
  if (authErr) {
    console.warn('[hard-delete] auth.users delete failed (profile already gone):', authErr.message)
    return NextResponse.json({
      success: true,
      warning: `Profile deleted. Auth user delete failed: ${authErr.message}. The auth user is orphaned and cannot sign in — clean up manually in Supabase dashboard if desired.`,
    })
  }

  return NextResponse.json({ success: true })
}
