// /privacy/authority-requests — public policy on how we handle
// requests from public authorities (police, courts, regulators,
// government bodies) for the personal data we hold.
//
// Rides the /privacy prefix, so it is already public in proxy.js
// (startsWith match) and behaves exactly like /privacy and
// /privacy/members — standalone server-rendered markup, no auth,
// not wrapped in the CRM AppShell. No allowlist changes needed.
//
// This is a public commitment: the four processes it describes
// (legality review, challenge of unlawful requests, data
// minimisation, documentation) are the ones we actually operate.
// Don't add commitments here the business does not intend to keep —
// this page can be relied on by data subjects and regulators.

export const runtime = 'nodejs'

export const metadata = {
  title: 'Government & public authority data requests · Repset',
  description:
    'How Champ Fitness Ltd (trading as UN1T Dublin) handles requests from police, courts, regulators, and other public authorities for the personal data it holds — legality review, challenging unlawful requests, data minimisation, and documentation.',
}

export default function AuthorityRequestsPolicy() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">
            Government &amp; public authority data request policy
          </h1>
          <p className="mt-2 text-sm text-gray-500">Last updated 16 July 2026</p>
        </header>

        <section className="prose prose-gray max-w-none">
          <p>
            This policy explains how Champ Fitness Ltd, trading as UN1T
            Dublin (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;) responds when a public authority &mdash; such as
            a police force, court, regulator, tax authority, or other
            government body &mdash; asks us to disclose personal data we hold.
            It applies to personal data we process as a data controller for
            our own operations, and to personal data we process on behalf of
            business customers who connect their own accounts through our
            platform. We handle every such request under the EU General Data
            Protection Regulation (GDPR) and the Irish Data Protection Act
            2018.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            1. We require valid legal process
          </h2>
          <p>
            We do not disclose personal data to a public authority simply
            because it is asked for. We disclose it only where we are
            satisfied there is a valid legal basis to do so &mdash; for
            example a court order, a statutory power exercised correctly, or
            another lawful obligation that genuinely applies to us. A request
            on letterhead, by phone, or by email, without a proper legal
            basis, is not on its own sufficient.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            2. We review the legality of every request
          </h2>
          <p>
            Every request from a public authority is reviewed before we
            respond. That review is carried out by a named responsible person
            within UN1T Dublin (our data protection contact, reachable at the
            address below), who checks:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>that the authority is who it says it is and is acting within its powers;</li>
            <li>that the request cites a specific and applicable legal basis;</li>
            <li>that the request is properly served and, where required, accompanied by the correct order or authorisation;</li>
            <li>that the data sought is actually within scope of that legal basis.</li>
          </ul>
          <p className="mt-4">
            Where the request relates to data we process on behalf of a
            business customer, we will, wherever we are lawfully permitted to
            do so, direct the authority to that business customer (the
            controller of that data) and notify the customer, rather than
            disclosing the data ourselves.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            3. We challenge requests we consider unlawful
          </h2>
          <p>
            If, after review, we consider a request to be unlawful, invalid,
            overbroad, or otherwise improper, we will not comply with it as
            made. Depending on the circumstances we will push back on the
            authority, ask for it to be narrowed or properly authorised, seek
            our own legal advice, and where appropriate formally object to or
            challenge the request through the available channels before any
            disclosure is made.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            4. We disclose only the minimum necessary
          </h2>
          <p>
            Where we are lawfully required to disclose data, we apply data
            minimisation: we disclose only the specific personal data that
            falls within the scope of the request and its legal basis, and no
            more. We do not hand over a person&rsquo;s entire record, or
            unrelated data about other people, when a narrower disclosure
            answers the request.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            5. We document every request
          </h2>
          <p>
            We keep a record of each request from a public authority,
            including the authority involved, the date, the legal basis
            claimed, the review we carried out, the people involved in the
            decision, our response, and exactly what (if anything) was
            disclosed. These records let us account for our decisions to the
            Irish Data Protection Commission and to the individuals concerned.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            6. Emergency requests
          </h2>
          <p>
            In a genuine emergency involving a risk to life or serious harm,
            we may respond more quickly, but we still record the request, the
            emergency relied on, and the disclosure made, and we still limit
            the disclosure to what is necessary to address the emergency.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            7. Notifying affected individuals
          </h2>
          <p>
            Where we are lawfully allowed to do so, and it would not prejudice
            an investigation, we aim to notify a person whose personal data
            has been requested by a public authority, so that they can seek
            their own advice. We will not give notice where the law prohibits
            us from doing so.
          </p>

          <h2 className="text-xl font-semibold mt-8 mb-3">
            8. How authorities should contact us
          </h2>
          <p>
            Public authorities should send requests in writing, with the
            relevant legal basis and any required order or authorisation, to:
          </p>
          <p>
            <strong>Champ Fitness Ltd</strong> (trading as UN1T Dublin) &mdash; Data Protection Contact
            <br />
            First Floor Unit, Stillorgan Village Centre,
            Lower Kilmacud Road, Dublin, A94 AC67
            <br />
            Email: <a className="underline" href="mailto:privacy@un1tdublin.com">privacy@un1tdublin.com</a>
          </p>
          <p className="mt-4 text-sm text-gray-500">
            This policy sits alongside our main{' '}
            <a className="underline" href="/privacy">privacy policy</a>. It
            describes our standing process; it is not legal advice to any
            authority or individual. Individuals can also complain to the
            Irish Data Protection Commission at{' '}
            <a className="underline" href="https://www.dataprotection.ie">dataprotection.ie</a>.
          </p>
        </section>
      </div>
    </div>
  )
}
