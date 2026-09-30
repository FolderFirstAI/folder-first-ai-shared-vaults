import type { DeliveryErrorCode } from './core';

/** Plain-language, deliberately non-destructive next steps for a failed shared vault. */
export function recoveryGuidance(errorCode: DeliveryErrorCode | undefined): string | undefined {
  if (errorCode === 'local-changes') {
    return 'Shared folders are receiving copies. First copy anything useful into My Work/Inbox (or My Work/Proposals for a suggested shared change). If the edit was accidental, use the Restore approved copy button for this vault and confirm it, then select Refresh all. Do not edit, delete, commit or push files in Shared to make this message disappear.';
  }
  if (errorCode === 'credential-manager-unavailable') {
    return 'Secure GitHub sign-in is not ready on this computer. Do not paste a password or token here. Ask your implementation specialist or IT to install and configure the approved Git Credential Manager, then choose Connect vaults to sign in in your browser.';
  }
  if (errorCode === 'remote-unavailable') {
    return 'The existing approved copy was kept. Check the internet connection and repository access. If GitHub sign-in may have expired, choose Connect vaults to reopen the approved browser sign-in, then select Refresh all.';
  }
  return undefined;
}
