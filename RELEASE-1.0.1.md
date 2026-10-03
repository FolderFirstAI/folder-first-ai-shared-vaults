# Shared Vaults 1.0.1 release contract

## Purpose

Correct the Obsidian Community Overview, which cached the `1.0.0` tag's pre-release README and incorrectly says the already-installable plugin is unavailable.

## Allowed changes

- Update the public README from pre-release to live-installation wording.
- Add the pinned, least-privilege GitHub artifact-attestation workflow.
- Bump release metadata from `1.0.0` to `1.0.1` in `manifest.json`, `package.json`, `package-lock.json` and `versions.json`.
- Add this contract and the matching changelog entry.

## Preservation rules

- Do not change `src/`, `main.js` or `styles.css`.
- Keep the plugin ID, minimum Obsidian version, permissions, authentication, destinations and runtime behavior unchanged.
- Keep the existing `1.0.0` tag, release and attestation immutable.
- Publish only `main.js`, `manifest.json` and `styles.css` as `1.0.1` release assets.

## Acceptance

- The `1.0.1` `main.js` and `styles.css` hashes equal the published `1.0.0` hashes.
- Lint, 24 tests, typecheck/build, release structure, committed-bundle parity and runtime dependency audit pass.
- Hosted Ubuntu, macOS and Windows validation passes at the exact release commit.
- The GitHub `1.0.1` release is not a draft or prerelease and its assets match the reviewed local files.
- A GitHub artifact attestation covers the three exact `1.0.1` release files.
- Obsidian detects `1.0.1`; its Overview no longer says the plugin is unavailable.
