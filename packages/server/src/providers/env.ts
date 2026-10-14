// The server's runtime mode must not control agents' npm installs or builds.
// Explicit per-agent settings still take precedence over inherited defaults.
export function providerEnv(overrides?: Record<string, string>): Record<string, string> {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return { ...env, ...overrides } as Record<string, string>;
}
