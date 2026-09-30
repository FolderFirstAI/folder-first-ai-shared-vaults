# Changelog

All notable changes use semantic versioning. Internal `0.0.x` versions are release-candidate evidence and were not published in the Obsidian Community directory.

## Unreleased

- Prepare the standalone public repository, license, release checks and Community-directory submission.
- Complete current Mac/Windows behavior and plugin-update qualification.

## 0.0.11 — 2026-09-30

- Stop the active Git command and its helper processes when the Shared Vaults view closes, the plugin is disabled, output exceeds its safe limit or the operation times out.
- Add a cross-platform regression test proving that process-tree cancellation stops a spawned descendant.

## 0.0.10 — 2026-09-30

- Re-enable Connect and Refresh immediately after a successful confirmed Restore instead of leaving the view in its temporary busy state until reopened.

## 0.0.9 — 2026-09-30

- Accept the safe shell-escaped absolute Git Credential Manager path written by GitHub Desktop on macOS.
- Add a regression test for that exact native configuration while continuing to reject unescaped whitespace, unexpected escapes and shell syntax.

## 0.0.8 — 2026-09-30

- Add the official Obsidian ESLint rules to local and hosted validation; resolve every reported source error and warning.
- Preserve the employee's chosen Shared Vaults pane location when the plugin is disabled or updated.
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
