import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import ShiftTemplateManager from '@/components/ShiftTemplateManager'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function ShiftSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    redirect('/')
  }

  return (
    <div className="p-8">
      <ShiftTemplateManager user={user} />
    </div>
  )
}
