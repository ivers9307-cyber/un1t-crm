import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, MapPin, Shield, UserCog, LayoutGrid, Trophy, Cable, ChevronRight, Bell, KeyRound, MessagesSquare, Bot, Download, Globe, Activity } from 'lucide-react'

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

  // Per-org API keys are sensitive (programmatic data access), so the
  // settings card is master/owner only — same gate as the API + page.
  const canManageApiKeys = ['master', 'owner'].includes(user.role)

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Settings</h2>
      <p className="text-sm text-un1t-subtle mb-8">Manage your team, locations, communications, and permissions</p>

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
              {/* SETTINGS.5 — collapsed Platform admin + Audit log
                  buttons into one Admin entry pointing at /admin
                  (the new hub page that lists every admin tool the
                  caller has access to). The hub itself surfaces the
                  feature matrix, audit log, achievements, and
                  integrations as cards, so we don't need top-level
                  shortcuts for each one here. Kept Achievements +
                  Integrations as direct shortcuts because they're
                  the two masters reach for most often. */}
              <Link
                href="/admin"
                className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <LayoutGrid size={12} /> Admin
              </Link>
              <Link
                href="/admin/achievements"
                className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <Trophy size={12} /> Achievements
              </Link>
              <Link
                href="/admin/integrations"
                className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium inline-flex items-center gap-1.5"
              >
                <Cable size={12} /> Integrations
              </Link>
              <Link
                href="/settings/impersonate"
                className="text-xs bg-amber-500 text-un1t-bg px-3 py-1.5 rounded-md hover:bg-amber-400 transition-colors font-medium"
              >
                View as user
              </Link>
            </div>
          </div>
          <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
            <p className="text-sm text-un1t-subtle">Sign in as another user to debug their experience. Every session is audited.</p>
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
            <Users size={18} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Team Members</h3>
            <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full ml-1">{staffCount || 0}</span>
          </div>
          <Link
            href="/settings/staff/new"
            className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
          >
            Add Staff
          </Link>
        </div>

        <Link
          href="/settings/staff"
          className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
        >
          <div>
            <div className="text-un1t-text">View team</div>
            <div className="text-xs text-un1t-subtle mt-0.5">
              Searchable list of all {staffCount || 0} team members. Filter by status, role, location, or name.
            </div>
          </div>
          <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text" />
        </Link>
      </div>

      {/* Locations Section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MapPin size={18} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Locations</h3>
            <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full ml-1">{locations.length}</span>
          </div>
          {user.role === 'master' && (
            <Link
              href="/settings/locations/new"
              className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent transition-colors font-medium"
            >
              Add Location
            </Link>
          )}
        </div>

        <div className="bg-un1t-surface border border-un1t-border rounded-lg divide-y divide-un1t-border">
          {locations.map(loc => (
            <div key={loc.id} className="p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{loc.name}</p>
                <p className="text-xs text-un1t-subtle mt-0.5">{loc.address || loc.slug}</p>
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

      {/* Communications — comms-config surfaces grouped together
          (SETTINGS.6). Two cards:
            - Notification registry (NOTIF.3) — read-only catalogue of
              every notification the CRM sends. Per-location lead-time
              config still lives on each location's edit page.
            - Customer agent (RADAR-AGENT.0) — the customer-facing
              WhatsApp/Instagram AI agent. This page previously had NO
              link from anywhere in the UI (reachable by direct URL
              only); surfacing it here is the genuine discoverability
              fix in the bet-4 settings pass. */}
      <div className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <MessagesSquare size={18} className="text-un1t-subtle" />
          <h3 className="text-lg font-semibold">Communications</h3>
        </div>
        <div className="space-y-2">
          <Link
            href="/settings/notifications"
            className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div className="flex items-center gap-3">
              <Bell size={16} className="text-un1t-subtle shrink-0" />
              <div>
                <div className="text-un1t-text">Notification registry</div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  Every notification the CRM sends — who fires it, who receives it, lead-time config per category.
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
          </Link>
          <Link
            href="/settings/customer-agent"
            className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div className="flex items-center gap-3">
              <Bot size={16} className="text-un1t-subtle shrink-0" />
              <div>
                <div className="text-un1t-text">Customer agent</div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  The customer-facing WhatsApp / Instagram AI agent — channel connections, behaviour, and the knowledge it answers from. Off by default.
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
          </Link>
          <Link
            href="/settings/class-categories"
            className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div className="flex items-center gap-3">
              <Activity size={16} className="text-un1t-subtle shrink-0" />
              <div>
                <div className="text-un1t-text">Class categories</div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  Tag each class cardio / strength / conditioning — powers the post-class report comparisons.
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
          </Link>
        </div>
      </div>

      {/* Data & website (SIDEBAR-IA.1) — set-and-forget surfaces that
          used to sit in the sidebar's Studio Management group. They're
          rare admin tasks (imports run a handful of times a year, the
          landing-page form changes occasionally), so they live here on
          the Settings index instead of costing daily sidebar rows.
          Each card keeps its own permission; the /admin + /settings
          pages behind them carry their own server gates regardless. */}
      {(hasPermission(user, 'glofox_import') || hasPermission(user, 'preferences_import') || hasPermission(user, 'landing_page')) && (
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <Download size={18} className="text-un1t-subtle" />
            <h3 className="text-lg font-semibold">Data &amp; website</h3>
          </div>
          <div className="space-y-2">
            {hasPermission(user, 'glofox_import') && (
              <Link
                href="/admin/glofox-import"
                className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Download size={16} className="text-un1t-subtle shrink-0" />
                  <div>
                    <div className="text-un1t-text">Glofox import</div>
                    <div className="text-xs text-un1t-subtle mt-0.5">
                      Interactive Glofox member import + sync history.
                    </div>
                  </div>
                </div>
                <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
              </Link>
            )}
            {hasPermission(user, 'preferences_import') && (
              <Link
                href="/admin/marketing-import"
                className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Download size={16} className="text-un1t-subtle shrink-0" />
                  <div>
                    <div className="text-un1t-text">Preferences import</div>
                    <div className="text-xs text-un1t-subtle mt-0.5">
                      Bulk import of marketing preferences (consent flags).
                    </div>
                  </div>
                </div>
                <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
              </Link>
            )}
            {hasPermission(user, 'landing_page') && (
              <Link
                href="/settings/landing-page"
                className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Globe size={16} className="text-un1t-subtle shrink-0" />
                  <div>
                    <div className="text-un1t-text">Landing page</div>
                    <div className="text-xs text-un1t-subtle mt-0.5">
                      Content + form settings for the public landing pages. The live page stays linked from Studio Management.
                    </div>
                  </div>
                </div>
                <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
              </Link>
            )}
          </div>
        </div>
      )}

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
          <Shield size={18} className="text-un1t-subtle" />
          <h3 className="text-lg font-semibold">Security</h3>
        </div>

        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-4">
          {canManageApiKeys && (
            <Link
              href="/settings/api-keys"
              className="flex items-center justify-between hover:bg-un1t-border/20 -m-4 p-4 rounded-lg transition-colors"
            >
              <div className="flex items-center gap-3">
                <KeyRound size={16} className="text-un1t-subtle" />
                <div>
                  <p className="text-sm font-medium">API keys</p>
                  <p className="text-xs text-un1t-subtle mt-0.5">Create and revoke keys for programmatic access (n8n and other integrations)</p>
                </div>
              </div>
              <ChevronRight size={16} className="text-un1t-subtle" />
            </Link>
          )}
          <Link
            href="/account/access-history"
            className="flex items-center justify-between hover:bg-un1t-border/20 -m-4 p-4 rounded-lg transition-colors"
          >
            <div>
              <p className="text-sm font-medium">Account access history</p>
              <p className="text-xs text-un1t-subtle mt-0.5">See every time a master account has signed in as you</p>
            </div>
            <span className="text-xs text-un1t-subtle">View →</span>
          </Link>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Two-Factor Authentication</p>
              <p className="text-xs text-un1t-subtle mt-0.5">Require 2FA for all team members</p>
            </div>
            <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full">Coming soon</span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Single Sign-On (SSO)</p>
              <p className="text-xs text-un1t-subtle mt-0.5">Connect your identity provider via SAML</p>
            </div>
            <span className="text-xs bg-un1t-border text-un1t-subtle px-2 py-0.5 rounded-full">Coming soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}
