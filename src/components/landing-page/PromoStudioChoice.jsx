// PromoStudioChoice — OPENWEEK.1: the first step of an all-studios promo page
// (/openweek) when no studio is chosen yet. One large link per studio to
// ?studio=<public path>; the page then renders that studio's own promo card.
// Links, not buttons: nothing here submits, and each choice is a real URL.
import { TRIAL_CARD } from './trial-card'

/** @param {{ heading: string, choices: { path: string, label: string }[] }} props */
export default function PromoStudioChoice({ heading, choices }) {
  return (
    <div id="corp" className={TRIAL_CARD}>
      <h2 className="font-display font-extrabold uppercase text-2xl sm:text-3xl text-black mb-4">{heading}</h2>
      <div className="grid gap-3">
        {choices.map((c) => (
          <a
            key={c.path}
            href={`?studio=${encodeURIComponent(c.path)}`}
            className="block w-full rounded-2xl border border-black/15 bg-white px-5 py-4 font-display font-extrabold uppercase text-lg text-black transition hover:border-black/40"
          >
            {c.label}
          </a>
        ))}
      </div>
    </div>
  )
}
