'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, ArrowLeftRight, Check, X, Clock, AlertCircle } from 'lucide-react'

const canManage = (role) => ['owner', 'manager', 'head_coach'].includes(role)

function formatTime(time) {
  if (!time) return ''
  const [h, m] = time.split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IE', {
    weekday: 'short', day: 'numeric', month: 'short'
  })
}

const statusColors = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  approved: 'bg-green-500/20 text-green-400',
  rejected: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-400',
}

export default function SwapRequestsManager({ user }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('pending')
  const locationId = user.activeLocation?.id
  const isManager = canManage(user.role)

  async function fetchRequests() {
    if (!locationId) return
    setLoading(true)
    const url = `/api/schedule/swaps?location_id=${locationId}${filter ? `&status=${filter}` : ''}`
    const res = await fetch(url)
    const data = await res.json()
    setRequests(data.data || [])
    setLoading(false)
  }

  useEffect(() => { fetchRequests() }, [locationId, filter])

  async function handleAction(id, status, note) {
    await fetch(`/api/schedule/swaps/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, review_note: note }),
    })
    fetchRequests()
  }

  return (
    <div>
      <Link href="/schedule" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-white mb-6">
        <ArrowLeft size={16} /> Back to Schedule
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Swap Requests</h2>
          <p className="text-sm text-un1t-light mt-1">Review and manage shift swap requests</p>
        </div>
        <div className="flex bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden text-xs">
          {['pending', 'approved', 'rejected', ''].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-2 transition-colors ${filter === s ? 'bg-white text-black' : 'text-un1t-light hover:text-white'}`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-un1t-light">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-12 text-center">
          <ArrowLeftRight size={40} className="mx-auto mb-4 text-un1t-light" />
          <h3 className="text-lg font-semibold mb-2">No swap requests</h3>
          <p className="text-sm text-un1t-light">
            {filter === 'pending' ? 'No pending requests to review' : 'No requests match this filter'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map(req => {
            const reqShift = req.requester_shift
            const reqTmpl = reqShift?.shift_templates || {}
            const tgtShift = req.target_shift
            const tgtTmpl = tgtShift?.shift_templates || {}

            return (
              <div key={req.id} className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {/* Requester info */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-semibold">{req.requester?.full_name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[req.status]}`}>{req.status}</span>
                    </div>

                    {/* Their shift */}
                    <div className="text-sm">
                      <span className="text-un1t-light">Wants to swap: </span>
                      <span className="font-medium" style={{ color: reqTmpl.color }}>
                        {reqTmpl.name}
                      </span>
                      {reqShift && (
                        <span className="text-un1t-light">
                          {' '} on {formatDate(reqShift.shift_date)} ({formatTime(reqShift.start_time_override || reqTmpl.start_time)}–{formatTime(reqShift.end_time_override || reqTmpl.end_time)})
                        </span>
                      )}
                    </div>

                    {/* Target shift if specified */}
                    {tgtShift && (
                      <div className="text-sm mt-1">
                        <span className="text-un1t-light">For: </span>
                        <span className="font-medium">{req.target?.full_name}'s</span>
                        <span className="font-medium" style={{ color: tgtTmpl.color }}> {tgtTmpl.name}</span>
                        <span className="text-un1t-light">
                          {' '} on {formatDate(tgtShift.shift_date)}
                        </span>
                      </div>
                    )}

                    {!tgtShift && (
                      <div className="text-sm mt-1 text-un1t-light flex items-center gap-1">
                        <AlertCircle size={12} /> Requesting to drop this shift (no swap)
                      </div>
                    )}

                    {req.reason && (
                      <div className="text-xs text-un1t-mid mt-2 italic">"{req.reason}"</div>
                    )}

                    {req.review_note && (
                      <div className="text-xs text-un1t-light mt-1">Manager note: {req.review_note}</div>
                    )}
                  </div>

                  {/* Actions */}
                  {isManager && req.status === 'pending' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button
                        onClick={() => handleAction(req.id, 'approved')}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-green-500/20 text-green-400 hover:bg-green-500/30 text-xs transition-colors"
                      >
                        <Check size={14} /> Approve
                      </button>
                      <button
                        onClick={() => {
                          const note = prompt('Reason for rejection (optional):')
                          handleAction(req.id, 'rejected', note)
                        }}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 text-xs transition-colors"
                      >
                        <X size={14} /> Reject
                      </button>
                    </div>
                  )}

                  {/* Staff can cancel their own pending requests */}
                  {!isManager && req.requester_id === user.id && req.status === 'pending' && (
                    <button
                      onClick={() => handleAction(req.id, 'cancelled')}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 text-xs transition-colors ml-4"
                    >
                      <X size={14} /> Cancel
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
