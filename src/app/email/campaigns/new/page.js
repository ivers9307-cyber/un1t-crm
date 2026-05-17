import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import CampaignEditor from '@/components/CampaignEditor'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage(props) {
  const searchParams = await props.searchParams;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Optional ?segment=<tag> deep-link from /communications/segments —
  // pre-populate the AudienceBuilder with that tag clause so operators
  // who clicked "Email broadcast" on a segment card don't have to
  // re-pick it manually.
  const segment = searchParams?.segment
  const initialAudienceFilter = segment
    ? { logic: 'and', filters: [{ field: 'tag', op: 'eq', value: String(segment) }] }
    : null

  return (
    <CampaignEditor
      locationId={user.activeLocation?.id}
      userId={user.id}
      initialAudienceFilter={initialAudienceFilter}
    />
  )
}
