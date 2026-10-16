// WASTUDIOPICK.1 — the structured signals for an unknown sender's studio
// (spec R2.1, R2.2, R5). Each returns one listed studio id or null; a failed
// read is null, logged (the next signal or the picker takes over).
import { logWarn } from '../log'
import { PICKER_ID_PREFIX } from './config'

export async function adSignal(db, referral, studioIds) {
  if (!referral || referral.source_type !== 'ad' || !referral.source_id || !studioIds?.length) return null
  try {
    const { data, error } = await db.from('ad_entities').select('location_id')
      .eq('level', 'ad').eq('external_id', String(referral.source_id)).in('location_id', studioIds)
    if (error) throw error
    const ids = [...new Set((data || []).map((r) => r.location_id))]
    return ids.length === 1 ? ids[0] : null
  } catch (e) {
    logWarn('wa-studio-pick', 'ad lookup failed', { err: e?.message || String(e) })
    return null
  }
}

export async function replySignal(db, contextId, studioIds) {
  if (!contextId || !studioIds?.length) return null
  try {
    const { data, error } = await db.from('whatsapp_messages').select('location_id')
      .eq('wa_message_id', String(contextId)).in('location_id', studioIds).limit(1)
    if (error) throw error
    return data?.[0]?.location_id || null
  } catch (e) {
    logWarn('wa-studio-pick', 'reply-context lookup failed', { err: e?.message || String(e) })
    return null
  }
}

export function tapSignal(message, studioIds) {
  if (message?.type !== 'interactive') return null
  const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || ''
  if (!id.startsWith(PICKER_ID_PREFIX)) return null
  const studioId = id.slice(PICKER_ID_PREFIX.length)
  return studioIds?.includes(studioId) ? studioId : null
}
