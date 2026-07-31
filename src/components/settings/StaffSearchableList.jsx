'use client'

// Searchable team-members list. Pulled out of the /settings page in
// SETTINGS.4 because the inline table was dominating the page and an
// operator typically wants to find ONE person, not browse the roster.
// Plain client-side filter over a small dataset (today ~tens of rows;
// scales fine to hundreds before we'd need server-side pagination).

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, X } from 'lucide-react'

const ROLE_COLORS = {
  master: 'bg-amber-500/20 text-amber-700',
  owner: 'bg-purple-500/20 text-purple-700',
  manager: 'bg-blue-500/20 text-blue-700',
  head_coach: 'bg-emerald-500/20 text-emerald-700',
  staff: 'bg-gray-500/20 text-gray-700',
}

const ROLE_LABELS = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

// Short relative age for the Device cell — "today" / "6d" / "3mo".
// Reads the clock at render time only for display; the outdated/no-app
// DECISION is made server-side in @/lib/staff-devices and arrives as a
// verdict, so the two can never drift.
function fmtAge(iso) {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return 'never'
  const d = Math.floor(ms / 86400000)
  if (d < 1) return 'today'
  if (d < 30) return `${d}d`
  return `${Math.floor(d / 30)}mo`
}

// `user` is no longer read inside this component — canEditFns is
// pre-computed server-side and passed in keyed by staff id — but
// kept on the prop list as a forward-compat hook in case future
// row-level behaviour wants the caller's role.

export default function StaffSearchableList({ staff, user: _user, canEditFns, verdictsById = {}, permissionsById = {}, targetVersion = null }) {
  const [query, setQuery] = useState('')
  // 'all' | 'active' | 'inactive' | 'needs_update'
  const [statusFilter, setStatusFilter] = useState('all')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return staff.filter(s => {
      if (statusFilter === 'active' && !s.active) return false
      if (statusFilter === 'inactive' && s.active) return false
      if (statusFilter === 'needs_update') {
        const kind = verdictsById[s.id]?.kind
        if (kind !== 'outdated' && kind !== 'no_device') return false
      }
      if (!q) return true
      const locationsLabel = (s.profile_locations || [])
        .map(pl => pl.locations?.name)
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return (
        (s.full_name || '').toLowerCase().includes(q)
        || (s.email || '').toLowerCase().includes(q)
        || (s.role || '').toLowerCase().includes(q)
        || (ROLE_LABELS[s.role] || '').toLowerCase().includes(q)
        || locationsLabel.includes(q)
      )
    })
  }, [staff, query, statusFilter, verdictsById])

  return (
    <div className="space-y-4">
      {/* Search + status filter row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-un1t-subtle pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name, email, role, or location…"
            className="w-full pl-9 pr-9 py-2 bg-un1t-bg border border-un1t-border rounded-md text-sm text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-un1t-subtle hover:text-un1t-text p-1"
              title="Clear"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="inline-flex border border-un1t-border rounded-md overflow-hidden">
          {[
            { key: 'all', label: 'All' },
            { key: 'active', label: 'Active' },
            { key: 'inactive', label: 'Inactive' },
            { key: 'needs_update', label: 'Needs update' },
          ].map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              className={`text-xs px-3 py-1.5 ${
                statusFilter === key ? 'bg-un1t-border text-un1t-text' : 'text-un1t-subtle hover:bg-un1t-border/30'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="text-xs text-un1t-subtle">
          {filtered.length} of {staff.length}
        </div>
      </div>

      <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-un1t-border text-un1t-subtle text-xs uppercase tracking-wider">
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Role</th>
              <th className="text-left p-3">Locations</th>
              <th className="text-left p-3" title={targetVersion ? `Latest reported version: ${targetVersion}` : undefined}>Device</th>
              <th className="text-left p-3">Status</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-un1t-border">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-sm text-un1t-subtle">
                  {staff.length === 0 ? 'No team members yet.' : 'No matches for that search.'}
                </td>
              </tr>
            )}
            {filtered.map(s => {
              const canEdit = canEditFns[s.id]
              return (
                <tr key={s.id} className="hover:bg-un1t-border/20 transition-colors">
                  <td className="p-3 font-medium">{s.full_name}</td>
                  <td className="p-3 text-un1t-subtle">{s.email}</td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${ROLE_COLORS[s.role] || ROLE_COLORS.staff}`}>
                      {ROLE_LABELS[s.role] || s.role}
                    </span>
                  </td>
                  <td className="p-3 text-un1t-subtle text-xs">
                    {(s.profile_locations || []).map(pl => pl.locations?.name).filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="p-3">
                    <DeviceCell verdict={verdictsById[s.id]} permission={permissionsById[s.id]} />
                  </td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${s.active ? 'bg-green-500/20 text-green-700' : 'bg-red-500/20 text-red-700'}`}>
                      {s.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-3">
                    {canEdit ? (
                      <Link
                        href={`/settings/staff/${s.id}`}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        Edit
                      </Link>
                    ) : (
                      <span
                        className="text-xs text-un1t-muted"
                        title="Master only — owners can't edit themselves or other owners"
                      >
                        Locked
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Current device's version + how long since it was last seen, with an
// amber Outdated chip or a neutral No app chip. The verdict keys off the
// person's NEWEST device, so an old spare on a newer build can't hide a
// daily phone that never updated.
// STAFF-DEV.10 — background-location state for the CURRENT device.
// A null/unknown value renders as "—" and NEVER as "Denied": the column
// is null until a device reports (any client below 2.2.0 never does),
// and absence of data is not a denial — conflating the two is what makes
// the whole diagnostic useless.
const PERMISSION_CHIPS = {
  always: ['bg-emerald-500/10 text-emerald-700', 'Always'],
  when_in_use: ['bg-amber-500/10 text-amber-700', 'While using'],
  denied: ['bg-red-500/10 text-red-700', 'Denied'],
  undetermined: ['bg-gray-500/10 text-gray-700', 'Not asked'],
}

function PermissionChip({ value }) {
  const entry = PERMISSION_CHIPS[value]
  if (!entry) return <span className="text-un1t-muted">—</span>
  const [tone, label] = entry
  return <span className={`px-2 py-0.5 rounded-full ${tone}`}>{label}</span>
}

function DeviceCell({ verdict, permission }) {
  if (!verdict || verdict.kind === 'no_device') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-700">No app</span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-un1t-text">
        {verdict.version || 'unknown'} <span className="text-un1t-muted">· {fmtAge(verdict.lastSeenAt)}</span>
      </span>
      {verdict.kind === 'outdated' && (
        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700">Outdated</span>
      )}
      <PermissionChip value={permission} />
    </span>
  )
}
