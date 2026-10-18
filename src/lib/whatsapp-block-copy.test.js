import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { blockConfirmMessage } from './whatsapp-block-copy.js'

describe('blockConfirmMessage (WAORGNUMBER.4, R8)', () => {
  it('names the thread number and says every studio that uses it', () => {
    expect(blockConfirmMessage('+353 1 000 0000'))
      .toBe('Block this sender? This blocks them from messaging +353 1 000 0000 at every studio that uses it.')
  })
  it('a thread with no stamped number says "this number"', () => {
    expect(blockConfirmMessage(null)).toContain('messaging this number at every studio')
  })
  it('the inbox confirm uses it with the thread number', () => {
    const src = readFileSync(new URL('../components/WAInbox.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/blockConfirmMessage\(conv\.whatsapp_numbers\?\.display_phone\)/)
  })
})
