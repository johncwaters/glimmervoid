import os from "node:os";
import path from "node:path";

export function specsDirectory(): string {
  return path.join(os.homedir(), ".local", "state", "ship", "specs");
}

export function specArchiveDirectory(): string {
  return path.join(os.homedir(), ".local", "state", "ship", "spec-archive");
}
