// ROLESWEEP.1b — company-card receipts judge `card_receipts` at the receipt's
// location (body.location_id, or the caller's sole location), never at the
// caller's ACTIVE studio. The upload-sign step knows no location, so its
// check is the coarse "you hold card_receipts somewhere".
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
import { describeGate } from '../helpers/role-gate-probe.js'
import { permissionCases, person, keyOnAtBOnly, featureOffAtA, masterFeatureOffAtA, LOC_A, LOC_B } from '../helpers/role-sweep-callers.js'
import * as receipts from '@/app/api/card-receipts/route.js'
import * as uploadSign from '@/app/api/card-receipts/upload-sign/route.js'

const T = { getCurrentUser, createServerClient, describe, it, expect }
// describeGate with each row's expected outcome in its title ("… (main: pass) → forbidden").
const gate = (title, spec) => describeGate(title, { ...spec, cases: spec.cases.map(([l, c, t, o]) => [`${l} → ${o}`, c, t, o]) }, T)
const json = (method, body) => new Request('http://localhost/api/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const KEY = 'card_receipts'
const NO_PERMISSION = { status: 403, body: { success: false, error: 'You do not have permission to submit company-card receipts.' } }

beforeEach(() => vi.clearAllMocks())

gate('POST /api/card-receipts — card_receipts at body.location_id', {
  call: (loc) => receipts.POST(json('POST', { location_id: loc, receipt_path: 'user-1/receipt.pdf', receipt_name: 'receipt.pdf' })),
  forbidden: NO_PERMISSION,
  hidden: { status: 403, body: { success: false, error: 'You are not assigned to that location.' } },
  cases: permissionCases(KEY),
})

// No location is known at upload-sign, so there is no non-member refusal;
// `hidden` is a placeholder no response can match.
gate('POST /api/card-receipts/upload-sign — card_receipts at any location', {
  call: () => uploadSign.POST(json('POST', { size: 1000, mime: 'application/pdf', file_name: 'receipt.pdf' })),
  forbidden: NO_PERMISSION,
  hidden: { status: 0, body: null },
  cases: [
    [`${KEY} switched off for them at A only, A active (main: forbidden)`, keyOnAtBOnly(KEY), LOC_B, 'pass'],
    [`feature ${KEY} off at A's location, A active (main: forbidden)`, featureOffAtA(KEY), LOC_B, 'pass'],
    [`a master with feature ${KEY} off at the active location (main: forbidden)`, masterFeatureOffAtA(KEY), LOC_B, 'pass'],
    [`${KEY} switched off for them at both studios`, person({ [LOC_A]: { role: 'owner', permissions: { [KEY]: false } }, [LOC_B]: { role: 'owner', permissions: { [KEY]: false } } }, LOC_A), LOC_B, 'forbidden'],
  ],
})
