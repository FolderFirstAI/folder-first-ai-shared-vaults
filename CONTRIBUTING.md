# Contributing

Shared Vaults has one narrow job: receive approved Company and Team GitHub repositories into prepared Folder First AI Workspace folders without changing personal work or writing to GitHub.

Before proposing a change:

1. Open an issue that describes the employee problem, affected platform and smallest safe reproduction.
2. Preserve the product boundaries in `README.md` and `SECURITY.md`.
3. Add or update a deterministic regression for behavior changes.
4. Run `npm ci`, `npm run lint`, `npm test`, `npm run build` and `node scripts/check-release.mjs`.
5. Do not include credentials, private repository names, client content or identifying local paths.

Changes involving authentication, filesystem destinations, Git commands, Restore behavior, new network access, telemetry, dependencies or automatic/background operation require a focused threat review and exact macOS/Windows native evidence before release.

Release tags and assets are created only by the maintainer after qualification. A passing pull request is not a release approval.
