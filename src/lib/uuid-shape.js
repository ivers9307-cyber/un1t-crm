// MAIL-ARCH.2 — the house id shape, in ONE place.
//
// Postgres's `uuid` type accepts any 36-character hex string, not only RFC
// 4122 v1–v8 (the seeded Stillorgan location id a0000000-0000-0000-0000-
// 000000000001 has version digit 0 and is stored and queried happily), so
// every validator of an id that originates from our DB is this permissive
// shape — NOT `z.string().uuid()`. It was spelled out by hand in at least four
// files (`uuidLike` in schemas.js and validate.js, `UUID_SHAPE` in the tickets
// route helpers, `isUuidShaped` in mail-digest.js); each now imports this.
// Deliberately import-free so it is safe in a client bundle and a server route
// alike.
export const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
