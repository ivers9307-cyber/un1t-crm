'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Copy, Send, Plus, Users, User, Clock, MapPin, X, ArrowLeftRight, CalendarOff, Palmtree, ThermometerSun, Ban, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { computeWeeklyCost } from '@/lib/payroll'
import { indexByDate } from '@/lib/bank-holidays'

const TIME_OFF_CONFIG = {
  holiday:     { label: 'Holiday',     color: '#22C55E', icon: Palmtree },
  sick:        { label: 'Sick',        color: '#EF4444', icon: ThermometerSun },
  unavailable: { label: 'Unavailable', color: '#F59E0B', icon: Ban },
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const canManage = (role) => ['owner', 'manager', 'head_coach'].includes(role)

function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function formatDate(date) {
  return date.toISOString().split('T')[0]
}

function addDays(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

export default function ScheduleCalendar({ user }) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))
  const [shifts, setShifts] = useState([])
  const [templates, setTemplates] = useState([])
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('all') // 'my' or 'all'
  const [showAddModal, setShowAddModal] = useState(null) // { date, dayIndex }
  const [publishing, setPublishing] = useState(false)
  const [copying, setCopying] = useState(false)
  const [swapModal, setSwapModal] = useState(null) // shift to swap
  const [timeOff, setTimeOff] = useState([]) // approved time-off for the week
  const [holidays, setHolidays] = useState([]) // merged static + custom holidays for the week

  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)

  const weekEnd = addDays(weekStart, 6)
  const weekLabel = `${weekStart.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })} – ${weekEnd.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}`

  const fetchData = useCallback(async () => {
    if (!locationId) return
    setLoading(true)

    const start = formatDate(weekStart)
    const end = formatDate(addDays(weekStart, 6))

    const [shiftsRes, templatesRes, staffRes, timeOffRes, holidaysRes] = await Promise.all([
      fetch(`/api/schedule/shifts?location_id=${locationId}&start_date=${start}&end_date=${end}`).then(r => r.json()),
      fetch(`/api/schedule/templates?location_id=${locationId}`).then(r => r.json()),
      fetch('/api/staff').then(r => r.json()),
      fetch(`/api/schedule/time-off?location_id=${locationId}&start_date=${start}&end_date=${end}&status=approved`).then(r => r.json()),
      fetch(`/api/locations/${locationId}/holidays?start=${start}&end=${end}`).then(r => r.json()),
    ])

    setShifts(shiftsRes.data || [])
    setTemplates((templatesRes.data || []).filter(t => t.active))
    setStaff(staffRes.data || [])
    setTimeOff(timeOffRes.data || [])
    setHolidays(holidaysRes.data || [])
    setLoading(false)
  }, [locationId, weekStart])

  useEffect(() => { fetchData() }, [fetchData])

  // Filter staff to those assigned to this location
  const locationStaff = staff.filter(s =>
    s.active && (s.profile_locations || []).some(pl => pl.location_id === locationId)
  )

  // Group shifts by day
  const shiftsByDay = DAY_LABELS.map((_, i) => {
    const date = formatDate(addDays(weekStart, i))
    const dayShifts = shifts.filter(s => s.shift_date === date)
    if (viewMode === 'my') {
      return dayShifts.filter(s => s.profile_id === user.id)
    }
    return dayShifts
  })

  // Count unpublished shifts
  const unpublishedCount = shifts.filter(s => !s.published).length

  async function handleAddShift(profileId, templateId, date) {
    try {
      const res = await fetch('/api/schedule/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId,
          profile_id: profileId,
          shift_template_id: templateId,
          shift_date: date,
        }),
      })
      const data = await res.json()
      if (data.success) {
        if (data.warnings && data.warnings.length > 0) {
          alert('Shift added with warning:\n\n' + data.warnings.join('\n'))
        }
        setShowAddModal(null)
        fetchData()
      } else {
        alert(data.error || 'Failed to add shift')
      }
    } catch (err) {
      alert('Failed to add shift: ' + err.message)
    }
  }

  async function handleDeleteShift(shiftId) {
    if (!confirm('Remove this shift?')) return
    await fetch(`/api/schedule/shifts/${shiftId}`, { method: 'DELETE' })
    fetchData()
  }

  async function handlePublish() {
    if (!confirm('Publish the roster for this week? Staff will be able to see their shifts.')) return
    setPublishing(true)
    await fetch('/api/schedule/shifts/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        start_date: formatDate(weekStart),
        end_date: formatDate(weekEnd),
        notify: true,
      }),
    })
    setPublishing(false)
    fetchData()
  }

  async function handleCopyWeek() {
    const prevWeekStart = addDays(weekStart, -7)
    if (!confirm(`Copy last week's roster (${formatDate(prevWeekStart)}) to this week?`)) return
    setCopying(true)
    const res = await fetch('/api/schedule/shifts/copy-week', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id: locationId,
        source_start: formatDate(prevWeekStart),
        target_start: formatDate(weekStart),
      }),
    })
    const data = await res.json()
    setCopying(false)
    if (data.success) fetchData()
    else alert(data.error || 'Failed to copy week')
  }

  async function handleSwapRequest(shiftId, reason) {
    const res = await fetch('/api/schedule/swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requester_shift_id: shiftId, reason }),
    })
    const data = await res.json()
    if (data.success) {
      setSwapModal(null)
      alert('Swap request submitted — waiting for manager approval')
    } else {
      alert(data.error || 'Failed to submit swap request')
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Schedule</h2>
          <p className="text-sm text-un1t-light mt-1">
            {user.activeLocation?.name} — Staff roster
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Time Off link */}
          <Link
            href="/schedule/time-off"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors"
          >
            <CalendarOff size={14} /> Time Off
          </Link>

          {/* View toggle */}
          <div className="flex bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden text-xs">
            <button
              onClick={() => setViewMode('my')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'my' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              <User size={14} /> My Shifts
            </button>
            <button
              onClick={() => setViewMode('all')}
              className={`flex items-center gap-1.5 px-3 py-2 transition-colors ${viewMode === 'all' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              <Users size={14} /> All Staff
            </button>
          </div>

          {isManager && (
            <>
              <button
                onClick={handleCopyWeek}
                disabled={copying}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30 transition-colors disabled:opacity-50"
              >
                <Copy size={14} /> {copying ? 'Copying...' : 'Copy Last Week'}
              </button>
              {unpublishedCount > 0 && (
                <button
                  onClick={handlePublish}
                  disabled={publishing}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                >
                  <Send size={14} /> {publishing ? 'Publishing...' : `Publish (${unpublishedCount})`}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Week Navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          className="p-2 rounded-lg hover:bg-un1t-gray/50 text-un1t-light hover:text-un1t-white transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="text-center">
          <span className="font-semibold">{weekLabel}</span>
          <button
            onClick={() => setWeekStart(getMonday(new Date()))}
            className="ml-3 text-xs text-blue-400 hover:text-blue-300"
          >
            Today
          </button>
        </div>
        <button
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          className="p-2 rounded-lg hover:bg-un1t-gray/50 text-un1t-light hover:text-un1t-white transition-colors"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      {/* Overtime warning panel — visible whenever any FTE in this week is at
          or above their contracted hours. Visible to managers (canManage). */}
      {!loading && canManage(user.role) && (() => {
        // Build per-staff cost summaries for the visible Mon-Sun week.
        // staff[] already holds the full profiles incl. HR fields; shifts[]
        // is the source of truth for hours actually scheduled.
        const summaries = locationStaff
          .filter(s => s.employment_type === 'fte' && (s.contracted_hours_per_week || 0) > 0)
          .map(s => {
            const own = shifts.filter(sh => sh.profile_id === s.id)
            const cost = computeWeeklyCost({ shifts: own, profile: s })
            return { staff: s, cost }
          })
          .filter(({ cost }) => cost.actual_hours > 0)

        const overOrAt = summaries.filter(({ cost }) =>
          cost.actual_hours >= cost.contracted_hours
        )
        if (overOrAt.length === 0) return null

        return (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-amber-400 font-medium text-sm mb-2">
              <AlertTriangle size={16} /> Weekly hours notice
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {overOrAt.map(({ staff: s, cost }) => {
                const isOver = cost.over_threshold
                return (
                  <div
                    key={s.id}
                    className={`text-xs rounded-md px-2.5 py-1.5 border ${isOver
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                      : 'border-un1t-gray bg-un1t-dark/40 text-un1t-light'
                    }`}
                  >
                    <span className="font-medium text-un1t-white">{s.full_name}</span>
                    {' — '}
                    <span>{cost.actual_hours.toFixed(1)}h / {cost.contracted_hours}h</span>
                    {isOver && (
                      <span className="ml-1 font-semibold">
                        +{cost.overtime_hours.toFixed(1)}h OT
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-[11px] text-un1t-mid mt-2">
              FTE staff scheduled at or above their contracted hours for {weekLabel}.
              Hours over contracted pay at the staff member&apos;s overtime rate (or regular rate if not set).
            </p>
          </div>
        )
      })()}

      {/* Calendar Grid */}
      {loading ? (
        <div className="text-center py-20 text-un1t-light">Loading roster...</div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {(() => {
            // Build a date → holiday lookup once per render so we don't scan
            // the holidays array per day.
            const holidayByDate = indexByDate(holidays)
            return DAY_LABELS.map((label, i) => {
              const date = addDays(weekStart, i)
              const dateStr = formatDate(date)
              const isToday = formatDate(new Date()) === dateStr
              const dayShifts = shiftsByDay[i]
              const holiday = holidayByDate.get(dateStr)

              // Today wins over holiday for the header colour; otherwise an
              // amber tint marks holidays at a glance.
              const headerCls = isToday
                ? 'bg-blue-600 text-white'
                : holiday
                  ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  : 'bg-un1t-dark text-un1t-light'

              return (
              <div key={i} className="min-h-[200px]">
                {/* Day header */}
                <div className={`text-center py-2 rounded-t-lg text-xs font-semibold ${headerCls}`} title={holiday?.name || undefined}>
                  <div>{label}</div>
                  <div className={`text-lg font-bold ${isToday ? 'text-white' : 'text-un1t-white'}`}>{date.getDate()}</div>
                  {holiday && (
                    <div className={`mt-0.5 text-[10px] font-medium leading-tight px-1 truncate ${isToday ? 'text-white/80' : 'text-amber-300'}`}>
                      {holiday.source === 'national' ? '🇮🇪 ' : '🏷 '}{holiday.name}
                    </div>
                  )}
                </div>

                {/* Shifts & Time Off */}
                <div className={`bg-un1t-dark/50 border border-un1t-gray border-t-0 rounded-b-lg p-1.5 space-y-1.5 min-h-[160px] ${holiday ? 'bg-amber-500/[0.04]' : ''}`}>
                  {/* Time-off bars */}
                  {timeOff
                    .filter(t => t.start_date <= dateStr && t.end_date >= dateStr)
                    .filter(t => viewMode === 'all' || t.profile_id === user.id)
                    .map(t => {
                      const conf = TIME_OFF_CONFIG[t.type] || TIME_OFF_CONFIG.unavailable
                      const Icon = conf.icon
                      return (
                        <div
                          key={`to-${t.id}`}
                          className="rounded-md px-2 py-1.5 text-xs flex items-center gap-1.5"
                          style={{ backgroundColor: conf.color + '18', borderLeft: `3px solid ${conf.color}` }}
                        >
                          <Icon size={12} style={{ color: conf.color }} />
                          <span className="font-medium truncate" style={{ color: conf.color }}>
                            {t.profiles?.full_name} — {conf.label}
                          </span>
                        </div>
                      )
                    })
                  }

                  {dayShifts.length === 0 && timeOff.filter(t => t.start_date <= dateStr && t.end_date >= dateStr).length === 0 && (
                    <div className="text-center py-6 text-xs text-un1t-mid">No shifts</div>
                  )}

                  {dayShifts.map(shift => {
                    const tmpl = shift.shift_templates || {}
                    const startTime = shift.start_time_override || tmpl.start_time
                    const endTime = shift.end_time_override || tmpl.end_time
                    const isMyShift = shift.profile_id === user.id

                    return (
                      <div
                        key={shift.id}
                        className={`rounded-md p-2 text-xs relative group ${isMyShift ? 'ring-1 ring-blue-400/50' : ''}`}
                        style={{ backgroundColor: (tmpl.color || '#3B82F6') + '20', borderLeft: `3px solid ${tmpl.color || '#3B82F6'}` }}
                      >
                        <div className="font-semibold truncate">{shift.profiles?.full_name || 'Unknown'}</div>
                        <div className="text-un1t-light mt-0.5 flex items-center gap-1">
                          <Clock size={10} />
                          {formatTime(startTime)}–{formatTime(endTime)}
                        </div>
                        {shift.role_label && (
                          <div className="text-un1t-light mt-0.5">{shift.role_label}</div>
                        )}
                        {shift.notes && (
                          <div className="text-un1t-mid mt-0.5 truncate" title={shift.notes}>{shift.notes}</div>
                        )}
                        {tmpl.name && (
                          <div className="mt-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ backgroundColor: (tmpl.color || '#3B82F6') + '30', color: tmpl.color || '#3B82F6' }}>
                            {tmpl.name}
                          </div>
                        )}
                        {!shift.published && (
                          <div className="absolute top-1 right-1 w-2 h-2 rounded-full bg-yellow-400" title="Unpublished" />
                        )}

                        {/* Actions (hover) */}
                        <div className="absolute top-1 right-1 hidden group-hover:flex gap-1">
                          {isMyShift && (
                            <button
                              onClick={() => setSwapModal(shift)}
                              className="p-1 rounded bg-un1t-dark/80 hover:bg-un1t-gray text-un1t-light hover:text-un1t-white"
                              title="Request swap"
                            >
                              <ArrowLeftRight size={12} />
                            </button>
                          )}
                          {isManager && (
                            <button
                              onClick={() => handleDeleteShift(shift.id)}
                              className="p-1 rounded bg-un1t-dark/80 hover:bg-red-500/30 text-un1t-light hover:text-red-400"
                              title="Remove shift"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}

                  {/* Add shift button */}
                  {isManager && (
                    <button
                      onClick={() => setShowAddModal({ date: dateStr, dayIndex: i })}
                      className="w-full py-2 rounded-md border border-dashed border-un1t-gray text-un1t-mid hover:text-un1t-white hover:border-un1t-white/30 text-xs transition-colors flex items-center justify-center gap-1"
                    >
                      <Plus size={12} /> Add
                    </button>
                  )}
                </div>
              </div>
              )
            })
          })()}
        </div>
      )}

      {/* Add Shift Modal */}
      {showAddModal && (
        <AddShiftModal
          date={showAddModal.date}
          templates={templates}
          staff={locationStaff}
          onAdd={handleAddShift}
          onClose={() => setShowAddModal(null)}
        />
      )}

      {/* Swap Request Modal */}
      {swapModal && (
        <SwapModal
          shift={swapModal}
          onSubmit={handleSwapRequest}
          onClose={() => setSwapModal(null)}
        />
      )}
    </div>
  )
}

function AddShiftModal({ date, templates, staff, onAdd, onClose }) {
  const [profileId, setProfileId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [saving, setSaving] = useState(false)

  const dayLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })

  async function handleClick() {
    if (!profileId || !templateId) return
    setSaving(true)
    await onAdd(profileId, templateId, date)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Add Shift — {dayLabel}</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-un1t-light mb-1">Staff Member *</label>
            <select value={profileId} onChange={e => setProfileId(e.target.value)} className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white">
              <option value="">Select staff...</option>
              {staff.map(s => (
                <option key={s.id} value={s.id}>{s.full_name} ({s.role})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-un1t-light mb-1">Shift *</label>
            <select value={templateId} onChange={e => setTemplateId(e.target.value)} className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white">
              <option value="">Select shift...</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({formatTime(t.start_time)}–{formatTime(t.end_time)})</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={handleClick}
          disabled={!profileId || !templateId || saving}
          className="w-full mt-4 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add Shift'}
        </button>
      </div>
    </div>
  )
}

function SwapModal({ shift, onSubmit, onClose }) {
  const [reason, setReason] = useState('')

  const tmpl = shift.shift_templates || {}

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Request Shift Swap</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>

        <div className="bg-black/30 rounded-lg p-3 mb-4 text-sm">
          <div className="font-medium">{tmpl.name} — {new Date(shift.shift_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <div className="text-un1t-light text-xs mt-1">
            {formatTime(shift.start_time_override || tmpl.start_time)}–{formatTime(shift.end_time_override || tmpl.end_time)}
            {shift.role_label && ` · ${shift.role_label}`}
          </div>
        </div>

        <div>
          <label className="block text-xs text-un1t-light mb-1">Reason (optional)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="Why do you need to swap this shift?"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white resize-none"
          />
        </div>

        <button
          onClick={() => onSubmit(shift.id, reason)}
          className="w-full mt-4 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors"
        >
          Submit Swap Request
        </button>
        <p className="text-xs text-un1t-mid mt-2 text-center">A manager will review your request</p>
      </div>
    </div>
  )
}
