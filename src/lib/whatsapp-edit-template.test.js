// src/lib/whatsapp-edit-template.test.js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { editTemplate } from './whatsapp.js'

afterEach(() => { vi.restoreAllMocks() })

describe('editTemplate', () => {
  it('POSTs category+components to the template id endpoint with the bearer token', async () => {
    const calls = []
    vi.stubGlobal('fetch', async (url, opts) => {
      calls.push({ url, opts })
      return { json: async () => ({ success: true }) }
    })
    const config = { token: 'TKN', businessAccountId: 'WABA' }
    await editTemplate('1234567890', { category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] }, { config })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer TKN')
    const body = JSON.parse(calls[0].opts.body)
    expect(body.category).toBe('UTILITY')
    expect(body.components).toEqual([{ type: 'BODY', text: 'hi' }])
    // name/language are immutable on edit — must NOT be sent.
    expect(body.name).toBeUndefined()
    expect(body.language).toBeUndefined()
  })

  it('throws on a Meta error', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ error: { message: 'bad components' } }) }))
    await expect(editTemplate('1', { components: [] }, { config: { token: 'T' } })).rejects.toThrow('bad components')
  })
})
