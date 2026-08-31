/* Ambient declaration so this package's TypeScript build can resolve
   `import { ... } from 'beholder'` without pulling root sources through
   this package's rootDir. At consume-time, types resolve from the
   consumer's installed `beholder` package. */

declare module 'beholder' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const hydraAdapter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const configureHydra: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const maskSecrets: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const matchCvePatterns: any;
}
