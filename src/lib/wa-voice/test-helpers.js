// VOICENOTE.1 — synthetic Ogg buffers for the duration tests. No real audio:
// only the page header the reader looks at.
export function makeOgg(granule, { pages = 2, tail = 64 } = {}) {
  const page = (g) => {
    const h = new Uint8Array(27 + 1 + 16)
    h.set([0x4f, 0x67, 0x67, 0x53]) // 'OggS'
    h[4] = 0 // version
    h[5] = 0 // header type
    const view = new DataView(h.buffer)
    view.setBigUint64(6, BigInt(g), true)
    h[26] = 1 // one segment
    h[27] = 16 // 16 bytes of payload
    return h
  }
  const parts = []
  for (let i = 1; i < pages; i++) parts.push(page(Math.floor((granule * i) / pages)), new Uint8Array(tail))
  parts.push(page(granule))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function randomBytes(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 2654435761) & 0xff
  // Never let a random buffer carry an 'OggS' capture pattern by accident.
  for (let i = 0; i + 3 < n; i++) if (out[i] === 0x4f && out[i + 1] === 0x67) out[i] = 0
  return out
}
