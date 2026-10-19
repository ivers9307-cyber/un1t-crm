// MIA-SONNET5.2 — guards on the agent's tool schemas.
//
// STRICT TOOL USE WAS ATTEMPTED AND BACKED OUT — read this before trying again.
// Sonnet 5 does support `strict: true` (4.6 did not), and it was applied
// centrally in auto-reply.js. The live API then rejected the whole request:
//
//   400 invalid_request_error — "Schemas contains too many optional
//   parameters (29), which would make grammar compilation inefficient.
//   Reduce the number of optional parameters in your tool schemas
//   (limit: 24)."
//
// The limit is across ALL tool schemas in the request, not per tool. Mia sits
// at 29, so adopting strict means either shedding 5 optional parameters (which
// changes behaviour — several are deliberately optional, e.g. verify_identity
// accepting email OR surname) or applying strict to a subset of tools. That is
// a scoped decision, not a free win, so it is deliberately NOT bundled with a
// live model swap. The count assertion below is the budget tracker for
// whoever picks it up.
import { describe, it, expect } from 'vitest'
import {
  ALL_AGENT_TOOLS, CACHED_ACCOUNT_TOOLS, CACHED_NO_BOOKING_TOOLS,
  CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS, CACHED_UN1T_FULL_TOOLS,
} from './auto-reply'

// The API rejects these inside a strict schema. The official SDKs strip them
// client-side; we send raw fetch, so they would reach the API and 400.
const UNSUPPORTED = ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern']
const STRICT_OPTIONAL_PARAM_LIMIT = 24

function objectSchemas(node, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (node.type === 'object') acc.push(node)
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') objectSchemas(v, acc)
  }
  return acc
}

function countOptionalParams(tools) {
  let n = 0
  for (const tool of tools) {
    for (const schema of objectSchemas(tool.input_schema)) {
      const props = Object.keys(schema.properties || {})
      const required = new Set(schema.required || [])
      n += props.filter(p => !required.has(p)).length
    }
  }
  return n
}

describe('agent tool schemas', () => {
  it('uses no constraint that strict mode rejects', () => {
    const offenders = []
    for (const tool of ALL_AGENT_TOOLS) {
      const json = JSON.stringify(tool.input_schema || {})
      for (const key of UNSUPPORTED) {
        if (json.includes(`"${key}"`)) offenders.push(`${tool.name}.${key}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never lists a required property that does not exist', () => {
    for (const tool of ALL_AGENT_TOOLS) {
      const props = Object.keys(tool.input_schema?.properties || {})
      for (const name of tool.input_schema?.required || []) {
        expect(props, `${tool.name}.required lists an unknown property "${name}"`).toContain(name)
      }
    }
  })

  // Not a failure today — a tripwire. If a future change pushes the optional
  // count further from the limit, adopting strict gets more expensive; if
  // someone trims it under 24, strict becomes a one-line win.
  it('reports the optional-parameter budget against the strict limit', () => {
    const optional = countOptionalParams(ALL_AGENT_TOOLS)
    const eligible = optional <= STRICT_OPTIONAL_PARAM_LIMIT
    // Documented, not enforced: this records where we stand so the next
    // attempt at strict tool use starts from the real number.
    expect(typeof optional).toBe('number')
    expect(optional).toBeGreaterThan(0)
    if (eligible) {
      console.log(`tool schemas now fit the strict limit (${optional} <= ${STRICT_OPTIONAL_PARAM_LIMIT}) — strict tool use is available`)
    }
  })

  // MIAHATCH.2 Task 3 — every block a request can carry counts against the
  // same API limit (the cap is per request, and a request carries ONE block).
  // The Glofox block is the ceiling: a new block must never be a reason strict
  // tool use gets harder than it already is. (The "29" in the comments above
  // is the count when strict was attempted; the Glofox block has since grown
  // to 32 by this same counter, measured on the base-commit fixture. 32 is the
  // ceiling: a block may be smaller, never bigger.)
  //
  // NOTE (MIAHATCH.5, Task 15): block 3b (`un1t_full`) is the one block allowed
  // past the Glofox ceiling, by exactly request_refund's optional booking_id
  // (33). Strict tool use is off, so nothing is rejected; the cost is only that
  // adopting strict for 3b would mean shedding one more optional parameter.
  // Task 19 adds the purchase tools to 3b and must raise UN1T_FULL_CEILING here
  // with its own note.
  it('reports the optional-parameter budget for every block', () => {
    const GLOFOX_CEILING = 32
    const UN1T_FULL_CEILING = GLOFOX_CEILING + 1
    const blocks = {
      glofox: CACHED_ACCOUNT_TOOLS,
      no_booking: CACHED_NO_BOOKING_TOOLS,
      un1t_read: CACHED_UN1T_READ_TOOLS,
      un1t_read_dual: CACHED_UN1T_READ_DUAL_TOOLS,
      un1t_full: CACHED_UN1T_FULL_TOOLS,
    }
    const counts = Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, countOptionalParams(v)]))
    console.log(`optional-parameter budget per block: ${JSON.stringify(counts)}`)
    expect(counts.glofox).toBe(GLOFOX_CEILING)
    expect(counts.un1t_full).toBe(UN1T_FULL_CEILING)
    for (const [block, n] of Object.entries(counts)) {
      if (block === 'un1t_full') continue
      expect(n, `${block} grew past the Glofox block`).toBeLessThanOrEqual(GLOFOX_CEILING)
    }
  })

  it('no block uses a constraint that strict mode rejects, and every required property exists', () => {
    for (const block of [CACHED_NO_BOOKING_TOOLS, CACHED_UN1T_READ_TOOLS, CACHED_UN1T_READ_DUAL_TOOLS, CACHED_UN1T_FULL_TOOLS]) {
      for (const tool of block) {
        const json = JSON.stringify(tool.input_schema || {})
        for (const key of UNSUPPORTED) expect(json.includes(`"${key}"`), `${tool.name}.${key}`).toBe(false)
        const props = Object.keys(tool.input_schema?.properties || {})
        for (const name of tool.input_schema?.required || []) expect(props, `${tool.name}.${name}`).toContain(name)
      }
    }
  })
})
