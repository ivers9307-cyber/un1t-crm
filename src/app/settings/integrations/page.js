// Settings → Integrations. Currently surfaces the Xero connection per
// location. The OAuth callback redirects back here with ?connected=
// or ?error= so the user gets immediate feedback without us having to
// wire up a toast system.

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, Plug, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { isFeatureEnabledAtLocation } from '@shared/permissions'
import { createServerClient } from '@/lib/supabase'
import XeroLocationCard from '@/components/settings/XeroLocationCard'

export const dynamic = 'force-dynamic'

export default async function IntegrationsPage({ searchParams }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')

  const db = createServerClient()
  // Show every location the user is a member of. Owners typically
  // see them all; staff see only their own. Pull `features` so we
  // can filter to locations with Car Processing enabled — Xero is
  // only used by the cars flow today, so a gym-only location has
  // nothing to integrate.
  const memberLocationIds = (user.locations || []).map(l => l.id).filter(Boolean)
  const { data: rawLocations } = memberLocationIds.length
    ? await db.from('locations').select('id, name, features').in('id', memberLocationIds).order('name')
    : { data: [] }
  const locations = (rawLocations || []).filter(l => isFeatureEnabledAtLocation(l, 'car_processing'))

  const { data: connections } = await db
    .from('xero_connections')
    .select('location_id, tenant_name, tenant_type, connected_at, last_refreshed_at, expires_at, scopes, bills_email_address')
    .in('location_id', memberLocationIds.length ? memberLocationIds : ['00000000-0000-0000-0000-000000000000'])

  const byLoc = new Map((connections || []).map(c => [c.location_id, c]))

  const connected = searchParams?.connected
  const error = searchParams?.error

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/settings" className="inline-flex items-center gap-1 text-xs text-un1t-light hover:text-un1t-white mb-3">
        <ChevronLeft size={14} /> Settings
      </Link>
      <h2 className="text-2xl font-bold mb-1">Integrations</h2>
      <p className="text-sm text-un1t-light mb-6">
        Connect each location to a Xero organisation. Used today for pushing customer invoices when a car is marked completed.
      </p>

      {connected && (
        <div className="bg-green-500/10 border border-green-500/30 text-green-400 text-sm rounded-lg p-3 mb-4 flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5" />
          <span>Connected to <strong>{connected}</strong>.</span>
        </div>
      )}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3 mb-4 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <Plug size={16} className="text-un1t-light" />
        <h3 className="text-lg font-semibold">Xero</h3>
      </div>

      {locations?.length ? (
        <div className="space-y-3">
          {locations.map(loc => (
            <XeroLocationCard key={loc.id} location={loc} connection={byLoc.get(loc.id) || null} />
          ))}
        </div>
      ) : (
        // Two cases: user has no locations at all, OR none of them
        // have Car Processing enabled. Either way Xero has nothing
        // to do — point the user at the location feature toggle so
        // they know how to surface this.
        <p className="text-sm text-un1t-light">
          No locations have Car Processing enabled. Turn it on under <Link href="/settings" className="underline">Settings → Locations → Features</Link> if a location should integrate with Xero.
        </p>
      )}

      <div className="mt-8 p-4 bg-un1t-dark border border-un1t-gray rounded-2xl text-xs text-un1t-light space-y-2">
        <p className="text-un1t-white font-semibold">Setup checklist</p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Register a Xero app at <a className="underline" href="https://developer.xero.com/app/manage" target="_blank" rel="noreferrer">developer.xero.com</a> (type: Web app).</li>
          <li>Add the redirect URI: <code className="bg-un1t-black/40 px-1 rounded">{process.env.NEXT_PUBLIC_APP_URL || 'https://your-domain'}/api/xero/callback</code></li>
          <li>Set <code>XERO_CLIENT_ID</code>, <code>XERO_CLIENT_SECRET</code>, and <code>XERO_REDIRECT_URI</code> in Vercel env (Production + Preview).</li>
          <li>(Optional) Set <code>XERO_SALES_ACCOUNT_CODE</code> if your Sales account isn&rsquo;t the default <code>200</code>.</li>
        </ol>
      </div>
    </div>
  )
}
