// ROLESWEEP.1b — every /api/cars route judges `car_processing` at the car's /
// document's / note's / body's / query's location, never at the caller's
// ACTIVE studio (`hasPermission(user, 'car_processing')`) — the CCF Autos
// shape, where the feature is on at one location and off at the others.
// The list GET narrows "every location I belong to" to the ones where the
// caller holds car_processing THERE.
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
import { permissionCases, person, keyOffAtB, masterFeatureOffAtB, OUTSIDER, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as cars from '@/app/api/cars/route.js'
import * as car from '@/app/api/cars/[id]/route.js'
import * as bca from '@/app/api/cars/[id]/bca/route.js'
import * as bcaSubmit from '@/app/api/cars/[id]/bca/submit/route.js'
import * as bcaUpload from '@/app/api/cars/[id]/bca/uploads/[slug]/route.js'
import * as cancelDeposit from '@/app/api/cars/[id]/cancel-deposit/route.js'
import * as doc from '@/app/api/cars/[id]/documents/[docId]/route.js'
import * as sendToXero from '@/app/api/cars/[id]/documents/[docId]/send-to-xero/route.js'
import * as docs from '@/app/api/cars/[id]/documents/route.js'
import * as depositLink from '@/app/api/cars/[id]/issue-deposit-link/route.js'
import * as issueInvoice from '@/app/api/cars/[id]/issue-xero-invoice/route.js'
import * as note from '@/app/api/cars/[id]/notes/[noteId]/route.js'
import * as notes from '@/app/api/cars/[id]/notes/route.js'
import * as promote from '@/app/api/cars/[id]/promote/route.js'
import * as voidInvoice from '@/app/api/cars/[id]/void-xero-invoice/route.js'
import * as contactSearch from '@/app/api/cars/[id]/xero-contact-search/route.js'
import * as invoicePdf from '@/app/api/cars/[id]/xero-invoice-pdf/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
// describeGate with each row's expected outcome in its title ("… (main: pass) → forbidden").
const gate = (title, spec) => describeGate(title, { ...spec, cases: spec.cases.map(([l, c, t, o]) => [`${l} → ${o}`, c, t, o]) }, T)
const json = (method, body, qs = '') => new Request(`http://localhost/api/x${qs}`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const bare = (method, qs = '') => new Request(`http://localhost/api/x${qs}`, { method })
const form = () => new Request('http://localhost/api/x', { method: 'POST', body: new FormData() })
const params = (p) => ({ params: Promise.resolve(p) })
const row = (fields) => (loc) => [{ data: { ...fields, location_id: loc }, error: null }]
const nested = (make) => (loc) => [{ data: make(loc), error: null }]

const KEY = 'car_processing'
// car_processing is off by default even for an owner, so the non-member row
// needs the key granted at their own studio to reach the membership check.
const carOutsider = person({ [LOC_A]: { role: 'owner', permissions: { [KEY]: true } } }, LOC_A)
const CASES = permissionCases(KEY).map(([l, c, t, o]) => [l, c === OUTSIDER ? carOutsider : c, t, o])

const NOT_FOUND = { status: 404, body: { success: false, error: 'Not found' } }
const NOT_MEMBER = { status: 403, body: { success: false, error: 'Forbidden — location not in your assignments' } }
const FORBIDDEN_PLAIN = { status: 403, body: { success: false, error: 'Forbidden' } }
const NOT_PERMITTED = { status: 403, body: { success: false, error: 'Not permitted' } }

beforeEach(() => vi.clearAllMocks())

// ── list + create ─────────────────────────────────────────────────────────
gate('GET /api/cars?location_id= — car_processing at the location', {
  call: (loc) => cars.GET(bare('GET', `?location_id=${loc}`)),
  forbidden: FORBIDDEN_PLAIN, hidden: NOT_MEMBER, cases: CASES,
})
gate('POST /api/cars — car_processing at body.location_id', {
  call: (loc) => cars.POST(json('POST', { location_id: loc, make: 'Ford', fx_gbp_to_eur: 1.17 })),
  forbidden: FORBIDDEN_PLAIN, hidden: NOT_MEMBER, cases: CASES,
})
describe('GET /api/cars (no location_id) lists only locations where the caller holds car_processing', () => {
  for (const [label, caller] of [
    ['drops B where car_processing is switched off for them (main listed A and B)', keyOffAtB(KEY)],
    // A master is scored at each location's features: the feature is off at B.
    ['a master: drops B where the car_processing feature is off (main listed A and B)', masterFeatureOffAtB(KEY)],
  ]) {
    it(label, async () => {
      getCurrentUser.mockResolvedValue(caller)
      const probe = gateProbe([])
      createServerClient.mockReturnValue(probe.db)
      await runProbed(probe, () => cars.GET(bare('GET')))
      expect(probe.tripped.table).toBe('cars')
      expect(probe.tripped.chain).toContainEqual(['in', 'location_id', [LOC_A]])
    })
  }
})

// ── detail routes ─────────────────────────────────────────────────────────
const CAR = row({ id: 'car-1', make: 'Ford', model: 'Focus', status: 'pending', deposit_status: null, xero_invoice_id: null, xero_invoice_pdf_path: null, car_documents: [] })
// The invoice-PDF route answers a 404 'No invoice PDF saved' right after the
// gate when the path is empty; the merged harness counts a 404 as a refusal,
// so that row carries a saved path and reaches the storage tripwire instead.
const CAR_WITH_PDF = row({ id: 'car-1', make: 'Ford', model: 'Focus', status: 'pending', deposit_status: null, xero_invoice_id: null, xero_invoice_pdf_path: 'car-1/invoice.pdf', car_documents: [] })
const DOC = nested((loc) => ({ id: 'doc-1', car_id: 'car-1', storage_path: 'car-1/doc.pdf', filename: 'doc.pdf', cars: { id: 'car-1', location_id: loc } }))
const CAR_ID = { id: 'car-1' }
const DETAIL = [
  ['GET /api/cars/[id]', () => car.GET(bare('GET'), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['PATCH /api/cars/[id]', () => car.PATCH(json('PATCH', { make: 'Toyota' }), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['DELETE /api/cars/[id]', () => car.DELETE(bare('DELETE'), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['GET /api/cars/[id]/bca', () => bca.GET(bare('GET'), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['POST /api/cars/[id]/bca/submit', () => bcaSubmit.POST(bare('POST'), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['POST /api/cars/[id]/bca/uploads/[slug]', () => bcaUpload.POST(form(), params({ id: 'car-1', slug: 'v5c' })), CAR, FORBIDDEN_PLAIN],
  ['DELETE /api/cars/[id]/bca/uploads/[slug]', () => bcaUpload.DELETE(bare('DELETE'), params({ id: 'car-1', slug: 'v5c' })), CAR, FORBIDDEN_PLAIN],
  ['POST /api/cars/[id]/cancel-deposit', () => cancelDeposit.POST(bare('POST'), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['GET /api/cars/[id]/documents/[docId]', () => doc.GET(bare('GET'), params({ id: 'car-1', docId: 'doc-1' })), DOC, FORBIDDEN_PLAIN],
  ['DELETE /api/cars/[id]/documents/[docId]', () => doc.DELETE(bare('DELETE'), params({ id: 'car-1', docId: 'doc-1' })), DOC, FORBIDDEN_PLAIN],
  ['POST /api/cars/[id]/documents/[docId]/send-to-xero', () => sendToXero.POST(bare('POST'), params({ id: 'car-1', docId: 'doc-1' })), DOC, NOT_PERMITTED],
  ['POST /api/cars/[id]/documents', () => docs.POST(form(), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['POST /api/cars/[id]/issue-deposit-link', () => depositLink.POST(json('POST', {}), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['POST /api/cars/[id]/issue-xero-invoice', () => issueInvoice.POST(bare('POST'), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['DELETE /api/cars/[id]/notes/[noteId]', () => note.DELETE(bare('DELETE'), params({ id: 'car-1', noteId: 'note-1' })), row({ id: 'note-1' }), NOT_PERMITTED],
  ['GET /api/cars/[id]/notes', () => notes.GET(bare('GET'), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['POST /api/cars/[id]/notes', () => notes.POST(json('POST', { content: 'Collected from the port' }), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['POST /api/cars/[id]/promote', () => promote.POST(json('POST', { to: 'completed' }), params(CAR_ID)), CAR, FORBIDDEN_PLAIN],
  ['POST /api/cars/[id]/void-xero-invoice', () => voidInvoice.POST(bare('POST'), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['GET /api/cars/[id]/xero-contact-search', () => contactSearch.GET(bare('GET', '?q=ford'), params(CAR_ID)), CAR, NOT_PERMITTED],
  ['GET /api/cars/[id]/xero-invoice-pdf', () => invoicePdf.GET(bare('GET'), params(CAR_ID)), CAR_WITH_PDF, NOT_PERMITTED],
]
for (const [name, call, gateReads, forbidden] of DETAIL) {
  gate(`${name} — car_processing at the car`, { call, gateReads, forbidden, hidden: NOT_FOUND, cases: CASES })
}

// A master is refused a car whose location has the car_processing feature off,
// even with it on at their active studio (open question 1: the one car at a
// UN1T studio). main let them through on the active studio's feature.
for (const [name, call] of [
  ['GET /api/cars/[id]', () => car.GET(bare('GET'), params(CAR_ID))],
  ['PATCH /api/cars/[id]', () => car.PATCH(json('PATCH', { make: 'Toyota' }), params(CAR_ID))],
  ['DELETE /api/cars/[id]', () => car.DELETE(bare('DELETE'), params(CAR_ID))],
]) {
  gate(`${name} — a master, car_processing off at the car's location`, {
    call, gateReads: CAR, forbidden: FORBIDDEN_PLAIN, hidden: NOT_FOUND,
    cases: [["a master, feature off at the car's location, on at the active one (main: pass)", masterFeatureOffAtB(KEY), LOC_B, 'forbidden']],
  })
}
