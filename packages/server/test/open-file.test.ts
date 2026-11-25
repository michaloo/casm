import assert from "node:assert/strict";
import test from "node:test";
import { canOpenDesktopFile, localDesktopRequest } from "../src/open-file.ts";

test("desktop opening requires the browser origin and socket to be local", () => {
  const socket = { remoteAddress: "127.0.0.1", localPort: 7373 };
  const headers = { origin: "http://127.0.0.1:7373", host: "127.0.0.1:7373" };
  assert.equal(localDesktopRequest({ socket, headers }), true);
  assert.equal(localDesktopRequest({ socket, headers: { host: headers.host } }), false);
  assert.equal(localDesktopRequest({ socket, headers: { ...headers, origin: "https://example.com" } }), false);
  assert.equal(localDesktopRequest({ socket, headers: { ...headers, "x-forwarded-for": "192.0.2.5" } }), false);
  assert.equal(localDesktopRequest({ socket: { ...socket, remoteAddress: "192.0.2.5" }, headers }), false);
  assert.equal(localDesktopRequest({ socket: { ...socket, localPort: 8765 }, headers }), false);
});

test("Tailscale Serve allows only the configured HTTPS origin and this laptop's source address", () => {
  const origin = "https://laptop.example.ts.net";
  const socket = { remoteAddress: "127.0.0.1", localPort: 7373 };
  const local = "100.100.1.2";
  const headers = {
    origin,
    host: "laptop.example.ts.net",
    "x-forwarded-host": "laptop.example.ts.net",
    "x-forwarded-proto": "https",
    "x-forwarded-for": local,
  };
  const proxy = { origin, addresses: new Set([local]) };
  assert.equal(localDesktopRequest({ socket, headers }, proxy), true);
  assert.equal(localDesktopRequest({ socket, headers }), false);
  assert.equal(localDesktopRequest({ socket, headers: { ...headers, "x-forwarded-for": "100.100.1.3" } }, proxy), false);
  assert.equal(localDesktopRequest({ socket, headers: { ...headers, "x-forwarded-for": local + ", 100.100.1.3" } }, proxy), false);
  assert.equal(localDesktopRequest({ socket, headers: { ...headers, "x-forwarded-host": "other.example.ts.net" } }, proxy), false);
  assert.equal(localDesktopRequest({ socket, headers: { ...headers, "tailscale-funnel-request": "?1" } }, proxy), false);
  assert.equal(localDesktopRequest({ socket: { ...socket, remoteAddress: local }, headers }, proxy), false);
});

test("desktop opening accepts local documents and excludes scripts, shortcuts and device paths", () => {
  assert.equal(canOpenDesktopFile("C:\\Work\\Monthly report.PDF"), true);
  for (const path of [
    "C:\\Work\\setup.exe", "C:\\Work\\run.cmd", "C:\\Work\\run.py", "C:\\Work\\report.pdf.lnk",
    "C:\\Work\\report.pdf:program", "\\\\server\\share\\report.pdf", "report.pdf",
  ]) assert.equal(canOpenDesktopFile(path), false, path);
});
