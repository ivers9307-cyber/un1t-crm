// MIAHATCH.4 (spec 6.6) — the customer copy a un1t.online studio (Hatch
// Street) can edit about booking and buying: one declarative list, rendered
// by the studio editor's "Hatch payments and booking" group (shown only at a
// un1t.online studio) and, minus chat_booking_unavailable_text (which the org
// editor lists under Messages), by the organisation editor. Staff copy: no
// em or en dashes anywhere in a label or help. The placeholder IS the code
// default (default-copy.js, the same constants renderMiaCopy falls back to).
import {
  DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT,
  DEFAULT_PURCHASE_OFFER_INTRO_TEXT, DEFAULT_PURCHASE_LINK_TEXT, DEFAULT_TRIAL_USED_TEXT,
  DEFAULT_REFUND_REQUEST_TEXT, DEFAULT_PURCHASE_LINK_OPEN_TEXT, DEFAULT_PURCHASE_PAID_BOOKED_TEXT,
  DEFAULT_PURCHASE_PAID_CLASS_GONE_TEXT, DEFAULT_PURCHASE_PAID_BOOKING_FAILED_TEXT,
  DEFAULT_PURCHASE_PAID_NO_CLASS_TEXT, DEFAULT_PAY_DONE_PAGE_TEXT, DEFAULT_PAY_CANCEL_PAGE_TEXT,
} from '@/lib/agent/default-copy'

export const HATCH_COPY_GROUP_TITLE = 'Hatch payments and booking'

const PRODUCT = '{product} becomes what is being bought.'
const CLASS = '{class} becomes the class and its time.'

export const HATCH_COPY_FIELDS = Object.freeze([
  { key: 'chat_booking_unavailable_text', label: 'Chat booking not available message', placeholder: DEFAULT_CHAT_BOOKING_UNAVAILABLE_TEXT,
    help: '{studio} becomes the studio name and {link} its booking link. With no booking link, a text that needs {link} is not used: the customer is told the team will help them book.' },
  { key: 'purchase_offer_intro_text', label: 'Offer intro (customer has no classes left)', placeholder: DEFAULT_PURCHASE_OFFER_INTRO_TEXT,
    help: 'Sent above the list of ways to keep training.' },
  { key: 'purchase_link_text', label: 'Payment link message', placeholder: DEFAULT_PURCHASE_LINK_TEXT,
    help: `${PRODUCT} ${CLASS} With no class to book, a text that needs {class} is not used and Mia says she will let them know when it is done.` },
  { key: 'trial_used_text', label: 'Free trial already used message', placeholder: DEFAULT_TRIAL_USED_TEXT,
    help: 'Sent when someone asks for the free trial but has had it before.' },
  { key: 'refund_request_text', label: 'Refund request message', placeholder: DEFAULT_REFUND_REQUEST_TEXT,
    help: 'Sent when a customer asks for a refund. The request goes to the team as an approval; Mia never refunds.' },
  { key: 'purchase_link_open_text', label: 'Payment link already open message', placeholder: DEFAULT_PURCHASE_LINK_OPEN_TEXT,
    help: `Sent when the customer asks for a link they already have waiting. ${PRODUCT}` },
  { key: 'purchase_paid_booked_text', label: 'Paid and booked message', placeholder: DEFAULT_PURCHASE_PAID_BOOKED_TEXT, help: CLASS },
  { key: 'purchase_paid_class_gone_text', label: 'Paid but class gone message', placeholder: DEFAULT_PURCHASE_PAID_CLASS_GONE_TEXT, help: CLASS },
  { key: 'purchase_paid_booking_failed_text', label: 'Paid but booking failed message', placeholder: DEFAULT_PURCHASE_PAID_BOOKING_FAILED_TEXT, help: CLASS },
  { key: 'purchase_paid_no_class_text', label: 'Paid with no class chosen message', placeholder: DEFAULT_PURCHASE_PAID_NO_CLASS_TEXT,
    help: 'Sent when payment arrives for a purchase that was not tied to a class.' },
  { key: 'pay_done_page_text', label: 'Payment done page text', placeholder: DEFAULT_PAY_DONE_PAGE_TEXT,
    help: 'Shown on the page the customer lands on after paying.' },
  { key: 'pay_cancel_page_text', label: 'Payment cancelled page text', placeholder: DEFAULT_PAY_CANCEL_PAGE_TEXT,
    help: 'Shown on the page the customer lands on if they back out of paying.' },
])
