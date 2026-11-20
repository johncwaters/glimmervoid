import fs from "node:fs";

function readHookInput() {
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (input?.version !== 1 || typeof input.tool !== "object" || input.tool === null) return null;
    return input;
  } catch {
    return null;
  }
}

function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

export { deny, readHookInput };
