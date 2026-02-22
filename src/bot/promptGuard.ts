import { checkPrompt } from "../db/bannedWords.js";

/**
 * Checks positive and negative prompts against the banned word list.
 * Returns an array of matched banned terms, or an empty array if clean.
 */
export function guardPrompt(positive: string, negative: string): string[] {
  const hits = new Set<string>();
  for (const w of checkPrompt(positive)) hits.add(w);
  for (const w of checkPrompt(negative)) hits.add(w);
  return [...hits];
}
