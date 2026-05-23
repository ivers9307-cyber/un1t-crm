// RADAR-OUTREACH.1 — one-click WhatsApp utility-template outreach
// from the Churn Radar and Lead Radar.
//
// The radar action routes call sendRadarOutreach() to send an
// operator-selected WhatsApp template to a contact. WhatsApp *template*
// messages — unlike free text — deliver outside the 24h customer-
// service window, which is essential here: the radar's whole
// population is people who've gone quiet, so none of them have an
// open window.
//
// Only APPROVED, UTILITY-category templates are sendable from the
// radar. This is *utility* outreach, not marketing — so there is no
// marketing-consent gate, and the operator can never pick a marketing
// template (the list endpoint + sendRadarOutreach both enforce it).
//
// The pure helpers (extract / sendable / components) are split out for
// unit testing; sendRadarOutreach does the DB lookup + the send.

import { sendTemplateMessage } from '@/lib/whatsapp'

/**
 * Pull the body text + variable shape out of a whatsapp_templates
 * `components` array (the Meta template definition).
 *
 * v1 supports only numeric positional placeholders ({{1}}). A named
 * placeholder ({{first_name}}) or a media header can't be auto-filled,
 * so they're flagged and the template is treated as not sendable.
 *
 * @param {object[]} components
 * @returns {{ bodyText: string, varCount: number, hasMediaHeader: boolean, hasNamedVars: boolean }}
 */
export function extractTemplateBody(components) {
  const list = Array.isArray(components) ? components : []
  let bodyText = ''
  let hasMediaHeader = false
  for (const c of list) {
    const type = String(c?.type || '').toUpperCase()
    if (type === 'BODY') {
      bodyText = typeof c?.text === 'string' ? c.text : ''
    } else if (type === 'HEADER') {
      // A non-TEXT header (image / video / document) needs a runtime
      // media parameter v1 can't supply.
      if (String(c?.format || 'TEXT').toUpperCase() !== 'TEXT') hasMediaHeader = true
    }
  }

  const numeric = new Set()
  let hasNamedVars = false
  for (const placeholder of bodyText.match(/\{\{[^}]+\}\}/g) || []) {
    const inner = placeholder.slice(2, -2).trim()
    if (/^\d+$/.test(inner)) numeric.add(inner)
    else hasNamedVars = true
  }

  return { bodyText, varCount: numeric.size, hasMediaHeader, hasNamedVars }
}

/**
 * Can this whatsapp_templates row be sent as one-click radar
 * outreach? It must be an APPROVED, UTILITY-category template whose
 * body has at most one numeric variable, no media header and no named
 * variables.
 *
 * @param {object} template  a whatsapp_templates row
 * @returns {boolean}
 */
export function isSendableUtilityTemplate(template) {
  if (!template) return false
  if (String(template.status || '').toUpperCase() !== 'APPROVED') return false
  if (String(template.category || '').toUpperCase() !== 'UTILITY') return false
  const { varCount, hasMediaHeader, hasNamedVars } = extractTemplateBody(template.components)
  return varCount <= 1 && !hasMediaHeader && !hasNamedVars
}

/**
 * Build the `components` array sendTemplateMessage() needs for the
 * body. A zero-variable template needs nothing; a one-variable
 * template gets the contact's first name.
 *
 * @param {number} varCount
 * @param {string} firstName
 * @returns {object[]}
 */
export function buildBodyComponents(varCount, firstName) {
  if (!varCount || varCount < 1) return []
  const name = (firstName && String(firstName).trim()) || 'there'
  return [{ type: 'body', parameters: [{ type: 'text', text: name }] }]
}

/** First name from a contact row, with a friendly fallback. */
function firstNameOf(contact) {
  if (contact?.first_name && String(contact.first_name).trim()) {
    return String(contact.first_name).trim()
  }
  const fromName = String(contact?.name || '').trim().split(/\s+/)[0]
  return fromName || 'there'
}

/**
 * Send an operator-selected WhatsApp utility template to a radar
 * contact. Looks the template up in whatsapp_templates (scoped to the
 * location), re-verifies server-side that it is a sendable UTILITY
 * template — never trusting the client's pick — resolves the WhatsApp
 * number and sends.
 *
 * @param {object} args
 * @param {object} args.db            Supabase server client
 * @param {object} args.contact       { name, first_name, wa_phone, phone }
 * @param {string} args.templateName
 * @param {string} args.locationId
 * @returns {Promise<{ messageId: string|null, templateName: string }>}
 * @throws  {Error} with a human-readable message on any failure
 */
export async function sendRadarOutreach({ db, contact, templateName, locationId }) {
  if (!templateName) throw new Error('Pick a template to send.')
  const to = contact?.wa_phone || contact?.phone
  if (!to) throw new Error('This contact has no phone number on file.')

  // A template name can exist in more than one language row — take
  // the most recent. maybeSingle() would throw on >1, so limit(1).
  const { data: rows, error } = await db
    .from('whatsapp_templates')
    .select('name, language, category, status, components')
    .eq('location_id', locationId)
    .eq('name', templateName)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  const template = rows?.[0]
  if (!template) throw new Error('That template was not found for this location.')
  if (!isSendableUtilityTemplate(template)) {
    throw new Error('That template is not an approved utility template that can be sent from the radar.')
  }

  const { varCount } = extractTemplateBody(template.components)
  const components = buildBodyComponents(varCount, firstNameOf(contact))

  const res = await sendTemplateMessage(
    to,
    template.name,
    template.language || 'en',
    components,
    { locationId },
  )
  return { messageId: res?.messageId || null, templateName: template.name }
}
