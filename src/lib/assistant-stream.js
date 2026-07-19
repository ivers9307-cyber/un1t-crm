// ASSIST-STREAM.1 — pure helpers for streaming the assistant's Anthropic
// responses. The route owns the network + the tool-execution loop; this
// module owns the two fiddly, bug-prone pure transforms so they can be
// unit-tested under the Node test env (no network, no DOM):
//
//   1. splitSSEEvents(buffer) — frame a raw SSE byte-stream into discrete
//      { event, data } records, returning any trailing partial frame so
//      the caller can prepend it to the next chunk.
//   2. applyAnthropicEvent(turn, evt) — fold one Anthropic streaming
//      event into an accumulating "turn" (content blocks + stop_reason),
//      returning any user-facing text delta to forward to the client.
//
// The accumulated `turn.blocks` is shaped exactly like Anthropic's
// non-streaming `content` array ([{type:'text',text}, {type:'tool_use',
// id,name,input}]), so the route's existing tool-use loop can consume it
// unchanged.

/**
 * Frame raw Server-Sent-Events text into complete events.
 * SSE events are separated by a blank line ("\n\n"); each event has
 * `event:` and `data:` lines. Anthropic sends one JSON object per
 * `data:` line. We JSON-parse it (skipping non-JSON keepalives).
 *
 * @param {string} buffer  accumulated text (may end mid-frame)
 * @returns {{ events: Array<{event:string|null, data:any}>, rest:string }}
 *   `rest` is the trailing partial frame to carry into the next chunk.
 */
export function splitSSEEvents(buffer) {
  const events = []
  const frames = buffer.split('\n\n')
  // The last element is an incomplete frame (no trailing blank line yet)
  // unless `buffer` ended exactly on "\n\n", in which case it's "".
  const rest = frames.pop() ?? ''

  for (const frame of frames) {
    if (!frame.trim()) continue
    let eventName = null
    const dataLines = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim())
      }
      // ignore `:` comments / id: / retry:
    }
    if (dataLines.length === 0) continue
    const raw = dataLines.join('\n')
    if (raw === '[DONE]') {
      events.push({ event: eventName, data: { type: '__done__' } })
      continue
    }
    try {
      events.push({ event: eventName, data: JSON.parse(raw) })
    } catch {
      // Non-JSON keepalive / partial — skip.
    }
  }
  return { events, rest }
}

/** Fresh accumulator for one Anthropic message turn. */
export function initTurn() {
  return { blocks: [], stopReason: null, usage: null, _partialJson: {} }
}

/**
 * Fold one Anthropic streaming event into the turn.
 *
 * Handles the event types we depend on:
 *   - content_block_start  → open a text or tool_use block at `index`
 *   - content_block_delta  → text_delta (emit) or input_json_delta (buffer)
 *   - content_block_stop   → finalize a tool_use block's JSON input
 *   - message_start        → capture input-side usage (SAAS4-M1)
 *   - message_delta        → capture stop_reason + output usage
 * Everything else (ping, message_stop, __done__) is a no-op.
 *
 * @param {ReturnType<typeof initTurn>} turn
 * @param {{event?:string, data:any}} evt
 * @returns {{ turn: object, textDelta: string|null }}
 */
export function applyAnthropicEvent(turn, evt) {
  const data = evt?.data || {}
  const type = data.type || evt?.event
  let textDelta = null

  switch (type) {
    case 'content_block_start': {
      const idx = data.index
      const block = data.content_block || {}
      if (block.type === 'tool_use') {
        turn.blocks[idx] = { type: 'tool_use', id: block.id, name: block.name, input: {} }
        turn._partialJson[idx] = ''
      } else if (block.type === 'text') {
        turn.blocks[idx] = { type: 'text', text: block.text || '' }
      } else {
        // Unknown block kind — keep a placeholder so indexes stay aligned.
        turn.blocks[idx] = { type: block.type || 'unknown', ...block }
      }
      break
    }
    case 'content_block_delta': {
      const idx = data.index
      const delta = data.delta || {}
      if (delta.type === 'text_delta') {
        const b = turn.blocks[idx]
        if (b && b.type === 'text') b.text += delta.text || ''
        textDelta = delta.text || ''
      } else if (delta.type === 'input_json_delta') {
        turn._partialJson[idx] = (turn._partialJson[idx] || '') + (delta.partial_json || '')
      }
      break
    }
    case 'content_block_stop': {
      const idx = data.index
      const b = turn.blocks[idx]
      if (b && b.type === 'tool_use') {
        const raw = turn._partialJson[idx]
        try {
          b.input = raw && raw.trim() ? JSON.parse(raw) : {}
        } catch {
          b.input = {}
        }
      }
      break
    }
    case 'message_start': {
      // SAAS4-M1 — usage capture. message_start carries the input-side
      // token counts (input + cache read/creation); message_delta below
      // carries the final output_tokens. Merged into turn.usage so the
      // route can meter the streamed turn like a buffered one.
      if (data.message?.usage) {
        turn.usage = { ...(turn.usage || {}), ...data.message.usage }
      }
      break
    }
    case 'message_delta': {
      if (data.delta && typeof data.delta.stop_reason !== 'undefined') {
        turn.stopReason = data.delta.stop_reason
      }
      if (data.usage) {
        turn.usage = { ...(turn.usage || {}), ...data.usage }
      }
      break
    }
    default:
      break
  }
  return { turn, textDelta }
}

/**
 * Finalize a turn into the Anthropic-shaped content array (compacted —
 * drops any holes left by sparse indexing) plus the stop_reason.
 * @param {ReturnType<typeof initTurn>} turn
 */
export function finalizeTurn(turn) {
  return {
    content: turn.blocks.filter(Boolean),
    stopReason: turn.stopReason,
    usage: turn.usage,
  }
}

/** Encode one of our own client-facing SSE events. */
export function encodeClientEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}
