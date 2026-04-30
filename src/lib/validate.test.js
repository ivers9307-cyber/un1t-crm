import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { validateBody, validate, uuidLike } from './validate.js'

// Minimal Request shim — validateBody only needs request.json()
function makeRequest(body) {
  return {
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('bad json')
      return body
    },
  }
}

const Schema = z.object({
  name: z.string().min(1).max(100),
  age: z.number().int().min(0).max(150),
})

describe('validateBody', () => {
  it('returns ok + parsed data for a valid body', async () => {
    const result = await validateBody(makeRequest({ name: 'Alice', age: 30 }), Schema)
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ name: 'Alice', age: 30 })
  })

  it('returns 400 with structured issues for an invalid body', async () => {
    const result = await validateBody(makeRequest({ name: '', age: 200 }), Schema)
    expect(result.ok).toBe(false)
    const json = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(json.success).toBe(false)
    expect(json.error).toBe('Invalid request body')
    expect(json.issues).toHaveLength(2)
    expect(json.issues.map(i => i.path).sort()).toEqual(['age', 'name'])
  })

  it('returns 400 when the body is not valid JSON', async () => {
    const badRequest = { json: async () => { throw new Error('parse fail') } }
    const result = await validateBody(badRequest, Schema)
    expect(result.ok).toBe(false)
    const json = await result.response.json()
    expect(result.response.status).toBe(400)
    expect(json.error).toBe('Request body is not valid JSON')
  })

  it('strips unknown keys (Zod default for z.object)', async () => {
    const result = await validateBody(makeRequest({ name: 'Bob', age: 25, extra: 'ignored' }), Schema)
    expect(result.ok).toBe(true)
    expect(result.data).not.toHaveProperty('extra')
  })
})

describe('validate (sync)', () => {
  it('parses a valid value', () => {
    const r = validate(42, z.number())
    expect(r.ok).toBe(true)
    expect(r.data).toBe(42)
  })

  it('returns a 400 NextResponse for invalid input', async () => {
    const r = validate('forty-two', z.number())
    expect(r.ok).toBe(false)
    const json = await r.response.json()
    expect(json.error).toBe('Invalid input')
  })
})

describe('uuidLike (Postgres-permissive UUID matcher)', () => {
  it('accepts the seeded Stillorgan location ID (RFC-noncompliant version digit)', () => {
    expect(uuidLike.safeParse('a0000000-0000-0000-0000-000000000001').success).toBe(true)
  })

  it('accepts a valid v4 UUID', () => {
    expect(uuidLike.safeParse('8a7b6c5d-4e3f-4a2b-9c1d-0e8f7a6b5c4d').success).toBe(true)
  })

  it('rejects garbage', () => {
    expect(uuidLike.safeParse('not-a-uuid').success).toBe(false)
    expect(uuidLike.safeParse('12345').success).toBe(false)
  })

  it('rejects strings of the wrong length', () => {
    expect(uuidLike.safeParse('a0000000-0000-0000-0000-000000000001-extra').success).toBe(false)
    expect(uuidLike.safeParse('a0000000-0000-0000-0000-00000000000').success).toBe(false)
  })
})
