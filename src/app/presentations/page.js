import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import PresentationsClient from './PresentationsClient'

export const dynamic = 'force-dynamic'

export default async function PresentationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'presentations')) redirect('/')
  return <PresentationsClient locationId={user.activeLocation?.id} appUrl={process.env.NEXT_PUBLIC_APP_URL} />
}
