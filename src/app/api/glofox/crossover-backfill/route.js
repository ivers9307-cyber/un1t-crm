// /api/glofox/crossover-backfill — GLOFOXSIBLING.1 one-off repair.
//
// Before GLOFOXSIBLING.1 a Glofox member whose one CRM contact lives at a
// sibling studio of the same organisation never reached the CRM: the
// studio-scoped lookup missed and the create hit contacts_email_org_unique
// (mig 712). The sync attaches them now, but the nightly cron only revisits
// members modified in the last 25 hours, so the people already stuck stay
// stuck until Glofox happens to touch them. This route finds exactly them and,
// when asked, syncs only them.
//
// Master-only. One Glofox member LIST page per call (caller pages):
//   POST { location_id, page?: 1, limit?: 100, dry_run?: true }
// dry_run (the default) reads only: it lists the candidates and conflicts.
// dry_run:false runs applyMemberSync for the candidates on the page (at most
// APPLY_CAP), which links each one (glofox_crossover_members + the studio's
// preferences row) exactly as the webhook and the cron now do.
// The response carries ids only, never names or emails.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { GLOFOX_SETTINGS_UNREADABLE, GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { glofoxCredentialsForLocation, fetchAllMembersPage } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { findGlofoxCrossoverContact } from '@/lib/glofox-crossover'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const APPLY_CAP = 25

export const CrossoverBackfillBody = z.object({
  location_id: uuidLike,
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  dry_run: z.boolean().optional(),
})

const memberIdOf = (m) => (m?._id || m?.id ? String(m._id || m.id) : null)
const emailOf = (m) => (typeof m?.email === 'string' && m.email.trim() ? m.email.trim().toLowerCase() : null)

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })

  const validation = await validateBody(request, CrossoverBackfillBody)
  if (!validation.ok) return validation.response
  const { location_id: locationId } = validation.data
  const page = validation.data.page ?? 1
  const limit = validation.data.limit ?? 100
  const dryRun = validation.data.dry_run !== false

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (creds.readError) {
    return NextResponse.json({ success: false, code: GLOFOX_SETTINGS_UNREADABLE, error: GLOFOX_SETTINGS_UNREADABLE_MESSAGE }, { status: 503 })
  }
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({ success: false, error: 'Glofox credentials not configured for this location.' }, { status: 400 })
  }

  const { data: members, total, hasMore } = await fetchAllMembersPage(creds, { page, limit })
  const list = (members || []).filter((m) => memberIdOf(m))

  // Who the studio already holds, by Glofox id or email (two batched reads).
  const ids = list.map(memberIdOf)
  const emails = [...new Set(list.map(emailOf).filter(Boolean))]
  const known = new Set()
  if (ids.length) {
    const { data, error } = await db.from('contacts').select('glofox_member_id')
      .eq('location_id', locationId).in('glofox_member_id', ids)
    if (error) return NextResponse.json({ success: false, error: `contacts read: ${error.message}` }, { status: 500 })
    for (const r of data || []) known.add(`id:${r.glofox_member_id}`)
  }
  if (emails.length) {
    const { data, error } = await db.from('contacts').select('email')
      .eq('location_id', locationId).in('email', emails)
    if (error) return NextResponse.json({ success: false, error: `contacts read: ${error.message}` }, { status: 500 })
    for (const r of data || []) if (r.email) known.add(`email:${r.email.toLowerCase()}`)
  }

  const candidates = []
  const conflicts = []
  const errors = []
  for (const m of list) {
    const id = memberIdOf(m)
    const email = emailOf(m)
    if (known.has(`id:${id}`) || (email && known.has(`email:${email}`))) continue
    const x = await findGlofoxCrossoverContact(db, locationId, { glofoxMemberId: id, email })
    if (x.error) { errors.push({ glofox_member_id: id, error: x.error }); continue }
    if (x.conflict) { conflicts.push({ glofox_member_id: id, contact_ids: x.conflict.contact_ids, reason: x.conflict.reason }); continue }
    // A contact AT this studio found only by a case-different email is not a
    // crossover; the sync matches it now either way.
    if (x.contact && x.contact.location_id !== locationId) {
      candidates.push({ member: m, glofox_member_id: id, contact_id: x.contact.id, home_location_id: x.contact.location_id, how: x.how })
    }
  }

  const applied = []
  if (!dryRun) {
    const membershipCache = new Map()
    for (const c of candidates.slice(0, APPLY_CAP)) {
      try {
        const r = await applyMemberSync(db, locationId, c.member, { creds, membershipCache })
        applied.push({
          glofox_member_id: c.glofox_member_id,
          contact_id: r.contact_id ?? null,
          action: r.error ? 'error' : r.action,
          linked: !!r.crossover_link?.linked,
          error: r.error || r.crossover_link?.error || null,
        })
      } catch (e) {
        logError('glofox-crossover-backfill', 'applyMemberSync threw', { locationId, glofox_member_id: c.glofox_member_id, err: e?.message })
        applied.push({ glofox_member_id: c.glofox_member_id, contact_id: null, action: 'error', linked: false, error: e?.message || 'threw' })
      }
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      dry_run: dryRun,
      location_id: locationId,
      page,
      limit,
      has_more: hasMore,
      total_available: total,
      scanned: list.length,
      candidates: candidates.map(({ member: _member, ...rest }) => rest),
      conflicts,
      errors,
      applied,
      apply_cap: APPLY_CAP,
      left_on_page: dryRun ? candidates.length : Math.max(0, candidates.length - APPLY_CAP),
    },
  })
}
