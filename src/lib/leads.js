// Pure helpers for the public waitlist / lead-capture form.
// Consumed by POST /api/public/leads. No DB, no side effects — unit-tested.

import { z } from 'zod'
import { isValidMobileNumber } from '@/lib/phone-validate'

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
    .refine(isValidMobileNumber, 'Enter a valid mobile number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick the consent box to continue' }),
  public_path: z.string().trim().min(1).max(120),
  // Optional campaign key (paid-traffic landing pages). Validated
  // against the LEAD_CAMPAIGNS allowlist server-side — an unknown or
  // studio-mismatched value is ignored, never trusted to set a tag.
  campaign: z.string().trim().min(1).max(80).optional(),
})

// Normalise a validated body into the fields the handler stores.
export function normaliseLead(data) {
  return {
    firstName: data.first_name.trim(),
    email: data.email.toLowerCase().trim(),
    phone: data.phone.trim(),
    publicPath: data.public_path.trim(),
    campaign: data.campaign ? data.campaign.trim() : null,
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

// ─────────────────────────────────────────────────────────────
// Campaign registry — paid-traffic landing pages (e.g. the Meta
// "3 free classes" page) capture leads with their own attribution
// without an editable landing_page_settings row (that table is
// one-row-per-location). Keyed by an opaque slug the page sends; the
// client can ONLY pick from this allowlist, so it can't inject an
// arbitrary tag/source or target another studio.
//
//   locationPublicPath — the studio the lead belongs to. The route
//     requires the submitted public_path to MATCH this before applying
//     the override, so a campaign can't be replayed at the wrong studio.
//   tag / leadSource — override the block-derived nurture tag +
//     attribution for leads captured on that page.
// ─────────────────────────────────────────────────────────────
export const LEAD_CAMPAIGNS = {
  'stillorgan-free-class': {
    locationPublicPath: 'stillorgan',
    tag: 'stillorgan-free-trial',
    leadSource: 'meta_free_trial',
    // First-touch WhatsApp: the instant the lead signs up, send this
    // APPROVED template (asks consultation vs first class via quick-reply
    // buttons); the reply hands off to the Mia agent who books it. Name
    // must match a whatsapp_templates row at the campaign's location.
    whatsappTemplate: 'meta_ad_whatsapp_lead',
  },
}

// Resolve a campaign slug to its config, or null when unknown.
export function resolveCampaign(key) {
  if (typeof key !== 'string') return null
  return Object.prototype.hasOwnProperty.call(LEAD_CAMPAIGNS, key) ? LEAD_CAMPAIGNS[key] : null
}
