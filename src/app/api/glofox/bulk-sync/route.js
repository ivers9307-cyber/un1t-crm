// /api/glofox/bulk-sync — operator-triggered batched member sync.
//
// GLOFOX2.1.16 — Tier 2 #4. The efficient successor to per-member
// /api/glofox/sync-member calls. Foundation for the GLOFOX2.2
// daily cron.
//
// Master-only. POST body shape (all optional):
//   {
//     "filters": {
//       "lead_status": ["MEMBER", "TRIAL"],     -- subset to sync
//       "created":  { "start": 1778000000 },    -- Unix seconds
//       "modified": { "start": 1778000000 }     -- Unix seconds
//     },
//     "pagination": { "skip": 0, "limit": 50 }, -- per Glofox spec
//     "dry_run": true                            -- preview only (no DB writes)
//   }
//
// Response shape:
//   {
//     ok: true,
//     dry_run: true|false,
//     fetched: <count from Glofox>,
//     total_available: <Glofox total_count if returned>,
//     processed: [
//       { glofox_member_id, name, action, error?, contact_id?,
//         deal?, interactions? }
//     ],
//     summary: {
//       create: 12, update: 30, ambiguous: 1, invalid: 0, error: 0
//     }
//   }
//
// Implementation notes:
// - Single-page sync (caller paginates by re-calling with
//   incremented skip). Keeps individual requests bounded under
//   Vercel's 60s timeout.
// - Membership cache is shared across the page so the
//   N-credit-members-with-the-same-Class-Packs-membership case
//   only does ONE membership lookup per page.
// - Bookings + interactions per-member API calls still happen
//   inside applyMemberSync — a 50-member page makes ~3 calls/member
//   = 150 Glofox calls. At 10 req/sec live ceiling, that's ~15s.
//   Comfortable under Vercel's timeout.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation, fetchBranchLeads } from '@/lib/glofox'
import { previewMemberSync, applyMemberSync } from '@/lib/glofox-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Vercel hobby tier ceiling

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { body = {} }
  const url = new URL(request.url)
  const locationId = body.location_id || url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide location_id (in body or ?location_id=) or set an active location',
    }, { status: 400 })
  }

  const filters = body.filters || {}
  const pagination = {
    skip: Number(body?.pagination?.skip) || 0,
    limit: Math.min(Math.max(Number(body?.pagination?.limit) || 50, 1), 100),
  }
  // Default to dry_run=true — explicit `false` to actually persist.
  const dryRun = body.dry_run !== false

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox credentials not configured for this location.',
    }, { status: 400 })
  }

  // Fetch the page of leads matching the filters.
  const { data: leads, total: totalAvailable, raw } = await fetchBranchLeads(creds, filters, pagination)
  if (!leads || leads.length === 0) {
    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      location_id: locationId,
      filters,
      pagination,
      fetched: 0,
      total_available: totalAvailable,
      processed: [],
      summary: { create: 0, update: 0, ambiguous: 0, invalid: 0, error: 0 },
      hint: 'No leads matched the filter for this page.',
    })
  }

  // Shared membership cache across the page — many members share
  // the same Membership (Class Packs, Subscription tiers), so this
  // turns N membership lookups into ~3-5 lookups per page.
  const membershipCache = new Map()
  const processed = []
  const summary = { create: 0, update: 0, ambiguous: 0, invalid: 0, error: 0 }

  for (const lead of leads) {
    const memberId = lead._id || lead.id || lead.member_id || null
    const name = lead.name || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null
    try {
      const result = dryRun
        ? await previewMemberSync(db, locationId, lead, { creds, membershipCache })
        : await applyMemberSync(db, locationId, lead, { creds, membershipCache })
      summary[result.action] = (summary[result.action] || 0) + 1
      processed.push({
        glofox_member_id: memberId,
        name,
        action: result.action,
        contact_id: result.contact_id || null,
        deal: result.deal || null,
        interactions: result.interactions || null,
        error: result.error || null,
      })
    } catch (e) {
      summary.error++
      processed.push({
        glofox_member_id: memberId,
        name,
        action: 'error',
        error: e?.message || 'unknown',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    location_id: locationId,
    branch_id: creds.branchId,
    filters,
    pagination,
    fetched: leads.length,
    total_available: totalAvailable,
    has_more: typeof totalAvailable === 'number'
      ? (pagination.skip + leads.length) < totalAvailable
      : null,
    processed,
    summary,
    raw_response_meta: raw && typeof raw === 'object'
      ? { keys: Object.keys(raw).filter(k => k !== 'data') }
      : null,
  })
}
