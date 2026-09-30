import {
  App,
  FileSystemAdapter,
  ItemView,
  Modal,
  Notice,
  Plugin,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';
import {
  connectSharedVaults,
  inspectSharedVaults,
  refreshSharedVaults,
  restoreSharedVault,
  type DeliveryReport,
  type SharedVaultResult,
  type LocalSharedVaultStatus,
} from './core';
import { OperationGate } from './operation-gate';
import { recoveryGuidance } from './recovery';

const VIEW_TYPE = 'folder-first-ai-shared-vaults';

interface SavedSharedVaultState {
  lastAttemptAt: string;
  lastAction: string;
  lastSuccessfulAt?: string;
  commit?: string;
  errorCode?: string;
}

interface SavedPluginData {
  sharedVaults: Record<string, SavedSharedVaultState>;
}

function shortCommit(commit: string | undefined): string {
  return commit?.slice(0, 8) ?? '';
}

function resultSummary(result: SharedVaultResult): string {
  if (result.action === 'failed') return `Needs attention: ${result.message}`;
  if (result.action === 'restored') return `Restored at ${shortCommit(result.commit)}. Refresh all to check for newer approved files.`;
  if (result.action === 'updated') return `Updated to ${shortCommit(result.commit)}.`;
  if (result.action === 'connected') return `Connected at ${shortCommit(result.commit)}.`;
  return `Current at ${shortCommit(result.commit)}.`;
}

class RestoreSharedVaultModal extends Modal {
  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly localPath: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `Restore ${this.vaultName}?` });
    this.contentEl.createEl('p', {
      text: `This will permanently remove uncommitted changes and untracked files inside ${this.localPath}. It will not change My Work, any other shared vault, or the GitHub repository.`,
    });
    this.contentEl.createEl('p', {
      text: 'Copy anything useful to My Work/Inbox or My Work/Proposals first. After restoring, select Refresh all to check GitHub for newer approved files.',
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => button
        .setDestructive()
        .setCta()
        .setButtonText(`Restore ${this.vaultName}`)
        .onClick(() => {
          this.close();
          this.onConfirm();
        }));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class SharedVaultsView extends ItemView {
  private busy = false;
  private statuses: LocalSharedVaultStatus[] = [];
  private report?: DeliveryReport;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SharedVaultsPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Shared vaults';
  }

  override getIcon(): string {
    return 'refresh-cw';
  }

  override async onOpen(): Promise<void> {
    await this.reloadStatus();
  }

  override async onClose(): Promise<void> {
    this.plugin.cancelOperations();
  }

  private async reloadStatus(): Promise<void> {
    this.report = undefined;
    try {
      this.statuses = await inspectSharedVaults(this.plugin.workspacePath());
    } catch (error) {
      this.statuses = [];
      this.renderFatal(error);
      return;
    }
    this.render();
  }

  private renderFatal(error: unknown): void {
    const root = this.containerEl.children[1];
    if (!(root instanceof HTMLElement)) return;
    root.empty();
    root.addClass('folder-first-ai-shared-vaults');
    root.createEl('h2', { text: 'Shared vaults' });
    root.createEl('p', {
      cls: 'folder-first-ai-shared-vaults__attention',
      text: error instanceof Error ? error.message : 'The workspace configuration could not be read.',
    });
    root.createEl('p', {
      cls: 'folder-first-ai-shared-vaults__detail',
      text: 'No shared files were changed. Ask your implementation specialist or IT team for help.',
    });
  }

  private render(): void {
    const root = this.containerEl.children[1];
    if (!(root instanceof HTMLElement)) return;
    root.empty();
    root.addClass('folder-first-ai-shared-vaults');
    root.createEl('h2', { text: 'Shared vaults' });
    root.createEl('p', {
      text: 'Connect and refresh the approved Company and Team files prepared for this workspace.',
    });
    root.createEl('p', {
      cls: 'folder-first-ai-shared-vaults__detail',
      text: 'Connect can open your approved GitHub browser sign-in when needed. It never asks for a password or token. Your implementation specialist or IT team configures the approved secure sign-in method.',
    });

    const actions = root.createDiv({ cls: 'folder-first-ai-shared-vaults__actions' });
    const connect = actions.createEl('button', { text: 'Connect vaults' });
    const refresh = actions.createEl('button', { text: 'Refresh all', cls: 'mod-cta' });
    connect.disabled = this.busy;
    refresh.disabled = this.busy;
    connect.addEventListener('click', () => { void this.run('connect'); });
    refresh.addEventListener('click', () => { void this.run('refresh'); });

    if (this.busy) root.createEl('p', { text: 'Checking shared vaults…' });
    const panel = root.createDiv({ cls: 'folder-first-ai-shared-vaults__status' });
    if (this.report) {
      for (const result of this.report.sharedVaults) this.renderResult(panel, result);
      panel.createEl('p', {
        cls: 'folder-first-ai-shared-vaults__detail',
        text: `Checked ${new Date(this.report.checkedAt).toLocaleString()}.`,
      });
    } else {
      for (const status of this.statuses) this.renderStatus(panel, status);
    }
  }

  private renderStatus(parent: HTMLElement, status: LocalSharedVaultStatus): void {
    const row = parent.createDiv({ cls: 'folder-first-ai-shared-vaults__row' });
    row.createEl('strong', { text: `${status.name} — ${status.state.replace('-', ' ')}` });
    row.createDiv({
      cls: status.state === 'needs-attention'
        ? 'folder-first-ai-shared-vaults__detail folder-first-ai-shared-vaults__attention'
        : 'folder-first-ai-shared-vaults__detail',
      text: `${status.localPath}: ${status.message}${status.commit ? ` (${shortCommit(status.commit)})` : ''}`,
    });
    const recovery = recoveryGuidance(status.errorCode);
    if (recovery) row.createDiv({ cls: 'folder-first-ai-shared-vaults__detail', text: recovery });
    if (status.errorCode === 'local-changes') this.renderRestoreButton(row, status);
    const saved = this.plugin.lastState(status.localPath);
    if (saved) {
      const success = saved.lastSuccessfulAt
        ? ` Last successful check: ${new Date(saved.lastSuccessfulAt).toLocaleString()}${saved.commit ? ` at ${shortCommit(saved.commit)}` : ''}.`
        : ' No successful remote check is recorded yet.';
      row.createDiv({
        cls: 'folder-first-ai-shared-vaults__detail',
        text: `Last attempt: ${new Date(saved.lastAttemptAt).toLocaleString()} (${saved.lastAction}).${success}`,
      });
    }
  }

  private renderResult(parent: HTMLElement, result: SharedVaultResult): void {
    const row = parent.createDiv({ cls: 'folder-first-ai-shared-vaults__row' });
    row.createEl('strong', { text: `${result.name} — ${result.action.replace('-', ' ')}` });
    row.createDiv({
      cls: result.action === 'failed'
        ? 'folder-first-ai-shared-vaults__detail folder-first-ai-shared-vaults__attention'
        : 'folder-first-ai-shared-vaults__detail',
      text: `${result.localPath}: ${resultSummary(result)}`,
    });
    const recovery = recoveryGuidance(result.errorCode);
    if (recovery) row.createDiv({ cls: 'folder-first-ai-shared-vaults__detail', text: recovery });
    if (result.errorCode === 'local-changes') {
      this.renderRestoreButton(row, { role: result.role, name: result.name, localPath: result.localPath, state: 'needs-attention', errorCode: result.errorCode, message: result.message });
    }
  }

  private renderRestoreButton(parent: HTMLElement, status: LocalSharedVaultStatus): void {
    const restore = parent.createEl('button', { text: `Restore ${status.name} approved copy` });
    restore.disabled = this.busy;
    restore.addEventListener('click', () => {
      new RestoreSharedVaultModal(this.app, status.name, status.localPath, () => { void this.runRestore(status); }).open();
    });
  }

  private async run(operation: 'connect' | 'refresh'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const controller = this.plugin.startOperation();
    if (!controller) {
      this.busy = false;
      this.render();
      new Notice('A shared-vault check is already in progress.');
      return;
    }
    try {
      this.report = operation === 'connect'
        ? await connectSharedVaults(this.plugin.workspacePath(), { signal: controller.signal })
        : await refreshSharedVaults(this.plugin.workspacePath(), { signal: controller.signal });
      await this.plugin.remember(this.report);
      const failures = this.report.sharedVaults.filter((sharedVault) => sharedVault.action === 'failed').length;
      new Notice(failures === 0
        ? `Shared vaults ${operation === 'connect' ? 'connected' : 'checked'} successfully.`
        : `${failures} shared ${failures === 1 ? 'vault needs' : 'vaults need'} attention.`);
    } catch (error) {
      this.renderFatal(error);
      new Notice('Shared vaults were not changed. Open the view for details.');
      return;
    } finally {
      this.plugin.finishOperation(controller);
      this.busy = false;
    }
    this.render();
  }

  private async runRestore(status: LocalSharedVaultStatus): Promise<void> {
    if (this.busy || status.errorCode !== 'local-changes') return;
    this.busy = true;
    this.render();
    const controller = this.plugin.startOperation();
    if (!controller) {
      this.busy = false;
      this.render();
      new Notice('A shared-vault check is already in progress.');
      return;
    }
    let reloadAfterRestore = false;
    try {
      this.report = await restoreSharedVault(this.plugin.workspacePath(), status.localPath, { signal: controller.signal });
      await this.plugin.remember(this.report);
      const result = this.report.sharedVaults[0];
      if (result?.action === 'restored') {
        new Notice(`${status.name} was restored. Select Refresh all to check for newer approved files.`);
        reloadAfterRestore = true;
      } else {
        new Notice(`${status.name} was not restored. Review the message in Shared vaults.`);
      }
    } catch (error) {
      this.renderFatal(error);
      new Notice('Shared vault was not changed. Open the view for details.');
      return;
    } finally {
      this.plugin.finishOperation(controller);
      this.busy = false;
    }
    if (reloadAfterRestore) {
      await this.reloadStatus();
      return;
    }
    this.render();
  }
}

export default class SharedVaultsPlugin extends Plugin {
  private saved: SavedPluginData = { sharedVaults: {} };
  private readonly operations = new OperationGate();

  override async onload(): Promise<void> {
    const loaded = await this.loadData() as SavedPluginData | null;
    if (loaded?.sharedVaults && typeof loaded.sharedVaults === 'object') this.saved = loaded;
    this.registerView(VIEW_TYPE, (leaf) => new SharedVaultsView(leaf, this));
    this.addRibbonIcon('refresh-cw', 'Open shared vaults', () => { void this.activateView(); });
    this.addCommand({
      id: 'open-shared-vaults',
      name: 'Open shared vaults',
      callback: () => { void this.activateView(); },
    });
  }

  override onunload(): void {
    this.cancelOperations();
  }

  startOperation(): AbortController | undefined {
    return this.operations.start();
  }

  finishOperation(controller: AbortController): void {
    this.operations.finish(controller);
  }

  cancelOperations(): void {
    this.operations.cancel();
  }

  workspacePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Shared vaults require a normal local desktop vault.');
    }
    return adapter.getBasePath();
  }

  async remember(report: DeliveryReport): Promise<void> {
    for (const sharedVault of report.sharedVaults) {
      const previous = this.saved.sharedVaults[sharedVault.localPath];
      const succeeded = sharedVault.action !== 'failed';
      this.saved.sharedVaults[sharedVault.localPath] = {
        lastAttemptAt: sharedVault.checkedAt,
        lastAction: sharedVault.action,
        ...(succeeded ? { lastSuccessfulAt: sharedVault.checkedAt } : previous?.lastSuccessfulAt ? { lastSuccessfulAt: previous.lastSuccessfulAt } : {}),
        ...(sharedVault.commit ? { commit: sharedVault.commit } : previous?.commit ? { commit: previous.commit } : {}),
        ...(sharedVault.errorCode ? { errorCode: sharedVault.errorCode } : {}),
      };
    }
    await this.saveData(this.saved);
  }

  lastState(localPath: string): SavedSharedVaultState | undefined {
    const value = this.saved.sharedVaults[localPath];
    if (
      !value
      || typeof value.lastAttemptAt !== 'string'
      || typeof value.lastAction !== 'string'
      || (value.lastSuccessfulAt !== undefined && typeof value.lastSuccessfulAt !== 'string')
      || (value.commit !== undefined && typeof value.commit !== 'string')
      || (value.errorCode !== undefined && typeof value.errorCode !== 'string')
    ) return undefined;
    return value;
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice('Obsidian could not open the shared-vaults view.');
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
