'use client'

// TrialStudioPicker — TRIALSTUDIO.10: the "choose your studio" step of the
// /trial card. One large option per studio: its label (the block's
// studio_label, else the studio's name), price and length. A studio with no
// sellable block cannot be chosen and says so. The tiles are type="button":
// nothing here submits.
import { formatTrialPrice } from '@/lib/paid-trial'

export default function TrialStudioPicker({ studios, onChoose }) {
  return (
    <div>
      <h1 className="font-display font-extrabold uppercase text-2xl text-white mb-4">Choose your studio</h1>
      <div className="grid gap-3">
        {studios.map((s) => (
          <button
            key={s.key}
            type="button"
            disabled={!s.sellable}
            onClick={() => onChoose(s.key)}
            className="w-full text-left rounded-2xl border border-white/15 bg-white/[0.06] px-5 py-4 transition hover:border-white/50 disabled:opacity-50 disabled:hover:border-white/15 disabled:cursor-not-allowed"
          >
            <span className="flex items-center justify-between gap-3">
              <span className="font-display font-extrabold uppercase text-lg text-white">{s.label}</span>
              {s.sellable ? (
                <span className="text-right shrink-0">
                  <span className="block font-display font-extrabold text-2xl text-white leading-none">{formatTrialPrice(s.priceCents, s.currency)}</span>
                  <span className="block text-xs text-white/60 mt-1">{s.durationDays} days</span>
                </span>
              ) : (
                <span className="text-xs text-white/60 shrink-0">Not available online</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
