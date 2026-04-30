import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { mergeHolidays, countryName, SUPPORTED_HOLIDAY_COUNTRIES } from '@/lib/bank-holidays'
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
  const [{ data: locRow }, { data: customRows }] = await Promise.all([
    db.from('locations').select('country').eq('id', locationId).single(),
    db.from('location_holidays')
      .select('id, location_id, date, name')
      .eq('location_id', locationId)
      .order('date', { ascending: true }),
  ])

  const country = locRow?.country || 'IE'
  const merged = mergeHolidays(customRows || [], { country })
  const isSupportedCountry = SUPPORTED_HOLIDAY_COUNTRIES.includes(country)

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white mb-4">
        <ArrowLeft size={16} /> Back to Settings
      </Link>
      <h2 className="text-2xl font-bold mb-1">Bank Holidays</h2>
      <p className="text-sm text-un1t-light mb-2">
        Public holidays for <span className="text-un1t-white font-medium">{user.activeLocation?.name}</span>
        {' '}({countryName(country)}) are highlighted on the schedule. Add custom holidays
        here for closures specific to this location.
      </p>
      {!isSupportedCountry && (
        <div className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
          We don&apos;t have a built-in public-holiday list for{' '}
          <span className="font-medium">{countryName(country)}</span> yet —
          add the dates below as custom holidays. (Set the country on{' '}
          <Link href={`/settings/locations/${locationId}`} className="underline hover:text-amber-200">
            the location settings page
          </Link>{' '}
          if this isn&apos;t right.)
        </div>
      )}

      <HolidayManager
        locationId={locationId}
        initialHolidays={merged}
      />
    </div>
  )
}
