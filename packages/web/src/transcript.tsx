import {
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import Markdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { userLineBreaks } from "./user-line-breaks";
import type { ImageData, Item } from "@casm/protocol";
import { messageAuthor } from "./message-author";
import { FileLinksContext, MarkdownLink, linkifyHtml, linkifyText, openFromClick, remarkFilePaths } from "./file-links";
const aliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  html: "xml",
  svg: "xml",
  py: "python",
};
export async function copy(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;opacity:0;left:0;top:0";
  const active = document.activeElement as HTMLElement | null;
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
  }
}
export function CodeBlock({
  text,
  language = "text",
  truncate = false,
  expansion,
  expansionKey,
}: {
  text: string;
  language?: string;
  truncate?: boolean;
  expansion?: Record<string, boolean>;
  expansionKey?: string;
}) {
  const [expanded, setExpanded] = useState(
    expansionKey ? (expansion?.[expansionKey] ?? false) : false,
  );
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const long = truncate && text.length > 5000;
  const visible = long && !expanded ? text.slice(0, 5000) : text;
  const lang = aliases[language] ?? language;
  const links = useContext(FileLinksContext);
  const [highlighted, setHighlighted] = useState<{ text: string; language: string; html: string } | null>(null);
  useEffect(() => {
    setHighlighted(null);
    if (["diff", "text", "plaintext"].includes(lang) || visible.length >= 40000) return;
    let active = true;
    void import("./highlight")
      .then((m) => {
        const html = m.highlight(visible, lang);
        if (active && html !== null) setHighlighted({ text: visible, language: lang, html });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, lang]);
  useEffect(() => {
    if (!copied && !copyFailed) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 1800);
    return () => clearTimeout(timer);
  }, [copied, copyFailed]);
  return (
    <div className={`code-block ${lang === "diff" ? "diff" : ""}`}>
      <div className="code-toolbar">
        <span>{language}</span>
        <button
          type="button"
          aria-label={`Copy ${language} code`}
          onClick={() =>
            void copy(text)
              .then(() => setCopied(true))
              .catch(() => setCopyFailed(true))
          }
        >
          {copied ? "Copied ✓" : copyFailed ? "Select to copy" : "Copy"}
        </button>
      </div>
      <pre onClick={links ? (e) => openFromClick(e, links) : undefined}>
        <code>
          {lang === "diff" ? (
            visible.split("\n").map((line, i) => (
              <span
                className={`diff-line ${line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""}`}
                key={i}
              >
                {line || " "}
              </span>
            ))
          ) : highlighted?.text === visible && highlighted.language === lang ? (
            <span dangerouslySetInnerHTML={{ __html: links ? linkifyHtml(highlighted.html, links.roots) : highlighted.html }} />
          ) : links ? (
            linkifyText(visible, links.roots)
          ) : (
            visible
          )}
        </code>
      </pre>
      {long && (
        <button
          type="button"
          className="show-more"
          aria-expanded={expanded}
          onClick={() => {
            if (expansion && expansionKey) expansion[expansionKey] = !expanded;
            setExpanded(!expanded);
          }}
        >
          {expanded
            ? "Show less"
            : `Show more · ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}
const components = {
  pre({ children }: { children?: ReactNode }) {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(
      children,
    )
      ? children.props
      : undefined;
    const text = String(code?.children ?? "").replace(/\n$/, "");
    const language =
      /language-([\w+-]+)/.exec(code?.className ?? "")?.[1] ?? "text";
    return <CodeBlock text={text} language={language} />;
  },
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    return <img loading="lazy" src={src} alt={alt ?? ""} />;
  },
  a: MarkdownLink,
};
export const Prose = memo(function Prose({ text, preserveLineBreaks = false }: { text: string; preserveLineBreaks?: boolean }) {
  const roots = useContext(FileLinksContext)?.roots;
  const plugins = useMemo((): Options["remarkPlugins"] => [
    remarkGfm,
    ...(preserveLineBreaks ? [userLineBreaks] : []),
    ...(roots?.length ? [[remarkFilePaths, { roots }] as [typeof remarkFilePaths, { roots: string[] }]] : []),
  ], [preserveLineBreaks, roots]);
  return (
    <div className="prose">
      <Markdown remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
function shortInput(input: unknown) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const fields = input as Record<string, unknown>;
    for (const key of [
      "command",
      "file_path",
      "path",
      "query",
      "pattern",
      "url",
      "description",
    ])
      if (typeof fields[key] === "string") return fields[key] as string;
  }
  return input ? JSON.stringify(input) : "";
}
export type ToolTime = { start: number; end?: number };
// The toggle event fires a task after the click. A row that Virtuoso unmounts
// in between would never record it and would remount collapsed, so record the
// new state as soon as the summary is clicked.
function rememberToggle(id: string, expansion: Record<string, boolean>) {
  return (e: MouseEvent<HTMLDetailsElement>) => {
    const summary = (e.target as Element).closest("summary");
    if (summary?.parentElement === e.currentTarget)
      expansion[id] = !e.currentTarget.open;
  };
}
function ToolRow({
  item,
  time,
  expansion,
}: {
  item: Extract<Item, { kind: "tool" }>;
  time?: ToolTime;
  expansion: Record<string, boolean>;
}) {
  const [open, setOpen] = useState(expansion[item.id] ?? false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!time || time.end) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [time?.start, time?.end]);
  const elapsed = time
    ? Math.max(0, ((time.end ?? Date.now()) - time.start) / 1000)
    : undefined;
  const summary = shortInput(item.input);
  const output = item.output ?? "";
  const diff = /^(diff --git|@@|--- )/m.test(output);
  return (
    <div className="item tool">
      <details
        open={open}
        onClick={rememberToggle(item.id, expansion)}
        onToggle={(e) => {
          expansion[item.id] = e.currentTarget.open;
          setOpen(e.currentTarget.open);
        }}
      >
        <summary>
          <span className="tool-icon" aria-hidden="true">
            ⌘
          </span>
          <strong>{item.name}</strong>
          <span className="tool-argument" title={summary}>
            {summary}
          </span>
          <span className={`status ${item.status}`}>
            {item.status === "done"
              ? "Done"
              : item.status === "error"
                ? "Failed"
                : "Running"}
          </span>
          {elapsed !== undefined && (
            <time title="Elapsed since this client observed the tool start">
              {elapsed.toFixed(elapsed < 10 ? 1 : 0)}s
            </time>
          )}
        </summary>
        {open && (
          <div className="tool-body">
            <CodeBlock
              text={JSON.stringify(item.input, null, 2) ?? ""}
              language="json"
              expansion={expansion}
              expansionKey={`${item.id}:input`}
              truncate
            />
            {output ? (
              <CodeBlock
                text={output}
                expansion={expansion}
                expansionKey={`${item.id}:output`}
                language={
                  diff ? "diff" : /^\s*[\[{]/.test(output) ? "json" : "text"
                }
                truncate
              />
            ) : !item.images?.length ? (
              <p className="muted">
                {item.status === "running"
                  ? "Waiting for output…"
                  : "No output"}
              </p>
            ) : null}
            {item.images?.length ? <Images images={item.images} /> : null}
          </div>
        )}
      </details>
    </div>
  );
}
function Disclosure({
  id,
  expansion,
  children,
}: {
  id: string;
  expansion: Record<string, boolean>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(expansion[id] ?? false);
  return (
    <details
      open={open}
      onClick={rememberToggle(id, expansion)}
      onToggle={(e) => {
        expansion[id] = e.currentTarget.open;
        setOpen(e.currentTarget.open);
      }}
    >
      {children}
    </details>
  );
}
export function Row({
  item,
  time,
  expansion,
}: {
  item: Item;
  time?: ToolTime;
  expansion: Record<string, boolean>;
}) {
  if (item.kind === "tool")
    return <ToolRow item={item} time={time} expansion={expansion} />;
  if (item.kind === "reasoning")
    return (
      <div className="item thinking">
        <Disclosure id={item.id} expansion={expansion}>
          <summary>
            <span aria-hidden="true">◌</span> Thinking
          </summary>
          <Prose text={item.text} />
        </Disclosure>
      </div>
    );
  if (item.kind === "subagent")
    return (
      <div className="item subagent">
        <Disclosure id={item.id} expansion={expansion}>
          <summary>
            <span className="subagent-icon" aria-hidden="true">
              ↗
            </span>
            <span className="row-kind">Subagent</span>
            <strong title={item.title}>{item.title}</strong>
            <span className={`status ${item.status}`}>{item.status}</span>
          </summary>
          <p className="muted">{item.activity}</p>
          <Prose text={item.summary ?? ""} />
        </Disclosure>
      </div>
    );
  if (item.kind === "plan")
    return (
      <div className="item plan">
        <small>Plan</small>
        {item.entries.map((e, i) => (
          <p key={i} className={`plan-${e.status}`}>
            <span aria-hidden="true">
              {e.status === "completed"
                ? "✓"
                : e.status === "in_progress"
                  ? "◉"
                  : "○"}
            </span>
            {e.text}
          </p>
        ))}
      </div>
    );
  if (item.kind === "notice")
    return (
      <div className={`item notice ${item.level ?? "info"}`}>
        <span className="notice-icon" aria-hidden="true">
          {item.level === "error" ? "!" : item.level === "warning" ? "△" : "i"}
        </span>
        <Prose text={item.text} />
      </div>
    );
  return (
    <article className={`item ${item.kind}`}>
      <div className="message-content">
        <small className="message-role">
          {item.kind === "user" ? (
            <span className="message-sender">{messageAuthor(item)}</span>
          ) : (
            <>
              <span className="mini-glyph" aria-hidden="true" />
              Assistant
            </>
          )}
        </small>
        <Prose text={item.text} preserveLineBreaks={item.kind === "user"} />
        {item.kind === "user" && item.images?.length ? (
          <Images images={item.images} />
        ) : null}
      </div>
    </article>
  );
}

// Inline only: never turn provider filesystem paths into browser URLs.
export function Images({ images, remove }: { images: ImageData[]; remove?: (index: number) => void }) {
  return <div className="image-attachments">
    {images.map((image, index) => <div key={index}>
      {image.data && /^image\/(png|jpeg|gif|webp|avif)$/i.test(image.mediaType) && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
        ? <img src={`data:${image.mediaType};base64,${image.data}`} alt={`Attached image ${index + 1}`} />
        : <small>Attached image {index + 1} · preview unavailable</small>}
      {remove && <button type="button" aria-label={`Remove image ${index + 1}`} onClick={() => remove(index)}>Remove</button>}
    </div>)}
  </div>;
}
