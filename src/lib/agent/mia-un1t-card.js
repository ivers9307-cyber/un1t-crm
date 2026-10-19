// MIAHATCH.5 — which approval cards are Mia's un1t.online cards. A tiny,
// import-free module so the approval route can judge a card without loading
// the write side (un1t-approval-branch.js, imported lazily). Pure.

/** A un1t.online card Mia filed (not a /start funnel card). */
export function isMiaUn1tCard(details) {
  return details?.provider === 'un1t_online' && details?.origin === 'mia'
}
