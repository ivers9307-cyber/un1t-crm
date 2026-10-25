// MAIL-RENAME.1 — DEPRECATED SHIM. The handler lives at
// /api/email/mail/[id]/attachments/[attachmentId]. This path stays only for
// the staff-app bundle already in the field (mobile/lib/email-api.js before
// MAIL-RENAME.1); an OTA lands on next launch, not on deploy. Delete in the
// shim sweep (~2 weeks after the OTA publishes), with the matching row in
// shims.test.js.
// Segment config cannot be re-exported (Next parses it statically), so the two
// literals are restated here and shims.test.js asserts they equal the handler's.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export { GET } from '@/app/api/email/mail/[id]/attachments/[attachmentId]/route'
