'use client'

// BOOK-ON-PROFILE.1 — booking section on the contact profile's "what
// happens next" column. Wraps the shared BookPanel to book consultations +
// Glofox classes for this contact, exactly as the inbox Book tab does.
//
// Confirmation: /api/bookings/create already auto-sends an email/SMS
// confirmation per the customer's preferences (sendBookingConfirmation).
// Staff can ADDITIONALLY fire a WhatsApp confirmation when the contact has
// an open 24h WhatsApp window — that reuses the exact thread drop-in the
// inbox uses, so no new WhatsApp plumbing. When the window is closed the
// toggle is absent (BookPanel only shows it when a conversationId is passed).
//
// onBooked → router.refresh() re-runs the server page so a new booking
// shows up in the timeline / upcoming list right away.

import { useRouter } from 'next/navigation'
import { CalendarPlus } from 'lucide-react'
import BookPanel from '@/components/BookPanel'

export default function ContactBookingCard({
  contactId,
  locationId,
  glofoxMemberId,
  eventTypes,
  waConversationId,
  waWindowOpen,
}) {
  const router = useRouter()
  const canWhatsApp = !!waConversationId && !!waWindowOpen
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
        <CalendarPlus size={12} /> Book a session
      </h3>
      <BookPanel
        contactId={contactId}
        locationId={locationId}
        glofoxMemberId={glofoxMemberId}
        eventTypes={eventTypes}
        channel={canWhatsApp ? 'wa' : null}
        conversationId={canWhatsApp ? waConversationId : null}
        notifyLabel="Also send a WhatsApp confirmation"
        onBooked={() => router.refresh()}
      />
      <p className="mt-3 text-[11px] text-un1t-subtle leading-relaxed">
        A confirmation email/SMS is sent automatically per the customer&apos;s preferences.
        {waConversationId && !waWindowOpen
          ? ' Their WhatsApp 24-hour window is closed, so a WhatsApp confirmation cannot be sent right now.'
          : ''}
      </p>
    </div>
  )
}
