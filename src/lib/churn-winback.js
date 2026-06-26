// Default win-back copy for the churn radar's "winback_sent" action, when the
// operator hasn't typed their own message. Pure + tested so the brand name is
// operator-driven (company_settings.company_name) rather than hard-coded.
export function defaultWinbackMessage(firstName, companyName) {
  const brand = (companyName || '').trim() || 'UN1T'
  return (
    `Hi ${firstName}, it's the team at ${brand} — we've noticed you've not been in for a bit and wanted to check in. ` +
    "Anything we can do to help you get back to it? We'd love to see you in class soon."
  )
}
