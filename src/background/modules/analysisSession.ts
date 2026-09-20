/** Owned by one tab/frame request, never by the entire worker. */
export class AnalysisSession {
  readonly controller = new AbortController();
  primaryController?: AbortController;
  skipPrimary = false;
  cancel(): void { this.controller.abort(); this.primaryController?.abort(); }
  skip(): void { this.skipPrimary = true; this.primaryController?.abort(); }
  check(): void {
    if (this.controller.signal.aborted) throw new DOMException("Analysis cancelled", "AbortError");
  }
}
