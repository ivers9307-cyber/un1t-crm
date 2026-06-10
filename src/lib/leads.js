// Pure helpers for the public waitlist / lead-capture form.
// Consumed by POST /api/public/leads. No DB, no side effects — unit-tested.

import { z } from 'zod'

// Defaults when a lead_form block hasn't overridden them. Hatch's
// founding-member launch is the first use; both are operator-overridable
// per-block via landing-page-blocks.js.
export const DEFAULT_LEAD_TAG = 'hatch-founding-member'
export const DEFAULT_LEAD_SOURCE = 'hatch_launch'

// Public submission shape. NOT strict — extra fields are ignored rather
// than 400'd. This intentionally tolerates a legacy `company` field from
// a browser still running a cached pre-honeypot-removal build, so those
// users validate fine instead of getting rejected.
export const LeadSchema = z.object({
  first_name: z.string().trim().min(1, 'Your name is required').max(120),
  email: z.string().trim().email('Enter a valid email').max(320),
  phone: z.string().trim().min(1, 'Phone number is required').max(50)
    .refine((v) => v.replace(/\D/g, '').length >= 7, 'Enter a valid phone number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick the consent box to continue' }),
  public_path: z.string().trim().min(1).max(120),
})

// Normalise a validated body into the fields the handler stores.
export function normaliseLead(data) {
  return {
    firstName: data.first_name.trim(),
    email: data.email.toLowerCase().trim(),
    phone: data.phone.trim(),
    publicPath: data.public_path.trim(),
  }
}

// Resolve the tag + lead_source from the page's first lead_form block,
// falling back to the defaults. Pure — the handler passes the page's
// blocks JSONB. Keeps tag/source server-derived so the client can't
// inject arbitrary tags.
export function leadConfigFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const lf = list.find((b) => b && typeof b === 'object' && b.type === 'lead_form')
  const tag = (lf && typeof lf.tag === 'string' && lf.tag.trim()) || DEFAULT_LEAD_TAG
  const leadSource = (lf && typeof lf.lead_source === 'string' && lf.lead_source.trim()) || DEFAULT_LEAD_SOURCE
  return { tag, leadSource }
}
