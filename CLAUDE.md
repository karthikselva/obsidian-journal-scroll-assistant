# Journal Scroll Assistant — Obsidian plugin

Companion to `D:\GitRepos\obsidian-journal-scroll` (view type `journal-scroll-view`). Same conventions as that repo: plain CommonJS, no build step, only `require("obsidian")`, mobile-safe (`requestUrl`, no Node APIs), no `innerHTML`/`el.style`/console logging, sentence-case UI.

## Releasing

Public repo `karthikselva/obsidian-journal-scroll-assistant`. Bump `manifest.json` and add the version to `versions.json`, commit and push, then `git tag <x.y.z> && git push origin <x.y.z>` (no `v`). `.github/workflows/release.yml` attests and attaches `main.js`, `manifest.json` and `styles.css`. Don't create releases by hand. The Obsidian community directory listing is managed at community.obsidian.md → Account → Plugins.

## Hard rule: no data outside Markdown

The owner's requirement: every output lives in the daily notes or in Markdown under the journal folder. Plugin `data.json` holds **configuration only** (API key, model, personas, areas, context days, summaries folder). Never cache titles, chats or results there.

- Title/highlights → frontmatter `title`, `highlights`. Comparison focus → frontmatter `focus` (area → focused|some|neglected).
- Comparisons → callouts between `%% journal-scroll-assistant: comparisons %%` and `%% /journal-scroll-assistant %%` at the end of the note. `writeComparison` replaces by persona. `cleanEntryText` strips the block and image lines before anything is sent to Gemini, so outputs never feed back in.
- Monthly timeline → `<view.dir>/<summariesFolder>/<YYYY>/<YYYY-MM> <Mon> Timeline.md`. The name does not match Journal Scroll's `DD-MM-YYYY` pattern, so it never shows up as an entry.

## Frontmatter gotcha

Many entries open with a `---` **section rule**, not frontmatter. `setFrontmatter` edits in place only when the metadata cache has real, non-empty frontmatter. Otherwise it prepends a fresh block and keeps the rule below it, then waits for the cache `changed` event so a second write doesn't prepend twice. Journal Scroll uses the same "non-empty parsed frontmatter" test to strip it.

## Architecture (`main.js`)

- `JournalScrollAssistant` attaches one `AssistantPanel` (a `Component`) per Journal Scroll view on `layout-change`/`active-leaf-change`, and re-attaches when the view rebuilt its DOM.
- `AssistantPanel` reads `view.entries` (`[{file, date}]`), `view.dir` and `view.currentPath()` from Journal Scroll (duck-typed; it falls back to scanning `view.dir`). The day in focus is `currentPath()`, falling back to the latest entry on or before today.
- The floating button opens an Obsidian `Menu`. The panel stops `keydown`/`wheel`/touch propagation, because Journal Scroll turns book pages on arrow keys.
- Chats: `newChat(key, sourcePath, contextFn)` resets the chat. `ask(text, shown, after)` loads `contextFn()` on the first turn, then sends. `after(reply)` runs inside the busy section, which is how life answers get saved. Day chats are keyed `day:<path>`, presets `<scope>:<path>`.
- Presets: `PRESETS` / `PRESET_GROUPS`, shown as chips by `showSuggestions()` and run by `askPreset()`. The scopes week, month, week-compare, month-compare and year-compare come from `periodsFor()`. The `life` scope reads every `<summaries>/**/<YYYY-MM> <Mon> Timeline.md` (minus its `## Titles` list) plus a one-line-per-day title index. Its first answer is saved to `<summaries>/<save>.md` (`saveLifeNote`) and overwritten when regenerated. Follow-up answers are not saved.
- `gemini()` retries 429/5xx with 2s, 5s and 12s backoff (progress shown in the pending bubble via `this.onRetry`, set in `run()`), then fails with a message naming the model. → `POST v1beta/models/<model>:generateContent` with `x-goog-api-key`. Default model `gemini-3.5-flash-lite`, chosen by the owner for cost (picker: Flash-Lite, the four Gemini 4 models, custom; saved `gemini-2.*` values migrate on load). **No `temperature`/`top_p`/`top_k`**: Gemini 4 rejects out-of-range values with a 400. Effort is `thinkingConfig.thinkingLevel` per task (titles low, chat/compare medium, timeline high); a 400 mentioning thinking retries once without it, because that REST field name was not confirmed for Gemini 4. A JSON `responseSchema` is used for titles and comparisons, plain text for chat and timelines. Thought parts are dropped.

Verify by loading in a real vault. There are no tests or API mocks.
