// MAIL-RENAME.1 — every old ticket route is the SAME function as its mail
// route, asserted by runtime identity so a shim can never drift into a copy.
import { describe, it, expect } from 'vitest'

const PAIRS = [
  ['compose', ['POST']],
  ['[id]', ['GET']],
  ['[id]/reply', ['POST']],
  ['[id]/forward', ['POST']],
  ['[id]/participants', ['PATCH']],
  ['[id]/merge', ['POST', 'DELETE']],
  ['[id]/read', ['POST']],
  ['[id]/link-contact', ['POST']],
  ['[id]/attachments/[attachmentId]', ['GET']],
  ['[id]/attachments/[attachmentId]/preview', ['GET']],
]

describe('/api/email/tickets shims', () => {
  for (const [sub, verbs] of PAIRS) {
    it(`${sub} re-exports ${verbs.join('/')} from /api/email/mail/${sub}`, async () => {
      const shimPath = `./${sub}/route.js`
      const realPath = `../mail/${sub}/route.js`
      const shim = await import(shimPath)
      const real = await import(realPath)
      for (const v of verbs) {
        expect(typeof real[v]).toBe('function')
        expect(shim[v]).toBe(real[v])
      }
    })
  }

  // The two attachment routes carry Next.js route-segment config; a shim
  // that re-exports the handler but drops `runtime`/`dynamic` would silently
  // change the segment's execution environment.
  const ATTACHMENT_ROUTES = ['[id]/attachments/[attachmentId]', '[id]/attachments/[attachmentId]/preview']
  for (const sub of ATTACHMENT_ROUTES) {
    it(`${sub} re-exports runtime/dynamic from /api/email/mail/${sub}`, async () => {
      const shimPath = `./${sub}/route.js`
      const realPath = `../mail/${sub}/route.js`
      const shim = await import(shimPath)
      const real = await import(realPath)
      expect(real.runtime).toBeDefined()
      expect(real.dynamic).toBeDefined()
      expect(shim.runtime).toBe(real.runtime)
      expect(shim.dynamic).toBe(real.dynamic)
    })
  }
})
