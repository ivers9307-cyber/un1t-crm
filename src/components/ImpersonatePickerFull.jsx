'use client'

// Full picker used on the dedicated /settings/impersonate page.
// Server-rendered users list (no fetch needed). Adds a reason
// field that's saved on the audit row.

import { useState, useMemo } from 'react'
import { Search, Crown, ShieldCheck } from 'lucide-react'

const ROLE_BADGES = {
  master: { label: 'Master', cls: 'bg-amber-500/30 text-amber-300', icon: Crown },
  owner: { label: 'Owner', cls: 'bg-purple-500/20 text-purple-300', icon: ShieldCheck },
  manager: { label: 'Manager', cls: 'bg-blue-500/20 text-blue-300' },
  head_coach: { label: 'Head Coach', cls: 'bg-emerald-500/20 text-emerald-300' },
  staff: { label: 'Staff', cls: 'bg-gray-500/20 text-gray-300' },
}

const ROLE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'master', label: 'Master' },
  { key: 'owner', label: 'Owner' },
  { key: 'manager', label: 'Manager' },
  { key: 'head_coach', label: 'Head Coach' },
  { key: 'staff', label: 'Staff' },
]

export default function ImpersonatePickerFull({ users }) {
  const [filter, setFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [showInactive, setShowInactive] = useState(false)
  const [reason, setReason] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const filtered = useMemo(() => {
    return (users || []).filter(u => {
      if (!showInactive && !u.active) return false
      if (roleFilter !== 'all' && u.role !== roleFilter) return false
      if (!filter) return true
      const q = filter.toLowerCase()
      return (
        u.full_name?.toLowerCase().includes(q)
        || u.email?.toLowerCase().includes(q)
        || u.locations?.some(l => l?.toLowerCase().includes(q))
      )
    })
  }, [users, filter, roleFilter, showInactive])

  async function impersonate(targetId) {
    setBusyId(targetId); setError(null)
    try {
      const res = await fetch('/api/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_user_id: targetId, reason: reason || null }),
      })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Impersonation failed')
        setBusyId(null)
        return
      }
      window.location.assign('/')
    } catch (e) {
      setError(e.message)
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 mb-4 space-y-3">
        <div className="flex items-center gap-2 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2">
          <Search size={14} className="text-un1t-light" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search name / email / location…"
            className="flex-1 bg-transparent text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-un1t-light mr-1">Role:</span>
          {ROLE_FILTERS.map(r => (
            <button
              key={r.key}
              onClick={() => setRoleFilter(r.key)}
              className={`text-xs px-2 py-1 rounded-md ${roleFilter === r.key ? 'bg-un1t-white text-un1t-black' : 'bg-un1t-gray/40 text-un1t-light hover:bg-un1t-gray'}`}
            >
              {r.label}
            </button>
          ))}
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-un1t-light cursor-pointer">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
        <div>
          <label className="block text-xs text-un1t-light mb-1">Reason (optional, saved to audit log)</label>
          <input
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. Investigating Sarah&rsquo;s schedule access bug"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-light"
          />
        </div>
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2">{error}</div>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-un1t-light">No users match.</p>
      ) : (
        <div className="bg-un1t-dark border border-un1t-gray rounded-2xl overflow-hidden divide-y divide-un1t-gray">
          {filtered.map(u => {
            const badge = ROLE_BADGES[u.role] || { label: u.role, cls: 'bg-gray-500/20 text-gray-300' }
            const BadgeIcon = badge.icon
            return (
              <div key={u.id} className="flex items-center gap-3 p-3 hover:bg-un1t-gray/20">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-un1t-white truncate">{u.full_name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls} inline-flex items-center gap-1`}>
                      {BadgeIcon && <BadgeIcon size={9} />}
                      {badge.label}
                    </span>
                    {!u.active && <span className="text-[10px] text-un1t-mid">inactive</span>}
                  </div>
                  <div className="text-xs text-un1t-light truncate">
                    {u.email}
                    {u.locations?.length > 0 && <> · {u.locations.join(', ')}</>}
                  </div>
                </div>
                <button
                  onClick={() => impersonate(u.id)}
                  disabled={busyId === u.id}
                  className="text-xs font-semibold bg-amber-500 text-un1t-black px-3 py-1.5 rounded-md hover:bg-amber-400 disabled:opacity-50"
                >
                  {busyId === u.id ? 'Switching…' : 'View as'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
