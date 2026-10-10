import type { TestContext } from 'node:test';

export function stubGlobalForTest(context: TestContext, globalName: string, stubValue: unknown): void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, globalName);
  Object.defineProperty(globalThis, globalName, { configurable: true, value: stubValue });
  context.after(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, globalName, originalDescriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, globalName);
  });
}

export function stubLocalStorageForTest(context: TestContext): Map<string, string> {
  const storedValues = new Map<string, string>();
  stubGlobalForTest(context, 'localStorage', {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
  });
  return storedValues;
}
