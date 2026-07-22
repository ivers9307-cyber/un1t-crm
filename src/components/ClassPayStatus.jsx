'use client'
import { useEffect, useState } from 'react'

export default function ClassPayStatus({ paymentId }) {
  const [state, setState] = useState('loading') // loading | paid | pending | failed | notfound
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`/api/public/class-booking-payments/${paymentId}`, { cache: 'no-store' })
        if (r.status === 404) { if (!stopped) setState('notfound'); return }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (!stopped) {
          if (d?.paid) { setState('paid'); return }
          if (d?.payment_status === 'failed' || d?.payment_status === 'expired' || d?.booking_status === 'payment_failed') { setState('failed'); return }
          setState('pending')
        }
      } catch { if (!stopped) setState('pending') }
      if (!stopped) setTimeout(tick, 3000)
    }
    tick()
    return () => { stopped = true }
  }, [paymentId])

  const wrap = (title, body) => (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-white/12 bg-black/45 backdrop-blur-xl px-6 py-10 text-center">
        <p className="font-display font-extrabold uppercase text-3xl mb-3">{title}</p>
        <p className="text-white/70">{body}</p>
      </div>
    </div>
  )

  if (state === 'paid') return wrap("You're being booked in 🎉", "That's your first class — watch for a WhatsApp confirming it. See you soon!")
  if (state === 'failed') return wrap('Payment didn’t go through', 'No charge was taken. You can close this page and start again from the class page.')
  if (state === 'notfound') return wrap('Not found', 'We couldn’t find that payment. You can safely close this page.')
  return wrap('Confirming your payment…', 'One moment — this page updates automatically.')
}
