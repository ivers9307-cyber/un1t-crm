// INBOXFOLLOW.2 — who has this thread, for the "Handled by" label.
//
// The first name of the thread's assignee; failing that, of the person who sent
// the newest staff message (WhatsApp only: instagram_messages carries no
// sender). Read only when a person has the thread. Best effort: any failed read
// answers null (the label then says "A coach"), never a failed thread load.
// profiles has no client grant, so the name is resolved here with a narrow
// select (id, full_name); a tombstoned profile gives null.

import { handledBy } from '@/lib/inbox-queues'
import { excludeTombstones } from '@/lib/staff-tombstone'
import { logWarn } from '@/lib/log'

const LOG = 'handled-by-name'

export function firstNameOf(fullName) {
  const first = String(fullName ?? '').trim().split(/\s+/)[0]
  return first || null
}

/**
 * @param {object} db  service-role client
 * @param {'wa'|'ig'} channel
 * @param {object} conversation  the thread row
 * @returns {Promise<string|null>}
 */
export async function readHandledByName(db, channel, conversation) {
  try {
    if (handledBy(conversation, channel) !== 'person') return null

    let profileId = conversation.assigned_to || null
    if (!profileId && channel === 'wa') {
      const { data: sent, error: sentErr } = await db.from('whatsapp_messages')
        .select('sent_by')
        .eq('conversation_id', conversation.id)
        .eq('direction', 'outbound')
        .not('sent_by', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
      if (sentErr) {
        logWarn(LOG, 'newest staff message read failed', { conversationId: conversation.id, error: sentErr.message })
        return null
      }
      profileId = sent?.[0]?.sent_by || null
    }
    if (!profileId) return null

    const { data: profiles, error: profErr } = await excludeTombstones(
      db.from('profiles').select('id, full_name').eq('id', profileId),
    ).limit(1)
    if (profErr) {
      logWarn(LOG, 'profile read failed', { conversationId: conversation.id, error: profErr.message })
      return null
    }
    return firstNameOf(profiles?.[0]?.full_name)
  } catch (err) {
    logWarn(LOG, 'name lookup threw', { conversationId: conversation?.id, error: err?.message })
    return null
  }
}
