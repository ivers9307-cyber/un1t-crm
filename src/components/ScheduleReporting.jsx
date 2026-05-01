'use client'

import { useState, useEffect, useCallback } from 'react'
import { Clock, Euro, CalendarOff, Users, TrendingUp, Play, Calendar, Plus, FileText, Bell, Mail, Repeat } from 'lucide-react'

const REPORT_TYPES = [
  { key: 'staff_hours',     label: 'Staff Hours Worked',    icon: Clock,       description: 'Total hours worked per staff member with daily breakdown' },
  { key: 'staff_cost',      label: 'Staff Cost Breakdown',  icon: Euro,        description: 'Labour costs by staff member based on hourly rates (€)' },
  { key: 'time_off_summary',label: 'Time Off Summary',      icon: CalendarOff, description: 'Holiday, sick, and unavailability summary by staff' },
  { key: 'roster_coverage', label: 'Roster Coverage',       icon: Users,       description: 'Daily shift coverage and staff availability overview' },
  { key: 'utilisation',     label: 'Staff Utilisation',     icon: TrendingUp,  description: 'Actual vs contracted hours — who is over/under utilised' },
]

const FREQ_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
]

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function formatCurrency(val) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(val)
}

function getDefaultDates() {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 6)
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  }
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
  const [showScheduleModal, setShowScheduleModal] = useState(null) // report_type to schedule
  const [loadingHistory, setLoadingHistory] = useState(false)

  const locationId = user.activeLocation?.id

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true)
    const res = await fetch(`/api/schedule/reports?location_id=${locationId}`).then(r => r.json())
    setHistory(res.data || [])
    setLoadingHistory(false)
  }, [locationId])

  const fetchScheduled = useCallback(async () => {
    const res = await fetch(`/api/schedule/reports/scheduled?location_id=${locationId}`).then(r => r.json())
    setScheduledReports(res.data || [])
  }, [locationId])

  useEffect(() => {
    fetchHistory()
    fetchScheduled()
  }, [fetchHistory, fetchScheduled])

  async function generateReport() {
    if (!selectedReport) return
    setGenerating(true)
    setReportResult(null)

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

    const data = await res.json()
    setGenerating(false)

    if (data.success) {
      setReportResult(data.data)
      fetchHistory()
    } else {
      alert(data.error || 'Failed to generate report')
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
          <p className="text-sm text-un1t-light mt-1">{user.activeLocation?.name} — Schedule & labour reports</p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1.5 mb-6 text-xs">
        {[
          { key: 'generate', label: 'Generate Report', icon: Play },
          { key: 'history', label: `Report History (${history.length})`, icon: FileText },
          { key: 'scheduled', label: `Scheduled (${scheduledReports.filter(s => s.active).length})`, icon: Repeat },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors ${
              view === t.key ? 'bg-un1t-white text-un1t-black' : 'bg-un1t-dark border border-un1t-gray text-un1t-light hover:text-un1t-white'
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
          <div className="grid grid-cols-5 gap-2">
            {REPORT_TYPES.map(rt => {
              const Icon = rt.icon
              return (
                <button
                  key={rt.key}
                  onClick={() => { setSelectedReport(rt.key); setReportResult(null) }}
                  className={`flex flex-col items-center gap-2 p-4 rounded-lg border text-xs transition-colors ${
                    selectedReport === rt.key
                      ? 'border-un1t-white/40 bg-un1t-gray/30 text-un1t-white'
                      : 'border-un1t-gray bg-un1t-dark text-un1t-light hover:border-white/20 hover:text-un1t-white'
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
              <div className="text-sm text-un1t-light">
                {REPORT_TYPES.find(r => r.key === selectedReport)?.description}
              </div>

              {/* Date range + generate */}
              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs text-un1t-light mb-1">Start Date</label>
                  <input
                    type="date"
                    value={periodStart}
                    onChange={e => setPeriodStart(e.target.value)}
                    className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-un1t-light mb-1">End Date</label>
                  <input
                    type="date"
                    value={periodEnd}
                    onChange={e => setPeriodEnd(e.target.value)}
                    className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
                  />
                </div>
                <button
                  onClick={generateReport}
                  disabled={generating}
                  className="flex items-center gap-1.5 px-4 py-2 bg-un1t-white text-un1t-black text-sm font-medium rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
                >
                  <Play size={14} /> {generating ? 'Generating...' : 'Generate'}
                </button>
                <button
                  onClick={() => setShowScheduleModal(selectedReport)}
                  className="flex items-center gap-1.5 px-4 py-2 border border-un1t-gray text-sm text-un1t-light hover:text-un1t-white rounded-md transition-colors"
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
                <div className="grid grid-cols-4 gap-3">
                  {Object.entries(reportResult.summary).map(([key, val]) => (
                    <div key={key} className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
                      <div className="text-xs text-un1t-light uppercase tracking-wider">{key.replace(/_/g, ' ')}</div>
                      <div className="text-xl font-bold mt-1">
                        {key.includes('cost') || key === 'currency' ? (typeof val === 'number' ? formatCurrency(val) : val) : val}
                        {key.includes('hours') && <span className="text-sm text-un1t-light ml-1">hrs</span>}
                        {key.includes('utilisation') && <span className="text-sm text-un1t-light ml-1">%</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Report period */}
              <div className="text-xs text-un1t-light">
                Period: {new Date(reportResult.period_start + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })} – {new Date(reportResult.period_end + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}
              </div>

              {/* Staff data table */}
              {reportResult.report_data?.staff && (
                <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-un1t-gray text-xs text-un1t-light uppercase">
                        <th className="text-left px-4 py-3">Staff Member</th>
                        <th className="text-left px-4 py-3">Role</th>
                        <th className="text-left px-4 py-3">Type</th>
                        {selectedReport === 'staff_cost' && <th className="text-right px-4 py-3">Rate (€/hr)</th>}
                        <th className="text-right px-4 py-3">
                          {selectedReport === 'utilisation' ? 'Contracted' : 'Total Hours'}
                        </th>
                        {selectedReport === 'utilisation' && <th className="text-right px-4 py-3">Actual</th>}
                        {selectedReport === 'staff_cost' && <th className="text-right px-4 py-3">Total Cost</th>}
                        {selectedReport === 'utilisation' && <th className="text-right px-4 py-3">Utilisation</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {reportResult.report_data.staff.map((s, i) => (
                        <tr key={i} className="border-b border-un1t-gray/50 hover:bg-un1t-gray/30">
                          <td className="px-4 py-3 font-medium">{s.name}</td>
                          <td className="px-4 py-3 text-un1t-light capitalize">{s.role}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${s.employment_type === 'contractor' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                              {s.employment_type === 'contractor' ? 'Contractor' : 'FTE'}
                            </span>
                          </td>
                          {selectedReport === 'staff_cost' && (
                            <td className="px-4 py-3 text-right">{formatCurrency(s.hourly_rate)}</td>
                          )}
                          <td className="px-4 py-3 text-right">
                            {selectedReport === 'utilisation' ? s.contracted_hours : (s.total_hours || s.total || 0)}
                          </td>
                          {selectedReport === 'utilisation' && (
                            <td className="px-4 py-3 text-right">{s.actual_hours}</td>
                          )}
                          {selectedReport === 'staff_cost' && (
                            <td className="px-4 py-3 text-right font-medium">{formatCurrency(s.total_cost)}</td>
                          )}
                          {selectedReport === 'utilisation' && (
                            <td className="px-4 py-3 text-right">
                              <span className={`font-medium ${s.utilisation_pct > 100 ? 'text-red-400' : s.utilisation_pct >= 80 ? 'text-green-400' : 'text-amber-400'}`}>
                                {s.utilisation_pct}%
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
                <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-un1t-gray text-xs text-un1t-light uppercase">
                        <th className="text-left px-4 py-3">Staff Member</th>
                        <th className="text-right px-4 py-3">Holiday</th>
                        <th className="text-right px-4 py-3">Sick</th>
                        <th className="text-right px-4 py-3">Unavailable</th>
                        <th className="text-right px-4 py-3">Total Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(reportResult.report_data.by_staff).map(([name, data]) => (
                        <tr key={name} className="border-b border-un1t-gray/50 hover:bg-un1t-gray/30">
                          <td className="px-4 py-3 font-medium">{name}</td>
                          <td className="px-4 py-3 text-right text-green-400">{data.holiday || 0}</td>
                          <td className="px-4 py-3 text-right text-red-400">{data.sick || 0}</td>
                          <td className="px-4 py-3 text-right text-amber-400">{data.unavailable || 0}</td>
                          <td className="px-4 py-3 text-right font-medium">{data.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Roster coverage day view */}
              {reportResult.report_data?.days && (
                <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-un1t-gray text-xs text-un1t-light uppercase">
                        <th className="text-left px-4 py-3">Date</th>
                        <th className="text-right px-4 py-3">Shifts</th>
                        <th className="text-right px-4 py-3">Staff Working</th>
                        <th className="text-left px-4 py-3">Staff Off</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportResult.report_data.days.map(day => (
                        <tr key={day.date} className="border-b border-un1t-gray/50 hover:bg-un1t-gray/30">
                          <td className="px-4 py-3 font-medium">
                            {new Date(day.date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })}
                          </td>
                          <td className="px-4 py-3 text-right">{day.shifts_count}</td>
                          <td className="px-4 py-3 text-right">{day.staff_working}</td>
                          <td className="px-4 py-3 text-un1t-light text-xs">
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
            <div className="text-center py-16 text-un1t-light">Loading report history...</div>
          ) : history.length === 0 ? (
            <div className="text-center py-16">
              <FileText size={40} className="mx-auto text-un1t-mid mb-3" />
              <p className="text-un1t-light text-sm">No reports generated yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map(r => {
                const typeInfo = REPORT_TYPES.find(rt => rt.key === r.report_type) || { label: r.report_type, icon: FileText }
                const Icon = typeInfo.icon
                return (
                  <button
                    key={r.id}
                    onClick={() => viewHistoricReport(r)}
                    className="w-full bg-un1t-dark border border-un1t-gray rounded-lg p-4 flex items-center gap-4 text-left hover:border-white/20 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                      <Icon size={20} className="text-blue-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{r.report_name}</div>
                      <div className="text-xs text-un1t-light mt-0.5">
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
                          <div className="text-xs text-un1t-light">{r.summary.total_hours} hrs</div>
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
            <div className="text-center py-16">
              <Repeat size={40} className="mx-auto text-un1t-mid mb-3" />
              <p className="text-un1t-light text-sm">No scheduled reports</p>
              <p className="text-xs text-un1t-mid mt-1">Schedule reports from the Generate Report tab</p>
            </div>
          ) : (
            <div className="space-y-2">
              {scheduledReports.map(sr => {
                const typeInfo = REPORT_TYPES.find(rt => rt.key === sr.report_type) || { label: sr.report_type, icon: FileText }
                const Icon = typeInfo.icon
                return (
                  <div
                    key={sr.id}
                    className={`bg-un1t-dark border border-un1t-gray rounded-lg p-4 flex items-center gap-4 ${!sr.active ? 'opacity-50' : ''}`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
                      <Icon size={20} className="text-purple-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{sr.report_name}</div>
                      <div className="text-xs text-un1t-light mt-0.5 flex items-center gap-2">
                        <span className="capitalize">{sr.frequency}</span>
                        {sr.day_of_week != null && <span>· {DAY_NAMES[sr.day_of_week]}</span>}
                        {sr.day_of_month && <span>· Day {sr.day_of_month}</span>}
                        {sr.deliver_email && <span className="flex items-center gap-0.5"><Mail size={10} /> Email</span>}
                        {sr.deliver_notification && <span className="flex items-center gap-0.5"><Bell size={10} /> Notification</span>}
                      </div>
                    </div>
                    {sr.next_run_at && (
                      <div className="text-xs text-un1t-light text-right shrink-0">
                        Next: {new Date(sr.next_run_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
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
          reportType={showScheduleModal}
          locationId={locationId}
          onClose={() => setShowScheduleModal(null)}
          onSave={() => { setShowScheduleModal(null); fetchScheduled() }}
        />
      )}
    </div>
  )
}

function ScheduleReportModal({ reportType, locationId, onClose, onSave }) {
  const typeInfo = REPORT_TYPES.find(r => r.key === reportType)
  const [name, setName] = useState(typeInfo ? `Weekly ${typeInfo.label}` : '')
  const [frequency, setFrequency] = useState('weekly')
  const [dayOfWeek, setDayOfWeek] = useState(0) // Monday
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [deliverEmail, setDeliverEmail] = useState(false)
  const [emailRecipients, setEmailRecipients] = useState('')
  const [deliverNotification, setDeliverNotification] = useState(true)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/schedule/reports/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_type: reportType,
        report_name: name,
        frequency,
        day_of_week: frequency === 'weekly' || frequency === 'fortnightly' ? dayOfWeek : null,
        day_of_month: frequency === 'monthly' ? dayOfMonth : null,
        deliver_email: deliverEmail,
        email_recipients: deliverEmail ? emailRecipients.split(',').map(e => e.trim()).filter(Boolean) : [],
        deliver_notification: deliverNotification,
        location_id: locationId,
      }),
    })
    const data = await res.json()
    setSaving(false)
    if (data.success) onSave()
    else alert(data.error || 'Failed to schedule report')
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Schedule Recurring Report</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><Plus size={18} className="rotate-45" /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-un1t-light mb-1">Report Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </div>

          <div>
            <label className="block text-xs text-un1t-light mb-1">Frequency</label>
            <select
              value={frequency}
              onChange={e => setFrequency(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            >
              {FREQ_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>

          {(frequency === 'weekly' || frequency === 'fortnightly') && (
            <div>
              <label className="block text-xs text-un1t-light mb-1">Day of Week</label>
              <select
                value={dayOfWeek}
                onChange={e => setDayOfWeek(Number(e.target.value))}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              >
                {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}

          {frequency === 'monthly' && (
            <div>
              <label className="block text-xs text-un1t-light mb-1">Day of Month</label>
              <input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={e => setDayOfMonth(Number(e.target.value))}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
            </div>
          )}

          <div className="space-y-3">
            <label className="block text-xs text-un1t-light">Delivery</label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={deliverNotification} onChange={e => setDeliverNotification(e.target.checked)} className="rounded" />
              <span className="text-sm flex items-center gap-1.5"><Bell size={14} /> In-app notification</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={deliverEmail} onChange={e => setDeliverEmail(e.target.checked)} className="rounded" />
              <span className="text-sm flex items-center gap-1.5"><Mail size={14} /> Email (PDF)</span>
            </label>
            {deliverEmail && (
              <div>
                <label className="block text-xs text-un1t-light mb-1">Recipients (comma-separated)</label>
                <input
                  type="text"
                  value={emailRecipients}
                  onChange={e => setEmailRecipients(e.target.value)}
                  placeholder="manager@un1t.ie, owner@un1t.ie"
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
                />
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={!name || saving}
          className="w-full mt-5 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Create Schedule'}
        </button>
      </div>
    </div>
  )
}
