// Dashboard data fetchers.
//
// Each `fetch*Dashboard()` returns `{ success, data, error }` where
// `data` is a flat object the matching dashboard component can render
// without further reshaping.
//
// All reads go direct to Supabase via the user's session JWT — RLS
// scopes everything to the active location automatically. No new API
// routes needed (matches the pattern used by Pipeline + WhatsApp tabs).
//
// Performance: dashboards aggregate a small number of rows (a week of
// shifts, a few open deals, a handful of pending requests). No need for
// SQL views or RPCs at this volume — direct PostgREST is fine.

import { supabase } from './supabase'

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function isoDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfWeek(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const dow = x.getDay() // 0 = Sunday
  const diff = dow === 0 ? -6 : 1 - dow
  x.setDate(x.getDate() + diff)
  return x
}

function endOfWeek(d = new Date()) {
  const x = startOfWeek(d)
  x.setDate(x.getDate() + 6)
  x.setHours(23, 59, 59, 999)
  return x
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function shiftDurationHours(shift) {
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

function hourlyRateFor(profile) {
  // Match src/lib/payroll.js logic at a basic level — annual salary
  // divided by 52 weeks divided by contracted hours, OR explicit
  // hourly_rate for contractors. Returns 0 if neither set (don't
  // double-count, don't error).
  if (profile?.hourly_rate && Number(profile.hourly_rate) > 0) {
    return Number(profile.hourly_rate)
  }
  const salary = Number(profile?.annual_salary || 0)
  const hours = Number(profile?.contracted_hours_per_week || 0)
  if (salary > 0 && hours > 0) return salary / 52 / hours
  return 0
}

// ----------------------------------------------------------------
// Personal — your shifts, your swaps, your inbox.
// Visible to everyone with permissions.mobile.dashboard_personal.
// ----------------------------------------------------------------

export async function fetchPersonalDashboard(profileId, locationId) {
  if (!profileId) return { success: false, error: 'No profile' }

  const todayIso = isoDate(new Date())
  const weekStartIso = isoDate(startOfWeek())
  const weekEndIso = isoDate(endOfWeek())

  const [shifts, swapsTargetingMe, myPendingTimeOff, myConvos] =
    await Promise.all([
      // All my shifts this week (for hour total + next-shift display)
      supabase
        .from('shifts')
        .select('id, shift_date, start_time_override, end_time_override, status, published, shift_templates(name, start_time, end_time)')
        .eq('profile_id', profileId)
        .gte('shift_date', weekStartIso)
        .lte('shift_date', weekEndIso)
        .order('shift_date', { ascending: true }),

      // Swap requests where someone is asking ME to take their shift
      supabase
        .from('shift_swap_requests')
        .select('id, requester_id, requester_shift_id, reason, created_at, requester:profiles!requester_id(full_name), requester_shift:shifts!requester_shift_id(shift_date, shift_templates(name))')
        .eq('target_id', profileId)
        .eq('status', 'pending'),

      // My pending time-off requests
      supabase
        .from('time_off_requests')
        .select('id, type, start_date, end_date, status, created_at')
        .eq('profile_id', profileId)
        .eq('status', 'pending')
        .order('start_date', { ascending: true }),

      // WhatsApp conversations assigned to me with unread messages
      locationId
        ? supabase
            .from('whatsapp_conversations')
            .select('id, unread_count, last_message_preview, contacts:contact_id(name, first_name)')
            .eq('assigned_to', profileId)
            .gt('unread_count', 0)
        : Promise.resolve({ data: [] }),
    ])

  if (shifts.error) return { success: false, error: shifts.error.message }

  const allShifts = shifts.data || []
  const upcomingShifts = allShifts.filter(s => s.shift_date >= todayIso)
  const nextShift = upcomingShifts[0] || null

  const totalHours = allShifts.reduce((sum, s) => sum + shiftDurationHours(s), 0)
  const unreadInbox = (myConvos.data || []).reduce((sum, c) => sum + (c.unread_count || 0), 0)

  return {
    success: true,
    data: {
      nextShift,
      shiftsThisWeek: allShifts.length,
      hoursThisWeek: Math.round(totalHours * 10) / 10,
      pendingSwapsForMe: swapsTargetingMe.data || [],
      myPendingTimeOff: myPendingTimeOff.data || [],
      unreadInbox,
      assignedConversations: myConvos.data || [],
    },
  }
}

// ----------------------------------------------------------------
// Studio — operational view for managers & head coaches.
// Leads / members / approvals queue. Deliberately omits finance.
// ----------------------------------------------------------------

export async function fetchStudioDashboard(locationId) {
  if (!locationId) return { success: false, error: 'No location' }

  const weekStartIso = startOfWeek().toISOString()

  const [
    pendingTimeOff,
    pendingSwaps,
    newLeadsThisWeek,
    contactsByStatus,
    unreadConvos,
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

  // Roll contacts up by lead_status so we have a funnel view.
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
      funnel,           // { active_trial: 12, member: 80, ... }
      totalContacts,
      totalUnreadWhatsapp: totalUnread,
    },
  }
}

// ----------------------------------------------------------------
// Business — owner-level numbers. Pipeline + realised value +
// scheduled labour. Sourced entirely from existing CRM data; no
// Glofox / Stripe ingestion required.
// ----------------------------------------------------------------

export async function fetchBusinessDashboard(locationId) {
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

    // Pull every shift this week + the assigned profile's pay
    // fields. We compute a labour estimate client-side; the math
    // here doesn't include overtime premium (that's tracked by the
    // web payroll lib for its weekly report).
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
      winRatePercent: winRate,                       // null if no decided deals
      scheduledHoursThisWeek: Math.round(scheduledHours * 10) / 10,
      scheduledLabourThisWeek: Math.round(scheduledLabour),
    },
  }
}
