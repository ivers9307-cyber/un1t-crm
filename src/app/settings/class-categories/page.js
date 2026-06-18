import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import { loadSeenClassCategories } from '@/lib/class-categories'
import ClassCategoriesManager from '@/components/ClassCategoriesManager'

export const dynamic = 'force-dynamic'

export default async function ClassCategoriesSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) redirect('/')
  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/settings')

  const db = createServerClient()
  const seen = await loadSeenClassCategories(db, locationId)

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={16} /> Back to Settings
      </Link>
      <h2 className="text-2xl font-bold mb-1">Class categories</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Tag each class as cardio, strength or conditioning. Members&apos; post-class reports use this to compare a session to their typical classes of the same kind.
      </p>
      <ClassCategoriesManager locationId={locationId} initialSeen={seen} />
    </div>
  )
}
