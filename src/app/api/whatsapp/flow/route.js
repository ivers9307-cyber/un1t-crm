// WhatsApp Flow data-exchange endpoint. The body is always encrypted; we decrypt
// it, dispatch to the handler, and return the encrypted base64 as text/plain.
// 421 on decrypt failure tells Meta to re-fetch our public key. This route is
// intentionally unauthenticated at the session layer — the RSA/AES encryption IS
// the credential (only Meta, holding our registered public key, can produce a
// request we can decrypt). Exempted in scripts/check-route-guards.mjs.
import { decryptFlowRequest, encryptFlowResponse } from '@/lib/whatsapp-flow/crypto.js'
import { handleDataExchange } from '@/lib/whatsapp-flow/handler.js'
import { resolveFlowConfigByToken } from '@/lib/whatsapp-flow/config.js'
import { createServerClient } from '@/lib/supabase'

export async function POST(request) {
  const privateKey = process.env.WHATSAPP_FLOW_PRIVATE_KEY
  if (!privateKey) return new Response('Server misconfigured', { status: 500 })

  let body
  try { body = await request.json() } catch { return new Response('Bad request', { status: 400 }) }

  let decrypted
  try {
    decrypted = decryptFlowRequest(privateKey, body)
  } catch (e) {
    console.error('[wa-flow] decrypt failed:', e.message)
    return new Response('Failed to decrypt', { status: 421 })
  }

  const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decrypted
  try {
    const db = createServerClient()
    const { contact, locationId, config } = await resolveFlowConfigByToken(db, decryptedBody.flow_token)
    const responseObject = await handleDataExchange(db, { decryptedBody, contact, locationId, config })
    const encrypted = encryptFlowResponse(responseObject, aesKeyBuffer, initialVectorBuffer)
    return new Response(encrypted, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  } catch (e) {
    console.error('[wa-flow] handler error:', e.message)
    const encrypted = encryptFlowResponse(
      { screen: 'DAY', data: { days: [], path: 'class', error_message: 'Something went wrong. Please try again.' } },
      aesKeyBuffer, initialVectorBuffer,
    )
    return new Response(encrypted, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
}
