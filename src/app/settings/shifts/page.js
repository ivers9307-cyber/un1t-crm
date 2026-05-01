import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import ShiftTemplateManager from '@/components/ShiftTemplateManager'
import { MANAGER_ROLES } from '@/lib/schemas'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function ShiftSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    redirect('/')
  }

  return (
    <div className="p-8">
      <ShiftTemplateManager user={user} />
    </div>
  )
}
