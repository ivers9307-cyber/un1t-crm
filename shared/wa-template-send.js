// WATPLPICKER.1 — what a staff member can send from the WhatsApp inbox
// template picker, and the exact request that sends it.
//
// Pure (no React, no network, no Intl), so the phone loads it under Hermes and
// vitest pins it. Callers: the phone's thread screen, the web inbox picker
// (src/components/WAInbox.jsx, since WATPLSEND.1), and the send route itself
// (POST /api/whatsapp/conversations/[id]/send refuses exactly what
// templateSendBlock blocks, and logs renderSentTemplateBody's text).
//
// Why each rule exists (live on 2026-09-28: 18 approved templates, 17 with body
// variables, one in en_US, one with a FLOW button, one with a dynamic URL
// button):
//   - Meta refuses a template whose {{n}} body variables are not all supplied
//     (132000), so the picker asks for every value and never sends a blank.
//   - Meta looks a template up by name AND language; sending 'en' for an en_US
//     template fails (132001), so the row's own language is sent.
//   - A FLOW button needs a per-send flow_token (131009): the send route mints
//     it from the conversation's contact + studio (WATPLSEND.1), so a FLOW
//     template is sendable. A dynamic URL button needs a per-send value
//     (132012) that only its own automation has, so it is shown but cannot be
//     picked here, and the route refuses it.
//   - A media header is attached by the send route from the row's stored
//     header_media_url; without one Meta refuses the send.

import { templateBodyText } from './wa-template-groups.js'

const PLACEHOLDER_RE = /\{\{([^}]*)\}\}/g

function componentsOf(t) {
  return Array.isArray(t?.components) ? t.components : []
}

function componentOfType(t, type) {
  return componentsOf(t).find((c) => String(c?.type || '').toUpperCase() === type) || null
}

/**
 * The numeric body variables, e.g. [1, 2] for "Hi {{1}}, see you {{2}}".
 * Distinct and ascending; a repeated {{1}} is one slot (Meta reuses the value).
 * Named placeholders ({{first_name}}) are not slots: templateSendBlock refuses them.
 */
export function bodyVariableSlots(t) {
  const slots = new Set()
  for (const m of templateBodyText(t).matchAll(PLACEHOLDER_RE)) {
    const inner = m[1].trim()
    if (/^\d+$/.test(inner)) slots.add(Number(inner))
  }
  return [...slots].sort((a, b) => a - b)
}

/**
 * Why this template cannot be sent from the inbox picker, or null when it can.
 * One of the SEND_BLOCK_TEXT keys.
 */
export function templateSendBlock(t) {
  const header = componentOfType(t, 'HEADER')
  const format = String(header?.format || '').toUpperCase()
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format) && !t?.header_media_url) return 'header_media'
  if (format === 'TEXT' && /\{\{/.test(String(header?.text || ''))) return 'header_value'

  for (const b of componentOfType(t, 'BUTTONS')?.buttons || []) {
    const type = String(b?.type || '').toUpperCase()
    if (type === 'URL' && /\{\{/.test(String(b?.url || ''))) return 'button_value'
    if (type === 'COPY_CODE' || type === 'OTP') return 'button_value'
  }

  const body = templateBodyText(t)
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    if (!/^\d+$/.test(m[1].trim())) return 'named_variables'
  }
  const slots = bodyVariableSlots(t)
  if (slots.some((n, i) => n !== i + 1)) return 'named_variables'
  return null
}

// Shown under a greyed-out row. Plain words; no em-dashes (house rule for
// anything a person reads).
export const SEND_BLOCK_TEXT = Object.freeze({
  header_media: 'Its media header has no stored file, so it cannot be sent from here.',
  header_value: 'Its header needs a value the inbox cannot fill in.',
  button_value: 'Its button needs a per-message value, filled in only by its own automation.',
  named_variables: 'Its variables cannot be filled in from the inbox.',
})

/**
 * Starting values: {{1}} is the contact's first name when we know it (the same
 * guess the web inbox makes). Every value stays editable.
 */
export function initialTemplateValues(t, firstName) {
  const name = typeof firstName === 'string' ? firstName.trim() : ''
  if (!name || !bodyVariableSlots(t).includes(1)) return {}
  return { 1: name }
}

// A filled value as it will be sent: every whitespace run becomes one space.
// Meta refuses a parameter holding a newline, a tab or 4+ spaces in a row
// (132018), and a paste into the field can carry them.
function slotValue(values, n) {
  return typeof values?.[n] === 'string' ? values[n].replace(/\s+/g, ' ').trim() : ''
}

/** The media a template's header attaches ('image' | 'video' | 'document'), or null. */
export function templateHeaderMedia(t) {
  const header = Array.isArray(t?.components)
    ? t.components.find((c) => String(c?.type || '').toUpperCase() === 'HEADER')
    : null
  const format = String(header?.format || '').toUpperCase()
  return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format) ? format.toLowerCase() : null
}

/** The body as the customer will read it; an unfilled slot stays as {{n}}. */
export function renderTemplatePreview(t, values = {}) {
  return templateBodyText(t).replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n) => slotValue(values, n) || whole)
}

/**
 * WATPLLOG.1 — the body text a send delivered, for the thread row. The i-th body
 * parameter fills the i-th DISTINCT slot in ascending order (the mapping
 * buildTemplateSend builds and Meta applies), and every occurrence of {{n}} gets
 * slot n's value. Filling by order of appearance instead logged the wrong text
 * for a template that repeats a variable or puts {{2}} before {{1}}.
 * A slot with no value stays visible as {{n}}. null when there is no body text.
 * Pure and Hermes-safe (a Map, no Object.hasOwn).
 */
export function renderSentTemplateBody(t, templateComponents) {
  const text = templateBodyText(t)
  if (!text) return null
  const list = Array.isArray(templateComponents) ? templateComponents : []
  const bodyComp = list.find((c) => String(c?.type || '').toLowerCase() === 'body')
  const params = Array.isArray(bodyComp?.parameters) ? bodyComp.parameters : []
  const bySlot = new Map()
  bodyVariableSlots(t).forEach((n, i) => {
    const value = params[i]?.text
    if (typeof value === 'string') bySlot.set(n, value)
  })
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n) => (bySlot.has(Number(n)) ? bySlot.get(Number(n)) : whole))
}

/**
 * The body for POST /api/whatsapp/conversations/[id]/send, or the reason it
 * cannot be built yet.
 *   { ok: true, payload: { type, template_name, template_language, template_components } }
 *   { ok: false, blocked: '<SEND_BLOCK_TEXT key>' }
 *   { ok: false, missing: [2, 3] }   (slots still blank)
 * The route attaches a media header itself, so only the body goes here.
 */
export function buildTemplateSend(t, values = {}) {
  const blocked = templateSendBlock(t)
  if (blocked) return { ok: false, blocked }
  const slots = bodyVariableSlots(t)
  const text = (n) => slotValue(values, n)
  const missing = slots.filter((n) => !text(n))
  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    payload: {
      type: 'template',
      template_name: t.name,
      template_language: t.language || 'en',
      template_components: slots.length
        ? [{ type: 'body', parameters: slots.map((n) => ({ type: 'text', text: text(n) })) }]
        : [],
    },
  }
}
