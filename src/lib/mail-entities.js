// PAIRSYNC — a shim, not a second implementation. See shared/mail-entities.js
// for why the rule lives on the shared side; web imports it through here so
// `@/lib/...` call sites read like every other lib import in src/.
export * from '@shared/mail-entities'
