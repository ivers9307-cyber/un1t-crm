// STAFFASSISTPREFILL.1 (C108) — the staff assistant's message list comes from
// the client (web bubble, phone tab), so the route cannot assume its shape.
// Current Claude models refuse a request whose LAST message is an assistant
// turn ("does not support assistant message prefill", HTTP 400), and every
// request must open on a user turn.
//
// Mia's reply path has its own normaliser (buildReplyTurnMessages in
// src/lib/agent/core.js, MIAPREFILL.1), but it maps stored WhatsApp ROWS
// (direction, customer-text sanitising, a customer-facing context preamble);
// none of that fits a staff chat, so this is the small sibling for
// {role, content} lists. Pure; never mutates its input.

const isEmpty = (content) => (Array.isArray(content)
  ? content.length === 0
  : !String(content ?? '').trim())

const toBlocks = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content) }])

/**
 * Guarantee: `messages` is either empty or starts on a user turn, alternates
 * roles, has no empty content, and ENDS ON A USER TURN.
 *
 *  - empty turns (a streaming placeholder, a blank string, []) are dropped;
 *  - consecutive same-role turns merge (strings join with a blank line; if
 *    either side is a block array, the blocks concatenate);
 *  - leading assistant turns are dropped;
 *  - a list whose last turn is the assistant's has nothing new to answer and
 *    comes back EMPTY with reason 'nothing_to_answer'. It is not trimmed back
 *    to the previous user turn: that turn was already answered, and answering
 *    it again could run a write tool a second time.
 *
 * @param {Array<{role:'user'|'assistant', content:string|Array<object>}>|null|undefined} turns
 * @returns {{ messages: Array<{role:string, content:string|Array<object>}>, reason: null|'nothing_to_answer' }}
 */
export function normaliseChatTurns(turns) {
  const merged = []
  for (const t of turns || []) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || isEmpty(t.content)) continue
    const last = merged[merged.length - 1]
    if (last && last.role === t.role) {
      last.content = (typeof last.content === 'string' && typeof t.content === 'string')
        ? `${last.content}\n\n${t.content}`
        : [...toBlocks(last.content), ...toBlocks(t.content)]
    } else {
      merged.push({ role: t.role, content: Array.isArray(t.content) ? [...t.content] : t.content })
    }
  }
  while (merged.length && merged[0].role !== 'user') merged.shift()
  if (!merged.length || merged[merged.length - 1].role !== 'user') {
    return { messages: [], reason: 'nothing_to_answer' }
  }
  return { messages: merged, reason: null }
}
