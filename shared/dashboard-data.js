// Shared dashboard data fetchers. Single source of truth for the
// numbers shown on both the web /dashboard/* pages and the mobile
// Home tab.
//
// Each function takes a Supabase client (so it works with either
// createServerClient on web or the browser supabase singleton on
// mobile) plus the relevant scope IDs, and returns
// `{ success, data?, error? }` with a flat `data` shape that the UI
// renders without further reshaping.
//
// Pure functions — no React, no Next.js imports — so this file is
// safe to import from Metro (React Native) and from server / client
// React components.

import { upcomingWeeksBounds, summariseShifts } from './roster-month.js'
import { pctDelta, sumCampaignRows, shapeFunnel, FUNNEL_SLUGS } from './dashboard-metrics.js'

// ============================================================
// Date helpers (shared across all three fetchers)
// ============================================================

export function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function startOfWeek(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const dow = x.getDay()
  const diff = dow === 0 ? -6 : 1 - dow
  x.setDate(x.getDate() + diff)
  return x
}

export function endOfWeek(d = new Date()) {
  const x = startOfWeek(d)
  x.setDate(x.getDate() + 6)
  x.setHours(23, 59, 59, 999)
  return x
}

export function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

// ============================================================
// Shift-cost helpers (used by Business dashboard's labour estimate)
// ============================================================

export function shiftDurationHours(shift) {
  // Prefer override times; fall back to template defaults.
  const start = shift.start_time_override || shift.shift_templates?.start_time
  const end = shift.end_time_override || shift.shift_templates?.end_time
  if (!start || !end) return 0
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60 // overnight shift
  return Math.round((mins / 60) * 10) / 10
}

export function hourlyRateFor(profile) {
  // Match src/lib/payroll.js basic logic. Returns 0 if neither rate
  // nor salary is set so we don't error out on partial profiles.
  if (profile?.hourly_rate && Number(profile.hourly_rate) > 0) {
    return Number(profile.hourly_rate)
  }
  const salary = Number(profile?.annual_salary || 0)
  const hours = Number(profile?.contracted_hours_per_week || 0)
  if (salary > 0 && hours > 0) return salary / 52 / hours
  return 0
}

// RETIRE-SHIFTS-MIRROR.2 — read scheduled shifts from the Roster v2 source
// of truth (shift_assignments + shift_blocks) instead of the legacy
// public.shifts mirror, normalised back to the exact legacy shift shape the
// dashboards already consume. `published` is derived from the block's roster
// (publishing is a roster concept now: a shift is published iff its block
// belongs to a published roster). Returns { data, error } so it drops into
// the existing Promise.all destructuring unchanged. `id` is the assignment
// id — used only as a display key here (the swap flow reads shift ids from
// the schedule screen, not the dashboard).
async function fetchDashboardShifts(supabase, { profileId, locationId, startDate, endDate, withProfiles = false }) {
  const profileSelect = withProfiles
    ? ', profiles:profile_id ( annual_salary, hourly_rate, contracted_hours_per_week, employment_type )'
    : ''
  let q = supabase
    .from('shift_assignments')
    .select(`
      id, profile_id, start_time_override, end_time_override, status,
      shift_blocks!inner ( block_date, location_id, roster_id, rosters:roster_id ( status ), shift_templates ( name, start_time, end_time ), locations:location_id ( id, name ) )${profileSelect}
    `)
    .gte('shift_blocks.block_date', startDate)
    .lte('shift_blocks.block_date', endDate)
  if (profileId) q = q.eq('profile_id', profileId)
  if (locationId) q = q.eq('shift_blocks.location_id', locationId)
  const { data, error } = await q
  if (error) return { data: null, error }
  const rows = (data || []).map((r) => {
    const block = r.shift_blocks || {}
    return {
      id: r.id,
      shift_date: block.block_date,
      start_time_override: r.start_time_override,
      end_time_override: r.end_time_override,
      status: r.status,
      published: block.rosters?.status === 'published',
      location_id: block.location_id,
      shift_templates: block.shift_templates,
      locations: block.locations,
      profiles: r.profiles,
    }
  })
  return { data: rows, error: null }
}

// ============================================================
// Personal — your shifts, your swaps, your inbox.
// ============================================================

export async function fetchPersonalDashboardData(supabase, profileId, locationId) {
  if (!profileId) return { success: false, error: 'No profile' }

  // 14-day window — this Monday → next Sunday — fetched as a single
  // query and split client-side. Cheaper than two queries.
  const today = new Date()
  const todayIso = isoDate(today)
  const thisWeekStart = startOfWeek(today)
  const thisWeekEnd = endOfWeek(today)
  const nextWeekStart = new Date(thisWeekEnd); nextWeekStart.setDate(nextWeekStart.getDate() + 1)
  const nextWeekEnd = new Date(nextWeekStart); nextWeekEnd.setDate(nextWeekEnd.getDate() + 6); nextWeekEnd.setHours(23, 59, 59, 999)

  const thisWeekStartIso = isoDate(thisWeekStart)
  const thisWeekEndIso = isoDate(thisWeekEnd)
  const nextWeekStartIso = isoDate(nextWeekStart)
  const nextWeekEndIso = isoDate(nextWeekEnd)

  // Rolling 7-week roster window (this week + the next 6), anchored on the same
  // "today" as the week dates. Kept under the monthStartIso/monthEndIso/monthShifts
  // keys so the downstream pipeline + buildMonthMatrix consume it unchanged — the
  // "Upcoming" toggle shows this window instead of a calendar month.
  const { monthStartIso, monthEndIso } = upcomingWeeksBounds(todayIso, 7)

  const [shifts, monthShiftsResult, swapsTargetingMe, myPendingTimeOff, myConvos, myPostedSwapsResult] =
    await Promise.all([
      // Cross-location query — filtered by profile_id only. Multi-
      // location staff see every shift they're assigned to, anywhere.
      // The locations() join lets the UI render a small chip on each
      // row so users can tell which gym a shift belongs to.
      // RETIRE-SHIFTS-MIRROR.2 — reads shift_assignments+shift_blocks now;
      // shape (incl. derived `published`) is unchanged. Re-sorted below.
      fetchDashboardShifts(supabase, { profileId, startDate: thisWeekStartIso, endDate: nextWeekEndIso }),

      // Month shifts for the calendar/agenda view (personal data is small —
      // a second range call is fine; avoids coupling the 14-day window logic).
      fetchDashboardShifts(supabase, { profileId, startDate: monthStartIso, endDate: monthEndIso }),

      // Swaps targeted at this coach that still need their accept/decline.
      // CT-P3: the old embed referenced the dropped public.shifts table AND
      // profiles!requester_id (which 500s on mobile's authenticated client —
      // no profiles grant). Read shift info via shift_assignments only; the
      // requester NAME for the actionable list is fetched client-side from
      // GET /api/schedule/swaps?for_me=1 (service-role).
      supabase
        .from('shift_swap_requests')
        .select('id, requester_id, requester_shift_id, target_id, status, reason, created_at, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date, shift_templates(name)))')
        .eq('target_id', profileId)
        .eq('status', 'pending'),

      supabase
        .from('time_off_requests')
        .select('id, type, start_date, end_date, status, created_at')
        .eq('profile_id', profileId)
        .eq('status', 'pending')
        .order('start_date', { ascending: true }),

      locationId
        ? supabase
            .from('whatsapp_conversations')
            .select('id, unread_count, last_message_preview, contacts:contact_id(name, first_name)')
            .eq('assigned_to', profileId)
            .gt('unread_count', 0)
        : Promise.resolve({ data: [] }),

      // Swaps the coach has POSTED that are still live — pending (nobody took
      // it yet) OR awaiting_approval (someone claimed; pending manager). Used
      // by the Today "My requests" list to show status + cancel.
      // CT-P3 fix: shift_templates must nest UNDER shift_blocks (there is no
      // shift_assignments->shift_templates FK; the old sibling embed errored
      // → this list was silently always empty).
      supabase
        .from('shift_swap_requests')
        .select('id, status, reason, created_at, target_id, requester_shift_id, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date, shift_templates(name)))')
        .eq('requester_id', profileId)
        .in('status', ['pending', 'awaiting_approval']),
    ])

  if (shifts.error) return { success: false, error: shifts.error.message }

  const monthShifts = (monthShiftsResult.data || []).slice().sort((a, b) => {
    if (a.shift_date !== b.shift_date) return a.shift_date.localeCompare(b.shift_date)
    const aStart = a.start_time_override || a.shift_templates?.start_time || ''
    const bStart = b.start_time_override || b.shift_templates?.start_time || ''
    return aStart.localeCompare(bStart)
  })
  const monthSummary = summariseShifts(monthShifts)

  // Sort by date then start time so "first shift of the day" is index [0].
  const sortedShifts = (shifts.data || []).slice().sort((a, b) => {
    if (a.shift_date !== b.shift_date) return a.shift_date.localeCompare(b.shift_date)
    const aStart = a.start_time_override || a.shift_templates?.start_time || ''
    const bStart = b.start_time_override || b.shift_templates?.start_time || ''
    return aStart.localeCompare(bStart)
  })

  // Split the 14 days into the two week buckets. KPIs (hours / shift
  // count) are based on THIS week only — that's the metric staff care
  // about for the current pay period.
  const thisWeekShifts = sortedShifts.filter(s =>
    s.shift_date >= thisWeekStartIso && s.shift_date <= thisWeekEndIso
  )
  const nextWeekShifts = sortedShifts.filter(s =>
    s.shift_date >= nextWeekStartIso && s.shift_date <= nextWeekEndIso
  )
  const totalHours = thisWeekShifts.reduce((sum, s) => sum + shiftDurationHours(s), 0)
  const unreadInbox = (myConvos.data || []).reduce((sum, c) => sum + (c.unread_count || 0), 0)

  return {
    success: true,
    data: {
      // This week
      weekShifts: thisWeekShifts,
      shiftsThisWeek: thisWeekShifts.length,
      hoursThisWeek: Math.round(totalHours * 10) / 10,
      weekStartIso: thisWeekStartIso,
      weekEndIso: thisWeekEndIso,
      // Next week
      nextWeekShifts,
      nextWeekStartIso,
      nextWeekEndIso,
      // Month roster (calendar / agenda view)
      monthShifts,
      monthStartIso,
      monthEndIso,
      shiftsThisMonth: monthSummary.count,
      hoursThisMonth: monthSummary.hours,
      // Other
      pendingSwapsForMe: swapsTargetingMe.data || [],
      myPostedSwaps: myPostedSwapsResult.data || [],
      myPendingTimeOff: myPendingTimeOff.data || [],
      unreadInbox,
      assignedConversations: myConvos.data || [],
    },
  }
}

// ============================================================
// Unstaffed blocks — count of empty future shift_blocks across
// the manager/owner's assigned locations this week. Surfaced as
// an alert chip on the Today tab + the manager mobile home.
// Only meaningful for managers, head_coaches, owners.
//
// Roster v2 phase 2. Empty blocks are demand windows (template
// × date) with zero coach assignments — customers will be in the
// studio either way, so leaving these unsurfaced is a hazard.
// ============================================================

export async function fetchUnstaffedBlocksThisWeek(supabase, locationIds) {
  if (!locationIds || locationIds.length === 0) {
    return { success: true, data: { count: 0, byLocation: {} } }
  }

  const todayIso = isoDate(new Date())
  const endIso = isoDate(endOfWeek())

  // Pull blocks for the visible window, then filter to those with
  // zero assignments. Cheaper than aggregating in SQL given the
  // small row count (a typical week has ~50 blocks at one location).
  const { data, error } = await supabase
    .from('shift_blocks')
    .select('id, location_id, block_date, shift_assignments(count)')
    .in('location_id', locationIds)
    .gte('block_date', todayIso)
    .lte('block_date', endIso)

  if (error) return { success: false, error: error.message }

  const empty = (data || []).filter(b => (b.shift_assignments?.[0]?.count ?? 0) === 0)
  const byLocation = {}
  for (const b of empty) {
    byLocation[b.location_id] = (byLocation[b.location_id] || 0) + 1
  }

  return {
    success: true,
    data: { count: empty.length, byLocation },
  }
}

// ============================================================
// Pending roster approvals — count of draft rosters waiting on
// owner sign-off at locations where the viewer can approve.
//
// Roster v2 phase 5 follow-up. The /schedule/approvals page is
// linkable from email + the schedule, but owners shouldn't have
// to remember to check. This chip on the Today tab surfaces the
// count whenever they log in.
//
// Visibility: only counts drafts at locations where the viewer
// is OWNER (or master). A manager who happens to land on the
// Today tab won't see "5 approvals waiting" for things they
// can't act on.
//
// `ownerLocationIds` is the array of location IDs where the
// caller is an owner. For master, pass every accessible
// location; the function doesn't try to second-guess the
// caller's per-location role.
// ============================================================

export async function fetchPendingRosterApprovalsCount(supabase, ownerLocationIds) {
  if (!ownerLocationIds || ownerLocationIds.length === 0) {
    return { success: true, data: { count: 0 } }
  }

  const { count, error } = await supabase
    .from('rosters')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'draft')
    .in('location_id', ownerLocationIds)

  if (error) return { success: false, error: error.message }
  return { success: true, data: { count: count || 0 } }
}

// ============================================================
// Profile cost-data completeness — manager-facing warning that
// surfaces staff at the manager's locations missing the data
// the phase 4 cost panel needs.
//
// Roster v2 phase 3. The columns themselves
// (employment_type, contracted_hours_per_week, hourly_rate,
// annual_salary) all pre-existed; this fetcher just rolls up
// "who's incomplete" so the operator can fix it.
//
// Returns at most 20 names — enough to surface the pattern,
// not enough to overwhelm the chip if 200 contractors are
// missing rates after a bulk import.
// ============================================================

export async function fetchIncompletePayProfiles(supabase, locationIds) {
  if (!locationIds || locationIds.length === 0) {
    return { success: true, data: { count: 0, sample: [] } }
  }

  // Pull profiles assigned to any of the operator's locations
  // and check the cost-data completeness rule:
  //   FTE        → annual_salary OR hourly_rate must be set,
  //                AND contracted_hours_per_week > 0
  //   Contractor → hourly_rate must be set
  // Inactive profiles are excluded — they don't get rostered.
  const { data, error } = await supabase
    .from('profile_locations')
    .select('profiles:profile_id(id, full_name, active, employment_type, hourly_rate, annual_salary, contracted_hours_per_week)')
    .in('location_id', locationIds)

  if (error) return { success: false, error: error.message }

  const seen = new Set()
  const incomplete = []
  for (const row of data || []) {
    const p = row.profiles
    if (!p || !p.active) continue
    if (seen.has(p.id)) continue
    seen.add(p.id)

    const isFte = p.employment_type === 'fte'
    const isContractor = p.employment_type === 'contractor'
    const hasFtePay = (Number(p.annual_salary) > 0) || (Number(p.hourly_rate) > 0)
    const hasFteHours = Number(p.contracted_hours_per_week) > 0
    const hasContractorRate = Number(p.hourly_rate) > 0

    const missing = isFte
      ? (!hasFtePay || !hasFteHours)
      : isContractor
        ? !hasContractorRate
        : false

    if (missing) {
      incomplete.push({
        id: p.id,
        name: p.full_name,
        employment_type: p.employment_type,
      })
    }
  }

  return {
    success: true,
    data: {
      count: incomplete.length,
      sample: incomplete.slice(0, 20),
    },
  }
}

// ============================================================
// Studio — operational view for managers + head coaches.
// Leads / members / approvals queue. No financial data.
// ============================================================

export async function fetchStudioDashboardData(supabase, locationId) {
  if (!locationId) return { success: false, error: 'No location' }

  const weekStartIso = startOfWeek().toISOString()

  const [
    pendingTimeOff, pendingSwaps,
    newLeadsThisWeek, unreadConvos,
  ] = await Promise.all([
    supabase
      .from('time_off_requests')
      .select('id, profile_id, type, start_date, end_date, total_days, created_at, profiles!profile_id(full_name)')
      .eq('location_id', locationId)
      .eq('status', 'pending')
      .order('start_date', { ascending: true }),

    supabase
      .from('shift_swap_requests')
      .select('id, requester_id, target_id, created_at, requester:profiles!requester_id(full_name)')
      .eq('location_id', locationId)
      .eq('status', 'pending'),

    // joined_at, NOT lead_created_at: the latter defaults to NOW() at
    // insert (mig 001), so every bulk-imported contact carries its
    // import day and any import spikes this count into the thousands.
    // joined_at is the Glofox-side signup date — the same signal
    // fetchFunnelCounts uses for "entered" below.
    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gte('joined_at', weekStartIso),

    supabase
      .from('whatsapp_conversations')
      .select('unread_count')
      .eq('location_id', locationId)
      .gt('unread_count', 0),
  ])

  // AUDIT P1-2 — the funnel reads pipeline_stage_slug for EVERY contact at the
  // location (Stillorgan is 8,000+), so a bare .select() silently truncated at
  // the PostgREST 1000-row cap — the funnel + totalContacts under-counted by
  // ~7,000. This file is the shared web↔mobile seam and CANNOT import
  // src/lib/select-all (check:mobile-imports forbids it), so we inline a
  // .range() page loop (no import) instead. Kept faithful to the original
  // return shape: a per-slug funnel map (including an 'unknown' bucket for
  // NULL / off-list slugs) plus an EXACT totalContacts = sum of all rows. The
  // narrow single-column projection makes the ~8 pages cheap.
  const funnel = {}
  let totalContacts = 0
  const PAGE = 1000
  const HARD_LIMIT = 200_000
  for (let from = 0; from < HARD_LIMIT; from += PAGE) {
    const { data: page, error } = await supabase
      .from('contacts')
      .select('pipeline_stage_slug')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    // Best-effort, matching the original (which never checked .error): on a
    // mid-pagination failure, stop and render the funnel built so far rather
    // than blanking the whole dashboard (the other cards loaded fine).
    if (error) break
    if (!Array.isArray(page) || page.length === 0) break
    for (const c of page) {
      const k = c.pipeline_stage_slug || 'unknown'
      funnel[k] = (funnel[k] || 0) + 1
    }
    totalContacts += page.length
    if (page.length < PAGE) break
  }
  const totalUnread = (unreadConvos.data || []).reduce((s, c) => s + (c.unread_count || 0), 0)

  return {
    success: true,
    data: {
      pendingTimeOff: pendingTimeOff.data || [],
      pendingSwaps: pendingSwaps.data || [],
      newLeadsThisWeek: newLeadsThisWeek.count || 0,
      funnel,
      totalContacts,
      totalUnreadWhatsapp: totalUnread,
    },
  }
}

// ---------------------------------------------------------------------------
// DASH-REBUILD — Business dashboard block fetchers. Each is independently
// callable so the page can stream blocks and mobile can adopt them later.
// Sums paginate (1k-row select cap); counts use head:true single aggregates.

// Tradeoff: a concurrent insert mid-pagination (e.g. an INVOICE_UPDATED
// webhook landing between pages) can be missed by this scan — acceptable for
// a presentational metric that self-heals on the next load; the mig 324 daily
// reconcile stays ground truth. Exported for tests.
export async function paginatedSumCents(supabase, filters) {
  // filters: fn(query) → query. Sums amount_cents over all matching rows.
  let from = 0
  const page = 1000
  let total = 0
  let count = 0
  for (;;) {
    let q = supabase.from('glofox_invoices').select('amount_cents').order('id', { ascending: true }).range(from, from + page - 1)
    q = filters(q)
    const { data, error } = await q
    if (error) return { error }
    for (const r of data || []) total += r.amount_cents || 0
    count += (data || []).length
    if (!data || data.length < page) break
    from += page
  }
  return { totalCents: total, rows: count }
}

// Revenue MTD from PAID invoices only (glofox_invoices is stale for
// anything else — mig 324's daily reconcile keeps statuses honest).
// Delta compares against the same day-window of last month.
export async function fetchRevenueMTD(supabase, locationId, now = new Date()) {
  const monthStart = startOfMonth(now)
  const lastMonthStart = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const lastMonthSameDay = new Date(lastMonthStart)
  lastMonthSameDay.setDate(lastMonthSameDay.getDate() + (now.getDate() - 1))
  lastMonthSameDay.setHours(23, 59, 59, 999)

  const cur = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', monthStart.toISOString()))
  if (cur.error) return { success: false, error: cur.error.message }

  const prev = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', lastMonthStart.toISOString())
    .lte('invoice_date', lastMonthSameDay.toISOString()))
  if (prev.error) return { success: false, error: prev.error.message }

  return {
    success: true,
    data: {
      totalCents: cur.totalCents,
      paidCount: cur.rows,
      deltaPct: pctDelta(cur.totalCents, prev.totalCents),
    },
  }
}

// Arrears = PAST_DUE rows as of the last daily reconcile (mig 324) —
// never derived from raw invoice math.
export async function fetchArrearsSummary(supabase, locationId) {
  let from = 0
  const page = 1000
  let totalCents = 0
  const contacts = new Set()
  for (;;) {
    const { data, error } = await supabase.from('glofox_invoices')
      .select('amount_cents, contact_id')
      .eq('location_id', locationId).eq('status', 'PAST_DUE')
      .order('id', { ascending: true }).range(from, from + page - 1)
    if (error) return { success: false, error: error.message }
    for (const r of data || []) {
      totalCents += r.amount_cents || 0
      if (r.contact_id) contacts.add(r.contact_id)
    }
    if (!data || data.length < page) break
    from += page
  }
  return { success: true, data: { totalCents, memberCount: contacts.size } }
}

// Current funnel stage counts + this-month entered/converted.
// entered uses joined_at (lead_created_at is import-poisoned);
// conversions use converted_at (mig 350).
export async function fetchFunnelCounts(supabase, locationId, now = new Date()) {
  const monthStartIso = startOfMonth(now).toISOString()

  // All 7 head-counts are independent — run them in one Promise.all.
  const results = await Promise.all([
    ...FUNNEL_SLUGS.map(slug => supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).eq('pipeline_stage_slug', slug)),
    supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).gte('joined_at', monthStartIso),
    supabase.from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).gte('converted_at', monthStartIso),
  ])

  const stageCounts = {}
  for (let i = 0; i < FUNNEL_SLUGS.length; i++) {
    const { count, error } = results[i]
    if (error) return { success: false, error: error.message }
    stageCounts[FUNNEL_SLUGS[i]] = count || 0
  }
  const { count: entered, error: e1 } = results[FUNNEL_SLUGS.length]
  if (e1) return { success: false, error: e1.message }
  const { count: converted, error: e2 } = results[FUNNEL_SLUGS.length + 1]
  if (e2) return { success: false, error: e2.message }
  return { success: true, data: shapeFunnel(stageCounts, { entered: entered || 0, converted: converted || 0 }) }
}

// Last-7-days ad performance. level='campaign' filtered IN THE QUERY —
// ad_insights_daily also stores adset+ad rows for the same days, and
// fetching all levels then filtering client-side can blow the 1000-row cap
// and silently truncate spend. sumCampaignRows keeps the level guard as
// defence-in-depth; .order() makes any residual cap deterministic.
export async function fetchAdsSummary(supabase, locationId, now = new Date()) {
  const since = new Date(now); since.setDate(since.getDate() - 7)
  const sinceIso = isoDate(since)
  const { data, error } = await supabase.from('ad_insights_daily')
    .select('level, spend, results')
    .eq('location_id', locationId)
    .eq('level', 'campaign')
    .gte('date', sinceIso)
    .order('date', { ascending: true })
    .limit(1000)
  if (error) return { success: false, error: error.message }
  const { spend, results } = sumCampaignRows(data || [])
  const { count: attributed, error: e2 } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .not('ad_provider', 'is', null)
    .gte('attributed_at', since.toISOString())
  if (e2) return { success: false, error: e2.message }
  return {
    success: true,
    data: {
      spend, results,
      costPerResult: results > 0 ? spend / results : null,
      attributedContacts: attributed || 0,
    },
  }
}

// Today's operations strip. Labour reuses the existing week window.
export async function fetchTodayOps(supabase, locationId, now = new Date()) {
  const todayIso = isoDate(now)

  // class_occurrences (mig 284) has no date column — it stores starts_at
  // (timestamptz). Count today's classes via a Dublin wall-clock day window
  // and exclude cancelled occurrences (cancelled_at, mig 344 — live reads
  // always filter .is('cancelled_at', null)).
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999)
  const weekStart = startOfWeek(now)
  const weekEnd = endOfWeek(now)

  // All four queries are independent — run them in one Promise.all.
  const [
    { count: bookedToday, error: e1 },
    { count: classesToday, error: e2 },
    { data: blocks, error: e3 },
    { data: weekShifts, error: e4 },
  ] = await Promise.all([
    supabase.from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).eq('booking_date', todayIso)
      .neq('status', 'cancelled'),
    supabase.from('class_occurrences')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gte('starts_at', dayStart.toISOString())
      .lte('starts_at', dayEnd.toISOString())
      .is('cancelled_at', null),
    supabase.from('shift_blocks')
      .select('id, shift_assignments(profile_id)')
      .eq('location_id', locationId).eq('block_date', todayIso)
      .limit(200),
    fetchDashboardShifts(supabase, {
      locationId, startDate: isoDate(weekStart), endDate: isoDate(weekEnd), withProfiles: true,
    }),
  ])
  if (e1) return { success: false, error: e1.message }
  if (e2) return { success: false, error: e2.message }
  if (e3) return { success: false, error: e3.message }
  if (e4) return { success: false, error: e4.message }

  const staffToday = new Set()
  for (const b of blocks || []) for (const a of b.shift_assignments || []) if (a.profile_id) staffToday.add(a.profile_id)
  let labourCents = 0
  let hours = 0
  for (const s of weekShifts || []) {
    const h = shiftDurationHours(s)
    hours += h
    labourCents += Math.round(h * (hourlyRateFor(s.profiles) || 0) * 100)
  }

  return {
    success: true,
    data: {
      bookedToday: bookedToday || 0,
      classesToday: classesToday || 0,
      staffToday: staffToday.size,
      labourWeekCents: labourCents,
      hoursWeek: Math.round(hours),
    },
  }
}
