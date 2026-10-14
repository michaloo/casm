import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "./host-usage";

/** The ⋯ glyph shared by every sidebar row that has a menu. */
export function MoreGlyph() {
  return <svg className="more-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="12.5" cy="8" r="1.4" />
  </svg>;
}

/** Arrow, Home and End keys between the enabled menu items of a panel. */
export function menuKeys(panel: RefObject<HTMLElement | null>) {
  return (e: KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };
}

export const focusFirstItem = (panel: RefObject<HTMLElement | null>) =>
  requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled), .host-panel-back")?.focus());

export type RowMenuItem = { label: string; hint?: string; disabled?: boolean; onSelect: () => void };

/** A ⋯ button with a small keyboard menu, for project rows (the host row adds sub-views; see HostMenu). */
export function RowMenu({ label, title, heading, items, triggerRef }: {
  label: string; title: string; heading: ReactNode; items: RowMenuItem[]; triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const own = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? own;
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useAnchoredPosition(open, trigger, panel);
  return <>
    <button ref={trigger} type="button" className="row-more" popoverTarget={id} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title}>
      <MoreGlyph />
    </button>
    {createPortal(<div ref={panel} id={id} popover="auto" className="host-panel" data-view="menu" role="menu" aria-label={label} onKeyDown={menuKeys(panel)}
      onToggle={(event) => {
        const isOpen = event.currentTarget.matches(":popover-open");
        setOpen(isOpen);
        if (isOpen) focusFirstItem(panel);
      }}>
      <div className="host-panel-heading" role="presentation">{heading}</div>
      {items.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
        onClick={() => { panel.current?.hidePopover(); item.onSelect(); }}>
        <span>{item.label}</span>{item.hint && <small>{item.hint}</small>}
      </button>)}
    </div>, document.body)}
  </>;
}
