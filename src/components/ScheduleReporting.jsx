'use client'

import { useState, useEffect, useCallback } from 'react'
import { Clock, Euro, CalendarOff, Users, TrendingUp, Play, Calendar, FileText, Mail, Repeat, Pause, Pencil, Trash2 } from 'lucide-react'
import { EmptyState, Loading, Modal } from '@/components/ui'
import { toJsDay, fromJsDay, DAY_NAMES_MONDAY_FIRST } from '@/lib/report-schedule-days'
import { formatDate } from '@/lib/roster'
import { canViewReportType, isRateReportType } from '@/lib/report-access'
import {
  EMPTY_CELL, formatEuroCell, formatHoursCell, readStaffCostRow, readStaffHoursTotal, staffCostHasSplit,
} from '@/lib/report-staff-table'
// ROSTER-FIX.6a — one failure shape and one banner across the schedule
// screens, so no call site can quietly forget to check the response.
import ScheduleErrorBanner from './schedule/ScheduleErrorBanner'
import { readJson } from './schedule/useScheduleData'

const REPORT_TYPES = [
  { key: 'staff_hours',     label: 'Staff Hours Worked',    icon: Clock,       description: 'Total hours worked per staff member with daily breakdown' },
  { key: 'staff_cost',      label: 'Staff Cost Breakdown',  icon: Euro,        description: 'Labour costs by staff member based on hourly rates (€)' },
  { key: 'time_off_summary',label: 'Time Off Summary',      icon: CalendarOff, description: 'Holiday, sick, and unavailability summary by staff' },
  { key: 'roster_coverage', label: 'Roster Coverage',       icon: Users,       description: 'Daily shift coverage and staff availability overview' },
  { key: 'utilisation',     label: 'Staff Utilisation',     icon: TrendingUp,  description: 'Actual vs contracted hours — who is over/under utilised' },
]

// ROSTER-FIX.5 — 'daily' and 'fortnightly' were each supported by two of the
// three layers (table CHECK, POST schema, this list) and missing from the
// third, so Fortnightly was offered here and rejected by the API. Mig 601
// settles all three on this set.
const FREQ_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
]

function formatCurrency(val) {
  return formatEuroCell(val)
}

// ROSTER-FIX.6a — toISOString() on a LOCAL Date shifts to UTC, so under
// Dublin BST the default window opened and closed a day early: the operator's
// "last 7 days" quietly excluded today and included the day before last week.
// formatDate() reads the local calendar components, which is what the picker
// and the API both mean by a date.
function getDefaultDates() {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 6)
  return { start: formatDate(start), end: formatDate(end) }
}

export default function ScheduleReporting({ user }) {
  const [view, setView] = useState('generate') // 'generate', 'history', 'scheduled'
  const [selectedReport, setSelectedReport] = useState(null)
  const [periodStart, setPeriodStart] = useState(getDefaultDates().start)
  const [periodEnd, setPeriodEnd] = useState(getDefaultDates().end)
  const [generating, setGenerating] = useState(false)
  const [reportResult, setReportResult] = useState(null)
  const [history, setHistory] = useState([])
  const [scheduledReports, setScheduledReports] = useState([])
  // { reportType } to create, { schedule } to edit (REPORTS.2).
  const [showScheduleModal, setShowScheduleModal] = useState(null)
  // REPORTS.2 — the schedule id awaiting a delete confirmation, and the id
  // whose pause/resume/delete request is in flight.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [busyScheduleId, setBusyScheduleId] = useState(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  // ROSTER-FIX.6a — both loads and both writes discarded every failure, so a
  // refused read left the history and schedule lists silently empty (which
  // reads as "no reports yet") and a refused save looked like nothing
  // happened at all.
  //
  // ROSTER-FIX.6a-8 — one state serves the load AND generateReport, so the
  // banner's fixed "Something went wrong" title said nothing about which, and
  // its Retry always re-ran the LOAD - which succeeds, clearing the banner
  // while the report the operator asked for was never generated. Each failure
  // now carries { title, message, retry }.
  const [error, setError] = useState(null)

  const locationId = user.activeLocation?.id
  // STAFFCOST.1 — Staff Cost shows pay rates, so its tile is hidden from head
  // coaches. Display only: the API refuses to generate, list or schedule it.
  const reportTypes = REPORT_TYPES.filter(rt => canViewReportType(user, locationId, rt.key))
  const resultType = reportResult?.report_type || selectedReport

  const loadReports = useCallback(async () => {
    setLoadingHistory(true)
    setError(null)
    try {
      const [historyRes, scheduledRes] = await Promise.all([
        readJson(`/api/schedule/reports?location_id=${locationId}`),
        readJson(`/api/schedule/reports/scheduled?location_id=${locationId}`),
      ])
      setHistory(historyRes.data || [])
      setScheduledReports(scheduledRes.data || [])
    } catch (e) {
      setError({ title: 'Could not load reports', message: e?.message || 'The request failed.', retry: true })
    } finally {
      setLoadingHistory(false)
    }
  }, [locationId])

  useEffect(() => { loadReports() }, [loadReports])

  async function generateReport() {
    if (!selectedReport) return
    setGenerating(true)
    setReportResult(null)
    setError(null)
    try {
      const res = await fetch('/api/schedule/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_type: selectedReport,
          period_start: periodStart,
          period_end: periodEnd,
          location_id: locationId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        setError({ title: 'Could not generate the report', message: data.error || 'The report was not generated.', retry: false })
        return
      }
      setReportResult(data.data)
      loadReports()
    } catch {
      setError({ title: 'Could not generate the report', message: 'Network error, please try again', retry: false })
    } finally {
      // The button used to stay on "Generating…" whenever the fetch threw.
      setGenerating(false)
    }
  }

  // REPORTS.2 — pause/resume (PATCH) and delete (DELETE deactivates).
  async function changeSchedule(sr, action) {
    setBusyScheduleId(sr.id)
    setError(null)
    try {
      const url = `/api/schedule/reports/scheduled?id=${encodeURIComponent(sr.id)}`
      if (action === 'delete') {
        await readJson(url, { method: 'DELETE' })
      } else {
        await readJson(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: action === 'pause' }),
        })
      }
      setConfirmDeleteId(null)
      await loadReports()
    } catch (e) {
      const title = action === 'delete' ? 'Could not delete the schedule'
        : action === 'pause' ? 'Could not pause the schedule' : 'Could not resume the schedule'
      setError({ title, message: e?.message || 'The request failed.', retry: false })
    } finally {
      setBusyScheduleId(null)
    }
  }

  function viewHistoricReport(report) {
    setReportResult(report)
    setSelectedReport(report.report_type)
    setPeriodStart(report.period_start)
    setPeriodEnd(report.period_end)
    setView('generate')
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Reporting</h2>
          <p className="text-sm text-un1t-subtle mt-1">{user.activeLocation?.name} — Schedule & labour reports</p>
        </div>
      </div>

      {error && (
        <ScheduleErrorBanner
          title={error.title}
          message={error.message}
          onRetry={error.retry ? loadReports : undefined}
          busy={loadingHistory}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Sub-tabs */}
      <div className="flex gap-1.5 mb-6 text-xs">
        {[
          { key: 'generate', label: 'Generate Report', icon: Play },
          { key: 'history', label: `Report History (${history.length})`, icon: FileText },
          { key: 'scheduled', label: `Scheduled (${scheduledReports.length})`, icon: Repeat },
        ].map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setView(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors ${
              view === t.key ? 'bg-un1t-text text-un1t-bg' : 'bg-un1t-surface border border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* Generate Report view */}
      {view === 'generate' && (
        <div className="space-y-6">
          {/* Report type selector */}
          {/* ROSTER-FIX.6b — five report tiles, each with an icon over a
              two-line label, will not fit a phone in one row. */}
          <div className={`grid grid-cols-2 sm:grid-cols-3 ${reportTypes.length >= 5 ? 'md:grid-cols-5' : 'md:grid-cols-4'} gap-2`}>
            {reportTypes.map(rt => {
              const Icon = rt.icon
              return (
                <button
                  key={rt.key}
                  type="button"
                  onClick={() => { setSelectedReport(rt.key); setReportResult(null) }}
                  className={`flex flex-col items-center gap-2 p-4 rounded-lg border text-xs transition-colors ${
                    selectedReport === rt.key
                      ? 'border-un1t-text/40 bg-un1t-border/30 text-un1t-text'
                      : 'border-un1t-border bg-un1t-surface text-un1t-subtle hover:border-white/20 hover:text-un1t-text'
                  }`}
                >
                  <Icon size={20} />
                  <span className="font-medium text-center">{rt.label}</span>
                </button>
              )
            })}
          </div>

          {selectedReport && (
            <>
              <div className="text-sm text-un1t-subtle">
                {reportTypes.find(r => r.key === selectedReport)?.description}
              </div>

              {/* Date range + generate */}
              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs text-un1t-subtle mb-1">Start Date</label>
                  <input
                    type="date"
                    value={periodStart}
                    onChange={e => setPeriodStart(e.target.value)}
                    className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                  />
                </div>
                <div>
                  <label className="block text-xs text-un1t-subtle mb-1">End Date</label>
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={e => setPeriodEnd(e.target.value)}
                    className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                  />
                </div>
                <button
                  type="button"
                  onClick={generateReport}
                  disabled={generating}
                  className="flex items-center gap-1.5 px-4 py-2 bg-un1t-text text-un1t-bg text-sm font-medium rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
                >
                  <Play size={14} /> {generating ? 'Generating...' : 'Generate'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowScheduleModal({ reportType: selectedReport })}
                  className="flex items-center gap-1.5 px-4 py-2 border border-un1t-border text-sm text-un1t-subtle hover:text-un1t-text rounded-md transition-colors"
                >
                  <Calendar size={14} /> Schedule
                </button>
              </div>
            </>
          )}

          {/* Report Result */}
          {reportResult && (
            <div className="space-y-4">
              {/* Summary cards */}
              {reportResult.summary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {Object.entries(reportResult.summary).map(([key, val]) => (
                    <div key={key} className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
                      <div className="text-xs text-un1t-subtle uppercase tracking-wider">{key.replace(/_/g, ' ')}</div>
                      <div className="text-xl font-bold mt-1">
                        {key.includes('cost') ? formatCurrency(val) : (typeof val === 'number' && !Number.isFinite(val) ? EMPTY_CELL : val)}
                        {key.includes('hours') && <span className="text-sm text-un1t-subtle ml-1">hrs</span>}
                        {key.includes('utilisation') && <span className="text-sm text-un1t-subtle ml-1">%</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Report period */}
              <div className="text-xs text-un1t-subtle">
                Period: {new Date(reportResult.period_start + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })} – {new Date(reportResult.period_end + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}
              </div>

              {/* Staff data table */}
              {/* STAFFCOST.1 — staff_cost has its own table: it read hourly_rate
                  and total_hours, which the generator stopped writing on 30 Apr,
                  so every rate cell was €NaN and every hours cell 0. The
                  helpers read the current fields and fall back field by field
                  for reports stored before then. */}
              {reportResult.report_data?.staff && resultType === 'staff_cost' && (
                <StaffCostTable rows={reportResult.report_data.staff} />
              )}
              {reportResult.report_data?.staff && resultType !== 'staff_cost' && (
                <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="border-b border-un1t-border text-xs text-un1t-subtle uppercase">
                        <th className="text-left px-4 py-3">Staff Member</th>
                        <th className="text-left px-4 py-3">Role</th>
                        <th className="text-left px-4 py-3">Type</th>
                        <th className="text-right px-4 py-3">
                          {resultType === 'utilisation' ? 'Contracted' : 'Total Hours'}
                        </th>
                        {resultType === 'utilisation' && <th className="text-right px-4 py-3">Actual</th>}
                        {resultType === 'utilisation' && <th className="text-right px-4 py-3">Utilisation</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {reportResult.report_data.staff.map((s, i) => (
                        <tr key={i} className="border-b border-un1t-border/50 hover:bg-un1t-border/30">
                          <td className="px-4 py-3 font-medium">{s.name}</td>
                          <td className="px-4 py-3 text-un1t-subtle capitalize">{s.role}</td>
                          <td className="px-4 py-3"><EmploymentChip type={s.employment_type} /></td>
                          <td className="px-4 py-3 text-right">
                            {resultType === 'utilisation'
                              ? formatHoursCell(s.contracted_hours)
                              : formatHoursCell(readStaffHoursTotal(s))}
                          </td>
                          {resultType === 'utilisation' && (
                            <td className="px-4 py-3 text-right">{formatHoursCell(s.actual_hours)}</td>
                          )}
                          {resultType === 'utilisation' && (
                            <td className="px-4 py-3 text-right">
                              <span className={`font-medium ${s.utilisation_pct > 100 ? 'text-red-700' : s.utilisation_pct >= 80 ? 'text-green-700' : 'text-amber-700'}`}>
                                {Number.isFinite(Number(s.utilisation_pct)) ? `${s.utilisation_pct}%` : EMPTY_CELL}
                              </span>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Time-off by staff table */}
              {reportResult.report_data?.by_staff && (
                <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="border-b border-un1t-border text-xs text-un1t-subtle uppercase">
                        <th className="text-left px-4 py-3">Staff Member</th>
                        <th className="text-right px-4 py-3">Holiday</th>
                        <th className="text-right px-4 py-3">Sick</th>
                        <th className="text-right px-4 py-3">Unavailable</th>
                        <th className="text-right px-4 py-3">Total Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(reportResult.report_data.by_staff).map(([name, data]) => (
                        <tr key={name} className="border-b border-un1t-border/50 hover:bg-un1t-border/30">
                          <td className="px-4 py-3 font-medium">{name}</td>
                          <td className="px-4 py-3 text-right text-green-700">{data.holiday || 0}</td>
                          <td className="px-4 py-3 text-right text-red-700">{data.sick || 0}</td>
                          <td className="px-4 py-3 text-right text-amber-700">{data.unavailable || 0}</td>
                          <td className="px-4 py-3 text-right font-medium">{data.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Roster coverage day view */}
              {reportResult.report_data?.days && (
                <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead>
                      <tr className="border-b border-un1t-border text-xs text-un1t-subtle uppercase">
                        <th className="text-left px-4 py-3">Date</th>
                        <th className="text-right px-4 py-3">Shifts</th>
                        <th className="text-right px-4 py-3">Staff Working</th>
                        <th className="text-left px-4 py-3">Staff Off</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportResult.report_data.days.map(day => (
                        <tr key={day.date} className="border-b border-un1t-border/50 hover:bg-un1t-border/30">
                          <td className="px-4 py-3 font-medium">
                            {new Date(day.date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })}
                          </td>
                          <td className="px-4 py-3 text-right">{day.shifts_count}</td>
                          <td className="px-4 py-3 text-right">{day.staff_working}</td>
                          <td className="px-4 py-3 text-un1t-subtle text-xs">
                            {day.staff_off.length > 0 ? day.staff_off.join(', ') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Report History */}
      {view === 'history' && (
        <div>
          {loadingHistory ? (
            <Loading label="Loading report history…" />
          ) : history.length === 0 ? (
            <EmptyState
              icon={<FileText size={40} />}
              title="No reports generated yet"
            />
          ) : (
            <div className="space-y-2">
              {history.map(r => {
                const typeInfo = REPORT_TYPES.find(rt => rt.key === r.report_type) || { label: r.report_type, icon: FileText }
                const Icon = typeInfo.icon
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => viewHistoricReport(r)}
                    className="w-full bg-un1t-surface border border-un1t-border rounded-lg p-4 flex items-center gap-4 text-left hover:border-white/20 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                      <Icon size={20} className="text-blue-700" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{r.report_name}</div>
                      <div className="text-xs text-un1t-subtle mt-0.5">
                        {new Date(r.period_start + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })} – {new Date(r.period_end + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}
                        <span className="mx-2">·</span>
                        Generated {new Date(r.created_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    {r.summary && (
                      <div className="text-right shrink-0">
                        {r.summary.total_cost !== undefined && (
                          <div className="text-sm font-bold">{formatCurrency(r.summary.total_cost)}</div>
                        )}
                        {r.summary.total_hours !== undefined && (
                          <div className="text-xs text-un1t-subtle">{r.summary.total_hours} hrs</div>
                        )}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Scheduled Reports */}
      {view === 'scheduled' && (
        <div>
          {scheduledReports.length === 0 ? (
            <EmptyState
              icon={<Repeat size={40} />}
              title="No scheduled reports"
              description="Schedule reports from the Generate Report tab"
            />
          ) : (
            <div className="space-y-2">
              {scheduledReports.map(sr => {
                const typeInfo = REPORT_TYPES.find(rt => rt.key === sr.report_type) || { label: sr.report_type, icon: FileText }
                const Icon = typeInfo.icon
                const busy = busyScheduleId === sr.id
                const recipientCount = (sr.email_recipients || []).length
                return (
                  <div
                    key={sr.id}
                    className="bg-un1t-surface border border-un1t-border rounded-lg p-4 flex flex-wrap items-center gap-4"
                  >
                    <div className={`w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0 ${sr.paused ? 'opacity-50' : ''}`}>
                      <Icon size={20} className="text-purple-700" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm flex items-center gap-2">
                        <span className="truncate">{sr.report_name}</span>
                        {sr.paused && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-500/10 text-amber-700 border-amber-500/30">Paused</span>
                        )}
                      </div>
                      <div className="text-xs text-un1t-subtle mt-0.5 flex flex-wrap items-center gap-2">
                        <span className="capitalize">{sr.frequency}</span>
                        {sr.day_of_week != null && <span>· {DAY_NAMES_MONDAY_FIRST[fromJsDay(sr.day_of_week)]}</span>}
                        {sr.day_of_month && <span>· Day {sr.day_of_month}</span>}
                        {sr.deliver_email && recipientCount > 0 && (
                          <span className="flex items-center gap-0.5">
                            <Mail size={10} /> Email summary to {recipientCount} {recipientCount === 1 ? 'recipient' : 'recipients'}
                          </span>
                        )}
                        {!sr.deliver_email && <span>· Report History only</span>}
                      </div>
                    </div>
                    {sr.next_run_at && !sr.paused && (
                      <div className="text-xs text-un1t-subtle text-right shrink-0">
                        Next: {new Date(sr.next_run_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {confirmDeleteId === sr.id ? (
                        <>
                          <span className="text-xs text-un1t-subtle">Delete this schedule?</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => changeSchedule(sr, 'delete')}
                            className="px-2.5 py-1.5 text-xs rounded-md bg-red-500/10 text-red-700 border border-red-500/30 disabled:opacity-50"
                          >
                            {busy ? 'Deleting…' : 'Delete'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2.5 py-1.5 text-xs rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => changeSchedule(sr, sr.paused ? 'resume' : 'pause')}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                          >
                            {sr.paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setShowScheduleModal({ schedule: sr })}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
                          >
                            <Pencil size={12} /> Edit
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(sr.id)}
                            aria-label={`Delete ${sr.report_name}`}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-un1t-border text-un1t-subtle hover:text-red-700 disabled:opacity-50"
                          >
                            <Trash2 size={12} /> Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <ScheduleReportModal
          reportType={showScheduleModal.reportType}
          schedule={showScheduleModal.schedule}
          allowedReportTypes={reportTypes}
          locationId={locationId}
          onClose={() => setShowScheduleModal(null)}
          onSave={() => { setShowScheduleModal(null); loadReports() }}
        />
      )}
    </div>
  )
}

function EmploymentChip({ type }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${type === 'contractor' ? 'bg-amber-500/10 text-amber-700' : 'bg-blue-500/10 text-blue-700'}`}>
      {type === 'contractor' ? 'Contractor' : 'FTE'}
    </span>
  )
}

// STAFFCOST.1 — regular and overtime columns appear when the stored report
// has them (every report since 30 Apr); an older report shows one Total Hours
// column, as it was generated.
export function StaffCostTable({ rows }) {
  const split = staffCostHasSplit(rows)
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
      <table className="w-full text-sm min-w-[600px]">
        <thead>
          <tr className="border-b border-un1t-border text-xs text-un1t-subtle uppercase">
            <th className="text-left px-4 py-3">Staff Member</th>
            <th className="text-left px-4 py-3">Role</th>
            <th className="text-left px-4 py-3">Type</th>
            <th className="text-right px-4 py-3">Rate (€/hr)</th>
            {split && <th className="text-right px-4 py-3">OT Rate (€/hr)</th>}
            {split && <th className="text-right px-4 py-3">Regular Hours</th>}
            {split && <th className="text-right px-4 py-3">Overtime Hours</th>}
            <th className="text-right px-4 py-3">Total Hours</th>
            <th className="text-right px-4 py-3">Total Cost</th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((s, i) => {
            const r = readStaffCostRow(s)
            return (
              <tr key={i} className="border-b border-un1t-border/50 hover:bg-un1t-border/30">
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3 text-un1t-subtle capitalize">{s.role}</td>
                <td className="px-4 py-3"><EmploymentChip type={s.employment_type} /></td>
                <td className="px-4 py-3 text-right">{formatEuroCell(r.rate)}</td>
                {split && <td className="px-4 py-3 text-right">{formatEuroCell(r.overtimeRate)}</td>}
                {split && <td className="px-4 py-3 text-right">{formatHoursCell(r.regularHours)}</td>}
                {split && <td className="px-4 py-3 text-right">{formatHoursCell(r.overtimeHours)}</td>}
                <td className="px-4 py-3 text-right">{formatHoursCell(r.totalHours)}</td>
                <td className="px-4 py-3 text-right font-medium">{formatEuroCell(r.totalCost)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ScheduleReportModal({ reportType: initialReportType, schedule, allowedReportTypes, locationId, onClose, onSave }) {
  // REPORTS.2 — one form for create (POST) and edit (PATCH). Editing may change
  // the report type, but only among the types this caller may see here; the
  // API enforces the same rule at the schedule's location.
  const editing = !!schedule
  const [reportType, setReportType] = useState(schedule?.report_type || initialReportType)
  const typeInfo = REPORT_TYPES.find(r => r.key === reportType)
  const [name, setName] = useState(schedule?.report_name ?? (typeInfo ? `Weekly ${typeInfo.label}` : ''))
  const [frequency, setFrequency] = useState(schedule?.frequency || 'weekly')
  // ROSTER-FIX.5 — this is the STORED value, a JS weekday. 1 = Monday.
  const [dayOfWeek, setDayOfWeek] = useState(schedule?.day_of_week ?? 1)
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.day_of_month ?? 1)
  const [deliverEmail, setDeliverEmail] = useState(schedule?.deliver_email === true)
  const [emailRecipients, setEmailRecipients] = useState((schedule?.email_recipients || []).join(', '))
  const [saving, setSaving] = useState(false)
  // ROSTER-FIX.6a — a failed save used to alert() and, if the fetch threw,
  // leave the button on "Saving…" with the modal open and nothing said.
  const [saveError, setSaveError] = useState(null)
  // REPORTS.2 — addresses the API wants confirmed as external before a staff
  // cost schedule may email them. Cleared whenever the recipients change, so
  // a confirmation always names the list being saved.
  const [externalToConfirm, setExternalToConfirm] = useState(null)
  const rateReport = isRateReportType(reportType)

  async function handleSave({ confirmExternal = false } = {}) {
    setSaving(true)
    setSaveError(null)
    try {
      const payload = {
        report_type: reportType,
        report_name: name,
        frequency,
        day_of_week: frequency === 'weekly' || frequency === 'fortnightly' ? dayOfWeek : null,
        day_of_month: frequency === 'monthly' ? dayOfMonth : null,
        deliver_email: deliverEmail,
        email_recipients: deliverEmail ? emailRecipients.split(',').map(e => e.trim()).filter(Boolean) : [],
        ...(confirmExternal ? { confirm_external: true } : {}),
      }
      const res = editing
        ? await fetch(`/api/schedule/reports/scheduled?id=${encodeURIComponent(schedule.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        : await fetch('/api/schedule/reports/scheduled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, location_id: locationId }),
        })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409 && data.code === 'confirm_external_recipients') {
        setExternalToConfirm(data.external_recipients || [])
        return
      }
      if (!res.ok || !data.success) {
        setSaveError(data.error || (editing ? 'Failed to save changes' : 'Failed to schedule report'))
        return
      }
      onSave()
    } catch {
      setSaveError('Network error, please try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    // ROSTER-FIX.6b — the close control used to be a Plus icon rotated 45°
    // with no accessible name at all; the primitive's own labelled close
    // button replaces it.
    <Modal open onClose={onClose} title={editing ? 'Edit Scheduled Report' : 'Schedule Recurring Report'} dismissOnBackdrop={false}>
      <div>
        {/* ROSTER-FIX.6a — a failed save used to alert(); it reports in place
            now, inside the dialog that still holds the operator's form. */}
        {saveError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-4">
            {saveError}
          </div>
        )}

        <div className="space-y-4">
          {editing && (
            <div>
              <label htmlFor="schedule-report-type" className="block text-xs text-un1t-subtle mb-1">Report</label>
              <select
                id="schedule-report-type"
                value={reportType}
                onChange={e => { setReportType(e.target.value); setExternalToConfirm(null) }}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                {(allowedReportTypes || REPORT_TYPES).map(rt => <option key={rt.key} value={rt.key}>{rt.label}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Report Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
          </div>

          <div>
            <label className="block text-xs text-un1t-subtle mb-1">Frequency</label>
            <select
              value={frequency}
              onChange={e => setFrequency(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            >
              {FREQ_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>

          {(frequency === 'weekly' || frequency === 'fortnightly') && (
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">Day of Week</label>
              <select
                value={dayOfWeek}
                onChange={e => setDayOfWeek(Number(e.target.value))}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                {DAY_NAMES_MONDAY_FIRST.map((d, i) => <option key={i} value={toJsDay(i)}>{d}</option>)}
              </select>
            </div>
          )}

          {frequency === 'monthly' && (
            <div>
              <label className="block text-xs text-un1t-subtle mb-1">Day of Month</label>
              <input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={e => setDayOfMonth(Number(e.target.value))}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
          )}

          <div className="space-y-3">
            <label className="block text-xs text-un1t-subtle">Delivery</label>
            <p className="text-xs text-un1t-subtle">Every run is saved to Report History.</p>
            {/* REPORTS.2 — this was "Email (PDF)", but the email is an HTML
                summary of the report's totals; no PDF is attached. The
                "In-app notification" option beside it never notified anyone
                and is gone. */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={deliverEmail}
                onChange={e => { setDeliverEmail(e.target.checked); setExternalToConfirm(null) }}
                className="rounded"
              />
              <span className="text-sm flex items-center gap-1.5"><Mail size={14} /> Email summary</span>
            </label>
            {deliverEmail && (
              <div>
                <label className="block text-xs text-un1t-subtle mb-1">Recipients (comma-separated)</label>
                <input
                  type="text"
                  value={emailRecipients}
                  onChange={e => { setEmailRecipients(e.target.value); setExternalToConfirm(null) }}
                  placeholder="manager@un1t.ie, owner@un1t.ie"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                />
                {rateReport && (
                  <p className="text-xs text-un1t-subtle mt-1">
                    Staff cost figures go only to owners and managers at this studio, or to outside addresses you confirm.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {externalToConfirm && externalToConfirm.length > 0 ? (
          <div role="alertdialog" aria-label="Confirm external recipients" className="mt-5 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm">
            <p className="text-amber-700 font-medium">These addresses are not staff at this studio:</p>
            <ul className="mt-1 text-un1t-text list-disc pl-5">
              {externalToConfirm.map(e => <li key={e}>{e}</li>)}
            </ul>
            <p className="mt-2 text-un1t-subtle text-xs">
              They will receive this studio&apos;s staff cost figures every time the report runs. Only confirm addresses outside the team, like your accountant.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => handleSave({ confirmExternal: true })}
                disabled={saving}
                className="flex-1 bg-un1t-text text-un1t-bg font-medium text-sm py-2 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Confirm and save'}
              </button>
              <button
                type="button"
                onClick={() => setExternalToConfirm(null)}
                disabled={saving}
                className="px-3 py-2 text-sm rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
              >
                Go back
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => handleSave()}
            disabled={!name || saving}
            className="w-full mt-5 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Schedule'}
          </button>
        )}
      </div>
    </Modal>
  )
}
