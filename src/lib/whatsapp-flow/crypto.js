// Meta WhatsApp Flow endpoint encryption. Request: AES-128-GCM key wrapped with
// RSA-OAEP-256. Response: same AES key, IV bit-flipped, GCM tag appended.
import crypto from 'node:crypto'

export function decryptFlowRequest(privateKeyPem, { encrypted_flow_data, encrypted_aes_key, initial_vector }) {
  const aesKeyBuffer = crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64'),
  )
  const initialVectorBuffer = Buffer.from(initial_vector, 'base64')
  const flowData = Buffer.from(encrypted_flow_data, 'base64')
  const tagLength = 16
  const body = flowData.subarray(0, flowData.length - tagLength)
  const tag = flowData.subarray(flowData.length - tagLength)
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, initialVectorBuffer)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  return { decryptedBody: JSON.parse(decrypted), aesKeyBuffer, initialVectorBuffer }
}

export function encryptFlowResponse(responseObject, aesKeyBuffer, initialVectorBuffer) {
  const flippedIv = Buffer.from(initialVectorBuffer.map((b) => ~b & 0xff))
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, flippedIv)
  const clear = Buffer.from(JSON.stringify(responseObject), 'utf8')
  const enc = Buffer.concat([cipher.update(clear), cipher.final()])
  return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64')
}
