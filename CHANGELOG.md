# Changelog

All notable changes use semantic versioning. Internal `0.0.x` versions are release-candidate evidence and were not published in the Obsidian Community directory.

## Unreleased

- Prepare the standalone public repository, license, release checks and Community-directory submission.
- Complete current Mac/Windows behavior and plugin-update qualification.

## 0.0.8 — 2026-09-30

- Neutralize repository protocols, hooks, global attributes, file-monitor commands and untracked-cache behavior for plugin Git operations.
- Refuse receiving repositories above 25,000 files, any file above 100 MiB, or more than 1 GiB of directly versioned files before checkout.
- Build against the qualified public Obsidian Desktop 1.13.7 support floor and pin CI actions by commit.

## 0.0.7 — 2026-09-30

- Refuse repository-controlled `.gitattributes` and `.lfsconfig` files before checkout.
- Tighten Git Credential Manager helper recognition to exact standard names or one absolute executable path.
- Retain deliberate Connect authentication, non-interactive Refresh, confirmed local-only Restore and all prior preservation rules.

## 0.0.6 — 2026-09-30

- Recheck private GitHub access during deliberate Connect for existing clones.
- Add confirmed per-vault Restore for uncommitted local receiving-copy edits while refusing local commits/divergence.
