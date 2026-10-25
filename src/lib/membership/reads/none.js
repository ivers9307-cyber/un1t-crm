// UN1TREAD.1 — the adapter for a location with no membership source (and the
// fallback for a source key nothing registers): it supplies no reads, so
// supportsRead() is false for every key and a surface shows its own
// "not available" state rather than zeros.
export const noneReads = Object.freeze({})
