// The part of a cumulative tool output snapshot not yet streamed. Snapshots
// keep the tail when output grows large, so after a cut the overlap is found
// by the previous tail.
export function outputDelta(prev: string, next: string): string {
  if (next.startsWith(prev)) return next.slice(prev.length);
  const tail = prev.slice(-Math.min(200, Math.ceil(prev.length / 2)));
  const at = tail ? next.lastIndexOf(tail) : -1;
  return at >= 0 ? next.slice(at + tail.length) : next;
}
