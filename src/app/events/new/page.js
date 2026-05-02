import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import EventForm from '@/components/EventForm'

export const dynamic = 'force-dynamic'

export default async function NewEventPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">Create event type</h2>
      <p className="text-sm text-un1t-light mb-6">Define a new bookable template that customers can reserve from the public booking page.</p>
      <EventForm locationId={user.activeLocation?.id} />
    </div>
  )
}
