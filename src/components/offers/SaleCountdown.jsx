'use client'

// SaleCountdown — big red ticking countdown for the /offers pages
// (OFFERS.7). endsAt is a timestamptz ISO string; the maths is pure
// absolute-instant subtraction (no Dublin wall-clock parsing).
import { useEffect, useState } from 'react'

const pad = (n) => String(n).padStart(2, '0')

// doneLabel: what shows once the instant passes (an "Opens" countdown says
// the sale is open, not that it ended).
// calmLabel (OFFERSDESIGN.1): shown instead of the ticking clock while more
// than CALM_MS remain, so a two-week sale reads as a date, not a red blur;
// the clock takes over for the last 48 hours. The server formats it on the
// studio's clock (formatSaleDeadline), since only it knows the zone.
export const CALM_MS = 48 * 3600 * 1000

export default function SaleCountdown({ endsAt, doneLabel = 'SALE ENDED', calmLabel = null }) {
  // Render a placeholder until mounted so SSR and client HTML agree.
  const [now, setNow] = useState(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (now === null) return <span className={calmLabel ? 'ofr-count ofr-count-calm' : 'ofr-count'}>{calmLabel || '—'}</span>
  const ms = new Date(endsAt).getTime() - now
  if (ms <= 0) return <span className="ofr-count">{doneLabel}</span>
  if (calmLabel && ms > CALM_MS) return <span className="ofr-count ofr-count-calm">{calmLabel}</span>
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
