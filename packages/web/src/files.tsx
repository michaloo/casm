// Read-only project files: a preview dialog (with Download and Copy path) and
// a directory browser. Downloads use short-lived signed links from the server
// the page is connected to, so they work for peers' files and on iPhone Safari.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { FileContent, Result } from "@casm/protocol";
import { serverURL, type Rpc } from "./state";
import { CodeBlock, Prose, copy } from "./transcript";
import { FileLinksContext, insideRoot } from "./file-links";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", py: "python", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml",
};
const extension = (name: string) => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
const parentOf = (path: string) => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
const childOf = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
const formatTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type Link = { href: string; expires: number };
async function signedLink(rpc: Rpc, host: string, path: string, inline = false): Promise<Link> {
  const r = await rpc.call("fs.downloadLink", { path, inline }, host);
  return { href: new URL(r.url, serverURL()).href, expires: Date.parse(r.expiresAt) };
}

export function FilePreview({ rpc, host, path: initial, roots, close }: {
  rpc: Rpc; host: string; path: string; roots: string[]; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [trail, setTrail] = useState([initial]);
  const path = trail[trail.length - 1];
  const [file, setFile] = useState<FileContent>();
  const [error, setError] = useState("");
  const [download, setDownload] = useState<Link>();
  const [image, setImage] = useState<string>();
  const [copied, setCopied] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setFile(undefined); setError(""); setDownload(undefined); setImage(undefined);
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
  }, [rpc, host, path]);
  const go = (next: string) => setTrail((t) => [...t, next]);
  // Opening a link inside the preview moves the preview there.
  const links = useMemo(() => ({ roots, open: go }), [roots]);
  // Links last a few minutes; an old one is replaced before it is followed.
  const fresh = (e: MouseEvent<HTMLAnchorElement>) => {
    if (download && download.expires - Date.now() > 30_000) return;
    e.preventDefault();
    void signedLink(rpc, host, path).then((link) => { setDownload(link); location.assign(link.href); }).catch((err) => setError(message(err)));
  };
  const name = baseName(path);
  return createPortal(<dialog ref={dialog} className="host-settings file-preview" aria-label={`File ${name}`}
    // React passes "close" up through portals: it must not also close a settings dialog this one opened from.
    onClose={(e) => { e.stopPropagation(); close(); }}>
    <header>
      <h2 title={path}>{name}</h2>
      <button type="button" aria-label="Close file preview" onClick={() => dialog.current?.close()}>×</button>
    </header>
    <div className="file-preview-bar">
      <code className="settings-path">{path}</code>
      {file && <small className="file-meta">{file.type === "dir" ? "Folder" : `${formatSize(file.size)} · ${file.mime}`} · modified {formatTime(file.mtime)}</small>}
      <div className="settings-actions">
        {trail.length > 1 && <button type="button" onClick={() => setTrail((t) => t.slice(0, -1))}>Back</button>}
        {file?.type === "file" && (download
          ? <a className="button" href={download.href} download={name} onClick={fresh}>Download</a>
          : <button type="button" disabled>Download</button>)}
        <button type="button" onClick={() => void copy(path).then(() => setCopied("Copied ✓"), () => setCopied("Select to copy"))
          .finally(() => setTimeout(() => setCopied(""), 1800))}>{copied || "Copy path"}</button>
      </div>
    </div>
    <div className="settings-content file-preview-body">
      {error && <p role="alert" className="error">{error}</p>}
      {!file && !error && <p role="status">Loading…</p>}
      {file && <FileLinksContext.Provider value={links}>
        <FileBody file={file} image={image} rpc={rpc} host={host} roots={roots} open={go} />
      </FileLinksContext.Provider>}
    </div>
  </dialog>, document.body);
}

function FileBody({ file, image, rpc, host, roots, open }: {
  file: FileContent; image?: string; rpc: Rpc; host: string; roots: string[]; open: (path: string) => void;
}) {
  const ext = extension(file.path);
  if (file.type === "dir") {
    const root = roots.filter((r) => insideRoot(file.path, [r])).sort((a, b) => b.length - a.length)[0] ?? file.path;
    return <FileBrowser rpc={rpc} host={host} root={root} dir={file.path} setDir={open} openFile={open} />;
  }
  if (file.type !== "file") return <p>This is not a regular file, so there is nothing to preview.</p>;
  const truncated = file.truncated && <p role="note" className="file-note">Showing the first 1 MB of {formatSize(file.size)}. Download the file to see all of it.</p>;
  if (file.mime.startsWith("image/"))
    return image ? <img className="file-image" src={image} alt={baseName(file.path)} /> : <p role="status">Loading image…</p>;
  if (file.content === null)
    return <p className="file-note">{file.binary ? "Binary file" : "No preview"} · {formatSize(file.size)} · {file.mime}. Use Download to open it on this device.</p>;
  if (!file.content) return <p className="file-note">This file is empty.</p>;
  if (file.mime === "text/markdown") return <>{truncated}<Prose text={file.content} /></>;
  let text = file.content;
  if (ext === "json" && !file.truncated) {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  return <>{truncated}<CodeBlock text={text} language={LANGUAGES[ext] ?? "text"} /></>;
}

// One folder of a project: breadcrumbs from the project root, then folders and files.
export function FileBrowser({ rpc, host, root, dir, setDir, openFile }: {
  rpc: Rpc; host: string; root: string; dir: string; setDir: (dir: string) => void; openFile: (path: string) => void;
}) {
  const [listing, setListing] = useState<Result<"fs.list">>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    void rpc.call("fs.list", { path: dir }, host).then((r) => { if (active) setListing(r); }).catch((e) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [rpc, host, dir]);
  const base = root.replace(/\/+$/, "");
  const crumbs = [base, ...dir.slice(base.length).split("/").filter(Boolean)];
  const shown = listing?.dir === dir ? listing : undefined;
  return <div className="file-browser">
    <nav className="file-crumbs" aria-label="Folder path">
      {crumbs.map((part, i) => {
        const target = i === 0 ? base : `${base}/${crumbs.slice(1, i + 1).join("/")}`;
        const current = i === crumbs.length - 1;
        return <span key={target}>
          {i > 0 && <span aria-hidden="true">/</span>}
          <button type="button" aria-current={current ? "location" : undefined} disabled={current} onClick={() => setDir(target)}>{i === 0 ? baseName(base) : part}</button>
        </span>;
      })}
    </nav>
    {error && <p role="alert" className="error">{error}</p>}
    {!shown && !error && <p role="status">Loading files…</p>}
    {shown?.entries.length === 0 && <p className="file-note">This folder is empty.</p>}
    {shown && <ul className="file-list" aria-label={`Files in ${baseName(dir)}`}>
      {dir !== base && <li><button type="button" onClick={() => setDir(parentOf(dir))}><span className="file-name">..</span><small>Parent folder</small></button></li>}
      {shown.entries.map((e) => <li key={e.name} className={e.hidden ? "hidden-file" : undefined}>
        <button type="button" onClick={() => (e.type === "dir" ? setDir : openFile)(childOf(dir, e.name))}>
          <span className="file-name">{e.name}{e.type === "dir" ? "/" : ""}{e.symlink && <span className="file-badge">link</span>}{e.hidden && <span className="file-badge">hidden</span>}</span>
          <small>{e.type === "file" ? `${formatSize(e.size)} · ` : ""}{formatTime(e.mtime)}</small>
        </button>
      </li>)}
    </ul>}
  </div>;
}
