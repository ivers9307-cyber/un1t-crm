// /admin — index hub for the admin tools.
//
// Originally returned 404 because the /admin route had a layout but
// no page. Now renders a tile list of every admin tool the caller
// has access to. The relaxed layout (STUDIO-GROUP.1) already filters
// who can land here — master always, plus anyone holding any of the
// four Studio Management permissions. This page just lays out the
// available tools as a hub.

import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  FileSignature, Tv, Download, BookOpen, ChevronRight,
  Award, ScrollText, Plug, LayoutGrid, Radio, Smartphone,
  CheckSquare, Globe, BadgeEuro, Building2, Dumbbell, HardDrive,
  AlertTriangle,
} from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

function isMaster(user) {
  return user?.profileRole === 'master' || user?.role === 'master'
}
function isOwner(user) {
  return user?.role === 'owner'
}

function Card({ href, icon: Icon, title, description }) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 p-4 rounded-xl border border-un1t-border bg-un1t-surface hover:bg-un1t-border/30 transition-colors"
    >
      <div className="w-9 h-9 rounded-md bg-un1t-border/40 flex items-center justify-center shrink-0">
        <Icon size={16} className="text-un1t-subtle" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-un1t-text font-medium text-sm">
          {title}
          <ChevronRight size={14} className="text-un1t-muted" />
        </div>
        <div className="text-xs text-un1t-subtle mt-0.5">{description}</div>
      </div>
    </Link>
  )
}

export default async function AdminHubPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const master = isMaster(user)
  const ownerOrMaster = master || isOwner(user)

  // Studio Management family — visible per per-user permission.
  const studioTools = [
    { perm: 'contracts',          href: '/contracts',               icon: FileSignature, title: 'Contracts',           desc: 'Issue, track, and revoke digital contracts.' },
    { perm: 'tv_displays',        href: '/tv-displays',             icon: Tv,            title: 'TV Displays',         desc: 'Register studio TVs and push content via UC Cast Pro.' },
    { perm: 'glofox_import',      href: '/admin/glofox-import',     icon: Download,      title: 'Glofox import',       desc: 'Interactive Glofox member import and sync history.' },
    { perm: 'preferences_import', href: '/admin/marketing-import',  icon: Download,      title: 'Preferences import',  desc: 'Bulk import marketing preferences from external platforms.' },
    // HYROX-TC.2 — coach planner: generate the block, then review/approve/
    // regenerate each AI-generated session before it publishes to a TV.
    { perm: 'approvals_hyrox_sessions', href: '/hyrox',             icon: Dumbbell,      title: 'Hyrox Training Club', desc: 'Generate and review the 12-week Hyrox block.' },
    // Policies admin is owner/master-only at the page level. Expose the
    // card to them; non-owner/non-master with a Studio Management perm
    // won't see this card (and the page itself would redirect them
    // back to /).
    { ownerOrMasterOnly: true,    href: '/admin/policies',          icon: BookOpen,      title: 'Policies',            desc: 'Manage HR policies — versioning, view tracking, change history.' },
    // CHECKLIST.1 — per-(role, day) closer / opener checklists for
    // coaches on shift. Master + owner write; anyone with admin
    // access can browse to see the current layout.
    { ownerOrMasterOnly: true,    href: '/checklists',              icon: CheckSquare,   title: 'Checklists',          desc: 'Role + day-of-week checklists for coaches. Items shown on the mobile app during their shift.' },
    // FLEET-CMD.1 — keyed on fleet_restart, the SAFE tier, so a coach who
    // can restart a frozen board can find the page. Destructive actions are
    // gated per-action behind fleet_admin inside it.
    { perm: 'fleet_restart',      href: '/admin/fleet',             icon: HardDrive,     title: 'Studio devices (Pis)', desc: 'Restart a frozen TV, reboot or power down a studio Raspberry Pi, redeploy the HR bridge.' },
    // DEADLETTER-UI.1 — owner+master, matching the page and API gates.
    { ownerOrMasterOnly: true,    href: '/admin/webhook-dead-letter', icon: AlertTriangle, title: 'Webhook dead letters', desc: 'Captured events that failed to process — unroutable inbound email, exhausted bounces and unsubscribes, unfiled sent mail. Review and resolve.' },
  ].filter((t) => {
    if (master) return true
    if (t.ownerOrMasterOnly) return ownerOrMaster
    return hasPermission(user, t.perm)
  })

  // Master-only platform tools.
  const masterTools = master ? [
    { href: '/admin/matrix',        icon: LayoutGrid,  title: 'Feature matrix',   desc: 'Locations × features grid + access overview.' },
    { href: '/admin/achievements',  icon: Award,       title: 'Achievements',     desc: 'Data-driven achievement rule set.' },
    { href: '/admin/audit-log',     icon: ScrollText,  title: 'Audit log',        desc: 'Assignment-change audit trail. CSV export.' },
    { href: '/admin/integrations',  icon: Plug,        title: 'Integrations',     desc: 'Third-party service credentials (Strava, Garmin, Apple).' },
    { href: '/admin/plans',         icon: BadgeEuro,   title: 'Plans & pricing',  desc: 'SaaS tiers, add-ons, allowances and overage rates — versioned, per location.' },
    { href: '/admin/tenants',       icon: Building2,   title: 'Tenants',          desc: 'Per-org roster: plans, wallets, usage and health, with drill-in and wallet adjustments.' },
    { href: '/admin/bridges',       icon: Radio,       title: 'HR Bridges',       desc: 'Register studio heart-rate bridges (Raspberry Pi) and manage tokens.' },
    { href: '/admin/studio-devices', icon: Smartphone, title: 'Studio devices',   desc: 'Pair Macs + iPads for studio PIN-login and manage trusted IPs.' },
    { href: '/admin/tenant-domains', icon: Globe,       title: 'Tenant domains',   desc: 'Map custom domains to tenant organizations — live without a deploy.' },
  ] : []

  return (
    <div className="p-6 md:p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Admin</h2>
      <p className="text-sm text-un1t-subtle mb-6 max-w-2xl">
        {master
          ? 'Platform and studio administration. Use the cards below to manage org-wide settings.'
          : 'Tools you have access to. Need more? Ask an owner or master to update your permissions in Staff settings.'}
      </p>

      {studioTools.length > 0 && (
        <section className="mb-8">
          <h3 className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-3">Studio Management</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {studioTools.map((t) => (
              <Card key={t.href} href={t.href} icon={t.icon} title={t.title} description={t.desc} />
            ))}
          </div>
        </section>
      )}

      {masterTools.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-3">Platform (master only)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {masterTools.map((t) => (
              <Card key={t.href} href={t.href} icon={t.icon} title={t.title} description={t.desc} />
            ))}
          </div>
        </section>
      )}

      {studioTools.length === 0 && masterTools.length === 0 && (
        <div className="text-sm text-un1t-muted italic">No admin tools available with your current permissions.</div>
      )}
    </div>
  )
}
