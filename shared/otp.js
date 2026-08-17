// shared/otp.js
// Pure helpers for the emailed login code on mobile/app/(auth)/login.jsx.
// Web doesn't use them — it sends a magic *link* and verifies the token_hash on
// /auth/callback, so it never asks anyone for digits.
//
// The length mirrors a value set in the Supabase dashboard, not anything in
// this repo: Auth -> Sign In / Providers -> Email -> "Email OTP Length" is 8 on
// the shared project (`iyvtbjjxdggiadzwwvdj`), NOT supabase's documented
// default of 6. That gap has now bitten both apps on the project — this one in
// #16 (the input was capped at 6 and ate the last two digits), and un1t-crm's
// staff app the same way a month later. Keeping the length in one exported
// constant is what makes a dashboard change a one-line follow instead of a
// hunt through screens, placeholders and copy.

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
 * Is the typed code long enough to submit? Exact length, not a minimum. #16
 * widened the input to 8 but left the gate at `>= 6`, so a member who stopped
 * at six digits got a live button and a rejection — the same "wrong code"
 * dead-end the truncation bug produced, for the opposite reason.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCompleteOtp(value) {
  return normalizeOtpInput(value).length === EMAIL_OTP_LENGTH
}
