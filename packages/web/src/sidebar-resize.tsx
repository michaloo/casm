import { useEffect, useRef, useState } from "react";
import "./sidebar-resize.css";

const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const WIDTH_KEY = "casm.sidebar.width";
const maxWidth = () => Math.max(MIN_WIDTH, Math.min(560, Math.floor(window.innerWidth * 0.55)));
const clamp = (width: number, max: number) => Math.min(max, Math.max(MIN_WIDTH, width));

export function useSidebarWidth() {
  const [preferred, setPreferred] = useState(() => {
    try {
      const width = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(width) && width >= MIN_WIDTH) return width;
    } catch { /* Optional preference. */ }
    return DEFAULT_WIDTH;
  });
  const [max, setMax] = useState(maxWidth);
  useEffect(() => {
    const resize = () => setMax(maxWidth());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return { width: clamp(preferred, max), max, setPreferred };
}

export function SidebarResize({ width, max, setPreferred }: ReturnType<typeof useSidebarWidth>) {
  const drag = useRef<{ id: number; x: number; width: number }>(null);
  const change = (want: number) => {
    const next = clamp(want, max);
    setPreferred(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* Optional preference. */ }
  };
  return <div className="sidebar-resize" role="separator" tabIndex={0}
    aria-label="Resize conversation sidebar" aria-controls="conversation-sidebar" aria-orientation="vertical"
    aria-valuemin={MIN_WIDTH} aria-valuemax={max} aria-valuenow={width}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.id === event.pointerId) change(start.width + event.clientX - start.x);
    }}
    onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) drag.current = null; }}
    onDoubleClick={() => change(DEFAULT_WIDTH)}
    onKeyDown={event => {
      const direction = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
      const next = event.key === "Home" ? MIN_WIDTH : event.key === "End" ? max : width + (direction ?? 0);
      if (next === width && !direction) return;
      event.preventDefault();
      change(next);
    }} />;
}
