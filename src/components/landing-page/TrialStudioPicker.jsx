'use client'

// TrialStudioPicker — TRIALSTUDIO.10: the "choose your studio" step of the
// /trial card. One large option per studio: its label (the block's
// studio_label, else the studio's name), price and length. A studio with no
// sellable block cannot be chosen and says so. The tiles are type="button":
// nothing here submits. TRIALFIRST.1: white tiles on the white trial card.
import { formatTrialPrice } from '@/lib/paid-trial'
import { TRIAL_MUTED } from './trial-card'

export default function TrialStudioPicker({ studios, onChoose }) {
  return (
    <div>
      <h1 className="font-display font-extrabold text-2xl text-black mb-4">Choose your studio</h1>
      <div className="grid gap-3">
        {studios.map((s) => (
          <button
            key={s.key}
            type="button"
            disabled={!s.sellable}
            onClick={() => onChoose(s.key)}
            className="w-full text-left rounded border border-black/15 bg-white px-5 py-4 transition hover:border-black disabled:opacity-50 disabled:hover:border-black/15 disabled:cursor-not-allowed"
          >
            <span className="flex items-center justify-between gap-3">
              <span className="font-display font-extrabold uppercase text-lg text-black">{s.label}</span>
              {s.sellable ? (
                <span className="text-right shrink-0">
                  <span className="block font-display font-extrabold text-2xl text-black leading-none">{formatTrialPrice(s.priceCents, s.currency)}</span>
                  <span className={`block text-xs mt-1 ${TRIAL_MUTED}`}>{s.durationDays} days</span>
                </span>
              ) : (
                <span className={`text-xs shrink-0 ${TRIAL_MUTED}`}>Not available online</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
