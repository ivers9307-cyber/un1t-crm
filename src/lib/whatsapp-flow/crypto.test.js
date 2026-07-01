import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { decryptFlowRequest, encryptFlowResponse } from './crypto.js'

function makeEncryptedRequest(publicKeyPem, payloadObj) {
  const aesKey = crypto.randomBytes(16)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv)
  const clear = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const enc = Buffer.concat([cipher.update(clear), cipher.final()])
  const tag = cipher.getAuthTag()
  const encrypted_flow_data = Buffer.concat([enc, tag]).toString('base64')
  const encrypted_aes_key = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  ).toString('base64')
  return { encrypted_flow_data, encrypted_aes_key, initial_vector: iv.toString('base64') }
}

describe('whatsapp-flow crypto', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  it('decrypts a Meta-shaped request', () => {
    const body = makeEncryptedRequest(publicKey, { action: 'ping', version: '3.0' })
    const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptFlowRequest(privateKey, body)
    expect(decryptedBody).toEqual({ action: 'ping', version: '3.0' })
    expect(aesKeyBuffer).toHaveLength(16)
    expect(initialVectorBuffer).toHaveLength(16)
  })

  it('encrypts a response the client can decrypt (flipped IV)', () => {
    const body = makeEncryptedRequest(publicKey, { action: 'ping' })
    const { aesKeyBuffer, initialVectorBuffer } = decryptFlowRequest(privateKey, body)
    const b64 = encryptFlowResponse({ data: { status: 'active' } }, aesKeyBuffer, initialVectorBuffer)
    const flipped = Buffer.from(initialVectorBuffer.map((b) => ~b & 0xff))
    const raw = Buffer.from(b64, 'base64')
    const tag = raw.subarray(raw.length - 16)
    const data = raw.subarray(0, raw.length - 16)
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, flipped)
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    expect(JSON.parse(out)).toEqual({ data: { status: 'active' } })
  })

  it('throws on a tampered AES key', () => {
    const body = makeEncryptedRequest(publicKey, { action: 'ping' })
    body.encrypted_aes_key = Buffer.from('garbage').toString('base64')
    expect(() => decryptFlowRequest(privateKey, body)).toThrow()
  })
})
