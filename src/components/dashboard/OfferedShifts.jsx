'use client'
// REPLACE.1b — "Shifts up for grabs" on /dashboard/today: shifts a manager
// offered to the team that the viewer could take (GET /api/schedule/offers,
// the same default-6 rule as the push). Claim = first come, first served;
// the server's words say who won. When, what and where only: never a count
// or a minimum (COACHSCOPE.1). Renders nothing when nothing is on offer.
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Megaphone } from 'lucide-react'
import { SectionHeader } from '@/components/dashboard/Cards'
import { offerWhenLine, offerClaimResultText } from '@shared/offer-to-team'

export default function OfferedShifts({ locationId }) {
  const router = useRouter()
  const [offers, setOffers] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [message, setMessage] = useState(null) // { tone, text }

  const load = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/schedule/offers?location_id=${encodeURIComponent(locationId)}`)
      const json = await res.json().catch(() => ({}))
      setOffers(res.ok && json.success ? (json.data || []) : [])
    } catch (e) {
      console.error('[OfferedShifts] load error:', e?.message || e)
    }
  }, [locationId])

  useEffect(() => { load() }, [load])

  async function claim(offer) {
    if (busyId) return
    setBusyId(offer.id)
    setMessage(null)
    try {
      const res = await fetch(`/api/schedule/offers/${offer.id}/claim`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      setMessage(offerClaimResultText(res.status, json))
      await load()
      if (res.ok && json.success) router.refresh()
    } catch {
      setMessage({ tone: 'error', text: 'Network error. Please try again.' })
    } finally {
      setBusyId(null)
    }
  }

  if (offers.length === 0 && !message) return null
  return (
    <>
      <SectionHeader title="Shifts up for grabs" count={offers.length || null} />
      {message && (
        <p role="status" className={`mb-2 text-xs px-3 py-2 rounded-md ${message.tone === 'success' ? 'bg-green-500/10 text-green-700' : 'bg-red-500/10 text-red-700'}`}>
          {message.text}
        </p>
      )}
      {offers.length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden mb-3">
          {offers.map((o, i) => {
            const when = offerWhenLine(o)
            const title = [o.shift_name || 'Shift', o.studio_name].filter(Boolean).join(' · ')
            return (
              <div key={o.id} className={`flex items-center gap-3 px-4 py-3 ${i < offers.length - 1 ? 'border-b border-un1t-border' : ''}`}>
                <Megaphone size={16} className="text-un1t-subtle flex-shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-un1t-text truncate">{title}</div>
                  {when ? <div className="text-xs text-un1t-subtle truncate">{when}</div> : null}
                </div>
                <button
                  type="button"
                  onClick={() => claim(o)}
                  disabled={!!busyId}
                  aria-label={`Claim ${o.shift_name || 'shift'}, ${when}`}
                  className="text-xs font-semibold px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg hover:bg-un1t-accent disabled:opacity-50 flex-shrink-0"
                >
                  {busyId === o.id ? '…' : 'Claim'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
