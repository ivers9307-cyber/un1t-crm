// Legacy URL — collapsed into /cars/active (new + pending).
import { redirect } from 'next/navigation'

export default function NewCarsRedirect() {
  redirect('/cars/active')
}
