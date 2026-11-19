// SaleOffersCard — SALEPAGE.1: the offer card of a page-builder sale. Lists
// the studio's chosen offers (from Settings > Offers), each a link to its own
// /offers page where it is bought: this card sells nothing itself. Plain data
// props only (a server page renders it, and the editor preview rebuilds it
// with the live block's words).
import { TRIAL_CARD, TRIAL_MUTED, TRIAL_FINE } from './trial-card'

/**
 * @param {{
 *   copy: { eyebrow?: string, heading?: string, subhead?: string, empty_text?: string },
 *   offers: { id: string, name: string, bonus: string|null, price: string, href: string, opensLabel?: string|null }[],
 *   readFailed?: boolean,
 * }} props
 */
export default function SaleOffersCard({ copy = {}, offers = [], readFailed = false }) {
  return (
    <div id="sale" className={TRIAL_CARD}>
      {copy.eyebrow && <p className={`text-xs font-bold uppercase tracking-widest ${TRIAL_MUTED} mb-2`}>{copy.eyebrow}</p>}
      {copy.heading && <h2 className="font-display font-extrabold uppercase text-2xl sm:text-3xl text-black mb-2">{copy.heading}</h2>}
      {copy.subhead && <p className={`text-sm ${TRIAL_MUTED} mb-4`}>{copy.subhead}</p>}
      {readFailed ? (
        <p className={TRIAL_FINE}>We couldn&apos;t load the offers just now. Please try again in a minute.</p>
      ) : offers.length === 0 ? (
        <p className={TRIAL_FINE}>{copy.empty_text || 'No offers are on right now.'}</p>
      ) : (
        <ul className="grid gap-3">
          {offers.map((o) => (
            <li key={o.id}>
              <a
                href={o.href}
                className="flex items-center justify-between gap-4 rounded-2xl border border-black/15 bg-white px-5 py-4 transition hover:border-black/40"
              >
                <span className="min-w-0">
                  <span className="block font-display font-extrabold uppercase text-lg text-black">{o.bonus || o.name}</span>
                  {o.bonus && <span className={`block text-sm ${TRIAL_MUTED}`}>{o.name}</span>}
                  {o.opensLabel && <span className="block text-xs text-amber-700 mt-0.5">{o.opensLabel}</span>}
                </span>
                <span className="shrink-0 font-display font-extrabold text-xl text-black">{o.price}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The card's words off a sale_offers block. Pure. */
export function saleOffersCopy(block) {
  const b = block && typeof block === 'object' ? block : {}
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  return { eyebrow: s(b.eyebrow), heading: s(b.heading), subhead: s(b.subhead), empty_text: s(b.empty_text), cta_label: s(b.cta_label) }
}
