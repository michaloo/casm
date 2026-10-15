// Items without their entry times, for tests about everything else.
import type { Item } from "@casm/protocol";

type Untimed<T> = T extends Item[] ? Item[] : Item;
const strip = (i: Item) => { const { at: _at, ...rest } = i as Item & { endedAt?: string }; delete (rest as { endedAt?: string }).endedAt; return rest as Item; };
export function untimed<T extends Item | Item[]>(items: T): Untimed<T> {
  return (Array.isArray(items) ? items.map(strip) : strip(items as Item)) as Untimed<T>;
}
