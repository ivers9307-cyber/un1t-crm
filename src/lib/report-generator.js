// Shared report generation logic — used by both manual generate and cron scheduler
import { createServerClient } from '@/lib/supabase'
import { computeWeeklyCost, implicitHourlyRate, mondayOf, shiftHours } from '@/lib/payroll'
import { isLiveAssignment, formatDate } from '@/lib/roster'
import { logWarn } from '@/lib/log'

// RETIRE-SHIFTS-MIRROR.1 — reports now read the Roster v2 source of truth
// (shift_assignments + shift_blocks) instead of the legacy public.shifts
// mirror. This helper queries the new model and normalises each row back
// to the exact legacy "shift" shape the report math already expects, so
// every report's output is unchanged — only the data source moves.
//
// Field mapping: shift_date ← shift_blocks.block_date; the time overrides
// live on shift_assignments (mig 100); the template (name + default times)
// comes through the block. ROSTER-FIX.1 — cancelled assignments are dropped:
// they used to be paid in staff_hours / staff_cost and counted as coverage,
// which is what the mirror's 1:1-with-assignments behaviour inherited.
const SHIFT_ROW_SELECT = `
  profile_id, start_time_override, end_time_override, status,
  profiles:profile_id ( full_name, role, employment_type ),
  shift_blocks!inner ( block_date, location_id, shift_templates ( name, start_time, end_time ) )
`

// ROSTER-FIX.5 — a report is about ONE location, so its staff list has to be
// too. utilisation and staff_cost used to select every active profile in the
// estate: the utilisation average was diluted by staff who can never appear on
// that location's roster (they show as 0% used), and the cost report
// enumerated the whole company's payroll under one gym's heading. Roles are
// per-location on profile_locations (mig 051), which is the join that says
// who works where.
export async function fetchLocationProfileIds(db, locationId) {
  const { data, error } = await db
    .from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
  // Returned, not thrown: generateReport's contract is { success, error } and
  // POST /api/schedule/reports does not wrap the call, so a throw here would
  // surface as a bare 500 instead of a readable message. Failing closed IS
  // right for this one — an unreadable staff list would silently produce a
  // report scoped to nobody, which reads as "no staff worked here".
  if (error) return { profileIds: [], error: `Failed to load location staff: ${error.message}` }
  return { profileIds: [...new Set((data || []).map(r => r.profile_id).filter(Boolean))], error: null }
}

export async function fetchScheduledShiftRows(db, { locationId, periodStart, periodEnd }) {
  const { data: rows, error } = await db.from('shift_assignments')
    .select(SHIFT_ROW_SELECT)
    .eq('shift_blocks.location_id', locationId)
    .gte('shift_blocks.block_date', periodStart)
    .lte('shift_blocks.block_date', periodEnd)
  // ROSTER-FIX.5 — the error used to be discarded, so a failed query and a
  // genuinely empty period both produced []: the report was saved reading
  // "0 hours" with nothing anywhere saying the query had failed. The shape
  // stays an array (four callers depend on it) but the failure is now loud.
  if (error) logWarn('report-generator', 'shift rows query failed', { locationId, periodStart, periodEnd, err: error })
  return (rows || []).filter(isLiveAssignment).map((r) => ({
    shift_date: r.shift_blocks?.block_date,
    profile_id: r.profile_id,
    start_time_override: r.start_time_override,
    end_time_override: r.end_time_override,
    status: r.status,
    profiles: r.profiles,
    shift_templates: r.shift_blocks?.shift_templates,
  }))
}

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
      const shifts = await fetchScheduledShiftRows(db, { locationId: locId, periodStart: period_start, periodEnd: period_end })

      const staffHours = {}
      let totalHours = 0

      for (const shift of (shifts || [])) {
        const name = shift.profiles?.full_name || 'Unknown'
        const profileId = shift.profile_id
        if (!staffHours[profileId]) {
          staffHours[profileId] = { name, role: shift.profiles?.role, employment_type: shift.profiles?.employment_type, days: {}, total: 0 }
        }

        // ROSTER-FIX.5 — shiftHours() honours start_time_override /
        // end_time_override; the inline template math did not, so a shift a
        // manager had shortened or extended was paid at its TEMPLATE length
        // and this report disagreed with staff_cost (which already used it)
        // for the very same shifts.
        const hours = shiftHours(shift)
        if (hours > 0) {
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
      // Pull profiles + shifts in parallel — they're independent queries
      // and serial awaits used to roughly double the cron runtime.
      // Profiles include overtime_rate so OT hours can be costed at the
      // explicit rate when present. Shifts include start/end overrides
      // so we honour the same hours the schedule UI shows.
      const { profileIds, error: scopeError } = await fetchLocationProfileIds(db, locId)
      if (scopeError) return { success: false, error: scopeError }
      const [{ data: profiles, error: profilesError }, shifts] = await Promise.all([
        db.from('profiles')
          .select('id, full_name, role, employment_type, annual_salary, hourly_rate, contracted_hours_per_week, overtime_rate')
          .eq('active', true)
          .in('id', profileIds),
        fetchScheduledShiftRows(db, { locationId: locId, periodStart: period_start, periodEnd: period_end }),
      ])
      if (profilesError) return { success: false, error: profilesError.message }

      const profileMap = {}
      for (const p of (profiles || [])) profileMap[p.id] = p

      // Group shifts by (profile, week-monday) so overtime is computed per
      // week — overtime is a weekly concept, not a period total.
      const byProfileWeek = new Map() // pid → Map(mondayIso → shifts[])
      for (const shift of shifts || []) {
        const profile = profileMap[shift.profile_id]
        if (!profile) continue
        const monday = mondayOf(shift.shift_date)
        if (!byProfileWeek.has(shift.profile_id)) byProfileWeek.set(shift.profile_id, new Map())
        const weekMap = byProfileWeek.get(shift.profile_id)
        if (!weekMap.has(monday)) weekMap.set(monday, [])
        weekMap.get(monday).push(shift)
      }

      const staffCosts = {}
      let totalRegularCost = 0
      let totalOvertimeCost = 0
      let totalRegularHours = 0
      let totalOvertimeHours = 0

      for (const [pid, weekMap] of byProfileWeek) {
        const profile = profileMap[pid]
        const entry = {
          name: profile.full_name,
          role: profile.role,
          employment_type: profile.employment_type,
          regular_rate: Math.round(implicitHourlyRate(profile) * 100) / 100,
          overtime_rate: Number(profile.overtime_rate) > 0
            ? Math.round(Number(profile.overtime_rate) * 100) / 100
            : null,  // null = no premium; OT hours pay at regular rate
          weeks: {},
          regular_hours: 0,
          overtime_hours: 0,
          regular_cost: 0,
          overtime_cost: 0,
          total_cost: 0,
        }

        for (const [mondayIso, weekShifts] of weekMap) {
          const cost = computeWeeklyCost({ shifts: weekShifts, profile })
          entry.weeks[mondayIso] = {
            actual_hours: cost.actual_hours,
            regular_hours: cost.regular_hours,
            overtime_hours: cost.overtime_hours,
            regular_cost: cost.regular_cost,
            overtime_cost: cost.overtime_cost,
            total_cost: cost.total_cost,
            over_threshold: cost.over_threshold,
          }
          entry.regular_hours += cost.regular_hours
          entry.overtime_hours += cost.overtime_hours
          entry.regular_cost += cost.regular_cost
          entry.overtime_cost += cost.overtime_cost
          entry.total_cost += cost.total_cost
        }

        entry.regular_hours = Math.round(entry.regular_hours * 10) / 10
        entry.overtime_hours = Math.round(entry.overtime_hours * 10) / 10
        entry.regular_cost = Math.round(entry.regular_cost * 100) / 100
        entry.overtime_cost = Math.round(entry.overtime_cost * 100) / 100
        entry.total_cost = Math.round(entry.total_cost * 100) / 100

        staffCosts[pid] = entry
        totalRegularHours += entry.regular_hours
        totalOvertimeHours += entry.overtime_hours
        totalRegularCost += entry.regular_cost
        totalOvertimeCost += entry.overtime_cost
      }

      reportData = { staff: Object.values(staffCosts) }
      summary = {
        total_regular_hours: Math.round(totalRegularHours * 10) / 10,
        total_overtime_hours: Math.round(totalOvertimeHours * 10) / 10,
        total_regular_cost: Math.round(totalRegularCost * 100) / 100,
        total_overtime_cost: Math.round(totalOvertimeCost * 100) / 100,
        total_cost: Math.round((totalRegularCost + totalOvertimeCost) * 100) / 100,
        total_hours: Math.round((totalRegularHours + totalOvertimeHours) * 10) / 10,
        staff_count: Object.keys(staffCosts).length,
        currency: 'EUR',
      }
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

      // Seed all five types (mig 283) so unpaid/other/unavailable are bucketed,
      // not dropped. The `byType[req.type] = …` accumulator below tolerates any
      // key; seeding just makes the report shape stable.
      const byType = { holiday: 0, sick: 0, unpaid: 0, other: 0, unavailable: 0 }
      const byStatus = { pending: 0, approved: 0, rejected: 0, cancelled: 0 }
      const byStaff = {}

      for (const req of (requests || [])) {
        byType[req.type] = (byType[req.type] || 0) + Number(req.total_days)
        byStatus[req.status] = (byStatus[req.status] || 0) + 1
        const name = req.profiles?.full_name || 'Unknown'
        if (!byStaff[name]) byStaff[name] = { holiday: 0, sick: 0, unpaid: 0, other: 0, unavailable: 0, total: 0 }
        byStaff[name][req.type] = (byStaff[name][req.type] || 0) + Number(req.total_days)
        byStaff[name].total += Number(req.total_days)
      }

      reportData = { requests: requests || [], by_type: byType, by_status: byStatus, by_staff: byStaff }
      summary = { total_requests: (requests || []).length, total_days: Object.values(byType).reduce((a, b) => a + b, 0), ...byType }
      break
    }

    case 'roster_coverage': {
      reportName = 'Roster Coverage'
      // shifts and approved time-off are independent — fetch in parallel.
      const [shifts, { data: timeOff }] = await Promise.all([
        fetchScheduledShiftRows(db, { locationId: locId, periodStart: period_start, periodEnd: period_end }),
        db.from('time_off_requests')
          .select('start_date, end_date, profile_id, type, profiles!profile_id(full_name)')
          .eq('location_id', locId)
          .eq('status', 'approved')
          .lte('start_date', period_end)
          .gte('end_date', period_start),
      ])

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
      // profiles + shifts are independent — fetch in parallel.
      const { profileIds, error: scopeError } = await fetchLocationProfileIds(db, locId)
      if (scopeError) return { success: false, error: scopeError }
      const [{ data: profiles, error: profilesError }, shifts] = await Promise.all([
        db.from('profiles')
          .select('id, full_name, role, employment_type, contracted_hours_per_week')
          .eq('active', true)
          .in('id', profileIds),
        fetchScheduledShiftRows(db, { locationId: locId, periodStart: period_start, periodEnd: period_end }),
      ])
      if (profilesError) return { success: false, error: profilesError.message }

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
        // ROSTER-FIX.5 — override-aware, same as staff_hours and staff_cost.
        staffUtil[shift.profile_id].actual_hours += shiftHours(shift)
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
 * Daily = yesterday, weekly = last 7 days, fortnightly = last 14 days,
 * monthly = last calendar month. All boundaries inclusive.
 *
 * ROSTER-FIX.5 — boundaries are now formatted from LOCAL calendar components
 * (formatDate), not toISOString(). The old UTC formatting was the classic
 * CLAUDE.md trap: `new Date(y, m - 1, 1)` is LOCAL midnight, so under any
 * offset east of UTC (Dublin BST = +1) toISOString() rolled it back a day and
 * every monthly report covered 31 Mar - 29 Apr instead of 1 - 30 Apr. It also
 * removes the old "don't move the cron earlier than 01:00 UTC" caveat: local
 * components mean the period is the operator's yesterday at any run hour.
 */
export function calculatePeriodForSchedule(frequency) {
  const now = new Date()

  // period_end is always yesterday, local.
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  // A daily report covers ONE day. It used to fall through to the 7-day
  // default, so a schedule labelled "daily" re-reported the same week every
  // morning.
  if (frequency === 'daily') {
    const day = formatDate(yesterday)
    return { period_start: day, period_end: day }
  }

  if (frequency === 'monthly') {
    // Previous full calendar month.
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0)
    return { period_start: formatDate(first), period_end: formatDate(last) }
  }

  // weekly (and the fallback) = 7 days, fortnightly = 14 — both ending
  // yesterday, inclusive.
  const span = frequency === 'fortnightly' ? 13 : 6
  const start = new Date(yesterday)
  start.setDate(start.getDate() - span)
  return { period_start: formatDate(start), period_end: formatDate(yesterday) }
}

/**
 * Calculate the next run date after execution. Always 07:00 local on the
 * target day; null for 'once' (nothing to advance to) and for a
 * weekly/fortnightly schedule with no weekday set.
 *
 * `dayOfWeek` is a JS weekday (0=Sunday) — see src/lib/report-schedule-days.js
 * and mig 601. The UI converts; nothing else may.
 */
export function calculateNextRun(frequency, dayOfWeek, dayOfMonth) {
  const now = new Date()

  // ROSTER-FIX.5 — 'daily' returned null, so /api/cron/run-scheduled-reports
  // left next_run_at where it was: a daily schedule ran once and then either
  // stalled or re-fired every tick.
  if (frequency === 'daily') {
    const target = new Date(now)
    target.setDate(target.getDate() + 1)
    target.setHours(7, 0, 0, 0)
    return target.toISOString()
  }

  if ((frequency === 'weekly' || frequency === 'fortnightly') && dayOfWeek != null) {
    const target = new Date(now)
    const diff = (dayOfWeek - target.getDay() + 7) % 7
    // diff === 0 means today IS the target weekday, and the run that just
    // happened is why we are here — so the next one is a whole week out, never
    // today. Fortnightly is then that occurrence plus another week.
    const next = diff === 0 ? 7 : diff
    target.setDate(target.getDate() + next + (frequency === 'fortnightly' ? 7 : 0))
    target.setHours(7, 0, 0, 0)
    return target.toISOString()
  }

  if (frequency === 'monthly' && dayOfMonth) {
    const target = new Date(now.getFullYear(), now.getMonth() + 1, dayOfMonth, 7, 0, 0)
    return target.toISOString()
  }

  return null // 'once' — no next run
}

// ─── Email delivery ──────────────────────────────────────────────────────────
// Render a generated report into a transactional HTML email. Pure (no IO) so
// it's unit-testable; the cron route (`/api/cron/run-scheduled-reports`) calls
// this then sends via Postmark's `outbound` stream. The email is a summary
// teaser — the full per-row breakdown stays in the CRM under Schedule →
// Reporting (the CTA links there when an app URL is available).

const REPORT_CURRENCY_SYMBOLS = { EUR: '€', GBP: '£', USD: '$' }

export function humanizeReportKey(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// Deterministic thousands separator (no Intl/locale dependency so the unit
// tests assert stable strings across Node ICU versions).
function withThousands(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatReportValue(key, value, currency) {
  if (value == null) return '—'
  if (typeof value !== 'number') return String(value)
  const isMoney = /cost|salary|pay\b/i.test(key)
  if (isMoney) {
    const sym = REPORT_CURRENCY_SYMBOLS[currency] || ''
    const [int, frac = '00'] = value.toFixed(2).split('.')
    return `${sym}${withThousands(int)}.${frac}`
  }
  // Plain count / hours — keep up to one decimal, add thousands separators.
  const rounded = Math.round(value * 10) / 10
  const [int, frac] = String(rounded).split('.')
  return frac != null ? `${withThousands(int)}.${frac}` : withThousands(int)
}

export function buildReportEmailHtml(report, { appUrl } = {}) {
  const { report_name, period_start, period_end, summary } = report || {}
  const currency = summary?.currency

  const periodLine = !period_start || period_start === period_end
    ? (period_start || '')
    : `${period_start} → ${period_end}`

  const rows = Object.entries(summary || {})
    .filter(([k]) => k !== 'currency')
    .map(([k, v]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E5E9;color:#64748B;font-size:13px;">${humanizeReportKey(k)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #E2E5E9;color:#111827;font-size:13px;font-weight:600;text-align:right;">${formatReportValue(k, v, currency)}</td>
        </tr>`)
    .join('')

  const body = rows ||
    `<tr><td style="padding:8px 12px;color:#64748B;font-size:13px;">No data for this period.</td></tr>`

  const cta = appUrl
    ? `<p style="margin:24px 0 0;font-size:13px;color:#64748B;">Full breakdown is in the CRM under <a href="${appUrl}/schedule" style="color:#1E293B;font-weight:600;">Schedule → Reporting</a>.</p>`
    : ''

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#F7F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#FFFFFF;border:1px solid #E2E5E9;border-radius:16px;padding:24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#94A3B8;">Scheduled report</div>
      <h1 style="margin:4px 0 2px;font-size:20px;color:#111827;">${report_name || 'Report'}</h1>
      <div style="font-size:13px;color:#64748B;">${periodLine}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;">
        ${body}
      </table>
      ${cta}
    </div>
    <!-- CHROME.1 — scheduled reports go to STAFF addresses
         (schedule.email_recipients, never CRM contacts), so the footer
         names the platform, not the gym. -->
    <p style="text-align:center;font-size:11px;color:#94A3B8;margin-top:16px;">Repset · automated report delivery</p>
  </div>
</body>
</html>`
}
