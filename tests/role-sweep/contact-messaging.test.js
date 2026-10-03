// ROLESWEEP.1c — the 1:1 contact channels (cancellation-form, email,
// whatsapp, the messaging context; sms left with TWILIO-RETIRE.1), the TV image upload, the TV admin
// session routes (MEMBERWRITESWEEP.1f) and the command
// centre's channel flags judge the WEB key OR the MOBILE toggle at the
// contact's / upload's location, never at the caller's ACTIVE studio
// (hasPermission / hasMobilePermission).
// Harness: tests/helpers/role-gate-probe.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => ({ get: () => null }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(), createBrowserClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { describeGate, gateProbe, runProbed } from '../helpers/role-gate-probe.js'
import { webOrMobileCases } from '../helpers/role-sweep-callers-c.js'
import * as cancelForm from '@/app/api/contacts/[id]/cancellation-form/route.js'
import * as email from '@/app/api/contacts/[id]/email/route.js'
import * as whatsapp from '@/app/api/contacts/[id]/whatsapp/route.js'
import * as messaging from '@/app/api/contacts/[id]/messaging/route.js'
import * as commandCentre from '@/app/api/contacts/[id]/command-centre/route.js'
import * as tvUpload from '@/app/api/admin/tv-displays/upload/route.js'
import * as tvUploadSign from '@/app/api/admin/tv-displays/upload/sign/route.js'
import * as tvUploadFinalise from '@/app/api/admin/tv-displays/upload/finalise/route.js'
import * as tvDisplays from '@/app/api/admin/tv-displays/route.js'
import * as tvDisplay from '@/app/api/admin/tv-displays/[id]/route.js'
import * as tvContent from '@/app/api/admin/tv-displays/[id]/content/route.js'
import * as tvTemplates from '@/app/api/admin/tv-templates/route.js'
import * as tvTemplate from '@/app/api/admin/tv-templates/[id]/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const params = (p) => ({ params: Promise.resolve(p) })
const CONTACT_ID = 'c0000000-0000-4000-8000-000000000001'
const contactRow = (fields) => (loc) => [{ data: { id: CONTACT_ID, name: 'Member One', first_name: 'Member', location_id: loc, ...fields }, error: null }]

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }

beforeEach(() => {
  vi.clearAllMocks()
  // cancellation-form's loadContext builds the link base from the app URL.
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
  // …and signs the link token (past the gate) with the service-role key.
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')
})

// ── cancellation-form: GET needs email OR whatsapp; POST the chosen channel ──
// loadContext reads the contact, then its location's settings.
const CANCEL_READS = (loc) => [
  ...contactRow({ email: 'member.one@example.com', email_status: 'active', phone: '+353870000001' })(loc),
  { data: { name: 'Studio', settings: {} }, error: null },
]
describeGate('GET /api/contacts/[id]/cancellation-form (email OR whatsapp, web OR mobile, at the contact)', {
  call: () => cancelForm.GET(bare('GET'), params({ id: CONTACT_ID })),
  gateReads: CANCEL_READS,
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_FOUND, cases: webOrMobileCases(['email', 'whatsapp']),
}, T)
describeGate('POST /api/contacts/[id]/cancellation-form {channel: email}', {
  call: () => cancelForm.POST(json('POST', { channel: 'email' }), params({ id: CONTACT_ID })),
  gateReads: CANCEL_READS,
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — email not enabled at this location for your role' } },
  hidden: NOT_FOUND, cases: webOrMobileCases(['email']),
}, T)

describeGate('POST /api/contacts/[id]/email', {
  call: () => email.POST(json('POST', { subject: 'Hello', body: 'Hi there' }), params({ id: CONTACT_ID })),
  gateReads: contactRow({ email: 'member.one@example.com', email_status: 'active', locations: null }),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — email not enabled at this location for your role' } },
  hidden: NOT_FOUND, cases: webOrMobileCases(['email']),
}, T)

describeGate('POST /api/contacts/[id]/whatsapp', {
  call: () => whatsapp.POST(json('POST', { text: 'Hi there' }), params({ id: CONTACT_ID })),
  gateReads: contactRow({ phone: '+353870000001', wa_phone: null }),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden — WhatsApp not enabled at this location for your role' } },
  hidden: NOT_FOUND, cases: webOrMobileCases(['whatsapp']),
}, T)

describeGate('GET /api/contacts/[id]/messaging', {
  call: () => messaging.GET(bare('GET'), params({ id: CONTACT_ID })),
  gateReads: contactRow({}),
  forbidden: { status: 403, body: { success: false, error: 'Forbidden' } },
  hidden: NOT_FOUND, cases: webOrMobileCases(['whatsapp']),
}, T)

// ── TV image upload: formData location_id (|| active) ─────────────────────
const upload = (loc) => {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'art.png', { type: 'image/png' }))
  fd.append('kind', 'content')
  fd.append('location_id', loc)
  return tvUpload.POST(new Request('http://localhost/api/admin/tv-displays/upload', { method: 'POST', body: fd }))
}
describeGate('POST /api/admin/tv-displays/upload (tv_displays, web OR mobile, at location_id)', {
  call: upload,
  forbidden: { status: 403, body: { success: false, error: 'Not authorised for TV displays' } },
  hidden: NOT_MEMBER, cases: webOrMobileCases(['tv_displays']),
}, T)
// TVUPLOAD.1 (C93) — the phone's signed-upload pair: the same gate as the
// multipart route above (src/lib/tv-upload-gate.js), on the same case table.
describeGate('POST /api/admin/tv-displays/upload/sign (tv_displays, web OR mobile, at location_id)', {
  call: (loc) => tvUploadSign.POST(json('POST', { kind: 'content', location_id: loc, file_name: 'art.png', mime: 'image/png', size: 4 })),
  forbidden: { status: 403, body: { success: false, error: 'Not authorised for TV displays' } },
  hidden: NOT_MEMBER, cases: webOrMobileCases(['tv_displays']),
}, T)
describeGate('POST /api/admin/tv-displays/upload/finalise (tv_displays, web OR mobile, at location_id)', {
  call: (loc) => tvUploadFinalise.POST(json('POST', { kind: 'content', location_id: loc, path: `${loc}/1c000000-0000-4000-8000-000000000003.png` })),
  forbidden: { status: 403, body: { success: false, error: 'Not authorised for TV displays' } },
  hidden: NOT_MEMBER, cases: webOrMobileCases(['tv_displays']),
}, T)

// MEMBERWRITESWEEP.1f — the TV admin's session routes (src/lib/tv-admin.js):
// the upload routes' gate (web OR mobile tv_displays) judged at the TV's or
// the template's OWN studio, or the query/body studio for list and create.
// A studio outside the caller's is a 404 (not 403, as on the upload routes),
// so ids are not enumerable.
const TV_FORBIDDEN = { status: 403, body: { success: false, error: 'Not authorised for TV displays' } }
const TV_ID = 'e0000000-0000-4000-8000-0000000000e1'
const TPL_ID = 'f1000000-0000-4000-8000-0000000000f1'
const tvRow = (loc) => [{ data: { id: TV_ID, location_id: loc }, error: null }]
const tplRow = (loc) => [{ data: { id: TPL_ID, location_id: loc, base_image_path: `${loc}/templates/old.png` }, error: null }]
const tvSpecs = [
  ['GET /api/admin/tv-displays?location_id=', (loc) => tvDisplays.GET(bare('GET', `?location_id=${loc}`)), null],
  ['POST /api/admin/tv-displays', (loc) => tvDisplays.POST(json('POST', { location_id: loc, label: 'Lobby TV' })), null],
  ['PATCH /api/admin/tv-displays/[id]', () => tvDisplay.PATCH(json('PATCH', { rotation: 90 }), params({ id: TV_ID })), tvRow],
  ['DELETE /api/admin/tv-displays/[id]', () => tvDisplay.DELETE(bare('DELETE'), params({ id: TV_ID })), tvRow],
  ['PUT /api/admin/tv-displays/[id]/content', () => tvContent.PUT(json('PUT', { source_type: 'url', source_ref: 'https://example.invalid/a.png' }), params({ id: TV_ID })), tvRow],
  ['DELETE /api/admin/tv-displays/[id]/content', () => tvContent.DELETE(bare('DELETE'), params({ id: TV_ID })), tvRow],
  ['GET /api/admin/tv-templates?location_id=', (loc) => tvTemplates.GET(bare('GET', `?location_id=${loc}`)), null],
  ['POST /api/admin/tv-templates', (loc) => tvTemplates.POST(json('POST', { location_id: loc, name: 'Board', base_image_path: `${loc}/templates/x.png`, zones: [] })), null],
  ['GET /api/admin/tv-templates/[id]', () => tvTemplate.GET(bare('GET'), params({ id: TPL_ID })), tplRow],
  ['PUT /api/admin/tv-templates/[id]', (loc) => tvTemplate.PUT(json('PUT', { name: 'Board', base_image_path: `${loc}/templates/old.png`, zones: [] }), params({ id: TPL_ID })), tplRow],
  ['DELETE /api/admin/tv-templates/[id]', () => tvTemplate.DELETE(bare('DELETE'), params({ id: TPL_ID })), tplRow],
]
for (const [title, call, gateReads] of tvSpecs) {
  describeGate(`${title} (tv_displays, web OR mobile, at the row's / requested studio)`, {
    call, ...(gateReads ? { gateReads } : {}),
    forbidden: TV_FORBIDDEN, hidden: NOT_FOUND, cases: webOrMobileCases(['tv_displays']),
  }, T)
}

// ── command centre: the drawer's channel flags at the contact's location ───
// Not an access gate (the route is membership-only); the flags decide what
// the drawer's composer offers. They make the SEND routes' decision (web OR
// mobile at the contact's location), so they run on the very case table the
// email / whatsapp gates above run on: 'pass' → the flag is on,
// 'forbidden' → off, 'hidden' → the route's own 404 for a non-member. The
// contact read is scripted; every other read answers an empty list, so the
// route runs to completion and the flags are asserted.
describe('GET /api/contacts/[id]/command-centre?scope=drawer — channel flags = the send routes\' decision', () => {
  const EMPTY = { data: [], error: null }
  const flagCases = ['whatsapp', 'email'].flatMap((key) =>
    webOrMobileCases([key]).map(([label, caller, target, want]) => [`${key}: ${label}`, caller, target, key, want]))
  it.each(flagCases)('%s', async (_label, caller, target, key, want) => {
    getCurrentUser.mockResolvedValue(caller)
    const probe = gateProbe([
      { data: { id: CONTACT_ID, name: 'Member One', location_id: target }, error: null },
      ...Array.from({ length: 30 }, () => EMPTY),
    ])
    createServerClient.mockReturnValue(probe.db)
    const { status, body } = await runProbed(probe, () => commandCentre.GET(bare('GET', '?scope=drawer'), params({ id: CONTACT_ID })))
    if (want === 'hidden') {
      expect(status).toBe(404)
      return
    }
    expect(status).toBe(200)
    expect(body.permissions[key]).toBe(want === 'pass')
  })
})
