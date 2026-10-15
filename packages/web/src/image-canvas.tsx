import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronGlyph } from "./row-menu";

/** Previous/next arrows for a gallery, shown inside the canvas's control pill. */
export function ImageSteps({ index, count, step }: { index: number; count: number; step: (delta: number) => void }) {
  return <>
    <button type="button" aria-label="Previous image" disabled={index === 0} onClick={() => step(-1)}><ChevronGlyph className="image-step-back" /></button>
    <span className="image-position" role="status">{index + 1} / {count}</span>
    <button type="button" aria-label="Next image" disabled={index === count - 1} onClick={() => step(1)}><ChevronGlyph className="image-step-next" /></button>
  </>;
}

/** Shared image surface for files and inline images. Scale 1 means fit; 1:1 uses natural pixels. */
export function ImageCanvas({ src, name, close, children }: { src: string; name: string; close: () => void; children?: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ x: 0, y: 0, px: 0, py: 0, distance: 0, scale: 1, moved: false, pinch: false });
  const naturalScale = () => {
    const img = image.current;
    const width = img?.getBoundingClientRect().width ?? 0;
    return img?.naturalWidth && width > 0 ? Math.max(1, img.naturalWidth / (width / scale)) : 1;
  };
  const zoom = () => { setScale(scale === 1 ? naturalScale() : 1); setPan({ x: 0, y: 0 }); };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer or lost contact. */ }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    gesture.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, distance: points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0, scale, moved: false, pinch: points.length > 1 };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current, dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (Math.hypot(dx, dy) > 6) g.moved = true;
    const points = [...pointers.current.values()];
    if (points.length > 1 && g.distance) {
      setScale(Math.max(1, Math.min(Math.max(4, naturalScale()), g.scale * Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / g.distance)));
      setPan({ x: 0, y: 0 });
    } else if (scale > 1 && !g.pinch) {
      const img = image.current, box = surface.current;
      const maxX = img && box ? Math.max(0, (img.clientWidth * scale - box.clientWidth) / 2) : 0;
      const maxY = img && box ? Math.max(0, (img.clientHeight * scale - box.clientHeight) / 2) : 0;
      setPan({ x: Math.max(-maxX, Math.min(maxX, g.px + dx)), y: Math.max(-maxY, Math.min(maxY, g.py + dy)) });
    }
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (event.type === "pointercancel") return;
    if (!g.pinch && event.pointerType === "touch" && scale === 1 && event.clientY - g.y > 90 && Math.abs(event.clientX - g.x) < 70) close();
    else if (!g.moved && !g.pinch) zoom();
  };
  return <div className="image-viewer">
    <div ref={surface} className="image-surface" data-zoom={scale > 1 ? "actual" : "fit"} tabIndex={0} role="button" aria-label="Zoom image" title="Click to zoom · drag to pan"
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); zoom(); } }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {error ? <p role="alert">Image could not be loaded. Try Download.</p> : <img ref={image} className="file-image" src={src} alt={name} draggable={false}
        onError={() => setError(true)} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }} />}
    </div>
    {!error && <div className="image-controls">
      <div className="image-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-pressed={scale === 1} onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>Fit</button>
        <button type="button" aria-pressed={scale !== 1} onClick={() => { setScale(naturalScale()); setPan({ x: 0, y: 0 }); }}>1:1</button>
      </div>
      {children && <span className="image-controls-rule" aria-hidden="true" />}
      {children}
    </div>}
  </div>;
}
