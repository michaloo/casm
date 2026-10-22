import { readFileSync } from "node:fs";

// Same layout in the source checkout and the standalone npm artifact.
export const VERSION: string = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
