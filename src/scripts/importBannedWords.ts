/**
 * Import banned words from data/banned_words_seed.txt into the database.
 * Run with: npm run import-banned-words
 *
 * File format (one entry per line):
 *   word               → whole-word match
 *   word:partial       → substring match
 *   # comment          → ignored
 *   (blank line)       → ignored
 *
 * Re-running is idempotent — existing entries are updated in-place.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addBannedWord } from "../db/bannedWords.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = resolve(__dirname, "../../data/banned_words_seed.txt");
const SYSTEM_USER = "system";

let added = 0;
let skipped = 0;

const raw = readFileSync(SEED_FILE, "utf-8");
const lines = raw.split("\n");

for (const rawLine of lines) {
  const line = rawLine.trim();

  // Skip comments and blank lines
  if (!line || line.startsWith("#")) {
    skipped++;
    continue;
  }

  const partial = line.endsWith(":partial");
  const word = partial ? line.slice(0, -":partial".length).trim() : line;

  if (!word) {
    skipped++;
    continue;
  }

  addBannedWord(word, partial, SYSTEM_USER);
  console.log(`  + "${word}" (${partial ? "partial" : "whole-word"})`);
  added++;
}

console.log(`\nDone. ${added} word(s) imported, ${skipped} line(s) skipped.`);
