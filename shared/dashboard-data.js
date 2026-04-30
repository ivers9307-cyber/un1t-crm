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

// ============================================================
// Personal — your shifts, your swaps, your inbox.
// ============================================================

export async function fetchPersonalDashboardData(supabase, profileId, locationId) {
  if (!profileId) return { success: false, error: 'No profile' }

  // 14-day window — this Monday → next Sunday — fetched as a single
  // query and split client-side. Cheaper than two queries.
  const thisWeekStart = startOfWeek()
  const thisWeekEnd = endOfWeek()
  const nextWeekStart = new Date(thisWeekEnd); nextWeekStart.setDate(nextWeekStart.getDate() + 1)
  const nextWeekEnd = new Date(nextWeekStart); nextWeekEnd.setDate(nextWeekEnd.getDate() + 6); nextWeekEnd.setHours(23, 59, 59, 999)

  const thisWeekStartIso = isoDate(thisWeekStart)
  const thisWeekEndIso = isoDate(thisWeekEnd)
  const nextWeekStartIso = isoDate(nextWeekStart)
  const nextWeekEndIso = isoDate(nextWeekEnd)

  const [shifts, swapsTargetingMe, myPendingTimeOff, myConvos] =
    await Promise.all([
      supabase
        .from('shifts')
        .select('id, shift_date, start_time_override, end_time_override, status, published, shift_templates(name, start_time, end_time)')
        .eq('profile_id', profileId)
        .gte('shift_date', thisWeekStartIso)
        .lte('shift_date', nextWeekEndIso)
        .order('shift_date', { ascending: true }),

      supabase
        .from('shift_swap_requests')
        .select('id, requester_id, requester_shift_id, reason, created_at, requester:profiles!requester_id(full_name), requester_shift:shifts!requester_shift_id(shift_date, shift_templates(name))')
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
    ])

  if (shifts.error) return { success: false, error: shifts.error.message }

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
      // Other
      pendingSwapsForMe: swapsTargetingMe.data || [],
      myPendingTimeOff: myPendingTimeOff.data || [],
      unreadInbox,
      assignedConversations: myConvos.data || [],
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
    newLeadsThisWeek, contactsByStatus, unreadConvos,
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

    supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .gte('lead_created_at', weekStartIso),

    supabase
      .from('contacts')
      .select('lead_status')
      .eq('location_id', locationId),

    supabase
      .from('whatsapp_conversations')
      .select('unread_count')
      .eq('location_id', locationId)
      .gt('unread_count', 0),
  ])

  const funnel = {}
  for (const c of contactsByStatus.data || []) {
    const k = c.lead_status || 'unknown'
    funnel[k] = (funnel[k] || 0) + 1
  }
  const totalContacts = (contactsByStatus.data || []).length
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

// ============================================================
// Business — owner-level numbers. Pipeline + realised value +
// scheduled labour. Sourced entirely from existing CRM data.
// ============================================================

export async function fetchBusinessDashboardData(supabase, locationId) {
  if (!locationId) return { success: false, error: 'No location' }

  const monthStart = startOfMonth().toISOString()
  const weekStartIso = isoDate(startOfWeek())
  const weekEndIso = isoDate(endOfWeek())

  const [openDeals, monthDeals, weekShifts] = await Promise.all([
    supabase
      .from('deals')
      .select('value')
      .eq('location_id', locationId)
      .eq('status', 'open'),

    supabase
      .from('deals')
      .select('value, status, updated_at')
      .eq('location_id', locationId)
      .in('status', ['won', 'lost'])
      .gte('updated_at', monthStart),

    supabase
      .from('shifts')
      .select(`
        id, shift_date, start_time_override, end_time_override,
        shift_templates(start_time, end_time),
        profiles!profile_id(annual_salary, hourly_rate, contracted_hours_per_week, employment_type)
      `)
      .eq('location_id', locationId)
      .gte('shift_date', weekStartIso)
      .lte('shift_date', weekEndIso),
  ])

  if (openDeals.error) return { success: false, error: openDeals.error.message }

  const openPipelineValue = (openDeals.data || []).reduce(
    (s, d) => s + Number(d.value || 0), 0
  )
  const wonThisMonth = (monthDeals.data || []).filter(d => d.status === 'won')
  const lostThisMonth = (monthDeals.data || []).filter(d => d.status === 'lost')
  const wonValue = wonThisMonth.reduce((s, d) => s + Number(d.value || 0), 0)

  const winCount = wonThisMonth.length
  const totalDecided = winCount + lostThisMonth.length
  const winRate = totalDecided > 0 ? Math.round((winCount / totalDecided) * 100) : null

  let scheduledHours = 0
  let scheduledLabour = 0
  for (const s of weekShifts.data || []) {
    const hours = shiftDurationHours(s)
    scheduledHours += hours
    scheduledLabour += hours * hourlyRateFor(s.profiles)
  }

  return {
    success: true,
    data: {
      openPipelineValue: Math.round(openPipelineValue),
      openDealCount: (openDeals.data || []).length,
      wonValueMTD: Math.round(wonValue),
      wonCountMTD: winCount,
      lostCountMTD: lostThisMonth.length,
      winRatePercent: winRate,
      scheduledHoursThisWeek: Math.round(scheduledHours * 10) / 10,
      scheduledLabourThisWeek: Math.round(scheduledLabour),
    },
  }
}
