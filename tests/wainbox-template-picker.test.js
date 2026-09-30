// WATPLSEND.1 / WATPLLOG.1 — the web inbox's WhatsApp template picker, pinned
// as source. The decisions (what can be sent, the request body, the preview,
// one value per DISTINCT {{n}} in number order) live in
// shared/wa-template-send.js and are tested there, shared with the phone.
// WAInbox is a 1,300-line client component with no test harness of its own,
// so what is pinned here is that it CALLS those helpers and that the two
// shapes that broke it (a blank ' ' value, one value per occurrence) are gone.
// A floor, not proof; the operator smoke in the plan is the rest.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
const INBOX = read('src/components/WAInbox.jsx')

describe('web WhatsApp inbox: template picker', () => {
  it('uses the shared rules the phone uses', () => {
    expect(INBOX).toMatch(/from '@shared\/wa-template-send'/)
    for (const fn of ['buildTemplateSend(', 'templateSendBlock(', 'renderTemplatePreview(', 'initialTemplateValues(', 'bodyVariableSlots(']) {
      expect(INBOX).toContain(fn)
    }
  })

  it('never sends a single space for an empty variable', () => {
    expect(INBOX).not.toContain("|| ' '")
  })

  it('asks for one value per DISTINCT variable, not one per occurrence (WATPLLOG.1)', () => {
    expect(INBOX).not.toContain('match(/\\{\\{\\d+\\}\\}/g)')
    expect(INBOX).toMatch(/bodyVariableSlots\(selectedTemplate\)\.map\(/)
  })

  it('posts exactly the body buildTemplateSend built, and greys out what it cannot send', () => {
    expect(INBOX).toContain('body: JSON.stringify(built.payload)')
    expect(INBOX).toContain('SEND_BLOCK_TEXT[block]')
    expect(INBOX).toMatch(/disabled=\{!!block\}/)
  })

  it('shows the route\'s warnings when a send succeeded but its bookkeeping did not', () => {
    expect((INBOX.match(/data\.warnings\?\.length/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

// MIANITS fix — send-flow and react answer `{ success: true, warnings: [...] }`
// when Meta took the action but the thread row was lost. The Flow handler
// must show it, or staff see nothing in the thread and send a second Flow.
// Pinned as source (no harness for this component): the handler's body.
const handlerBody = (name) => {
  const start = INBOX.indexOf(`async function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const next = INBOX.indexOf('\n  async function ', start + 1)
  return INBOX.slice(start, next === -1 ? undefined : next)
}

describe('web WhatsApp inbox: send-flow and react warnings', () => {
  it('handleSendFlow alerts the route\'s warnings on a successful send', () => {
    expect(handlerBody('handleSendFlow')).toMatch(/if \(data\.warnings\?\.length\) alert\(data\.warnings\.join\('\\n\\n'\)\)/)
  })

  it('reactToMessage reads the response and alerts its warnings', () => {
    const body = handlerBody('reactToMessage')
    expect(body).toMatch(/await res\.json\(\)/)
    expect(body).toMatch(/data\.warnings\?\.length/)
  })
})
