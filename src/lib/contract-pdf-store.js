// CONTRACTS-PDF.2 — render a signed contract's dual-signed PDF from its
// stored record and keep it in the private `contracts` bucket.
//
// ONE implementation for two callers, so they cannot drift:
//   - POST /api/contracts/[id]/sign, right after the row flips to 'signed'
//     (CONTRACTS-PDF.1), where a failure degrades to a warning on an
//     otherwise successful sign;
//   - POST /api/contracts/[id]/pdf, the backfill for a contract signed
//     before CONTRACTS-PDF.1 (signed_pdf_path NULL), where a failure is the
//     route's whole answer.
//
// THE DB ROW IS THE LEGAL RECORD. body_rendered + issuer_signature/issued_at
// + signature_value/signed_at/signed_ip are what make the simple electronic
// signature (eIDAS Art. 25); the PDF is rendered FROM that record and can be
// rendered again at any time, which is exactly what the backfill does.
//
// The function never throws. The buffer deliberately survives a STORAGE
// failure: if the render succeeded the sign route can still attach the PDF
// to the confirmation emails even though /pdf cannot serve it yet.

import { renderContractPdf } from './contract-pdf.js'
import { getLocationBranding } from './location-branding.js'
import { contractPdfCountersignatureLabel } from './contracting-entity.js'

/** Where a contract's signed PDF lives inside the `contracts` bucket. */
export function signedContractPdfPath(contractId) {
  return `${contractId}/signed.pdf`
}

/**
 * Render the dual-signed PDF for a SIGNED contract row, upload it to
 * contracts/<id>/signed.pdf and write `signed_pdf_path` on the row.
 *
 * @param {object} args
 * @param {object} args.db           service-role supabase client
 * @param {object} args.contract     the contracts row: id, location_id,
 *   body_rendered, issuer_signature, issued_at, signature_value, signed_at,
 *   signed_ip, variables_data
 * @param {string|null} [args.templateName]
 * @param {string} args.zone         the studio's display zone (displayZoneFor)
 * @returns {Promise<{ pdfBuffer: Buffer|null, pdfPath: string|null, error: string|null }>}
 *   pdfBuffer is set once the render succeeded; pdfPath once the upload AND
 *   the path write succeeded; error names the first step that failed.
 */
export async function renderAndStoreSignedContractPdf({ db, contract, templateName = null, zone }) {
  let pdfBuffer = null
  try {
    const branding = await getLocationBranding(db, contract.location_id)
    pdfBuffer = await renderContractPdf({
      bodyRendered: contract.body_rendered,
      issuerSignature: contract.issuer_signature,
      issuedAt: contract.issued_at,
      recipientSignature: contract.signature_value,
      signedAt: contract.signed_at,
      signedIp: contract.signed_ip,
      templateName: templateName || undefined,
      companyName: branding?.companyName,
      // LEGALENT.1 / CONTRACTS-PDF.2 — a legal-entity claim read from the
      // contract's OWN frozen variables, never resolved live.
      contractingEntity: contractPdfCountersignatureLabel(contract),
      zone,
    })
  } catch (e) {
    return { pdfBuffer: null, pdfPath: null, error: `render failed: ${e?.message || 'unknown error'}` }
  }

  const pdfPath = signedContractPdfPath(contract.id)
  try {
    const { error: upErr } = await db.storage
      .from('contracts')
      .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (upErr) throw new Error(upErr.message)
    // Must be awaited — a bare .update() thenable never fires — and judged:
    // a failed write here would leave a stored PDF the row does not know of.
    const { data: rows, error: pathErr } = await db
      .from('contracts')
      .update({ signed_pdf_path: pdfPath })
      .eq('id', contract.id)
      .select('id')
    if (pathErr) throw new Error(pathErr.message)
    if (!rows?.length) throw new Error('contract row not updated')
  } catch (e) {
    return { pdfBuffer, pdfPath: null, error: `store failed: ${e?.message || 'unknown error'}` }
  }

  return { pdfBuffer, pdfPath, error: null }
}
