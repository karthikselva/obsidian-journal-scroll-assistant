# Journal Scroll Assistant

A Gemini-powered companion for [Journal Scroll](https://github.com/karthikselva/obsidian-journal-scroll). It adds a button to the bottom-right corner of the Journal Scroll view. Click it for:

- **Chat about this day.** Ask about the entry you're reading. The assistant also sees the few days before it.
- **Compare with someone.** See how Elon Musk, Steve Jobs, Jensen Huang, or anyone you name might spend a day like yours. You get what went well, how to be more effective, and which life areas (family, health, career, hobbies, self-realization) got attention or were neglected.
- **Questions to ask** (the 💡 button). Each starts a chat you can follow up on:
  - *Your life*: **Who am I?**, **Who I need to be** and **How far I came** read all your monthly timelines plus every day's title. Each answer is saved as a note in `Summaries/` and replaced when you ask again.
  - *Reflect* on the month: what's going well, what isn't, what to focus on, repeating patterns, what you're putting off, life balance, mood and energy, who you spent time with, gratitude, lessons.
  - *Compare over time*: this week vs last, this month vs last, this month vs a year ago.
  - *Summaries*: this week, this month's accomplishments, open threads and follow-ups.
- **Title and highlight this day**, or **every untitled day this month**. Journal Scroll shows the title and highlights above the entry's date.
- **Summarize this month as a timeline.** Covers weeks, people, themes and focus, with every day's title listed.

## Your data stays in your notes

Everything the assistant writes goes into Markdown in your vault:

| What | Where |
| --- | --- |
| Title, highlights | `title:` and `highlights:` in the entry's frontmatter |
| Life-area focus from a comparison | `focus:` in the entry's frontmatter |
| Comparison write-up | A folded `[!compare]` callout at the end of the entry, one per person, replaced when you compare again |
| Who am I? / Who I need to be / How far I came | `<journal folder>/Summaries/<question>.md`, replaced each time you ask again |
| Monthly timeline | `<journal folder>/Summaries/<YYYY>/<YYYY-MM> <Mon> Timeline.md`, rewritten when you regenerate it |

Chats are not saved. The plugin's own settings hold only configuration: your API key, model and lists.

Entries you ask about are sent to Google's Gemini API using your own key.

## Setup

1. Install and enable Journal Scroll (0.4.0 or later shows titles and highlights).
2. Install this plugin by copying `manifest.json`, `main.js` and `styles.css` into `<vault>/.obsidian/plugins/journal-scroll-assistant/`, then enable it.
3. Paste a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) into the plugin's settings. It uses Gemini 3.5 Flash-Lite by default, the cheapest option. You can switch to a Gemini 4 model (Hydrogen, Neon, Argon, Carbon) or any other model code.
4. Open Journal Scroll and click the ✦ button.
