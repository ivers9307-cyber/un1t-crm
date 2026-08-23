// SONOSMOB.1 — the playback enum moved to shared/sonos-playback.js so the
// mobile control card can read it (mobile cannot import src/lib). This shim
// keeps every web import of `@/lib/sonos/playback` working unchanged. The
// implementation + its test live in shared/; tests/shared-pair-sync.test.js
// asserts the two paths resolve to the SAME objects.
export * from '@shared/sonos-playback'
