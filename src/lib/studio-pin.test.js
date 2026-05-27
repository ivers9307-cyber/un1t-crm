// STUDIO-PIN.1 — coverage for the PIN hash + verify primitives and
// the findProfileByPin matcher. The format guard, hash round-trip,
// tampering, and per-profile safety cap are the cases that matter.

import { describe, it, expect, vi } from 'vitest'
import {
  isValidPinFormat,
  hashPin,
  verifyPin,
  findProfileByPin,
} from './studio-pin'

describe('isValidPinFormat', () => {
  it('accepts exactly 4 digits', () => {
    expect(isValidPinFormat('0000')).toBe(true)
    expect(isValidPinFormat('1234')).toBe(true)
    expect(isValidPinFormat('9999')).toBe(true)
  })

  it('rejects other lengths', () => {
    expect(isValidPinFormat('123')).toBe(false)
    expect(isValidPinFormat('12345')).toBe(false)
    expect(isValidPinFormat('')).toBe(false)
  })

  it('rejects non-digit characters', () => {
    expect(isValidPinFormat('12a4')).toBe(false)
    expect(isValidPinFormat(' 123')).toBe(false)
    expect(isValidPinFormat('12.4')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isValidPinFormat(1234)).toBe(false)
    expect(isValidPinFormat(null)).toBe(false)
    expect(isValidPinFormat(undefined)).toBe(false)
  })
})

describe('hashPin + verifyPin round-trip', () => {
  it('hashes a valid PIN and verifies it back', async () => {
    const hash = await hashPin('4271')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPin('4271', hash)).toBe(true)
  })

  it('produces a different hash each call (fresh salt)', async () => {
    const a = await hashPin('1234')
    const b = await hashPin('1234')
    expect(a).not.toBe(b)
    expect(await verifyPin('1234', a)).toBe(true)
    expect(await verifyPin('1234', b)).toBe(true)
  })

  it('rejects a wrong PIN against a real hash', async () => {
    const hash = await hashPin('4271')
    expect(await verifyPin('4272', hash)).toBe(false)
    expect(await verifyPin('1234', hash)).toBe(false)
    expect(await verifyPin('0000', hash)).toBe(false)
  })

  it('throws on malformed PIN to hash', async () => {
    await expect(hashPin('123')).rejects.toThrow(/4 digits/)
    await expect(hashPin('12a4')).rejects.toThrow(/4 digits/)
    await expect(hashPin('')).rejects.toThrow(/4 digits/)
  })
})

describe('verifyPin malformed input', () => {
  it('returns false on malformed PIN', async () => {
    const hash = await hashPin('1111')
    expect(await verifyPin('abc', hash)).toBe(false)
    expect(await verifyPin('', hash)).toBe(false)
    expect(await verifyPin(null, hash)).toBe(false)
  })

  it('returns false on malformed hash', async () => {
    expect(await verifyPin('1111', '')).toBe(false)
    expect(await verifyPin('1111', 'plain-text')).toBe(false)
    expect(await verifyPin('1111', 'scrypt$nothex$alsonothex')).toBe(false)
    expect(await verifyPin('1111', 'scrypt$00$00')).toBe(false) // wrong lengths
    expect(await verifyPin('1111', 'bcrypt$abc$def')).toBe(false) // wrong algo tag
  })

  it('returns false on tampered hash', async () => {
    const hash = await hashPin('1111')
    // Flip a byte in the derived key.
    const parts = hash.split('$')
    const dk = Buffer.from(parts[2], 'hex')
    dk[0] = dk[0] ^ 0x01
    const tampered = `scrypt$${parts[1]}$${dk.toString('hex')}`
    expect(await verifyPin('1111', tampered)).toBe(false)
  })
})

describe('findProfileByPin', () => {
  const buildDb = (profiles) => ({
    from() { return this },
    select() { return this },
    not() { return this },
    eq() { return this },
    limit() {
      return Promise.resolve({ data: profiles, error: null })
    },
  })

  it('returns null when no profile has a PIN set', async () => {
    const db = buildDb([])
    const got = await findProfileByPin({ db, pin: '1234' })
    expect(got).toBeNull()
  })

  it('returns the matching profile when the PIN matches', async () => {
    const hash = await hashPin('4271')
    const db = buildDb([
      { id: 'p1', full_name: 'Alice', pin_hash: hash },
    ])
    const got = await findProfileByPin({ db, pin: '4271' })
    expect(got).toEqual({ id: 'p1', full_name: 'Alice' })
  })

  it('iterates all candidates and finds the right one', async () => {
    const [aHash, bHash, cHash] = await Promise.all([
      hashPin('1111'),
      hashPin('2222'),
      hashPin('3333'),
    ])
    const db = buildDb([
      { id: 'a', full_name: 'A', pin_hash: aHash },
      { id: 'b', full_name: 'B', pin_hash: bHash },
      { id: 'c', full_name: 'C', pin_hash: cHash },
    ])
    expect(await findProfileByPin({ db, pin: '2222' })).toEqual({
      id: 'b', full_name: 'B',
    })
  })

  it('returns null when no PIN matches', async () => {
    const hash = await hashPin('1111')
    const db = buildDb([{ id: 'a', full_name: 'A', pin_hash: hash }])
    expect(await findProfileByPin({ db, pin: '9999' })).toBeNull()
  })

  it('returns null on malformed PIN without touching the db', async () => {
    const db = buildDb([])
    const spy = vi.spyOn(db, 'from')
    expect(await findProfileByPin({ db, pin: 'abc' })).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('throws when more profiles than safetyCap have PINs (misconfig signal)', async () => {
    const hash = await hashPin('1111')
    const profiles = Array.from({ length: 3 }, (_, i) => ({
      id: `p${i}`, full_name: `P${i}`, pin_hash: hash,
    }))
    const db = buildDb(profiles)
    await expect(
      findProfileByPin({ db, pin: '1111', safetyCap: 2 }),
    ).rejects.toThrow(/more than 2 profiles/)
  })

  it('surfaces db errors', async () => {
    const db = {
      from() { return this },
      select() { return this },
      not() { return this },
      eq() { return this },
      limit() {
        return Promise.resolve({ data: null, error: { message: 'db down' } })
      },
    }
    await expect(findProfileByPin({ db, pin: '1111' })).rejects.toThrow('db down')
  })
})
