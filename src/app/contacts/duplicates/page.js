// /contacts/duplicates — redirects to the Duplicates tab on the
// Contacts list page. Kept so old bookmarks / links still work.
// CONSULTATIONS-SP1 — duplicate review moved into a Contacts tab.

import { redirect } from 'next/navigation'

export default function ContactDuplicatesPage() {
  redirect('/contacts?tab=duplicates')
}
