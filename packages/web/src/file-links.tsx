// Absolute paths inside a project folder, found in transcript prose, inline
// code and code blocks, become links that open the file preview. Their href is
// the /f/<path> route, so opening one in a new tab works too.
import { createContext, useContext, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

export type FileLinks = { roots: string[]; open: (path: string) => void };
export const FileLinksContext = createContext<FileLinks | null>(null);

const CHARS = "[\\p{L}\\p{N}_.@+~%,=-]";
// Not inside a word, URL or relative path ("a/b", "./x", "https://h/x").
const PATH = new RegExp(`(?<![\\p{L}\\p{N}_.~:/\\\\@%+-])/${CHARS}+(?:/${CHARS}+)*/?`, "gu");

export const insideRoot = (path: string, roots: string[]) =>
  roots.some((r) => {
    const root = r.replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });

export function findPaths(text: string, roots: string[]): { index: number; path: string }[] {
  if (!roots.length || !text.includes("/")) return [];
  const found: { index: number; path: string }[] = [];
  for (const m of text.matchAll(PATH)) {
    // Sentence punctuation after a path is not part of it.
    const path = m[0].replace(/[.,:;=-]+$/, "").replace(/(.)\/$/, "$1");
    if (insideRoot(path, roots)) found.push({ index: m.index, path });
  }
  return found;
}

export const fileHref = (path: string) => `/f${path.split("/").map(encodeURIComponent).join("/")}`;
export function pathFromHref(href: string | null | undefined): string | null {
  if (!href?.startsWith("/f/")) return null;
  try {
    return decodeURIComponent(href.slice(2));
  } catch {
    return null;
  }
}

// A plain click opens the preview; modified clicks keep the browser's behaviour.
export function openFromClick(e: MouseEvent, links: FileLinks | null) {
  const a = (e.target as Element).closest?.("a.file-link");
  if (!a || !links || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const path = pathFromHref(a.getAttribute("href"));
  if (!path) return;
  e.preventDefault();
  links.open(path);
}

export function linkifyText(text: string, roots: string[]): ReactNode {
  const found = findPaths(text, roots);
  if (!found.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { index, path } of found) {
    parts.push(text.slice(at, index), <a key={index} className="file-link" href={fileHref(path)}>{path}</a>);
    at = index + path.length;
  }
  parts.push(text.slice(at));
  return parts;
}

// highlight.js output: paths only ever sit in text between tags, and contain
// none of the characters it escapes.
export function linkifyHtml(html: string, roots: string[]): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith("<")) return part;
      const found = findPaths(part, roots);
      let out = "";
      let at = 0;
      for (const { index, path } of found) {
        out += `${part.slice(at, index)}<a class="file-link" href="${fileHref(path)}">${path}</a>`;
        at = index + path.length;
      }
      return out + part.slice(at);
    })
    .join("");
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

// Remark plugin: text and whole-path inline code become links (`path:line` too).
export function remarkFilePaths({ roots }: { roots: string[] }) {
  const split = (value: string): MdNode[] => {
    const found = findPaths(value, roots);
    if (!found.length) return [{ type: "text", value }];
    const nodes: MdNode[] = [];
    let at = 0;
    for (const { index, path } of found) {
      if (index > at) nodes.push({ type: "text", value: value.slice(at, index) });
      nodes.push({ type: "link", url: fileHref(path), children: [{ type: "text", value: path }] });
      at = index + path.length;
    }
    if (at < value.length) nodes.push({ type: "text", value: value.slice(at) });
    return nodes;
  };
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child.value ?? "");
      if (child.type === "inlineCode") {
        const value = (child.value ?? "").trim();
        const [first] = findPaths(value, roots);
        if (first?.index === 0 && /^(:\d+)*\/?$/.test(value.slice(first.path.length)))
          return [{ type: "link", url: fileHref(first.path), children: [child] }];
        return [child];
      }
      walk(child);
      return [child];
    });
  };
  return (tree: MdNode) => walk(tree);
}

// Markdown links: file links (and plain absolute paths inside a project) open
// the preview; everything else is an ordinary link.
export function MarkdownLink({ href, children, node: _node, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const links = useContext(FileLinksContext);
  const path = pathFromHref(href) ?? (href?.startsWith("/") && links && insideRoot(href, links.roots) ? href : null);
  if (!path || !links) return <a href={href} {...rest}>{children}</a>;
  return <a {...rest} className="file-link" href={fileHref(path)} onClick={(e) => openFromClick(e, links)}>{children}</a>;
}
