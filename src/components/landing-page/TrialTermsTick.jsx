'use client'

// TrialTermsTick — TRIALSTUDIO.10: un1t.online's terms and liability-waiver
// tick on the /trial form for Hatch Street, marked up exactly as the class
// funnel's (src/components/ClassFunnel.jsx): the operator's label with both
// document links. `terms` is un1tTermsPayload's shape.
import { termsLabelSegments } from '@/lib/un1t-online-funnel-copy'

export default function TrialTermsTick({ terms, checked, onChange }) {
  return (
    <label className="flex items-start gap-2.5 text-xs text-white/65">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 w-4 h-4 accent-white" />
      <span>
        {termsLabelSegments({ terms_label: terms.label, terms_link_label: terms.terms_link_label, waiver_link_label: terms.waiver_link_label })
          .map((seg, i) => (seg.link
            ? <a key={i} href={seg.link === 'terms' ? terms.terms_url : terms.waiver_url} target="_blank" rel="noreferrer" className="underline">{seg.text}</a>
            : <span key={i}>{seg.text}</span>))}
      </span>
    </label>
  )
}
