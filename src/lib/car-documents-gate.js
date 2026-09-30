// CARDOCUPLOAD.1 (C124) — the car-documents upload gate, shared by the
// multipart route (POST /api/cars/[id]/documents) and the signed-upload
// routes (…/documents/sign, …/documents/finalise). It is the multipart
// route's gate (ROLESWEEP.1b) exactly: signed in, car_processing somewhere
// (coarse), the car exists, the caller is a member of the car's studio
// (404 otherwise, so ids can't be enumerated), then car_processing AT the
// car's studio, never the caller's active one. Same statuses and words, so
// tests/role-sweep/cars.test.js runs all three routes on one case table.

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { logWarn } from '@/lib/log'

const FORBIDDEN = () => NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

/**
 * @param {object|null} user  getCurrentUser()
 * @param {object} db  createServerClient()
 * @param {string} carId
 * @returns {Promise<{ car: { id: string, location_id: string } } | { response: Response }>}
 */
export async function carDocumentsGate(user, db, carId) {
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermissionAtAnyLocation(user, 'car_processing')) return { response: FORBIDDEN() }

  // .single() on the primary key: PGRST116 is "no such car" (a 404); any
  // other error is a failed read, not a missing car.
  const { data: car, error } = await db.from('cars').select('id, location_id').eq('id', carId).single()
  if (error && error.code !== 'PGRST116') {
    logWarn('car-documents-gate', 'car read failed', { error: error.message })
    return { response: NextResponse.json({ success: false, error: 'Could not read the car' }, { status: 500 }) }
  }
  if (!car) return { response: NextResponse.json({ success: false, error: 'Not found' }, { status: 404 }) }
  const guard = assertLocationAccessOr404(user, car.location_id)
  if (guard) return { response: guard }
  // ROLESWEEP.1b — judged at the car's location, not the caller's active studio.
  if (!hasPermissionForLocation(user, car.location_id, 'car_processing')) return { response: FORBIDDEN() }
  return { car }
}
