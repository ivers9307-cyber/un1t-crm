// SAAS4-C4 — /legal/subprocessors: the public subprocessor register
// (SaaS machinery plan §6). One platform-level list for all tenants:
// their privacy notices and DPAs reference it instead of embedding a
// roster that drifts. Roster verified against the actual stack in the
// 2026-07-19 audit sweep; scope notes distinguish platform-wide
// processors from module-scoped ones (member-app / platform-org only).
//
// Public path: '/legal/' is registered in ALL FOUR allowlists (proxy
// publicPaths, brands.js un1t-marketing, tenant-domain DB defaults,
// AppShell PUBLIC_PATHS) — the documented three-allowlist lesson,
// plus the SAAS-8 DB tier.
//
// Changes policy: material changes are notified to tenant controllers
// 30 days ahead (the DPA's general-authorisation clause) — update the
// date + notify BEFORE a new vendor goes live.

export const runtime = 'nodejs'

export const metadata = {
  title: 'Subprocessors · Champ Fitness Ltd',
  description:
    'The subprocessors Champ Fitness Ltd uses to operate Repset, its gym management platform, with the data each processes and the safeguards in place.',
}

const SUBPROCESSORS = [
  ['Supabase', 'Database, authentication, file storage — the system of record', 'EU (Ireland)', 'DPA + SCCs'],
  ['Vercel', 'Application hosting and runtime logs', 'EU / US edge', 'DPA + SCCs'],
  ['Glofox', 'Gym membership and booking platform (member records, bookings, attendance, billing sync)', 'EU', 'DPA'],
  ['Meta Platforms', 'WhatsApp Cloud API and Instagram messaging; hashed identifiers for ad conversions', 'US', 'DPA + SCCs'],
  ['Postmark (ActiveCampaign)', 'Transactional and marketing email delivery', 'US', 'DPA + SCCs'],
  ['Twilio', 'SMS delivery', 'US', 'DPA + SCCs'],
  ['Zoom Video Communications', 'Cloud telephony. Member and lead names and phone numbers are held in a shared external-contacts directory so inbound calls to the studio are identified by name', 'EU / US', 'DPA + SCCs'],
  ['Stripe', 'Payment processing (event tickets; platform billing)', 'EU / US', 'DPA + SCCs'],
  ['Revolut Business', 'Payment processing (deposits)', 'EU', 'DPA'],
  ['Xero', 'Accounting (invoices and bills)', 'EU / global', 'DPA'],
  ['Anthropic', 'AI assistant and document extraction — content processed transiently, not used for model training', 'US', 'DPA + SCCs'],
  ['Upstash', 'Message-queue infrastructure (webhook and job payloads in transit)', 'EU / US', 'DPA + SCCs'],
  ['Apple / Expo', 'Push notification delivery to staff and member devices', 'US', 'DPA + SCCs'],
  ['Ubiquiti (UniFi)', 'Studio door access (door-unlock events)', 'EU / US', 'DPA'],
]

// Module-scoped processors — only engaged for gyms using the member
// app (Pulse) module; standard-plan tenants have no data here.
const MODULE_SCOPED = [
  ['InBody (Lookin’Body)', 'Body-composition scan results (member app module only)', 'EU / KR', 'DPA'],
  ['Strava', 'Fitness-activity import where a member connects their own account (member app module only)', 'US', 'API terms + DPA'],
]

function Table({ rows }) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left border-b-2 border-gray-200">
            <th className="py-2 pr-4 font-semibold">Subprocessor</th>
            <th className="py-2 pr-4 font-semibold">Purpose / data</th>
            <th className="py-2 pr-4 font-semibold">Region</th>
            <th className="py-2 font-semibold">Safeguard</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, purpose, region, safeguard]) => (
            <tr key={name} className="border-b border-gray-100 align-top">
              <td className="py-2 pr-4 font-medium whitespace-nowrap">{name}</td>
              <td className="py-2 pr-4">{purpose}</td>
              <td className="py-2 pr-4 whitespace-nowrap">{region}</td>
              <td className="py-2 whitespace-nowrap">{safeguard}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function SubprocessorsPage() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Subprocessors</h1>
          <p className="mt-2 text-sm text-gray-500">Last updated 19 July 2026</p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            <strong>Champ Fitness Ltd</strong> operates <strong>Repset</strong>, a gym management platform. Where we act as a
            data processor for the gyms using the platform (each the data controller for its own
            members), we engage the subprocessors below under written agreements. Transfers outside
            the EEA rely on the European Commission&rsquo;s Standard Contractual Clauses or, where
            applicable, the EU-US Data Privacy Framework.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">Platform subprocessors</h2>
          <Table rows={SUBPROCESSORS} />

          <h2 className="text-xl font-semibold mt-8 mb-3">Module-scoped subprocessors</h2>
          <p className="text-sm">
            Engaged only for gyms using the member-app module; gyms on standard plans have no data
            processed by these vendors.
          </p>
          <Table rows={MODULE_SCOPED} />

          <h2 className="text-xl font-semibold mt-8 mb-3">Changes to this list</h2>
          <p>
            We give the gyms we process for at least 30 days&rsquo; notice before a new subprocessor
            handles their members&rsquo; personal data, per the subprocessor-authorisation terms of
            our data processing agreement. Questions:{' '}
            <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>.
          </p>
        </section>
      </div>
    </div>
  )
}
