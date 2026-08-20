// /account/contracts/[id] — recipient's view of one contract.
//   - Shows the issuer's countersignature.
//   - When status is issued/viewed, shows the sign form.
//   - When signed, shows the dual-signature block (timestamp+IP).
//   - When declined/revoked, shows the explanation.
// First-view side-effect (issued -> viewed) happens inside the
// GET /api/contracts/[id] route, but here we render straight from
// Supabase to avoid a round trip; the explicit "viewed" tick will
// fire when the recipient navigates here via the API path or
// reloads after a state change.

import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getContractingEntity } from '@/lib/contracting-entity'
import ContractSignForm from '@/components/ContractSignForm'
import ContractPrintButton from '@/components/ContractPrintButton'
import ContractBody from '@/components/ContractBody'

export const dynamic = 'force-dynamic'

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default async function AccountContractDetail(props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const db = createServerClient()
  const { data: c } = await db
    .from('contracts')
    .select(`
      *,
      profile:profiles!profile_id (id, full_name, email),
      issuer:profiles!issued_by (id, full_name),
      template:contract_templates!template_id (name, version)
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (!c) notFound()
  // Hard guard — RLS would block this anyway, but the explicit
  // check gives a friendlier 404 than a SELECT-no-rows.
  if (c.profile_id !== user.id) notFound()
  // CONTRACTS-DRAFT.1 — this page is recipient-only (no master/owner
  // branch exists here, unlike the admin detail page), so the check
  // is unconditional: a draft is issuer-side work-in-progress the
  // recipient was never notified about, full stop.
  if (c.status === 'draft') notFound()

  // First-time view-tracking — best-effort flip from issued -> viewed
  // straight from this page so the issuer sees signal even if the
  // recipient never hits the API GET separately. Can never touch a
  // draft: guarded on status === 'issued', and a draft is already
  // notFound()'d above.
  if (c.status === 'issued') {
    await db.from('contracts')
      .update({ status: 'viewed', viewed_at: new Date().toISOString() })
      .eq('id', c.id)
      .eq('status', 'issued')
    c.status = 'viewed'
  }

  // LEGALENT.1 — the countersignature label asserts the CONTRACTING
  // COMPANY on a document this member is about to sign, so it is
  // resolved from the org's configured legal entity (org_settings,
  // mig 425) rather than the literal it used to be. Falls back to the
  // resolved brand, never to another org's company.
  const { label: entityLabel } = await getContractingEntity(db, {
    organizationId: c.organization_id,
    locationId: c.location_id,
  })

  const signed = c.status === 'signed'
  const declined = c.status === 'declined'
  const revoked = c.status === 'revoked'
  const pending = c.status === 'issued' || c.status === 'viewed'

  return (
    <div className="p-6 md:p-8 max-w-3xl print:p-0 print:max-w-none">
      <div className="print:hidden">
        <Link href="/account/contracts" className="text-xs text-un1t-subtle hover:text-un1t-text">
          ← Your contracts
        </Link>
        <h2 className="text-2xl font-bold mt-1">{c.template?.name || 'Contract'}</h2>
        <p className="text-xs text-un1t-subtle mb-4">
          Issued by {c.issuer?.full_name} on {fmtDate(c.issued_at)}
        </p>
      </div>

      {revoked && (
        <div className="bg-gray-500/10 border border-gray-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-sm font-semibold">This contract has been withdrawn.</p>
          {c.revoked_reason && <p className="text-xs text-un1t-subtle mt-1">{c.revoked_reason}</p>}
          <p className="text-[11px] text-un1t-muted mt-2">No action required.</p>
        </div>
      )}
      {declined && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4 print:hidden">
          <p className="text-sm font-semibold text-red-700">You declined this contract.</p>
          {c.declined_reason && <p className="text-xs text-red-700 mt-1">{c.declined_reason}</p>}
        </div>
      )}

      {/* Print-friendly contract body */}
      <article className="bg-white text-gray-900 rounded-lg p-6 md:p-8 mb-6 print:rounded-none print:p-0 print:bg-white">
        <ContractBody markdown={c.body_rendered} />

        <div className="mt-10 pt-6 border-t border-gray-300 grid grid-cols-1 sm:grid-cols-2 gap-6">
          <SignatureBlock
            label={`For ${entityLabel}`}
            name={c.issuer_signature}
            timestamp={c.issued_at}
          />
          {signed ? (
            <SignatureBlock
              label="Employee / Contractor"
              name={c.signature_value}
              timestamp={c.signed_at}
              ip={c.signed_ip}
            />
          ) : (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Employee / Contractor</p>
              <p className="mt-2 italic text-gray-400 text-sm">
                {pending ? 'Awaiting your signature below' : '—'}
              </p>
            </div>
          )}
        </div>
      </article>

      {pending && (
        <ContractSignForm
          contract={c}
          recipientName={user.full_name}
          impersonating={!!(user.impersonatingFrom || user.supportSession)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4 print:hidden">
        <ContractPrintButton />
        {/* CONTRACTS-PDF.1 — the stored dual-signed artifact. Plain <a>
            (not <Link>) because the route 302s to a signed Storage URL,
            which is a real navigation, not a client-side route. */}
        {c.signed_pdf_path && (
          <a
            href={`/api/contracts/${c.id}/pdf`}
            className="text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text"
          >Download PDF</a>
        )}
      </div>

      <style>{`
        @media print {
          body { background: white; }
        }
      `}</style>
    </div>
  )
}

function SignatureBlock({ label, name, timestamp, ip }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-2 font-serif text-2xl italic" style={{ fontFamily: 'Georgia, serif' }}>
        {name || ''}
      </p>
      <p className="text-[10px] text-gray-500 mt-1">
        Signed {new Date(timestamp).toLocaleString('en-IE', { timeZone: 'Europe/Dublin' })}
        {ip ? ` · ${ip}` : ''}
      </p>
    </div>
  )
}
