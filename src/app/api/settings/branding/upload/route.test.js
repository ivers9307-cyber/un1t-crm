// MAILFIX-BRANDGATE.1 — POST /api/settings/branding/upload writes a studio's
// public logo/favicon (rendered on marketing pages, in customer emails, as
// the site favicon), keyed by the caller-named location_id.
//
// TWO PROPERTIES ARE PINNED HERE:
//
// 1. THE GATE IS THE ROLE AT THE TARGET STUDIO. `user.role` resolves at the
//    caller's ACTIVE location (highest-role-anywhere fallback), so the old
//    `user.role` check let an owner at studio A who is plain STAFF at studio
//    B overwrite B's logo. The gate is now membership + owner-or-master AT
//    the target (assertLocationAccess then guardMasterOrOwner — the
//    guardMailboxAdmin order). Every refusal asserts NOTHING WAS UPLOADED.
//
// 2. THE BYTES MUST MATCH THE CLAIMED TYPE. file.type is client-asserted and
//    the bucket is public-read by design (SAAS-7), so without a sniff an
//    arbitrary payload can be parked on our public host wearing an image
//    content-type. Raster types get the /api/me/signature-photo magic-byte
//    check (PNG/WebP, plus ICO's ICONDIR — a PNG renamed .ico stays accepted,
//    browsers render those as favicons). SVG stays accepted (existing logos
//    are SVG — re-upload must not break) with a structural check: after the
//    optional BOM / whitespace / XML prolog, the first ELEMENT must be <svg.
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so the real guards' contracts are what run here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const OWNER_A = {
  id: 'u1', role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
// The audit cast — owner at active A, plain staff at target B. user.role and
// profileRole both read 'owner'; neither may count at B.
const OWNER_A_STAFF_B = {
  id: 'u2', role: 'owner', profileRole: 'owner',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
const STAFF_A_OWNER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff',
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'owner' },
  activeLocation: { id: LOC_A },
}
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master',
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

function makeDb() {
  const uploads = []
  return {
    uploads,
    // This route reads no tables — fail LOUD if it ever starts to.
    from(table) { throw new Error(`unexpected db.from('${table}') in branding upload test`) },
    storage: {
      from(bucket) {
        if (bucket !== 'branding') throw new Error(`unexpected storage bucket '${bucket}'`)
        return {
          upload: (path, buffer, opts) => {
            uploads.push({ path, bytes: Buffer.from(buffer), contentType: opts?.contentType, upsert: opts?.upsert })
            return Promise.resolve({ error: null })
          },
          getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.test/branding/${path}` } }),
        }
      },
    },
  }
}

// Real magic bytes, padded past the sniffs' minimum lengths.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(8)])
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.alloc(8)])
const ICO_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00])
const NOT_AN_IMAGE = Buffer.from('#!/bin/sh\necho pwned\n')

function req({ bytes, name, mime, locationId = LOC_A, type = 'logo' } = {}) {
  const fd = new FormData()
  fd.append('file', new File([bytes], name, { type: mime }))
  fd.append('type', type)
  if (locationId) fd.append('location_id', locationId)
  return new Request('http://localhost/api/settings/branding/upload', { method: 'POST', body: fd })
}

const pngReq = (over = {}) => req({ bytes: PNG_BYTES, name: 'logo.png', mime: 'image/png', ...over })
const svg = (text, over = {}) => req({ bytes: Buffer.from(text), name: 'logo.svg', mime: 'image/svg+xml', ...over })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER_A)
})

// MAILFIX-BRANDGATE.2 — the storage key is server-built: for EVERY accepted
// request in this whole file, the path must be {locationId}/{logo|favicon}.
// {png|webp|ico|svg} with no client string inside it. A traversal that
// slipped any refusal above would fail here, whatever test it hid in.
afterEach(() => {
  for (const { path } of db.uploads) {
    expect(path).toMatch(new RegExp(`^(${LOC_A}|${LOC_B})/(logo|favicon)\\.(png|webp|ico|svg)$`))
  }
})

describe('POST /api/settings/branding/upload — the gate is the role AT THE TARGET studio', () => {
  it('refuses an owner-at-A who is plain STAFF at the target B, uploading nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await POST(pngReq({ locationId: LOC_B }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners or master can upload branding')
    expect(db.uploads).toEqual([])
  })

  it('an owner AT THE TARGET succeeds unchanged, even with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await POST(pngReq({ locationId: LOC_B }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // The exact success shape the settings form parses: absolute public URL,
    // {locationId}/{type}.{ext} path, cache-bust query.
    expect(body.url).toMatch(new RegExp(`^https://cdn\\.test/branding/${LOC_B}/logo\\.png\\?t=\\d+$`))
    expect(db.uploads).toEqual([expect.objectContaining({ path: `${LOC_B}/logo.png`, contentType: 'image/png', upsert: true })])
  })

  it('a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await POST(pngReq({ locationId: LOC_B }))).status).toBe(200)
    expect(db.uploads).toHaveLength(1)
  })

  it('an owner omitting location_id still lands on their active studio', async () => {
    const res = await POST(pngReq({ locationId: null }))
    expect(res.status).toBe(200)
    expect(db.uploads[0].path).toBe(`${LOC_A}/logo.png`)
  })

  it('403s a non-member on the MEMBERSHIP message, uploading nothing', async () => {
    const res = await POST(pngReq({ locationId: LOC_B }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/location/i)
    expect(db.uploads).toEqual([])
  })

  it('401s an anonymous caller without uploading', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(pngReq())).status).toBe(401)
    expect(db.uploads).toEqual([])
  })

  it('400s when no target studio can be resolved at all (no field, no active location)', async () => {
    getCurrentUser.mockResolvedValue({ ...MASTER, activeLocation: null })
    const res = await POST(pngReq({ locationId: null }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('location_id is required')
    expect(db.uploads).toEqual([])
  })
})

describe('POST /api/settings/branding/upload — the storage key is server-built, never client strings', () => {
  // The reviewer-verified vector: storage-js does not strip dot segments and
  // WHATWG URL resolution folds them before the request leaves, so an
  // unwhitelisted `type` of `../<other-studio>/logo` + upsert:true would
  // overwrite ANOTHER studio's live logo through the service-role key.
  it("refuses a traversal smuggled through `type`, uploading nothing", async () => {
    const res = await POST(pngReq({ type: `../${LOC_B}/logo` }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("type must be 'logo' or 'favicon'")
    expect(db.uploads).toEqual([])
  })

  it('refuses any type outside logo|favicon, however innocent', async () => {
    expect((await POST(pngReq({ type: 'banner' }))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('a traversal smuggled through the FILENAME is inert — the name never reaches the key', async () => {
    const res = await POST(req({ bytes: PNG_BYTES, name: `../../${LOC_B}/logo.png`, mime: 'image/png' }))
    expect(res.status).toBe(200)
    expect(db.uploads[0].path).toBe(`${LOC_A}/logo.png`)
  })

  it('a legitimate basename containing ".." (logo..png) still uploads to the canonical key', async () => {
    const res = await POST(req({ bytes: PNG_BYTES, name: 'logo..png', mime: 'image/png' }))
    expect(res.status).toBe(200)
    expect(db.uploads[0].path).toBe(`${LOC_A}/logo.png`)
  })

  it('derives the extension from the sniffed MIME, never from the client filename', async () => {
    // A benign mismatch: PNG bytes + PNG MIME under a .jpeg name. The name
    // must not reach the key — ext-from-filename would write logo.jpeg here.
    const res = await POST(req({ bytes: PNG_BYTES, name: 'logo.jpeg', mime: 'image/png' }))
    expect(res.status).toBe(200)
    expect(db.uploads[0].path).toBe(`${LOC_A}/logo.png`)
  })

  it('an SVG lands at {locationId}/logo.svg', async () => {
    expect((await POST(svg('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status).toBe(200)
    expect(db.uploads[0].path).toBe(`${LOC_A}/logo.svg`)
  })

  it('a PNG under the .ico MIME keeps writing favicon.ico, as it always has', async () => {
    expect((await POST(req({ bytes: PNG_BYTES, name: 'favicon.ico', mime: 'image/x-icon', type: 'favicon' }))).status).toBe(200)
    expect(db.uploads[0].path).toBe(`${LOC_A}/favicon.ico`)
  })
})

describe('POST /api/settings/branding/upload — the bytes must match the claimed type', () => {
  it('refuses a payload wearing the PNG MIME with the wrong magic, uploading nothing', async () => {
    const res = await POST(req({ bytes: NOT_AN_IMAGE, name: 'logo.png', mime: 'image/png' }))
    expect(res.status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('refuses a payload wearing the WebP MIME with the wrong magic', async () => {
    expect((await POST(req({ bytes: NOT_AN_IMAGE, name: 'logo.webp', mime: 'image/webp' }))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('refuses a payload wearing the ICO MIME with the wrong magic', async () => {
    expect((await POST(req({ bytes: NOT_AN_IMAGE, name: 'favicon.ico', mime: 'image/x-icon', type: 'favicon' }))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('a PNG whose bytes SAY PNG uploads exactly as before', async () => {
    expect((await POST(pngReq())).status).toBe(200)
    expect(db.uploads[0].bytes.subarray(0, 4)).toEqual(PNG_BYTES.subarray(0, 4))
  })

  it('a real WebP uploads', async () => {
    expect((await POST(req({ bytes: WEBP_BYTES, name: 'logo.webp', mime: 'image/webp' }))).status).toBe(200)
  })

  it('a real ICO uploads, under either of its two MIME spellings', async () => {
    expect((await POST(req({ bytes: ICO_BYTES, name: 'favicon.ico', mime: 'image/x-icon', type: 'favicon' }))).status).toBe(200)
    expect((await POST(req({ bytes: ICO_BYTES, name: 'favicon.ico', mime: 'image/vnd.microsoft.icon', type: 'favicon' }))).status).toBe(200)
  })

  it('a PNG renamed favicon.ico stays accepted — browsers render PNG favicons and re-upload must not break', async () => {
    expect((await POST(req({ bytes: PNG_BYTES, name: 'favicon.ico', mime: 'image/x-icon', type: 'favicon' }))).status).toBe(200)
  })

  it('a MIME outside the allowlist is still refused up front (unchanged)', async () => {
    expect((await POST(req({ bytes: PNG_BYTES, name: 'photo.jpg', mime: 'image/jpeg' }))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })
})

describe('POST /api/settings/branding/upload — SVG stays accepted, structurally checked', () => {
  it('accepts a plain <svg> document', async () => {
    expect((await POST(svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).status).toBe(200)
  })

  it('accepts the full real-world prolog: BOM, XML declaration, comment, DOCTYPE, whitespace', async () => {
    const text = '﻿ \n<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Adobe Illustrator -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY x "y">]>\n<svg xmlns="http://www.w3.org/2000/svg"/>'
    expect((await POST(svg(text))).status).toBe(200)
  })

  it('accepts a self-closing and an unattributed <svg> alike', async () => {
    expect((await POST(svg('<svg/>'))).status).toBe(200)
    expect((await POST(svg('<svg><g/></svg>'))).status).toBe(200)
  })

  it('refuses an HTML document wearing the SVG MIME, uploading nothing', async () => {
    const res = await POST(svg('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>'))
    expect(res.status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('refuses a script payload wearing the SVG MIME', async () => {
    expect((await POST(svg('<script>fetch("https://evil.example")</script>'))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('refuses plain not-XML bytes wearing the SVG MIME', async () => {
    expect((await POST(svg('#!/bin/sh\necho pwned'))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('refuses an element that merely STARTS with svg (<svgfoo>)', async () => {
    expect((await POST(svg('<svgfoo xmlns="x"/>'))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })
})

describe('POST /api/settings/branding/upload — pre-existing refusals unchanged', () => {
  it('400s when file or type is missing', async () => {
    const fd = new FormData()
    fd.append('type', 'logo')
    fd.append('location_id', LOC_A)
    const res = await POST(new Request('http://localhost/api/settings/branding/upload', { method: 'POST', body: fd }))
    expect(res.status).toBe(400)
    expect(db.uploads).toEqual([])
  })

  it('400s a file over 5MB before touching storage', async () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)])
    expect((await POST(req({ bytes: big, name: 'logo.png', mime: 'image/png' }))).status).toBe(400)
    expect(db.uploads).toEqual([])
  })
})
