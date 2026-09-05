// CANCEL-FORM.2 — the cancellation form's constants: reason codes and the
// customer-facing defaults. NO imports on purpose: the settings editor (a
// client component) renders these as placeholders, so this file must be
// safe to ship to the browser. Behaviour (resolve/render) lives in copy.js.

// Structured reason codes the form offers. Glofox's enum mapping lives in
// lib/glofox.js (GLOFOX_CANCELLATION_REASONS); the labels below are what the
// member sees and are operator-editable per code.
export const REASON_CODES = Object.freeze([
  'price', 'moving', 'not_using', 'service', 'schedule', 'change_membership', 'injury_health', 'other',
])

export const CANCELLATION_FORM_DEFAULTS = Object.freeze({
  // Form page
  form_intro: 'Hi {first_name}. Use this page to pause or cancel your {plan} membership. Nothing changes until the team confirms it with you.',
  pause_offer_enabled: true,
  pause_offer_text: 'Before you go: you can pause your membership instead. Pick the dates that suit and we will hold your place.',
  pause_max_weeks: 8,
  reason_labels: Object.freeze({
    price: 'The price',
    moving: 'I am moving away',
    not_using: 'I am not using it enough',
    service: 'An experience with the team',
    schedule: 'The timetable does not suit me',
    change_membership: 'I want a different membership',
    injury_health: 'Injury or health',
    other: 'Something else',
  }),
  end_date_help_text: 'Choose the date you would like your membership to end. Your membership terms may apply.',
  notice_days: 0,
  confirm_text: 'Please check the details below. The team will review this and confirm with you.',
  thanks_cancel_text: 'Thanks {first_name}. We have your request and will confirm shortly.',
  thanks_pause_text: 'Thanks {first_name}. We have your pause request from {start_date} to {end_date} and will confirm shortly.',
  // Link delivery
  email_subject: 'Your membership with {location}',
  email_body: 'Hi {first_name},\n\nAs requested, here is the link to pause or cancel your membership. It takes about a minute.\n\n{link}\n\nNothing changes until we confirm it with you.\n\n{location}',
  whatsapp_text: 'Hi {first_name}, as requested here is the link to pause or cancel your membership. It takes about a minute and nothing changes until we confirm it with you.',
  whatsapp_button_text: 'Open form',
  // Approved UTILITY template with a dynamic URL button, for links sent
  // outside the 24h WhatsApp window. Null = in-window sends only.
  whatsapp_template_name: null,
  // Decision confirmations (sent on the channel the link went out on)
  cancel_confirmation_text: 'Hi {first_name}, we have received your cancellation and your membership will end on {end_date}. Thanks for training with us, you are welcome back any time.',
  pause_confirmation_text: 'Hi {first_name}, your membership pause from {start_date} to {end_date} is confirmed. See you when you are back.',
  saved_confirmation_text: 'Hi {first_name}, thanks for the chat. Your membership stays as it is. Any questions, just reply here.',
  confirmation_template_cancel: null,
  confirmation_template_pause: null,
  confirmation_template_saved: null,
  // Host the link is built on. Null = getAppUrl() (the CRM host). Set to the
  // marketing host (already allowlisted) to hand members a friendlier URL.
  public_base_url: null,
})

// Keys whose default is a customer-facing string (hygiene-tested).
export const CANCELLATION_FORM_TEXT_KEYS = Object.freeze([
  'form_intro', 'pause_offer_text', 'end_date_help_text', 'confirm_text',
  'thanks_cancel_text', 'thanks_pause_text', 'email_subject', 'email_body',
  'whatsapp_text', 'whatsapp_button_text',
  'cancel_confirmation_text', 'pause_confirmation_text', 'saved_confirmation_text',
])

