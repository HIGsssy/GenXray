import { getDb } from "./database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BannedWord {
  id: number;
  word: string;
  partial: boolean;
  addedBy: string;
  addedAt: string;
}

// ---------------------------------------------------------------------------
// Simple in-process cache to avoid a DB round-trip on every generation attempt
// ---------------------------------------------------------------------------

interface CacheEntry {
  words: BannedWord[];
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
let _cache: CacheEntry | null = null;

function invalidateCache(): void {
  _cache = null;
}

function getCachedWords(): BannedWord[] {
  if (_cache && Date.now() < _cache.expiresAt) {
    return _cache.words;
  }
  const words = listBannedWords();
  _cache = { words, expiresAt: Date.now() + CACHE_TTL_MS };
  return words;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function addBannedWord(word: string, partial: boolean, addedBy: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO banned_words (word, partial, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(word) DO UPDATE SET partial = excluded.partial, added_by = excluded.added_by
  `).run(word.trim(), partial ? 1 : 0, addedBy);
  invalidateCache();
}

/** Returns false if the word was not found. */
export function removeBannedWord(word: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM banned_words WHERE word = ? COLLATE NOCASE").run(word.trim());
  if (result.changes > 0) {
    invalidateCache();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listBannedWords(): BannedWord[] {
  const db = getDb();
  const rows = db.prepare("SELECT id, word, partial, added_by, added_at FROM banned_words ORDER BY added_at ASC").all() as {
    id: number;
    word: string;
    partial: number;
    added_by: string;
    added_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    word: r.word,
    partial: r.partial === 1,
    addedBy: r.added_by,
    addedAt: r.added_at,
  }));
}

/**
 * Checks `text` against the banned word list.
 * Returns the list of matched banned words (deduplicated, original casing from DB).
 */
export function checkPrompt(text: string): string[] {
  const words = getCachedWords();
  const matched: string[] = [];
  const lower = text.toLowerCase();

  for (const entry of words) {
    if (entry.partial) {
      if (lower.includes(entry.word.toLowerCase())) {
        matched.push(entry.word);
      }
    } else {
      // Whole-word match using word boundary regex
      const escaped = entry.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(text)) {
        matched.push(entry.word);
      }
    }
  }

  // Deduplicate (case-insensitive duplicates shouldn't exist due to UNIQUE COLLATE NOCASE, but belt-and-suspenders)
  return [...new Set(matched)];
}
