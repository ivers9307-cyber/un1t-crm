'use client'

// SaleCountdown — big red ticking countdown for the /offers pages
// (OFFERS.7). endsAt is a timestamptz ISO string; the maths is pure
// absolute-instant subtraction (no Dublin wall-clock parsing).
import { useEffect, useState } from 'react'

const pad = (n) => String(n).padStart(2, '0')

export default function SaleCountdown({ endsAt }) {
  // Render a placeholder until mounted so SSR and client HTML agree.
  const [now, setNow] = useState(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (now === null) return <span className="ofr-count">—</span>
  const ms = new Date(endsAt).getTime() - now
  if (ms <= 0) return <span className="ofr-count">SALE ENDED</span>
  const d = Math.floor(ms / 86400000)
  const h = Math.floor(ms / 3600000) % 24
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  return (
    <span className="ofr-count">
      {d > 0 ? `${d}D ` : ''}{pad(h)}H {pad(m)}M {pad(s)}S
    </span>
  )
}
