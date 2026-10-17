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
  const [info, setInfo] = useState(false);
  const [view, setView] = useState<"rendered" | "source">("rendered");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    // Focus the dialog itself: Escape and Tab work, and no button opens highlighted.
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setFile(undefined); setError(""); setDownload(undefined); setImage(undefined); setView("rendered");
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
  const html = !!file && isHtmlPage(file) && !source;
  const navigate = (delta: number) => setIndex(i => Math.max(0, Math.min((images?.length ?? 1) - 1, i + delta)));
  return createPortal(<dialog ref={dialog} tabIndex={-1} className="host-settings file-preview" aria-label={`File ${name}`}
    onKeyDown={event => { if (images && !/INPUT|TEXTAREA/.test((event.target as HTMLElement).tagName) && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); navigate(event.key === "ArrowLeft" ? -1 : 1); } }}
    // React passes "close" up through portals: it must not also close a settings dialog this one opened from.
    onClose={(e) => { e.stopPropagation(); close(); }}>
    <header className="file-preview-head">
      {trail.length > 1 && <button type="button" className="file-icon" aria-label="Back" title="Back" onClick={() => setTrail((t) => t.slice(0, -1))}><Glyph d="M10 3 5 8l5 5" /></button>}
      <h2 title={path || name} onClick={() => setInfo(v => !v)}>{name}</h2>
      {!memory && <button type="button" className="file-icon file-info-toggle" aria-label="File details" title="File details" aria-expanded={info} onClick={() => setInfo(v => !v)}>
        <Glyph d="M8 7.2v4M8 4.8v.1" circle /></button>}
      <div className="file-head-actions">
        {html && <div className="file-view-toggle" role="group" aria-label="HTML view">
          {(["rendered", "source"] as const).map(v => <button key={v} type="button" className="file-icon" aria-pressed={view === v} aria-label={v === "rendered" ? "Rendered" : "Source"}
            title={v === "rendered" ? "Rendered page" : "Source"} onClick={() => setView(v)}><Glyph d={v === "rendered" ? PLAY : CODE} /><span>{v === "rendered" ? "Rendered" : "Source"}</span></button>)}
        </div>}
        {memory && <a className="button file-icon" href={memory.src} download={name} aria-label="Download" title="Download"><Glyph d={DOWNLOAD} /><span>Download</span></a>}
        {file?.type === "file" && (download
          ? <a className="button file-icon" href={download.href} download={name} onClick={fresh} aria-label="Download" title="Download"><Glyph d={DOWNLOAD} /><span>Download</span></a>
          : <button type="button" className="file-icon" disabled aria-label="Download" title="Download"><Glyph d={DOWNLOAD} /><span>Download</span></button>)}
        {!memory && <button type="button" className="file-icon" aria-label={copied || "Copy path"} title={copied || "Copy path"} onClick={() => void copy(path).then(() => setCopied("Copied ✓"), () => setCopied("Select to copy"))
          .finally(() => setTimeout(() => setCopied(""), 1800))}><Glyph d={copied === "Copied ✓" ? "m3 8.5 3.2 3.2L13 4.8" : COPY} /><span>{copied || "Copy path"}</span></button>}
        {source && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write && <button type="button" className="file-icon" aria-label={copied || "Copy image"} title={copied || "Copy image"} onClick={() => {
          const blob = clipboardPng(source);
          void navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => setCopied("Image copied ✓"), err => setError(message(err)));
        }}><Glyph d={copied === "Image copied ✓" ? "m3 8.5 3.2 3.2L13 4.8" : COPY} /><span>{copied || "Copy image"}</span></button>}
      </div>
      <button type="button" aria-label="Close file preview" onClick={() => dialog.current?.close()}>×</button>
    </header>
    {!memory && <div className="file-preview-bar" data-open={info}>
      <code className="settings-path" title={path}>{path}</code>
      {file && <small className="file-meta">{file.type === "dir" ? "Folder" : `${formatSize(file.size)} · ${file.mime}`} · modified {formatTime(file.mtime)}</small>}
    </div>}
    <div className={`settings-content file-preview-body${source ? " has-image" : ""}${html && view === "rendered" ? " bleed" : ""}`}>
      {error && <p role="alert" className="error">{error}</p>}
      {!memory && !file && !error && <p role="status">Loading…</p>}
      {source && <ImageCanvas key={`${index}:${path || name}`} src={source} name={name} close={() => dialog.current?.close()}>
        {images && images.length > 1 && <ImageSteps index={index} count={images.length} step={navigate} />}
      </ImageCanvas>}
      {!source && file && <FileLinksContext.Provider value={links}>
        <FileBody file={file} line={line} view={view} />
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

function HtmlView({ html, line, view }: { html: string; line?: number; view: "rendered" | "source" }) {
  const doc = useMemo(() => /<head[\s>]/i.test(html) ? html : `<meta charset="utf-8">${html}`, [html]);
  const assets = RELATIVE_ASSET.test(html);
  return view === "rendered" ? <>
    <iframe className="file-html-frame" title="Rendered HTML" sandbox={HTML_SANDBOX} referrerPolicy="no-referrer" srcDoc={doc} />
    {assets && <p className="file-note muted">This page refers to files next to it (images, styles, scripts). Only the HTML file itself is shown, so those won't load.</p>}
  </> : <CodeBlock text={html} language="html" line={line} />;
}

const isHtmlPage = (file: FileContent) => file.type === "file" && !!file.content && /^html?$/.test(extension(file.path)) && !file.truncated;
const DOWNLOAD = "M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13h10";
const COPY = "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7";
const PLAY = "M5.5 3.8v8.4L12.5 8z";
const CODE = "M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5M9 3.5 7 12.5";
function Glyph({ d, circle }: { d: string; circle?: boolean }) {
  return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {circle && <circle cx="8" cy="8" r="6.2" />}<path d={d} /></svg>;
}

function FileBody({ file, line, view }: { file: FileContent; line?: number; view: "rendered" | "source" }) {
  const ext = extension(file.path);
  if (file.type === "dir") return <p className="file-note">This is a folder. Open a file inside it from the transcript to preview or download it.</p>;
  if (file.type !== "file") return <p>This is not a regular file, so there is nothing to preview.</p>;
  const truncated = file.truncated && <p role="note" className="file-note">Showing the first 1 MB of {formatSize(file.size)}. Download the file to see all of it.</p>;
  if (file.mime.startsWith("image/"))
    return <p role="status">Loading image…</p>;
  if (file.content === null)
    return <p className="file-note">{file.binary ? "Binary file" : "No preview"} · {formatSize(file.size)} · {file.mime}. Use Download to open it on this device.</p>;
  if (!file.content) return <p className="file-note">This file is empty.</p>;
  if (isHtmlPage(file)) return <HtmlView html={file.content} line={line} view={view} />;
  if (file.mime === "text/markdown") return <>{truncated}<Prose text={file.content} /></>;
  let text = file.content;
  if (ext === "json" && !file.truncated) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  return <>{truncated}<CodeBlock text={text} language={LANGUAGES[ext] ?? "text"} line={line} /></>;
}
