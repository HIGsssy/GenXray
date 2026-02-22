CREATE TABLE IF NOT EXISTS banned_words (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  word      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  partial   INTEGER NOT NULL DEFAULT 0,  -- 1 = substring match, 0 = whole-word only
  added_by  TEXT    NOT NULL,            -- Discord user ID of the admin who added it
  added_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
