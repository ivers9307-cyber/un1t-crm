import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { redirect, notFound } from 'next/navigation'
import CampaignDetail from '@/components/CampaignDetail'
import CampaignEditor from '@/components/CampaignEditor'

export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage(props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: campaign } = await db.from('campaigns')
    .select('*')
    .eq('id', params.id)
    .single()

  // IDOR guard — campaign (and its recipients) must belong to a location the user
  // can access. 404 (not 403) so foreign ids aren't enumerable. Must run BEFORE the
  // draft/edit branch below, or a foreign draft would open in the editor.
  if (!campaign || assertLocationAccess(user, campaign.location_id)) notFound()

  // CAMPAIGN.4 — drafts (and any URL with ?edit=1) open in the editor.
  // Previously this rendered <CampaignDetail> for drafts, which then
  // tried to router.replace(...?edit=1) — but nothing actually reads
  // ?edit=1 to render the editor, so the page sat blank.
  const editRequested = searchParams?.edit === '1' || searchParams?.edit === 'true'
  const isDraft = campaign.status === 'draft'

  if (isDraft || editRequested) {
    return (
      <CampaignEditor
        campaign={campaign}
        locationId={campaign.location_id || user.activeLocation?.id}
        userId={user.id}
      />
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
