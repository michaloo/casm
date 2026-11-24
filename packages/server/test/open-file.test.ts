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

test("desktop opening accepts local documents and excludes scripts, shortcuts and device paths", () => {
  assert.equal(canOpenDesktopFile("C:\\Work\\Monthly report.PDF"), true);
  for (const path of [
    "C:\\Work\\setup.exe", "C:\\Work\\run.cmd", "C:\\Work\\run.py", "C:\\Work\\report.pdf.lnk",
    "C:\\Work\\report.pdf:program", "\\\\server\\share\\report.pdf", "report.pdf",
  ]) assert.equal(canOpenDesktopFile(path), false, path);
});
