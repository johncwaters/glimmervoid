export function isTreeContained(mergeTreeStdout: string, mainlineTreeOid: string): boolean {
  const firstOutputLine = mergeTreeStdout.split("\n").find((line) => line.trim() !== "");
  if (firstOutputLine === undefined) {
    return false;
  }
  const mergeTreeOid = firstOutputLine.trim();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(mergeTreeOid)) {
    return false;
  }
  return mergeTreeOid === mainlineTreeOid;
}
