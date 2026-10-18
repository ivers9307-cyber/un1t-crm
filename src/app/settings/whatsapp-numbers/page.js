// WAORGNUMBER.1 (Task 5, R8) — /settings/whatsapp-numbers: the organisation's
// WhatsApp numbers. A number belongs to the ORGANISATION and is switched on per
// studio; this is where an organisation admin adds, edits and removes them,
// chooses a number's home studio and connects one through Embedded Signup.
//
// Auth: an organisation admin of the active organisation, or a master (the
// /api/organizations/[id]/whatsapp/* rule: assertOrganizationAdmin). Anyone
// else gets a 404, not a redirect: the page is not theirs to know about.

import { notFound, redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { activeOrganizationId, isOrgAdmin } from '@/lib/org-admin'
import OrgWhatsAppNumbers from '@/components/settings/whatsapp/OrgWhatsAppNumbers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function WhatsAppNumbersPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  const orgId = activeOrganizationId(user)
  if (!isOrgAdmin(user, orgId)) notFound()

  let locations = []
  if (orgId) {
    const db = createServerClient()
    const { data, error } = await db
      .from('locations')
      .select('id, name')
      .eq('organization_id', orgId)
      .eq('active', true)
      .eq('is_host_anchor', false)
      .order('name')
    // Never render a home-studio picker off a failed read: the error page instead.
    if (error) throw new Error(`locations read failed: ${error.message}`)
    locations = data || []
  }

  const orgName = user.activeOrganization?.name || null

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">WhatsApp numbers</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        The WhatsApp numbers of{' '}
        <span className="text-un1t-text">{orgName || 'this organisation'}</span>.
      </p>
      {orgId ? (
        <OrgWhatsAppNumbers organizationId={orgId} organizationName={orgName} locations={locations} />
      ) : (
        <p className="text-sm text-un1t-subtle">
          No active organisation for your session. Switch to a studio that belongs to an organisation to manage its WhatsApp numbers.
        </p>
      )}
    </div>
  )
}
