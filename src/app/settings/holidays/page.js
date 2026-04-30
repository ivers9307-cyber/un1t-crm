import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { mergeHolidays } from '@/lib/bank-holidays'
import HolidayManager from '@/components/HolidayManager'
import { MANAGER_ROLES } from '@/lib/schemas'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default async function HolidaysSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    redirect('/')
  }
  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/settings')

  const db = createServerClient()
  const { data: customRows } = await db.from('location_holidays')
    .select('id, location_id, date, name')
    .eq('location_id', locationId)
    .order('date', { ascending: true })

  const merged = mergeHolidays(customRows || [])

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-4">
        <ArrowLeft size={16} /> Back to Settings
      </Link>
      <h2 className="text-2xl font-bold mb-1">Bank Holidays</h2>
      <p className="text-sm text-un1t-light mb-6">
        Irish public holidays are baked into the app and highlighted automatically on the schedule.
        Add custom holidays here to mark closures specific to <span className="text-un1t-white font-medium">{user.activeLocation?.name}</span>.
      </p>

      <HolidayManager
        locationId={locationId}
        initialHolidays={merged}
      />
    </div>
  )
}
