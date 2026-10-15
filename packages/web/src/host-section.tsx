import { useId, useState, type ReactNode } from "react";
import { ChevronGlyph } from "./row-menu";

/** A foldable host, drawn as a section header: icon, name and the chevron (drawn at the row's far right) fold it; status lives in its tooltip and description; `menu` sits before the chevron. */
export function HostSection({ host, name, identity, status, menu, children }: {
  host: string; name: string; identity: ReactNode; status: string; menu: ReactNode; children: ReactNode;
}) {
  const storageKey = `casm.host.collapsed:${host}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "true"; } catch { return false; }
  });
  const id = useId();
  return <section className="host">
    <h2 className="host-heading">
      <button type="button" className="host-collapse" aria-label={`Toggle ${name} host`} aria-description={status}
        aria-expanded={!collapsed} aria-controls={id} title={`${name} · ${status}`}
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          try { localStorage.setItem(storageKey, String(next)); } catch { /* Optional preference. */ }
        }}>{identity}<span className="fold-mark"><ChevronGlyph /></span></button>
      {menu}
    </h2>
    <div id={id} hidden={collapsed}>{children}</div>
  </section>;
}
