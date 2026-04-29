// Shared report generation logic — used by both manual generate and cron scheduler
import { createServerClient } from '@/lib/supabase'

/**
 * Generate a report and save it to generated_reports.
 * @param {Object} opts
 * @param {string} opts.report_type — one of: staff_hours, staff_cost, time_off_summary, roster_coverage, utilisation
 * @param {string} opts.period_start — YYYY-MM-DD
 * @param {string} opts.period_end — YYYY-MM-DD
 * @param {string} opts.location_id — UUID
 * @param {string|null} opts.generated_by — profile UUID (null for cron)
 * @param {string|null} opts.scheduled_report_id — UUID if triggered by schedule
 * @returns {{ success: boolean, data?: Object, error?: string }}
 */
export async function generateReport({ report_type, period_start, period_end, location_id, generated_by = null, scheduled_report_id = null }) {
  const db = createServerClient()
  const locId = location_id

  if (!report_type || !period_start || !period_end || !locId) {
    return { success: false, error: 'report_type, period_start, period_end, and location_id are required' }
  }

  let reportData = {}
  let summary = {}
  let reportName = ''

  switch (report_type) {
    case 'staff_hours': {
      reportName = 'Staff Hours Worked'
      const { data: shifts } = await db.from('shifts')
        .select('shift_date, profile_id, profiles!profile_id(full_name, role, employment_type), shift_templates(name, start_time, end_time)')
        .eq('location_id', locId)
        .gte('shift_date', period_start)
        .lte('shift_date', period_end)
        .order('shift_date')

      const staffHours = {}
      let totalHours = 0

      for (const shift of (shifts || [])) {
        const name = shift.profiles?.full_name || 'Unknown'
        const profileId = shift.profile_id
        if (!staffHours[profileId]) {
          staffHours[profileId] = { name, role: shift.profiles?.role, employment_type: shift.profiles?.employment_type, days: {}, total: 0 }
        }

        const start = shift.shift_templates?.start_time
        const end = shift.shift_templates?.end_time
        if (start && end) {
          const [sh, sm] = start.split(':').map(Number)
          const [eh, em] = end.split(':').map(Number)
          let hours = (eh + em / 60) - (sh + sm / 60)
          if (hours < 0) hours += 24
          staffHours[profileId].days[shift.shift_date] = (staffHours[profileId].days[shift.shift_date] || 0) + hours
          staffHours[profileId].total += hours
          totalHours += hours
        }
      }

      reportData = { staff: Object.values(staffHours) }
      summary = { total_hours: Math.round(totalHours * 10) / 10, staff_count: Object.keys(staffHours).length }
      break
    }

    case 'staff_cost': {
      reportName = 'Staff Cost Breakdown'
      const { data: profiles } = await db.from('profiles')
        .select('id, full_name, role, employment_type, annual_salary, hourly_rate, contracted_hours_per_week')
        .eq('active', true)

      const { data: shifts } = await db.from('shifts')
        .select('shift_date, profile_id, shift_templates(start_time, end_time)')
        .eq('location_id', locId)
        .gte('shift_date', period_start)
        .lte('shift_date', period_end)

      const profileMap = {}
      for (const p of (profiles || [])) {
        let rate = 0
        if (p.employment_type === 'contractor') {
          rate = Number(p.hourly_rate) || 0
        } else if (p.annual_salary && p.contracted_hours_per_week) {
          rate = Number(p.annual_salary) / (Number(p.contracted_hours_per_week) * 52)
        }
        profileMap[p.id] = { ...p, effective_hourly_rate: Math.round(rate * 100) / 100 }
      }

      const staffCosts = {}
      let totalCost = 0
      let totalHrs = 0

      for (const shift of (shifts || [])) {
        const profile = profileMap[shift.profile_id]
        if (!profile) continue
        const pid = shift.profile_id

        if (!staffCosts[pid]) {
          staffCosts[pid] = {
            name: profile.full_name,
            role: profile.role,
            employment_type: profile.employment_type,
            hourly_rate: profile.effective_hourly_rate,
            days: {},
            total_hours: 0,
            total_cost: 0,
          }
        }

        const start = shift.shift_templates?.start_time
        const end = shift.shift_templates?.end_time
        if (start && end) {
          const [sh, sm] = start.split(':').map(Number)
          const [eh, em] = end.split(':').map(Number)
          let hours = (eh + em / 60) - (sh + sm / 60)
          if (hours < 0) hours += 24
          const cost = hours * profile.effective_hourly_rate

          if (!staffCosts[pid].days[shift.shift_date]) {
            staffCosts[pid].days[shift.shift_date] = { hours: 0, cost: 0 }
          }
          staffCosts[pid].days[shift.shift_date].hours += hours
          staffCosts[pid].days[shift.shift_date].cost += cost
          staffCosts[pid].total_hours += hours
          staffCosts[pid].total_cost += cost
          totalCost += cost
          totalHrs += hours
        }
      }

      Object.values(staffCosts).forEach(s => {
        s.total_cost = Math.round(s.total_cost * 100) / 100
        Object.values(s.days).forEach(d => { d.cost = Math.round(d.cost * 100) / 100 })
      })

      reportData = { staff: Object.values(staffCosts) }
      summary = { total_cost: Math.round(totalCost * 100) / 100, total_hours: Math.round(totalHrs * 10) / 10, staff_count: Object.keys(staffCosts).length, currency: 'EUR' }
      break
    }

    case 'time_off_summary': {
      reportName = 'Time Off Summary'
      const { data: requests } = await db.from('time_off_requests')
        .select('*, profiles!profile_id(full_name, role)')
        .eq('location_id', locId)
        .gte('start_date', period_start)
        .lte('end_date', period_end)
        .order('start_date')

      const byType = { holiday: 0, sick: 0, unavailable: 0 }
      const byStatus = { pending: 0, approved: 0, rejected: 0, cancelled: 0 }
      const byStaff = {}

      for (const req of (requests || [])) {
        byType[req.type] = (byType[req.type] || 0) + Number(req.total_days)
        byStatus[req.status] = (byStatus[req.status] || 0) + 1
        const name = req.profiles?.full_name || 'Unknown'
        if (!byStaff[name]) byStaff[name] = { holiday: 0, sick: 0, unavailable: 0, total: 0 }
        byStaff[name][req.type] = (byStaff[name][req.type] || 0) + Number(req.total_days)
        byStaff[name].total += Number(req.total_days)
      }

      reportData = { requests: requests || [], by_type: byType, by_status: byStatus, by_staff: byStaff }
      summary = { total_requests: (requests || []).length, total_days: Object.values(byType).reduce((a, b) => a + b, 0), ...byType }
      break
    }

    case 'roster_coverage': {
      reportName = 'Roster Coverage'
      const { data: shifts } = await db.from('shifts')
        .select('shift_date, profile_id, shift_templates(name)')
        .eq('location_id', locId)
        .gte('shift_date', period_start)
        .lte('shift_date', period_end)

      const { data: timeOff } = await db.from('time_off_requests')
        .select('start_date, end_date, profile_id, type, profiles!profile_id(full_name)')
        .eq('location_id', locId)
        .eq('status', 'approved')
        .lte('start_date', period_end)
        .gte('end_date', period_start)

      const days = {}
      const start = new Date(period_start + 'T00:00:00')
      const end = new Date(period_end + 'T00:00:00')
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const ds = d.toISOString().split('T')[0]
        days[ds] = { shifts: 0, staff_on_shift: [], staff_off: [] }
      }

      for (const s of (shifts || [])) {
        if (days[s.shift_date]) {
          days[s.shift_date].shifts++
          if (!days[s.shift_date].staff_on_shift.includes(s.profile_id)) {
            days[s.shift_date].staff_on_shift.push(s.profile_id)
          }
        }
      }

      for (const t of (timeOff || [])) {
        const ts = new Date(t.start_date + 'T00:00:00')
        const te = new Date(t.end_date + 'T00:00:00')
        for (let d = new Date(ts); d <= te; d.setDate(d.getDate() + 1)) {
          const ds = d.toISOString().split('T')[0]
          if (days[ds]) {
            days[ds].staff_off.push(t.profiles?.full_name || 'Unknown')
          }
        }
      }

      const coverage = Object.entries(days).map(([date, info]) => ({
        date,
        shifts_count: info.shifts,
        staff_working: info.staff_on_shift.length,
        staff_off: info.staff_off,
      }))

      reportData = { days: coverage }
      summary = { total_days: coverage.length, avg_shifts_per_day: Math.round(coverage.reduce((s, d) => s + d.shifts_count, 0) / coverage.length * 10) / 10 }
      break
    }

    case 'utilisation': {
      reportName = 'Staff Utilisation'
      const { data: profiles } = await db.from('profiles')
        .select('id, full_name, role, employment_type, contracted_hours_per_week')
        .eq('active', true)

      const { data: shifts } = await db.from('shifts')
        .select('shift_date, profile_id, shift_templates(start_time, end_time)')
        .eq('location_id', locId)
        .gte('shift_date', period_start)
        .lte('shift_date', period_end)

      const periodStartD = new Date(period_start + 'T00:00:00')
      const periodEndD = new Date(period_end + 'T00:00:00')
      const weeks = Math.max(1, Math.round((periodEndD - periodStartD) / (7 * 24 * 60 * 60 * 1000)))

      const staffUtil = {}
      for (const p of (profiles || [])) {
        const contracted = (Number(p.contracted_hours_per_week) || 40) * weeks
        staffUtil[p.id] = { name: p.full_name, role: p.role, contracted_hours: contracted, actual_hours: 0 }
      }

      for (const shift of (shifts || [])) {
        if (!staffUtil[shift.profile_id]) continue
        const start = shift.shift_templates?.start_time
        const end = shift.shift_templates?.end_time
        if (start && end) {
          const [sh, sm] = start.split(':').map(Number)
          const [eh, em] = end.split(':').map(Number)
          let hours = (eh + em / 60) - (sh + sm / 60)
          if (hours < 0) hours += 24
          staffUtil[shift.profile_id].actual_hours += hours
        }
      }

      const utilData = Object.values(staffUtil)
        .filter(s => s.contracted_hours > 0)
        .map(s => ({
          ...s,
          actual_hours: Math.round(s.actual_hours * 10) / 10,
          utilisation_pct: Math.round((s.actual_hours / s.contracted_hours) * 1000) / 10,
        }))
        .sort((a, b) => b.utilisation_pct - a.utilisation_pct)

      reportData = { staff: utilData }
      const avgUtil = utilData.length > 0 ? Math.round(utilData.reduce((s, u) => s + u.utilisation_pct, 0) / utilData.length * 10) / 10 : 0
      summary = { avg_utilisation: avgUtil, staff_count: utilData.length, weeks }
      break
    }

    default:
      return { success: false, error: `Unknown report type: ${report_type}` }
  }

  // Save the generated report
  const record = {
    location_id: locId,
    generated_by,
    scheduled_report_id,
    report_type,
    report_name: reportName,
    period_start,
    period_end,
    report_data: reportData,
    summary,
  }

  const { data: saved, error } = await db.from('generated_reports').insert(record).select().single()
  if (error) return { success: false, error: error.message }

  return { success: true, data: saved }
}

/**
 * Calculate the period dates for a scheduled report based on frequency.
 * Weekly = last 7 days, fortnightly = last 14 days, monthly = last calendar month.
 */
export function calculatePeriodForSchedule(frequency) {
  const now = new Date()
  let period_start, period_end

  // period_end is always yesterday
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  period_end = yesterday.toISOString().split('T')[0]

  if (frequency === 'weekly') {
    const start = new Date(yesterday)
    start.setDate(start.getDate() - 6) // 7-day window
    period_start = start.toISOString().split('T')[0]
  } else if (frequency === 'fortnightly') {
    const start = new Date(yesterday)
    start.setDate(start.getDate() - 13) // 14-day window
    period_start = start.toISOString().split('T')[0]
  } else if (frequency === 'monthly') {
    // Previous full calendar month
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    period_start = lastMonth.toISOString().split('T')[0]
    const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0)
    period_end = lastDayPrevMonth.toISOString().split('T')[0]
  } else {
    // Default: last 7 days
    const start = new Date(yesterday)
    start.setDate(start.getDate() - 6)
    period_start = start.toISOString().split('T')[0]
  }

  return { period_start, period_end }
}

/**
 * Calculate the next run date after execution.
 */
export function calculateNextRun(frequency, dayOfWeek, dayOfMonth) {
  const now = new Date()

  if (frequency === 'weekly' && dayOfWeek != null) {
    const target = new Date(now)
    const diff = (dayOfWeek - target.getDay() + 7) % 7 || 7
    target.setDate(target.getDate() + diff)
    target.setHours(7, 0, 0, 0)
    return target.toISOString()
  }

  if (frequency === 'fortnightly' && dayOfWeek != null) {
    const target = new Date(now)
    const diff = (dayOfWeek - target.getDay() + 7) % 7 || 7
    target.setDate(target.getDate() + diff + 7) // +7 extra for fortnightly
    target.setHours(7, 0, 0, 0)
    return target.toISOString()
  }

  if (frequency === 'monthly' && dayOfMonth) {
    const target = new Date(now.getFullYear(), now.getMonth() + 1, dayOfMonth, 7, 0, 0)
    return target.toISOString()
  }

  return null // 'once' — no next run
}
