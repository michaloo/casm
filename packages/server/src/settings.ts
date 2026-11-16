// Host-wide settings: keys of $CASM_HOME/config.json that clients can change
// (server.settings). Read on use, so edits apply without a restart.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerSettings } from "@casm/protocol";

// Aggressive on purpose: an idle agent holds ~1 GB (its CLI plus MCP servers),
// and resuming costs a couple of seconds once.
export const DEFAULT_IDLE_UNLOAD_MINUTES = 15;

export function readConfig(home: string | null): Record<string, unknown> {
  if (!home) return {};
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

// Merges `patch` into config.json, keeping the keys it doesn't name.
export function updateConfig(home: string, patch: Record<string, unknown>) {
  const file = join(home, "config.json");
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...readConfig(home), ...patch }, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

export class Settings {
  // Null: no state directory (tests); the defaults apply and can't be changed.
  readonly home: string | null;
  constructor(home: string | null) {
    this.home = home;
  }

  get(): ServerSettings {
    const minutes = readConfig(this.home).idleUnloadMinutes;
    return {
      idleUnloadMinutes: Number.isInteger(minutes) && (minutes as number) >= 0 ? (minutes as number) : DEFAULT_IDLE_UNLOAD_MINUTES,
    };
  }

  set(update: Partial<ServerSettings>): ServerSettings {
    if (!this.home) throw new Error("this server keeps no state directory for settings");
    updateConfig(this.home, update);
    return this.get();
  }
}
