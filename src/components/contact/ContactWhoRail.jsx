// CC.2 — the "who they are" rail of the command-centre contact page:
// linked accounts, identity (emails/phones, cross-account when
// grouped), CRM details, the Glofox membership card, and marketing
// preferences. Server component — cards moved verbatim from the old
// Overview / Admin tabs.

import { Mail, Phone } from 'lucide-react'
import LinkedAccountsCard from '@/components/LinkedAccountsCard'
import ContactMarketingPreferencesCard from '@/components/ContactMarketingPreferencesCard'
import GlofoxProfileCard from './GlofoxProfileCard'

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-un1t-subtle">{label}</span>
      <span className="font-medium">{value ?? '—'}</span>
    </div>
  )
}

export default function ContactWhoRail({ contact, person, identityEmails, identityPhones, canEditPrefs }) {
  return (
    <>
      {/* PERSON-LINK.1 — linked accounts (or "not linked" CTA when single). */}
      <LinkedAccountsCard person={person} contactId={contact.id} locationId={contact.location_id} />

      {/* Identity — emails + phones (deduped across the group when linked). */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-1">Identity</h3>
        <div className="space-y-1.5">
          {identityEmails.length === 0 && identityPhones.length === 0 && (
            <p className="text-sm text-un1t-muted">No contact details</p>
          )}
          {identityEmails.map((e) => (
            <div key={`em-${e.value}`} className="flex items-center gap-2 text-sm text-un1t-text">
              <Mail size={14} className="text-un1t-subtle shrink-0" />
              <span className="truncate">{e.value}</span>
              {e.contactable === false && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-700">
                  Not contactable
                </span>
              )}
            </div>
          ))}
          {identityPhones.map((p) => (
            <div key={`ph-${p.value}`} className="flex items-center gap-2 text-sm text-un1t-text">
              <Phone size={14} className="text-un1t-subtle shrink-0" />
              <span className="truncate">{p.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Info Card. GLOFOX2.9 — Glofox-specific fields live in the
          dedicated Glofox Profile card below; this card only carries
          CRM-native identifiers. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Details</h3>
        <InfoRow label="Source" value={contact.lead_source || contact.source} />
        <InfoRow label="Label" value={contact.label || '—'} />
        <InfoRow label="Created" value={new Date(contact.created_at).toLocaleDateString('en-IE')} />
      </div>

      <GlofoxProfileCard contact={contact} />

      {/* CONSENT.1 — operator toggles for marketing email / SMS /
          WhatsApp. Transactional sends stay on regardless. */}
      <ContactMarketingPreferencesCard
        contactId={contact.id}
        canEdit={canEditPrefs}
        glofoxMembershipStatus={contact.glofox_membership_status}
      />
    </>
  )
}
