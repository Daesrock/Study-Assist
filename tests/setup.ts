/**
 * Vitest Setup - Mock Chrome APIs and global setup
 */

import { vi } from "vitest";

// ============================================
// Mock Chrome Extension APIs
// ============================================

const mockStorage: Record<string, unknown> = {};

const chromeStorageLocal = {
  get: vi.fn(async (keys: string | string[]) => {
    if (typeof keys === "string") {
      return { [keys]: mockStorage[keys] };
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in mockStorage) result[key] = mockStorage[key];
    }
    return result;
  }),
  set: vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(mockStorage, items);
  }),
};

const chromeAction = {
  setBadgeText: vi.fn(async () => {}),
  setBadgeBackgroundColor: vi.fn(async () => {}),
  setIcon: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
};

const chromeRuntime = {
  getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
  onMessage: {
    addListener: vi.fn(),
  },
  onInstalled: {
    addListener: vi.fn(),
  },
  onStartup: {
    addListener: vi.fn(),
  },
  sendMessage: vi.fn(),
};

const chromeTabs = {
  onUpdated: {
    addListener: vi.fn(),
  },
  sendMessage: vi.fn(),
};

// Set up global chrome mock
const chromeMock = {
  storage: { local: chromeStorageLocal },
  action: chromeAction,
  runtime: chromeRuntime,
  tabs: chromeTabs,
};

// @ts-expect-error - Mocking global chrome
globalThis.chrome = chromeMock;

// ============================================
// Polyfill innerText for jsdom
// jsdom doesn't implement innerText (requires layout engine)
// Fallback to textContent for testing
// ============================================

if (!("innerText" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
    set(value: string) {
      this.textContent = value;
    },
    configurable: true,
  });
}

// Export for tests to access and manipulate
export { mockStorage, chromeStorageLocal, chromeAction, chromeRuntime };
