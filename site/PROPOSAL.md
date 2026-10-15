# casm landing page: proposal (self-hosting first)

The mockup is [`index.html`](index.html): one self-contained file, inline CSS and
SVG, no JS, no external fonts or CDNs, light and dark via
`prefers-color-scheme`, checked at 1440 and 375 px wide in Chromium.

## Positioning

**One line:** casm runs your coding agents on your machines, over your network,
from your devices, with no casm cloud in between.

**Who it's for:** developers who already pay for Claude Code or Codex (or run
OpenCode/pi with local models), have more than one machine (a desktop, a home
server, a GPU box, a laptop), want to start, watch and approve agent work from
their phone, and don't want a third-party service holding their sessions,
code or tokens.

**Headline promises** (the four cards under the hero):

1. **Runs on your machines.** One Node server per machine, state in SQLite under
   `~/.casm-ng`. No casm account, cloud or relay, and no telemetry.
2. **Your subscriptions.** casm drives the official Claude Code (Agent SDK),
   Codex (`codex app-server`), OpenCode and pi programs, logged in the way you
   already use them. No API middleman.
3. **Your network.** Tailscale, Headscale, WireGuard, LAN or a Cloudflare
   tunnel; casm needs one port and a token per device.
4. **Your devices.** An installable web app served by your own server, offline
   reading, standard Web Push.

The differentiator against Paseo and HAPI (README "How it compares") is not that
casm is self-hosted (they are too) but that it has *no* central component at
all: every server is independent, and there's no hub or relay to run, trust or
self-host.

## Verification notes (what each claim rests on)

| Claim | Source |
|---|---|
| Node + SQLite in `~/.casm-ng` | `packages/server/src/db.ts` (`node:sqlite`), README quick start |
| No telemetry / phone-home | Every `fetch` in `packages/server/src` and `packages/cli/src`: peer file relay (`files.ts`), Web Push POST (`push.ts`), the local OpenCode server (`providers/opencode*.ts`), signed downloads from your own server (CLI). Server deps are only the Claude Agent SDK, `ws`, `zod` and casm's own packages. No analytics code in any package. |
| Fonts/assets not from a CDN | `packages/web/src/fonts/` bundles Inter and JetBrains Mono woff2 |
| Token not in URLs | `docs/network.md` "What casm exposes"; CLI/peers use `Authorization: Bearer`, browsers an `auth` message; downloads use signed links |
| VAPID keys generated on your server | `packages/server/src/push.ts` (generated on first use into `$CASM_HOME/push-vapid.json`, mode 0600) |
| Push goes through browser vendors | `docs/network.md` (Apple, Google, Mozilla, Microsoft endpoints) |
| Peering copies nothing | README "Connect another machine", `docs/concepts.md` |
| Offline read-only cache, HTTP vs HTTPS | `docs/pwa.md`, README "Install as an app" |
| Limits, schedules, queue/steer | `docs/concepts.md` |
| Local models | `docs/providers.md` "Local models" |
| Never expose 7373 | `docs/network.md` "Requirements" |

Not claimed: anything about the provider CLIs' own telemetry (it's theirs; the
page says so), licensing, pricing, numbers or testimonials.

## Page structure

1. **Header.** Glyph + wordmark, anchors (Self-hosting, How it works, Features,
   What leaves, FAQ), GitHub button. Sticky, translucent.
2. **Hero.** Left: eyebrow "Self-hosted agent orchestrator", headline
   *Your agents. Your machines. Your network.* (last line in the logo
   gradient), a two-sentence lede, three fact chips (Node + SQLite, no
   telemetry, any private network), the real install commands, the
   requirement line, CTAs *Get started* and *Plan your network*. Right: a CSS
   mock of the web client with two hosts in the sidebar, an agent calling
   `casm -H worker run`, and a coral permission request.
   *Why:* the headline is the whole positioning in three beats; the mock shows
   multi-machine and phone approvals without a screenshot that won't load in
   casm's preview. Showing the honest install (clone, build, install.sh)
   instead of a one-liner sets expectations: this is for people who run
   servers.
3. **The deal** (four promises). One sentence each, specific nouns.
4. **What stays on your machine.** A diagram: dashed teal boundary "your
   private network" holding phone/laptop → studio → worker with token labels;
   two coral arrows out to *Model provider APIs* and *Browser push service*.
   A separate vertical SVG for mobile. *Why:* the boundary picture is the
   single most persuasive asset for a self-hosting audience, and it previews
   the honesty of the trust table.
5. **How it works.** Three numbered steps (server, peers, clients) with the
   real commands.
6. **Features.** A 3×3 grid: providers, queue/steer, limits, schedules,
   agents running agents, approvals on the phone, offline reading, files and
   previews, open protocol. Status dots reuse casm's colour semantics (teal =
   running, coral = needs you, violet = agents).
7. **Self-hosting recipes.** Tailscale, Headscale, WireGuard, Cloudflare
   Tunnel + Access, each with its HTTPS story, linking `docs/network.md`; a
   coral "one rule" callout: never expose 7373 to the internet.
8. **What leaves your machine.** A three-column trust table (data, where it
   lives, who else sees it) with stays/leaves/your-network pills, and a note
   that the provider CLIs have their own telemetry settings. *Why:* naming the
   exceptions is what makes "self-hosted" believable.
9. **FAQ.** Eight `<details>` items: account, subscriptions, local models, phone
   safety, sandboxing, file sync, HTTPS, native app.
10. **Closing CTA** and **footer** (docs, self-hosting, project links).

## Copy (as in the mockup)

**Hero**
> Your agents. Your machines. Your network.
>
> casm runs Claude Code, Codex, OpenCode and pi on the computers you already
> own, and lets you drive them from your phone, your laptop or a script. One
> small server per machine. No casm cloud, no account, no relay.

**The deal:** "Everything casm does happens on hardware you control."

**Stays:** "Inside the line is yours. Two kinds of traffic cross it." /
"Each server owns its projects, agents, queues, schedules and tokens. Your phone
talks to one server; servers talk to their peers. Only model calls and push
notifications go out."

**How it works:** "A server, its peers, and the clients you already carry."

**Features:** "Built for unattended work on your own hardware."

**Recipes:** "Bring the network you trust." / "casm has no relay and no TLS of
its own, on purpose. Pick a network, then point casm at it."

**What leaves:** "Self-hosted doesn't mean nothing goes out. Here's exactly what
does."

| Data | Where it lives | Who else sees it |
|---|---|---|
| Projects, agents, queues, schedules, tokens | your server (SQLite) | Nobody. No cloud service, no telemetry. |
| Transcripts and files | your server | Your devices, over your network. Peers don't copy them. |
| Prompts and code sent to a model | model provider | The provider, via its own CLI and your account. Nothing with local models. |
| Notifications | browser push service | Apple/Google/Mozilla/Microsoft relay it encrypted; off until enabled per device. |
| Who can connect | your network | Your VPN's coordination server if hosted; self-host Headscale/WireGuard to remove it. |

**Closing:** "Run it where your code already lives." / "One server today, more
machines when you need them."

## Alternatives

Headlines:
- Your agents. Your machines. Your network. *(used)*
- Coding agents on your own hardware, in your pocket.
- Run Claude Code and Codex on your machines. Drive them from anywhere.
- An agent orchestrator with nothing in the middle.
- Self-hosted all the way down (except the model). *(playful, honest; could
  be the "What leaves" heading instead)*

Taglines (footer / meta description):
- A small, self-hosted orchestrator for Claude Code, Codex, OpenCode and pi. *(used; README's own wording)*
- One server per machine. No cloud. Your subscriptions.
- Queue, steer and schedule your agents from your own servers.

## Open questions for Michal

1. **Install story.** The page shows the real checkout install (clone, `npm ci`,
   build, `install.sh`). Is an npm package or a one-line installer planned? A
   hero one-liner would land better.
2. **Where is it hosted?** A static `site/` on GitHub Pages fits "no casm
   cloud". Should the site itself avoid analytics entirely (I'd recommend yes,
   and say so in the footer)?
3. **Hero visual.** CSS mock (current, works in casm's preview) or the real
   `docs/media/web-agent-*.png` / mobile screenshots with `<picture>`? A real
   phone screenshot next to the desktop one might sell "your devices" better.
4. **Comparison.** Should the page carry a short Paseo/HAPI comparison (README
   has one), or keep it to the README?
5. **`?token=` on upgrade.** `packages/server/src/server.ts` still accepts a
   token in the WebSocket URL query, though no casm client sends one. The page
   says the *browser* never puts it in a URL, which is true; dropping the query
   path would let the page say the server never accepts one.
6. **Native apps.** Mention the `apple` branch on the page (I put one line in
   the FAQ) or leave it out until it ships?
7. **Name and domain.** Is there a domain, and should the wordmark stay
   lowercase "casm" everywhere (I kept it lowercase)?
