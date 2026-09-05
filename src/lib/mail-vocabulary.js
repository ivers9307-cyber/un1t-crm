// MAIL-ARCH.2 — the Mail vocabulary (archive/needs-reply/spam predicates and
// the view list) moved to shared/ so mobile can import the SAME implementation
// (mobile cannot import src/lib). This is the re-export shim, in the
// class-timer / pipeline-classifier pattern: the web Mail components import it
// via src/components/mail/mail-vocabulary.js, and tests/shared-pair-sync.test.js
// asserts by runtime identity that every binding here IS the shared one.
export * from '@shared/mail-vocabulary'
