// Default win-back copy for the churn radar's "winback_sent" action, when the
// operator hasn't typed their own message. Pure + tested so the brand name is
// operator-driven (getLocationBranding: company_settings → org_settings →
// locations.name) rather than hard-coded. W1.B1: with no brand at all the
// copy says "the studio" — never another gym's wordmark.
export function defaultWinbackMessage(firstName, companyName) {
  const brand = (companyName || '').trim() || 'the studio'
  return (
    `Hi ${firstName}, it's the team at ${brand} — we've noticed you've not been in for a bit and wanted to check in. ` +
    "Anything we can do to help you get back to it? We'd love to see you in class soon."
  )
}
