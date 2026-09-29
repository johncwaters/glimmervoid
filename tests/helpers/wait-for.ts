import assert from 'node:assert/strict';

const FS_WATCH_ARM_MS = 300;

async function waitFor(predicate: () => boolean, label = 'condition became true', deadlineMs = 1000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), label);
}

async function waitForFsWatchToArm(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, FS_WATCH_ARM_MS));
}

export { waitFor, waitForFsWatchToArm };
