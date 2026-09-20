/** Remote image URLs must not reveal signed queries or target local services.
 * This is a conservative filter, not DNS resolution or a guarantee of publicity.
 */
export function isPublicImageUrl(src: string): boolean {
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase();
    if (!host.includes(".") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) return false;
    if (/(^|\.)(localhost|local|internal|home|lan)$/.test(host)) return false;
    return !url.pathname.includes("/pluginfile.php/");
  } catch { return false; }
}
