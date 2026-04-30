// Legacy URL — collapsed into /cars/active (new + pending).
import { redirect } from 'next/navigation'

export default function PendingCarsRedirect() {
  redirect('/cars/active')
}
