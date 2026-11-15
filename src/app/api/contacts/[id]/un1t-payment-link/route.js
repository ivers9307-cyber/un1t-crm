// /api/contacts/[id]/un1t-payment-link — staff sends a Hatch Street (un1t.online)
// customer a payment link on WhatsApp (PAYLINK.1).
//
// GET  ?locationId= → what the send card needs: the studio's sellable offers,
//        the latest link, what can be sent right now, a live membership (shown
//        only) and a rendered preview of the operator's copy.
// POST { locationId, offerId }
//      → mints a 7-day link (lib/staff-payment-links), sends it on WhatsApp
//        (cta_url inside the 24h window, else an approved UTILITY template with a
//        dynamic URL button rooted on /buy/), logs the send, returns
//        { linkId, expiresAt, via }.
//
// The CRM never charges a card: the customer opens /buy/<token>, accepts the
// terms themselves and pays on un1t.online's hosted checkout.
//
// Authorization: session + the un1t_payment_links permission AND the WhatsApp
// channel permission, both judged at `locationId` (the Hatch card's studio, which
// may differ from the contact's home studio) + the contact must be visible there
// (home studio, or any contact_studios row). Not gated on marketing consent: a
// payment link a person asked for on the phone is a service message. It IS
// refused when the person is WhatsApp-opted-out at the studio or undeliverable.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { sendCtaUrlMessage, sendTemplateMessage, isWindowOpen, buildTemplateComponents, renderTemplateBody, getOrCreateConversation } from '@/lib/whatsapp'
import { URL_BUTTON_MAPPING_KEY, dynamicUrlButtonIndex } from '@/lib/whatsapp-template-buttons'
import { contactWaPhone, loadSendConversation } from '@/lib/whatsapp-conversations'
import { ownNumberOrRefusal } from '@/lib/whatsapp-own-number'
import { pickTemplateConfig } from '@/lib/whatsapp-config'
import { whatsappErrorStatus } from '@/lib/whatsapp-number-missing'
import { manualTakeoverPatch } from '@/lib/agent/core'
import { canSendUn1tPaymentLink } from '@/lib/un1t-payment-link-access'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { hasRelationshipAt } from '@/lib/contact-studios'
import { listPurchaseOptions } from '@/lib/agent/purchase-intents'
import { isSellableUn1tProduct } from '@/lib/agent/mia-offer-limits'
import { logWarn, logError } from '@/lib/log'
import {
  issueStaffPaymentLink, revokeStaffPaymentLink, buildBuyUrl, productLabel, paymentLinkCopy,
  LIVE_STATUSES,
} from '@/lib/staff-payment-links'

export const runtime = 'nodejs'

const SendSchema = z.object({ locationId: uuidLike, offerId: uuidLike })
const CONTACT_COLUMNS = 'id, name, first_name, email, phone, wa_phone, wa_status, location_id'
const LOCATION_COLUMNS = 'id, name, organization_id, membership_source, settings'
const PRODUCT_COLUMNS = 'id, un1t_id, title, type, status, price_cents, currency, billing_interval, billing_interval_count'
const BLOCKED_WA_STATUSES = ['blocked', 'opted_out', 'undeliverable']
const NEEDS_TEMPLATE_ERROR = 'The 24-hour WhatsApp window has closed and no approved payment-link template is set up for this host. Ask the customer to message the studio first, or configure the template under Settings → un1t.online.'

const json = (body, status = 200) => NextResponse.json(body, { status })
const fail = (error, status, extra = {}) => json({ success: false, error, ...extra }, status)

// ROLESWEEP.1c — the WhatsApp channel judged AT the studio (web OR mobile toggle).
const whatsappPermitted = (user, locationId) =>
  hasPermissionForLocation(user, locationId, 'whatsapp') || hasMobilePermissionForLocation(user, locationId, 'whatsapp')

// The template's dynamic URL button must be rooted on OUR /buy/ page, or the
// token would be handed to another origin.
function buyTemplateUrlOk(template, baseUrl) {
  const comps = template?.components || []
  const idx = dynamicUrlButtonIndex(comps)
  if (idx < 0) return false
  const buttons = (comps.find((c) => String(c?.type || '').toUpperCase() === 'BUTTONS')?.buttons) || []
  const url = String(buttons[idx]?.url || '').trim()
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return !!base && url === `${base}/buy/{{1}}`
}

function templateUsable(template, baseUrl) {
  if (!template) return false
  if (String(template.status || '').toUpperCase() !== 'APPROVED') return false
  if (String(template.category || '').toUpperCase() !== 'UTILITY') return false
  return buyTemplateUrlOk(template, baseUrl)
}

async function loadTemplate(db, locationId, name) {
  if (!name) return null
  const { data: rows } = await db.from('whatsapp_templates')
    .select('name, language, category, status, components, header_media_url, business_account_id')
    .eq('location_id', locationId)
    .eq('name', name)
    .order('created_at', { ascending: false })
    .limit(1)
  return rows?.[0] || null
}

/**
 * Everything the gates before the offer need: the contact (404), the studio
 * (404/403/409). Returns { response } to stop, else { contact, location }.
 */
async function loadGuarded(db, user, contactId, locationId) {
  if (!locationId) return { response: fail('locationId is required', 400) }
  const { data: contact, error } = await db.from('contacts').select(CONTACT_COLUMNS).eq('id', contactId).maybeSingle()
  if (error) {
    logError('paylink', 'contact read failed', { contactId, code: error.code ?? null })
    return { response: fail('Could not read the contact', 500) }
  }
  if (!contact) return { response: fail('Contact not found', 404) }
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return { response: guard }
  // The contact must be visible at THIS studio: its home studio, or any
  // contact_studios row there (ORGCONTACTS: visibility is any relationship).
  if (contact.location_id !== locationId) {
    const rel = await hasRelationshipAt(db, contact.id, [locationId])
    if (!rel.ok) return { response: fail('Could not read the contact', 500) }
    if (!rel.at.has(locationId)) return { response: fail('Contact not found', 404) }
  }
  if (!canSendUn1tPaymentLink(user, locationId) || !whatsappPermitted(user, locationId)) {
    return { response: fail('Forbidden', 403) }
  }
  const { data: location, error: locError } = await db.from('locations')
    .select(LOCATION_COLUMNS).eq('id', locationId).maybeSingle()
  if (locError || !location) {
    logError('paylink', 'studio read failed', { locationId, code: locError?.code ?? null })
    return { response: fail('Could not read the studio', 500) }
  }
  if (location.membership_source !== 'un1t_online') {
    return { response: fail('This studio does not sell through un1t.online.', 409, { code: 'not_a_un1t_studio' }) }
  }
  return { contact, location }
}

/** null when WhatsApp may be sent to this person at this studio, else a reason. */
async function whatsappRefusal(db, contact, locationId) {
  if (BLOCKED_WA_STATUSES.includes(contact.wa_status || '')) {
    return contact.wa_status === 'undeliverable'
      ? 'WhatsApp could not deliver to this number before, so no link was sent.'
      : 'This customer has opted out of WhatsApp.'
  }
  // The link is a service (administrative-family) message: a contact-wide
  // whatsapp_administrative=false refuses it. Missing row = not opted out.
  const { data: admin, error: adminError } = await db.from('contact_preferences')
    .select('whatsapp_administrative')
    .eq('contact_id', contact.id)
    .maybeSingle()
  if (adminError) {
    logWarn('paylink', 'contact WhatsApp preference unreadable', { contactId: contact.id, code: adminError.code ?? null })
    return 'Could not check this customer\'s WhatsApp preferences. Try again in a moment.'
  }
  if (admin && admin.whatsapp_administrative === false) return 'This customer has opted out of WhatsApp.'
  // A studio STOP writes whatsapp_marketing=false on the studio's row (the
  // column defaults TRUE: creating the row is the opt-in).
  const { data: pref, error } = await db.from('contact_location_preferences')
    .select('whatsapp_marketing')
    .eq('contact_id', contact.id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) {
    // Unknown is not "fine to send": a STOP we cannot see must not be overridden.
    logWarn('paylink', 'studio WhatsApp preference unreadable', { contactId: contact.id, locationId, code: error.code ?? null })
    return 'Could not check this customer\'s WhatsApp preferences. Try again in a moment.'
  }
  if (pref && pref.whatsapp_marketing === false) return 'This customer has opted out of WhatsApp at this studio.'
  return null
}

/** Offers + recurring flag (listPurchaseOptions returns no product type). */
async function offersWithType(db, locationId) {
  const { offers } = await listPurchaseOptions(db, locationId)
  if (!offers.length) return []
  const { data: rows, error } = await db.from('mia_purchase_offers')
    .select('id, un1t_product_row_id')
    .eq('location_id', locationId)
    .in('id', offers.map((o) => o.offer_id))
  if (error) throw new Error(`offer rows unreadable (${error.code ?? 'no code'})`)
  const productIds = [...new Set((rows || []).map((r) => r.un1t_product_row_id).filter(Boolean))]
  const { data: products, error: pError } = productIds.length
    ? await db.from('un1t_products').select('id, type').eq('location_id', locationId).in('id', productIds)
    : { data: [], error: null }
  if (pError) throw new Error(`offer products unreadable (${pError.code ?? 'no code'})`)
  const typeByProduct = new Map((products || []).map((p) => [p.id, p.type]))
  const productByOffer = new Map((rows || []).map((r) => [r.id, r.un1t_product_row_id]))
  return offers.map((o) => ({
    offer_id: o.offer_id,
    title: o.title,
    price_label: o.price_label,
    recurring: typeByProduct.get(productByOffer.get(o.offer_id)) === 'recurring',
  }))
}

export async function GET(request, props) {
  const { id: contactId } = await props.params
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorized', 401)
  const locationId = new URL(request.url).searchParams.get('locationId')

  const db = createServerClient()
  const g = await loadGuarded(db, user, contactId, locationId)
  if (g.response) return g.response
  const { contact, location } = g
  const settings = un1tWriteSettingsFrom(location.settings)
  const copy = paymentLinkCopy(location.settings?.un1t_online?.payment_link)

  let offers
  try {
    offers = await offersWithType(db, locationId)
  } catch (e) {
    logError('paylink', 'offers unreadable', { locationId, errClass: e?.name })
    return fail('Could not read the studio\'s offers', 500)
  }

  const baseUrl = await resolveCustomerBaseUrl(db, locationId)
  const [latestRes, template, convRes, memberRes, refusal] = await Promise.all([
    db.from('staff_payment_links')
      .select('status, product_title, created_at, paid_at, expires_at')
      .eq('location_id', locationId).eq('contact_id', contact.id)
      .order('created_at', { ascending: false }).limit(1),
    loadTemplate(db, locationId, copy.template_name),
    db.from('whatsapp_conversations')
      .select('id, window_expires_at')
      .eq('contact_id', contact.id).eq('location_id', locationId)
      .order('last_message_at', { ascending: false, nullsFirst: false }).limit(1),
    db.from('contact_studios')
      .select('membership_plan')
      .eq('contact_id', contact.id).eq('location_id', locationId).eq('membership_status', 'active')
      .limit(1),
    whatsappRefusal(db, contact, locationId),
  ])
  const latest = latestRes?.data?.[0] || null
  const conversation = convRes?.data?.[0] || null
  const member = memberRes?.data?.[0] || null
  const hasEmail = !!contact.email
  const hasPhone = !!(contact.wa_phone || contact.phone)
  const windowOpen = !!conversation && isWindowOpen(conversation)
  const templateReady = templateUsable(template, baseUrl)

  return json({
    success: true,
    data: {
      first_name: contact.first_name || null,
      offers,
      latest: latest
        ? { status: latest.status, product_title: latest.product_title, created_at: latest.created_at, paid_at: latest.paid_at, expires_at: latest.expires_at }
        : null,
      can: {
        send: settings.writesEnabled && hasEmail && hasPhone && !refusal && (windowOpen || templateReady),
        has_email: hasEmail,
        has_phone: hasPhone,
        window_open: windowOpen,
        template_ready: templateReady,
      },
      live_membership: member ? { plan: member.membership_plan || null } : null,
      preview_text: renderCopyText(copy.whatsapp_text, { first_name: contact.first_name || '', studio: location.name || '', product: '{product}' }),
    },
  })
}

function renderCopyText(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
}

export async function POST(request, props) {
  const { id: contactId } = await props.params
  const user = await getCurrentUser()
  if (!user) return fail('Unauthorized', 401)

  const v = await validateBody(request, SendSchema)
  if (!v.ok) return v.response
  const { locationId, offerId } = v.data

  const db = createServerClient()
  const g = await loadGuarded(db, user, contactId, locationId)
  if (g.response) return g.response
  const { contact, location } = g

  if (!un1tWriteSettingsFrom(location.settings).writesEnabled) {
    return fail('un1t.online is not switched on for this studio.', 409, { code: 'writes_disabled' })
  }
  if (!contact.email) {
    return fail('Add an email to this contact first — un1t.online needs it for the account.', 400)
  }
  if (!contact.wa_phone && !contact.phone) return fail('Contact has no phone number on file', 400)
  const refusal = await whatsappRefusal(db, contact, locationId)
  if (refusal) return fail(refusal, 409, { code: 'whatsapp_refused' })

  // The offer: a sellable offer of THIS studio, resolved to its product row.
  let product
  try {
    const { offers } = await listPurchaseOptions(db, locationId)
    if (!offers.some((o) => o.offer_id === offerId)) return fail('offer_not_available', 400)
    const { data: offer, error: offerError } = await db.from('mia_purchase_offers')
      .select('id, un1t_product_row_id').eq('location_id', locationId).eq('id', offerId).maybeSingle()
    if (offerError) throw new Error('offer unreadable')
    if (!offer) return fail('offer_not_available', 400)
    const { data: row, error: productError } = await db.from('un1t_products')
      .select(PRODUCT_COLUMNS).eq('location_id', locationId).eq('id', offer.un1t_product_row_id).maybeSingle()
    if (productError) throw new Error('product unreadable')
    product = row
  } catch (e) {
    logError('paylink', 'offer read failed', { locationId, errClass: e?.name })
    return fail('Could not read the studio\'s offers', 500)
  }
  if (!isSellableUn1tProduct(product) || !product.un1t_id) return fail('offer_not_available', 400)

  const copy = paymentLinkCopy(location.settings?.un1t_online?.payment_link)
  const baseUrl = await resolveCustomerBaseUrl(db, locationId)

  // WACONFIGFALLBACK.1 — the studio's own WhatsApp number, before a thread or link exists.
  const own = await ownNumberOrRefusal(locationId, 'paylink-send')
  if (!own.ok) return fail(own.error, own.status)
  const numberConfig = own.config

  const waPhone = contactWaPhone(contact)
  const opened = await loadSendConversation(db,
    await getOrCreateConversation(db, { ...contact, wa_phone: waPhone }, locationId))
  if (!opened.ok) return fail(opened.error, opened.status)
  const conversation = opened.conversation

  let template = null
  if (!isWindowOpen(conversation)) {
    template = await loadTemplate(db, locationId, copy.template_name)
    if (!templateUsable(template, baseUrl)) {
      return fail(NEEDS_TEMPLATE_ERROR, 409, { window_expired: true, needs_template: true, code: 'needs_template' })
    }
  }

  const issued = await issueStaffPaymentLink(db, {
    locationId,
    organizationId: location.organization_id,
    contactId: contact.id,
    product: { un1t_id: product.un1t_id, title: product.title, price_cents: product.price_cents },
    createdBy: user.id,
  })
  if (!issued.ok) {
    logError('paylink', 'link issue failed', { contactId: contact.id, locationId, detail: String(issued.error || '').slice(0, 200) })
    return fail('Could not create the payment link. Please try again.', 500)
  }

  const url = buildBuyUrl(baseUrl, issued.token)
  const label = productLabel(product)
  const firstName = contact.first_name || (contact.name || '').split(' ')[0] || ''
  let via
  let result
  let messageType
  let body
  let templateName = null
  // Only the Meta send can revoke the link: after it succeeds the customer holds it.
  try {
    if (!template) {
      via = 'cta'
      body = renderCopyText(copy.whatsapp_text, { first_name: firstName, studio: location.name || '', product: label })
      result = await sendCtaUrlMessage(waPhone, { bodyText: body, buttonText: copy.button_text, url }, { config: numberConfig })
      messageType = 'interactive'
    } else {
      via = 'template'
      const components = buildTemplateComponents(template, contact, { '1': 'first_name', '2': label, [URL_BUTTON_MAPPING_KEY]: issued.token }, null, { locationId })
      const held = pickTemplateConfig(null, numberConfig, template.business_account_id || null)
      result = await sendTemplateMessage(waPhone, template.name, template.language || 'en', components,
        held ? { config: held } : { locationId, businessAccountId: template.business_account_id })
      messageType = 'template'
      templateName = template.name
    }
  } catch (e) {
    await revokeStaffPaymentLink(db, issued.linkId, e?.message || 'send failed')
    return fail(e?.message || 'Failed to send the payment link', whatsappErrorStatus(e, 502))
  }

  // Everything below is best-effort: the link is already delivered, so a
  // failure here is logged and never revokes it.
  try {
    if (templateName) {
      body = renderTemplateBody(template, { ...contact, first_name: firstName }, { '1': 'first_name', '2': label }, { locationId }) || `[Template: ${template.name}]`
    }
    const nowIso = new Date().toISOString()
    // The body never carries the token or URL (the URL rides the button).
    const { error: msgErr } = await db.from('whatsapp_messages').insert({
      conversation_id: conversation.id,
      contact_id: contact.id,
      location_id: locationId,
      wa_message_id: result.messageId,
      direction: 'outbound',
      message_type: messageType,
      body,
      template_name: templateName,
      status: 'sent',
      sent_by: user.id,
      sent_at: nowIso,
    })
    if (msgErr) logError('paylink', 'whatsapp_messages insert failed', { linkId: issued.linkId, code: msgErr.code ?? null })
    // A staff send is a human take-over: pause Mia in this thread.
    const { error: convErr } = await db.from('whatsapp_conversations').update({
      last_message_at: nowIso,
      last_message_direction: 'outbound',
      last_message_preview: String(body).substring(0, 100),
      ...manualTakeoverPatch(conversation.agent_handed_off_at),
    }).eq('id', conversation.id).select('id')
    if (convErr) logError('paylink', 'conversation update failed', { linkId: issued.linkId, code: convErr.code ?? null })
    const { error: stampErr } = await db.from('staff_payment_links')
      .update({ whatsapp_message_id: result.messageId, updated_at: new Date().toISOString() })
      .eq('id', issued.linkId)
      .in('status', LIVE_STATUSES)
    if (stampErr) logWarn('paylink', 'whatsapp_message_id stamp failed', { linkId: issued.linkId, code: stampErr.code ?? null })
    const { error: actErr } = await db.from('activities').insert({
      contact_id: contact.id,
      location_id: locationId,
      type: 'un1t_payment_link_sent',
      subject: `Payment link sent on WhatsApp: ${label}`,
      note: null,
      created_by: user.id,
    })
    if (actErr) logWarn('paylink', 'activity insert failed', { linkId: issued.linkId, code: actErr.code ?? null })
  } catch (e) {
    logError('paylink', 'post-send bookkeeping threw', { linkId: issued.linkId, errClass: e?.name })
  }

  return json({ success: true, data: { linkId: issued.linkId, expiresAt: issued.expiresAt, via } })
}
