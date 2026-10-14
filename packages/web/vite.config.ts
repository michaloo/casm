import { defineConfig } from "vite";
// Both browser-history routes and a page reload resolve to the React entry point.
export default defineConfig({
  appType: "spa",
  server: {
    allowedHosts: ["ubuntu", "localhost", ".localhost", "127.0.0.1", "::1", "100.68.62.102"],
  },
});
