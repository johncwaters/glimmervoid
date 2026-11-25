export interface FitVerdict {
  fitsTask: boolean | null;
  misfit: string | null;
}

export function standingMisfitOf(verdictsNewestFirst: Iterable<FitVerdict | undefined>): string | null {
  for (const verdict of verdictsNewestFirst) {
    if (verdict !== undefined && verdict.fitsTask !== null) return verdict.misfit;
  }
  return null;
}
