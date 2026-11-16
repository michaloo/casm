// Shared by transcript links and direct file-preview routes; no browser dependencies.
export const windowsAbsolute = (path: string) => /^[a-z]:[\\/]|^\\\\[^\\]+\\[^\\]+/i.test(path);

export function insideRoot(path: string, roots: string[]): boolean {
  return roots.some(root => {
    let candidate = path;
    const windows = windowsAbsolute(root);
    if (windows) {
      root = root.replace(/\\/g, "/").toLowerCase();
      candidate = candidate.replace(/\\/g, "/").toLowerCase();
    }
    root = root.replace(/\/+$/, "");
    return candidate === root || candidate.startsWith(`${root}/`);
  });
}

export const fileHref = (path: string) => windowsAbsolute(path)
  ? `/f/${encodeURIComponent(path)}`
  : `/f${path.split("/").map(encodeURIComponent).join("/")}`;

export function pathFromHref(href: string | null | undefined): string | null {
  if (!href?.startsWith("/f/")) return null;
  try {
    const path = decodeURIComponent(href.slice(2));
    return windowsAbsolute(path.slice(1)) ? path.slice(1) : path;
  } catch { return null; }
}
