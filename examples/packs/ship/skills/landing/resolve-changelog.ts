import { resolveChangelogConflicts } from "./lib/changelog-merge.ts";
import { Git } from "./lib/git.ts";

const git = new Git(process.cwd());
const checkoutPath = git.run(["rev-parse", "--show-toplevel"]).stdout.trim();
const resolution = resolveChangelogConflicts(git, checkoutPath);
process.stdout.write(`${JSON.stringify(resolution)}\n`);
