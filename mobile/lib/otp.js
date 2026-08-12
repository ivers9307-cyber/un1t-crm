// mobile/lib/otp.js
// Pure helpers for the emailed login code on /(auth)/login. NO native imports —
// vitest runs this in Node.
//
// MAGIC-LINK.2 shipped the input hard-coded to 6 digits — Supabase's *default*
// OTP length, not this project's. Auth → Sign In / Providers → Email → "Email
// OTP Length" is set to 8 on `iyvtbjjxdggiadzwwvdj`, so `maxLength={6}` ate the
// last two digits of every emailed code and verifyOtp could never succeed:
// passwordless sign-in was dead on mobile from day one, with only the
// break-glass password path working. champ-app — same Supabase project, same
// magic-link template — hit this first and fixed it in champ-app#16 (2026-06-19),
// a month before MAGIC-LINK.2 copied the pre-fix shape.
//
// The length lives here, in one constant, because it mirrors a value set in the
// Supabase dashboard: if that setting ever changes, this is the single line to
// follow it (and the login copy reads from it rather than repeating the digit).

/** Digits in an emailed login code — mirrors the project's Email OTP Length. */
export const EMAIL_OTP_LENGTH = 8

/** Input hint, sized off the constant so it can't drift from `maxLength`. */
export const OTP_PLACEHOLDER = Array.from({ length: EMAIL_OTP_LENGTH }, (_, i) => (i + 1) % 10).join('')

/**
 * Keystrokes/paste → the code we hand to verifyOtp. Digits only (a code pasted
 * out of the email can arrive spaced or hyphenated), capped at the code length.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeOtpInput(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\D/g, '').slice(0, EMAIL_OTP_LENGTH)
}

/**
 * Is the typed code long enough to submit? Exact length, not a minimum — an
 * enabled button on a half-typed code is what made the 6-digit cap look like a
 * wrong code rather than a truncated one.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCompleteOtp(value) {
  return normalizeOtpInput(value).length === EMAIL_OTP_LENGTH
}
