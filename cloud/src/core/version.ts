/**
 * Best-effort dotted-version compare (PEP 440-ish, not a full parser):
 * numeric segments compare numerically, non-numeric segments compare as
 * strings, missing trailing segments count as 0. Good enough for the
 * versions this project publishes (`0.1.18`, `0.2.0`).
 *
 * Returns a negative number when `a < b`, 0 when equal, positive when
 * `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? "0";
    const bv = bs[i] ?? "0";
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}
