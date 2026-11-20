import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deny, readHookInput } from "./hook-input.mjs";

const VALIDATE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "specifying", "validate.ts");
const VALIDATE_TIMEOUT_MS = 8000;

function keyOf(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function realPathOf(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function nearestExistingDirectory(filePath) {
  let directory = path.dirname(filePath);
  while (!fs.existsSync(directory) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  return directory;
}

function gitPathOf(directory, gitArguments) {
  const lookup = spawnSync("git", ["-C", directory, ...gitArguments], { encoding: "utf8", timeout: 3000 });
  if (lookup.status !== 0) return null;
  return lookup.stdout.trim() || null;
}

function checkoutOf(directory) {
  const toplevel = gitPathOf(directory, ["rev-parse", "--show-toplevel"]);
  if (toplevel === null) return null;
  const commonDirectory = gitPathOf(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDirectory === null) return null;
  return { toplevel: realPathOf(toplevel), commonDirectory, repoName: path.basename(path.dirname(commonDirectory)) };
}

function checkoutsTouchedBy(input) {
  const filePaths = Array.isArray(input.tool.filePaths) ? input.tool.filePaths : [];
  const directories = filePaths.length === 0 ? [input.cwd] : filePaths.map((filePath) => nearestExistingDirectory(path.resolve(input.cwd, filePath)));
  const checkoutsByToplevel = new Map();
  for (const directory of new Set(directories)) {
    const checkout = checkoutOf(directory);
    if (checkout !== null) checkoutsByToplevel.set(checkout.toplevel, checkout);
  }
  return [...checkoutsByToplevel.values()];
}

function sessionKeyOf(input) {
  if (typeof input.sessionId === "string" && input.sessionId !== "") return input.sessionId;
  const agentUrlMatch = /\/agent\/([^/?#]+)/.exec(process.env.GLIMMERVOID_AGENT_URL ?? "");
  if (agentUrlMatch) return decodeURIComponent(agentUrlMatch[1]);
  return `ppid-${process.ppid}`;
}

function readMarker(markerPath) {
  try {
    return fs.readFileSync(markerPath, "utf8").trim();
  } catch {
    return null;
  }
}

function writeMarker(markerPath, text) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${text}\n`);
    return true;
  } catch {
    return false;
  }
}

function specNamesCheckout(specPath, toplevel) {
  try {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    return typeof spec.repoRoot === "string" && realPathOf(spec.repoRoot) === toplevel;
  } catch {
    return false;
  }
}

function isSpecValid(specPath) {
  const validation = spawnSync(process.execPath, [VALIDATE_SCRIPT, specPath], { encoding: "utf8", timeout: VALIDATE_TIMEOUT_MS });
  return validation.status === 0;
}

function validSpecFor(checkout) {
  const specDirectory = path.join(os.homedir(), ".local", "state", "ship", "specs", checkout.repoName);
  const specNames = (() => {
    try { return fs.readdirSync(specDirectory); } catch { return []; }
  })();
  return specNames
    .filter((specName) => specName.endsWith(".json") && !specName.endsWith(".intent.json"))
    .map((specName) => path.join(specDirectory, specName))
    .find((specPath) => specNamesCheckout(specPath, checkout.toplevel) && isSpecValid(specPath)) ?? null;
}

function isCheckoutSpecced(checkout) {
  const checkoutMarkerPath = path.join(checkout.commonDirectory, "ship", "spec-gate", "checkouts", keyOf(checkout.toplevel));
  const markedSpecPath = readMarker(checkoutMarkerPath);
  if (markedSpecPath !== null && specNamesCheckout(markedSpecPath, checkout.toplevel)) return true;
  const specPath = validSpecFor(checkout);
  if (specPath === null) return false;
  writeMarker(checkoutMarkerPath, specPath);
  return true;
}

function shouldDenyOnce(checkout, sessionKey) {
  const sessionMarkerPath = path.join(checkout.commonDirectory, "ship", "spec-gate", "sessions", keyOf(sessionKey));
  if (readMarker(sessionMarkerPath) !== null) return false;
  return writeMarker(sessionMarkerPath, checkout.toplevel);
}

const input = readHookInput();
if (input === null || input.tool.kind !== "edit") process.exit(0);
const sessionKey = sessionKeyOf(input);
const unspeccedCheckout = checkoutsTouchedBy(input).find((checkout) => !isCheckoutSpecced(checkout) && shouldDenyOnce(checkout, sessionKey));
if (unspeccedCheckout === undefined) process.exit(0);
deny(`No valid design spec names ${unspeccedCheckout.toplevel}. Run the specifying skill of the ship pack first unless the change is a typo or a mechanical edit with no decision in it; retry the edit to go ahead without one.`);
