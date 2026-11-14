// STAFFCONSENT.1 — the fixed reasons staff give for switching one studio's
// marketing email, and the note limit. Kept apart from the zod schema so the
// contact-page card can import them without pulling zod into the browser.

/** Stored on consent_log.reason. */
export const STUDIO_CONSENT_REASONS = Object.freeze(['in_person', 'phone', 'email', 'signed_form', 'other'])

export const STUDIO_CONSENT_NOTE_MAX = 500
