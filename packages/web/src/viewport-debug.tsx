// Temporary: viewport measurements for an installed iPhone app, where the test
// browsers can't reproduce the layout. Tap the connection status to toggle.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

function measure(): string {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const inset = getComputedStyle(probe);
  const safe = [inset.paddingTop, inset.paddingRight, inset.paddingBottom, inset.paddingLeft].map((v) => parseFloat(v)).join(" ");
  probe.remove();
  const vv = window.visualViewport;
  const app = document.querySelector(".app")?.getBoundingClientRect();
  const nav = navigator as Navigator & { standalone?: boolean };
  return [
    `inner ${innerWidth}x${innerHeight}  outer ${outerWidth}x${outerHeight}`,
    `screen ${screen.width}x${screen.height}  dpr ${devicePixelRatio}`,
    `visualViewport ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}` : "none"}`,
    `docEl client ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
    `body ${document.body.clientHeight}  .app ${app ? `${Math.round(app.top)}..${Math.round(app.bottom)}` : "none"}`,
    `safe-area t r b l: ${safe}`,
    `standalone mq ${matchMedia("(display-mode: standalone)").matches}  navigator ${nav.standalone}`,
    `keyboard attr ${document.documentElement.dataset.keyboard ?? "-"}  scrollY ${Math.round(scrollY)}  --vt ${document.documentElement.style.getPropertyValue("--viewport-top")} --vh ${document.documentElement.style.getPropertyValue("--viewport-height")}`,
    `header ${(() => { const h = document.querySelector(".app header, main header")?.getBoundingClientRect(); return h ? `${Math.round(h.top)}..${Math.round(h.bottom)}` : "none"; })()}  composer ${(() => { const c = document.querySelector(".composer")?.getBoundingClientRect(); return c ? `${Math.round(c.top)}..${Math.round(c.bottom)}` : "none"; })()}`,
    `ua ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 90)}`,
  ].join("\n");
}

export function ViewportDebug({ close }: { close: () => void }) {
  const [text, setText] = useState(measure);
  useEffect(() => {
    const update = () => setText(measure());
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    const timer = setInterval(update, 1000);
    return () => { window.removeEventListener("resize", update); window.visualViewport?.removeEventListener("resize", update); clearInterval(timer); };
  }, []);
  return createPortal(<pre className="viewport-debug" onClick={close} role="status">{text}</pre>, document.body);
}
