// DEPAUDIT.5 — smtp-send.js against the REAL nodemailer, not a fake.
//
// smtp-send.test.js drives a fake transporter, which is right for the
// verdict envelope and the redaction, but it means nothing in the suite would
// notice if a nodemailer upgrade stopped reading the shapes this file hands it.
// The 9 → 10 major (a TypeScript rewrite with new ESM/CJS builds) is exactly
// that kind of change, so these pin the four library behaviours smtp-send.js's
// comments say it depends on, using nodemailer's own offline streamTransport
// and SMTP option parser. No socket is opened.

import { describe, it, expect } from 'vitest'
import nodemailer from 'nodemailer'
import {
  adaptAuthForNodemailer,
  toNodemailerHeaders,
  toNodemailerAttachments,
  bareMessageId,
} from './smtp-send'

async function compose(mail) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  const info = await transport.sendMail({ from: 'studio@example.com', to: 'member@example.com', ...mail })
  return { info, raw: info.message.toString('utf8') }
}

describe('nodemailer contract (real library)', () => {
  it('the default import exposes createTransport', () => {
    expect(typeof nodemailer.createTransport).toBe('function')
  })

  it('writes Postmark-shaped threading headers once mapped to { key, value }', async () => {
    const { raw } = await compose({
      subject: 'Re: hello',
      text: 'hi',
      headers: toNodemailerHeaders([
        { Name: 'In-Reply-To', Value: '<orig@example.com>' },
        { Name: 'References', Value: '<root@example.com> <orig@example.com>' },
      ]),
    })
    expect(raw).toMatch(/^In-Reply-To: <orig@example\.com>$/m)
    expect(raw).toMatch(/^References: <root@example\.com> <orig@example\.com>$/m)
  })

  it('decodes a base64 attachment from content + encoding, not a path', async () => {
    const payload = 'attachment body'
    const { raw } = await compose({
      text: 'see attached',
      attachments: toNodemailerAttachments([
        { Name: 'note.txt', Content: Buffer.from(payload).toString('base64'), ContentType: 'text/plain' },
      ]),
    })
    expect(raw).toMatch(/filename=note\.txt/)
    expect(raw).toContain(Buffer.from(payload).toString('base64'))
  })

  it('returns a BRACKETED messageId that bareMessageId strips to the stored form', async () => {
    const { info } = await compose({ text: 'x' })
    expect(info.messageId).toMatch(/^<[^<>]+@[^<>]+>$/)
    expect(bareMessageId(info.messageId)).toBe(info.messageId.slice(1, -1))
  })

  it('selects XOAUTH2 only for the adapted { type: OAuth2 } shape', () => {
    const smtp = (auth) => nodemailer.createTransport({ host: 'smtp.example.com', port: 465, secure: true, auth }).transporter
    const oauth = smtp(adaptAuthForNodemailer({ user: 'u@example.com', accessToken: 'tok' }))
    expect(oauth.auth.type).toBe('OAUTH2')
    expect(oauth.auth.method).toBe('XOAUTH2')

    const password = smtp(adaptAuthForNodemailer({ user: 'u@example.com', pass: 'app-password' }))
    expect(password.auth.type).toBe('LOGIN')
    expect(password.auth.credentials).toEqual({ user: 'u@example.com', pass: 'app-password' })
  })
})
