'use client'

// Master-only access view: every staff member × every location, with
// per-(user, location) role displayed in each cell. Locations grouped
// by organization (mig 079) so master can scan a single org's access
// posture at a glance.
//
// v1 is READ-ONLY — clicking a name jumps to /settings/staff/[id]
// for editing, reusing the existing StaffForm wizard. Inline editing
// of role assignments is the v2 follow-up; today the matrix is the
// canonical "who has what" view, and the staff editor is the canonical
// "change what they have" tool.
//
// A search input narrows users by name or email — the user list will
// scale faster than locations/orgs do, so name-search matters more
// than location filters for now.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Building2, Search, ShieldCheck } from 'lucide-react'

const ROLE_LABELS = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

// Light-theme-tuned status pills. Same -700 ramp as the rest of
// the codebase per the coding-conventions note in CLAUDE.md.
const ROLE_PILLS = {
  owner: 'bg-purple-500/15 text-purple-700',
  manager: 'bg-blue-500/15 text-blue-700',
  head_coach: 'bg-emerald-500/15 text-emerald-700',
  staff: 'bg-gray-500/15 text-gray-700',
}

function RoleCell({ role }) {
  if (!role) {
    return <span className="text-un1t-mid text-xs">—</span>
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${ROLE_PILLS[role] || ROLE_PILLS.staff}`}>
      {ROLE_LABELS[role] || role}
    </span>
  )
}

export default function AdminAccessMatrix({ organizations, locationsByOrg, staff }) {
  const [filter, setFilter] = useState('')

  const visibleStaff = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return staff
    return staff.filter(s =>
      (s.full_name || '').toLowerCase().includes(q) ||
      (s.email || '').toLowerCase().includes(q)
    )
  }, [staff, filter])

  // Build a quick {staffId → {locationId → role}} index so cell
  // lookup is O(1) per render. profile_locations is already loaded
  // on each staff row by the page server component.
  const rolesByStaffByLoc = useMemo(() => {
    const m = {}
    for (const s of staff) {
      m[s.id] = {}
      for (const link of (s.profile_locations || [])) {
        if (link?.location_id && link?.role) {
          m[s.id][link.location_id] = link.role
        }
      }
    }
    return m
  }, [staff])

  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
      <div className="mb-4 relative max-w-sm">
        <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-un1t-mid pointer-events-none" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or email…"
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-un1t-black border border-un1t-gray rounded-md text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
        />
      </div>

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-un1t-dark text-left p-2 font-medium text-un1t-light min-w-[200px]">
                User
              </th>
              {organizations.map(org => {
                const locs = locationsByOrg[org.id] || []
                if (locs.length === 0) return null
                return (
                  <th
                    key={`org-h-${org.id}`}
                    colSpan={locs.length}
                    className="px-2 py-1 text-center font-semibold text-un1t-light bg-un1t-gray/30 text-[11px] uppercase tracking-wider border-l border-un1t-gray"
                  >
                    <div className="inline-flex items-center gap-1.5">
                      <Building2 size={11} /> {org.name}
                    </div>
                  </th>
                )
              })}
              <th className="px-2 py-1 text-center font-medium text-un1t-light w-[80px] border-l border-un1t-gray">
                Master
              </th>
            </tr>
            <tr>
              <th className="sticky left-0 z-10 bg-un1t-dark p-2"></th>
              {organizations.map(org => (
                (locationsByOrg[org.id] || []).map(loc => (
                  <th
                    key={loc.id}
                    className="px-2 py-1.5 text-left font-medium text-un1t-light whitespace-nowrap text-[11px]"
                  >
                    {loc.name}
                  </th>
                ))
              ))}
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {visibleStaff.length === 0 && (
              <tr>
                <td colSpan={99} className="p-6 text-center text-un1t-light text-sm">
                  No users match &ldquo;{filter}&rdquo;.
                </td>
              </tr>
            )}
            {visibleStaff.map(s => (
              <tr key={s.id} className="hover:bg-un1t-gray/10 group">
                <td className="sticky left-0 z-10 bg-un1t-dark px-2 py-1.5">
                  <Link
                    href={`/settings/staff/${s.id}`}
                    className="block group-hover:text-blue-700 transition-colors"
                  >
                    <div className="font-medium text-un1t-white whitespace-nowrap">{s.full_name}</div>
                    <div className="text-[10px] text-un1t-light truncate max-w-[200px]">{s.email}</div>
                  </Link>
                </td>
                {organizations.map(org => (
                  (locationsByOrg[org.id] || []).map(loc => (
                    <td key={loc.id} className="px-2 py-1.5">
                      <RoleCell role={rolesByStaffByLoc[s.id]?.[loc.id]} />
                    </td>
                  ))
                ))}
                <td className="px-2 py-1.5 text-center border-l border-un1t-gray/40">
                  {s.role === 'master' ? (
                    <span
                      className="inline-flex items-center gap-1 text-amber-700"
                      title="Platform-wide super-admin"
                    >
                      <ShieldCheck size={12} />
                    </span>
                  ) : (
                    <span className="text-un1t-mid text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[11px] text-un1t-light">
        Click any user to open the per-staff editor where assignments and per-location permissions
        can be edited. Inline editing on this matrix is planned for v2.
      </p>
    </div>
  )
}
