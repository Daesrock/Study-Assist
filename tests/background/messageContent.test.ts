/**
 * Tests for Message Content Building with Image URL Support
 * Covers: buildMessageContent with URL vs base64 preference
 */

import { describe, it, expect } from "vitest";
import { buildMessageContent } from "../../src/background/modules/prompts";
import type { ImageData } from "../../src/types/index";
import type { ClaudeContentBlock } from "../../src/background/modules/constants";

// ============================================
// buildMessageContent Tests
// ============================================

describe("buildMessageContent", () => {
  describe("Text-only (no images)", () => {
    it("should return plain string for text without images", () => {
      const prompt = "What is the default gateway?";
      const result = buildMessageContent(prompt, undefined);

      expect(result).toBe(prompt);
      expect(typeof result).toBe("string");
    });

    it("should return plain string when images array is empty", () => {
      const prompt = "Analyze this question";
      const result = buildMessageContent(prompt, []);

      expect(result).toBe(prompt);
    });
  });

  describe("URL-based images (public URLs)", () => {
    it("should prefer URL over base64 when both are available", () => {
      const images: ImageData[] = [
        {
          url: "https://netacad.com/diagram.png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAUA...",
          mediaType: "image/png",
        },
      ];

      const result = buildMessageContent("Analyze this diagram", images);

      expect(Array.isArray(result)).toBe(true);
      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(2); // 1 image + 1 text

      const imageBlock = blocks[0];
      expect(imageBlock.type).toBe("image");
      if (imageBlock.type === "image") {
        expect(imageBlock.source.type).toBe("url");
        if (imageBlock.source.type === "url") {
          expect(imageBlock.source.url).toBe("https://netacad.com/diagram.png");
        }
      }
    });

    it("should use URL-only for public images (no base64 conversion)", () => {
      const images: ImageData[] = [
        {
          url: "https://example.com/network.jpg",
          mediaType: "image/jpeg",
        },
      ];

      const result = buildMessageContent("What protocol is shown?", images);

      const blocks = result as ClaudeContentBlock[];
      const imageBlock = blocks[0];
      
      expect(imageBlock.type).toBe("image");
      if (imageBlock.type === "image") {
        expect(imageBlock.source.type).toBe("url");
        if (imageBlock.source.type === "url") {
          expect(imageBlock.source.url).toBe("https://example.com/network.jpg");
        }
      }
    });

    it("should handle multiple URL-based images", () => {
      const images: ImageData[] = [
        {
          url: "https://netacad.com/diagram1.png",
          mediaType: "image/png",
        },
        {
          url: "https://netacad.com/diagram2.png",
          mediaType: "image/png",
        },
        {
          url: "https://netacad.com/diagram3.jpg",
          mediaType: "image/jpeg",
        },
      ];

      const result = buildMessageContent("Compare these diagrams", images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(4); // 3 images + 1 text

      const imageBlocks = blocks.slice(0, 3);
      imageBlocks.forEach((block, idx) => {
        expect(block.type).toBe("image");
        if (block.type === "image" && block.source.type === "url") {
          expect(block.source.url).toContain("netacad.com");
          expect(block.source.url).toContain(`diagram${idx + 1}`);
        }
      });
    });
  });

  describe("Base64-based images (non-public sources)", () => {
    it("should use base64 when URL is not available", () => {
      const images: ImageData[] = [
        {
          // Valid base64 string (>100 chars) representing a tiny 1x1 PNG
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
          mediaType: "image/png",
        },
      ];

      const result = buildMessageContent("Analyze this", images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(2); // 1 image + 1 text
      const imageBlock = blocks[0];

      expect(imageBlock.type).toBe("image");
      if (imageBlock.type === "image") {
        expect(imageBlock.source.type).toBe("base64");
        if (imageBlock.source.type === "base64") {
          expect(imageBlock.source.media_type).toBe("image/png");
          expect(imageBlock.source.data).toBe(images[0].base64);
        }
      }
    });

    it("should skip images with very short base64 (likely corrupted)", () => {
      const images: ImageData[] = [
        {
          base64: "abc", // Too short (<100 chars)
          mediaType: "image/png",
        },
        {
          // Valid base64 (>100 chars)
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
          mediaType: "image/png",
        },
      ];

      const result = buildMessageContent("Analyze", images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(2); // 1 valid image + 1 text (corrupted image skipped)
    });

    it("should handle mixed URL and base64 images", () => {
      const images: ImageData[] = [
        {
          url: "https://netacad.com/public.png",
          mediaType: "image/png",
        },
        {
          // Valid base64 (>100 chars)
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
          mediaType: "image/png",
        },
        {
          url: "https://example.com/another.jpg",
          mediaType: "image/jpeg",
        },
      ];

      const result = buildMessageContent("Compare these", images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(4); // 3 images + 1 text

      // First image should use URL
      const firstImage = blocks[0];
      expect(firstImage.type).toBe("image");
      if (firstImage.type === "image") {
        expect(firstImage.source.type).toBe("url");
      }

      // Second image should use base64
      const secondImage = blocks[1];
      expect(secondImage.type).toBe("image");
      if (secondImage.type === "image") {
        expect(secondImage.source.type).toBe("base64");
      }

      // Third image should use URL
      const thirdImage = blocks[2];
      expect(thirdImage.type).toBe("image");
      if (thirdImage.type === "image") {
        expect(thirdImage.source.type).toBe("url");
      }
    });
  });

  describe("Edge cases", () => {
    it("should skip images with neither URL nor base64", () => {
      const images: ImageData[] = [
        {
          mediaType: "image/png",
        },
      ];

      const result = buildMessageContent("Test", images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(1); // Only text, image skipped
      expect(blocks[0].type).toBe("text");
    });

    it("should skip null/undefined images in array", () => {
      const images: (ImageData | null | undefined)[] = [
        {
          url: "https://example.com/valid.png",
          mediaType: "image/png",
        },
        null,
        undefined,
        {
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
          mediaType: "image/png",
        },
      ];

      const result = buildMessageContent("Test", images as ImageData[]);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(3); // 2 valid images + 1 text
    });

    it("should always place text block last", () => {
      const images: ImageData[] = [
        { url: "https://example.com/1.png", mediaType: "image/png" },
        { url: "https://example.com/2.png", mediaType: "image/png" },
      ];

      const result = buildMessageContent("Final question text", images);

      const blocks = result as ClaudeContentBlock[];
      const lastBlock = blocks[blocks.length - 1];

      expect(lastBlock.type).toBe("text");
      if (lastBlock.type === "text") {
        expect(lastBlock.text).toBe("Final question text");
      }
    });
  });

  describe("Real-world scenarios", () => {
    it("should handle NetAcad question with public diagram", () => {
      const images: ImageData[] = [
        {
          url: "https://static-course-assets.s3.amazonaws.com/CCNA7/en/images/topology.png",
          mediaType: "image/png",
          location: "question",
        },
      ];

      const prompt = "Based on the network topology shown, what is the correct subnet mask?";
      const result = buildMessageContent(prompt, images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(2);
      
      // Image should use URL (saves tokens)
      const imageBlock = blocks[0];
      expect(imageBlock.type).toBe("image");
      if (imageBlock.type === "image" && imageBlock.source.type === "url") {
        expect(imageBlock.source.url).toContain("amazonaws.com");
      }
    });

    it("should handle inline SVG diagram (data URI)", () => {
      const images: ImageData[] = [
        {
          base64: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxjaXJjbGUgcj0iNTAiLz48L3N2Zz4=PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxjaXJjbGUgcj0iNTAiLz48L3N2Zz4=",
          mediaType: "image/svg+xml",
          location: "option",
        },
      ];

      const result = buildMessageContent("Which icon represents a router?", images);

      const blocks = result as ClaudeContentBlock[];
      const imageBlock = blocks[0];
      
      expect(imageBlock.type).toBe("image");
      if (imageBlock.type === "image") {
        expect(imageBlock.source.type).toBe("base64");
      }
    });

    it("should optimize token usage for multi-image questions", () => {
      // Scenario: Question with 3 public images
      const images: ImageData[] = [
        { url: "https://netacad.com/img1.png", mediaType: "image/png" },
        { url: "https://netacad.com/img2.png", mediaType: "image/png" },
        { url: "https://netacad.com/img3.png", mediaType: "image/png" },
      ];

      const result = buildMessageContent("Compare configurations A, B, and C", images);

      const blocks = result as ClaudeContentBlock[];
      expect(blocks).toHaveLength(4);

      // All images should use URL (not base64) for token efficiency
      blocks.slice(0, 3).forEach((block) => {
        expect(block.type).toBe("image");
        if (block.type === "image") {
          expect(block.source.type).toBe("url");
        }
      });
    });
  });
});
