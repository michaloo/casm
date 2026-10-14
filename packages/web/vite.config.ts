import { appShellWorker } from "./pwa-build";
import { defineConfig, loadEnv } from "vite";
// Both browser-history routes and a page reload resolve to the React entry point.
// Signed download links (/dl/...) are same-origin so a[download] names the file;
// the dev server forwards them to the casm server named by VITE_CASM_URL.
export default defineConfig(({ mode }) => {
  const casm = loadEnv(mode, process.cwd(), "VITE_").VITE_CASM_URL;
  const target = casm && new URL(casm.replace(/^ws/, "http")).origin;
  return {
    appType: "spa",
    plugins: [appShellWorker()],
    server: {
      allowedHosts: ["ubuntu", "localhost", ".localhost", "127.0.0.1", "::1", "100.68.62.102"],
      ...(target ? { proxy: { "/dl": { target } } } : {}),
    },
  };
});
