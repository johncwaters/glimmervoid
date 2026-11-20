import os from "node:os";
import path from "node:path";

export function specsDirectory(): string {
  return path.join(os.homedir(), ".agents", "specs");
}

export function specArchiveDirectory(): string {
  return path.join(os.homedir(), ".agents", "spec-archive");
}
