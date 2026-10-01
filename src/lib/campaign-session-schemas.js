// MEMBERWRITESWEEP.1e — request schemas for the campaign editor's session
// routes (/api/communications/campaigns*). Pure (zod only), so
// src/lib/openapi.js can register them without importing the routes' gate.

import { z } from 'zod'
import { uuidLike, email, audienceFilterSchema } from '@/lib/schemas'

// The editor's payload. Bounds are CampaignCreateSchema's
// (src/app/api/campaigns/route.js) and the DB CHECKs (mig 398: A/B pct 5-50,
// wait 1-24 h; postmark_stream broadcast|outbound). created_by, status,
// scheduled_at and location_id are NOT here: zod strips them, so a body can
// never set them through a save (DECISION 3: created_by stays the creator).
export const CampaignContentSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().max(500).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  from_name: z.string().max(100).nullable().optional(),
  from_email: email.nullable().optional(),
  reply_to: email.nullable().optional(),
  design_json: z.unknown().optional(),
  html_content: z.string().max(1_000_000).nullable().optional(),
  audience_filter: audienceFilterSchema,
  postmark_stream: z.enum(['broadcast', 'outbound']).optional(),
  ab_subject_b: z.string().min(1).max(500).nullable().optional(),
  ab_test_pct: z.number().int().min(5).max(50).optional(),
  ab_wait_hours: z.number().int().min(1).max(24).optional(),
})

export const CampaignCreateSchema = CampaignContentSchema.extend({
  location_id: uuidLike,
  name: z.string().trim().min(1).max(200),
})

export const CampaignScheduleSchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }),
})

export const CONTENT_FIELDS = Object.freeze(Object.keys(CampaignContentSchema.shape))

/** Only the content fields the body actually carried (a partial save never blanks the rest). */
export function contentPatch(data) {
  const out = {}
  for (const k of CONTENT_FIELDS) if (data[k] !== undefined) out[k] = data[k]
  return out
}
