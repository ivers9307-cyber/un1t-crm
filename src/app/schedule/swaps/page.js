import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import SwapRequestsManager from '@/components/SwapRequestsManager'

export const dynamic = 'force-dynamic'

export default async function SwapRequestsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="p-8">
      <SwapRequestsManager user={user} />
    </div>
  )
}
