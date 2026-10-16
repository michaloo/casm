# Protocol for third-party clients

Everything the CLI and the web client do goes through one public protocol:
**JSON-RPC 2.0 over a WebSocket**. You can write your own client in any
language: a dashboard, a bot, an editor integration.

- Source of truth: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)
  (zod schemas, with comments on every method).
- Language-neutral export: [`spec/protocol.json`](../spec/protocol.json), JSON
  Schema for every method's params and result and every notification
  (regenerate with `npm run schema`; tests fail when it drifts).
- A typed Node client: [`packages/client`](../packages/client/src/index.ts)
  (`CasmClient.connect(url, token)`, `call`, `on`).

## Connecting

```text
ws://<host>:7373/                        Authorization: Bearer <token>
ws://<host>:7373/  then {"method":"auth","params":{"token":"<token>"}}   browsers
GET /health                              unauthenticated
```

Create a token on the server with `casm token create <name>`. The server
listens on `127.0.0.1:7373` by default; another machine needs `listen` in
`$CASM_HOME/config.json` (or `casm serve --listen`). `/health` tells
you the server and protocol version before you connect:

```console
$ curl -s http://127.0.0.1:7373/health
{"id":"78486051-526d-4303-8180-098146be5f3f","name":"studio","version":"0.0.1","protocol":1}
```

A wrong token in the header fails the WebSocket upgrade with HTTP 401.

Browsers can't set headers on a WebSocket, so they connect without one and
send `auth` with the token as the first request, within 10 seconds. Until it
succeeds any other method gets error `1006` (Unauthorized), and then, like a
wrong token or no `auth` in time, the server closes the socket with code
`4401`. The token never goes in the URL: reverse proxies, server logs and
browser history keep URLs. (`?token=<token>` still works for one more release
and logs a deprecation line; don't use it.)

Revoking a token (`casm token revoke <name>`) closes its open connections
within about 30 seconds, also with `4401`.

## Requests, results, notifications

Requests are plain JSON-RPC 2.0. A request may add a top-level `"host"`: the
name or server ID of one of the server's peers, and the server forwards the
call there. Notifications relayed from that peer carry the same `host`.

```json
{"jsonrpc":"2.0","id":1,"method":"agent.send","params":{"id":"83b4f029-…","text":"Run the tests"}}
{"jsonrpc":"2.0","id":1,"result":{"queued":false}}
```

Errors use the standard codes plus casm's own:

| Code | Name | Meaning |
| --- | --- | --- |
| -32700 … -32603 | JSON-RPC | parse error, invalid request, method not found, invalid params, internal |
| 1001 | NotFound | no such agent, project, schedule, request… |
| 1002 | Busy | the agent can't take that now |
| 1003 | Conflict | e.g. a stale `expectedSha256` when saving AGENTS.md |
| 1004 | Limited | the provider is over its usage limit (`whenLimited: "fail"`) |
| 1005 | Unreachable | a peer didn't answer |

## The method families

| Family | Methods |
| --- | --- |
| Server | `server.info`, `server.agentPrompt`, `server.setAgentPrompt`, `peer.list`, `host.agentsMd`, `host.setAgentsMd` |
| Projects | `project.list`, `project.create`, `project.update`, `project.delete`, `project.agentsMd`, `project.setAgentsMd`, `project.memories` |
| Agents | `agent.list`, `agent.get`, `agent.create`, `agent.update`, `agent.delete`, `agent.history`, `agent.subscribe`, `agent.unsubscribe`, `agent.wait`, `agent.usage`, `agent.subagents`, `agent.subagentHistory`, `agent.commands`, `agent.shell` |
| Messages | `agent.send`, `agent.pending`, `agent.retryPending`, `agent.steerPending`, `agent.editPending`, `agent.cancelPending`, `agent.interrupt`, `agent.reload`, `agent.restart` |
| Requests | `agent.respondPermission`, `agent.answerQuestion` |
| MCP | `agent.mcpStatus`, `agent.mcpReconnect`, `agent.mcpToggle` |
| Host-wide | `pending.list`, `provider.limits`, `provider.catalog` |
| Schedules | `schedule.list` (`projectId?`, `agentId?` filters), `schedule.create`, `schedule.update`, `schedule.delete`, `schedule.runNow`; each schedule carries its derived `projectId` |
| Files | `fs.read`, `fs.search`, `fs.downloadLink` |
| Notifications | `push.list`, `push.subscribe`, `push.unsubscribe`, `push.test`, `push.notify` |

Notifications: `agent.event` (for subscribed agents), `agent.status`,
`agent.changed`, `agent.removed`, `project.changed`, `project.removed`,
`schedule.changed`, `schedule.removed`, `provider.limits`,
`peer.disconnected`.

## Transcripts and live events

`agent.history` returns normalized **items**, paged from the end (`before`,
`limit`; the result has `start` and `total`). Item kinds:

| Kind | Fields |
| --- | --- |
| `user` | `text`, `images?`, `sender?` (who sent it: agent, host, schedule) |
| `assistant` | `text` (Markdown) |
| `reasoning` | `text` |
| `tool` | `name`, `input`, `status` (`running`/`done`/`error`), `output?`, `images?`, `origin?` |
| `subagent` | `title`, `status`, `activity?`, `summary?`, `usage?` |
| `notice` | `text`, `level?`; upserted by ID (e.g. a retry countdown) |
| `plan` | `entries[]` of `{text, status}`; each update replaces the list |

`agent.subscribe` returns the agent's status, the **in-flight turn** so far,
and open permission/question requests, so a client that connects mid-turn can
catch up. After that, `agent.event` notifications stream `turnStarted`,
`delta` (streamed assistant or reasoning text), `item` (upserted by ID),
`toolOutput`, `usage`, `permission`/`permissionResolved`,
`question`/`questionResolved` and `turnEnded`.

## Sending well

- `agent.send` takes `whenBusy: "queue"` (default) or `"steer"`, and
  `whenLimited: "queue"` (default) or `"fail"`. The result says whether it was
  `queued`, with the `pendingId` and a `deferredUntil` for limits.
- Pass your own UUID as `messageId`. It becomes the pending ID and the user
  item's ID, so you can show the message at once and match it later. Sending
  the same ID again after a lost response does **not** send it twice.
- `sender` declares provenance (see [message provenance](message-provenance.md));
  it's trusted-client metadata, not authorization.

## A complete client in 30 lines

Node 22+ has `WebSocket` built in; this connects, subscribes to an agent,
sends a message and prints the reply as it arrives:

```js
// client.mjs: CASM_TOKEN=… node client.mjs
const ws = new WebSocket("ws://127.0.0.1:7373/");
let nextId = 1;
const waiting = new Map();
const call = (method, params = {}, host) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(host ? { host } : {}) }));
  });
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "agent.event" && msg.params.event.type === "item") {
    const item = msg.params.event.item;
    if (item.kind === "assistant") console.log("assistant:", item.text);
  } else if (msg.method === "agent.status") {
    console.log("status:", msg.params.status);
    if (msg.params.status === "idle") ws.close();
  }
};
ws.onopen = async () => {
  await call("auth", { token: process.env.CASM_TOKEN });
  const info = await call("server.info");
  console.log(info.name, "protocol", info.protocol, "providers", info.providers.join(", "));
  const { agents } = await call("agent.list");
  const agent = agents.find((a) => a.name === "reviewer");
  await call("agent.subscribe", { id: agent.id });
  await call("agent.send", { id: agent.id, text: "Name one prime number. Just the number." });
};
```

```console
$ CASM_TOKEN=$(casm token create my-client) node client.mjs
studio protocol 1 providers claude, codex, pi, opencode
status: running
assistant: 7
status: idle
```

Pass a peer's name as the third argument of `call` to do the same on another
host.

## Files over HTTP

`fs.downloadLink` returns a short-lived signed URL, `GET /dl/<token>`, valid
for about five minutes, that needs no client token. `fs.read` returns text
previews up to 1 MiB. Paths must resolve inside a registered project folder.

## Notifications (Web Push)

`push.notify {message, title?, url?, device?, sender?}` notifies the user: the
server sends a Web Push message to each subscribed device (or the one whose
label or id is `device`). A
`sender` that is an agent on this server titles it `<agent> · <project>` and
sets `url` to `/h/<host>/a/<agent>`. Senders get 10 a minute (error 1002
beyond). The result reports `delivered`, `devices` and per-device `failed`
reasons.

A browser subscribes with its service worker: `push.list` returns the VAPID
`publicKey` for `PushManager.subscribe({userVisibleOnly: true,
applicationServerKey})`, and `push.subscribe` registers the subscription's
endpoint and keys with a `label`. Endpoints and keys never leave the server;
`push.list {endpoint}` marks the caller's own device `current`. The server
encrypts payloads per RFC 8291 (aes128gcm), signs requests with VAPID
(RFC 8292; the key pair is `$CASM_HOME/push-vapid.json`), removes a
subscription its push service answers 404 or 410 for, and pauses one that
answers 429. The payload is `{title, body, tag, url}` JSON.
