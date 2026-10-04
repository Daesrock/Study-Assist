/** Owned by one tab/frame request, never by the entire worker. */
export class AnalysisSession {
  readonly controller = new AbortController();
  primaryController?: AbortController;
  skipPrimary = false;
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  /** Keep only this pending operation alive; an open port alone is insufficient. */
  startKeepAlive(): void {
    if (this.disposed || this.controller.signal.aborted || this.keepAliveTimer !== undefined) return;
    const pulse = (): void => {
      try {
        // Extension API activity resets Chromium's service-worker idle timer.
        void chrome.runtime.getPlatformInfo().catch(() => {});
      } catch { /* Unavailable API must not change the analysis result. */ }
    };
    pulse();
    this.keepAliveTimer = setInterval(pulse, 20000);
  }

  /** Called on success, failure, replacement or disconnect. */
  dispose(): void {
    this.disposed = true;
    if (this.keepAliveTimer !== undefined) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  cancel(): void { this.dispose(); this.controller.abort(); this.primaryController?.abort(); }
  skip(): void { this.skipPrimary = true; this.primaryController?.abort(); }
  check(): void {
    if (this.controller.signal.aborted) throw new DOMException("Analysis cancelled", "AbortError");
  }
}
