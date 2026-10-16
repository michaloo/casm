// Host load (host.stats), shared by the sidebar's mini bars and the Resources tab:
// one poller per host, at the fastest cadence any reader asks for, paused while the page is hidden.
import { useEffect, useState } from "react";
import type { HostStats } from "@casm/protocol";
import type { Rpc } from "./state";

type Reader = { every: number; rpc: Rpc; seen: (stats: HostStats | null | undefined) => void };
type Poller = { readers: Set<Reader>; stats: HostStats | null | undefined; at: number; rpc?: Rpc; timer?: ReturnType<typeof setTimeout>; reading: boolean };

const pollers = new Map<string, Poller>();
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function plan(host: string) {
  const poller = pollers.get(host);
  if (!poller) return;
  clearTimeout(poller.timer);
  poller.timer = undefined;
  if (!poller.readers.size || hidden() || poller.reading) return;
  const readers = [...poller.readers];
  const rpc = readers[readers.length - 1].rpc;
  // A new connection reads at once.
  if (rpc !== poller.rpc) { poller.rpc = rpc; poller.at = 0; }
  const every = Math.min(...readers.map((reader) => reader.every));
  poller.timer = setTimeout(() => read(host), Math.max(0, poller.at + every - Date.now()));
}

function read(host: string) {
  const poller = pollers.get(host);
  if (!poller?.rpc) return;
  const rpc = poller.rpc;
  poller.reading = true;
  // Older hosts without host.stats fail: no stats, so their bars stay hidden.
  void rpc.call("host.stats", {}, host).then((stats) => stats, () => null).then((stats) => {
    poller.reading = false;
    poller.at = Date.now();
    if (poller.rpc === rpc) {
      poller.stats = stats;
      for (const reader of poller.readers) reader.seen(stats);
    }
    plan(host);
  });
}

if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { for (const host of pollers.keys()) plan(host); });

/** This host's latest load, read every `every` ms while mounted and the page is visible:
 * undefined until the first read, null when offline or the host lacks host.stats. */
export function useHostStats(host: string, rpc: Rpc | null, online: boolean, every: number): HostStats | null | undefined {
  const [stats, setStats] = useState<HostStats | null | undefined>(() => online && rpc ? pollers.get(host)?.stats : null);
  useEffect(() => {
    if (!online || !rpc) { setStats(null); return; }
    const poller = pollers.get(host) ?? { readers: new Set(), stats: undefined, at: 0, reading: false };
    pollers.set(host, poller);
    setStats(poller.rpc === rpc ? poller.stats : undefined);
    const reader: Reader = { every, rpc, seen: setStats };
    poller.readers.add(reader);
    plan(host);
    return () => {
      poller.readers.delete(reader);
      if (poller.readers.size) plan(host);
      else { clearTimeout(poller.timer); if (pollers.get(host) === poller) pollers.delete(host); }
    };
  }, [host, rpc, online, every]);
  return stats;
}

export const pctTone = (percent: number) => percent >= 95 ? "full" : percent >= 80 ? "high" : "";
export const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
export const ramPercent = (stats: HostStats) => stats.memory.total ? (stats.memory.used / stats.memory.total) * 100 : 0;
