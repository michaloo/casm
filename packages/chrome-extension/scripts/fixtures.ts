// Test pages for the extension: a login form, same- and cross-origin
// iframes, dialogs, a file input, a download and a popup. Used by e2e.ts, and
// served on their own for trying the extension by hand:
//
//   node packages/chrome-extension/scripts/fixtures.ts [port]   (default 7499, loopback)
//
// 127.0.0.1 and localhost are different sites, so each page's "other" origin
// (the one it isn't served from) puts the cross-origin iframe in another process.
import { createServer, type Server } from "node:http";

const pages: Record<string, (other: string) => string> = {
  "/": () => `<!doctype html><title>Test login</title>
<h1>Sign in</h1>
<label>Email <input id="email" name="email"></label>
<button onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('email').value">Continue</button>
<p id="out">waiting</p>`,
  "/next": () => "<title>Next</title><h1>Next page</h1>",
  "/frames": (other) => `<!doctype html><title>Frames</title><h1>Outer</h1>
<iframe title="same" src="/inner?who=Same" width="400" height="90"></iframe>
<div style="height: 30px"></div>
<iframe title="cross" src="${other}/inner?who=Cross" width="400" height="90"></iframe>`,
  "/inner": () => `<!doctype html><button onclick="this.textContent = this.textContent + ' clicked'"></button><input aria-label="Field">
<script>document.querySelector("button").textContent = new URLSearchParams(location.search).get("who") + " button"</script>`,
  "/tools": () => `<!doctype html><title>Tools</title>
<button onclick="document.getElementById('said').textContent = confirm('Leave?') ? 'yes' : 'no'">Ask</button>
<button onclick="document.getElementById('said').textContent = prompt('Name?', 'anon')">Name</button>
<p id="said">-</p>
<label>Attachment <input type="file" id="file" onchange="this.files[0].text().then((t) => document.getElementById('got').textContent = this.files[0].name + ': ' + t)"></label>
<p id="got">-</p>
<a href="/report.txt">Get the report</a>
<button onclick="window.open('/next', 'login', 'popup,width=400,height=300')">Sign in with popup</button>
<p><a href="/next?blank" target="_blank">Blank link</a> <a id="plain" href="/next?plain">Plain link</a></p>`,
};
export async function startFixtures(port: number, host = "127.0.0.1"): Promise<Server> {
  const web = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/report.txt")
      return void res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=report.txt" }).end("quarterly numbers");
    const other = `http://${req.headers.host?.startsWith("localhost") ? "127.0.0.1" : "localhost"}:${(web.address() as { port: number }).port}`;
    res.writeHead(200, { "content-type": "text/html" }).end((pages[url.pathname] ?? pages["/"])(other));
  });
  await new Promise<void>((r) => web.listen(port, host, r));
  return web;
}

if (import.meta.main) {
  const web = await startFixtures(Number(process.argv[2] ?? 7499));
  console.log(`test pages on http://127.0.0.1:${(web.address() as { port: number }).port}/ (/, /frames, /tools)`);
}
