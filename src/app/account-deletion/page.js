// /account-deletion — public account-deletion-request page.
//
// Required by Google Play (Data Safety form, "Account Deletion URL"
// field) and Apple App Store (Guideline 5.1.1.v) for any app that
// creates user accounts. Must be publicly accessible (no auth) so
// reviewers can verify the page exists and explains the process.
//
// UN1T CRM is an internal staff tool — accounts are provisioned by
// admins, not self-served — so the "deletion request" flow is the
// existing GDPR-compliant master-only delete path operating on
// behalf of the user. This page surfaces that path publicly: who to
// email, what gets deleted, what's retained for legal reasons.

export const runtime = 'nodejs'

export const metadata = {
  title: 'Account deletion · UN1T Dublin',
  description:
    'How to request deletion of your UN1T CRM account and associated personal data.',
}

export default function AccountDeletion() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Account and data deletion</h1>
          <p className="mt-2 text-sm text-gray-500">Last updated 18 August 2026</p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            UN1T CRM is an internal staff application used by employees and
            contractors of UN1T Dublin Ltd. Accounts are created and managed by
            UN1T administrators rather than by self-service sign-up. If you no
            longer wish your data to be held by us, you can request deletion at
            any time using the process below.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">How to request deletion</h2>
          <p>
            Email <a className="underline" href="mailto:privacy@un1tdublin.com">
            privacy@un1tdublin.com</a> from the email address associated with
            your UN1T CRM account, with the subject line:
          </p>
          <p className="font-mono bg-gray-100 px-3 py-2 rounded inline-block">
            Account deletion request
          </p>
          <p>
            We will acknowledge the request within 7 days and complete the
            deletion (subject to the retention exceptions below) within 30 days,
            in line with the EU General Data Protection Regulation.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">What gets deleted</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Your profile (name, email, phone, role, location memberships)</li>
            <li>Your authentication credentials in Supabase Auth</li>
            <li>Your push notification tokens</li>
            <li>Your time-off requests, swap requests, and shift assignments</li>
            <li>Any draft contractor invoices you created that have not yet been approved</li>
            <li>Any contact tags, notes, or activity logs you authored where you are personally identifiable</li>
            <li>Audit-log entries that are not required for legal compliance</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">What may be retained</h2>
          <p>
            Some data must be kept after account deletion to comply with Irish
            employment, tax, and accounting law, or to preserve the integrity
            of records that other parties depend on. Specifically:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Approved contractor invoices and their PDFs (kept for the period required by Irish revenue law, currently six years)</li>
            <li>Payroll records derived from completed shifts</li>
            <li>Audit-log entries that record administrative actions (assignment changes, master account toggles, impersonation sessions) where retention is required for security and compliance</li>
            <li>Anonymised aggregates used for operational reporting (these contain no personally identifiable information and cannot be traced back to you)</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">If your account was a contact, not a staff account</h2>
          <p>
            UN1T CRM also stores contact records for members of the public who
            have interacted with UN1T (gym members, event attendees, race
            registrants). If you are a member of the public and want your
            contact record deleted, the same email address — <a className="underline"
            href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a> —
            handles those requests under the same 30-day window. Deleting a
            contact record includes any health and fitness data collected
            through the member app (heart-rate sessions, workouts synced
            from Apple Health or Strava, body-composition scan results, and
            weight), subject only to the legal retention exceptions above.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">Contact</h2>
          <p>
            <strong>UN1T Dublin Ltd</strong><br />
            Email: <a className="underline" href="mailto:privacy@un1tdublin.com">
            privacy@un1tdublin.com</a><br />
            Postal address available on request.
          </p>
          <p>
            For our full privacy policy, see <a className="underline" href="/privacy">
            crm.repset.ie/privacy</a>.
          </p>
        </section>
      </div>
    </div>
  )
}
