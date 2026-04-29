'use client'

import { useState, useEffect, useCallback } from 'react'
import { Check, X, Palmtree, ThermometerSun, Ban, ArrowLeftRight, Clock, Inbox } from 'lucide-react'

const TIME_OFF_TYPE = {
  holiday:     { label: 'Holiday',     color: '#22C55E', icon: Palmtree },
  sick:        { label: 'Sick Leave',  color: '#EF4444', icon: ThermometerSun },
  unavailable: { label: 'Unavailable', color: '#F59E0B', icon: Ban },
}

export default function ScheduleApprovals({ user }) {
  const [timeOffRequests, setTimeOffRequests] = useState([])
  const [swapRequests, setSwapRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('pending') // 'pending', 'all'

  const locationId = user.activeLocation?.id

  const fetchData = useCallback(async () => {
    setLoading(true)
    const statusParam = filter === 'pending' ? '&status=pending' : ''

    const [toRes, swapRes] = await Promise.all([
      fetch(`/api/schedule/time-off?location_id=${locationId}${statusParam}`).then(r => r.json()),
      fetch(`/api/schedule/swaps?location_id=${locationId}${filter === 'pending' ? '&status=pending' : ''}`).then(r => r.json()),
    ])

    setTimeOffRequests(toRes.data || [])
    setSwapRequests(swapRes.data || [])
    setLoading(false)
  }, [locationId, filter])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleTimeOffAction(id, status, note) {
    const reviewNote = status === 'rejected' ? (note || prompt('Reason for rejection (optional):')) : null
    const res = await fetch(`/api/schedule/time-off/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, review_note: reviewNote || null }),
    })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to update')
  }

  async function handleSwapAction(id, status) {
    const res = await fetch(`/api/schedule/swaps/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const data = await res.json()
    if (data.success) fetchData()
    else alert(data.error || 'Failed to update')
  }

  const pendingTimeOff = timeOffRequests.filter(r => r.status === 'pending')
  const pendingSwaps = swapRequests.filter(r => r.status === 'pending')
  const totalPending = pendingTimeOff.length + pendingSwaps.length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Approvals</h2>
          <p className="text-sm text-un1t-light mt-1">
            {totalPending} pending request{totalPending !== 1 ? 's' : ''} · {user.activeLocation?.name}
          </p>
        </div>
        <div className="flex gap-1.5 text-xs">
          {['pending', 'all'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full transition-colors capitalize ${
                filter === f ? 'bg-white text-black' : 'bg-un1t-dark border border-un1t-gray text-un1t-light hover:text-white'
              }`}
            >
              {f === 'pending' ? 'Pending' : 'All Requests'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-un1t-light">Loading approvals...</div>
      ) : (timeOffRequests.length === 0 && swapRequests.length === 0) ? (
        <div className="text-center py-16">
          <Inbox size={40} className="mx-auto text-un1t-mid mb-3" />
          <p className="text-un1t-light text-sm">No {filter === 'pending' ? 'pending ' : ''}requests</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Time-Off Requests */}
          {timeOffRequests.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">
                Time Off Requests ({timeOffRequests.length})
              </h3>
              <div className="space-y-2">
                {timeOffRequests.map(req => {
                  const conf = TIME_OFF_TYPE[req.type] || TIME_OFF_TYPE.unavailable
                  const Icon = conf.icon
                  const isPending = req.status === 'pending'

                  return (
                    <div key={req.id} className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: conf.color + '20' }}>
                        <Icon size={20} style={{ color: conf.color }} />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{req.profiles?.full_name}</span>
                          <span className="text-sm" style={{ color: conf.color }}>{conf.label}</span>
                          {!isPending && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${
                              req.status === 'approved' ? 'bg-green-500/20 text-green-400' :
                              req.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
                              'bg-un1t-gray/30 text-un1t-mid'
                            }`}>
                              {req.status}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-un1t-light mt-1 flex items-center gap-3">
                          <span className="flex items-center gap-1">
                            <Clock size={10} />
                            {new Date(req.start_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}
                            {req.start_date !== req.end_date && ` – ${new Date(req.end_date + 'T00:00:00').toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}`}
                          </span>
                          <span>{req.total_days} day{Number(req.total_days) !== 1 ? 's' : ''}</span>
                          {req.reason && <span className="text-un1t-mid truncate max-w-[200px]">{req.reason}</span>}
                        </div>
                      </div>

                      {isPending && req.profile_id !== user.id && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleTimeOffAction(req.id, 'approved')}
                            className="p-2 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors"
                            title="Approve"
                          >
                            <Check size={16} />
                          </button>
                          <button
                            onClick={() => handleTimeOffAction(req.id, 'rejected')}
                            className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                            title="Reject"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Swap Requests */}
          {swapRequests.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">
                Shift Swap Requests ({swapRequests.length})
              </h3>
              <div className="space-y-2">
                {swapRequests.map(req => {
                  const isPending = req.status === 'pending'
                  const reqShift = req.requester_shift
                  const tmpl = reqShift?.shift_templates || {}

                  return (
                    <div key={req.id} className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                        <ArrowLeftRight size={20} className="text-blue-400" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">{req.requester?.full_name}</span>
                          <span className="text-sm text-blue-400">Swap Request</span>
                          {!isPending && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase ${
                              req.status === 'approved' ? 'bg-green-500/20 text-green-400' :
                              req.status === 'rejected' ? 'bg-red-500/20 text-red-400' :
                              'bg-un1t-gray/30 text-un1t-mid'
                            }`}>
                              {req.status}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-un1t-light mt-1 flex items-center gap-3">
                          <span>{tmpl.name} — {reqShift?.shift_date && new Date(reqShift.shift_date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                          {req.reason && <span className="text-un1t-mid truncate max-w-[200px]">{req.reason}</span>}
                        </div>
                      </div>

                      {isPending && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleSwapAction(req.id, 'approved')}
                            className="p-2 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors"
                            title="Approve"
                          >
                            <Check size={16} />
                          </button>
                          <button
                            onClick={() => handleSwapAction(req.id, 'rejected')}
                            className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                            title="Reject"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
