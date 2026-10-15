/** Shared entry point for the central schedules modal. The modal owner listens
 * on window for this event; `host` is the RPC host key (empty string = local). */
export const openSchedulesEvent = "casm:open-schedules";
export function openSchedules(host: string) {
  window.dispatchEvent(new CustomEvent(openSchedulesEvent, { detail: { host } }));
}
