// A labelled field row shared by the WhatsApp settings forms: the studio tab's
// cards (WhatsAppIntegrationTab) and the organisation's number forms
// (OrgWhatsAppNumbers). One copy, so the two cannot drift.

export function Row({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-un1t-subtle mb-0.5">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-un1t-muted mt-0.5">{hint}</div>}
    </label>
  )
}
