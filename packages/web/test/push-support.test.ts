import test from "node:test";
import assert from "node:assert/strict";
import { deviceLabel, keyBytes, pushSupport, sameKey, type PushEnv } from "../src/push-support.ts";

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const env = (over: Partial<PushEnv> = {}): PushEnv => ({ secure: true, serviceWorker: true, pushManager: true, notification: true, userAgent: macSafari, standalone: false, touchPoints: 0, ...over });

test("push support says why not: HTTP, an iPhone tab, an old browser", () => {
  assert.deepEqual(pushSupport(env()), { ok: true });
  assert.deepEqual(pushSupport(env({ secure: false })), { ok: false, reason: "insecure" });
  assert.deepEqual(pushSupport(env({ userAgent: iphone, pushManager: false })), { ok: false, reason: "ios-not-installed" });
  assert.deepEqual(pushSupport(env({ userAgent: iphone, standalone: true })), { ok: true });
  // iPadOS asks for desktop pages as a Mac.
  assert.deepEqual(pushSupport(env({ touchPoints: 5 })), { ok: false, reason: "ios-not-installed" });
  assert.deepEqual(pushSupport(env({ pushManager: false })), { ok: false, reason: "unsupported" });
});

test("device labels name the device and how casm runs there", () => {
  assert.equal(deviceLabel(env({ userAgent: iphone, standalone: true })), "iPhone · Home Screen app");
  assert.equal(deviceLabel(env({ standalone: true })), "Mac · Safari app");
  assert.equal(deviceLabel(env()), "Mac · Safari");
  assert.equal(deviceLabel(env({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" })), "Linux · Chrome");
  assert.equal(deviceLabel(env({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0" })), "Windows · Edge");
});

test("the server key decodes from base64url and compares with a subscription's", () => {
  const bytes = keyBytes(Buffer.from([4, 250, 251, 0, 62, 63]).toString("base64url"));
  assert.deepEqual([...bytes], [4, 250, 251, 0, 62, 63]);
  assert.ok(sameKey(bytes.slice().buffer, bytes));
  assert.ok(!sameKey(new Uint8Array([4, 250]).buffer, bytes));
  assert.ok(!sameKey(null, bytes));
});
