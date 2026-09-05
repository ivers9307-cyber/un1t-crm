// Get-or-create a contact's whatsapp_conversations row for a STAFF send.
//
// CANCEL-FORM.4 — extracted verbatim from /api/contacts/[id]/whatsapp so the
// cancellation-form send route opens the same conversation the composer does
// (one thread per contact, races onto the wa_phone + location unique).
//
// Returns { ok:true, conversation, waPhone } or { ok:false, error, status }.

export async function getOrCreateContactConversation(db, contact) {
  const phone = contact?.wa_phone || contact?.phone
  if (!phone) return { ok: false, status: 400, error: 'Contact has no phone number on file' }
  // Meta wants the number without a leading '+'.
  const waPhone = phone.startsWith('+') ? phone.slice(1) : phone

  const { data: existing } = await db
    .from('whatsapp_conversations')
    .select('id, window_expires_at, location_id, agent_handed_off_at')
    .eq('contact_id', contact.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  let conversation = existing?.[0] || null

  if (!conversation) {
    const { data: created, error: convErr } = await db
      .from('whatsapp_conversations')
      .insert({
        location_id: contact.location_id,
        contact_id: contact.id,
        wa_phone: waPhone,
        status: 'active',
      })
      .select('id, window_expires_at, location_id, agent_handed_off_at')
      .single()
    if (created) {
      conversation = created
    } else {
      // Unique-constraint race on wa_phone — adopt the existing row.
      const { data: byPhone } = await db
        .from('whatsapp_conversations')
        .select('id, window_expires_at, location_id, agent_handed_off_at')
        .eq('wa_phone', waPhone)
        .eq('location_id', contact.location_id)
        .limit(1)
      conversation = byPhone?.[0] || null
      if (conversation) {
        await db.from('whatsapp_conversations').update({ contact_id: contact.id }).eq('id', conversation.id)
      }
    }
    if (!conversation) {
      return { ok: false, status: 500, error: convErr?.message || 'Could not open a conversation' }
    }
  }
  return { ok: true, conversation, waPhone }
}
