# Plan: Dropdown Labels on the Generation Form

**Status:** Under consideration  
**Date drafted:** 2026-02-24

---

## Background

The main generation config form (shown after the prompt modal) currently displays four `StringSelectMenu` dropdowns for Model, Sampler, Scheduler, and Size. Each has a placeholder string (e.g. `"Select model…"`) that disappears once a value is chosen. There is no persistent label identifying what each dropdown controls.

The request is to add visible labels — ideally to the right of, or adjacent to, each dropdown.

---

## Discord Platform Constraints

- **No tooltip support.** Discord has no rollover/hover tooltip API for embeds, select menus, or buttons. This is a hard platform limitation and cannot be worked around.
- **No inline text+component layout.** Standard `ActionRow + EmbedBuilder` messages cannot place arbitrary text next to a select menu. Text and interactive components live in separate areas of the message.
- **Components v2** (available in discord.js ≥ 14.16 — the project uses `14.25.1`) is the only Discord-native way to mix `TextDisplay` blocks with interactive components in the same visual area.

---

## Proposed Approach: Components v2

Replace the current `EmbedBuilder` + `ActionRow[]` message structure with a **Components v2 `ContainerBuilder`** that interleaves `TextDisplay` labels and `ActionRow` select menus.

### Visual layout (per dropdown)

```
**Model**
[ animayhemPaleRider_v30PlainsDrifter.safetensors ▾ ]

**Sampler**
[ dpmpp_2m_sde ▾ ]

**Scheduler**
[ karras ▾ ]

**Size**
[ Portrait (832×1216) ▾ ]
```

Labels appear **above** each dropdown (Discord's layout engine does not support side-by-side text + select menu in any configuration).

---

## Implementation Steps

1. **Verify Components v2 exports** — confirm `ContainerBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, and `MessageFlags.IsComponentsV2` are exported from the installed `discord.js@14.25.1`.

2. **Refactor `formEmbed.ts`** — replace `buildFormEmbed()` + `buildSelectRows()` with a new `buildFormComponents(draft, options)` function returning a single `ContainerBuilder` containing:
   - `TextDisplay` block: title, description, current Steps / CFG / Seed / Prompts / LoRAs as formatted markdown
   - `Separator`
   - For each of the 4 selects: `TextDisplay("**Label**")` → `ActionRow([selectMenu])`
   - `Separator` → `ActionRow([Edit Prompts, LoRAs, Generate buttons])`

3. **Update all three render call sites in `interactionCreate.ts`**:
   - Modal submit → first render (`interaction.reply()`)
   - Select menu change → re-render (`interaction.update()`)
   - Edit button on output post → `interaction.reply()`
   
   Each payload changes from:
   ```ts
   { embeds: [buildFormEmbed(draft)], components: [...buildSelectRows(options, draft), buildButtonRow(draft)] }
   ```
   to:
   ```ts
   { components: [buildFormComponents(draft, options)], flags: [MessageFlags.IsComponentsV2] }
   ```

4. **Remove `buildSelectRows` as a public export** — it becomes internal, called from inside `buildFormComponents`.

5. **Confirm `options` (ComfyOptions) availability** at all three render sites — ensure the models/samplers/schedulers lists are accessible wherever the form is re-rendered.

---

## Trade-offs

| | Current (EmbedBuilder) | Proposed (Components v2) |
|---|---|---|
| Dropdown labels | None (placeholder only, disappears on select) | Persistent bold label above each dropdown |
| Info card layout | Clean inline field grid (side-by-side) | Linear markdown text stack |
| Visual polish | Higher | Slightly lower |
| Platform support | Stable, widely supported | Stable as of discord.js 14.16+ |
| Code complexity | Low | Moderate |

---

## Lightweight Alternative (Lower Risk)

Change each dropdown's `placeholder` to always include the field name, e.g.:

```
"Model — animayhemPaleRider…"
"Sampler — dpmpp_2m_sde"
```

- Requires no structural changes
- Placeholder is shown in collapsed state but may be truncated for long model names
- Not a true persistent label; disappears while the menu is open

---

## Files Affected

- [`src/bot/components/formEmbed.ts`](../src/bot/components/formEmbed.ts) — primary change
- [`src/bot/events/interactionCreate.ts`](../src/bot/events/interactionCreate.ts) — three call sites
