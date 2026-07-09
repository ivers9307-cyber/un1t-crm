// GET/POST/DELETE /api/hosts/[id]/link-staff — link an existing UN1T staff login
// to a host (dual staff+host account). ADMIN_ROLES; host + staff user must be in
// the caller's org. Deliberate STAFF-XOR exception (see host-auth.js). (HOST-PORTAL.5)
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { linkStaffDecision } from '@/lib/host-staff-link'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LinkSchema = z.object({ email: z.string().email().max(320) })
const UnlinkSchema = z.object({ auth_user_id: z.string().min(1) })

async function gate(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { err: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!ADMIN_ROLES.includes(user.role)) return { err: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { err: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return { err: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  return { db, orgId, hostId: host.id }
}

async function staffSharesOrg(db, staffId, orgId) {
  const { data: pls } = await db.from('profile_locations').select('location_id').eq('profile_id', staffId)
  const locIds = (pls || []).map((r) => r.location_id)
  if (locIds.length === 0) return false
  const { data: locs } = await db.from('locations').select('id').in('id', locIds).eq('organization_id', orgId)
  return (locs || []).length > 0
}

export async function GET(_request, props) {
  const g = await gate(props); if (g.err) return g.err
  const { data: links } = await g.db.from('host_users').select('auth_user_id, email').eq('host_id', g.hostId)
  const ids = (links || []).map((l) => l.auth_user_id)
  let nameById = {}
  if (ids.length) {
    const { data: profs } = await g.db.from('profiles').select('id, full_name').in('id', ids)
    nameById = Object.fromEntries((profs || []).map((p) => [p.id, p.full_name]))
  }
  const rows = (links || []).map((l) => ({ auth_user_id: l.auth_user_id, email: l.email, full_name: nameById[l.auth_user_id] || null }))
  return NextResponse.json({ success: true, data: rows })
}

export async function POST(request, props) {
  const g = await gate(props); if (g.err) return g.err
  const { db, orgId, hostId } = g
  let body; try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = LinkSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Enter a valid email.' }, { status: 400 })
  const email = parsed.data.email.trim()

  // Exact (case-insensitive) match — escape LIKE metacharacters so an email with
  // '_' or '%' can't act as a wildcard and match the wrong profile.
  const likeEmail = email.replace(/[\\%_]/g, '\\$&')
  const { data: staffProfile } = await db.from('profiles').select('id, full_name, email').ilike('email', likeEmail).maybeSingle()
  const sameOrg = staffProfile ? await staffSharesOrg(db, staffProfile.id, orgId) : false
  const existingLink = staffProfile
    ? (await db.from('host_users').select('host_id').eq('auth_user_id', staffProfile.id).maybeSingle()).data
    : null

  const decision = linkStaffDecision({ staffProfile, sameOrg, existingLink, hostId })
  const errors = {
    not_staff: 'That email isn’t a UN1T staff account — use “Invite to portal” for a 3rd-party host on a separate email.',
    cross_org: 'That staff member is not in this organisation.',
    other_host: 'That staff member is already linked to another host.',
  }
  if (decision === 'already') return NextResponse.json({ success: true, data: { already: true, full_name: staffProfile.full_name, email: staffProfile.email } })
  if (decision !== 'ok') return NextResponse.json({ success: false, error: errors[decision] }, { status: 400 })

  const { error: insErr } = await db.from('host_users').insert({ host_id: hostId, auth_user_id: staffProfile.id, email: staffProfile.email || email })
  if (insErr) {
    logError('host-link-staff', 'link insert failed', { err: insErr })
    return NextResponse.json({ success: false, error: 'Could not link that staff login.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { linked: { full_name: staffProfile.full_name, email: staffProfile.email || email } } })
}

export async function DELETE(request, props) {
  const g = await gate(props); if (g.err) return g.err
  let body; try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = UnlinkSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid request.' }, { status: 400 })
  const { error } = await g.db.from('host_users').delete().eq('host_id', g.hostId).eq('auth_user_id', parsed.data.auth_user_id)
  if (error) {
    logError('host-link-staff', 'unlink delete failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not unlink.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
