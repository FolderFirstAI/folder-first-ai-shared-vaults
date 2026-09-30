# Practical AI OS Shared Vaults

Shared Vaults is a desktop-only Obsidian plugin that places an employee’s approved Company and Team GitHub repositories in prepared folders inside a Practical AI OS workspace.

The current source is a **pre-release candidate**. It is not yet available in Obsidian’s Community Plugins directory.

## What employees do

1. Open the prepared Practical AI OS workspace in Obsidian.
2. Open **Shared Vaults**.
3. Select **Connect vaults** and complete GitHub’s browser sign-in if asked.
4. Select **Refresh all** when they want to check for approved Company or Team updates.
5. If an accidental local edit blocks one shared vault, preserve anything useful in `My Work`, then use that vault’s confirmed **Restore approved copy** action and select **Refresh all** again.

The implementation specialist prepares `Shared/VAULTS.yaml`. Employees do not enter repository URLs, branches or folder paths.

## Requirements

- Obsidian desktop on macOS or Windows. Mobile is not supported.
- A recognized Practical AI OS workspace.
- System Git and Git Credential Manager installed and configured by the employee, implementation specialist or IT team.
- A GitHub account with access to every repository assigned in `Shared/VAULTS.yaml`.
- Network and browser authentication access permitted by the organization.

The plugin does not install or update Git, Git Credential Manager, Obsidian, itself or any dependency.

## Safety boundaries

Shared Vaults:

- writes receiving copies only to `Shared/Company` and prepared `Shared/Teams/<team>` folders;
- never reads or changes `My Work` during delivery operations;
- never pushes, commits, force-resets a remote branch or resolves merge conflicts;
- stores no GitHub password or token;
- opens authentication only after the employee deliberately selects **Connect vaults**;
- keeps existing local files when a refresh cannot reach GitHub or access is unavailable;
- refuses local commits, divergent history, symlinks, submodules, incompatible paths and repository-controlled checkout-filter/LFS configuration;
- refuses receiving repositories above 25,000 files, any single file above 100 MiB, or more than 1 GiB of directly versioned files;
- collects no telemetry and has no Practical AI OS server or account.

**Restore approved copy** is intentionally narrow. After confirmation, it removes uncommitted tracked and untracked non-ignored changes only inside one validated shared-vault receiving clone. It refuses local commits or divergent history. It does not update from GitHub; the employee selects **Refresh all** separately.

Removing someone’s GitHub access prevents later authenticated checks but cannot erase files already downloaded to their computer. Client IT owns endpoint retention and offboarding.

## Network and system access disclosure

The plugin invokes the computer’s system Git executable. Git connects to the `https://github.com/<owner>/<repository>` URLs prepared in `Shared/VAULTS.yaml` and uses the computer’s configured Git Credential Manager/browser flow. The plugin reads its current Obsidian vault and writes only the configured receiving paths plus its private runtime folder under `Shared/.practical-ai-os-delivery`.

Like all Obsidian Community plugins, it inherits Obsidian’s desktop permissions. Organizations should review the source and release hashes before approving it for sensitive workspaces.

## Updates

After the first Community-directory version is accepted, Obsidian will obtain compatible plugin updates from this repository’s GitHub releases. The plugin never updates itself. Managed organizations may pin a reviewed version through their normal software change process.

A plugin update changes plugin software only. It must preserve `Shared/VAULTS.yaml`, downloaded shared vaults, plugin state and `My Work`. Practical AI OS workspace-file upgrades are separate release-specific changes.

## Development

Development requires Node.js 22.6 or newer. Employees do not need Node.js.

```sh
npm ci
npm run lint
npm test
npm run build
```

The production build writes the Community-release asset `main.js` at the repository root. A valid release also attaches the matching root `manifest.json` and `styles.css` under a Git tag identical to the manifest version.

## Support and security

Use GitHub Issues for reproducible non-sensitive defects. Do not post credentials, private repository names, client content or logs containing private paths. Report a vulnerability through the repository’s private GitHub Security Advisory channel; see [SECURITY.md](SECURITY.md).

Shared Vaults is licensed under the [MIT License](LICENSE). Third-party components and licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
