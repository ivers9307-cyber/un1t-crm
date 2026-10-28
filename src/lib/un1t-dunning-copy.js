// UN1TDUN.1 — the fixed names and words of the un1t.online payment reminder,
// in a module with no imports so the agent and the public page can read them
// without loading the dunning machinery (un1t-dunning.js re-exports them).

/** The public path our short pay link lives under (four allowlists: CLAUDE.md). */
export const UN1T_PAY_PATH = '/pay-link/'

/** The approved Meta template the un1t dunning sequence sends (its URL button's base ends in UN1T_PAY_PATH). */
export const UN1T_DUNNING_WA_TEMPLATE = 'outstanding_payment_link_un1t'

// The words on /pay-link/<token> when it does not redirect. Plain constants, as
// on /fee-appeal (FEES.3) and like the Glofox reminder's card-update wording;
// the redirect itself carries no copy.
export const UN1T_PAY_PAGE_TEXT = Object.freeze({
  paid: "You're all paid up. There is nothing left to pay on this invoice, thanks.",
  unavailable: (studio) => (studio
    ? `We can't open your payment page right now. Please try again shortly, or contact ${studio} if it keeps happening.`
    : "We can't open your payment page right now. Please try again shortly, or contact the studio if it keeps happening."),
})
