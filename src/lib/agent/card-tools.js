// MIA-CARDS.1 — the customer agent's card-set tool. Card sets are
// operator-curated swipeable image carousels (locations.settings
// .wa_card_sets, sent via sendMediaCarousel) — the same sets staff send
// from the inbox composer. The prompt lists the available sets (see
// buildCardSetsBlock in prompt.js) with each operator-authored
// description of WHEN to send it; this tool does the actual send.
//
// WhatsApp only — Instagram has no carousel surface, so its prompt never
// mentions card sets and this executor refuses the channel outright.
// One set per conversation, enforced server-side by counting existing
// carousel thread rows (the prompt asks nicely; this makes it a rule).
//
// Executor does the IO and never throws (mirrors executeEventTool);
// results/errors are returned to Claude as tool_result JSON, so error
// messages are written FOR the model (list the valid names so it can
// self-correct, tell it to answer in text instead).

import { AGENT_MESSAGE_SOURCE } from './core'
import { sendCardSetToConversation } from '@/lib/whatsapp-carousel-send'

export const CARD_TOOLS = [
  {
    name: 'send_card_set',
    description:
      "Send one of the studio's visual card sets (swipeable image cards, optionally with " +
      'tap-through links) to this customer on WhatsApp. Use when a set directly matches what ' +
      'they are asking about. Send at most one set per conversation.',
    input_schema: {
      type: 'object',
      properties: {
        set_name: { type: 'string', description: 'Exact name of the card set to send' },
      },
      required: ['set_name'],
    },
  },
]

export const CARD_TOOL_NAMES = new Set(CARD_TOOLS.map(t => t.name))

// ── executor (IO) ───────────────────────────────────────────────────
// ctx is the shared toolCtx from auto-reply.js:
// { db, conversationId, locationId, channel, ... }
export async function executeCardTool(toolName, input, ctx) {
  const { db, conversationId, locationId, channel } = ctx

  if (toolName !== 'send_card_set') return { error: 'unknown_tool', tool: toolName }

  if (channel !== 'whatsapp') {
    return { error: 'wrong_channel', message: 'Card sets can only be sent on WhatsApp. Answer in text instead.' }
  }

  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const sets = Array.isArray(loc?.settings?.wa_card_sets) ? loc.settings.wa_card_sets : []
  const wanted = String(input?.set_name || '').trim().toLowerCase()
  const set = sets.find((s) => String(s?.name || '').trim().toLowerCase() === wanted)
  if (!set) {
    const names = sets.map((s) => s?.name).filter(Boolean)
    return {
      error: 'not_found',
      message: names.length
        ? `No card set named "${String(input?.set_name || '')}". Available sets: ${names.map((n) => `"${n}"`).join(', ')}.`
        : 'This studio has no card sets configured — answer in text instead.',
    }
  }

  // Once-per-conversation guard: any prior carousel row (agent OR staff)
  // means the customer already got a card set on this thread.
  const { count } = await db.from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('message_type', 'carousel')
  if ((count || 0) > 0) {
    return { error: 'already_sent', message: 'A card set was already sent in this conversation. Answer in text instead.' }
  }

  const { data: conversation } = await db.from('whatsapp_conversations')
    .select('id, contact_id, wa_phone')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conversation?.wa_phone) {
    return { error: 'no_recipient', message: "Could not resolve this conversation's WhatsApp number — answer in text instead." }
  }

  try {
    await sendCardSetToConversation(db, {
      set,
      conversation,
      locationId,
      source: AGENT_MESSAGE_SOURCE,
    })
  } catch (e) {
    console.error('[agent][cards] carousel send failed:', e?.message)
    return { error: 'send_failed', message: 'The card set could not be sent — answer in text instead.' }
  }

  return { sent: true, set: set.name }
}
