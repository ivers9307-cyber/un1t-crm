// ORDERSTRIALS.1 — trials and offers read sensibly in the Orders table.
import { describe, it, expect } from 'vitest'
import { orderSourceDetail, REFUNDABLE_PROVIDERS } from './OrdersTable.jsx'

describe('orderSourceDetail', () => {
  it('names the trial product and the offer', () => {
    expect(orderSourceDetail({ source_type: 'trial_purchase', metadata: { product_name: '14 Day Reset' } })).toBe('14 Day Reset')
    expect(orderSourceDetail({ source_type: 'offer_purchase', metadata: { offer_name: '30 + 10 pack' } })).toBe('30 + 10 pack')
  })
  it('keeps the car and race lines as they were', () => {
    expect(orderSourceDetail({ source_type: 'car_deposit', metadata: { car_make: 'VW', car_model: 'Golf', irish_reg: '191D1' } })).toBe('VW Golf 191D1')
    expect(orderSourceDetail({ source_type: 'race_registration', metadata: {} })).toBe('')
  })
  it('offers a refund on un1t.online orders too (it files a card)', () => {
    expect(REFUNDABLE_PROVIDERS).toEqual(['revolut', 'stripe_connect', 'un1t_online'])
  })

  it('names the class, the payment link product and the fee class (ORDERSMORE.1)', () => {
    expect(orderSourceDetail({ source_type: 'class_booking', metadata: { class_name: 'HYROX' } })).toBe('HYROX')
    expect(orderSourceDetail({ source_type: 'staff_payment_link', metadata: { product_title: '1 Month' } })).toBe('1 Month')
    expect(orderSourceDetail({ source_type: 'class_fee', metadata: { class_title: 'Strength' } })).toBe('Strength')
    expect(orderSourceDetail({ source_type: 'donation', metadata: { race_event_id: 'r1' } })).toBe('')
  })
})
