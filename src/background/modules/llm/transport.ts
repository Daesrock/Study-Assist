/**
 * LLM Transport
 *
 * Thin wrapper over `fetchWithRetry` that allows injecting a `fetch`
 * implementation. This is the single seam used by tests to assert exact
 * request bodies and simulate SSE streams without touching the network.
 */

import { fetchWithRetry } from "../fetchUtils.js";
import type { FetchOptionsWithSignal } from "../constants.js";

export type LlmFetch = typeof fetch;

let injectedFetch: LlmFetch | undefined;

/** Inject a fetch implementation (tests). Pass `undefined` to reset. */
export function setLlmFetch(fn: LlmFetch | undefined): void {
  injectedFetch = fn;
}

export interface LlmRequestOptions {
  url: string;
  init: FetchOptionsWithSignal;
  /** Retries after the first attempt. Default 2. */
  retries?: number;
  /** Per-attempt timeout in ms. Default 30000. */
  timeout?: number;
}

export function llmRequest(opts: LlmRequestOptions): Promise<Response> {
  return fetchWithRetry(
    opts.url,
    opts.init,
    opts.retries ?? 2,
    opts.timeout ?? 30000,
    injectedFetch,
  );
}
