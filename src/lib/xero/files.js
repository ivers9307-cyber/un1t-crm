// Bills push — forwards uploaded supplier documents to Xero's
// Files Inbox. Xero's auto-bill OCR (Hubdoc-derived) then turns
// the file into a draft Bill in Business → Bills to pay → Draft,
// extracting the supplier, line items and amount automatically.
//
// User-side prerequisite: in Xero, the org needs auto-bill
// processing enabled in Files → Inbox settings ("Convert files to
// bills" or equivalent — naming varies by region/release). Without
// that, the file still lands in the Inbox but has to be promoted
// to a bill manually.
//
// Scope required: `files`. Existing connections must Reconnect
// once after the scope was added to grant it.

import { withFreshToken, XeroError } from './client'
import { createServerClient } from '@/lib/supabase'

const XERO_FILES_BASE = 'https://api.xero.com/files.xro/1.0'
const STORAGE_BUCKET = 'car-documents'

// Resolve the Xero "Inbox" folder ID. Every Xero org has exactly
// one Inbox folder — this is what auto-bill processing reads from.
async function resolveInboxFolderId(xfetch) {
  // GET /Folders returns all folders incl. Inbox + Contracts +
  // user-created. Xero docs say the Inbox folder is always present
  // and identifiable by name + the IsInbox flag.
  const json = await xfetch(`${XERO_FILES_BASE}/Folders`)
  // Folders endpoint returns an array directly (not wrapped).
  const folders = Array.isArray(json) ? json : (json?.Folders || [])
  const inbox = folders.find(f => f.IsInbox || (f.Name || '').toLowerCase() === 'inbox')
  if (!inbox?.Id) {
    throw new XeroError('Could not find the Files Inbox folder in Xero.')
  }
  return inbox.Id
}

// Build the multipart/form-data body manually. Xero's Files API
// expects a single 'file' part with a filename — Node's FormData
// + Blob is the cleanest way on Node 18+.
function buildMultipart({ filename, contentType, bytes }) {
  // `Blob` and `FormData` are global on the Edge runtime + Node 18+.
  const fd = new FormData()
  const blob = new Blob([bytes], { type: contentType })
  fd.append('file', blob, filename)
  return fd
}

/**
 * Forward a single car_documents row to the Xero Files Inbox.
 * Returns the Xero file id so the caller can save it on the row.
 *
 * @param {string} documentId  car_documents.id
 */
export async function sendCarDocumentToXero(documentId) {
  const db = createServerClient()
  const { data: doc, error: loadErr } = await db
    .from('car_documents')
    .select('id, car_id, doc_type, file_name, mime_type, storage_path, xero_file_id, cars!inner(id, location_id, uk_reg, irish_reg, vin, make, model)')
    .eq('id', documentId)
    .single()
  if (loadErr || !doc) throw new XeroError('Document not found.')
  if (doc.xero_file_id) {
    return {
      alreadySent: true,
      xeroFileId: doc.xero_file_id,
    }
  }

  const car = doc.cars
  if (!car?.location_id) throw new XeroError('Document\'s car has no location_id.')

  // Pull the actual bytes from Supabase Storage.
  const { data: blob, error: dlErr } = await db.storage
    .from(STORAGE_BUCKET)
    .download(doc.storage_path)
  if (dlErr || !blob) {
    throw new XeroError(`Could not download "${doc.file_name}" from storage: ${dlErr?.message || 'unknown error'}`)
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())

  const { xfetch } = await withFreshToken(car.location_id)
  const folderId = await resolveInboxFolderId(xfetch)

  // Annotate the filename with the car reg so the OCR-extracted
  // bill is easy to match back to the right car in Xero's Drafts.
  const reg = car.uk_reg || car.irish_reg || car.vin || car.id
  const safeReg = String(reg).replace(/[^A-Za-z0-9_-]/g, '_')
  const filename = `${doc.doc_type}-${safeReg}-${doc.file_name || 'file'}`

  const fd = buildMultipart({
    filename,
    contentType: doc.mime_type || 'application/octet-stream',
    bytes,
  })

  // POST /Folders/{Id} uploads into that folder. Xero auto-bill
  // processing watches the Inbox folder.
  const uploaded = await xfetch(`${XERO_FILES_BASE}/Folders/${folderId}`, {
    method: 'POST',
    body: fd,
  })

  const xeroFileId = uploaded?.Id || uploaded?.FileId || uploaded?.[0]?.Id
  if (!xeroFileId) {
    throw new XeroError('Xero accepted the upload but returned no file id.', { body: uploaded })
  }
  return {
    alreadySent: false,
    xeroFileId,
    fileName: filename,
    folderId,
  }
}
