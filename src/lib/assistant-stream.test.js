import { describe, it, expect } from 'vitest'
import {
  splitSSEEvents,
  initTurn,
  applyAnthropicEvent,
  finalizeTurn,
  encodeClientEvent,
} from './assistant-stream.js'

// Helper to build a raw SSE frame the way Anthropic sends them.
function frame(event, dataObj) {
  return `event: ${event}\ndata: ${JSON.stringify(dataObj)}\n\n`
}

describe('splitSSEEvents', () => {
  it('frames complete events and returns empty rest', () => {
    const buf = frame('ping', { type: 'ping' }) + frame('message_stop', { type: 'message_stop' })
    const { events, rest } = splitSSEEvents(buf)
    expect(events).toHaveLength(2)
    expect(events[0].data.type).toBe('ping')
    expect(rest).toBe('')
  })

  it('carries a trailing partial frame into rest', () => {
    const whole = frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    const partial = 'event: content_block_delta\ndata: {"type":"content_block'
    const { events, rest } = splitSSEEvents(whole + partial)
    expect(events).toHaveLength(1)
    expect(rest).toBe(partial)
  })

  it('re-joins a partial frame on the next chunk', () => {
    const r1 = splitSSEEvents('event: x\ndata: {"a":1')
    expect(r1.events).toHaveLength(0)
    const r2 = splitSSEEvents(r1.rest + '23}\n\n')
    expect(r2.events).toHaveLength(1)
    expect(r2.events[0].data.a).toBe(123)
  })

  it('skips non-JSON keepalives and recognises [DONE]', () => {
    const { events } = splitSSEEvents('data: [DONE]\n\n: keepalive comment\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data.type).toBe('__done__')
  })
})

describe('applyAnthropicEvent — text turn', () => {
  it('accumulates text deltas and emits each delta', () => {
    let turn = initTurn()
    const seq = [
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } } },
      { data: { type: 'content_block_stop', index: 0 } },
      { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    ]
    const emitted = []
    for (const evt of seq) {
      const { textDelta } = applyAnthropicEvent(turn, evt)
      if (textDelta) emitted.push(textDelta)
    }
    expect(emitted).toEqual(['Hello', ' there'])
    const { content, stopReason } = finalizeTurn(turn)
    expect(stopReason).toBe('end_turn')
    expect(content).toEqual([{ type: 'text', text: 'Hello there' }])
  })
})

describe('applyAnthropicEvent — tool_use turn', () => {
  it('reassembles streamed partial JSON into the tool input', () => {
    let turn = initTurn()
    const seq = [
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'search_contacts' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"ada"}' } } },
      { data: { type: 'content_block_stop', index: 0 } },
      { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    ]
    for (const evt of seq) applyAnthropicEvent(turn, evt)
    const { content, stopReason } = finalizeTurn(turn)
    expect(stopReason).toBe('tool_use')
    expect(content).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'search_contacts', input: { query: 'ada' } }])
  })

  it('handles a turn that emits text THEN calls a tool (narration + tool_use)', () => {
    let turn = initTurn()
    const seq = [
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking that up…' } } },
      { data: { type: 'content_block_stop', index: 0 } },
      { data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_2', name: 'list_staff' } } },
      { data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { data: { type: 'content_block_stop', index: 1 } },
      { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
    ]
    const emitted = []
    for (const evt of seq) {
      const { textDelta } = applyAnthropicEvent(turn, evt)
      if (textDelta) emitted.push(textDelta)
    }
    expect(emitted).toEqual(['Looking that up…'])
    const { content } = finalizeTurn(turn)
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: 'Looking that up…' })
    expect(content[1]).toMatchObject({ type: 'tool_use', name: 'list_staff', input: {} })
  })

  it('defaults to {} when tool input JSON never arrives or is malformed', () => {
    let turn = initTurn()
    applyAnthropicEvent(turn, { data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'navigate_user' } } })
    applyAnthropicEvent(turn, { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{bad' } } })
    applyAnthropicEvent(turn, { data: { type: 'content_block_stop', index: 0 } })
    expect(finalizeTurn(turn).content[0].input).toEqual({})
  })
})

describe('applyAnthropicEvent — usage capture (SAAS4-M1)', () => {
  it('captures input tokens from message_start and output tokens from message_delta', () => {
    let turn = initTurn()
    applyAnthropicEvent(turn, {
      data: {
        type: 'message_start',
        message: { usage: { input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 1 } },
      },
    })
    applyAnthropicEvent(turn, {
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 210 } },
    })
    const { usage, stopReason } = finalizeTurn(turn)
    expect(stopReason).toBe('end_turn')
    expect(usage).toMatchObject({
      input_tokens: 900,
      cache_read_input_tokens: 4000,
      output_tokens: 210,
    })
  })

  it('returns null usage when the stream never carried usage (older wire shapes)', () => {
    let turn = initTurn()
    applyAnthropicEvent(turn, { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } })
    expect(finalizeTurn(turn).usage).toBeNull()
  })
})

describe('encodeClientEvent', () => {
  it('produces a valid SSE data frame', () => {
    expect(encodeClientEvent({ type: 'text', delta: 'hi' })).toBe('data: {"type":"text","delta":"hi"}\n\n')
  })
})
