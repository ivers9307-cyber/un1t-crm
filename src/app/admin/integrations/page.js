// /admin/integrations — master-only credentials store for
// third-party services (Strava etc).

import { createServerClient } from '@/lib/supabase'
import IntegrationsAdmin from '@/components/IntegrationsAdmin'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function AdminIntegrationsPage() {
  const db = createServerClient()
  const { data: integrations } = await db
    .from('service_integrations')
    .select('*')
    .order('display_name', { ascending: true })

  return (
    <div className="p-8 max-w-4xl">
      <h2 className="text-2xl font-bold mb-1">Service integrations</h2>
      <p className="text-sm text-un1t-light mb-8 max-w-3xl">
        Third-party app credentials — Strava, Garmin, Apple Health.
        Members can connect their accounts only when an integration
        is configured (client_id + client_secret) and toggled on.
        Apply for the OAuth app on the provider&apos;s developer
        portal first, then paste the credentials here.
      </p>
      <IntegrationsAdmin initial={integrations || []} />
    </div>
  )
}
