// UN1TWRITE.14/15 — the staff copy for un1t.online bookings. Pure, so the
// browser's Book panel can read it (un1t-staff-booking.js is server-only).

/** Staff copy (plan D global constraints, verbatim). */
export const UN1T_STAFF_COPY = Object.freeze({
  unknown: 'un1t.online did not answer clearly. Check the class in un1t.online before trying again.',
  noAccount: (studio) => `This contact has no un1t.online account at ${studio}. They can book through the website.`,
  alreadyBooked: 'Already booked in un1t.online',
  off: (studio) => `un1t.online booking is off at ${studio}.`,
  busy: 'un1t.online is busy. Try again in a minute.',
  // An unconfirmed "already booked" (the words said so; the check read could not).
  alreadyBookedUnverified: 'The CRM could not confirm whether this person is already booked. Check the class in un1t.online before trying again.',
  settingsUnreadable: "Could not read this studio's un1t.online settings just now. Nothing was sent; try again.",
})

