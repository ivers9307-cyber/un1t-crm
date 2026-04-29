import EventForm from '@/components/EventForm'

export default function NewEventPage() {
  return (
    <div className="p-8 max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">Create Event</h2>
      <p className="text-sm text-un1t-light mb-6">Set up a new bookable event for your website</p>
      <EventForm />
    </div>
  )
}
