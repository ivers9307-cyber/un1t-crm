import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import CampaignDetail from '@/components/CampaignDetail'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function CampaignDetailPage({ params }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: campaign } = await db.from('campaigns')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!campaign) notFound()

  // If draft, redirect to editor
  if (campaign.status === 'draft') {
    return (
      <div>
        {/* Dynamic import of editor for drafts */}
        <CampaignDetail
          campaign={campaign}
          locationId={user.activeLocation?.id}
          userId={user.id}
        />
      </div>
    )
  }

  // Get recipients for sent campaigns
  const { data: recipients } = await db.from('campaign_recipients')
    .select('*, contacts(name, email)')
    .eq('campaign_id', params.id)
    .order('sent_at', { ascending: false })
    .limit(100)

  return (
    <CampaignDetail
      campaign={campaign}
      recipients={recipients || []}
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
