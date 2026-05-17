import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, MapPin, Shield, UserCog, LayoutGrid, FileClock, Trophy, Cable, ChevronRight, Bell } from 'lucide-react'

// SETTINGS.3/.4 — reorganized this page:
//   - Master tools moved to TOP (was mid-page)
//   - Removed Shift Templates + Bank Holidays sections (now linked
//     from the per-location settings page since both are location-
//     scoped data)
//   - Removed standalone Integrations section (Xero is now a tab
//     under Settings → Locations → <name> → Integrations)
//   - Removed top-level Branding section (was duplicated; per-
//     location branding lives on Settings → Locations → <name>)
//   - SETTINGS.4: Team Members inline table replaced with a link
//     card → /settings/staff (searchable + status-filtered list)

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function SettingsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  // Permission gate honoured for every role. The page contains
  // links into staff/* and locations/* sub-pages — those have their
  // own owner-only role gate independent of this permission, so an
  // owner who toggles `settings` off still can't accidentally lock
  // themselves out of admin operations (they navigate via direct URL).
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()
  // We only need counts on this index page now — the full staff list
  // lives at /settings/staff. Pull head=true + count so we don't drag
  // 50+ rows + profile_locations joins for what's effectively a badge.
  const [{ count: staffCount }, locationsRes] = await Promise.all([
    db.from('profiles').select('id', { count: 'exact', head: true }),
    db.from('locations').select('*').order('created_at'),
  ])
  const locations = locationsRes.data || []

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Settings</h2>
      <p className="text-sm text-un1t-light mb-8">Manage your team, locations, and permissions</p>

      {/* Master tools — platform-level admin links. Moved to the TOP
          of the settings page in SETTINGS.3 since this is the most
          frequently-used section for masters. Visible only to masters
          (or someone currently impersonating). The /admin/* segment
          is master-only at the layout level (mig 079). */}
      {(user.role === 'master' || user.impersonatingFrom) && (
        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <UserCog size={18} className="text-amber-400" />
              <h3 className="text-lg font-semibold">Master tools</h3>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href="/admin/matrix"
                className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <LayoutGrid size={12} /> Platform admin
              </Link>
              <Link
                href="/admin/audit-log"
                className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <FileClock size={12} /> Audit log
              </Link>
              <Link
                href="/admin/achievements"
                className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <Trophy size={12} /> Achievements
              </Link>
              <Link
                href="/admin/integrations"
                className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <Cable size={12} /> Integrations
              </Link>
              <Link
                href="/settings/impersonate"
                className="text-xs bg-amber-500 text-un1t-black px-3 py-1.5 rounded-md hover:bg-amber-400 transition-colors font-medium"
              >
                View as user
              </Link>
            </div>
          </div>
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <p className="text-sm text-un1t-light">Sign in as another user to debug their experience. Every session is audited.</p>
          </div>
        </div>
      )}

      {/* Team Members — link card to /settings/staff (searchable list).
          SETTINGS.4 moved the inline table out of this index page;
          /settings/staff now hosts the full searchable + status-
          filterable list. The Add Staff CTA hangs off this card so
          common-action ergonomics aren't lost. */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Team Members</h3>
            <span className="text-xs bg-un1t-gray text-un1t-light px-2 py-0.5 rounded-full ml-1">{staffCount || 0}</span>
          </div>
          <Link
            href="/settings/staff/new"
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Add Staff
          </Link>
        </div>

        <Link
          href="/settings/staff"
          className="bg-un1t-dark border border-un1t-gray hover:border-un1t-light rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
        >
          <div>
            <div className="text-un1t-white">View team</div>
            <div className="text-xs text-un1t-light mt-0.5">
              Searchable list of all {staffCount || 0} team members. Filter by status, role, location, or name.
            </div>
          </div>
          <ChevronRight size={16} className="text-un1t-light group-hover:text-un1t-white" />
        </Link>
      </div>

      {/* Locations Section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MapPin size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Locations</h3>
            <span className="text-xs bg-un1t-gray text-un1t-light px-2 py-0.5 rounded-full ml-1">{locations.length}</span>
          </div>
          {user.role === 'master' && (
            <Link
              href="/settings/locations/new"
              className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
            >
              Add Location
            </Link>
          )}
        </div>

        <div className="bg-un1t-dark border border-un1t-gray rounded-lg divide-y divide-un1t-gray">
          {locations.map(loc => (
            <div key={loc.id} className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{loc.name}</p>
                <p className="text-xs text-un1t-light mt-0.5">{loc.address || loc.slug}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${loc.active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                  {loc.active ? 'Active' : 'Inactive'}
                </span>
                <Link
                  href={`/settings/locations/${loc.id}`}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Edit
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* NOTIF.3 — Push Notifications registry. Read-only catalogue
          of every notification type the CRM sends, with who fires it
          and who receives it. Per-location lead-time config lives on
          each location's edit page. */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={18} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Push Notifications</h3>
        </div>
        <Link
          href="/settings/notifications"
          className="bg-un1t-dark border border-un1t-gray hover:border-un1t-light rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
        >
          <div>
            <div className="text-un1t-white">Notification registry</div>
            <div className="text-xs text-un1t-light mt-0.5">
              Every notification the CRM sends — who fires it, who receives it, lead-time config per category.
            </div>
          </div>
          <ChevronRight size={16} className="text-un1t-light group-hover:text-un1t-white" />
        </Link>
      </div>

      {/* SETTINGS.3 — Shift Templates / Bank Holidays / Integrations /
          Branding sections removed from this top-level page:
            - Shift Templates + Bank Holidays moved to per-location
              settings (location-scoped data; lives next to the
              location's other config now)
            - Integrations (Xero) moved to per-location Integrations
              tab (was duplicated as a standalone cross-location
              overview; per-location tab is the single source now)
            - Branding moved to per-location settings (was duplicated;
              branding has always been per-location at the data
              layer via locations.company_settings) */}

      {/* Security Section */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Shield size={18} className="text-un1t-light" />
          <h3 className="text-lg font-semibold">Security</h3>
        </div>

        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4 space-y-4">
          <Link
            href="/account/access-history"
            className="flex items-center justify-between hover:bg-un1t-gray/20 -m-4 p-4 rounded-lg transition-colors"
          >
            <div>
              <p className="text-sm font-medium">Account access history</p>
              <p className="text-xs text-un1t-light mt-0.5">See every time a master account has signed in as you</p>
            </div>
            <span className="text-xs text-un1t-light">View →</span>
          </Link>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Two-Factor Authentication</p>
              <p className="text-xs text-un1t-light mt-0.5">Require 2FA for all team members</p>
            </div>
            <span className="text-xs bg-un1t-gray text-un1t-light px-2 py-0.5 rounded-full">Coming soon</span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Single Sign-On (SSO)</p>
              <p className="text-xs text-un1t-light mt-0.5">Connect your identity provider via SAML</p>
            </div>
            <span className="text-xs bg-un1t-gray text-un1t-light px-2 py-0.5 rounded-full">Coming soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}
