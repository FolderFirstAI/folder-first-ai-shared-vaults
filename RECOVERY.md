---
id: practical-ai-os-shared-vaults-recovery
type: guide
status: release-candidate
created: "2026-09-29"
updated: "2026-09-30"
summary: "Plain-language setup and confirmed local-change recovery for the Shared Vaults release-candidate plugin."
---
# Shared Vaults: setup and recovery

> **Pre-release source only.** This guide describes Shared Vaults `0.0.8`, the Community-release stabilization build after Practical AI OS `1.0.0-rc.5`. It is not yet production-approved or a substitute for client IT approval.

## What this view does

The Shared Vaults view places approved Company and Team folders inside an employee's workspace, then checks those copies for changes. It does not decide who may access a repository, edit official company guidance, repair local edits automatically, or store a password/token.

An employee should normally see one simple sequence:

1. Open the prepared workspace in Obsidian.
2. Select **Connect vaults** once.
3. Sign into the employee's own GitHub account in the browser if asked.
4. See the permitted Company and Team folders under `Shared`.
5. Later select **Refresh all** while Obsidian is open.

All three actions are user-driven. **Connect vaults** is the only action that
may open a GitHub browser sign-in. **Refresh all** shows a result for every
vault but reuses an existing approved sign-in without interrupting the user.
**Restore approved copy** appears only after a local-edit safety stop and asks
for confirmation; it changes only the local receiving copy and never contacts
GitHub. If Refresh says access could not be confirmed and sign-in may have
expired, select Connect vaults, complete the browser sign-in, then Refresh all.

Here, “non-interactive” means **Refresh all will not surprise the employee with
a sign-in window**. Refresh and Restore are still visible buttons the employee
chooses, and both show an explicit result. Automatic/background refresh is not
part of `1.0.0`.

## If it says “Local shared-vault edits were found”

This is a safety stop. A file inside `Shared/Company` or `Shared/Teams/...` differs from the approved receiving copy. The plugin will not overwrite it because it cannot know whether the change is important.

1. **Do not edit, delete, commit or push files in `Shared` to make the warning disappear.** Those folders are receiving copies.
2. If the change contains a useful note, first **copy it** to `My Work/Inbox`. If it is a suggested change to Company or Team guidance, copy it to `My Work/Proposals` and tell the relevant steward.
3. If the change is just accidental and you have saved anything useful outside Shared, select **Restore Company approved copy** or **Restore [Team] approved copy** in the same row. Read the confirmation carefully. It deletes only uncommitted tracked and untracked files in that one shared folder; it does not change `My Work`, another Team folder or GitHub.
4. The restore button is intentionally unavailable for a wrong repository/branch, an unsafe location, local commits or divergent history. Tell the implementation specialist or support owner in those cases. They decide whether a preserved change belongs in a reviewed steward proposal or needs a separate repair.
5. After a successful restore, select **Refresh all** to check GitHub for a newer approved revision.

The plugin deliberately has no “discard everything” button. Restore is limited to one validated receiving copy, requires confirmation, and never turns a local edit into an official shared change.

## If it says secure sign-in is not configured

The plugin uses the computer's normal Git Credential Manager (GCM) for secure browser sign-in. The plugin does not install it, and an employee must never paste a password, recovery code or GitHub token into Obsidian.

### Small business / individual setup

An implementation specialist can prepare one computer at a time:

1. Confirm the current official **Git for Windows** application and Git Credential Manager are approved for that Windows PC. A Git executable privately bundled inside Codex, GitHub Desktop or another app is not a supported prerequisite because that app can update or remove it independently.
2. Install the current official Git for Windows package, including its Git Credential Manager option. It installs Git in a normal location and configures GCM for that user or computer; GCM uses Windows Credential Manager by default. [Official Git for Windows download](https://git-scm.com/download/win), [Git Credential Manager installation instructions](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/install.md) and [credential-store reference](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/credstores.md).
3. Reopen Obsidian, select **Connect vaults**, and let the employee complete their own GitHub browser sign-in.
4. Confirm the expected Company/Team folders appear. Record only that success, application versions and the account name—never passwords, codes or token values.

The official Git for Windows installer is the preferred Windows path. Do not
copy a command that happens to work on another computer: application paths and
existing Git helpers vary.

If Windows PowerShell can run Git but the Shared Vaults view says that Git is
unavailable, do not edit PATH, paste an executable path or change credentials.
First confirm that PowerShell is not using a private runtime bundled with
Codex, GitHub Desktop or another app. Close/reopen Obsidian once after a normal
Git for Windows installation; if the message remains, preserve it and ask the
implementation specialist or IT team to check the approved installation.
Candidate version 0.0.8 accepts only conventional Git for Windows locations;
it intentionally does not depend on another app's private runtime.

### Managed client setup

Client IT installs/updates approved Git and GCM through its ordinary device-management process, then confirms the secure store and GitHub sign-in on a representative device. GCM documents Windows Registry/Group Policy defaults and macOS configuration profiles for MDM. [Official enterprise configuration guide](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/enterprise-config.md).

A one-device Windows test passed the candidate's bounded connection, exact placement, refresh, restart and local-edit-refusal path using official Git for Windows and a secure system Git Credential Manager helper. It has **not** qualified managed Windows, SSO/GitHub Enterprise, a client MDM configuration or newcomer self-service.

## What the specialist checks

- the workspace is the intended local Practical AI OS folder;
- its prepared `Shared/VAULTS.yaml` names only permitted Company/Team repositories and exact receiving paths;
- Git Credential Manager uses the platform secure store, not plaintext/cache/no-store modes;
- the employee's own GitHub account has the expected repository access;
- a successful refresh does not modify `My Work`.

If any check fails, preserve the workspace and error message, then use the client’s IT/support process. Do not widen repository access, share an administrator login, disable security controls or replace the receiving copy blindly.
