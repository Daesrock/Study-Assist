/** Comparison keys only: never use these values in provider requests. */
export function comparableModelId(id: string): string {
  return id.trim().toLowerCase().replace(/[._]/g, "-");
}

/** Publisher aliases only; model names and variant suffixes stay untouched. */
export function comparablePublisher(publisher: string): string {
  const id = publisher.trim().toLowerCase();
  if (id === "z-ai" || id === "zai-org") return "zai";
  if (id === "deepseek-ai") return "deepseek";
  return id;
}

export function isNvidiaNimUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "integrate.api.nvidia.com" &&
      !url.port && !url.username && !url.password && url.pathname.replace(/\/+$/, "") === "/v1";
  } catch {
    return false;
  }
}
