/** Classify trusted NetAcad platform hosts without inspecting URL paths or queries. */
export function netAcadHost(pageUrl: string | undefined): "netacad" | "skillsforall" | null {
  if (!pageUrl) return null;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "netacad.com" || host.endsWith(".netacad.com")) return "netacad";
    if (host === "skillsforall.com" || host.endsWith(".skillsforall.com")) return "skillsforall";
  } catch { /* Invalid or unavailable page URL. */ }
  return null;
}
