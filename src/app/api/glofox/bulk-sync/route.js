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
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { glofoxCredentialsForLocation, fetchAllMembersPage, glofoxFetch } from '@/lib/glofox'
import { previewMemberSync, applyMemberSync } from '@/lib/glofox-sync'
import { validateBody } from '@/lib/validate'

const BulkSyncBody = z.object({
  location_id: uuidLike.optional(),
  filters: z.object({
    lead_status: z.array(z.string()).optional(),
    created: z.object({ start: z.number().optional() }).optional(),
    modified: z.object({ start: z.number().optional() }).optional(),
  }).optional(),
  pagination: z.object({
    skip: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).optional(),
  dry_run: z.boolean().optional(),
  mode: z.enum(['glofox_pull', 'crm_resync']).optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Vercel hobby tier ceiling

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'master') {
    return NextResponse.json({ ok: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, BulkSyncBody, { allowEmpty: true })
  if (!validation.ok) return validation.response
  const body = validation.data
  const url = new URL(request.url)
  const locationId = body.location_id || url.searchParams.get('location_id') || user.activeLocation?.id || null
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({
      ok: false,
      error: 'Provide location_id (in body or ?location_id=) or set an active location',
    }, { status: 400 })
  }

  // GLOFOX2.4 — Glofox's /2.0/members endpoint uses page+limit
  // (not skip+limit). The UI still speaks skip; we convert here.
  // The lead_status filter is now CLIENT-SIDE (applied to the
  // fetched page below) because /2.0/members doesn't accept it
  // as a query param. modified_since is also client-side for
  // the same reason.
  const filters = body.filters || {}
  const pagination = {
    skip: Number(body?.pagination?.skip) || 0,
    limit: Math.min(Math.max(Number(body?.pagination?.limit) || 50, 1), 100),
  }
  const page = Math.floor(pagination.skip / pagination.limit) + 1
  // Default to dry_run=true — explicit `false` to actually persist.
  const dryRun = body.dry_run !== false
  // GLOFOX2.7 — mode controls where we get the member list from.
  //   'glofox_pull'  (default) — paginate /2.0/members (everyone at the studio)
  //   'crm_resync'   — iterate contacts.glofox_member_id IS NOT NULL,
  //                    fetch each one's current Glofox state and re-apply.
  //                    Lets the operator validate code changes immediately
  //                    without waiting for the daily cron.
  const mode = body.mode === 'crm_resync' ? 'crm_resync' : 'glofox_pull'

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      ok: false,
      error: 'Glofox credentials not configured for this location.',
    }, { status: 400 })
  }

  // GLOFOX2.4 / GLOFOX2.7 — two data sources depending on mode.
  let pageData
  let totalAvailable
  let hasMore
  if (mode === 'crm_resync') {
    // Iterate already-linked CRM contacts. For each we re-fetch
    // the live Glofox member object so applyMemberSync sees the
    // latest data (membership status, credits, bookings,
    // interactions). Pagination here is over the CRM contacts
    // table, not the Glofox API.
    const { data: contacts, count } = await db
      .from('contacts')
      .select('id, glofox_member_id, name', { count: 'exact' })
      .eq('location_id', locationId)
      .not('glofox_member_id', 'is', null)
      .order('id', { ascending: true })
      .range(pagination.skip, pagination.skip + pagination.limit - 1)
    totalAvailable = count ?? 0
    hasMore = (pagination.skip + (contacts?.length || 0)) < (totalAvailable || 0)
    // Fetch each member from Glofox in parallel-ish (sequential
    // here for simplicity + Glofox rate-limit safety). Drop any
    // that 404 — operator can investigate via the audit row's
    // error message.
    const fetched = []
    for (const c of (contacts || [])) {
      try {
        const r = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(c.glofox_member_id)}`)
        if (!r.ok) {
          fetched.push({ _id: c.glofox_member_id, name: c.name, _resync_error: `Glofox HTTP ${r.status}` })
          continue
        }
        const body = await r.json()
        const member = body?.data || body?.member || body
        if (member) fetched.push(member)
      } catch (e) {
        fetched.push({ _id: c.glofox_member_id, name: c.name, _resync_error: e?.message || 'fetch failed' })
      }
    }
    pageData = fetched
  } else {
    // GLOFOX2.4 — fetch a page from /2.0/members (the canonical
    // all-users endpoint). Returns ALL lead_status values; we apply
    // the operator's lead_status filter client-side below.
    const { data: pd, total, hasMore: hm } = await fetchAllMembersPage(creds, {
      page, limit: pagination.limit,
    })
    pageData = pd
    totalAvailable = total
    hasMore = hm
  }
  // Client-side filtering — operator-supplied lead_status[] +
  // modified.start narrow the page after fetch.
  let leads = pageData
  const wantStatuses = Array.isArray(filters?.lead_status) && filters.lead_status.length > 0
    ? new Set(filters.lead_status.map(s => String(s).toUpperCase()))
    : null
  const modifiedSinceSec = Number(filters?.modified?.start) || null
  // GLOFOX2.4 — track whether ANY member on this page is older than
  // the modified-since cutoff. Because /2.0/members is sorted
  // modified-DESC, a single hit means every later page is also
  // out-of-window — we set has_more=false to stop the auto-paginate
  // loop early (mirrors the cron's early-termination logic).
  let crossedCutoff = false
  if (wantStatuses || modifiedSinceSec) {
    leads = leads.filter(m => {
      if (wantStatuses) {
        const status = String(m?.lead_status || m?.leads?.status || '').toUpperCase()
        if (!wantStatuses.has(status)) return false
      }
      if (modifiedSinceSec) {
        const mod = Number(m?.modified) || 0
        if (mod > 0 && mod < modifiedSinceSec) {
          crossedCutoff = true
          return false
        }
      }
      return true
    })
  }
  const filteredCount = leads.length
  const fetchedRaw = pageData?.length || 0
  // Override has_more when modified-since cutoff was crossed —
  // /2.0/members's natural has_more says "more pages of users",
  // but we know everything past the cutoff is out of window.
  const effectiveHasMore = crossedCutoff ? false : hasMore
  if (!leads || leads.length === 0) {
    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      location_id: locationId,
      filters,
      pagination,
      fetched: 0,
      raw_page_count: fetchedRaw,
      total_available: totalAvailable,
      has_more: effectiveHasMore,
      processed: [],
      summary: { create: 0, update: 0, ambiguous: 0, invalid: 0, error: 0 },
      hint: fetchedRaw > 0
        ? `Fetched ${fetchedRaw} from this page but none matched the lead_status / modified filter. Try the next page or relax the filter.`
        : 'No more members available.',
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
    // GLOFOX2.7 — surface re-sync fetch failures inline rather
    // than trying to map an error stub through applyMemberSync.
    if (lead._resync_error) {
      summary.error++
      processed.push({
        glofox_member_id: memberId,
        name,
        action: 'error',
        error: `Glofox fetch failed: ${lead._resync_error}`,
      })
      continue
    }
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
    mode,
    location_id: locationId,
    branch_id: creds.branchId,
    filters,
    pagination,
    fetched: leads.length,
    raw_page_count: fetchedRaw,
    filtered_out: fetchedRaw - filteredCount,
    total_available: totalAvailable,
    // GLOFOX2.4 — has_more comes from the Glofox response (page-level
    // signal). The /2.0/members has_more reflects "is there another
    // page of users", not "is there another match" — important for the
    // auto-paginate loop, which keeps going as long as has_more even if
    // a page yielded zero matches after client-side filtering.
    has_more: hasMore,
    processed,
    summary,
  })
}
