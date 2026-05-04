// orders — generic order ledger sync + retry detection (mig 085).
//
// The orders table is a denormalised projection of every paid (or
// attempted) transaction. Source-specific tables (race_payments,
// cars.deposit_*) remain the lifecycle source of truth; this module
// keeps the orders row in sync via UPSERT.
//
// Match key for retry detection: lead buyer email only.
//   - race_payments.contact_email (the captain)
//   - cars.buyer_email
// Team-member emails on race_payments are NOT considered.
//
// Retry window: 7 days (RETRY_WINDOW_DAYS). When a new order moves
// to status='completed' AND there's an earlier same-email + same-
// source_type order in failed/abandoned within the window, we link
// them via retry_of_order_id (forward) + superseded_by_order_id
// (backward, also flips the older row to status='recovered').

const RETRY_WINDOW_DAYS = 7

/**
 * UPSERT an orders row from a race_payments record. Idempotent —
 * safe to call repeatedly with the same (or evolving) payment row.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db   service-role client
 * @param {object} args.payment      race_payments row (must include locations relation OR just race_event_id)
 * @returns {Promise<object>} the orders row
 */
export async function syncOrderFromRacePayment({ db, payment }) {
  if (!payment) throw new Error('syncOrderFromRacePayment: payment is required')
  if (!payment.id) throw new Error('syncOrderFromRacePayment: payment.id is required')

  // Resolve location_id + organization_id via the parent race.
  let locationId = payment.location_id || null
  let organizationId = null
  if (!locationId && payment.race_event_id) {
    const { data: race } = await db
      .from('race_events')
      .select('location_id, locations:location_id(organization_id)')
      .eq('id', payment.race_event_id)
      .single()
    if (race) {
      locationId = race.location_id
      organizationId = race.locations?.organization_id || null
    }
  } else if (locationId) {
    const { data: loc } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', locationId)
      .single()
    organizationId = loc?.organization_id || null
  }

  const row = {
    location_id: locationId,
    organization_id: organizationId,
    source_type: 'race_registration',
    source_id: payment.id,
    contact_id: payment.contact_id || null,
    contact_email: payment.contact_email,
    contact_phone: payment.contact_phone || null,
    contact_name: payment.contact_name || null,
    amount_cents: payment.amount_cents,
    currency: payment.currency || 'EUR',
    status: payment.status,
    payment_provider: payment.payment_provider || null,
    payment_provider_ref: payment.payment_provider_ref || null,
    completed_at: payment.completed_at || null,
    failed_at: payment.failed_at || null,
    abandoned_at: payment.abandoned_at || null,
    refunded_at: payment.refunded_at || null,
    refunded_amount_cents: payment.refunded_amount_cents || null,
  }

  const { data, error } = await db
    .from('orders')
    .upsert(row, { onConflict: 'source_type,source_id' })
    .select()
    .single()
  if (error) throw new Error(`orders upsert (race) failed: ${error.message}`)

  // If the just-synced order landed in 'completed', try to link
  // any earlier failed/abandoned order from the same buyer.
  if (data.status === 'completed') {
    await detectRetryRecovery({ db, order: data })
  }
  return data
}

/**
 * UPSERT an orders row from a cars row. Cars store deposit amounts
 * as NUMERIC(10,2) majors — converted to cents here. Map the
 * cars-specific deposit_status to our orders enum.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.car   row from `cars` with at least
 *   { id, location_id, buyer_email, buyer_phone, buyer_name,
 *     deposit_amount, deposit_paid_amount, deposit_status,
 *     deposit_revolut_order_id, deposit_link_sent_at,
 *     deposit_paid_at, make, model, irish_reg, created_at }
 * @returns {Promise<object>} the orders row
 */
export async function syncOrderFromCarDeposit({ db, car }) {
  if (!car) throw new Error('syncOrderFromCarDeposit: car is required')
  if (!car.id) throw new Error('syncOrderFromCarDeposit: car.id is required')
  if (!car.buyer_email) {
    // No buyer email = no retry detection key. Skip silently — the
    // car might still be in operator-fill stage. Caller can retry
    // once the buyer details are populated.
    return null
  }

  const { data: loc } = await db
    .from('locations')
    .select('organization_id')
    .eq('id', car.location_id)
    .single()

  const status = mapCarDepositStatus(car.deposit_status)
  const major = car.deposit_paid_amount != null
    ? Number(car.deposit_paid_amount)
    : Number(car.deposit_amount || 0)
  const amountCents = Math.round(major * 100)

  const row = {
    location_id: car.location_id,
    organization_id: loc?.organization_id || null,
    source_type: 'car_deposit',
    source_id: car.id,
    contact_email: car.buyer_email,
    contact_phone: car.buyer_phone || null,
    contact_name: car.buyer_name || null,
    amount_cents: amountCents,
    currency: 'EUR',
    status,
    payment_provider: car.deposit_revolut_order_id ? 'revolut' : null,
    payment_provider_ref: car.deposit_revolut_order_id || null,
    completed_at: status === 'completed' ? (car.deposit_paid_at || null) : null,
    failed_at: status === 'failed' ? (car.deposit_link_sent_at || null) : null,
    refunded_at: status === 'refunded' ? (car.deposit_paid_at || null) : null,
    metadata: {
      car_make: car.make || null,
      car_model: car.model || null,
      irish_reg: car.irish_reg || null,
    },
  }

  const { data, error } = await db
    .from('orders')
    .upsert(row, { onConflict: 'source_type,source_id' })
    .select()
    .single()
  if (error) throw new Error(`orders upsert (car) failed: ${error.message}`)

  if (data.status === 'completed') {
    await detectRetryRecovery({ db, order: data })
  }
  return data
}

function mapCarDepositStatus(s) {
  switch (s) {
    case 'paid': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'abandoned'
    case 'refunded': return 'refunded'
    case 'sent':
    case 'terms_accepted':
      return 'pending'
    default: return 'pending'
  }
}

/**
 * When a new order completes, look back RETRY_WINDOW_DAYS for any
 * earlier order from the same buyer email + same source_type that
 * ended in failed or abandoned. Link them:
 *   - new.retry_of_order_id   ← old.id  (forward pointer)
 *   - old.superseded_by_order_id ← new.id  (backward pointer)
 *   - old.status              ← 'recovered'
 *
 * Uses the existing partial idx_orders_retry_lookup index.
 *
 * @param {object} args
 * @param {SupabaseClient} args.db
 * @param {object} args.order  the just-completed orders row
 * @returns {Promise<{ recoveredCount: number }>}
 */
export async function detectRetryRecovery({ db, order }) {
  if (!order || order.status !== 'completed') return { recoveredCount: 0 }
  if (!order.contact_email || !order.source_type) return { recoveredCount: 0 }

  const completedAt = order.completed_at ? new Date(order.completed_at) : new Date()
  const windowStart = new Date(completedAt.getTime() - RETRY_WINDOW_DAYS * 86400_000)

  // Find earlier same-buyer same-type orders in failed/abandoned
  // within the window. Exclude self defensively.
  const { data: candidates, error } = await db
    .from('orders')
    .select('id, status')
    .eq('contact_email', order.contact_email)
    .eq('source_type', order.source_type)
    .in('status', ['failed', 'abandoned'])
    .gte('created_at', windowStart.toISOString())
    .lt('created_at', completedAt.toISOString())
    .neq('id', order.id)
  if (error) throw new Error(`retry lookup failed: ${error.message}`)
  if (!candidates || candidates.length === 0) return { recoveredCount: 0 }

  // Mark each candidate as recovered + point at the new order.
  // Use the most recent candidate as the "primary" recovery
  // for the forward-pointer on the new order (retry_of_order_id).
  const ids = candidates.map((c) => c.id)
  await db
    .from('orders')
    .update({
      status: 'recovered',
      superseded_by_order_id: order.id,
    })
    .in('id', ids)

  // Sort newest-first to pick the primary retry_of pointer.
  const { data: sorted } = await db
    .from('orders')
    .select('id, created_at')
    .in('id', ids)
    .order('created_at', { ascending: false })
  const primary = sorted?.[0]
  if (primary) {
    await db
      .from('orders')
      .update({ retry_of_order_id: primary.id })
      .eq('id', order.id)
  }

  return { recoveredCount: candidates.length }
}

// Exported for tests + future ops tooling.
export const __test = {
  RETRY_WINDOW_DAYS,
  mapCarDepositStatus,
}
