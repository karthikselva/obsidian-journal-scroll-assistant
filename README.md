# Journal Scroll Assistant

A Gemini-powered companion for [Journal Scroll](https://github.com/karthikselva/obsidian-journal-scroll). It adds a button to the bottom-right corner of the Journal Scroll view. Click it for:

- **Chat about this day.** Ask about the entry you're reading. The assistant also sees the few days before it.
- **Compare with someone.** See how Elon Musk, Steve Jobs, Jensen Huang, or anyone you name might spend a day like yours. You get what went well, how to be more effective, and which life areas (family, health, career, hobbies, self-realization) got attention or were neglected.
- **Title and highlight this day**, or **every untitled day this month**. Journal Scroll shows the title and highlights above the entry's date.
- **Summarize this month as a timeline.** Covers weeks, people, themes and focus, with every day's title listed.

## Your data stays in your notes

Everything the assistant writes goes into Markdown in your vault:

| What | Where |
| --- | --- |
| Title, highlights | `title:` and `highlights:` in the entry's frontmatter |
| Life-area focus from a comparison | `focus:` in the entry's frontmatter |
| Comparison write-up | A folded `[!compare]` callout at the end of the entry, one per person, replaced when you compare again |
| Monthly timeline | `<journal folder>/Summaries/<YYYY>/<YYYY-MM> <Mon> Timeline.md`, rewritten when you regenerate it |

Chats are not saved. The plugin's own settings hold only configuration: your API key, model and lists.

Entries you ask about are sent to Google's Gemini API using your own key.

## Setup

1. Install and enable Journal Scroll (0.4.0 or later shows titles and highlights).
2. Install this plugin by copying `manifest.json`, `main.js` and `styles.css` into `<vault>/.obsidian/plugins/journal-scroll-assistant/`, then enable it.
3. Paste a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) into the plugin's settings.
4. Open Journal Scroll and click the ✦ button.
