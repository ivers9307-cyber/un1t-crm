import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import CampaignEditor from '@/components/CampaignEditor'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <CampaignEditor
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
