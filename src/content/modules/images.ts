/**
 * Images Module
 * Handles image extraction and conversion for sending to AI APIs.
 * Prefers sending public URLs directly (saves tokens), falls back to base64.
 */

import type { ImageData } from "../../types/index.js";
import { querySelectorAllDeep } from "./utils.js";

/**
 * Check if a URL is a publicly accessible HTTP(S) URL that Claude can fetch.
 * Excludes data URIs, blob URIs, extension URLs, and localhost.
 */
export function isPublicImageUrl(src: string): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
    // Exclude extension-internal URLs
    if (src.startsWith("chrome-extension://") || src.startsWith("moz-extension://")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract all relevant images from a root element and convert them to base64
 * @param root - The root element to search for images
 * @returns Array of base64-encoded images
 */
export async function extractImagesAsBase64(root: Element): Promise<ImageData[]> {
  const images: ImageData[] = [];

  // Find all img elements (deep search)
  const imgElements = querySelectorAllDeep("img", root) as HTMLImageElement[];

  for (const img of imgElements) {
    try {
      // Get the image source
      const imgSrc: string = img.src;

      // Skip data URIs that are too small (icons)
      if (imgSrc.startsWith("data:") && imgSrc.length < 500) {
        continue;
      }

      // Skip known icon patterns
      if (
        imgSrc.includes("icon") ||
        imgSrc.includes("logo") ||
        imgSrc.includes("avatar")
      ) {
        continue;
      }

      // Wait for image to load if needed
      if (!img.complete) {
        await new Promise<void>((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          // Timeout after 3 seconds
          setTimeout(resolve, 3000);
        });
      }

      // Check dimensions after loading (but be more lenient)
      const width: number = img.naturalWidth || img.width || 100;
      const height: number = img.naturalHeight || img.height || 100;

      if (width < 30 || height < 30) {
        continue;
      }

      // If image is publicly accessible, use URL directly (no base64 conversion needed)
      if (isPublicImageUrl(imgSrc)) {
        images.push({
          url: imgSrc,
          mediaType: "image/jpeg", // Claude doesn't need this for URL type
        });
      } else {
        // For non-public images (data:, blob:, CORS-restricted), convert to base64
        const base64Data = await imageToBase64(img);
        if (base64Data) {
          images.push(base64Data);
        }
      }
    } catch (error) {
      console.warn("[Study Assist] Failed to extract image:", error);
    }
  }

  return images;
}

/**
 * Convert an image element to base64
 * @param img - Image element to convert
 * @returns Base64 data or null if conversion fails
 */
export async function imageToBase64(img: HTMLImageElement): Promise<ImageData | null> {
  return new Promise((resolve) => {
    try {
      // If image is not loaded, wait for it
      if (!img.complete) {
        img.onload = () => convertToBase64(img, resolve);
        img.onerror = () => resolve(null);
        return;
      }

      convertToBase64(img, resolve);
    } catch (error) {
      console.warn("[Study Assist] Image conversion error:", error);
      resolve(null);
    }
  });
}

/**
 * Convert a loaded image to base64 using canvas
 * @param img - Loaded image element
 * @param resolve - Promise resolve function to call with result
 */
export function convertToBase64(
  img: HTMLImageElement,
  resolve: (value: ImageData | null) => void
): void {
  try {
    const canvas: HTMLCanvasElement = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    // Skip if canvas is too small
    if (canvas.width < 50 || canvas.height < 50) {
      resolve(null);
      return;
    }

    const ctx: CanvasRenderingContext2D | null = canvas.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(img, 0, 0);

    // Get as PNG base64
    const dataUrl: string = canvas.toDataURL("image/png");
    const base64: string = dataUrl.replace(/^data:image\/\w+;base64,/, "");

    resolve({
      base64: base64,
      mediaType: "image/png",
    });
  } catch (error) {
    // CORS error - try fetching the image
    fetchImageAsBase64(img.src)
      .then(resolve)
      .catch(() => resolve(null));
  }
}

/**
 * Fetch an image via URL and convert to base64 (for CORS-restricted images)
 * @param url - The URL of the image to fetch
 * @returns Base64 data or null if fetch fails
 */
export async function fetchImageAsBase64(url: string): Promise<ImageData | null> {
  try {
    const response: Response = await fetch(url);
    const blob: Blob = await response.blob();

    return new Promise((resolve, reject) => {
      const reader: FileReader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64: string = dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const mediaType: string = blob.type || "image/png";
        resolve({ base64, mediaType });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.warn("[Study Assist] Failed to fetch image:", error);
    return null;
  }
}
