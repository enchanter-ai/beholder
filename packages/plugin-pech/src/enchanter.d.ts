/* Ambient declaration so this package's TypeScript build can resolve
   `import { ... } from 'beholder'` without pulling the root sources
   through this package's rootDir. At runtime, the consumer installs
   `beholder` (the peer dependency) and the import resolves normally
   via Node's module resolution. */

declare module 'beholder' {
  // Re-export the canonical adapter shape. The full type comes from the
  // root package; we only need the variable to be typed as `unknown`-safe
  // at this thin re-export boundary. Consumers get the real types from
  // their installed `beholder` package.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const pechAdapter: any;
}
