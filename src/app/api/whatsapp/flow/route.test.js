import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/whatsapp-flow/crypto.js', () => ({
  decryptFlowRequest: vi.fn(() => ({ decryptedBody: { action: 'ping' }, aesKeyBuffer: Buffer.alloc(16), initialVectorBuffer: Buffer.alloc(16) })),
  encryptFlowResponse: vi.fn(() => 'ENCRYPTED'),
}))
vi.mock('@/lib/whatsapp-flow/handler.js', () => ({ handleDataExchange: vi.fn(async () => ({ data: { status: 'active' } })) }))
vi.mock('@/lib/whatsapp-flow/config.js', () => ({ resolveFlowConfigByToken: vi.fn(async () => ({ contact: null, locationId: 'loc1', config: {} })) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({}) }))

process.env.WHATSAPP_FLOW_PRIVATE_KEY = 'pk'
const { POST } = await import('./route.js')

function req(body) { return new Request('http://x/api/whatsapp/flow', { method: 'POST', body: JSON.stringify(body) }) }

describe('POST /api/whatsapp/flow', () => {
  it('returns the base64 ciphertext as text/plain for a valid request', async () => {
    const res = await POST(req({ encrypted_flow_data: 'a', encrypted_aes_key: 'b', initial_vector: 'c' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(await res.text()).toBe('ENCRYPTED')
  })

  it('returns 421 when decryption fails (Meta re-fetches the key)', async () => {
    const { decryptFlowRequest } = await import('@/lib/whatsapp-flow/crypto.js')
    decryptFlowRequest.mockImplementationOnce(() => { throw new Error('bad key') })
    const res = await POST(req({ encrypted_flow_data: 'a', encrypted_aes_key: 'b', initial_vector: 'c' }))
    expect(res.status).toBe(421)
  })

  it('returns 500 when the private key env is missing', async () => {
    const saved = process.env.WHATSAPP_FLOW_PRIVATE_KEY
    delete process.env.WHATSAPP_FLOW_PRIVATE_KEY
    const res = await POST(req({ encrypted_flow_data: 'a', encrypted_aes_key: 'b', initial_vector: 'c' }))
    expect(res.status).toBe(500)
    process.env.WHATSAPP_FLOW_PRIVATE_KEY = saved
  })
})
