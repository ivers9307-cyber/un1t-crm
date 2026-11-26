'use client'

// TYPOHINT.1 — a one-line "Did you mean …?" under an email box when the
// domain looks like a typo of a common provider (src/lib/email-typo.js).
// Tapping it fills the corrected address; ignoring it changes nothing.
// Styling is inherited so it sits in light and dark funnels alike.

import { suggestEmailFix } from '@/lib/email-typo'

export default function EmailTypoHint({ email, onAccept, className = '' }) {
  const fix = suggestEmailFix(email)
  if (!fix) return null
  return (
    <p className={`text-xs ${className}`} role="status">
      Did you mean{' '}
      <button type="button" onClick={() => onAccept(fix)} className="underline font-medium">
        {fix}
      </button>
      ?
    </p>
  )
}
