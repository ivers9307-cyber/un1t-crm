// SECRETTAILS.1 guard. shelly_connections.key_hint held the last 4 characters
// of the Shelly auth key. Mig 659 clears it and CHECKs it stays NULL; this
// keeps the code on the same side: no non-test file under src/, shared/ or
// mobile/ may name `key_hint` or `keyHint` in code (comments are allowed, so
// a file can say why the field is gone). A floor, not a proof: a column name
// built at runtime is invisible here. The DB CHECK is the proof for writes.

import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { stripComments, stripCommentsOfFile } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'dist', 'web-build'])
const FORBIDDEN = /\bkey_hint\b|\bkeyHint\b/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx|tsx?)$/.test(name) && !/\.test\.(m?js|jsx|tsx?)$|\.test-helpers\.js$/.test(name)) out.push(full)
  }
  return out
}

// Comments blanked by the TypeScript parser's ranges (tests/helpers/js-code.js),
// never a regex: a '/*' in a string hid the rest of a file from the old one.
export const codeOnly = (text, file) => stripComments(text, file)

describe('no code names the retired Shelly key hint (SECRETTAILS.1)', () => {
  it('no source file under src/, shared/ or mobile/ reads, writes or selects it', () => {
    const hits = []
    for (const dir of ['src', 'shared', 'mobile']) {
      for (const f of walk(path.join(ROOT, dir))) {
        const m = stripCommentsOfFile(f).match(FORBIDDEN)
        if (m) hits.push(`${path.relative(ROOT, f)}: ${m.join(', ')}`)
      }
    }
    expect(hits, 'key_hint was the auth key\'s last four characters: show presence (SECRET_MASK), never a character').toEqual([])
  })

  it('the matcher sees code and ignores comments', () => {
    expect(codeOnly(`const s = 'host, key_hint, status'`).match(FORBIDDEN)).toEqual(['key_hint'])
    expect(codeOnly(`r.keyHint ? 1 : 0`).match(FORBIDDEN)).toEqual(['keyHint'])
    expect(codeOnly(`// key_hint was retired by mig 659`).match(FORBIDDEN)).toBeNull()
    expect(codeOnly(`/* no keyHint */ const x = 1`).match(FORBIDDEN)).toBeNull()
    expect(codeOnly(`const u = 'https://x.example/key_hint'`).match(FORBIDDEN)).toEqual(['key_hint'])
    // GUARDSTRIP.1 (C74): the regex stripper read the '/*' in a string as a comment.
    expect(codeOnly(`const a = 'image/*'\nrow.key_hint = k\n/* x */`).match(FORBIDDEN)).toEqual(['key_hint'])
  })
})
