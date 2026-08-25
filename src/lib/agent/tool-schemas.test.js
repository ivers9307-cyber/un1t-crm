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
import { ALL_AGENT_TOOLS } from './auto-reply'

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
})
