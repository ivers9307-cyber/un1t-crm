// Logger unit tests. The point of these is to guard the contract:
//   • dev mode preserves the human-readable `[module] message`
//     shape that 100+ existing console.warn call-sites use, so a
//     mechanical swap doesn't change developer terminal flow
//   • prod mode emits a single JSON line per call with stable
//     top-level keys (ts, level, module, msg) so log shippers and
//     Sentinel can match on shape rather than prose
//   • Errors flatten to {name, message, stack} so they don't
//     vanish under JSON.stringify (which drops Error properties)
//   • level routing — error→console.error, warn→console.warn,
//     info→console.log — so existing log-level filters keep working

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('logger', () => {
  let originalNodeEnv
  let logSpy, warnSpy, errorSpy

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    vi.restoreAllMocks()
    vi.resetModules()
  })

  // Dev mode is the default — anything other than NODE_ENV='production'.
  describe('dev mode (preserves prose shape)', () => {
    beforeEach(async () => {
      process.env.NODE_ENV = 'development'
      vi.resetModules()
    })

    it('logWarn writes [module] message to console.warn', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'booking trigger failed')
      expect(warnSpy).toHaveBeenCalledWith('[sequences] booking trigger failed')
    })

    it('logError writes [module] message to console.error', async () => {
      const { logError } = await import('./log.js')
      logError('revolut', 'webhook signature mismatch')
      expect(errorSpy).toHaveBeenCalledWith('[revolut] webhook signature mismatch')
    })

    it('logInfo writes [module] message to console.log', async () => {
      const { logInfo } = await import('./log.js')
      logInfo('cron', 'tick fired')
      expect(logSpy).toHaveBeenCalledWith('[cron] tick fired')
    })

    it('appends meta object as second argument when non-empty', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'enrol failed', { bookingId: 'abc', stepId: 7 })
      expect(warnSpy).toHaveBeenCalledWith(
        '[sequences] enrol failed',
        { bookingId: 'abc', stepId: 7 }
      )
    })

    it('omits the meta argument entirely when meta is undefined', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'thing happened')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      // Single-arg call — exactly one argument, no trailing undefined.
      expect(warnSpy.mock.calls[0]).toHaveLength(1)
    })

    it('flattens an Error in meta.err', async () => {
      const { logWarn } = await import('./log.js')
      const err = new Error('boom')
      logWarn('sequences', 'caught', { bookingId: 'abc', err })
      const [, meta] = warnSpy.mock.calls[0]
      expect(meta.bookingId).toBe('abc')
      expect(meta.err.name).toBe('Error')
      expect(meta.err.message).toBe('boom')
      expect(typeof meta.err.stack).toBe('string')
    })

    it('adds no undefined code/details/hint keys for a plain Error', async () => {
      // Dev prints the meta bag as a LIVE object, so an unconditional
      // `code: undefined` would show up in the terminal as a key. (Prod
      // cannot catch this: JSON.stringify silently drops undefined
      // values, so the guard is invisible there — this is the test that
      // makes the conditional spread in flattenError load-bearing.)
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'caught', { err: new Error('boom') })
      const [, meta] = warnSpy.mock.calls[0]
      expect(Object.keys(meta.err).sort()).toEqual(['message', 'name', 'stack'])
    })
  })

  // Production mode emits structured JSON lines.
  describe('prod mode (structured JSON)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production'
      vi.resetModules()
    })

    it('logWarn emits a single JSON line on console.warn', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'enrol failed', { bookingId: 'abc' })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [arg] = warnSpy.mock.calls[0]
      const parsed = JSON.parse(arg)
      expect(parsed.level).toBe('warn')
      expect(parsed.module).toBe('sequences')
      expect(parsed.msg).toBe('enrol failed')
      expect(parsed.bookingId).toBe('abc')
      expect(typeof parsed.ts).toBe('string')
    })

    it('logError routes to console.error', async () => {
      const { logError } = await import('./log.js')
      logError('revolut', 'sig mismatch')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const parsed = JSON.parse(errorSpy.mock.calls[0][0])
      expect(parsed.level).toBe('error')
    })

    it('flattens Error in meta.error to {name, message, stack}', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'caught', { error: new Error('boom') })
      const parsed = JSON.parse(warnSpy.mock.calls[0][0])
      expect(parsed.error.name).toBe('Error')
      expect(parsed.error.message).toBe('boom')
      expect(typeof parsed.error.stack).toBe('string')
    })

    it('keeps a PostgrestError identifiable — code, details and hint survive', async () => {
      // The real one EXTENDS Error, so it takes the Error branch and used
      // to arrive as name/message/stack only: a 23505 (duplicate key) was
      // indistinguishable from a 42703 (undefined column) in production.
      // Modelled as a subclass carrying the same own properties the
      // installed @supabase/postgrest-js sets.
      class PostgrestError extends Error {
        constructor({ message, code, details, hint }) {
          super(message)
          this.name = 'PostgrestError'
          this.code = code
          this.details = details
          this.hint = hint
        }
      }
      const { logError } = await import('./log.js')
      logError('tickets/reply', 'ticket patch failed after a successful send', {
        error: new PostgrestError({
          message: 'duplicate key value violates unique constraint',
          code: '23505',
          details: 'Key (id)=(1) already exists.',
          hint: 'use upsert',
        }),
      })
      const parsed = JSON.parse(errorSpy.mock.calls[0][0])
      expect(parsed.error.code).toBe('23505')
      expect(parsed.error.details).toBe('Key (id)=(1) already exists.')
      expect(parsed.error.hint).toBe('use upsert')
      // …without losing what was already there.
      expect(parsed.error.name).toBe('PostgrestError')
      expect(parsed.error.message).toBe('duplicate key value violates unique constraint')
      expect(typeof parsed.error.stack).toBe('string')
    })

    it('leaves a plain Error exactly as it was — no empty code/details/hint keys', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('sequences', 'caught', { error: new Error('boom') })
      const parsed = JSON.parse(warnSpy.mock.calls[0][0])
      expect(Object.keys(parsed.error).sort()).toEqual(['message', 'name', 'stack'])
    })

    it('preserves Supabase-shaped error objects as-is', async () => {
      const { logWarn } = await import('./log.js')
      logWarn('contacts', 'select failed', {
        err: { code: 'PGRST116', message: 'not found', details: 'x' },
      })
      const parsed = JSON.parse(warnSpy.mock.calls[0][0])
      expect(parsed.err).toEqual({
        code: 'PGRST116', message: 'not found', details: 'x',
      })
    })
  })
})
