// CARDLENS.2 — which studio a row on the contact page belongs to. `names` is
// studioNameMap() output: empty for a single-studio person, so nothing renders.
export default function StudioTag({ locationId, names }) {
  const name = locationId ? names?.[locationId] : null
  if (!name) return null
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-500/10 text-slate-700 whitespace-nowrap">
      {name}
    </span>
  )
}
