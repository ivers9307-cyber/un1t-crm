// Client-safe invoice category enum. Kept apart from invoice-extraction.js so
// client components (e.g. InvoicesInbox) can import it WITHOUT pulling the
// server-only OCR module — which imports `sharp` (native) — into the browser
// bundle. invoice-extraction.js imports this for its Zod enum.
export const INVOICE_CATEGORIES = Object.freeze([
  'utilities',
  'cleaning',
  'equipment',
  'marketing',
  'insurance',
  'rent',
  'maintenance',
  'professional_services',
  'staff_training',
  'office_supplies',
  'software',
  'bank_fees',
  'other',
])
