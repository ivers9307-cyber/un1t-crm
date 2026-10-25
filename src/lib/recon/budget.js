// The receipt-hunt LLM budget (RCOV). ONE weekly cap for the whole estate:
// hunt.js's weeklySpendSoFar sums every tenant's hunts before each hunt.
// Its own module so the Runs & health route can report the enforced
// number without importing the hunt engine (IMAP client, scoring, the
// invoices queue). hunt.js re-exports it, so existing imports still work.
export const HUNT_WEEKLY_BUDGET_USD = 15
