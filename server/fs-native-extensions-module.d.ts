declare module 'fs-native-extensions' {
  interface LockOptions {
    shared?: boolean;
  }
  export function tryLock(fd: number, options?: LockOptions): boolean;
  export function unlock(fd: number): void;
  export function waitForLockSync(fd: number, options?: LockOptions): void;
}
