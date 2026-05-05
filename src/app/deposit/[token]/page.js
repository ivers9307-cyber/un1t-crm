// Public car-deposit page. No auth — the token in the URL is the
// only credential. Lives at /deposit/<token> rather than under /cars/
// so it doesn't inherit the /cars/layout.js auth gate (which would
// redirect anonymous buyers to /login).

import CarDepositPage from '@/components/CarDepositPage'
import { createServerClient } from '@/lib/supabase'

export const dynamicParams = true
export const revalidate = 0   // status changes between visits — never cache the shell

// Per-location favicon + tab title. The car's location_id determines
// the brand the buyer sees — CCF Autos cars on pay.ccfautos.com
// surface CCF Autos's logo + favicon (and tab title), while a UN1T
// gym-side car would surface UN1T's. Falls back to the root layout
// metadata (UN1T) when the car can't be found or the location has
// no company_settings row yet.
export async function generateMetadata({ params }) {
  try {
    const db = createServerClient()
    const { data: car } = await db
      .from('cars')
      .select('make, model, vehicle_year, location_id, locations ( company_settings ( logo_url, favicon_url, company_name ) )')
      .eq('deposit_token', params.token)
      .maybeSingle()

    if (!car) return { title: 'Car Deposit' }

    const settings = car.locations?.company_settings?.[0] || {}
    const carLabel = [car.make, car.model, car.vehicle_year].filter(Boolean).join(' ').trim()
    const companyName = settings.company_name || ''
    const title = [companyName, carLabel ? `${carLabel} Deposit` : 'Car Deposit']
      .filter(Boolean)
      .join(' — ')

    const metadata = { title }
    if (settings.favicon_url) {
      metadata.icons = {
        icon: settings.favicon_url,
        shortcut: settings.favicon_url,
        apple: settings.favicon_url,
      }
    }
    return metadata
  } catch {
    // Any DB blip falls through to the root layout metadata.
    return { title: 'Car Deposit' }
  }
}

export default function DepositPage({ params }) {
  return <CarDepositPage token={params.token} />
}
