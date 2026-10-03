# Folder First AI Shared Vaults

Shared Vaults is a desktop-only Obsidian plugin that places an employee’s approved Company and Team GitHub repositories in prepared folders inside a Folder First AI Workspace.

Version `1.0.0` is the first public release. Install it from Obsidian’s Community Plugins directory or from the reviewed [GitHub release](https://github.com/FolderFirstAI/folder-first-ai-shared-vaults/releases/tag/1.0.0).

## What employees do

1. Open the prepared Folder First AI Workspace in Obsidian.
2. Open **Shared Vaults**.
3. Select **Connect vaults** and complete GitHub’s browser sign-in if asked.
4. Select **Refresh all** when they want to check for approved Company or Team updates.
5. If an accidental local edit blocks one shared vault, preserve anything useful in `My Work`, then use that vault’s confirmed **Restore approved copy** action and select **Refresh all** again.

The implementation specialist prepares `Shared/VAULTS.yaml`. Employees do not enter repository URLs, branches or folder paths.

## Requirements

- Obsidian desktop on macOS or Windows. Mobile is not supported.
- A recognized Folder First AI Workspace.
- System Git and Git Credential Manager installed and configured by the employee, implementation specialist or IT team. On macOS, use GCM's official package/Homebrew installation or an already approved GitHub Desktop GCM configuration; on Windows, use the normal Git for Windows installation.
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
- refuses receiving repositories above 25,000 files, paths above 220 UTF-8 bytes, any single file above 100 MiB, or more than 1 GiB of directly versioned files;
- collects no telemetry and has no Folder First AI server or account.

**Restore approved copy** is intentionally narrow. After confirmation, it removes uncommitted tracked and untracked non-ignored changes only inside one validated shared-vault receiving clone. It refuses local commits or divergent history. It does not update from GitHub; the employee selects **Refresh all** separately.

Closing the Shared Vaults view or disabling the plugin cancels the active Git command and its helper processes. A partial staging folder is never treated as a connected receiving copy.

Removing someone’s GitHub access prevents later authenticated checks but cannot erase files already downloaded to their computer. Client IT owns endpoint retention and offboarding.

## Network and system access disclosure

The plugin invokes the computer’s system Git executable. Git connects to the `https://github.com/<owner>/<repository>` URLs prepared in `Shared/VAULTS.yaml` and uses the computer’s configured Git Credential Manager/browser flow. The plugin reads its current Obsidian vault and writes only the configured receiving paths plus its private runtime folder under `Shared/.folder-first-ai-delivery`.

Like all Obsidian Community plugins, it inherits Obsidian’s desktop permissions. Organizations should review the source and release hashes before approving it for sensitive workspaces.

## Updates

Obsidian obtains compatible plugin updates from this repository’s GitHub releases. The plugin never updates itself. Managed organizations may pin a reviewed version through their normal software change process.

A plugin update changes plugin software only. It must preserve `Shared/VAULTS.yaml`, downloaded shared vaults, plugin state and `My Work`. Folder First AI Workspace file upgrades are separate release-specific changes.

## Development

Development requires Node.js 22.6 or newer. Employees do not need Node.js.

```sh
npm ci
npm run lint
npm test
npm run build
```

The production build writes the Community-release asset `main.js` at the repository root. A valid release also attaches the matching root `manifest.json` and `styles.css` under a Git tag identical to the manifest version.

GitHub [artifact attestation 52392814](https://github.com/FolderFirstAI/folder-first-ai-shared-vaults/attestations/52392814) records the exact SHA-256 identities of the three `1.0.0` release files. A downloaded file can be verified with GitHub CLI:

```sh
gh attestation verify --owner FolderFirstAI <filename>
```

## Support and security

Use GitHub Issues for reproducible non-sensitive defects. Do not post credentials, private repository names, client content or logs containing private paths. Report a vulnerability through the repository’s private GitHub Security Advisory channel; see [SECURITY.md](SECURITY.md).

Shared Vaults is licensed under the [MIT License](LICENSE). Third-party components and licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
