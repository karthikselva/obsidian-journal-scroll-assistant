/*
 * Journal Scroll Assistant — a Gemini-powered companion for Journal Scroll.
 *
 * Adds a floating button to every Journal Scroll view. From it you can chat
 * about the day in view, compare the day with someone you admire, title and
 * highlight entries, and write a monthly timeline.
 *
 * Everything it produces lives in Markdown, never in plugin data:
 *   - title / highlights / focus  -> the daily note's frontmatter
 *   - comparisons                 -> a folded callout at the end of the daily note
 *   - monthly timelines           -> <journal dir>/<summaries folder>/<YYYY>/<YYYY-MM> Timeline.md
 * Chats are not saved. Plugin settings hold only configuration (API key, model, lists).
 */

const {
  Plugin, PluginSettingTab, Setting, ItemView, Menu, Notice, MarkdownRenderer, Component,
  TFile, TFolder, requestUrl, normalizePath, setIcon, stringifyYaml,
} = require("obsidian");

const JS_VIEW = "journal-scroll-view";
const NAME_RE = /^(\d{2})-(\d{2})-(\d{4})\b/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Comparisons sit between these markers at the end of a daily note. %% comments are hidden when rendered.
const CMP_START = "%% journal-scroll-assistant: comparisons %%";
const CMP_END = "%% /journal-scroll-assistant %%";

// Nov 2026 prices per 1M tokens (in / out): Flash-Lite $0.30 / $2.50, Hydrogen $1.50 / $7.50,
// Argon $2 / $10, Neon $3 / $15, Carbon $2 / $10, rising to $4 / $20 on 1 Dec 2026.
const MODELS = [
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite: fastest, cheapest (default)"],
  ["gemini-4-hydrogen", "Gemini 4 Hydrogen: balanced, Google's general-purpose pick"],
  ["gemini-4-neon", "Gemini 4 Neon: frontier-level, fast"],
  ["gemini-4-argon", "Gemini 4 Argon: efficient frontier reasoning"],
  ["gemini-4-carbon", "Gemini 4 Carbon: most capable, highest cost"],
];

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gemini-3.5-flash-lite",
  personas: "Elon Musk, Steve Jobs, Jensen Huang",
  areas: "Family, Health, Career, Hobbies, Self-realization",
  contextDays: 7,
  summariesFolder: "Summaries",
};

/* ---------------- helpers ---------------- */

function parseDate(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[1]) return null;
  return d;
}

function fmtDate(d) {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function longDate(d) {
  return `${WEEKDAYS[d.getDay()]}, ${fmtDate(d)}`;
}

function splitList(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** Remove the comparisons block (so it is never fed back to the model or duplicated). */
function stripComparisons(text) {
  const a = text.indexOf(CMP_START);
  if (a < 0) return text;
  const b = text.indexOf(CMP_END, a);
  const tail = b < 0 ? "" : text.slice(b + CMP_END.length);
  return (text.slice(0, a).replace(/\s+$/, "") + tail).replace(/\s+$/, "") + "\n";
}

/** Journal prose only: no frontmatter, comparisons or image lines. Captions stay. */
function cleanEntryText(text, fmEnd) {
  if (fmEnd) text = text.slice(fmEnd);
  text = stripComparisons(text);
  return text
    .split("\n")
    .filter((l) => !/^\s*!\[\[[^\]]*\]\]\s*$/.test(l) && !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse the comparisons block into { persona: calloutText } in file order. */
function readComparisons(text) {
  const out = new Map();
  const a = text.indexOf(CMP_START);
  if (a < 0) return out;
  const b = text.indexOf(CMP_END, a);
  const block = text.slice(a + CMP_START.length, b < 0 ? undefined : b);
  const re = /^> \[!compare\][+-]? Compared with (.+)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(block))) heads.push({ persona: m[1].trim(), at: m.index });
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : block.length;
    out.set(h.persona, block.slice(h.at, end).trim());
  });
  return out;
}

/** Return text with the comparison for `persona` added or replaced. */
function writeComparison(text, persona, callout) {
  const all = readComparisons(text);
  all.set(persona, callout.trim());
  const body = stripComparisons(text).replace(/\s+$/, "");
  return `${body}\n\n${CMP_START}\n\n${Array.from(all.values()).join("\n\n")}\n\n${CMP_END}\n`;
}

function quote(md) {
  return md.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

function cell(s) {
  return String(s || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/* ---------------- Gemini ---------------- */

/**
 * One generateContent call. Gemini 4 rejects temperature/top_p/top_k, so none are sent.
 * `thinking` is low | medium | high (the model default is high). If the endpoint rejects
 * the thinking config, the call is retried once without it.
 */
async function gemini(settings, { system, contents, schema, thinking }) {
  if (!settings.apiKey) throw new Error("Add your Gemini API key in Journal Scroll Assistant settings.");
  try {
    return await geminiOnce(settings, { system, contents, schema, thinking });
  } catch (e) {
    if (thinking && e.status === 400 && /thinking/i.test(e.message)) {
      return geminiOnce(settings, { system, contents, schema });
    }
    throw e;
  }
}

async function geminiOnce(settings, { system, contents, schema, thinking }) {
  const generationConfig = {};
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const model = encodeURIComponent((settings.model || DEFAULT_SETTINGS.model).trim());
  const res = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    method: "POST",
    contentType: "application/json",
    headers: { "x-goog-api-key": settings.apiKey.trim() },
    body: JSON.stringify(body),
    throw: false,
  });
  let data = null;
  try { data = res.json; } catch (e) { data = null; }
  if (res.status >= 400) {
    const msg = data && data.error && data.error.message;
    const err = new Error(`Gemini ${res.status}: ${msg || "request failed"}`);
    err.status = res.status;
    throw err;
  }
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) {
    const why = (cand && cand.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason);
    throw new Error(`Gemini returned no text${why ? ` (${why})` : ""}.`);
  }
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("Gemini returned malformed JSON. Try again.");
  }
}

const TITLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    highlights: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["title", "highlights"],
};

const TITLE_SYSTEM = [
  "You title entries in a private daily journal.",
  "title: 3 to 8 words that capture what made this day this day. Be specific (names, places, events).",
  "No date, no quotation marks, no emoji, no trailing full stop.",
  "highlights: 2 to 5 short phrases (at most 10 words each), in the order they happened.",
  "Use only facts written in the entry. Never invent or embellish. Keep the author's own words where you can.",
].join("\n");

/* ---------------- the panel inside a Journal Scroll view ---------------- */

class AssistantPanel extends Component {
  constructor(plugin, view) {
    super();
    this.plugin = plugin;
    this.app = plugin.app;
    this.view = view;
    this.history = [];      // Gemini contents for the current chat; never saved
    this.chatPath = null;   // entry the chat is about
    this.awaitingPersona = false;
    this.busy = false;
  }

  onload() {
    const host = this.view.contentEl;
    host.addClass("jsa-host");
    this.fab = host.createEl("button", { cls: "jsa-fab", attr: { "aria-label": "Journal assistant" } });
    setIcon(this.fab, "sparkles");
    this.registerDomEvent(this.fab, "click", (evt) => this.openMenu(evt));

    this.panel = host.createDiv({ cls: "jsa-panel is-hidden" });
    const head = this.panel.createDiv({ cls: "jsa-head" });
    this.titleEl = head.createDiv({ cls: "jsa-head-title", text: "Journal assistant" });
    const menuBtn = head.createEl("button", { cls: "jsa-icon-btn", attr: { "aria-label": "Actions" } });
    setIcon(menuBtn, "more-horizontal");
    this.registerDomEvent(menuBtn, "click", (evt) => this.openMenu(evt));
    const close = head.createEl("button", { cls: "jsa-icon-btn", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    this.registerDomEvent(close, "click", () => this.hide());

    this.messagesEl = this.panel.createDiv({ cls: "jsa-messages" });
    const form = this.panel.createEl("form", { cls: "jsa-form" });
    this.input = form.createEl("textarea", {
      cls: "jsa-input",
      attr: { rows: "2", placeholder: "Ask about this day…" },
    });
    const send = form.createEl("button", { cls: "jsa-send", attr: { type: "submit", "aria-label": "Send" } });
    setIcon(send, "send");
    this.registerDomEvent(form, "submit", (evt) => {
      evt.preventDefault();
      this.submit();
    });
    this.registerDomEvent(this.input, "keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        this.submit();
      }
    });
    // Journal Scroll turns pages on arrow keys; keep typing and scrolling here to ourselves.
    for (const e of ["keydown", "wheel", "touchstart", "touchend"]) {
      this.registerDomEvent(this.panel, e, (evt) => evt.stopPropagation(), { passive: true });
    }
  }

  onunload() {
    this.fab.remove();
    this.panel.remove();
    this.view.contentEl.removeClass("jsa-host");
  }

  get attached() {
    return this.fab.isConnected;
  }

  show() {
    this.panel.removeClass("is-hidden");
    this.fab.addClass("is-open");
  }

  hide() {
    this.panel.addClass("is-hidden");
    this.fab.removeClass("is-open");
  }

  /* ----- journal access ----- */

  entries() {
    const list = Array.isArray(this.view.entries) ? this.view.entries : [];
    if (list.length) return list.filter((e) => e && e.file instanceof TFile && e.date);
    // Fallback: scan the view's folder ourselves.
    const dir = this.view.dir && this.app.vault.getAbstractFileByPath(this.view.dir);
    if (!(dir instanceof TFolder)) return [];
    const out = [];
    const walk = (f) => {
      for (const c of f.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile && c.extension === "md") {
          const date = parseDate(c.basename);
          if (date) out.push({ file: c, date });
        }
      }
    };
    walk(dir);
    return out.sort((a, b) => a.date - b.date);
  }

  focusEntry() {
    const list = this.entries();
    if (!list.length) return null;
    const path = typeof this.view.currentPath === "function" ? this.view.currentPath() : null;
    const hit = path && list.find((e) => e.file.path === path);
    if (hit) return hit;
    const today = new Date();
    const past = list.filter((e) => e.date <= today);
    return past.length ? past[past.length - 1] : list[list.length - 1];
  }

  async entryText(file) {
    const raw = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const fmEnd = cache && cache.frontmatter && Object.keys(cache.frontmatter).length && cache.frontmatterPosition
      ? cache.frontmatterPosition.end.offset : 0;
    return cleanEntryText(raw.replace(/^﻿/, ""), fmEnd);
  }

  /** The focus day plus up to `days - 1` entries before it, oldest first, as labelled text. */
  async contextFor(entry, days) {
    const list = this.entries();
    const i = list.findIndex((e) => e.file.path === entry.file.path);
    const from = Math.max(0, i - Math.max(1, days) + 1);
    const parts = [];
    for (const e of list.slice(from, i + 1)) {
      const text = await this.entryText(e.file);
      const tag = e === entry ? " (THE DAY IN FOCUS)" : "";
      parts.push(`### ${longDate(e.date)}${tag}\n${text || "(empty entry)"}`);
    }
    return parts.join("\n\n");
  }

  /* ----- menu ----- */

  openMenu(evt) {
    const s = this.plugin.settings;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Chat about this day").setIcon("message-circle")
      .onClick(() => this.startChat()));
    menu.addSeparator();
    for (const p of splitList(s.personas)) {
      menu.addItem((i) => i.setTitle(`Compare with ${p}`).setIcon("users")
        .onClick(() => this.compare(p)));
    }
    menu.addItem((i) => i.setTitle("Compare with someone else…").setIcon("user-plus")
      .onClick(() => this.askPersona()));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Title and highlight this day").setIcon("heading")
      .onClick(() => this.titleDay()));
    menu.addItem((i) => i.setTitle("Title every untitled day this month").setIcon("list-checks")
      .onClick(() => this.titleMonth()));
    menu.addItem((i) => i.setTitle("Summarize this month as a timeline").setIcon("calendar-range")
      .onClick(() => this.monthTimeline()));
    menu.showAtMouseEvent(evt);
  }

  /* ----- messages ----- */

  async addMessage(role, md, { sourcePath, copy } = {}) {
    const el = this.messagesEl.createDiv({ cls: `jsa-msg is-${role}` });
    const body = el.createDiv({ cls: "jsa-msg-body markdown-rendered" });
    if (role === "user") body.setText(md);
    else await MarkdownRenderer.render(this.app, md, body, sourcePath || "", this);
    if (copy) {
      const btn = el.createEl("button", { cls: "jsa-copy", attr: { "aria-label": "Copy" } });
      setIcon(btn, "copy");
      this.registerDomEvent(btn, "click", async () => {
        await navigator.clipboard.writeText(md);
        new Notice("Copied");
      });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return el;
  }

  pending(text) {
    const el = this.messagesEl.createDiv({ cls: "jsa-msg is-assistant is-pending", text });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return el;
  }

  async run(label, fn) {
    if (this.busy) {
      new Notice("The assistant is still working on the last request.");
      return;
    }
    this.busy = true;
    this.show();
    const wait = this.pending(label);
    try {
      await fn(wait);
    } catch (e) {
      await this.addMessage("error", `**Something went wrong.** ${e.message || e}`);
    } finally {
      wait.remove();
      this.busy = false;
    }
  }

  /* ----- chat ----- */

  startChat() {
    const entry = this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    this.awaitingPersona = false;
    if (this.chatPath !== entry.file.path) {
      this.history = [];
      this.chatPath = entry.file.path;
      this.messagesEl.empty();
      const before = this.plugin.settings.contextDays - 1;
      this.addMessage("system", `Chatting about **${longDate(entry.date)}**`
        + (before > 0 ? `, with the ${before} day${before === 1 ? "" : "s"} before it for context.` : "."));
    }
    this.titleEl.setText(`Journal assistant · ${fmtDate(entry.date)}`);
    this.input.setAttr("placeholder", "Ask about this day…");
    this.show();
    this.input.focus();
  }

  async submit() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = "";
    if (this.awaitingPersona) {
      this.awaitingPersona = false;
      this.input.setAttr("placeholder", "Ask about this day…");
      return this.compare(text);
    }
    if (!this.chatPath) this.startChat();
    const entry = this.entries().find((e) => e.file.path === this.chatPath) || this.focusEntry();
    if (!entry) return;
    await this.addMessage("user", text);
    await this.run("Thinking…", async () => {
      const s = this.plugin.settings;
      if (!this.history.length) {
        const ctx = await this.contextFor(entry, s.contextDays);
        this.history.push({ role: "user", parts: [{ text: `My journal:\n\n${ctx}` }] });
        this.history.push({ role: "model", parts: [{ text: "Got it. What would you like to talk about?" }] });
      }
      this.history.push({ role: "user", parts: [{ text }] });
      let reply;
      try {
        reply = await gemini(s, {
          thinking: "medium",
          system: [
            "You help the author of a private daily journal reflect on it.",
            "Answer from the journal text you were given. If it does not say, say so rather than guess.",
            "Be warm but direct, and brief: short paragraphs or bullets. Talk to the author as \"you\".",
          ].join("\n"),
          contents: this.history,
        });
      } catch (e) {
        this.history.pop();
        throw e;
      }
      this.history.push({ role: "model", parts: [{ text: reply }] });
      await this.addMessage("assistant", reply, { sourcePath: entry.file.path, copy: true });
    });
  }

  /* ----- compare ----- */

  askPersona() {
    this.awaitingPersona = true;
    this.show();
    this.addMessage("system", "Who should I compare your day with? Type a name.");
    this.input.setAttr("placeholder", "e.g. Marie Curie");
    this.input.focus();
  }

  async compare(persona) {
    const entry = this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    const s = this.plugin.settings;
    const areas = splitList(s.areas);
    await this.addMessage("user", `Compare ${fmtDate(entry.date)} with ${persona}`);
    await this.run(`Comparing with ${persona}…`, async () => {
      const ctx = await this.contextFor(entry, s.contextDays);
      const res = await gemini(s, {
        thinking: "medium",
        system: [
          "You are a candid, encouraging performance coach.",
          `Compare the author's day in focus with how ${persona} would likely spend a comparable day,`,
          "based on what is publicly known about their habits and priorities. Earlier days are background only.",
          "Ground every claim about the author in the journal text. Never invent events in their life.",
          `Rate each of these life areas for the day in focus: ${areas.join(", ")}.`,
          "level is \"focused\" (clear time or attention), \"some\" (touched on) or \"neglected\" (absent).",
          "Advice must be concrete and doable tomorrow, adapted to the author's life, not a copy of the persona's.",
          "Speak to the author as \"you\".",
        ].join("\n"),
        contents: [{ role: "user", parts: [{ text: `My journal:\n\n${ctx}` }] }],
        schema: {
          type: "OBJECT",
          properties: {
            one_line: { type: "STRING" },
            persona_day: { type: "STRING" },
            went_well: { type: "ARRAY", items: { type: "STRING" } },
            be_more_effective: { type: "ARRAY", items: { type: "STRING" } },
            areas: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  area: { type: "STRING" },
                  level: { type: "STRING", enum: ["focused", "some", "neglected"] },
                  evidence: { type: "STRING" },
                },
                required: ["area", "level", "evidence"],
              },
            },
          },
          required: ["one_line", "persona_day", "went_well", "be_more_effective", "areas"],
        },
      });

      const LEVEL = { focused: "● Focused", some: "◐ Some", neglected: "○ Neglected" };
      const md = [
        `**${res.one_line}**`,
        "",
        `**What ${persona} might be doing:** ${res.persona_day}`,
        "",
        "**What went well**",
        ...(res.went_well || []).map((x) => `- ${x}`),
        "",
        "**Be more effective**",
        ...(res.be_more_effective || []).map((x) => `- ${x}`),
        "",
        "| Area | Focus | Evidence |",
        "| --- | --- | --- |",
        ...(res.areas || []).map((a) => `| ${cell(a.area)} | ${LEVEL[a.level] || cell(a.level)} | ${cell(a.evidence)} |`),
      ].join("\n");

      // Save into the daily note: the callout at the end, the levels in frontmatter.
      const callout = `> [!compare]- Compared with ${persona}\n${quote(md)}`;
      await this.app.vault.process(entry.file, (text) => writeComparison(text, persona, callout));
      await this.plugin.setFrontmatter(entry.file, (fm) => {
        const focus = {};
        for (const a of res.areas || []) if (a.area && a.level) focus[a.area] = a.level;
        fm.focus = focus;
      });
      await this.addMessage("assistant", `### ${fmtDate(entry.date)} vs ${persona}\n\n${md}\n\n`
        + `*Saved to ${entry.file.basename}.*`, { sourcePath: entry.file.path, copy: true });
    });
  }

  /* ----- titles ----- */

  async generateTitle(entry) {
    const text = await this.entryText(entry.file);
    if (!text) return null;
    const res = await gemini(this.plugin.settings, {
      thinking: "low",
      system: TITLE_SYSTEM,
      contents: [{ role: "user", parts: [{ text: `Journal entry for ${longDate(entry.date)}:\n\n${text}` }] }],
      schema: TITLE_SCHEMA,
    });
    const title = String(res.title || "").trim().replace(/^["']|["']$/g, "").replace(/\.$/, "");
    const highlights = (res.highlights || []).map((h) => String(h).trim()).filter(Boolean).slice(0, 5);
    if (!title) return null;
    await this.plugin.setFrontmatter(entry.file, (fm) => {
      fm.title = title;
      fm.highlights = highlights;
    });
    return { title, highlights };
  }

  async titleDay() {
    const entry = this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    await this.run(`Titling ${fmtDate(entry.date)}…`, async () => {
      const r = await this.generateTitle(entry);
      if (!r) return this.addMessage("system", `${fmtDate(entry.date)} has no text to title.`);
      await this.addMessage("assistant", `**${fmtDate(entry.date)} — ${r.title}**\n\n`
        + r.highlights.map((h) => `- ${h}`).join("\n"), { sourcePath: entry.file.path });
    });
  }

  monthEntries(entry) {
    const y = entry.date.getFullYear(), m = entry.date.getMonth();
    return this.entries().filter((e) => e.date.getFullYear() === y && e.date.getMonth() === m);
  }

  async titleMonth() {
    const entry = this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    const todo = this.monthEntries(entry).filter((e) => {
      const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter;
      return !(fm && typeof fm.title === "string" && fm.title.trim());
    });
    const month = `${MONTHS_LONG[entry.date.getMonth()]} ${entry.date.getFullYear()}`;
    if (!todo.length) return this.addMessage("system", `Every entry in ${month} already has a title.`).then(() => this.show());
    await this.run(`Titling ${todo.length} entries in ${month}…`, async (wait) => {
      const lines = [];
      for (const [i, e] of todo.entries()) {
        wait.setText(`Titling ${fmtDate(e.date)} (${i + 1} of ${todo.length})…`);
        try {
          const r = await this.generateTitle(e);
          lines.push(r ? `- **${fmtDate(e.date)}** — ${r.title}` : `- ${fmtDate(e.date)} — skipped (empty)`);
        } catch (err) {
          lines.push(`- ${fmtDate(e.date)} — failed: ${err.message || err}`);
          if (/^Gemini 4(01|03)/.test(err.message || "")) break; // bad key: stop
          await sleep(4000); // likely rate-limited; back off
        }
        await sleep(400);
      }
      await this.addMessage("assistant", `**${month}**\n\n${lines.join("\n")}`);
    });
  }

  /* ----- monthly timeline ----- */

  async monthTimeline() {
    const entry = this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    const list = this.monthEntries(entry);
    const y = entry.date.getFullYear(), m = entry.date.getMonth();
    const month = `${MONTHS_LONG[m]} ${y}`;
    await this.addMessage("user", `Summarize ${month} as a timeline`);
    await this.run(`Reading ${list.length} entries from ${month}…`, async () => {
      const titles = [];
      const parts = [];
      for (const e of list) {
        const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter || {};
        const title = typeof fm.title === "string" ? fm.title.trim() : "";
        titles.push(`- [[${e.file.basename}|${fmtDate(e.date)}]]${title ? ` — ${title}` : ""}`);
        parts.push(`### ${longDate(e.date)}${title ? ` — ${title}` : ""}\n${await this.entryText(e.file)}`);
      }
      const areas = splitList(this.plugin.settings.areas);
      const md = await gemini(this.plugin.settings, {
        thinking: "high",
        system: [
          "You turn a month of private daily journal entries into a timeline the author will keep.",
          "Write Markdown with exactly these sections:",
          "## In a line — one sentence on what the month was about.",
          "## Timeline — grouped by week (### Week of <d Mon>), bullets that start with the date like \"**3 Nov** —\".",
          "## People — who was around and in what context.",
          "## Themes — 3 to 6 recurring threads, one line each.",
          `## Focus — one line each for ${areas.join(", ")}: how much attention it got this month.`,
          "Use only what the entries say. Do not invent. First person is fine (\"I\"), matching the author.",
        ].join("\n"),
        contents: [{ role: "user", parts: [{ text: `Entries for ${month}:\n\n${parts.join("\n\n")}` }] }],
      });

      const s = this.plugin.settings;
      const folder = normalizePath(`${this.view.dir}/${s.summariesFolder || "Summaries"}/${y}`);
      const path = normalizePath(`${folder}/${y}-${String(m + 1).padStart(2, "0")} ${MONTHS[m]} Timeline.md`);
      const fm = stringifyYaml({
        type: "timeline",
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        entries: list.length,
        generated: new Date().toISOString().slice(0, 10),
        model: s.model,
      });
      const note = `---\n${fm}---\n\n# ${month}\n\n${md.trim()}\n\n## Titles\n\n${titles.join("\n")}\n`;
      await this.plugin.ensureFolder(folder);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modify(existing, note);
      else await this.app.vault.create(path, note);
      await this.addMessage("assistant", `${md.trim()}\n\n*Saved to [[${path.replace(/\.md$/, "")}|${month} Timeline]].*`,
        { sourcePath: path, copy: true });
    });
  }
}

/* ---------------- plugin ---------------- */

class JournalScrollAssistant extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Gemini 2.x is being retired (2.5 Flash is rerouted to 3.5 Flash-Lite on 1 Dec 2026).
    if (/^gemini-2[.-]/.test(this.settings.model || "")) {
      this.settings.model = DEFAULT_SETTINGS.model;
      await this.saveSettings();
    }
    this.panels = new Map(); // view -> AssistantPanel
    this.addSettingTab(new AssistantSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.attachAll());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.attachAll()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.attachAll()));

    this.addCommand({
      id: "open",
      name: "Open the assistant in Journal Scroll",
      checkCallback: (checking) => {
        const panel = this.activePanel();
        if (!panel) return false;
        if (!checking) panel.startChat();
        return true;
      },
    });
    this.addCommand({
      id: "title-day",
      name: "Title and highlight the day in view",
      checkCallback: (checking) => {
        const panel = this.activePanel();
        if (!panel) return false;
        if (!checking) panel.titleDay();
        return true;
      },
    });
  }

  onunload() {
    for (const panel of this.panels.values()) panel.unload();
    this.panels.clear();
  }

  activePanel() {
    this.attachAll();
    const active = this.app.workspace.getActiveViewOfType(ItemView);
    const view = active && active.getViewType() === JS_VIEW ? active : null;
    const any = view || (this.app.workspace.getLeavesOfType(JS_VIEW)[0] || {}).view;
    return any ? this.panels.get(any) : null;
  }

  /** Put a panel on every open Journal Scroll view (again, if the view rebuilt its DOM). */
  attachAll() {
    const views = new Set(this.app.workspace.getLeavesOfType(JS_VIEW).map((l) => l.view).filter(Boolean));
    for (const [view, panel] of this.panels) {
      if (!views.has(view) || !panel.attached) {
        panel.unload();
        this.panels.delete(view);
      }
    }
    for (const view of views) {
      if (this.panels.has(view) || !view.contentEl) continue;
      const panel = new AssistantPanel(this, view);
      panel.load();
      this.panels.set(view, panel);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureFolder(path) {
    const parts = normalizePath(path).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
    }
  }

  /**
   * Update a note's frontmatter. Many journal entries open with a "---" section
   * rule that isn't frontmatter, so only real (parsed, non-empty) frontmatter is
   * edited in place; otherwise a fresh block is prepended and the rule kept below it.
   */
  async setFrontmatter(file, mutate) {
    const cache = this.app.metadataCache.getFileCache(file);
    const real = cache && cache.frontmatter && Object.keys(cache.frontmatter).length && cache.frontmatterPosition;
    if (real) {
      await this.app.fileManager.processFrontMatter(file, mutate);
      return;
    }
    const fm = {};
    mutate(fm);
    const parsed = this.waitForMetadata(file);
    await this.app.vault.process(file, (text) => {
      text = text.replace(/^﻿/, "");
      return `---\n${stringifyYaml(fm)}---\n${text.startsWith("---") ? "\n" : ""}${text}`;
    });
    await parsed; // so a follow-up write sees the new frontmatter instead of prepending twice
  }

  waitForMetadata(file) {
    return new Promise((resolve) => {
      const ref = this.app.metadataCache.on("changed", (f) => {
        if (f.path !== file.path) return;
        this.app.metadataCache.offref(ref);
        window.clearTimeout(timer);
        resolve();
      });
      const timer = window.setTimeout(() => {
        this.app.metadataCache.offref(ref);
        resolve();
      }, 3000);
    });
  }
}

class AssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Adds an assistant button to Journal Scroll. Entries you ask about are sent to Google's Gemini API. "
        + "Everything it writes goes into your notes: titles, highlights and focus levels into each entry's "
        + "frontmatter, comparisons at the end of the entry, and monthly timelines into the summaries folder. "
        + "Chats are not saved.",
    });

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("From Google AI Studio (aistudio.google.com/apikey). Kept in this plugin's settings, never in your notes.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("AIza…").setValue(s.apiKey).onChange(async (v) => {
          s.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Flash-Lite is cheapest and fine for titles and quick questions. Hydrogen gives more "
        + "thoughtful comparisons and timelines at about 3-5x the cost. Carbon is the most capable. "
        + "Pick Custom to type any other Gemini model code.")
      .addDropdown((d) => {
        for (const [id, label] of MODELS) d.addOption(id, label);
        d.addOption("custom", "Custom…");
        const known = MODELS.some(([id]) => id === s.model);
        d.setValue(known && !this.customModel ? s.model : "custom").onChange(async (v) => {
          this.customModel = v === "custom";
          if (this.customModel) {
            this.display();
            return;
          }
          s.model = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (!MODELS.some(([id]) => id === s.model)) this.customModel = true;
    if (this.customModel) {
      new Setting(containerEl)
        .setName("Custom model code")
        .setDesc("Exact model code from Google AI Studio, e.g. gemini-3.5-flash-lite.")
        .addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.model).setValue(s.model).onChange(async (v) => {
          s.model = v.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.saveSettings();
        }));
    }

    new Setting(containerEl)
      .setName("People to compare with")
      .setDesc("Comma-separated. Each gets its own item in the assistant menu.")
      .addText((t) => t.setValue(s.personas).onChange(async (v) => {
        s.personas = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Life areas")
      .setDesc("Comma-separated areas rated in comparisons and monthly timelines.")
      .addText((t) => t.setValue(s.areas).onChange(async (v) => {
        s.areas = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Days of context")
      .setDesc("How many days, ending with the day in view, the chat and comparisons can see.")
      .addSlider((sl) => sl.setLimits(1, 14, 1).setValue(s.contextDays).setDynamicTooltip()
        .onChange(async (v) => {
          s.contextDays = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Summaries folder")
      .setDesc("Inside the journal folder. Monthly timelines are saved here, one note per month.")
      .addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.summariesFolder).setValue(s.summariesFolder)
        .onChange(async (v) => {
          s.summariesFolder = v.trim() || DEFAULT_SETTINGS.summariesFolder;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = JournalScrollAssistant;
