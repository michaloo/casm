import { appShellWorker } from "./pwa-build";
import { defineConfig, loadEnv } from "vite";
// Both browser-history routes and a page reload resolve to the React entry point.
// Signed download links (/dl/...) are same-origin so a[download] names the file;
// the dev server forwards them to the casm server named by VITE_CASM_URL.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const casm = env.VITE_CASM_URL;
  // Extra host names the dev server answers to (comma-separated), e.g. the
  // machine's LAN or VPN name when you open the dev server from another device.
  const extraHosts = (env.VITE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const target = casm && new URL(casm.replace(/^ws/, "http")).origin;
  return {
    appType: "spa",
    plugins: [appShellWorker()],
    server: {
      allowedHosts: ["localhost", ".localhost", "127.0.0.1", "::1", ...extraHosts],
      ...(target ? { proxy: { "/dl": { target } } } : {}),
    },
  };
});
