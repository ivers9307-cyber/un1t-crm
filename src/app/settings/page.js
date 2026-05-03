import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, MapPin, Shield, Clock, Palette, CalendarDays, Plug, UserCog, LayoutGrid, FileClock } from 'lucide-react'
import BrandingSettings from '@/components/BrandingSettings'

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
  const [staffRes, locationsRes] = await Promise.all([
    db.from('profiles').select('*, profile_locations(*, locations(*))').order('created_at'),
    db.from('locations').select('*').order('created_at'),
  ])

  const staff = staffRes.data || []
  const locations = locationsRes.data || []

  const roleColors = {
    owner: 'bg-purple-500/20 text-purple-400',
    manager: 'bg-blue-500/20 text-blue-400',
    head_coach: 'bg-emerald-500/20 text-emerald-400',
    staff: 'bg-gray-500/20 text-gray-400',
  }

  const roleLabels = {
    owner: 'Owner',
    manager: 'Manager',
    head_coach: 'Head Coach',
    staff: 'Staff',
  }

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Settings</h2>
      <p className="text-sm text-un1t-light mb-8">Manage your team, locations, and permissions</p>

      {/* Staff Section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Team Members</h3>
            <span className="text-xs bg-un1t-gray text-un1t-light px-2 py-0.5 rounded-full ml-1">{staff.length}</span>
          </div>
          <Link
            href="/settings/staff/new"
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Add Staff
          </Link>
        </div>

        <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-un1t-gray text-un1t-light text-xs uppercase tracking-wider">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Email</th>
                <th className="text-left p-3">Role</th>
                <th className="text-left p-3">Locations</th>
                <th className="text-left p-3">Status</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-un1t-gray">
              {staff.map(s => (
                <tr key={s.id} className="hover:bg-un1t-gray/20 transition-colors">
                  <td className="p-3 font-medium">{s.full_name}</td>
                  <td className="p-3 text-un1t-light">{s.email}</td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${roleColors[s.role] || roleColors.staff}`}>
                      {roleLabels[s.role] || s.role}
                    </span>
                  </td>
                  <td className="p-3 text-un1t-light text-xs">
                    {(s.profile_locations || []).map(pl => pl.locations?.name).filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="p-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${s.active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                      {s.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-3">
                    <Link
                      href={`/settings/staff/${s.id}`}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

      {/* Shift Templates Section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Clock size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Shift Templates</h3>
          </div>
          <Link
            href="/settings/shifts"
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Manage Shifts
          </Link>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-sm text-un1t-light">Define named shift templates (Morning, Afternoon, Evening) used when building the weekly roster.</p>
        </div>
      </div>

      {/* Bank Holidays Section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CalendarDays size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Bank Holidays</h3>
          </div>
          <Link
            href="/settings/holidays"
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Manage Holidays
          </Link>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-4">
          <p className="text-sm text-un1t-light">Irish public holidays are highlighted on the schedule automatically. Add custom closures (Good Friday, Christmas Eve early-close) per location.</p>
        </div>
      </div>

      {/* Master tools — platform-level admin links. Visible only to
          masters (or someone currently impersonating, so they can
          switch targets from this page too). The /admin/* segment
          is master-only at the layout level (mig 079). */}
      {(user.role === 'master' || user.impersonatingFrom) && (
        <div className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <UserCog size={18} className="text-amber-400" />
              <h3 className="text-lg font-semibold">Master tools</h3>
            </div>
            <div className="flex items-center gap-2">
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

      {/* Integrations Section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Plug size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Integrations</h3>
          </div>
          <Link
            href="/settings/integrations"
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Manage
          </Link>
        </div>
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
          <p className="text-sm text-un1t-light">Xero connection per location — used for pushing customer invoices when a car is marked completed.</p>
        </div>
      </div>

      {/* Branding Section — Owner or master */}
      {(user.role === 'owner' || user.role === 'master') && (
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <Palette size={18} className="text-un1t-light" />
            <h3 className="text-lg font-semibold">Branding</h3>
          </div>
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
            <BrandingSettings user={user} />
          </div>
        </div>
      )}

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
