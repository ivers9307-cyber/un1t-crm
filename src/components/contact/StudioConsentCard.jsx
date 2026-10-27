// CARDLENS.10 — marketing consent per studio (contact_location_preferences),
// read-only, for a person with two or more studios the viewer can act at.
// WhatsApp STOP / START are per studio (WAORGNUMBER.3) and a studio's email
// sends check that studio's row (LOCCOMMS.5), so one contact-wide flag hid
// what actually applies. No row at a studio = not on that studio's list.
// Edits stay with the Marketing preferences card and the preference centre.

const CHANNELS = [
  { key: 'email_marketing', label: 'Email marketing' },
  { key: 'whatsapp_marketing', label: 'WhatsApp marketing' },
]

function cell(row, key) {
  if (!row) return { text: 'Not on list', cls: 'text-un1t-subtle' }
  return row[key] === true
    ? { text: 'On', cls: 'text-emerald-700 font-semibold' }
    : { text: 'Off', cls: 'text-red-700 font-semibold' }
}

/**
 * @param {{ studios: Array<{ locationId: string, name: string }>, rows: Array<object>|null }} p
 *   rows null = the read failed
 */
export default function StudioConsentCard({ studios = [], rows }) {
  if (!Array.isArray(studios) || studios.length < 2) return null
  const byLoc = new Map((rows || []).map((r) => [r.location_id, r]))
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Consent by studio</h3>
      {rows == null ? (
        <p className="text-sm text-un1t-muted">Could not load consent by studio.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left font-normal text-un1t-subtle" scope="col"><span className="sr-only">Channel</span></th>
              {studios.map((s) => (
                <th key={s.locationId} scope="col" className="text-left text-[11px] font-semibold text-un1t-subtle">{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CHANNELS.map((c) => (
              <tr key={c.key}>
                <th scope="row" className="text-left font-normal text-un1t-text py-1 pr-2">{c.label}</th>
                {studios.map((s) => {
                  const v = cell(byLoc.get(s.locationId), c.key)
                  return <td key={s.locationId} className={`py-1 ${v.cls}`}>{v.text}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
