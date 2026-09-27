/**
 * Browser environment source.
 *
 * Isolated from `config.ts` so the configuration POLICY is a pure function of an
 * env bag and can be unit-tested without a bundler.
 *
 * The bag is injected by Vite's `define` (see `vite.config.ts`), which replaces
 * the identifier at build time with a literal object. That keeps the exact set
 * of build-time inputs auditable in one place, avoids `import.meta` (so the
 * module compiles for the Node test runner), and means no environment variable
 * outside the declared list can influence the build.
 */

export type EnvBag = Record<string, string | boolean | undefined>;

declare const __OOTLE_ENV__: EnvBag | undefined;

export function readBrowserEnv(): EnvBag {
  // `typeof` guard: in the test build the identifier is not replaced, so it must
  // resolve to an empty configuration rather than throwing.
  if (typeof __OOTLE_ENV__ === 'undefined' || __OOTLE_ENV__ === null) return {};
  return __OOTLE_ENV__;
}
