import { readSpec } from "./lib/read-spec.ts";

const { report } = readSpec(process.argv[2]);
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = { VALID: 0, INVALID: 1, UNREADABLE: 2 }[report.outcome];
