# NuXL desktop

A Tauri 2 desktop app around OpenMS' OpenNuXL (protein–nucleic acid cross-links): the Rust shim in `src-tauri/`, the
Svelte 5 front end in `src/`, OpenMS built and bundled by `native/scripts/` in CI (`.github/workflows/desktop.yml`).
The design and the contract between the parts: `docs/design.md`. Building and packaging: `native/README.md`.

## Checks before a pull request

```bash
npx svelte-check --tsconfig ./tsconfig.app.json && npx tsc -p tsconfig.node.json
npx vitest run
cd src-tauri && cargo test && cargo clippy --all-targets && cargo fmt --check
```

The end-to-end specs run the real app against a fake OpenNuXL: `NUXL_FAKE=1 e2e/run.sh` (README, "Develop"). They never
ask GitHub: `e2e/app.sh` sets `NUXL_NO_UPDATE_CHECK` (the new-version check at start, `docs/design.md` §7). OpenMS
is not built locally; CI builds it (the packaging jobs take minutes with warm caches, about an hour without).

## Releasing

A release is the packages of a commit of `main` whose `desktop.yml` push run passed; nothing is built for it. When
asked to make a release, e.g. 0.2.0:

1. **The version.** On the working branch, from the latest `main`: `node scripts/bump-version.mjs 0.2.0` (sets it in
   `src-tauri/tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`), commit
   ("Version 0.2.0"), push, open a pull request to `main`. Merge it once its CI is green (only when the user asked
   for the release; that is the ask to merge this pull request).
2. **Wait** for `main`'s `desktop.yml` push run of the merge commit to pass (Actions; the release is made from its
   packages).
3. **Tag and publish in one run:** run the workflow `tag-release.yml` ("Tag release") on ref `main` with the inputs
   `version: 0.2.0` and `publish: true` (with the GitHub tools: the Actions "run workflow" call). It checks the version
   and the passed run, tags `main`'s head `desktop-native-v0.2.0`, starts `desktop.yml` on the tag (its release job
   makes the draft release with the six packages), waits for it, and publishes the draft as the latest release
   (`publish-release.yml`). With `publish: false` the release stays a draft for the user to look at; publish it later
   with "Publish release" (`publish-release.yml`, input `version`) or on GitHub.
4. **Report** the release's URL (`https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v0.2.0`)
   and its six packages: `NuXL_<version>_amd64.AppImage`, `_amd64.deb`, `_aarch64.AppImage`, `_arm64.deb`,
   `_aarch64.dmg`, `_x64-setup.exe`.

Why the workflows: sessions can push only their own branch, not tags, and a tag pushed with a workflow's own token
starts no workflow; "Tag release" makes the tag through the API and starts the release run itself. An existing tag is
never moved: for a fix after a release, bump to the next patch version. If a step fails, its message says what to do
(e.g. a release job whose run's packages expired after 14 days: re-run `main`'s run, then the release job).
