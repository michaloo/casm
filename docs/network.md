# Self-hosted network architecture

casm has no relay, cloud account or TLS of its own: you bring the network. This
page is about setting that network up **before** you install casm, so your
servers, their peers, the CLI and the web client (also as an app on a phone)
can reach each other, and nobody else can. casm works the same on any of the
options below; pick the one that fits you.

- [The model](#the-model)
- [What casm exposes](#what-casm-exposes)
- [Requirements: must, should, can](#requirements-must-should-can)
- [Options](#options): [Tailscale](#tailscale-and-headscale),
  [Cloudflare Zero Trust](#cloudflare-zero-trust),
  [WireGuard](#plain-wireguard), [OpenVPN](#openvpn),
  [others](#others), [comparison](#comparison)
- [HTTPS recipes](#https-recipes)
- [Checklist before installing casm](#checklist-before-installing-casm)
- [Troubleshooting](#troubleshooting)

## The model

- **One server per machine.** Each machine that runs agents runs `casm serve`.
  It owns that machine's projects and agents and listens on one port (7373).
- **Peers.** A server can register other servers as peers
  (`casm peer add <name> <ws-url> <token>`) and forward requests to them, one
  hop: that is what `-H worker` and the web client's extra hosts use. The
  calling server opens the connection and keeps the peer's token.
- **Clients.** The CLI on the same machine finds its server by itself
  (`local.json`, a loopback address). The web client talks only to the server
  it was loaded from; that server reaches the peers for it. A CLI on a machine
  without a server uses `casm host add <name> <ws-url> <token>`.

So a phone needs to reach **one** server (any of them), and servers need to
reach their peers. Nothing has to reach the phone except its own push service.

```text
┌─ your private network: overlay VPN, tunnel or LAN ────────────────────────┐
│                                                                           │
│  phone / laptop         studio                         worker             │
│  ┌──────────────┐  wss  ┌──────────────┐   ws(s)       ┌──────────────┐   │
│  │ web client   │─────▶ │ casm serve   │─────────────▶ │ casm serve   │   │
│  │ browser/PWA  │ token │ :7373        │  peer token   │ :7373        │   │
│  └──────────────┘       └──────────────┘               └──────────────┘   │
│         ▲                      │  (CLI: loopback)             │           │
└─────────┼──────────────────────┼──────────────────────────────┼───────────┘
          │ notifications        │ HTTPS out                    │ HTTPS out
┌─────────┴──────────────────────▼──────────────────────────────▼───────────┐
│ internet: Apple / Google / Mozilla / Microsoft push services,             │
│           provider APIs (Anthropic, OpenAI, …)                            │
└───────────────────────────────────────────────────────────────────────────┘
```

Two trust boundaries matter: who can open a TCP connection to port 7373 (the
network's job), and who holds a token (casm's job). Keep both.

## What casm exposes

Everything is on one port, HTTP and WebSocket together:

| What | Auth | Notes |
|---|---|---|
| WebSocket upgrade (JSON-RPC 2.0), any path | client token | `Authorization: Bearer <token>` (CLI, peers) or `?token=<token>` in the URL (browsers can't set headers on a WebSocket). A bad token gets `401`. |
| `GET /`, `/h/…`, `/f/…`, `/assets/…`, `/sw.js`, manifest, icons | none | The web client's static files. `/f/…` is the preview page, not file contents. |
| `GET /dl/<signed link>/<name>` | signed link | File downloads, valid about five minutes; no token in the URL. |
| `GET /health` | none | Server name, id and protocol version. |

- **Bind address:** `127.0.0.1:7373` by default, so only the machine itself.
  Change it with `casm serve --listen host:port`, `CASM_LISTEN` or `listen`
  in `$CASM_HOME/config.json` (the first one set wins). The
  [service](getting-started.md#run-it-as-a-service) retries every few seconds
  when the address doesn't exist yet, for example a VPN interface still coming
  up at boot.
- **Tokens:** `casm token create <name>` on the server, `casm token list`,
  `casm token revoke <name>` (stops working at once). One token per device or
  peer makes revoking one cheap. Treat each one as a password: it lets the
  holder run agents as your user on that machine.
- **Outbound:** the provider CLIs reach their own APIs; casm itself only
  connects to its peers and, for notifications, `POST`s encrypted Web Push
  messages over HTTPS to the endpoint each browser gave it (Apple
  `*.push.apple.com`, Google `fcm.googleapis.com`, Mozilla
  `*.push.services.mozilla.com`, Microsoft `*.notify.windows.com`). Allow
  outbound HTTPS (443) from every server.
- **What needs a secure origin:** the web client works over plain HTTP,
  including the Home Screen and Dock app, the offline copy of your transcripts
  and drafts. Only the service worker needs HTTPS (or
  `localhost`), and two features depend on it: a cold start with no
  connection at all, and **notifications** (Web Push). Chrome and Edge also
  only offer their install button on HTTPS. See [the web client](web-client.md#offline-and-connection)
  and [pwa.md](pwa.md). The certificate must be **trusted** by the device: a
  certificate warning you click through doesn't make a secure context for a
  service worker.

## Requirements: must, should, can

**Must**

- Every client can reach the server it uses, and every server can reach its
  peers, at the address you put in their URLs.
- Every connection carries a token. Create one per device and per peer;
  revoke the ones you no longer use.
- **Never expose port 7373 directly to the public internet** (port forward,
  `0.0.0.0` on a public IP, an open tunnel). A token is the only thing between
  the internet and a shell on your machine, the static files and `/health`
  answer anyone, and a browser sends the token in the URL.

**Should**

- Put the machines on a **private overlay network or an authenticated
  tunnel**, so only your devices can open a connection at all.
- Serve the web client over **HTTPS with a certificate your devices trust**,
  if you want notifications, offline cold start or the Chrome/Edge install
  button.
- Choose the **bind address** on purpose: keep `127.0.0.1` when a local proxy
  (`tailscale serve`, Caddy, `cloudflared`) fronts casm; otherwise bind the
  VPN address (`100.x.y.z`, `10.8.0.1`), not `0.0.0.0`.
- Restrict who on that network can reach 7373 (ACLs, firewall), if other
  people or devices share it.

**Can**

- Expose the web client publicly **behind an identity-aware proxy** (for
  example Cloudflare Access), so a login happens before any request reaches
  casm.
- Use a real domain with a public certificate for private addresses
  ([Caddy with DNS-01](#caddy-with-a-real-domain-and-dns-01)).
- Mix: an overlay for servers and the CLI, a tunnel for the phone.

## Options

### Tailscale (and Headscale)

**How it works.** A WireGuard mesh with a hosted control plane: every device
gets a `100.x.y.z` address and, with [MagicDNS](https://tailscale.com/kb/1081/magicdns),
a name such as `studio` and `studio.<tailnet>.ts.net`. Connections go direct
or through relays, so it works behind CGNAT without opening ports.

**Setup for casm.**

1. Install Tailscale on each machine and the phone; enable MagicDNS.
2. Either bind casm to the tailnet address and use HTTP:

   ```json
   { "listen": "100.101.102.103:7373" }
   ```

   Web client at `http://studio:7373`; peers as `ws://studio:7373`.

3. Or keep `listen` at `127.0.0.1:7373` and let
   [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve) add
   HTTPS (needs [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https)
   enabled for the tailnet):

   ```sh
   tailscale serve --bg 7373      # https://studio.<tailnet>.ts.net → 127.0.0.1:7373
   tailscale serve status
   ```

   Web client at `https://studio.<tailnet>.ts.net`; peers as
   `wss://studio.<tailnet>.ts.net`. WebSockets pass through.

4. Optional: [grants/ACLs](https://tailscale.com/kb/1324/grants) so only your
   own devices (or a `tag:casm` group) reach port 443/7373 on the servers.

**Pros.** Minutes to set up, NAT traversal, phone apps, real HTTPS without a
domain, ACLs. **Cons.** A third-party control plane (it never sees your
traffic, which is end-to-end WireGuard). The certificates are from Let's
Encrypt, so **your machine names and tailnet name land in public Certificate
Transparency logs**; don't use names you consider secret.
**Phone/PWA.** Tailscale app on, open the `ts.net` address, add to Home Screen;
notifications work. **Don't** use [Funnel](https://tailscale.com/kb/1223/funnel)
for casm: it publishes the server to the internet.

**Headscale.** [Headscale](https://headscale.net/stable/about/features/) is
a self-hosted control server the official clients (including the phone apps)
can use. It supports MagicDNS and ACLs, but not Serve, Funnel or `ts.net`
certificates: use HTTP, or [Caddy with your own domain](#caddy-with-a-real-domain-and-dns-01)
for HTTPS. Headscale itself must be reachable from the internet (HTTPS) for
devices to join.

### Cloudflare Zero Trust

**How it works.** [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
(`cloudflared`) opens an outbound-only connection from your machine to
Cloudflare and publishes a hostname such as `casm.example.com`;
[Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
puts a login (your identity provider, one-time PIN) in front of it.
[Private network routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/)
with the Cloudflare One client (formerly WARP) reaches private IPs instead,
like a VPN.

**Setup for casm.**

1. A domain on Cloudflare. Keep `listen` at `127.0.0.1:7373`.
2. Create a tunnel on the machine and publish `casm.example.com` →
   `http://localhost:7373`.
3. **Before** sharing the URL, add an Access application for
   `casm.example.com` with a policy that admits only you. Without it, casm is
   on the public internet.
4. The browser and the installed app log in to Access, then paste the casm
   token as usual. [WebSockets](https://developers.cloudflare.com/network/websockets/)
   work on all plans.
5. **CLI and peers** can't pass Access: they send only casm's bearer token,
   not Access [service-token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
   headers or cookies. Connect servers through private network routing
   (`ws://<private-ip>:7373`, casm bound to that address) or a separate
   overlay.

**Pros.** No inbound ports, works behind CGNAT, real certificates, a login
before anything reaches casm, free tier for personal use. **Cons.**
**Cloudflare terminates TLS**, so it can read everything that passes,
including tokens and transcripts; the setup has more parts; Access sessions
expire and the app has to log in again. **Phone/PWA.** HTTPS with a public
certificate, so install and notifications work; or the Cloudflare One Agent
app for private routing.

### Plain WireGuard

**How it works.** You run [WireGuard](https://www.wireguard.com/quickstart/)
yourself, usually **hub and spoke**: one hub with a reachable UDP port (a
small VPS, or a home router with a port forward), every machine and phone a
spoke with its own key pair and a `10.8.0.x` address. No control plane, no
third party.

**Setup for casm.**

1. Generate a key pair per device; on the hub, one `[Peer]` per device with its
   public key and `AllowedIPs = 10.8.0.x/32`; on each spoke, the hub as the
   peer with `AllowedIPs = 10.8.0.0/24` and `PersistentKeepalive = 25`. Enable
   IP forwarding on the hub so spokes reach each other.
2. Bind casm to the spoke's address: `"listen": "10.8.0.2:7373"`. Peers as
   `ws://10.8.0.3:7373`, or names in `/etc/hosts` or your DNS.
3. HTTPS is up to you: none (HTTP works, minus notifications), an internal CA
   ([Caddy `tls internal`](#caddy-with-an-internal-ca), [mkcert](#mkcert))
   trusted on each device, or a real domain pointing at `10.8.0.x` with
   [DNS-01](#caddy-with-a-real-domain-and-dns-01).

**Pros.** Small, fast, fully self-hosted, nothing to trust but your keys.
**Cons.** Manual keys and addresses; the hub needs a public UDP port, so
CGNAT on both ends needs a VPS; no DNS or ACLs unless you add them (firewall
`10.8.0.0/24` → 7373). **Phone/PWA.** The official WireGuard app imports a
config from a QR code; with an on-demand rule it stays connected.

### OpenVPN

The legacy option: [OpenVPN](https://openvpn.net/community/) works like the
WireGuard hub (bind casm to the tun address, HTTPS the same way), with a
heavier PKI and slower links. Use it if you already run it; otherwise prefer
WireGuard or an overlay built on it.

### Others

- **[ZeroTier](https://www.zerotier.com/):** a mesh like Tailscale (NAT
  traversal, phone apps); the network controller can be self-hosted. HTTPS via
  your own domain or CA.
- **[NetBird](https://netbird.io/):** WireGuard mesh with ACLs, SSO and phone
  apps; the whole control plane is open source and self-hostable.
- **[Nebula](https://github.com/slackhq/nebula):** a certificate-based overlay
  with self-hosted "lighthouses"; phone app from Defined Networking. More
  manual, no third party.
- **LAN only:** bind the LAN address (`192.168.1.20:7373`) and use mDNS names
  (`studio.local`). Simple, but only at home, and anyone on the LAN can try
  tokens. `.local` names can't get public certificates: use an internal CA or
  HTTP.
- **A reverse proxy with a real domain:** [Caddy](#caddy-with-a-real-domain-and-dns-01)
  in front of casm on any of the networks above, with a public certificate
  obtained by DNS-01, so the name can point at a private address.

### Comparison

| | Setup effort | Self-hostable control plane | HTTPS story | Phone | Behind CGNAT | Cost |
|---|---|---|---|---|---|---|
| Tailscale | Low | Via Headscale | `tailscale serve`, built in | App, push works | Yes | Free personal tier ([pricing](https://tailscale.com/pricing)) |
| Headscale | Medium | Yes | Your domain + DNS-01, or internal CA | Tailscale app | Yes (needs one public server) | Free + a small server |
| Cloudflare Tunnel + Access | Medium | No | Public cert, Cloudflare terminates TLS | Browser + Access login | Yes | Free tier ([plans](https://www.cloudflare.com/plans/zero-trust-services/)) |
| WireGuard | Medium–high | Nothing to host but the hub | Your domain + DNS-01, or internal CA | App, QR config | Only with a public hub | Free (+ VPS) |
| OpenVPN | High | Yes | Same as WireGuard | App | Only with a public server | Free (+ VPS) |
| ZeroTier / NetBird | Low–medium | Yes | Your domain or CA | Apps | Yes | Free tiers or self-host |
| Nebula | High | Yes (lighthouses) | Your domain or CA | App | Needs a public lighthouse | Free |
| LAN + mDNS | Lowest | n/a | Internal CA or none | At home only | n/a | Free |

## HTTPS recipes

Which of these make the origin secure (service worker, notifications) on
your devices:

| Recipe | Certificate | Trusted on iPhone / Mac without extra steps | Others |
|---|---|---|---|
| `tailscale serve` | Let's Encrypt (`ts.net`) | Yes | Yes |
| Caddy + real domain + DNS-01 | Let's Encrypt | Yes | Yes |
| Cloudflare Tunnel | Cloudflare edge certificate | Yes | Yes |
| Caddy `tls internal` | Your own CA | Only after installing and fully trusting the root | Same |
| mkcert | Your own CA | Only after installing and fully trusting the root | Same |
| Self-signed, warning clicked through | none | No | No |

Public certificates are the easy path. With a private CA, install the root on
**every** device: on iOS open the `.pem`, install the profile under
**Settings → General → VPN & Device Management**, then turn on full trust
under **Settings → General → About → Certificate Trust Settings**; on macOS
mark it *Always Trust* in Keychain Access; on Android install it as a CA
certificate in the security settings (Chrome honors user CAs). Verify on the
device that **Host options → Notifications** offers to enable notifications.
Web Push on iPhone and iPad also needs the app added to the Home Screen
([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).

### tailscale serve

```sh
tailscale serve --bg 7373      # HTTPS on 443 → http://127.0.0.1:7373
tailscale serve reset          # undo
```

casm keeps `listen` at `127.0.0.1:7373`. The certificate is issued and
renewed for you.

### Caddy with a real domain and DNS-01

A public name (`casm.example.com`) with an `A` record pointing at a private
address (`100.x.y.z`, `10.8.0.2`); Let's Encrypt validates through a DNS TXT
record ([DNS-01](https://letsencrypt.org/docs/challenge-types/)), so nothing
has to be reachable from the internet. Caddy needs a build with your DNS
provider's module ([Automatic HTTPS](https://caddyserver.com/docs/automatic-https)):

```caddyfile
casm.example.com {
	bind 10.8.0.2
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:7373
}
```

`reverse_proxy` passes WebSockets through. The name appears in Certificate
Transparency logs; the private address only in your DNS.

### Caddy with an internal CA

```caddyfile
studio.lan {
	tls internal
	reverse_proxy 127.0.0.1:7373
}
```

Caddy runs its own CA ([`tls`](https://caddyserver.com/docs/caddyfile/directives/tls));
the root is in Caddy's data directory under `pki/authorities/local/root.crt`.
Install it on every device as above.

### mkcert

```sh
mkcert -install
mkcert studio.lan 10.8.0.2      # writes studio.lan+1.pem and -key.pem
```

Serve them from a proxy (Caddy `tls <cert> <key>`). On phones, install
`rootCA.pem` from `mkcert -CAROOT` and trust it fully
([mkcert](https://github.com/FiloSottile/mkcert)). Never copy `rootCA-key.pem`
anywhere: it can sign a certificate for any site.

### Cloudflare

The tunnel's public hostname has Cloudflare's certificate; there is nothing
to configure on the casm side. Keep Access in front of it.

## Checklist before installing casm

- [ ] Every machine that will run casm, and every phone or laptop that will use
      it, is on the private network and can reach the others (`ping`, or
      `curl http://<name>:<port>/health` once casm runs).
- [ ] You know each server's address and name: what goes in `listen` and in
      `casm peer add … ws(s)://<name>:<port>`.
- [ ] Port 7373 is not forwarded on your router and not open on a public
      interface; a tunnel hostname has an access policy.
- [ ] If you want notifications or offline cold start: an HTTPS origin your
      devices trust, decided now (changing the address later means pasting the
      token and enabling notifications again on each device, since browsers
      keep both per origin).
- [ ] Servers can make outbound HTTPS to the provider APIs and the push
      services.
- [ ] The VPN client starts at boot on every server, and the casm service is
      allowed to start before it (it retries until the address exists).
- [ ] Optional: ACLs or firewall rules limiting 7373 (or the proxy's 443) to
      your devices.

Then [install casm](getting-started.md), set `listen`, create one token per
device and per peer, and add the peers.

## Troubleshooting

- **The page loads but never connects.** The proxy doesn't pass the
  WebSocket upgrade. Caddy, `tailscale serve` and Cloudflare do by default;
  nginx needs it spelled out:

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:7373;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 1h;
  }
  ```

- **`casm: connect with a WebSocket` (HTTP 426).** A plain HTTP request
  reached a path that isn't a static file; usually the same missing upgrade.
- **Connections drop after a minute or so of idling.** A proxy or load
  balancer idle timeout. The web client probes after 20 seconds of silence,
  which keeps its own connection alive; an idle peer connection is reopened
  on the next call, and the web client reloads peer views after
  `peer.disconnected`. Raise the proxy's timeout (`proxy_read_timeout`) if it
  is short.
- **`wss://` from an `http://` page, or the reverse.** The web client follows
  the page: `https://` pages use `wss://`, `http://` pages `ws://`. Mixed
  content means a proxy in between rewrote one of them (for example TLS
  terminated in front of another proxy that still says `http`); open the
  HTTPS address directly.
- **Notifications say "Unavailable over plain HTTP"** or the button is
  missing: the origin isn't a secure context. Check the certificate is trusted
  without a warning, and on iPhone that casm was opened from the Home Screen.
- **Tokens in logs.** Browsers send the token as `?token=` on the WebSocket
  URL. If your proxy writes access logs, drop or redact query strings for
  that host, and revoke any token that leaked.
- **A public name resolves to a private address, but not at home.** Some
  routers block DNS answers with private addresses (DNS rebinding
  protection). Allow the domain in the router's DNS settings, or use another
  resolver.
- **A peer is unreachable.** See
  [troubleshooting: peers](troubleshooting.md#peers); `casm peers --probe`
  shows each peer's state.
