/** Keeps the plugin from running overlapping Git operations against Shared/. */
export class OperationGate {
  private active?: AbortController;

  start(): AbortController | undefined {
    if (this.active) return undefined;
    this.active = new AbortController();
    return this.active;
  }

  finish(controller: AbortController): void {
    if (this.active === controller) this.active = undefined;
  }

  cancel(): void {
    this.active?.abort();
    this.active = undefined;
  }
}
