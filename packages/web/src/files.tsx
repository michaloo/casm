import type { PreviewImage } from "./image-preview";
import { ImageCanvas, ImageSteps } from "./image-canvas";
// Shared read-only preview for project files and in-memory transcript images.
// File paths keep Download and Copy path; inline images use named downloads. Downloads use short-lived signed links from the server
// the page is connected to, so they work for peers' files and on iPhone Safari.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { FileContent } from "@casm/protocol";
import { serverURL, type Rpc } from "./state";
import { CodeBlock, Prose, copy } from "./transcript";
import { FileLinksContext, splitLine } from "./file-links";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", py: "python", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml",
};
const extension = (name: string) => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
const formatTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// Follows a download link the way a click on <a href download> does.
function save(href: string, name: string) {
  const a = Object.assign(document.createElement("a"), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
// Clipboard image writes consistently support PNG, including when the source is JPEG/WebP.
async function clipboardPng(source: string): Promise<Blob> {
  const response = await fetch(source);
  if (!response.ok) throw new Error("Could not load image for copying");
  const url = URL.createObjectURL(await response.blob());
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve(); img.onerror = () => reject(new Error("Could not load image for copying")); img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not copy image")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
type Link = { href: string; expires: number };
async function signedLink(rpc: Rpc, host: string, path: string, inline = false): Promise<Link> {
  const r = await rpc.call("fs.downloadLink", { path, inline }, host);
  // Same origin when possible (browsers only honour a[download] there): the
  // Vite dev server proxies /dl to VITE_CASM_URL; only ?server= goes cross-origin.
  const href = new URLSearchParams(location.search).has("server") ? new URL(r.url, serverURL()).href : r.url;
  return { href, expires: Date.parse(r.expiresAt) };
}

export function FilePreview({ rpc, host = "", path: initial = "", images, index: initialIndex = 0, roots, close }: {
  rpc?: Rpc; host?: string; path?: string; images?: PreviewImage[]; index?: number; roots: string[]; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(initialIndex);
  const memory = images?.[index];
  const [trail, setTrail] = useState([initial]);
  const { path, line } = splitLine(trail[trail.length - 1]);
  const [file, setFile] = useState<FileContent>();
  const [error, setError] = useState("");
  const [download, setDownload] = useState<Link>();
  const [image, setImage] = useState<string>();
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setFile(undefined); setError(""); setDownload(undefined); setImage(undefined);
    if (memory || !rpc) return;
    void rpc.call("fs.read", { path }, host).then(async (f) => {
      if (!active) return;
      setFile(f);
      if (f.type !== "file") return;
      const [link, inline] = await Promise.all([
        signedLink(rpc, host, path),
        f.mime.startsWith("image/") ? signedLink(rpc, host, path, true) : undefined,
      ]);
      if (!active) return;
      setDownload(link);
      if (inline) setImage(inline.href);
    }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [rpc, host, path, memory]);
  const go = (next: string) => setTrail((t) => [...t, next]);
  // Opening a link inside the preview moves the preview there.
  const links = useMemo(() => ({ roots, open: go }), [roots]);
  // Links last a few minutes; an old one is replaced before it is followed.
  const fresh = (e: MouseEvent<HTMLAnchorElement>) => {
    if (memory || !rpc) return;
    if (download && download.expires - Date.now() > 30_000) return;
    e.preventDefault();
    void signedLink(rpc, host, path).then((link) => { setDownload(link); save(link.href, name); }).catch((err) => setError(message(err)));
  };
  const name = memory?.name ?? baseName(path);
  const source = memory?.src ?? image;
  const navigate = (delta: number) => setIndex(i => Math.max(0, Math.min((images?.length ?? 1) - 1, i + delta)));
  return createPortal(<dialog ref={dialog} className="host-settings file-preview" aria-label={`File ${name}`}
    onKeyDown={event => { if (images && !/INPUT|TEXTAREA/.test((event.target as HTMLElement).tagName) && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); navigate(event.key === "ArrowLeft" ? -1 : 1); } }}
    // React passes "close" up through portals: it must not also close a settings dialog this one opened from.
    onClose={(e) => { e.stopPropagation(); close(); }}>
    <header>
      <h2 title={path || name}>{name}</h2>
      <button type="button" aria-label="Close file preview" onClick={() => dialog.current?.close()}>×</button>
    </header>
    <div className="file-preview-bar">
      {!memory && <code className="settings-path">{path}</code>}
      {file && <small className="file-meta">{file.type === "dir" ? "Folder" : `${formatSize(file.size)} · ${file.mime}`} · modified {formatTime(file.mtime)}</small>}
      <div className="settings-actions">
        {trail.length > 1 && <button type="button" onClick={() => setTrail((t) => t.slice(0, -1))}>Back</button>}
        {memory && <a className="button" href={memory.src} download={name}>Download</a>}
        {file?.type === "file" && (download
          ? <a className="button" href={download.href} download={name} onClick={fresh}>Download</a>
          : <button type="button" disabled>Download</button>)}
        {!memory && <button type="button" onClick={() => void copy(path).then(() => setCopied("Copied ✓"), () => setCopied("Select to copy"))
          .finally(() => setTimeout(() => setCopied(""), 1800))}>{copied || "Copy path"}</button>}
        {source && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write && <button type="button" onClick={() => {
          const blob = clipboardPng(source);
          void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => setCopied("Image copied ✓"), err => setError(message(err)));
        }}>{copied || "Copy image"}</button>}
      </div>
    </div>
    <div className={`settings-content file-preview-body${source ? " has-image" : ""}`}>
      {error && <p role="alert" className="error">{error}</p>}
      {!memory && !file && !error && <p role="status">Loading…</p>}
      {source && <ImageCanvas key={`${index}:${path || name}`} src={source} name={name} close={() => dialog.current?.close()}>
        {images && images.length > 1 && <ImageSteps index={index} count={images.length} step={navigate} />}
      </ImageCanvas>}
      {!source && file && <FileLinksContext.Provider value={links}>
        <FileBody file={file} line={line} />
      </FileLinksContext.Provider>}
    </div>
  </dialog>, document.body);
}

// Scripts run so that self-contained pages (charts, reports) work, but the
// sandbox has no allow-same-origin: the page gets an opaque origin and can't
// touch casm's storage, token, cookies or API. It can still make outbound
// network requests like any web page; popups, forms, top navigation and
// downloads stay blocked.
const HTML_SANDBOX = "allow-scripts";
const RELATIVE_ASSET = /\b(?:src|href)\s*=\s*["']?(?!(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:))[^"'\s>]+/i;

function HtmlView({ html, line }: { html: string; line?: number }) {
  const [view, setView] = useState<"rendered" | "source">("rendered");
  const doc = useMemo(() => /<head[\s>]/i.test(html) ? html : `<meta charset="utf-8">${html}`, [html]);
  const assets = RELATIVE_ASSET.test(html);
  return <>
    <div className="file-view-toggle" role="group" aria-label="HTML view">
      {(["rendered", "source"] as const).map(v => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v === "rendered" ? "Rendered" : "Source"}</button>)}
    </div>
    {view === "rendered" ? <>
      <iframe className="file-html-frame" title="Rendered HTML" sandbox={HTML_SANDBOX} referrerPolicy="no-referrer" srcDoc={doc} />
      {assets && <p className="file-note muted">This page refers to files next to it (images, styles, scripts). Only the HTML file itself is shown, so those won't load.</p>}
    </> : <CodeBlock text={html} language="html" line={line} />}
  </>;
}

function FileBody({ file, line }: { file: FileContent; line?: number }) {
  const ext = extension(file.path);
  if (file.type === "dir") return <p className="file-note">This is a folder. Open a file inside it from the transcript to preview or download it.</p>;
  if (file.type !== "file") return <p>This is not a regular file, so there is nothing to preview.</p>;
  const truncated = file.truncated && <p role="note" className="file-note">Showing the first 1 MB of {formatSize(file.size)}. Download the file to see all of it.</p>;
  if (file.mime.startsWith("image/"))
    return <p role="status">Loading image…</p>;
  if (file.content === null)
    return <p className="file-note">{file.binary ? "Binary file" : "No preview"} · {formatSize(file.size)} · {file.mime}. Use Download to open it on this device.</p>;
  if (!file.content) return <p className="file-note">This file is empty.</p>;
  if ((ext === "html" || ext === "htm") && !file.truncated) return <HtmlView html={file.content} line={line} />;
  if (file.mime === "text/markdown") return <>{truncated}<Prose text={file.content} /></>;
  let text = file.content;
  if (ext === "json" && !file.truncated) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  return <>{truncated}<CodeBlock text={text} language={LANGUAGES[ext] ?? "text"} line={line} /></>;
}
