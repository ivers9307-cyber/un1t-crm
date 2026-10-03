// ROLEUI.1 — the contact and booking-type pages decide their gates and their
// action buttons where the action happens (the contact's / the booking type's
// location), never on the ACTIVE studio: no ROLES.includes(user.role), no
// user.role === 'owner', no hasPermission(user, …) / hasMobilePermission(user,
// …) in these files (comments ignored). Same token set as the API guard
// (scripts/lib/active-role-gates.mjs). A floor, not a proof: the decisions
// themselves are pinned in src/lib/contact-page-gates.test.js,
// src/lib/event-type-gates.test.js and each page's own test.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { activeRoleGates } from '../scripts/lib/active-role-gates.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PAGES = [
  'src/app/(sales)/contacts/[id]/page.js',
  'src/app/(sales)/contacts/[id]/edit/page.js',
  'src/app/(sales)/contacts/new/page.js',
  'src/app/(members)/bookings/event-types/page.js',
  'src/app/(members)/bookings/event-types/new/page.js',
  'src/app/(members)/bookings/event-types/[id]/page.js',
  'src/app/(members)/bookings/event-types/[id]/edit/page.js',
  // PAGEGATES.1 — the detail pages aligned with their routes (each page's
  // own test pins the decision).
  'src/app/(members)/events/[id]/edit/page.js',
  'src/app/(members)/events/[id]/teams/page.js',
  'src/app/events/[id]/checkin/page.js',
  'src/app/events/[id]/checkin/scan/page.js',
  'src/app/events/[id]/control/page.js',
  'src/app/(money)/orders/[id]/page.js',
  'src/app/(operations)/presentations/[id]/page.js',
  'src/app/presentations/[id]/present/page.js',
  'src/app/(sales)/contacts/imports/[id]/page.js',
  'src/app/cars/[id]/page.js',
  'src/app/communications/(marketing-era)/sent/[channel]/[id]/page.js',
  'src/app/settings/staff/[id]/page.js',
  'src/components/settings/LocationIntegrations.jsx',
]

describe('ROLEUI.1 — no active-studio gate on the contact and booking-type pages', () => {
  it.each(PAGES)('%s', (file) => {
    expect(activeRoleGates(readFileSync(path.join(ROOT, file), 'utf8'))).toEqual([])
  })
})
