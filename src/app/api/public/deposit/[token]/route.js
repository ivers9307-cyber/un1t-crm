// GET /api/public/deposit/[token]   PUBLIC — no auth.
//
// Returns the data the public deposit page needs to render: car
// summary, deposit amount, T&Cs (current version), and current
// status. Used by the page on initial load and after a return-from-
// Revolut to show the latest state.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select(`
      id, make, model, vehicle_year, uk_reg, irish_reg,
      buyer_name,
      deposit_token, deposit_token_expires_at, deposit_amount, deposit_status,
      deposit_terms_accepted_at, deposit_paid_at, deposit_paid_amount,
      locations ( id, name, car_deposit_terms, car_deposit_terms_version )
    `)
    .eq('deposit_token', params.token)
    .maybeSingle()

  if (!car) {
    return NextResponse.json({ success: false, error: 'Invalid deposit link' }, { status: 404 })
  }

  // Token expiry — paid deposits stay viewable indefinitely so the
  // buyer can come back to their receipt. Unpaid expired tokens
  // return 410 Gone with a specific code so the UI can show a
  // 'link expired, please ask for a new one' state.
  if (car.deposit_status !== 'paid' && car.deposit_token_expires_at) {
    if (new Date(car.deposit_token_expires_at).getTime() <= Date.now()) {
      return NextResponse.json({
        success: false,
        error: 'This deposit link has expired. Please ask the dealer to send you a new one.',
        code: 'TOKEN_EXPIRED',
      }, { status: 410 })
    }
  }

  const carLabel = [car.make, car.model, car.vehicle_year]
    .filter(Boolean).join(' ').trim() || 'Tesla'
  const reg = car.irish_reg || car.uk_reg || null

  return NextResponse.json({
    success: true,
    car: {
      id: car.id,
      label: carLabel,
      reg,
      buyer_name: car.buyer_name,
    },
    amount: Number(car.deposit_amount) || 500,
    currency: 'EUR',
    status: car.deposit_status,
    terms: {
      text: car.locations?.car_deposit_terms || null,
      version: car.locations?.car_deposit_terms_version || 1,
    },
    accepted_at: car.deposit_terms_accepted_at,
    paid_at: car.deposit_paid_at,
    paid_amount: car.deposit_paid_amount != null ? Number(car.deposit_paid_amount) : null,
  })
}
