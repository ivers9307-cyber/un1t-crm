// ACDEVLOC.1 — the settings tab's old handlers are gone. Their only caller was
// the tab; each acted on the caller's ACTIVE studio (or took a credential in
// a query string). The control-panel / phone / widget handlers stay.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../../../../../tests/helpers/js-code.js'

const HERE = import.meta.dirname
const src = (rel) => stripComments(fs.readFileSync(path.join(HERE, rel), 'utf8'))
const exportsHandler = (code, name) => new RegExp(String.raw`export\s+(?:const|async\s+function|function)\s+${name}\b`).test(code)

describe('retired AC settings handlers (ACDEVLOC.1)', () => {
  it('the discovery routes that read ?api_key= / ?pat= are deleted', () => {
    expect(fs.existsSync(path.join(HERE, 'pods/route.js'))).toBe(false)
    expect(fs.existsSync(path.join(HERE, 'lg-devices/route.js'))).toBe(false)
  })

  it('devices keeps GET (control panel, phone) and loses POST', () => {
    const code = src('devices/route.js')
    expect(exportsHandler(code, 'GET')).toBe(true)
    expect(exportsHandler(code, 'POST')).toBe(false)
  })

  it('devices/[id] keeps GET (panel/phone polling) and loses PATCH and DELETE', () => {
    const code = src('devices/[id]/route.js')
    expect(exportsHandler(code, 'GET')).toBe(true)
    expect(exportsHandler(code, 'PATCH')).toBe(false)
    expect(exportsHandler(code, 'DELETE')).toBe(false)
  })

  it('turn-on / turn-off / extend are untouched', () => {
    for (const r of ['devices/[id]/turn-on/route.js', 'devices/[id]/turn-off/route.js', 'devices/[id]/extend/route.js']) {
      expect(fs.existsSync(path.join(HERE, r))).toBe(true)
    }
  })
})
