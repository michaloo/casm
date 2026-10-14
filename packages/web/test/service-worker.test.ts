import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("service worker caches only the explicit shell and never intercepts data or credential URLs", async () => {
  const handlers = new Map<string, (event: any) => void>();
  const deleted: string[] = [];
  let added: string[] = [];
  let offline = false;
  let claimed = false;
  const source = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8")
    .replace("__CASM_VERSION__", "test-version").replace("__CASM_ASSETS__", JSON.stringify(["/index.html", "/assets/app.js"]));
  runInNewContext(source, {
    URL, Response, Set,
    Request: class { url: string; constructor(path: string, _options: unknown) { this.url = path; } },
    self: { location: { origin: "https://casm.test" }, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler), clients: { claim: async () => { claimed = true; } } },
    caches: {
      keys: async () => ["casm-shell-old", "casm-shell-test-version", "other-app"],
      delete: async (name: string) => { deleted.push(name); },
      open: async () => ({ addAll: async (requests: { url: string }[]) => { added = requests.map(request => request.url); }, match: async (path: string) => new Response(path === "/index.html" ? "shell" : "asset") }),
    },
    fetch: async () => { if (offline) throw new Error("offline"); return new Response("network"); },
  });
  for (const event of ["install", "activate"]) {
    let done: Promise<unknown> | undefined;
    handlers.get(event)!({ waitUntil: (promise: Promise<unknown>) => { done = promise; } });
    await done;
  }
  assert.deepEqual(Array.from(added), ["/index.html", "/assets/app.js"]);
  assert.deepEqual(deleted, ["casm-shell-old"]);
  assert.equal(claimed, true);
  const request = (path: string, mode = "cors", method = "GET") => {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: { url: new URL(path, "https://casm.test").href, mode, method }, respondWith: (promise: Promise<Response>) => { response = promise; } });
    return response;
  };
  for (const path of ["/health", "/api/messages", "/dl/signed-token", "/assets/unknown.js", "/?token=secret", "/assets/app.js?token=secret", "https://peer.test/assets/app.js"]) {
    assert.equal(request(path), undefined, path);
    assert.equal(request(path, "navigate"), undefined, path);
  }
  assert.equal(request("/assets/app.js", "cors", "POST"), undefined);
  assert.equal(await (await request("/assets/app.js"))!.text(), "asset");
  assert.equal(await (await request("/h/host/a/agent", "navigate"))!.text(), "network");
  offline = true;
  for (const path of ["/", "/h/host/a/agent", "/f/project/README.md"]) assert.equal(await (await request(path, "navigate"))!.text(), "shell");
});
