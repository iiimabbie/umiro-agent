export interface ContextTokenEstimator {
  estimate(text: string): number;
}

/** Provider-neutral fallback used when a model-specific tokenizer is not
 * installed. ASCII is estimated in short subword groups; non-ASCII code
 * points are charged conservatively. */
export const HEURISTIC_CONTEXT_TOKEN_ESTIMATOR: ContextTokenEstimator = {
  estimate(text: string): number {
    let ascii = 0; let nonAscii = 0;
    for (const character of text) {
      if (character.codePointAt(0)! <= 0x7f) ascii += 1;
      else nonAscii += 1;
    }
    return Math.ceil(ascii / 3) + nonAscii * 2;
  },
};
