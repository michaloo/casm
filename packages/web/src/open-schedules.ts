/** Opens a host's modal on its Schedules tab. The host's sidebar row listens on
 * window for this event; `host` is the RPC host key (empty string = local). */
export const openSchedulesEvent = "casm:open-schedules";
export function openSchedules(host: string) {
  window.dispatchEvent(new CustomEvent(openSchedulesEvent, { detail: { host } }));
}
