// The amount shown on an /approvals row or card: "€12.50". Moved out of
// ApprovalsInbox (APPROVALSQ.4) so the link list and the cards agree.
export function formatAmount(amount, currency) {
  if (amount == null) return null
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
  return `${sym}${Number(amount).toFixed(2)}`
}
