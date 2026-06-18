// CLASS-TIMER — the pure timer engine moved to shared/ so mobile can import it
// too (mobile can't import src/lib). This is a re-export shim so existing web
// imports of `@/lib/class-timer` keep working unchanged. The implementation +
// its tests live in `shared/class-timer.js` / `src/lib/class-timer.test.js`.
export * from '@shared/class-timer'
