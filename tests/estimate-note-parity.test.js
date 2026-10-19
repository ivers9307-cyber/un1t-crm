// UN1TRADAR.2 — the phone cannot import src/lib, so its estimate note is a
// copy of the web's. They must say the same thing.
import { describe, it, expect } from 'vitest'
import { ESTIMATE_NOTE as WEB } from '../src/lib/radar-copy'
import { ESTIMATE_NOTE as PHONE } from '../mobile/lib/arrears-estimate-label'

describe('estimate note parity', () => {
  it('web and phone say the same words', () => expect(PHONE).toBe(WEB))
})
