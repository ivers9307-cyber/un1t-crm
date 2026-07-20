// SAAS4-C2 — the templated member/visitor privacy notice served on a
// TENANT's hostname (plan §6). The tenant gym is the data CONTROLLER;
// Champ Fitness Ltd appears only in its true role — the platform
// processor. Generic gym content by design: no UN1T member-app,
// health-data or CCTV specifics (those are platform-org concerns; a
// tenant needing bespoke sections is a solicitor conversation, not a
// template edit). Server component, static markup, no auth.

export default function TenantPrivacyNotice({ entity, updated = '19 July 2026' }) {
  const displayName = entity.tradingName || entity.entityName
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">Privacy policy</h1>
          <p className="mt-2 text-sm text-gray-500">Last updated {updated}</p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            This policy explains how <strong>{entity.entityName}</strong>
            {entity.tradingName && entity.tradingName !== entity.entityName && (
              <>, trading as <strong>{entity.tradingName}</strong>,</>
            )}{' '}
            (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses, stores and protects your personal
            data when you enquire with us, book classes, or train at one of our studios. We are the
            data controller for this information under the EU General Data Protection Regulation
            (GDPR) and the Irish Data Protection Act 2018.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">1. Who we are</h2>
          <p>
            {displayName} operates fitness studios and related online services in Ireland.
            {entity.address && <> Our registered address is: {entity.address}.</>}
          </p>
          <p>
            For any privacy question, contact us at{' '}
            <a className="underline" href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">2. Data we collect</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Identity &amp; contact:</strong> name, email, phone number, and emergency contact where you provide one.</li>
            <li><strong>Membership:</strong> membership type, class bookings, attendance history, and account preferences.</li>
            <li><strong>Payment:</strong> billing details and transaction records. Card details are handled by our payment providers and are not stored by us.</li>
            <li><strong>Enquiries &amp; marketing:</strong> messages you send via web forms, WhatsApp, email or social media, plus your marketing preferences.</li>
            <li><strong>Technical:</strong> IP address, device and browser type, and pages visited on our booking pages.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">3. How we use your data</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>To set up and manage your membership and class bookings.</li>
            <li>To take payment and manage billing.</li>
            <li>To respond to enquiries and provide support.</li>
            <li>To send booking confirmations and reminders, and — only where permitted — marketing about classes, offers and events.</li>
            <li>To meet our legal and regulatory obligations.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">4. Legal bases</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Contract:</strong> managing your membership, bookings, and payments.</li>
            <li><strong>Consent:</strong> marketing communications. Every marketing message carries an unsubscribe or stop option, and you can change your preferences at any time.</li>
            <li><strong>Legitimate interests:</strong> running our studios safely and efficiently.</li>
            <li><strong>Legal obligation:</strong> accounting, tax, and other records we must keep.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">5. Who processes your data for us</h2>
          <p>
            Our member management and communications run on a platform operated by{' '}
            <strong>Champ Fitness Ltd</strong> (Dublin, Ireland), which acts as a data{' '}
            <em>processor</em> on our behalf under a data processing agreement — it processes your
            data only on our instructions. The platform in turn relies on vetted subprocessors
            (hosting, email and messaging delivery, payments); the current list is available from us
            on request at the contact address above.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">6. How long we keep it</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Membership and booking records: for your membership plus up to 7 years (legal and accounting retention).</li>
            <li>Message history: up to 7 years for compliance and dispute resolution.</li>
            <li>Marketing preferences and consent records: for as long as we send you marketing, plus proof-of-consent retention.</li>
          </ul>

          <h2 className="text-xl font-semibold mt-8 mb-3">7. Your rights</h2>
          <p>You have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>access the personal data we hold about you, and receive a portable copy</li>
            <li>have it corrected or erased (subject to legal retention)</li>
            <li>object to or restrict processing</li>
            <li>withdraw marketing consent at any time</li>
            <li>complain to the Irish Data Protection Commission (<a className="underline" href="https://www.dataprotection.ie">dataprotection.ie</a>)</li>
          </ul>
          <p>
            To exercise any of these, email{' '}
            <a className="underline" href={`mailto:${entity.contactEmail}`}>{entity.contactEmail}</a>.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">8. Changes to this policy</h2>
          <p>
            If we change this policy in a way that materially affects how we use your data, we will
            update the date at the top and, where appropriate, tell you directly.
          </p>
        </section>
      </div>
    </div>
  )
}
