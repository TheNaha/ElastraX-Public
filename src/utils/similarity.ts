/**
 * @file src/utils/similarity.ts
 * @description Utility for calculating string similarity using Levenshtein distance.
 */

/**
 * Calculates the Levenshtein distance between two strings.
 * The distance is the minimum number of single-character edits (insertions, deletions, or substitutions)
 * required to change one word into the other.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns The Levenshtein distance (0 for identical strings).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Swap to minimize memory allocation (we only need an array of the shortest length)
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const aLen = a.length;
  const bLen = b.length;

  // Use a typed array for faster memory access and reduced GC overhead
  // Uint16Array is sufficient since string lengths won't exceed 65535 in typical chat use-cases
  const row = new Uint16Array(aLen + 1);

  // Initialize the first row
  for (let i = 0; i <= aLen; i++) {
    row[i] = i;
  }

  // Calculate distances using O(min(N, M)) space instead of O(N*M)
  for (let i = 1; i <= bLen; i++) {
    let prev = i;
    let diag = i - 1;
    const bChar = b.charCodeAt(i - 1);

    for (let j = 1; j <= aLen; j++) {
      const up = row[j];

      // Calculate next value (substitution or match)
      // a.charCodeAt(j - 1) === bChar ? 0 : 1
      let next = a.charCodeAt(j - 1) === bChar ? diag : diag + 1;

      // Min of (substitution/match, deletion, insertion)
      if (prev + 1 < next) next = prev + 1;
      if (up + 1 < next) next = up + 1;

      // Update the row values for the next iteration
      row[j - 1] = prev;
      diag = up;
      prev = next;
    }
    // Update the last element of the current row
    row[aLen] = prev;
  }

  return row[aLen];
}
