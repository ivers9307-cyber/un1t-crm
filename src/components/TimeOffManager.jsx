'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { CalendarOff, Plus, Check, X, Palmtree, ThermometerSun, Ban } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'

const TYPE_CONFIG = {
  holiday:     { label: 'Holiday',     color: '#22C55E', bg: '#22C55E20', icon: Palmtree },
  sick:        { label: 'Sick Leave',  color: '#EF4444', bg: '#EF444420', icon: ThermometerSun },
  unavailable: { label: 'Unavailable', color: '#F59E0B', bg: '#F59E0B20', icon: Ban },
}

const STATUS_STYLES = {
  pending:   'bg-yellow-500/20 text-yellow-400',
  approved:  'bg-green-500/20 text-green-400',
  rejected:  'bg-red-500/20 text-red-400',
  cancelled: 'bg-un1t-gray/30 text-un1t-mid',
}

export default function TimeOffManager({ user }) {
  // BOOKKEEPER-APPROVALS-FIX — `?focus=<id>` arrives when the user
  // drilled in from /approvals. Default to the 'team' tab (the
  // request being approved belongs to someone else, not the
  // viewer) and 'pending' filter (the only status that needs
  // action). Otherwise we'd land on 'my' + 'all' and they'd see
  // their own holidays instead of the request they clicked.
  const searchParams = useSearchParams()
  const focusId = searchParams?.get('focus') || null
  const isManager = MANAGER_ROLES.includes(user.role)
  const hasFocus = !!focusId && isManager

  const [requests, setRequests] = useState([])
  const [allowance, setAllowance] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [filter, setFilter] = useState(hasFocus ? 'pending' : 'all') // 'all', 'pending', 'approved'
  const [tab, setTab] = useState(hasFocus ? 'team' : 'my') // 'my' or 'team' (team only for managers)
  // Ref-map of request id → DOM node so we can scroll the focused
  // row into view once it lands in the result set.
  const rowRefs = useRef(new Map())
  const focusScrolled = useRef(false)

  const locationId = user.activeLocation?.id

  const fetchData = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (locationId) params.set('location_id', locationId)
    if (filter !== 'all') params.set('status', filter)
    if (tab === 'my') params.set('profile_id', user.id)

    const [reqRes, allowRes] = await Promise.all([
      fetch(`/api/schedule/time-off?${params}`).then(r => r.json()),
      fetch(`/api/schedule/allowances?profile_id=${user.id}&year=${new Date().getFullYear()}`).then(r => r.json()),
    ])

    setRequests(reqRes.data || [])
    setAllowance(allowRes.data || null)
    setLoading(false)
  }, [locationId, filter, tab, user.id])

  useEffect(() => { fetchData() }, [fetchData])

  // BOOKKEEPER-APPROVALS-FIX — after data lands, two things:
  //   1. If we expected the focused row on this tab but it isn't
  //      there, flip the tab once and re-fetch (covers the rare
  //      case where the user clicked their OWN pending request in
  //      /approvals — initial guess of 'team' is wrong).
  //   2. Once the focused row IS in the result set, scroll it
  //      into view + highlight it. Only fires once so subsequent
  //      re-fetches don't yank the scroll position.
  const fallbackTried = useRef(false)
  useEffect(() => {
    if (!focusId || loading) return
    const inResults = requests.some((r) => r.id === focusId)
    if (!inResults && !fallbackTried.current) {
      fallbackTried.current = true
      // Initial guess (team) was wrong — try 'my'. Also broaden
      // filter so 'pending' isn't excluding it.
      setTab((t) => (t === 'team' ? 'my' : 'team'))
      setFilter('all')
      return
    }
    if (focusScrolled.current) return
    const node = rowRefs.current.get(focusId)
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      focusScrolled.current = true
    }
  }, [focusId, loading, requests])

  async function handleApprove(id) {
    const res = await fetch(`/api/schedule/time-off/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to approve')
  }

  async function handleReject(id, note) {
    const reviewNote = note || prompt('Reason for rejection (optional):')
    const res = await fetch(`/api/schedule/time-off/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', review_note: reviewNote || null }),
    })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to reject')
  }

  async function handleCancel(id) {
    if (!confirm('Cancel this time-off request?')) return
    const res = await fetch(`/api/schedule/time-off/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to cancel')
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Time Off</h2>
          <p className="text-sm text-un1t-light mt-1">
            {user.activeLocation?.name} — Holiday & leave management
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-un1t-white text-un1t-black font-medium hover:bg-un1t-accent transition-colors"
        >
          <Plus size={16} /> Request Time Off
        </button>
      </div>

      {/* Allowance Card */}
      {allowance && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <div className="text-xs text-un1t-light uppercase tracking-wider">Total Allowance</div>
            <div className="text-2xl font-bold mt-1">{allowance.total_days} <span className="text-sm text-un1t-light">days</span></div>
          </div>
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <div className="text-xs text-un1t-light uppercase tracking-wider">Used</div>
            <div className="text-2xl font-bold mt-1 text-red-400">{allowance.used_days} <span className="text-sm text-un1t-light">days</span></div>
          </div>
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <div className="text-xs text-un1t-light uppercase tracking-wider">Carried Over</div>
            <div className="text-2xl font-bold mt-1 text-blue-400">{allowance.carried_over} <span className="text-sm text-un1t-light">days</span></div>
          </div>
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
            <div className="text-xs text-un1t-light uppercase tracking-wider">Remaining</div>
            <div className="text-2xl font-bold mt-1 text-green-400">{allowance.remaining} <span className="text-sm text-un1t-light">days</span></div>
          </div>
        </div>
      )}

      {/* Tabs & Filters */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden text-xs">
          <button
            onClick={() => setTab('my')}
            className={`px-3 py-2 transition-colors ${tab === 'my' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
          >
            My Requests
          </button>
          {isManager && (
            <button
              onClick={() => setTab('team')}
              className={`px-3 py-2 transition-colors ${tab === 'team' ? 'bg-un1t-white text-un1t-black' : 'text-un1t-light hover:text-un1t-white'}`}
            >
              Team Requests
            </button>
          )}
        </div>

        <div className="flex gap-1.5 text-xs">
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full transition-colors capitalize ${filter === f ? 'bg-un1t-white text-un1t-black' : 'bg-un1t-dark border border-un1t-gray text-un1t-light hover:text-un1t-white'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Requests List */}
      {loading ? (
        <div className="text-center py-16 text-un1t-light">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16">
          <CalendarOff size={40} className="mx-auto text-un1t-mid mb-3" />
          <p className="text-un1t-light text-sm">No time-off requests found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map(req => {
            const typeConf = TYPE_CONFIG[req.type] || TYPE_CONFIG.unavailable
            const TypeIcon = typeConf.icon
            const isOwn = req.profile_id === user.id
            const canApprove = isManager && req.status === 'pending' && !isOwn
            const canCancel = isOwn && req.status === 'pending'

            const isFocused = req.id === focusId
            return (
              <div
                key={req.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(req.id, node)
                  else rowRefs.current.delete(req.id)
                }}
                className={`bg-un1t-dark border rounded-lg p-4 flex items-center gap-4 transition-colors ${
                  isFocused
                    ? 'border-un1t-white ring-2 ring-un1t-white/40'
                    : 'border-un1t-gray'
                }`}
              >
                {/* Type icon */}
                <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: typeConf.bg }}>
                  <TypeIcon size={20} style={{ color: typeConf.color }} />
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {tab === 'team' && (
                      <span className="font-semibold text-sm">{req.profiles?.full_name}</span>
                    )}
                    <span className="text-sm font-medium" style={{ color: typeConf.color }}>{typeConf.label}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${STATUS_STYLES[req.status]}`}>
                      {req.status}
                    </span>
                  </div>
                  <div className="text-xs text-un1t-light mt-1 flex items-center gap-3">
                    <span>
                      {new Date(req.start_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}
                      {req.start_date !== req.end_date && ` – ${new Date(req.end_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}`}
                    </span>
                    <span>{req.total_days} day{req.total_days !== 1 ? 's' : ''}</span>
                    {req.reason && <span className="text-un1t-mid truncate max-w-[200px]" title={req.reason}>{req.reason}</span>}
                  </div>
                  {req.review_note && (
                    <div className="text-xs text-un1t-mid mt-1 italic">
                      Note: {req.review_note} {req.reviewer && `— ${req.reviewer.full_name}`}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {canApprove && (
                    <>
                      <button
                        onClick={() => handleApprove(req.id)}
                        className="p-2 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors"
                        title="Approve"
                      >
                        <Check size={16} />
                      </button>
                      <button
                        onClick={() => handleReject(req.id)}
                        className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                        title="Reject"
                      >
                        <X size={16} />
                      </button>
                    </>
                  )}
                  {canCancel && (
                    <button
                      onClick={() => handleCancel(req.id)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-un1t-gray text-un1t-light hover:text-red-400 hover:border-red-400/30 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Request Form Modal */}
      {showForm && (
        <TimeOffFormModal
          user={user}
          allowance={allowance}
          onClose={() => setShowForm(false)}
          onSubmit={() => { setShowForm(false); fetchData() }}
        />
      )}
    </div>
  )
}

function TimeOffFormModal({ user, allowance, onClose, onSubmit }) {
  const [type, setType] = useState('holiday')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const totalDays = startDate && endDate
    ? Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1)
    : 0

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSaving(true)

    const res = await fetch('/api/schedule/time-off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        start_date: startDate,
        end_date: endDate,
        reason: reason || null,
        location_id: user.activeLocation?.id,
      }),
    })

    const data = await res.json()
    setSaving(false)

    if (data.success) {
      onSubmit()
    } else {
      setError(data.error || 'Failed to submit request')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Request Time Off</h3>
          <button onClick={onClose} className="text-un1t-light hover:text-un1t-white"><X size={18} /></button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type selection */}
          <div>
            <label className="block text-xs text-un1t-light mb-2">Type</label>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(TYPE_CONFIG).map(([key, conf]) => {
                const Icon = conf.icon
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setType(key)}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-xs transition-colors ${
                      type === key
                        ? 'border-un1t-white/40 bg-un1t-gray/30'
                        : 'border-un1t-gray hover:border-white/20'
                    }`}
                  >
                    <Icon size={18} style={{ color: conf.color }} />
                    <span>{conf.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-un1t-light mb-1">Start Date *</label>
              <input
                type="date"
                required
                value={startDate}
                onChange={e => {
                  setStartDate(e.target.value)
                  if (!endDate || e.target.value > endDate) setEndDate(e.target.value)
                }}
                min={new Date().toISOString().split('T')[0]}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
            </div>
            <div>
              <label className="block text-xs text-un1t-light mb-1">End Date *</label>
              <input
                type="date"
                required
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                min={startDate || new Date().toISOString().split('T')[0]}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
            </div>
          </div>

          {totalDays > 0 && (
            <div className="text-sm text-un1t-light">
              {totalDays} day{totalDays !== 1 ? 's' : ''} requested
              {type === 'holiday' && allowance && (
                <span className="ml-2">
                  · {allowance.remaining} remaining
                  {totalDays > allowance.remaining && (
                    <span className="text-red-400 ml-1">(exceeds balance)</span>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="block text-xs text-un1t-light mb-1">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Family holiday, doctor's appointment..."
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white resize-none"
            />
          </div>

          <button
            type="submit"
            disabled={!startDate || !endDate || saving}
            className="w-full bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            {saving ? 'Submitting...' : 'Submit Request'}
          </button>
          <p className="text-xs text-un1t-mid text-center">
            Your request will be reviewed by a manager
          </p>
        </form>
      </div>
    </div>
  )
}
