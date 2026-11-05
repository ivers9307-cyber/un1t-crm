'use client'

// MIASETTINGS.2c — Bookings and sales: class-booking autonomy, the sign-up and
// booking links, and at a un1t.online studio (Hatch Street) Mia's chat
// actions switch and what she can sell. The offers have their own Save
// (rows behind their own route), so they sit outside the fieldset.

import MiaOffersSection from '../MiaOffersSection'
import { bookingLinkErrors } from '../save-payload'
import { CARD } from './field-renderer'

export default function BookingsSection({ agent, renderField, canEdit }) {
  const { settings, serverFieldErrors, membershipSourceKey, location } = agent
  // The booking link messages shown beside their fields (the PUT's 400s too).
  const bookingErrors = { ...serverFieldErrors, ...bookingLinkErrors(settings) }
  return (
    <>
      <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
        <section className={`space-y-5 ${CARD}`}>
          {/* AGENT-HANDS.1 — class-booking autonomy. Consultations for new
              leads are always autonomous; this controls member CLASS bookings only. */}
          {renderField('booking_mode')}
          {renderField('membership_signup_url')}
          {/* MIAORG.1 — booking link, at a studio whose membership source takes
              no bookings, and at a un1t.online studio (the fallback link).
              Studio-only, always saved; blank = no link. */}
          {renderField('booking_url', { error: bookingErrors.booking_url })}
          {renderField('booking_cta_label', { error: bookingErrors.booking_cta_label })}
          {/* MIAHATCH.5 — Mia books, cancels and takes refund requests in chat
              here only with this ticked AND un1t.online writes on (Hatch only). */}
          {renderField('un1t_chat_actions_enabled')}
        </section>
      </fieldset>
      {/* MIAHATCH.4 (Task 14) — the products Mia can sell at a un1t.online
          studio; a Glofox studio sells nothing through Mia. */}
      {membershipSourceKey === 'un1t_online' && location?.id && (
        <MiaOffersSection locationId={location.id} canEdit={canEdit} />
      )}
    </>
  )
}
