// The /start class-booking queue's attempt cap: how many times a booking is
// tried (a THROW re-queues it) before it goes to staff as a card. ONE
// constant, because three places must agree on it: the queue's retry cap
// (class-booking-queue.js MAX_ATTEMPTS), the processor's review-unavailable
// fallback (class-booking-processor.js) and the staff card copy that says
// how many tries were made (approvals/agent-request-why.js). Pure: the card
// copy is rendered in the browser too.
export const CLASS_BOOKING_MAX_ATTEMPTS = 3
