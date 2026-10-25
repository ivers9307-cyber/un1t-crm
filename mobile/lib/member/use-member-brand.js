// W1.S5 — useMemberBrand(): the tenant brand for a MEMBER screen.
//
// A pure member session has no activeLocation (the staff auth context's
// idea of "where I am"), so useBrand() with no argument would answer the
// EMPTY brand forever on the member side. The member's studio is the
// contacts row's own location_id (CONTACT_COLUMNS in contact-context.jsx,
// readable under the own-row leg of the contacts_select policy, mig 690),
// so this hook reads it from the member contact context and hands it to
// useBrand(locationId). Same contract as useBrand(): the EMPTY brand (empty
// strings, bare nouns) until the load lands, never a literal gym name.
//
// Lives in mobile/lib (an OTA path) next to the contact context it reads;
// the only React it does is composing two hooks.

import { useAuth } from './contact-context'
import { useBrand } from '../use-brand'

/**
 * @returns {{ companyName: string, shortName: string, logoUrl: string|null, productNames: { points: string, hr: string }, pointsUnit: string, loading: boolean }}
 */
export function useMemberBrand() {
  const { contact } = useAuth()
  return useBrand(contact?.location_id || null)
}
