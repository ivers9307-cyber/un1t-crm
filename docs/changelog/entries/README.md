# Changelog entries (one file per PR)

From CHANGELOG-FILES.1 (30 Sep 2026) each PR adds **one new file** here instead of
inserting a row into `docs/CHANGELOG.md`. Two PRs never touch the same file, so a merge
never makes another open PR conflict (GitHub ignores the `merge=union` driver).

- **Name:** `<PR number>.md`, e.g. `1884.md`. Add it after `gh pr create`, when the number exists.
- **Content:** exactly one table row, in the same shape as the rows in `docs/CHANGELOG.md`:
  `| #1884 | KEY.1 — one-line title | YYYY-MM-DD. What changed and why. |`
  The `#<n>` must match the file name.
- **Never edit another PR's entry.** A correction is a new PR with its own entry.
- **Read the whole log:** `npm run changelog` prints these entries (newest first)
  followed by the historical table in `docs/CHANGELOG.md`, which is frozen as of #1883.

`tests/changelog-entries.test.js` enforces the name, the single row and the matching number.
