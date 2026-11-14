// STAFFCONSENT.1 — the body staff send to change one studio's marketing email.
import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'

import { STUDIO_CONSENT_REASONS, STUDIO_CONSENT_NOTE_MAX } from '@/lib/studio-consent-reasons'

export { STUDIO_CONSENT_REASONS, STUDIO_CONSENT_NOTE_MAX }

export const StudioConsentSchema = z.object({
  location_id: uuidLike,
  email_marketing: z.boolean(),
  reason: z.enum(STUDIO_CONSENT_REASONS),
  note: z.string().trim().max(STUDIO_CONSENT_NOTE_MAX).optional(),
}).refine((b) => b.reason !== 'other' || (b.note && b.note.length > 0), {
  message: 'A note is required when the reason is other',
  path: ['note'],
})
