# Journal Scroll Assistant

[![Add to Obsidian](https://img.shields.io/badge/Add_to-Obsidian-7C3AED?style=for-the-badge&logo=obsidian&logoColor=white)](https://community.obsidian.md/plugins/journal-scroll-assistant)

An AI companion for [Journal Scroll](https://github.com/karthikselva/obsidian-journal-scroll), using the model you choose: **Google Gemini, OpenAI (ChatGPT), Anthropic (Claude) or Hermes (Nous Portal**, which serves DeepSeek V4 and more). It adds a ✦ button to the corner of the Journal Scroll view, and a quiet row of **Chat · Compare · Regenerate · Summarize** buttons at the end of each day. They give you:

- **Chat about this day.** Ask about the entry you're reading. The assistant also sees the few days before it.
- **Compare with someone.** See how Elon Musk, Steve Jobs, Jensen Huang, or anyone you name might spend a day like yours. If they were alive that day and in the news, the comparison opens with what the news said they did (with links to the articles) and builds their day around it; otherwise it uses their usual routine. An hour-by-hour table sets what they'd be doing next to what you did, at 6 AM, 9 AM, 12 PM, 4 PM and 9 PM (you can change these) plus any times you wrote down. Where your entry doesn't say, it shows "Not in the journal" rather than a guess. Then you get what went well, how to be more effective, and how each life area fared that day.
- **Compare with another day:** the same day last month, last year, or any month or year you pick. An hour-by-hour table, what got better, what slipped, and what to carry forward.
- **Questions to ask** (the 💡 button). Each starts a chat you can follow up on:
  - *Your life*: **Who am I?**, **Who I need to be** and **How far I came** read all your monthly timelines plus every day's title. Each answer is saved as a note in `Summaries/` and replaced when you ask again.
  - *Reflect* on the month: what's going well, what isn't, what to focus on, repeating patterns, what you're putting off, life balance, mood and energy, who you spent time with, gratitude, lessons.
  - *Compare over time*: this week vs last, this month vs last, this month vs a year ago.
  - *Summaries*: this week, this month's accomplishments, open threads and follow-ups.
- **Title, highlight and rate this day**, every day this month, any month you pick, or the whole journal. A long run can be stopped. Each day is rated on six life areas, Family, Networking, Health, Career, Hobbies and Growth: focused, some, neglected (the entry shows it was skipped or pushed aside) or not today (it just didn't come up). Journal Scroll shows the ratings as signal meters on the date bar. You can change the areas in settings, and **Re-rate life areas in a month…** updates days you've already rated. Days that already have a title keep it and only get the missing ratings. Journal Scroll shows the title and highlights above the entry's date.
- **Fill in everything missing**, once, for the whole journal: a title, highlights and current life-area ratings for every day that lacks any. Titles and highlights you already have are kept. Three days at a time; stop and resume whenever you like.
- **Summarize this month, quarter or year.** The month becomes a timeline (weeks, people, themes, focus, every day's title); quarters and years become a review with highlights, themes and what to carry forward.
- **Switch models from the chat.** A picker in the panel header lists every model from the providers you've switched on, grouped by provider. If a request fails, the error offers *Try again with [model] · Retry*, and every answer says which model wrote it.

## Your data stays in your notes

Everything the assistant writes goes into Markdown in your vault:

| What | Where |
| --- | --- |
| Title, highlights, life-area ratings | `title:` and `highlights:` in the entry's frontmatter |
| Life-area focus from a comparison | `focus:` in the entry's frontmatter |
| Comparison write-up | A folded `[!compare]` callout at the end of the entry, one per person, replaced when you compare again |
| Who am I? / Who I need to be / How far I came | `<journal folder>/Summaries/<question>.md`, replaced each time you ask again |
| Monthly timeline | `<journal folder>/Summaries/<YYYY>/<YYYY-MM> <Mon> Timeline.md`, rewritten when you regenerate it |
| Quarter / year review | `<journal folder>/Summaries/<YYYY>/<YYYY>-Q<n> Summary.md` and `<YYYY> Year Summary.md` |

Chats are not saved. The plugin's own settings hold only configuration: your API keys, models and lists.

Entries you ask about are sent to the provider of the model you picked, using your own key. When you compare a day with a person, their **name and the date** (never your journal) are looked up on Wikidata, to check they were alive then, and Google News, for that day's headlines. Turn that off with *Use the news about living people*.

## Setup

1. Install and enable Journal Scroll (0.4.0 or later shows titles and highlights).
2. Install this plugin. In Obsidian, open *Settings → Community plugins → Browse*, search for **Journal Scroll Assistant**, then choose *Install* and *Enable*. Or open its [page in the Obsidian Community directory](https://community.obsidian.md/plugins/journal-scroll-assistant) and click **Add to Obsidian**. To install by hand instead, copy `manifest.json`, `main.js` and `styles.css` from the [latest release](https://github.com/karthikselva/obsidian-journal-scroll-assistant/releases/latest) into `<vault>/.obsidian/plugins/journal-scroll-assistant/`, then enable it.
3. In the plugin's settings, under **Models**, switch on one or more providers and paste each one's API key: [Google AI Studio](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys), the [Claude Console](https://platform.claude.com) or [Nous Portal](https://portal.nousresearch.com). Pick models from the suggestions (or **Load models** to fetch what your key can use), and press **Test**. Gemini 3.5 Flash-Lite is the cheapest choice for titling a whole journal.
4. Open Journal Scroll and click the ✦ button, or use the buttons at the end of any day.

People to compare with and life areas are picked from suggestion lists (people known for a well-documented routine and a big vision; common life areas), or typed in.
