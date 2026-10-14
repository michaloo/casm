// Vite development stays uncached. Plain HTTP on a remote host still works as
// an Apple Home Screen/Dock web app; service workers require a secure context.
if (import.meta.env.PROD && globalThis.isSecureContext && "serviceWorker" in navigator) {
  const register = () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(error => console.warn("App-shell offline support unavailable", error));
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
