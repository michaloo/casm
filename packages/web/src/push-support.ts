// Whether this browser can get casm's Web Push notifications, and why not.
export type PushSupport =
  | { ok: true }
  | { ok: false; reason: "insecure" | "ios-not-installed" | "unsupported" | "no-worker" };

export type PushEnv = {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  userAgent: string;
  // Installed: a Home Screen or Dock web app.
  standalone: boolean;
  touchPoints: number;
};

export function pushEnv(): PushEnv {
  return {
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    userAgent: navigator.userAgent,
    standalone: matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true,
    touchPoints: navigator.maxTouchPoints,
  };
}

// iPadOS reports itself as a Mac; touch tells them apart.
const ios = (e: PushEnv) => /iPhone|iPad|iPod/.test(e.userAgent) || (/Macintosh/.test(e.userAgent) && e.touchPoints > 1);

export function pushSupport(e: PushEnv): PushSupport {
  if (!e.secure) return { ok: false, reason: "insecure" };
  // iOS offers Web Push only to web apps added to the Home Screen.
  if (ios(e) && !e.standalone) return { ok: false, reason: "ios-not-installed" };
  if (!e.serviceWorker || !e.pushManager || !e.notification) return { ok: false, reason: "unsupported" };
  return { ok: true };
}

export const unsupportedText: Record<Exclude<PushSupport, { ok: true }>["reason"], string> = {
  insecure: "Unavailable over plain HTTP: browsers allow notifications only on HTTPS (or localhost). Serve casm over HTTPS, e.g. with tailscale serve.",
  "ios-not-installed": "On iPhone and iPad, notifications need casm on the Home Screen: tap Share, then Add to Home Screen, open casm from there and enable them here.",
  unsupported: "This browser doesn't support Web Push notifications.",
  "no-worker": "The app's service worker isn't running yet. Reload the page, then try again.",
};

// A name for the device list, e.g. "iPhone · Home Screen app" or "Mac · Chrome".
export function deviceLabel(e: PushEnv): string {
  const ua = e.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && e.touchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux|CrOS/.test(ua) ? "Linux" : "Browser";
  if (ios(e)) return `${device} · ${e.standalone ? "Home Screen app" : "Safari"}`;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [device, [browser, e.standalone ? "app" : ""].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

// The applicationServerKey PushManager wants, from the server's base64url key.
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}
