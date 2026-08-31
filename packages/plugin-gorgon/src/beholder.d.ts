/* Ambient declaration so this package's TypeScript build can resolve
   `import { ... } from 'beholder'` without pulling root sources through
   this package's rootDir. At consume-time, types resolve from the
   consumer's installed `beholder` package. */

declare module 'beholder' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const gorgonAdapter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const configureGorgon: any;
}
