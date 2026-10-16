// CPU, load and memory of this host, sampled in the background so a call returns at once.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, loadavg, platform, totalmem, uptime, type CpuInfo } from "node:os";
import type { HostStats } from "@casm/protocol";

type Times = { idle: number; total: number };

export function cpuTimes(list: Pick<CpuInfo, "times">[]): Times {
  let idle = 0, total = 0;
  for (const { times } of list) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Busy share (0-100, one decimal) between two cumulative samples; null if no time passed. */
export function cpuPercent(prev: Times, next: Times): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const busy = (total - (next.idle - prev.idle)) / total;
  return Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
}

const kb = (text: string, key: string) => {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
  return m ? Number(m[1]) * 1024 : undefined;
};

/** Bytes from /proc/meminfo text. `available` falls back to free + buffers + cached on old kernels. */
export function parseMeminfo(text: string): { total: number; available: number; swapTotal: number; swapUsed: number } | null {
  const total = kb(text, "MemTotal");
  if (total === undefined) return null;
  const available = kb(text, "MemAvailable") ?? (kb(text, "MemFree") ?? 0) + (kb(text, "Buffers") ?? 0) + (kb(text, "Cached") ?? 0);
  const swapTotal = kb(text, "SwapTotal") ?? 0;
  return { total, available: Math.min(total, available), swapTotal, swapUsed: Math.max(0, swapTotal - (kb(text, "SwapFree") ?? swapTotal)) };
}

/** Bytes that can be handed out on macOS: pages free + inactive + speculative, from `vm_stat` output. */
export function parseVmStat(text: string): number | null {
  const size = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!size) return null;
  let pages = 0;
  for (const key of ["Pages free", "Pages inactive", "Pages speculative"]) pages += Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  return pages * size;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout: 3000 }, (error, stdout) => resolve(error ? "" : stdout)));

type Memory = { total: number; available: number; swap: HostStats["swap"] };

async function readMemory(): Promise<Memory> {
  const total = totalmem();
  if (platform() === "linux") {
    const m = parseMeminfo(await readFile("/proc/meminfo", "utf8").catch(() => ""));
    if (m) return { total: m.total, available: m.available, swap: m.swapTotal ? { total: m.swapTotal, used: m.swapUsed } : null };
  } else if (platform() === "darwin") {
    const available = parseVmStat(await run("vm_stat", []));
    if (available !== null) return { total, available: Math.min(total, available), swap: null };
  }
  return { total, available: freemem(), swap: null };
}

export class HostSampler {
  private prev: Times = cpuTimes(cpus());
  private cpu: number | null = null;
  private memory: Memory = { total: totalmem(), available: freemem(), swap: null };
  private at = Date.now();

  constructor(intervalMs = 5000) {
    void this.sample();
    setInterval(() => void this.sample(), intervalMs).unref();
  }

  private async sample() {
    const next = cpuTimes(cpus());
    this.cpu = cpuPercent(this.prev, next) ?? this.cpu;
    this.prev = next;
    this.memory = await readMemory();
    this.at = Date.now();
  }

  read(runningAgents: number): HostStats {
    const { total, available, swap } = this.memory;
    const load = loadavg();
    return {
      cpuPercent: this.cpu,
      cores: availableParallelism(),
      loadAverage: platform() === "win32" ? null : [load[0]!, load[1]!, load[2]!],
      memory: { total, available, used: Math.max(0, total - available) },
      swap,
      uptimeSeconds: Math.round(uptime()),
      processRss: process.memoryUsage.rss(),
      runningAgents,
      sampledAt: new Date(this.at).toISOString(),
    };
  }
}
