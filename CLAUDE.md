# deemix-remastered — project rules

Project-scoped conventions for this repo. These are invariants that have bitten
repeatedly during real release work, so they live next to the code they govern
rather than in a global config.

## Releases

- **Cosmetic changes re-roll in place.** For minor changes that don't warrant a
  new version (a font-size tweak, a copy fix), move the existing tag and replace
  the release assets with `--clobber` rather than burning a new version number.
  Note that `--clobber` resets that asset's download count to zero, so weigh a
  re-roll against the count it costs.

- **Keep the local build until the next one starts.** After each rebuild or
  re-roll, leave the current installers in `release/` on disk. Clear that folder
  only at the START of the next rebuild, when those artifacts are about to be
  superseded, never right after pushing the GitHub release. Release assets get
  clobbered to the latest build, so the local copies are the only offline access
  to the current one.

- **Never delete GitHub release assets.** Download counts are stored per asset
  and are destroyed with it. There is no transfer and no merge, so removing a
  superseded version's assets permanently reduces the repository's total
  download count and the shields.io badge that reports it. Prior versions keep
  their assets indefinitely. Clean up superseded builds on local disk only.
  (Learned 2026-08-21: an earlier sweep of older releases had already cut the
  repo total from roughly 1,400 to 285, and by then every remaining download
  sat on a single version's assets.)

- **Snapshot download counts before every rollout.** Write the per-asset counts
  to `.release-metrics/` and commit them. That file is the only durable record
  if an asset is ever lost, since the API cannot recover a deleted asset's
  count.

- **Housekeeping ships with the version.** Each rollout audits and updates
  project structure and documentation surfaces so they describe what actually
  changed.

## Branching

- **Features live on an unmerged branch.** New features are built on a dedicated
  local feature branch. Cut local release-candidate builds for testing, and
  merge to main only after the maintainer explicitly confirms no issues.

## Fixes

- **Scope platform fixes to the platform.** Guard platform-specific bugs to the
  affected platform (`isLinux ? 800 : 1024`) rather than moving a shared default.
  Never trade majority-platform UX — spacing, min-width, layout density — for a
  minority-platform or single-user edge case. If a targeted fix can't solve the
  edge case without degrading someone else, leave it as a documented design
  limitation instead of making a global change.

- **Check the reference implementation before blaming this pipeline.** When a
  user disputes an audio-quality or behavior claim, investigate the maintained
  competitor or fork they reference (e.g. original Deemix) for differing API
  endpoints or backend processing such as ReplayGain, before concluding this
  app's own pipeline is at fault.

## Integrating a new service

Adding a data/service source to this multi-source system is not complete after a
single feature-surface sweep. Run progressively deeper passes:

1. Feature-surface walkthrough.
2. Mechanical call-site census — every call to the original source's service,
   checked for source-blindness.
3. Settings-object audit — every setting flows into the new path.
4. Field-level completeness — every metadata/tag field the downstream consumer
   reads is populated by the new source's shim.

Each layer of the Qobuz-alongside-Deezer effort caught gaps the previous layer
missed. Do not stop at layer one.

## Localization

- **No hard-coded UI copy.** Every toast, label, status word and help text goes
  through vue-i18n (`t()` in components, `i18n.global.t()` in stores and
  composables). A string typed into a component is invisible to all 21
  languages. The only exemption is the app's branded labels ("Transfer Rack",
  "Signal Deck", "AGGREGATE RATE", "Pull the signal"), which stay English on
  purpose. (Learned 2026-09-13 from #148: about 130 strings had bypassed the
  system, and nineteen locales were each missing a third of the app.)

- **A new key ships in all 21 locale files in the same commit.** English first,
  then every other locale, so the fallback never leaves a language half
  English. `bun scripts/i18n-check.ts` must pass before a release; it checks
  key parity and scans for hard-coded English.

## Settings

- **A server-side setting has four links plus the profile keys.** Type and
  default and validation in `electron/server.ts`, every download option site,
  the `settingsToSync` allowlist in `downloadStore.ts`, and the profile key
  list. Missing the allowlist ships a toggle that saves, displays, and does
  nothing (#131, #134, #141). Re-run the allowlist sweep and prove the setting
  both ways through the real app before it ships.

## Docs and disclaimers

- **Disclaimer coverage is audited per integrated service** across README,
  in-app UI, and docs. Draft new wording sourced from the README, get explicit
  sign-off, and bundle approved text into the next scheduled release.

- **Badges must be live.** Prefer shields.io badges (release version, download
  count, stars, last-commit, open/closed issues) over hardcoded static ones, and
  back a "build passing" badge with a real CI Actions workflow (typecheck +
  build on push) so it reflects actual project health.
