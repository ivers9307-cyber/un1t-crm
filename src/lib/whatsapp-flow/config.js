// A flow_token is minted per send as `<contactId>.<locationId>`. Resolve it back
// to the contact + the location's whatsapp_flow settings. Ping (health check)
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
