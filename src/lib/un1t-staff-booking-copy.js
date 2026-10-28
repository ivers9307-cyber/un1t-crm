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
  // UN1TMOVE.1 — the move route and the Move control.
  moveTargetUnavailable: "That class is not on this studio's timetable any more (or has already started), so nothing was moved.",
  moved: 'Booking moved in un1t.online.',
  // UN1TMOVE.2 — the late-window move rule (a studio fee policy).
  moveLateOtherDay: "This class starts inside the studio's late-cancel window, so the booking can only move to another class on the same day. Nothing was moved.",
  cancelAfterLateMove: "This booking was moved inside the studio's late-cancel window, so the CRM will not cancel it (that would dodge the late-cancel fee). Nothing was sent. If it really must go, cancel it in the un1t.online console.",
  lateCheckUnreadable: 'The late-cancel window could not be checked just now, so nothing was sent. Try again in a minute.',
  moveUnverified: 'The CRM moved this booking to that class before, and un1t.online could not confirm it is still there. Check the booking in un1t.online before trying again.',
})

