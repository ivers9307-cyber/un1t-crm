import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import SequenceEditor from '@/components/SequenceEditor'

export const dynamic = 'force-dynamic'

export default async function NewSequencePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <SequenceEditor
      locationId={user.activeLocation?.id}
      userId={user.id}
    />
  )
}
