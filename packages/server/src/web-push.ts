// A Web Push request: the payload encrypted for one subscription (RFC 8291,
// aes128gcm from RFC 8188) and signed for the push service with VAPID (RFC 8292).
// The push service (Apple, FCM, Mozilla, WNS) only relays the ciphertext.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type webcrypto } from "node:crypto";

export type VapidKeys = { publicKey: string; privateJwk: webcrypto.JsonWebKey };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushRequest = { endpoint: string; headers: Record<string, string>; body: Buffer };
export type PushOptions = { ttl: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; subject: string };

const b64 = (b: Buffer) => b.toString("base64url");
const hmac = (key: Buffer, ...data: Buffer[]) => {
  const h = createHmac("sha256", key);
  for (const d of data) h.update(d);
  return h.digest();
};

// A P-256 key pair; the public key is the uncompressed point clients pass as applicationServerKey.
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const d = ecdh.getPrivateKey();
  return {
    publicKey: b64(pub),
    privateJwk: { kty: "EC", crv: "P-256", d: b64(Buffer.concat([Buffer.alloc(32 - d.length), d])), x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) },
  };
}

// RFC 8291 §3.4: one record, so the whole payload is the last (0x02-delimited) one.
export function encrypt(payload: Buffer, p256dh: string, auth: string, salt = randomBytes(16)) {
  const local = createECDH("prime256v1");
  local.generateKeys();
  const uaPublic = Buffer.from(p256dh, "base64url");
  const asPublic = local.getPublicKey();
  const secret = local.computeSecret(uaPublic);
  const ikm = hmac(hmac(Buffer.from(auth, "base64url"), secret), Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// The VAPID Authorization header: an ES256 JWT for the endpoint's origin, valid 12 hours.
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()) {
  const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

export function pushRequest(target: PushTarget, payload: string, keys: VapidKeys, opts: PushOptions): PushRequest {
  return {
    endpoint: target.endpoint,
    headers: {
      authorization: vapidAuthorization(target.endpoint, keys, opts.subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(opts.ttl),
      ...(opts.urgency ? { urgency: opts.urgency } : {}),
      ...(opts.topic ? { topic: opts.topic } : {}),
    },
    body: encrypt(Buffer.from(payload), target.p256dh, target.auth),
  };
}
