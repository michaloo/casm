// Shared by Playwright and its disposable server; never use production state.
export const testHome = process.env.CASM_WEB_TEST_HOME ?? "/tmp/casm-web-dev";
export const testPort = Number(process.env.CASM_WEB_TEST_PORT ?? "7495");
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535)
  throw new Error("CASM_WEB_TEST_PORT must be an integer from 1024 to 65535");
export const testURL = `http://127.0.0.1:${testPort}`;
export const testWS = `ws://127.0.0.1:${testPort}`;
