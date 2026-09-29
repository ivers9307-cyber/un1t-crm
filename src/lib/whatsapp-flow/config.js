/**
 * WATPLSEND.1 — THE flow_token format: `<contactId>.<locationId>`. Mint every
 * token with this (template sends, broadcasts, sequences); resolveFlowConfigByToken
 * below is its only reader. null when either half is missing, so a caller can
 * refuse the send rather than hand Meta a token the endpoint cannot resolve.
 */
export function flowTokenFor(contactId, locationId) {
  if (!contactId || !locationId) return null
  return `${contactId}.${locationId}`
}

// Resolve a flow_token (see flowTokenFor) back to the contact + the location's
// whatsapp_flow settings. Ping (health check)
// carries no token, so this returns an empty fallback for it.
export async function resolveFlowConfigByToken(db, flowToken) {
  const fallback = { contact: null, locationId: null, config: {} }
  if (!flowToken || !flowToken.includes('.')) return fallback
  const [contactId, locationId] = flowToken.split('.')
  const [{ data: contact }, { data: loc }] = await Promise.all([
    db.from('contacts').select('id, name, first_name, last_name, email, phone').eq('id', contactId).maybeSingle(),
    db.from('locations').select('settings').eq('id', locationId).maybeSingle(),
  ])
  const config = loc?.settings?.whatsapp_flow || {}
  const resolvedContact = contact
    ? { ...contact, name: contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') }
    : null
  return { contact: resolvedContact, locationId, config }
}
