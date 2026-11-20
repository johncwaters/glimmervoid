import fs from "node:fs";
import path from "node:path";

export function repoRequiresSignoff(repoRoot: string): boolean {
  const dcoPath = ".github/dco.yml";
  if (fs.existsSync(path.join(repoRoot, dcoPath))) {
    return true;
  }

  const workflowsPath = path.join(repoRoot, ".github/workflows");
  if (fs.existsSync(workflowsPath)) {
    const workflowFiles = fs.readdirSync(workflowsPath, { withFileTypes: true });
    for (const workflowFile of workflowFiles) {
      if (!workflowFile.isFile() || !/\.ya?ml$/.test(workflowFile.name)) {
        continue;
      }
      const workflowPath = `.github/workflows/${workflowFile.name}`;
      if (/dco/i.test(fs.readFileSync(path.join(repoRoot, workflowPath), "utf8"))) {
        return true;
      }
    }
  }

  for (const contributingPath of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]) {
    const contributingFile = path.join(repoRoot, contributingPath);
    if (!fs.existsSync(contributingFile)) {
      continue;
    }
    if (/Signed-off-by|Developer Certificate of Origin/.test(fs.readFileSync(contributingFile, "utf8"))) {
      return true;
    }
  }

  return false;
}
