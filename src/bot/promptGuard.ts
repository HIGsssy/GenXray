import { checkPrompt } from "../db/bannedWords.js";

/**
 * Checks the positive prompt against the banned word list.
 * Returns an array of matched banned terms, or an empty array if clean.
 */
export function guardPrompt(positive: string): string[] {
  return checkPrompt(positive);
}
