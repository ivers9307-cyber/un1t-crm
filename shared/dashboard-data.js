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

import { upcomingWeeksBounds, summariseShifts, effectiveShiftStart, effectiveShiftEnd } from './roster-month.js'
import { pctDelta, sumCampaignRows, shapeFunnel, FUNNEL_SLUGS } from './dashboard-metrics.js'

// ROSTER-FIX.1 — "this assignment still puts a coach on the block".
// Inlined rather than imported: `shared/` is the mobile seam and cannot
// import from `src/lib`. Keep in step with isLiveAssignment (src/lib/roster.js)
// — only `cancelled` is dead; a missing status is a legacy live row.
// Every assignment reader in this module goes through it so a dropped shift
// cannot be counted by one fetcher and ignored by the next.
const isLiveRow = (a) => a?.status !== 'cancelled'

// ============================================================
// Date helpers — the RUNNING device's local calendar.
// A4 REVENUEMTD.1: on a staff phone in Ireland, local IS Dublin, which is what
// the phone-run fetchers want (fetchPersonalDashboardData's fallback). On the
// server local is UTC (Vercel), so a server-run fetcher must never use these:
// it loads the Dublin calendar with loadDublinTime() instead (pinned in
// dashboard-data.test.js), or takes its window from the caller
// (fetchStudioContactCounts, whose route computes the Dublin Monday).
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

export function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

// A4 REVENUEMTD.1 — the Europe/Dublin calendar, for the fetchers that run on
// the SERVER: fetchTodayOps, fetchRevenueMTD, fetchFunnelCounts and
// fetchAdsSummary (the Business dashboard, on web and, via
// /api/dashboard/business, on the phone). Loaded on first use, never at module
// scope: the staff app imports this module, and a Hermes build without full
// ICU throws on the timeZone formatters dublin-time.js builds at import
// (mobile/lib/dates.js, ROSTER-FIX.7f). The phone never calls those four, so it
// never loads it.
function loadDublinTime() {
  return import('./dublin-time.js')
}

// ============================================================
// Shift-cost helpers (used by Business dashboard's labour estimate)
// ============================================================

export function shiftDurationHours(shift) {
  // Override, then the block's own time, then the template default
  // (MOBILESCHED.2 — the block's time was skipped).
  const start = effectiveShiftStart(shift)
  const end = effectiveShiftEnd(shift)
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
// id (the Today swap flow posts it as requester_shift_id); `block_id` is its
// block (CANDIDATES.1's colleague ranking).
async function fetchDashboardShifts(supabase, { profileId, locationId, startDate, endDate, withProfiles = false, publishedOnly = false }) {
  const profileSelect = withProfiles
    ? ', profiles:profile_id ( annual_salary, hourly_rate, contracted_hours_per_week, employment_type )'
    : ''
  let q = supabase
    .from('shift_assignments')
    .select(`
      id, profile_id, start_time_override, end_time_override, status,
      shift_blocks!inner ( id, block_date, start_time, end_time, briefing, location_id, roster_id, rosters:roster_id ( status ), shift_templates ( name, start_time, end_time ), locations:location_id ( id, name ) )${profileSelect}
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
      // CANDIDATES.1 — the swap picker ranks colleagues for this BLOCK.
      block_id: block.id ?? null,
      shift_date: block.block_date,
      start_time_override: r.start_time_override,
      end_time_override: r.end_time_override,
      // MOBILESCHED.2 — the BLOCK's own times ride along under the same keys
      // src/lib/roster-read.js toApiShiftRow uses, so a block edited away from
      // its template displays, sorts and totals at its real hours.
      block_start_time: block.start_time ?? null,
      block_end_time: block.end_time ?? null,
      // BLOCKEDIT.1 (mig 629) — the shift's coach-visible briefing.
      briefing: block.briefing ?? null,
      status: r.status,
      published: block.rosters?.status === 'published',
      location_id: block.location_id,
      shift_templates: block.shift_templates,
      locations: block.locations,
      profiles: r.profiles,
    }
  })
  // ROSTER-FIX.1 (D1) — callers that serve a coach ask for published rows only.
  return { data: publishedOnly ? rows.filter((r) => r.published) : rows, error: null }
}

// ============================================================
// Personal — your shifts, your swaps, your inbox.
// ============================================================

export async function fetchPersonalDashboardData(supabase, profileId, locationId, opts) {
  if (!profileId) return { success: false, error: 'No profile' }

  // A4 REVENUEMTD.1 — whose "today"? This runs in two places. The web Today
  // page runs it on the SERVER (UTC on Vercel) and passes its Dublin today
  // (dublinTodayStr); without that, from 00:00 to 01:00 Dublin on a summer
  // Monday "This week" was last week. The phone passes nothing and keeps its
  // device day: Dublin for staff in Ireland, and no Intl, which a Hermes build
  // without full ICU cannot construct (mobile/lib/dates.js, ROSTER-FIX.7f).
  // A real calendar date only: '2027-13-45' or '2027-02-30' would otherwise
  // reach upcomingWeeksBounds and come back as NaN. Date.parse + toISOString
  // is plain UTC maths, no Intl, so it is Hermes-safe.
  const callerTodayIso = opts?.todayIso
  const isRealDay = typeof callerTodayIso === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(callerTodayIso)
    && !Number.isNaN(Date.parse(`${callerTodayIso}T00:00:00Z`))
    && new Date(`${callerTodayIso}T00:00:00Z`).toISOString().slice(0, 10) === callerTodayIso
  const todayIso = isRealDay ? callerTodayIso : isoDate(new Date())

  // 14-day window — this Monday → next Sunday — fetched as a single
  // query and split client-side. Cheaper than two queries. Pure date-string
  // maths from here (upcomingWeeksBounds), so no clock or zone is read again.
  const { monthStartIso: thisWeekStartIso, monthEndIso: thisWeekEndIso } = upcomingWeeksBounds(todayIso, 1)
  const { monthEndIso: nextWeekEndIso } = upcomingWeeksBounds(todayIso, 2)
  const { monthStartIso: nextWeekStartIso } = upcomingWeeksBounds(nextWeekEndIso, 1)

  // Rolling 7-week roster window (this week + the next 6), anchored on the same
  // "today" as the week dates. Kept under the monthStartIso/monthEndIso/monthShifts
  // keys so the downstream pipeline + buildMonthMatrix consume it unchanged — the
  // "Upcoming" toggle shows this window instead of a calendar month.
  const { monthStartIso, monthEndIso } = upcomingWeeksBounds(todayIso, 7)

  const [shifts, monthShiftsResult, myPendingTimeOff, myConvos, myPostedSwapsResult] =
    await Promise.all([
      // Cross-location query — filtered by profile_id only. Multi-
      // location staff see every shift they're assigned to, anywhere.
      // The locations() join lets the UI render a small chip on each
      // row so users can tell which gym a shift belongs to.
      // RETIRE-SHIFTS-MIRROR.2 — reads shift_assignments+shift_blocks now;
      // shape (incl. derived `published`) is unchanged. Re-sorted below.
      // D1 (ROSTER-FIX.1) — coaches see published shifts only. Personal =
      // published for everyone; a manager's own drafts live on the calendar.
      fetchDashboardShifts(supabase, { profileId, startDate: thisWeekStartIso, endDate: nextWeekEndIso, publishedOnly: true }),

      // Month shifts for the calendar/agenda view (personal data is small —
      // a second range call is fine; avoids coupling the 14-day window logic).
      // D1 (ROSTER-FIX.1) — coaches see published shifts only. Personal =
      // published for everyone; a manager's own drafts live on the calendar.
      fetchDashboardShifts(supabase, { profileId, startDate: monthStartIso, endDate: monthEndIso, publishedOnly: true }),

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
        .select('id, status, reason, created_at, target_id, requester_shift_id, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date, start_time, end_time, shift_templates(name)))')
        .eq('requester_id', profileId)
        .in('status', ['pending', 'awaiting_approval']),
    ])

  if (shifts.error) return { success: false, error: shifts.error.message }

  const monthShifts = (monthShiftsResult.data || []).slice().sort((a, b) => {
    if (a.shift_date !== b.shift_date) return a.shift_date.localeCompare(b.shift_date)
    const aStart = effectiveShiftStart(a) || ''
    const bStart = effectiveShiftStart(b) || ''
    return aStart.localeCompare(bStart)
  })
  const monthSummary = summariseShifts(monthShifts)

  // Sort by date then start time so "first shift of the day" is index [0].
  const sortedShifts = (shifts.data || []).slice().sort((a, b) => {
    if (a.shift_date !== b.shift_date) return a.shift_date.localeCompare(b.shift_date)
    const aStart = effectiveShiftStart(a) || ''
    const bStart = effectiveShiftStart(b) || ''
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
      myPostedSwaps: myPostedSwapsResult.data || [],
      myPendingTimeOff: myPendingTimeOff.data || [],
      unreadInbox,
      assignedConversations: myConvos.data || [],
    },
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

  // STUDIODASH.1 — the pending time-off + swap lists are NOT read here.
  // They need the requester's name, and this runs on mobile's authenticated
  // client, which has no grant on public.profiles (mig 153b) — the embed
  // 500'd the whole select and `|| []` rendered it as "nothing pending".
  // mobile/lib/dashboard-api.js reads them from the service-role
  // /api/schedule/time-off + /api/schedule/swaps routes instead.
  //
  // CONTACTREADSCOPE.1a — nor are the contact numbers (new leads this week,
  // the funnel, the total). From mig 690 this session reads a studio's
  // contacts only while holding Contacts there, and this screen is gated by
  // dashboard_studio, so they would read as zeros. The phone gets them from
  // /api/dashboard/studio-contacts (fetchStudioContactCounts below, service
  // role).
  const unreadConvos = await supabase
    .from('whatsapp_conversations')
    .select('unread_count')
    .eq('location_id', locationId)
    .gt('unread_count', 0)

  const totalUnread = (unreadConvos.data || []).reduce((s, c) => s + (c.unread_count || 0), 0)

  return {
    success: true,
    data: {
      totalUnreadWhatsapp: totalUnread,
    },
  }
}

// CONTACTREADSCOPE.1a — the Studio dashboard's contact numbers, for ONE
// studio, read by the SERVER with the service-role client
// (/api/dashboard/studio-contacts). Never call it with the phone's session:
// from mig 690 that session reads contacts only while holding Contacts.
// The caller passes the week start (the route computes the Europe/Dublin
// Monday), so this stays free of any calendar.
//
// joined_at, NOT lead_created_at: the latter defaults to NOW() at insert
// (mig 001), so every bulk-imported contact carries its import day and any
// import spikes the count into the thousands. joined_at is the Glofox-side
// signup date, the same signal fetchFunnelCounts uses for "entered".
//
// AUDIT P1-2 — the funnel reads pipeline_stage_slug for EVERY contact at the
// studio (8,000+), so it pages past the PostgREST 1000-row cap with an
// explicit order. This file is the shared web↔mobile seam and cannot import
// src/lib/select-all, hence the inline loop.
//
// A failed read is { success: false }, never a zero and never a partial
// funnel (the old phone-side loop stopped at a failed page and showed what it
// had as if complete).
export async function fetchStudioContactCounts(supabase, locationId, { weekStartIso } = {}) {
  if (!locationId) return { success: false, error: 'No location' }
  if (!weekStartIso) return { success: false, error: 'No week start' }

  const { count: newLeadsThisWeek, error: countError } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .gte('joined_at', weekStartIso)
  if (countError) return { success: false, error: countError.message }

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
    if (error) return { success: false, error: error.message }
    if (!Array.isArray(page) || page.length === 0) break
    for (const c of page) {
      const k = c.pipeline_stage_slug || 'unknown'
      funnel[k] = (funnel[k] || 0) + 1
    }
    totalContacts += page.length
    if (page.length < PAGE) break
  }

  return { success: true, data: { newLeadsThisWeek: newLeadsThisWeek || 0, funnel, totalContacts } }
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
// A4 REVENUEMTD.1 — both windows are Europe/Dublin calendar days, as half-open
// UTC ranges over invoice_date (timestamptz, mig 140):
//   this month  [1st 00:00 Dublin, …)
//   last month  [its 1st 00:00 Dublin, 00:00 Dublin the day after the same
//               day-of-month), the same day clamped to last month's length.
// They were the server's local midnights (UTC on Vercel): from 00:00 to 01:00
// Dublin on the 1st in summer "MTD" was the whole previous month, and a
// payment in that hour never counted in its own month. And with no clamp, on
// the 31st after a 30-day month "last month" ran on into this one.
export async function fetchRevenueMTD(supabase, locationId, now = new Date()) {
  const { dublinDateKey, dublinMonthStartMs, dublinDayRangeMs } = await loadDublinTime()
  const nowMs = now.getTime()
  const [y, m, d] = dublinDateKey(nowMs).split('-').map(Number)
  const monthStartIso = new Date(dublinMonthStartMs(nowMs)).toISOString()
  const prevY = m === 1 ? y - 1 : y
  const prevM = m === 1 ? 12 : m - 1
  // Day 0 of this month is the last day of the previous one.
  const daysInPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate()
  const pad = (n) => String(n).padStart(2, '0')
  const prevRange = dublinDayRangeMs(
    `${prevY}-${pad(prevM)}-01`,
    `${prevY}-${pad(prevM)}-${pad(Math.min(d, daysInPrev))}`,
  )
  const prevStartIso = new Date(prevRange.startMs).toISOString()
  const prevEndIso = new Date(prevRange.endMs).toISOString()

  const cur = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', monthStartIso))
  if (cur.error) return { success: false, error: cur.error.message }

  const prev = await paginatedSumCents(supabase, q => q
    .eq('location_id', locationId).eq('status', 'PAID')
    .gte('invoice_date', prevStartIso)
    .lt('invoice_date', prevEndIso))
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
  // A4 REVENUEMTD.1 — the same Dublin month as Revenue MTD (was the server's
  // local month: UTC on Vercel).
  const { dublinMonthStartMs } = await loadDublinTime()
  const monthStartIso = new Date(dublinMonthStartMs(now.getTime())).toISOString()

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
// fetching all levels then filtering client-side multiplies the row count.
// sumCampaignRows keeps the level guard as defence-in-depth; the .range()
// loop pages past the 1k-row select cap so a many-campaign week can never
// silently truncate spend (order by id for stable pages, like
// paginatedSumCents above).
export async function fetchAdsSummary(supabase, locationId, now = new Date()) {
  // A4 REVENUEMTD.1 — ad_insights_daily.date is a Dublin day, as src/lib/ads/read.js
  // reads it (that file steps back 168 h and formats a Dublin date, which differs
  // from calendar minus 7 only in the first Dublin hour after spring-forward);
  // the server's local day is UTC's. Leads are a rolling
  // 7 x 24 h over attributed_at (timestamptz), with no local time involved.
  const { dublinDateKey, dublinAddDays, DUBLIN_DAY_MS } = await loadDublinTime()
  const nowMs = now.getTime()
  const sinceIso = dublinAddDays(dublinDateKey(nowMs), -7)
  const attributedSinceIso = new Date(nowMs - 7 * DUBLIN_DAY_MS).toISOString()
  let from = 0
  const page = 1000
  const rows = []
  for (;;) {
    const { data, error } = await supabase.from('ad_insights_daily')
      .select('level, spend, results')
      .eq('location_id', locationId)
      .eq('level', 'campaign')
      .gte('date', sinceIso)
      .order('id', { ascending: true })
      .range(from, from + page - 1)
    if (error) return { success: false, error: error.message }
    rows.push(...(data || []))
    if (!data || data.length < page) break
    from += page
  }
  const { spend, results } = sumCampaignRows(rows)
  const { count: attributed, error: e2 } = await supabase.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .not('ad_provider', 'is', null)
    .gte('attributed_at', attributedSinceIso)
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
  // DUBLINDAY.1 — "today" and "this week" are Europe/Dublin calendar days.
  // They were the SERVER's local days (isoDate/startOfWeek read local time),
  // and both callers run on Vercel in UTC: from 00:00 to 01:00 Dublin in
  // summer the strip showed YESTERDAY's bookings, classes and staff, and on a
  // Monday in that hour it costed LAST week's labour.
  // Loaded lazily through loadDublinTime (see there): this function only ever
  // runs on the server, so the phone never loads it.
  const { dublinDateKey, dublinDayRangeMs, dublinWeekStartMs, dublinAddDays } = await loadDublinTime()
  const nowMs = now.getTime()
  const todayIso = dublinDateKey(nowMs)
  // class_occurrences (mig 284) has no date column — it stores starts_at
  // (timestamptz). Count today's classes over the Dublin day as a half-open
  // UTC window [00:00 Dublin, next 00:00 Dublin), and exclude cancelled
  // occurrences (cancelled_at, mig 344 — live reads always filter
  // .is('cancelled_at', null)).
  const { startMs: dayStartMs, endMs: dayEndMs } = dublinDayRangeMs(todayIso, todayIso)
  const weekStartIso = dublinDateKey(dublinWeekStartMs(nowMs))
  const weekEndIso = dublinAddDays(weekStartIso, 6)

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
      .gte('starts_at', new Date(dayStartMs).toISOString())
      .lt('starts_at', new Date(dayEndMs).toISOString())
      .is('cancelled_at', null),
    // ROSTER-FIX.1 — `status` rides along so staffToday can drop cancelled
    // rows. Without it an approved swap-drop still counted its coach as
    // working today, so the Today strip reported a body that isn't in.
    // STAFFTODAY.1 — the block's roster status rides along too: a shift on a
    // draft roster (or on no roster) is not published, so nobody has been
    // told to come in. Same rule as labour this week (LABOURWEEK.1).
    supabase.from('shift_blocks')
      .select('id, roster_id, rosters:roster_id ( status ), shift_assignments(profile_id, status)')
      .eq('location_id', locationId).eq('block_date', todayIso)
      .limit(200),
    // LABOURWEEK.1 — published rosters only: a draft week is not labour yet
    // (the same rule LABOUR.1 costs by). Cancelled rows are dropped below.
    fetchDashboardShifts(supabase, {
      locationId, startDate: weekStartIso, endDate: weekEndIso, withProfiles: true, publishedOnly: true,
    }),
  ])
  if (e1) return { success: false, error: e1.message }
  if (e2) return { success: false, error: e2.message }
  if (e3) return { success: false, error: e3.message }
  if (e4) return { success: false, error: e4.message }

  const staffToday = new Set()
  for (const b of (blocks || []).filter((blk) => blk.rosters?.status === 'published')) {
    for (const a of (b.shift_assignments || []).filter(isLiveRow)) if (a.profile_id) staffToday.add(a.profile_id)
  }
  let labourCents = 0
  let hours = 0
  // LABOURWEEK.1 — a cancelled assignment (an approved swap-drop, a removed
  // coach) is not labour: it was costed and counted in the hours until now.
  for (const s of (weekShifts || []).filter(isLiveRow)) {
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
