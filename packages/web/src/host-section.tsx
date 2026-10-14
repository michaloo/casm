import { useId, useState, type ReactNode } from "react";

export function HostSection({ host, name, heading, children }: {
  host: string; name: string; heading: ReactNode; children: ReactNode;
}) {
  const storageKey = `casm.host.collapsed:${host}`;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "true"; } catch { return false; }
  });
  const id = useId();
  return <section className="host">
    <h2 className="host-heading">
      <button type="button" className="host-collapse" aria-label={`Toggle ${name} host`}
        aria-expanded={!collapsed} aria-controls={id} title={`${collapsed ? "Expand" : "Collapse"} ${name}`}
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          try { localStorage.setItem(storageKey, String(next)); } catch { /* Optional preference. */ }
        }}><span className="chevron" aria-hidden="true" /></button>
      {heading}
    </h2>
    <div id={id} hidden={collapsed}>{children}</div>
  </section>;
}
