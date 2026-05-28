'use client'

// Sidebar dropdown for masters: pick a user to impersonate. Lazy-
// loads the full users list on first open (cached for the lifetime
// of this component instance — re-mount = re-fetch). Fast filter
// as you type.

import { useEffect, useRef, useState } from 'react'
import { UserCog, Search, ChevronDown, Crown, ShieldCheck } from 'lucide-react'

const ROLE_BADGES = {
  master: { label: 'Master', cls: 'bg-amber-500/30 text-amber-300', icon: Crown },
  owner: { label: 'Owner', cls: 'bg-purple-500/20 text-purple-300', icon: ShieldCheck },
  manager: { label: 'Manager', cls: 'bg-blue-500/20 text-blue-300' },
  head_coach: { label: 'Head Coach', cls: 'bg-emerald-500/20 text-emerald-300' },
  staff: { label: 'Staff', cls: 'bg-gray-500/20 text-gray-300' },
}

export default function ImpersonatePicker() {
  const [open, setOpen] = useState(false)
  const [users, setUsers] = useState(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const ref = useRef(null)

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Lazy load on first open.
  useEffect(() => {
    if (!open || users) return
    setLoading(true); setError(null)
    fetch('/api/impersonate/users')
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || 'Failed to load')
        setUsers(j.users || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, users])

  async function impersonate(targetId) {
    setBusyId(targetId); setError(null)
    try {
      const res = await fetch('/api/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_user_id: targetId }),
      })
      const j = await res.json()
      if (!j.success) {
        setError(j.error || 'Impersonation failed')
        setBusyId(null)
        return
      }
      // Hard reload — every server component must re-fetch
      // getCurrentUser with the new cookie.
      window.location.assign('/')
    } catch (e) {
      setError(e.message)
      setBusyId(null)
    }
  }

  const filtered = (users || []).filter(u => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      u.full_name?.toLowerCase().includes(q)
      || u.email?.toLowerCase().includes(q)
      || u.role?.toLowerCase().includes(q)
      || u.locations?.some(l => l?.toLowerCase().includes(q))
    )
  })

  return (
    <div className="px-2 py-1 relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-amber-400 hover:bg-amber-500/10 rounded-md border border-amber-500/30"
      >
        <span className="flex items-center gap-2">
          <UserCog size={14} /> View as user
        </span>
        <ChevronDown size={14} className={open ? 'rotate-180 transition' : 'transition'} />
      </button>

      {open && (
        // Anchored ABOVE the trigger because the picker lives at the
        // bottom of the sidebar — opening downward gets clipped by
        // the viewport. bottom-full + mb-1 puts it directly above
        // the button; max-h-[60vh] + overflow-auto on the inner
        // list keeps it scrollable when the user list is long.
        <div className="absolute left-2 right-2 bottom-full mb-1 bg-un1t-surface border border-un1t-border rounded-lg shadow-xl z-50 max-h-[60vh] flex flex-col">
          <div className="p-2 border-b border-un1t-border">
            <div className="flex items-center gap-2 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1">
              <Search size={12} className="text-un1t-subtle" />
              <input
                autoFocus
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search name / email / role…"
                className="flex-1 bg-transparent text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none"
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {loading && <p className="p-3 text-xs text-un1t-subtle">Loading…</p>}
            {error && <p className="p-3 text-xs text-red-400">{error}</p>}
            {!loading && !error && filtered.length === 0 && (
              <p className="p-3 text-xs text-un1t-subtle">No users match.</p>
            )}
            {filtered.map(u => {
              const badge = ROLE_BADGES[u.role] || { label: u.role, cls: 'bg-gray-500/20 text-gray-300' }
              const BadgeIcon = badge.icon
              return (
                <button
                  key={u.id}
                  onClick={() => impersonate(u.id)}
                  disabled={busyId === u.id}
                  className="w-full text-left px-3 py-2 hover:bg-un1t-border/40 disabled:opacity-50 border-b border-un1t-border/40 last:border-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-un1t-text truncate">
                      {u.full_name}
                      {!u.active && <span className="ml-2 text-[10px] text-un1t-muted">(inactive)</span>}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls} inline-flex items-center gap-1`}>
                      {BadgeIcon && <BadgeIcon size={9} />}
                      {badge.label}
                    </span>
                  </div>
                  <div className="text-[11px] text-un1t-subtle truncate">
                    {u.email}
                    {u.locations?.length > 0 && <> · {u.locations.join(', ')}</>}
                  </div>
                </button>
              )
            })}
          </div>
          <div className="p-2 border-t border-un1t-border text-[11px] text-un1t-muted text-center">
            <a href="/settings/impersonate" className="hover:text-un1t-text">Open full picker →</a>
          </div>
        </div>
      )}
    </div>
  )
}
