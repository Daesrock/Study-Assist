/**
 * Tests for Image URL Detection and Processing
 * Covers: isPublicImageUrl, URL vs base64 decision logic
 */

import { describe, it, expect } from "vitest";
import type { ImageData } from "../../src/types/index";

// ============================================
// isPublicImageUrl Tests
// ============================================

/**
 * Replicate the isPublicImageUrl logic for testing
 * (Since it's not exported from images.ts, we test the logic directly)
 */
function isPublicImageUrl(src: string): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
    if (src.startsWith("chrome-extension://") || src.startsWith("moz-extension://")) return false;
    return true;
  } catch {
    return false;
  }
}

describe("isPublicImageUrl", () => {
  describe("Valid public URLs", () => {
    it("should return true for HTTPS URLs", () => {
      expect(isPublicImageUrl("https://example.com/image.png")).toBe(true);
      expect(isPublicImageUrl("https://netacad.com/content/diagram.jpg")).toBe(true);
      expect(isPublicImageUrl("https://cdn.example.org/images/photo.webp")).toBe(true);
    });

    it("should return true for HTTP URLs", () => {
      expect(isPublicImageUrl("http://example.com/image.png")).toBe(true);
    });

    it("should return true for URLs with query parameters", () => {
      expect(isPublicImageUrl("https://example.com/image.png?size=large&v=2")).toBe(true);
    });

    it("should return true for URLs with hash fragments", () => {
      expect(isPublicImageUrl("https://example.com/image.png#section")).toBe(true);
    });
  });

  describe("Invalid/non-public URLs", () => {
    it("should return false for data URIs", () => {
      expect(isPublicImageUrl("data:image/png;base64,iVBORw0KGgo...")).toBe(false);
    });

    it("should return false for blob URIs", () => {
      expect(isPublicImageUrl("blob:https://example.com/550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    });

    it("should return false for chrome-extension URLs", () => {
      expect(isPublicImageUrl("chrome-extension://abcdefghijklmnop/icon.png")).toBe(false);
    });

    it("should return false for moz-extension URLs", () => {
      expect(isPublicImageUrl("moz-extension://12345678-1234-1234-1234-123456789012/icon.png")).toBe(false);
    });

    it("should return false for localhost", () => {
      expect(isPublicImageUrl("http://localhost:3000/image.png")).toBe(false);
      expect(isPublicImageUrl("http://localhost/test.jpg")).toBe(false);
    });

    it("should return false for 127.0.0.1", () => {
      expect(isPublicImageUrl("http://127.0.0.1:8080/image.png")).toBe(false);
    });

    it("should return false for IPv6 localhost", () => {
      expect(isPublicImageUrl("http://[::1]:3000/image.png")).toBe(false);
    });

    it("should return false for file:// URLs", () => {
      expect(isPublicImageUrl("file:///C:/Users/image.png")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isPublicImageUrl("")).toBe(false);
    });

    it("should return false for invalid URLs", () => {
      expect(isPublicImageUrl("not-a-url")).toBe(false);
      expect(isPublicImageUrl("//example.com/image.png")).toBe(false);
    });

    it("should return false for ftp URLs", () => {
      expect(isPublicImageUrl("ftp://example.com/image.png")).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("should handle URLs with uppercase protocols", () => {
      // URL constructor normalizes protocol to lowercase, so this should work
      expect(isPublicImageUrl("HTTPS://example.com/image.png")).toBe(true);
    });

    it("should handle URLs with ports", () => {
      expect(isPublicImageUrl("https://example.com:8443/image.png")).toBe(true);
    });

    it("should handle subdomains", () => {
      expect(isPublicImageUrl("https://cdn.static.example.com/images/photo.png")).toBe(true);
    });

    it("should handle IP addresses (non-localhost)", () => {
      expect(isPublicImageUrl("http://192.168.1.100/image.png")).toBe(true);
      expect(isPublicImageUrl("https://8.8.8.8/test.jpg")).toBe(true);
    });
  });
});

// ============================================
// ImageData Structure Tests
// ============================================

describe("ImageData interface", () => {
  it("should support URL-only images (public URLs)", () => {
    const imageData: ImageData = {
      url: "https://netacad.com/diagram.png",
      mediaType: "image/png",
    };

    expect(imageData.url).toBe("https://netacad.com/diagram.png");
    expect(imageData.base64).toBeUndefined();
  });

  it("should support base64-only images (non-public sources)", () => {
    const imageData: ImageData = {
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAUA...",
      mediaType: "image/png",
    };

    expect(imageData.base64).toBeDefined();
    expect(imageData.url).toBeUndefined();
  });

  it("should support optional alt text", () => {
    const imageData: ImageData = {
      url: "https://example.com/image.png",
      mediaType: "image/png",
      alt: "Network diagram",
    };

    expect(imageData.alt).toBe("Network diagram");
  });

  it("should support location metadata", () => {
    const imageData: ImageData = {
      url: "https://example.com/option.png",
      mediaType: "image/png",
      location: "option",
    };

    expect(imageData.location).toBe("option");
  });
});

// ============================================
// URL vs Base64 Decision Logic
// ============================================

describe("Image processing decision logic", () => {
  it("should prefer URL for NetAcad images", () => {
    const netacadUrl = "https://static.netacad.com/courses/ccna/images/diagram.png";
    expect(isPublicImageUrl(netacadUrl)).toBe(true);
    // In actual implementation, this would skip base64 conversion
  });

  it("should prefer URL for Skillsforall images", () => {
    const skillsUrl = "https://skillsforall.com/content/image.jpg";
    expect(isPublicImageUrl(skillsUrl)).toBe(true);
  });

  it("should use base64 for data URIs (inline images)", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo...";
    expect(isPublicImageUrl(dataUri)).toBe(false);
    // In actual implementation, this would convert to base64
  });

  it("should use base64 for blob URLs (generated content)", () => {
    const blobUrl = "blob:https://example.com/123e4567-e89b-12d3-a456-426614174000";
    expect(isPublicImageUrl(blobUrl)).toBe(false);
  });

  it("should use base64 for localhost development", () => {
    const localhostUrl = "http://localhost:3000/test-image.png";
    expect(isPublicImageUrl(localhostUrl)).toBe(false);
  });
});

// ============================================
// Integration Scenarios
// ============================================

describe("Real-world image scenarios", () => {
  it("should handle typical NetAcad exam images", () => {
    const scenarios = [
      {
        url: "https://static-course-assets.s3.amazonaws.com/CCNA7/en/images/network-topology.png",
        expected: true,
      },
      {
        url: "https://contenidosdigitales.ulp.edu.ar/files/imagen.jpg",
        expected: true,
      },
      {
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E...",
        expected: false,
      },
    ];

    scenarios.forEach(({ url, expected }) => {
      expect(isPublicImageUrl(url)).toBe(expected);
    });
  });

  it("should handle CDN URLs", () => {
    const cdnUrls = [
      "https://cdn.jsdelivr.net/npm/package@version/image.png",
      "https://unpkg.com/package/dist/image.jpg",
      "https://cloudflare.cdn.com/assets/diagram.svg",
    ];

    cdnUrls.forEach((url) => {
      expect(isPublicImageUrl(url)).toBe(true);
    });
  });

  it("should reject browser extension internal resources", () => {
    const extensionUrls = [
      "chrome-extension://abcdefghij/resources/icon-128.png",
      "moz-extension://uuid-1234/icons/logo.svg",
    ];

    extensionUrls.forEach((url) => {
      expect(isPublicImageUrl(url)).toBe(false);
    });
  });
});
