// Shared by Playwright and its disposable server; never use production state.
// Each Playwright worker owns one server, so workers use consecutive ports and
// separate homes and never share state.
const worker = Number(process.env.TEST_PARALLEL_INDEX ?? "0");
const basePort = Number(process.env.CASM_WEB_TEST_PORT ?? "7495");
const baseHome = process.env.CASM_WEB_TEST_HOME ?? "/tmp/casm-web-dev";
export const testPort = basePort + worker;
if (!Number.isInteger(testPort) || basePort < 1024 || testPort > 65535)
  throw new Error("CASM_WEB_TEST_PORT must be an integer from 1024 to 65535");
export const testHome = worker ? `${baseHome}-w${worker}` : baseHome;
export const testURL = `http://127.0.0.1:${testPort}`;
export const testWS = `ws://127.0.0.1:${testPort}`;
