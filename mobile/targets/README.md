# Apple targets

Swift sources for the app's Apple extension targets, generated into the Xcode
project by `@bacons/apple-targets` at prebuild. Each subdirectory is one target
and carries its own `expo-target.config.js`.

**Nothing here enters the Metro bundle.** An extension is a separate binary from
the React Native app, so a change to a file in this directory cannot take effect
without a new native build — which is why `mobile/targets` is classified
NON_BUNDLE in `scripts/check-ota-trigger-paths.mjs`, and why a Swift-only change
must publish no OTA.

This README also keeps the directory tracked, and that is load-bearing:
`check:ota-paths` requires every `NON_BUNDLE` key to correspond to a real
top-level entry under `mobile/` and reports a key with no directory as **stale**.
So the classification and the directory have to land in the same commit — you
cannot forward-declare one ahead of the other.
