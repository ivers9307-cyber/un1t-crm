import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { MANAGER_ROLES } from '@/lib/schemas'
import CorpPromosCard from '@/components/settings/CorpPromosCard'

export const dynamic = 'force-dynamic'

// WAYSIN.4 — the studio's corporate and partner promos (public.corp_promos,
// mig 816). Managers read; owners and masters edit (the card asks the API).
export default async function PromosSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) redirect('/')
  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/settings')

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-1">Promos</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Corporate and partner promos: free classes with a claim link. The words visitors read live on the promo block of the studio&apos;s landing page.
      </p>
      <CorpPromosCard locationId={locationId} />
    </div>
  )
}
