import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { MapPin, ChevronRight } from 'lucide-react'
import { visibleSettingsTree } from '@/lib/settings-tree'

// SETTINGS.2g Task 3 — the settings index is now a thin renderer over
// SETTINGS_TREE (src/lib/settings-tree.js): this page's job is (a) the
// page-level auth gate, (b) the two live counts (staff/locations) the
// tree can't know about on its own, and (c) the interactive location
// list, which — per the settings-tree.js header comment — is not a tree
// row at all (there's no single /settings/locations index page to link
// to). Every other row on this page is data-driven; adding a settings
// surface is now "add a row to settings-tree.js", not "hand-edit this
// file's JSX".
//
// SETTINGS.3/.4/.2g history:
//   - Master tools moved to TOP, then folded into the Workspace group's
//     masterOnly rows (SETTINGS.2g Task 3).
//   - Shift Templates + Bank Holidays moved to per-location settings,
//     then Bank Holidays came back as a Workspace row (Task 3).
//   - Team Members inline table replaced with a link card (SETTINGS.4),
//     then became the Team group's `staff` row (Task 3); Add Staff
//     became its own `staff-new` CTA row per the Task 3 spec.
//   - The flat card grid (SETTINGS.3-6) replaced by the 7-group tree
//     (SETTINGS.2g Task 3).

export const dynamic = 'force-dynamic'

// Per-row live counts this page computes and the static tree can't.
// Keyed by row id, same id space as SETTINGS_TREE rows.
function badgeFor(rowId, { staffCount }) {
  if (rowId === 'staff') return staffCount || 0
  return null
}

function SettingsRow({ row, badge }) {
  const Icon = row.icon
  const inner = (
    <div className="flex items-center gap-3">
      {Icon && <Icon size={16} className="text-un1t-subtle shrink-0" />}
      <div>
        <div className="text-un1t-text flex items-center gap-2">
          {row.label}
          {badge != null && (
            <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full">{badge}</span>
          )}
        </div>
        <div className="text-xs text-un1t-subtle mt-0.5">{row.description}</div>
      </div>
    </div>
  )

  // href: null rows are the Security group's "coming soon" placeholders
  // (SETTINGS_TREE — 2FA, SSO). Rendered inert: no Link, no hover state.
  if (!row.href) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 flex items-center justify-between text-sm opacity-70">
        {inner}
        <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full shrink-0">Coming soon</span>
      </div>
    )
  }

  return (
    <Link
      href={row.href}
      className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
    >
      {inner}
      <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
    </Link>
  )
}

function LocationsSection({ isMaster, locations }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <MapPin size={16} className="text-un1t-subtle" />
          <span className="text-sm font-medium text-un1t-text">Locations</span>
          <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full">{locations.length}</span>
        </div>
        {isMaster && (
          <Link
            href="/settings/locations/new"
            className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Add Location
          </Link>
        )}
      </div>
      <div className="bg-un1t-surface border border-un1t-border rounded-lg divide-y divide-un1t-border">
        {locations.map((loc) => (
          <div key={loc.id} className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{loc.name}</p>
              <p className="text-xs text-un1t-subtle mt-0.5">{loc.address || loc.slug}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-xs px-2 py-0.5 rounded-full ${loc.active ? 'bg-green-500/20 text-green-700' : 'bg-red-500/20 text-red-700'}`}>
                {loc.active ? 'Active' : 'Inactive'}
              </span>
              <Link href={`/settings/locations/${loc.id}`} className="text-xs text-blue-400 hover:text-blue-300">
                Edit
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Permission gate honoured for every role. The page contains links
  // into staff/* and locations/* sub-pages — those have their own
  // owner-only role gate independent of this permission, so an owner
  // who toggles `settings` off still can't accidentally lock themselves
  // out of admin operations (they navigate via direct URL).
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()
  // We only need counts on this index page — the full staff list lives
  // at /settings/staff. Pull head=true + count so we don't drag 50+ rows
  // + profile_locations joins for what's effectively a badge.
  const [{ count: staffCount }, locationsRes] = await Promise.all([
    db.from('profiles').select('id', { count: 'exact', head: true }),
    db.from('locations').select('*').eq('is_host_anchor', false).order('created_at'),
  ])
  const locations = locationsRes.data || []

  const hasPerm = (key) => hasPermission(user, key)
  const tree = visibleSettingsTree(user, hasPerm)

  // The interactive Locations list is NOT gated by anything beyond this
  // page's own `settings` permission (matches pre-Task-3 behaviour — every
  // settings-permission holder always saw it; only the Add Location CTA
  // was master-only). It must render regardless of whether the Workspace
  // GROUP survives visibleSettingsTree's filtering for this user (e.g. a
  // manager with none of Workspace's other rows — holidays/class-
  // categories need MANAGER_ROLES they may lack, hosts needs ADMIN_ROLES,
  // the admin-* rows are masterOnly — would otherwise lose the Locations
  // list entirely, a real regression from the old ungated section). So
  // Workspace is rendered unconditionally, with its Locations subsection
  // first, and whatever tree rows survive for it appended after.
  const workspaceRows = tree.find((g) => g.id === 'workspace')?.rows || []
  const otherGroups = tree.filter((g) => g.id !== 'workspace')

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Settings</h2>
      <p className="text-sm text-un1t-subtle mb-8">Manage your team, locations, communications, and permissions</p>

      <div className="mb-10">
        <h3 className="text-lg font-semibold mb-4">Workspace</h3>
        <LocationsSection isMaster={user.role === 'master'} locations={locations} />
        {workspaceRows.length > 0 && (
          <div className="space-y-2">
            {workspaceRows.map((row) => (
              <SettingsRow key={row.id} row={row} badge={badgeFor(row.id, { staffCount })} />
            ))}
          </div>
        )}
      </div>

      {otherGroups.map((group) => (
        <div key={group.id} className="mb-10">
          <h3 className="text-lg font-semibold mb-4">{group.label}</h3>
          <div className="space-y-2">
            {group.rows.map((row) => (
              <SettingsRow key={row.id} row={row} badge={badgeFor(row.id, { staffCount })} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
