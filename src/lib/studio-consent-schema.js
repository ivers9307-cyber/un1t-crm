// STAFFCONSENT.1 — the body staff send to change one studio's marketing email.
import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'

/** Why staff made the change. Shown in the reason dialog; stored on consent_log.reason. */
export const STUDIO_CONSENT_REASONS = Object.freeze(['in_person', 'phone', 'email', 'signed_form', 'other'])

export const STUDIO_CONSENT_NOTE_MAX = 500

export const StudioConsentSchema = z.object({
  location_id: uuidLike,
  email_marketing: z.boolean(),
  reason: z.enum(STUDIO_CONSENT_REASONS),
  note: z.string().trim().max(STUDIO_CONSENT_NOTE_MAX).optional(),
}).refine((b) => b.reason !== 'other' || (b.note && b.note.length > 0), {
  message: 'A note is required when the reason is other',
  path: ['note'],
})
