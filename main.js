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
  Plugin, PluginSettingTab, Setting, ItemView, Menu, Notice, MarkdownRenderer, Component, SuggestModal,
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

/*
 * Ready-made questions. scope picks the journal text the chat sees:
 *   week          the 7 days ending with the day in view
 *   month         the calendar month of the day in view
 *   week-compare  that week and the 7 days before it
 *   month-compare that month and the month before
 *   year-compare  that month and the same month a year earlier
 *   life          every monthly timeline note plus every day's title; the first answer is
 *                 saved (and replaced on regeneration) as <summaries>/<save>.md
 * {areas} is replaced with the life areas from settings.
 */
const PRESET_GROUPS = ["Your life", "Reflect", "Compare over time", "Summaries"];
const PRESETS = [
  { group: "Your life", icon: "fingerprint", scope: "life", label: "Who am I?", save: "Who am I",
    q: "From my monthly timelines and day titles, write a portrait of who I am right now: my roles, what I care "
      + "about, how I actually spend my days, my strengths, my recurring struggles, the people who matter and what "
      + "drives me. Ground every point in evidence (months or dates). Write it to me as \"you\". "
      + "End with three sentences that capture me." },
  { group: "Your life", icon: "compass", scope: "life", label: "Who I need to be", save: "Who I need to be",
    q: "Based on who I have been across these timelines (my goals, frustrations and what keeps recurring), describe "
      + "who I need to become over the next year: the traits, habits and priorities to grow, what to let go of, "
      + "and the first three concrete steps. Ground it in evidence. Be honest, not flattering." },
  { group: "Your life", icon: "mountain", scope: "life", label: "How far I came", save: "How far I came",
    q: "Trace how far I have come from the earliest period here to the latest: what changed in work, family, health, "
      + "hobbies, skills and mindset; the turning points, with dates; and what stayed the same. "
      + "End with what this trajectory suggests comes next." },
  { group: "Reflect", icon: "thumbs-up", scope: "month", label: "What's going well this month?",
    q: "What is going well for me this month? Group it by theme and cite the dates that show it." },
  { group: "Reflect", icon: "thumbs-down", scope: "month", label: "What's not going well?",
    q: "What is not going well for me this month? Be honest and point to the entries that show it." },
  { group: "Reflect", icon: "target", scope: "month", label: "What should I focus on?",
    q: "Based on this month, what are the 3 to 5 things I most need to focus on next, and why? "
      + "Make each one concrete and doable." },
  { group: "Reflect", icon: "repeat", scope: "month", label: "What patterns keep repeating?",
    q: "What patterns repeat across this month: sleep, energy, habits, work rhythm, moods, food? "
      + "Separate the helpful ones from the unhelpful ones." },
  { group: "Reflect", icon: "hourglass", scope: "month", label: "What am I putting off?",
    q: "What am I avoiding, postponing or leaving unfinished this month? Look for plans I mention but never follow up." },
  { group: "Reflect", icon: "scale", scope: "month", label: "How balanced is my life?",
    q: "How much attention did each of my life areas get this month: {areas}? For each: focused, some, "
      + "neglected or barely present, the evidence, and one small change." },
  { group: "Reflect", icon: "activity", scope: "month", label: "How have my mood and energy been?",
    q: "How did my mood and energy move through this month? Where were the highs and lows, and what seems to drive them?" },
  { group: "Reflect", icon: "users", scope: "month", label: "Who have I spent time with?",
    q: "Who did I spend time with this month, how often and in what context? Who important seems to be missing?" },
  { group: "Reflect", icon: "heart", scope: "month", label: "What can I be grateful for?",
    q: "Which moments this month can I be grateful for? List specific ones with their dates." },
  { group: "Reflect", icon: "graduation-cap", scope: "month", label: "What did this month teach me?",
    q: "What lessons does this month hold? Give 3 to 5, each drawn from a specific moment, with its date." },
  { group: "Compare over time", icon: "git-compare", scope: "week-compare", label: "This week vs last week",
    q: "Compare this week with the week before it: what improved, what slipped, and what should I carry forward?" },
  { group: "Compare over time", icon: "calendar-range", scope: "month-compare", label: "This month vs last month",
    q: "Compare this month with last month: what changed in my work, family, health, hobbies and mindset? "
      + "What improved and what slipped?" },
  { group: "Compare over time", icon: "history", scope: "year-compare", label: "This month vs a year ago",
    q: "Compare this month with the same month last year. How has my life changed? "
      + "What have I grown in, and what have I lost or let go?" },
  { group: "Summaries", icon: "calendar-days", scope: "week", label: "Summarize this week",
    q: "Summarize my week in one short paragraph, then list the key events as bullets with dates." },
  { group: "Summaries", icon: "trophy", scope: "month", label: "What did I get done this month?",
    q: "List what I accomplished this month, big and small, with dates, grouped by area." },
  { group: "Summaries", icon: "list-todo", scope: "month", label: "Open threads and follow-ups",
    q: "List the open threads from this month: things I started, promised, planned or worried about that show "
      + "no resolution yet. Include dates." },
];

const CHAT_SYSTEM = [
  "You help the author of a private daily journal reflect on it.",
  "Answer only from the journal text you were given, and cite dates (e.g. \"12 Nov\") or months as evidence.",
  "If the text doesn't cover something, say so rather than guess. Never invent events.",
  "Be warm but honest and direct. Use short paragraphs or bullets. Talk to the author as \"you\".",
].join("\n");

// What each default life area covers, sent with every rating so the model rates consistently.
// Areas the user adds in settings without a definition here are rated by their name alone.
const AREA_DEFS = {
  family: "time and attention with partner, children, parents and relatives",
  networking: "time with people outside the family: friends, peers, the professional network, meetups and community events",
  health: "sleep, food, exercise, medical care and rest",
  career: "output at work: doing the job, shipping, earning, building the business, calls, demos, applications",
  hobbies: "play and making things for their own sake: hobbies, games, crafts, music, tinkering",
  growth: "investing in yourself: learning, reading, courses, practising a skill, deliberate reflection, spirituality",
};

const OLD_DEFAULT_AREAS = "Family, Health, Career, Hobbies, Self-realization";

// The four ratings. "none" (shown as "not today") is neutral: the area just didn't come up.
const LEVELS = ["focused", "some", "neglected", "none"];
const RATING_SCALE = [
  "Rate each life area for the day from the entry alone:",
  "- \"focused\": clear, deliberate time or effort went into it.",
  "- \"some\": touched on briefly.",
  "- \"neglected\": the entry shows it was skipped, given up or pushed aside (e.g. \"skipped the gym again\", "
    + "\"no time for the kids\", \"slept only 4 hours\").",
  "- \"none\": not mentioned and no sign either way. Use this, not \"neglected\", when the entry is simply silent.",
].join("\n");

function areaGuide(areas) {
  return areas.map((a) => {
    const d = AREA_DEFS[a.toLowerCase()];
    return `- ${a}${d ? `: ${d}` : ""}`;
  }).join("\n");
}

const DEFAULT_SETTINGS = {
  // Per provider: { enabled, apiKey, baseUrl, models: [] }. Filled in by onload (see PROVIDERS).
  providers: {},
  activeModel: "",          // "<provider>::<model>"; empty = the first model of the first enabled provider
  personas: "Elon Musk, Steve Jobs, Jensen Huang",
  personaNews: true,        // comparisons with a living person use that day's news about them
  areas: "Family, Networking, Health, Career, Hobbies, Growth",
  contextDays: 7,
  compareTimes: "6 AM, 9 AM, 12 PM, 4 PM, 9 PM",
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

/** Minutes after midnight for "6 AM", "9:30 am", "12 PM", "21:00"; Infinity if unparseable. */
function timeOfDay(t) {
  const m = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i.exec(String(t || ""));
  if (!m) return Infinity;
  let h = +m[1] % 24;
  const min = m[2] ? +m[2] : 0;
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h * 60 + min;
}

/** Sort key for a journal day, which runs past midnight: 12:30 AM comes after 9 PM, not before 6 AM. */
function dayOrder(t) {
  const m = timeOfDay(t);
  return m < 4 * 60 ? m + 24 * 60 : m;
}

function quote(md) {
  return md.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

function cell(s) {
  return String(s || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/* ---------------- model providers ---------------- */
/*
 * Every request goes through llm(), which sends it to the active model: "<provider>::<model>"
 * in settings.activeModel, picked in settings or from the chat header. Requests are written
 * once in Gemini's shape ({ system, contents: [{ role: "user"|"model", parts: [{ text }] }],
 * schema, thinking }) and translated for each provider here:
 *   gemini     Google's generateContent API
 *   openai     any OpenAI-compatible /chat/completions API: OpenAI itself, and Hermes
 *              (Nous Portal's inference API, which serves DeepSeek, Hermes and more)
 *   anthropic  the Claude Messages API
 * All are plain HTTPS through Obsidian's requestUrl (no SDKs: this plugin has no build step).
 */
const PROVIDERS = [
  {
    id: "gemini", kind: "gemini", label: "Google Gemini", short: "Gemini",
    blurb: "Google's Gemini API. Key from Google AI Studio (aistudio.google.com/apikey).",
    keyPlaceholder: "AIza…",
    defaultModels: ["gemini-3.5-flash-lite"],
    suggestions: MODELS.map(([name, hint]) => ({ name, hint })),
  },
  {
    id: "openai", kind: "openai", label: "OpenAI (ChatGPT)", short: "ChatGPT",
    blurb: "ChatGPT models through the OpenAI API. Key from platform.openai.com/api-keys "
      + "(a ChatGPT subscription doesn't include API access).",
    keyPlaceholder: "sk-…",
    baseUrl: "https://api.openai.com/v1",
    defaultModels: ["gpt-5.5"],
    suggestions: [
      { name: "gpt-6-astra", hint: "Newest flagship" },
      { name: "gpt-5.6-sol", hint: "GPT-5.6, largest" },
      { name: "gpt-5.6-terra", hint: "GPT-5.6, balanced" },
      { name: "gpt-5.6-luna", hint: "GPT-5.6, fastest" },
      { name: "gpt-5.5", hint: "GPT-5.5" },
      { name: "gpt-5.4-mini", hint: "Small and cheap" },
    ],
  },
  {
    id: "anthropic", kind: "anthropic", label: "Anthropic (Claude)", short: "Claude",
    blurb: "Claude models through the Claude API. Key from the Claude Console (platform.claude.com).",
    keyPlaceholder: "sk-ant-…",
    defaultModels: ["claude-opus-5-5"],
    suggestions: [
      { name: "claude-opus-5-5", hint: "Claude Opus 5.5: most capable Opus, the default" },
      { name: "claude-sonnet-5-5", hint: "Claude Sonnet 5.5: fast and capable, lower cost" },
      { name: "claude-haiku-5-5", hint: "Claude Haiku 5.5: fastest, cheapest" },
      { name: "claude-fable-5-2", hint: "Claude Fable 5.2: Anthropic's most capable, highest cost" },
    ],
  },
  {
    id: "hermes", kind: "openai", label: "Hermes (Nous Portal)", short: "Hermes",
    blurb: "Nous Research's inference API, the provider behind Hermes Agent. One key for DeepSeek V4, "
      + "Hermes and many others. Key from portal.nousresearch.com.",
    keyPlaceholder: "Nous Portal API key",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    defaultModels: ["deepseek/deepseek-v4-flash-0731"],
    suggestions: [
      { name: "deepseek/deepseek-v4-flash-0731", hint: "DeepSeek V4 Flash: fast, very cheap" },
      { name: "deepseek/deepseek-v4-pro", hint: "DeepSeek V4 Pro: stronger reasoning" },
      { name: "anthropic/claude-sonnet-5", hint: "Claude Sonnet 5 through Nous" },
      { name: "openai/gpt-5.5", hint: "GPT-5.5 through Nous" },
      { name: "google/gemini-3.8-flash", hint: "Gemini 3.8 Flash through Nous" },
      { name: "x-ai/grok-4.6", hint: "Grok 4.6 through Nous" },
    ],
  },
];

function providerDef(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

function modelKey(pid, model) {
  return `${pid}::${model}`;
}

/** Every selectable model, in provider order: [{ pid, model, key, def }]. Only switched-on providers count. */
function enabledModels(settings) {
  const out = [];
  for (const def of PROVIDERS) {
    const cfg = settings.providers && settings.providers[def.id];
    if (!cfg || !cfg.enabled) continue;
    for (const model of cfg.models || []) out.push({ pid: def.id, model, key: modelKey(def.id, model), def });
  }
  return out;
}

/** The model requests go to: the saved choice if it's still available, else the first available one. */
function activeModel(settings) {
  const all = enabledModels(settings);
  return all.find((m) => m.key === settings.activeModel) || all[0] || null;
}

function modelLabel(m) {
  return m ? `${m.def.short} · ${m.model}` : "no model";
}

// Temporary server-side failures: overloaded (503), rate-limited (429), internal errors.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS = [2000, 5000, 12000];

/**
 * Send one request to a model: `target` ({ pid, model }) or the active model. Retries
 * temporary failures; anything else is thrown with the provider named in the message.
 * Resolves to text, or to parsed JSON when `req.schema` is given.
 */
async function llm(settings, req, onRetry, target) {
  const m = target ? { ...target, def: providerDef(target.pid) } : activeModel(settings);
  if (!m || !m.def) {
    throw new Error("No model is set up. Open Journal Scroll Assistant settings → Models, switch on a "
      + "provider, add its API key and at least one model.");
  }
  const cfg = (settings.providers || {})[m.pid] || {};
  if (!cfg.apiKey) throw new Error(`Add your ${m.def.label} API key in Journal Scroll Assistant settings → Models.`);
  const call = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic }[m.def.kind];
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(cfg, m.model, req, m.def);
    } catch (e) {
      if (!RETRYABLE.has(e.status) || attempt >= RETRY_DELAYS.length) {
        if (RETRYABLE.has(e.status)) {
          e.message = `${modelLabel(m)} is busy or unavailable right now (${e.status}), even after `
            + `${RETRY_DELAYS.length} retries. Pick another model and retry.`;
        }
        throw e;
      }
      if (onRetry) onRetry(attempt + 1, e.status);
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
}

/** POST JSON; throws an Error with .status and the provider's own message on HTTP errors. */
async function postJson(url, headers, body, who) {
  const res = await requestUrl({
    url, method: "POST", contentType: "application/json", headers, body: JSON.stringify(body), throw: false,
  });
  let data = null;
  try { data = res.json; } catch (e) { data = null; }
  if (res.status >= 400) {
    const err0 = data && data.error;
    const msg = (err0 && (err0.message || (typeof err0 === "string" ? err0 : ""))) || (data && data.message) || "";
    const err = new Error(`${who} ${res.status}: ${msg || "request failed"}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Parse a model's JSON reply, tolerating ```json fences or text around the object. */
function parseJsonReply(text, who) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fall through */ }
  }
  throw new Error(`${who} returned malformed JSON. Try again, or pick another model.`);
}

/** Gemini's schema dialect (OBJECT/STRING/…) -> standard JSON Schema with every field required. */
function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  const type = String(s.type || "").toLowerCase();
  if (type === "object") {
    const properties = {};
    for (const [k, v] of Object.entries(s.properties || {})) properties[k] = toJsonSchema(v);
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (type === "array") return { type: "array", items: toJsonSchema(s.items) };
  const out = { type };
  if (Array.isArray(s.enum)) out.enum = s.enum.slice();
  return out;
}

/** Gemini-shaped contents -> [{ role: "user"|"assistant", content }]. */
function toChatMessages(contents) {
  return (contents || []).map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: (c.parts || []).map((p) => p.text || "").join(""),
  }));
}

/* --- Google Gemini --- */

/**
 * Gemini 4 rejects temperature/top_p/top_k, so none are sent. `thinking` is low | medium | high;
 * if the endpoint rejects the thinking config, the call is retried once without it.
 */
async function callGemini(cfg, model, req) {
  try {
    return await geminiOnce(cfg, model, req);
  } catch (e) {
    if (req.thinking && e.status === 400 && /thinking/i.test(e.message)) {
      return geminiOnce(cfg, model, { ...req, thinking: null });
    }
    throw e;
  }
}

async function geminiOnce(cfg, model, { system, contents, schema, thinking }) {
  const generationConfig = {};
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.trim())}:generateContent`,
    { "x-goog-api-key": cfg.apiKey.trim() }, body, "Gemini");
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) {
    const why = (cand && cand.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason);
    throw new Error(`Gemini returned no text${why ? ` (${why})` : ""}.`);
  }
  return schema ? parseJsonReply(text, "Gemini") : text;
}

/* --- OpenAI-compatible: OpenAI and Hermes (Nous Portal) --- */

/**
 * JSON is asked for with a strict json_schema response_format. Some models behind an
 * OpenAI-compatible endpoint don't support it, so on a 400 about it the request falls back
 * to json_object mode, then to plain text, with the schema spelled out in the system prompt.
 */
async function callOpenAI(cfg, model, req, def) {
  const base = String(cfg.baseUrl || def.baseUrl || "").replace(/\/+$/, "");
  const who = def.short;
  const headers = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  const schema = req.schema ? toJsonSchema(req.schema) : null;
  const sys = (extra) => ({ role: "system", content: [req.system, extra].filter(Boolean).join("\n\n") });
  const send = async (format, extra) => {
    const messages = [sys(extra), ...toChatMessages(req.contents)].filter((x) => x.content);
    const body = { model, messages };
    if (format) body.response_format = format;
    const data = await postJson(`${base}/chat/completions`, headers, body, who);
    const choice = data && data.choices && data.choices[0];
    const text = String((choice && choice.message && choice.message.content) || "").trim();
    if (!text) throw new Error(`${who} returned no text${choice && choice.finish_reason ? ` (${choice.finish_reason})` : ""}.`);
    return text;
  };
  if (!schema) return send(null);
  const spelled = `Reply with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
  const formatProblem = (e) => e.status === 400 && /response_format|json_schema|json_object|structured/i.test(e.message);
  try {
    return parseJsonReply(await send({ type: "json_schema", json_schema: { name: "response", strict: true, schema } }), who);
  } catch (e) {
    if (!formatProblem(e)) throw e;
  }
  try {
    return parseJsonReply(await send({ type: "json_object" }, spelled), who);
  } catch (e) {
    if (!formatProblem(e)) throw e;
  }
  return parseJsonReply(await send(null, spelled), who);
}

/* --- Anthropic Claude (Messages API) --- */

// Models that support the server-side refusal fallback; on a safety decline the API
// re-runs the request on a suitable fallback model inside the same call.
const CLAUDE_FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-2|fable-5-1|sonnet-5-5)$/;

/**
 * Thinking is left at the model's default (adaptive on current models); depth is set with
 * output_config.effort. JSON uses output_config.format (structured outputs), not forced tool use,
 * which current models reject.
 */
async function callAnthropic(cfg, model, req) {
  const headers = { "x-api-key": cfg.apiKey.trim(), "anthropic-version": "2026-10-21" };
  const output = {};
  if (req.thinking) output.effort = req.thinking; // low | medium | high
  if (req.schema) output.format = { type: "json_schema", schema: toJsonSchema(req.schema) };
  const body = { model, max_tokens: 16000, messages: toChatMessages(req.contents) };
  if (req.system) body.system = req.system;
  if (Object.keys(output).length) body.output_config = output;
  if (CLAUDE_FALLBACK_MODELS.test(model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  let data;
  try {
    data = await postJson("https://api.anthropic.com/v1/messages", headers, body, "Claude");
  } catch (e) {
    // Older models without effort or fallbacks: retry once without the parameter it names.
    if (e.status !== 400 || !/effort|fallback/i.test(e.message)) throw e;
    delete body.fallbacks;
    delete headers["anthropic-beta"];
    if (/effort/i.test(e.message) && body.output_config) {
      delete body.output_config.effort;
      if (!Object.keys(body.output_config).length) delete body.output_config;
    }
    data = await postJson("https://api.anthropic.com/v1/messages", headers, body, "Claude");
  }
  if (data.stop_reason === "refusal") {
    const why = data.stop_details && (data.stop_details.explanation || data.stop_details.category);
    throw new Error(`Claude declined this request${why ? ` (${why})` : ""}. Try another model.`);
  }
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("").trim();
  if (data.stop_reason === "max_tokens") throw new Error("Claude's reply was cut off (max_tokens). Try again.");
  if (!text) throw new Error(`Claude returned no text${data.stop_reason ? ` (${data.stop_reason})` : ""}.`);
  return req.schema ? parseJsonReply(text, "Claude") : text;
}

/* ---------------- people in the news (persona comparisons) ---------------- */
/*
 * Before comparing a day with a person, check whether they were alive on that date
 * (Wikidata: birth P569 / death P570 of the best-matching human) and, if so, fetch the
 * headlines about them published that day (Google News RSS search). Only the person's
 * name and the date are sent; no journal text. Both services are free and keyless.
 */
const NEWS_UA = { "User-Agent": "JournalScrollAssistant (Obsidian plugin)" };
const personFacts = new Map(); // lower-cased name -> { found, label, born, died } (per session)

async function getJson(url) {
  const res = await requestUrl({ url, method: "GET", headers: NEWS_UA, throw: false });
  if (res.status >= 400) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json;
}

/** Wikidata time "+1971-06-28T00:00:00Z" -> local Date (year-only values become 1 Jan). */
function wikidataDate(claims, prop) {
  const c = (claims[prop] || []).find((x) => x.mainsnak && x.mainsnak.datavalue);
  const m = c && /^([+-]\d+)-(\d{2})-(\d{2})/.exec(c.mainsnak.datavalue.value.time || "");
  return m ? new Date(+m[1], Math.max(0, +m[2] - 1), Math.max(1, +m[3])) : null;
}

/** The best-matching human on Wikidata for a name, cached for the session. */
async function lookupPerson(name) {
  const key = name.trim().toLowerCase();
  if (personFacts.has(key)) return personFacts.get(key);
  const found = await getJson("https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json"
    + `&language=en&type=item&limit=5&search=${encodeURIComponent(name)}`);
  const ids = ((found && found.search) || []).map((x) => x.id);
  let facts = { found: false };
  if (ids.length) {
    const data = await getJson("https://www.wikidata.org/w/api.php?action=wbgetentities&format=json"
      + `&props=claims|labels&languages=en&ids=${ids.join("|")}`);
    const human = ids.map((id) => data.entities[id]).find((e) => e && e.claims
      && (e.claims.P31 || []).some((c) => c.mainsnak.datavalue && c.mainsnak.datavalue.value.id === "Q5"));
    if (human) {
      facts = {
        found: true,
        label: (human.labels && human.labels.en && human.labels.en.value) || name,
        born: wikidataDate(human.claims, "P569"),
        died: wikidataDate(human.claims, "P570"),
      };
    }
  }
  personFacts.set(key, facts);
  return facts;
}

function decodeXml(s) {
  return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").trim();
}

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Headlines about `name` published on `date` (local), or by noon the next day, when news
 * about a day often lands. Newest last, at most `max`. [{ title, source, link, published }]
 */
async function newsOnDay(name, date, max = 10) {
  const day = (n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const q = `"${name}" after:${isoDay(day(-1))} before:${isoDay(day(2))}`;
  const res = await requestUrl({
    url: `https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=${encodeURIComponent(q)}`,
    method: "GET", headers: NEWS_UA, throw: false,
  });
  if (res.status >= 400) throw new Error(`${res.status} from news.google.com`);
  const from = day(0).getTime(), to = day(1).getTime() + 12 * 3600 * 1000;
  const items = [];
  for (const m of String(res.text || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t) => decodeXml((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
    const published = new Date(tag("pubDate"));
    if (!(published.getTime() >= from && published.getTime() < to)) continue;
    const source = tag("source");
    let title = tag("title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    items.push({ title, source, link: tag("link"), published });
  }
  // Same story from several outlets: keep the first of each title.
  const seen = new Set();
  return items.filter((x) => !seen.has(x.title.toLowerCase()) && seen.add(x.title.toLowerCase()))
    .sort((a, b) => a.published - b.published).slice(0, max);
}

/**
 * { alive, label, items } for a person on a date. alive is null when the name isn't a known
 * person on Wikidata (then no news is fetched: a made-up or private name shouldn't be searched).
 */
async function personOnDay(name, date) {
  const p = await lookupPerson(name);
  if (!p.found) return { alive: null, label: name, items: [] };
  const alive = (!p.born || p.born <= date) && (!p.died || p.died > date);
  return { alive, label: p.label, items: alive ? await newsOnDay(p.label, date) : [] };
}

/** Model ids a provider offers right now, for the suggestions in settings. */
async function fetchProviderModels(def, cfg) {
  const key = String(cfg.apiKey || "").trim();
  if (!key) throw new Error("Add the API key first.");
  const get = async (url, headers) => {
    const res = await requestUrl({ url, method: "GET", headers, throw: false });
    if (res.status >= 400) {
      const e = res.json && res.json.error;
      throw new Error(`${res.status}: ${(e && (e.message || e)) || "request failed"}`);
    }
    return res.json;
  };
  if (def.kind === "gemini") {
    const data = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key });
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, "")).filter(Boolean);
  }
  if (def.kind === "anthropic") {
    const data = await get("https://api.anthropic.com/v1/models?limit=100",
      { "x-api-key": key, "anthropic-version": "2026-10-21" });
    return (data.data || []).map((m) => m.id).filter(Boolean);
  }
  const base = String(cfg.baseUrl || def.baseUrl || "").replace(/\/+$/, "");
  const data = await get(`${base}/models`, { Authorization: `Bearer ${key}` });
  return (data.data || []).map((m) => m.id).filter(Boolean).sort();
}

const TITLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    highlights: { type: "ARRAY", items: { type: "STRING" } },
    areas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          area: { type: "STRING" },
          level: { type: "STRING", enum: LEVELS },
        },
        required: ["area", "level"],
      },
    },
  },
  required: ["title", "highlights", "areas"],
};

const TITLE_SYSTEM = [
  "You title entries in a private daily journal.",
  "title: 3 to 8 words that capture what made this day this day. Be specific (names, places, events).",
  "No date, no quotation marks, no emoji, no trailing full stop.",
  "highlights: 2 to 5 short phrases (at most 10 words each), in the order they happened.",
  "Use only facts written in the entry. Never invent or embellish. Keep the author's own words where you can.",
  "areas: one row for every life area listed below.",
  RATING_SCALE,
].join("\n");

/* ---------------- month picker ---------------- */

/** Pick a month (newest first) or, if allowed, "All months". items: [{ label, note, value }]. */
class MonthPickerModal extends SuggestModal {
  constructor(app, placeholder, items, onChoose) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    return q ? this.items.filter((i) => i.label.toLowerCase().includes(q)) : this.items;
  }

  renderSuggestion(item, el) {
    el.createDiv({ text: item.label });
    if (item.note) el.createEl("small", { cls: "jsa-pick-note", text: item.note });
  }

  onChooseSuggestion(item) {
    this.onChoose(item.value);
  }
}

/* ---------------- day picker (compare with another day) ---------------- */

/** Pick another journal day; entries: [{ file, date }], already ordered newest first. */
class DayPickerModal extends SuggestModal {
  constructor(app, placeholder, entries, titleOf, onChoose) {
    super(app);
    this.entries = entries;
    this.titleOf = titleOf;
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.entries;
    return this.entries.filter((e) => `${longDate(e.date)} ${this.titleOf(e)}`.toLowerCase().includes(q));
  }

  renderSuggestion(e, el) {
    el.createDiv({ text: longDate(e.date) });
    const title = this.titleOf(e);
    if (title) el.createEl("small", { cls: "jsa-pick-note", text: title });
  }

  onChooseSuggestion(e) {
    this.onChoose(e);
  }
}

/**
 * Is this plausibly a person's name ("Elon Musk", "Marie Curie", "A. P. J. Abdul Kalam")?
 * No digits, no question, at most 6 words, and not a command like "retry …" or "compare …".
 */
function looksLikeName(text) {
  const t = String(text || "").trim();
  if (!t || /[\d?!:;\n]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  return !/^(retry|redo|again|compare|summari[sz]e|regenerate|what|why|how|when|can|could|please|tell|show|give)\b/i.test(t);
}

/** "a month earlier", "2 years earlier", "3 months later" — how far `other` is from `focus`. */
function describeGap(focus, other) {
  const months = (other.getFullYear() - focus.getFullYear()) * 12 + (other.getMonth() - focus.getMonth());
  const n = Math.abs(months);
  const dir = months < 0 ? "earlier" : "later";
  if (n && n % 12 === 0) return n === 12 ? `a year ${dir}` : `${n / 12} years ${dir}`;
  if (n) return n === 1 ? `a month ${dir}` : `${n} months ${dir}`;
  const days = Math.round((other - focus) / 86400000);
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days < 0 ? "earlier" : "later"}`;
}

/* ---------------- the panel inside a Journal Scroll view ---------------- */

class AssistantPanel extends Component {
  constructor(plugin, view) {
    super();
    this.plugin = plugin;
    this.app = plugin.app;
    this.view = view;
    this.history = [];      // Gemini contents for the current chat; never saved
    this.chatKey = null;      // what the chat is about: "day:<path>" or "<scope>:<path>"
    this.chatSource = "";     // note path for resolving links in replies
    this.chatContext = null;  // async () => journal text the chat sees
    this.awaitingPersona = false;
    this.personaEntry = null; // the day "Someone else…" was asked from
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
    // Which model answers: switchable at any time, grouped by provider.
    this.modelSelects = new Set();
    head.appendChild(this.buildModelSelect("is-header"));
    const ideas = head.createEl("button", { cls: "jsa-icon-btn", attr: { "aria-label": "Questions to ask" } });
    setIcon(ideas, "lightbulb");
    this.registerDomEvent(ideas, "click", () => this.showSuggestions());
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
    // A pending "type a name" prompt must not outlive the panel and swallow a later message.
    this.awaitingPersona = false;
    this.personaEntry = null;
    this.input.setAttr("placeholder", "Ask about this day…");
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
    menu.addItem((i) => i.setTitle("Reflect, compare or summarize…").setIcon("lightbulb")
      .onClick(() => this.showSuggestions()));
    menu.addSeparator();
    for (const p of splitList(s.personas)) {
      menu.addItem((i) => i.setTitle(`Compare with ${p}`).setIcon("users")
        .onClick(() => this.compare(p)));
    }
    menu.addItem((i) => i.setTitle("Compare with someone else…").setIcon("user-plus")
      .onClick(() => this.askPersona()));
    menu.addSeparator();
    this.fillEverythingItem(menu, (fn) => fn);
    menu.addItem((i) => i.setTitle("Title, highlight and rate this day").setIcon("heading")
      .onClick(() => this.titleDay()));
    menu.addItem((i) => i.setTitle("Title and rate every day this month").setIcon("list-checks")
      .onClick(() => this.titleMonth(this.focusMonth())));
    menu.addItem((i) => i.setTitle("Title and rate days in a month…").setIcon("calendar-search")
      .onClick(() => this.pickTitleMonth()));
    menu.addItem((i) => i.setTitle("Re-rate life areas in a month…").setIcon("refresh-cw")
      .onClick(() => this.pickTitleMonth(true)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Summarize this month as a timeline").setIcon("calendar-range")
      .onClick(() => this.monthTimeline(this.focusMonth())));
    menu.addItem((i) => i.setTitle("Summarize a month as a timeline…").setIcon("calendar-search")
      .onClick(() => this.pickTimelineMonth()));
    menu.showAtMouseEvent(evt);
  }

  /* ----- messages ----- */

  async addMessage(role, md, { sourcePath, copy } = {}) {
    const el = this.messagesEl.createDiv({ cls: `jsa-msg is-${role}` });
    const body = el.createDiv({ cls: "jsa-msg-body markdown-rendered" });
    if (role === "user") body.setText(md);
    else await MarkdownRenderer.render(this.app, md, body, sourcePath || "", this);
    // Every answer says which model wrote it.
    if (role === "assistant" && this.runModel) el.createDiv({ cls: "jsa-msg-model", text: this.runModel });
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

  /** Retry callback for llm(): show progress in the pending bubble. */
  retrying(wait, base) {
    return (n, status) => wait.setText(`${base} (Google is busy${status === 429 ? " (rate limit)" : ""}, `
      + `retrying ${n} of ${RETRY_DELAYS.length}…)`);
  }

  /* ----- model picker ----- */

  /** A <select> of every model from switched-on providers, grouped by provider. */
  buildModelSelect(cls) {
    const sel = createEl("select", { cls: `dropdown jsa-model-select ${cls || ""}`, attr: { "aria-label": "Model" } });
    this.fillModelSelect(sel);
    this.registerDomEvent(sel, "change", () => {
      if (sel.value === "__settings") {
        this.fillModelSelect(sel);
        return this.openSettings();
      }
      this.plugin.setActiveModel(sel.value);
    });
    this.modelSelects.add(sel);
    return sel;
  }

  fillModelSelect(sel) {
    const s = this.plugin.settings;
    const models = enabledModels(s);
    const active = activeModel(s);
    sel.empty();
    if (!models.length) sel.createEl("option", { text: "No model set up", value: "" });
    for (const def of PROVIDERS) {
      const mine = models.filter((m) => m.pid === def.id);
      if (!mine.length) continue;
      const group = sel.createEl("optgroup", { attr: { label: def.label } });
      for (const m of mine) group.createEl("option", { text: modelLabel(m), value: m.key });
    }
    sel.createEl("option", { text: "Set up models…", value: "__settings" });
    sel.value = active ? active.key : "";
    sel.setAttr("title", active ? `Answers come from ${active.def.label}: ${active.model}` : "No model set up");
  }

  refreshModelSelects() {
    for (const sel of Array.from(this.modelSelects)) {
      if (!sel.isConnected) this.modelSelects.delete(sel);
      else this.fillModelSelect(sel);
    }
  }

  openSettings() {
    const setting = this.app.setting;
    if (setting && setting.open) {
      setting.open();
      if (setting.openTabById) setting.openTabById(this.plugin.manifest.id);
    }
  }

  async run(label, fn) {
    if (this.busy) {
      new Notice("The assistant is still working on the last request.");
      return;
    }
    this.busy = true;
    this.show();
    const used = activeModel(this.plugin.settings);
    this.runModel = modelLabel(used);
    const wait = this.pending(`${label} · ${this.runModel}`);
    this.onRetry = this.retrying(wait, label);
    let failed = null;
    try {
      await fn(wait);
    } catch (e) {
      failed = e;
    } finally {
      wait.remove();
      this.busy = false;
      this.onRetry = null;
      this.runModel = null;
    }
    if (!failed) return;
    // Name the model that failed and offer the same request again, on any model.
    const el = await this.addMessage("error", `**${modelLabel(used)} failed.** ${failed.message || failed}`);
    const row = el.createDiv({ cls: "jsa-retry" });
    row.createSpan({ cls: "jsa-retry-label", text: "Try again with" });
    row.appendChild(this.buildModelSelect("is-inline"));
    const btn = row.createEl("button", { cls: "mod-cta jsa-retry-btn", text: "Retry" });
    setIcon(btn.createSpan({ cls: "jsa-retry-icon" }), "rotate-ccw");
    this.registerDomEvent(btn, "click", () => {
      if (this.busy) return new Notice("The assistant is still working on the last request.");
      row.remove();
      this.run(label, fn);
    });
  }

  /* ----- chat ----- */

  /** Start (or resume) a chat about the day in view, with the days before it as context. */
  startChat(entry) {
    entry = entry || this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    this.awaitingPersona = false;
    const key = `day:${entry.file.path}`;
    if (this.chatKey !== key) {
      const days = this.plugin.settings.contextDays;
      this.newChat(key, entry.file.path, () => this.contextFor(entry, days));
      const before = days - 1;
      this.addMessage("system", `Chatting about **${longDate(entry.date)}**`
        + (before > 0 ? `, with the ${before} day${before === 1 ? "" : "s"} before it for context.` : "."));
    }
    this.titleEl.setText(`Journal assistant · ${fmtDate(entry.date)}`);
    this.input.setAttr("placeholder", "Ask about this day…");
    this.show();
    this.input.focus();
  }

  newChat(key, sourcePath, context) {
    this.history = [];
    this.chatKey = key;
    this.chatSource = sourcePath;
    this.chatContext = context;
    this.messagesEl.empty();
  }

  async submit() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = "";
    if (this.awaitingPersona) {
      this.awaitingPersona = false;
      this.input.setAttr("placeholder", "Ask about this day…");
      const entry = this.personaEntry;
      this.personaEntry = null;
      // Only a name is a persona. Anything else (e.g. "retry for 16th Nov", which once got saved
      // as "Compared with retry for 16th Nov") is a normal chat message, not a comparison.
      if (looksLikeName(text)) return this.compare(text, entry);
      await this.addMessage("system", `"${text}" doesn't look like a name, so I didn't compare. `
        + "Use Compare → Compare with someone else… and type just the person's name.");
      return;
    }
    if (!this.chatKey) this.startChat();
    if (!this.chatKey) return;
    await this.ask(text);
  }

  /**
   * Send one question in the current chat; the journal text is loaded on the first turn.
   * Resolves to the reply, or null if it failed (the error is shown in the panel).
   * `after(reply)` runs inside the same busy section, e.g. to save the reply to a note.
   */
  async ask(text, shown, after) {
    await this.addMessage("user", shown || text);
    let out = null;
    await this.run("Thinking…", async (wait) => {
      const s = this.plugin.settings;
      if (!this.history.length) {
        const ctx = await this.chatContext(wait);
        this.history.push({ role: "user", parts: [{ text: `My journal:\n\n${ctx}` }] });
        this.history.push({ role: "model", parts: [{ text: "Got it. What would you like to talk about?" }] });
        wait.setText("Thinking…");
      }
      this.history.push({ role: "user", parts: [{ text }] });
      let reply;
      try {
        reply = await llm(s, { thinking: "medium", system: CHAT_SYSTEM, contents: this.history }, this.onRetry);
      } catch (e) {
        this.history.pop();
        if (this.history.length === 2) this.history = []; // reload the journal text on the next try
        throw e;
      }
      this.history.push({ role: "model", parts: [{ text: reply }] });
      const note = after ? await after(reply) : "";
      await this.addMessage("assistant", reply + (note ? `\n\n${note}` : ""),
        { sourcePath: this.chatSource, copy: true });
      out = reply;
    });
    return out;
  }

  /* ----- preset questions ----- */

  showSuggestions() {
    const entry = this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    this.awaitingPersona = false;
    this.show();
    const month = `${MONTHS_LONG[entry.date.getMonth()]} ${entry.date.getFullYear()}`;
    const box = this.messagesEl.createDiv({ cls: "jsa-suggest" });
    box.createDiv({
      cls: "jsa-suggest-intro",
      text: `"Your life" reads every monthly timeline. The rest use ${month} or the week ending ${fmtDate(entry.date)}.`,
    });
    for (const group of PRESET_GROUPS) {
      box.createDiv({ cls: "jsa-suggest-group", text: group });
      const row = box.createDiv({ cls: "jsa-suggest-chips" });
      for (const p of PRESETS.filter((x) => x.group === group)) {
        const chip = row.createEl("button", { cls: "jsa-chip" });
        setIcon(chip.createSpan({ cls: "jsa-chip-icon" }), p.icon);
        chip.createSpan({ text: p.label });
        this.registerDomEvent(chip, "click", () => this.askPreset(p));
      }
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** The periods a scope covers, newest first: [{ label, entries }]. */
  periodsFor(scope, entry) {
    const all = this.entries();
    const between = (a, b) => all.filter((e) => e.date >= a && e.date <= b);
    const day = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const month = (y, m) => {
      const first = new Date(y, m, 1);
      return {
        label: `${MONTHS_LONG[first.getMonth()]} ${first.getFullYear()}`,
        entries: between(first, new Date(y, m + 1, 0)),
      };
    };
    const week = (end) => ({
      label: `the week ${fmtDate(day(end, -6))} to ${fmtDate(end)}`,
      entries: between(day(end, -6), end),
    });
    const d = entry.date, y = d.getFullYear(), m = d.getMonth();
    switch (scope) {
      case "week": return [week(d)];
      case "week-compare": return [week(d), week(day(d, -7))];
      case "month-compare": return [month(y, m), month(y, m - 1)];
      case "year-compare": return [month(y, m), month(y - 1, m)];
      default: return [month(y, m)];
    }
  }

  async periodText(period) {
    const parts = [];
    for (const e of period.entries) {
      const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter || {};
      const title = typeof fm.title === "string" && fm.title.trim() ? ` — ${fm.title.trim()}` : "";
      parts.push(`### ${longDate(e.date)}${title}\n${(await this.entryText(e.file)) || "(empty entry)"}`);
    }
    return parts.join("\n\n");
  }

  summariesDir() {
    return normalizePath(`${this.view.dir}/${this.plugin.settings.summariesFolder || "Summaries"}`);
  }

  /** Monthly timeline notes, oldest first. */
  timelineNotes() {
    const root = this.summariesDir() + "/";
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(root) && /^\d{4}-\d{2} \w+ Timeline$/.test(f.basename))
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  /** Every entry that has a title, as one line each. */
  titleIndex() {
    const lines = [];
    for (const e of this.entries()) {
      const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter || {};
      if (typeof fm.title === "string" && fm.title.trim()) lines.push(`- ${fmtDate(e.date)}: ${fm.title.trim()}`);
    }
    return lines;
  }

  /** Text for the "Your life" questions: all timelines (minus their title lists) plus the title index. */
  async lifeContext(timelines, titles) {
    const parts = [];
    for (const f of timelines) {
      let text = await this.app.vault.cachedRead(f);
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache && cache.frontmatterPosition) text = text.slice(cache.frontmatterPosition.end.offset);
      text = text.replace(/\n## Titles[\s\S]*$/, "").trim(); // the title index below covers these
      parts.push(`## Timeline: ${f.basename.replace(/ Timeline$/, "")}\n\n${text}`);
    }
    if (titles.length) parts.push(`## Day titles (${titles.length})\n\n${titles.join("\n")}`);
    return parts.join("\n\n");
  }

  /** entry: the day the question is about (default: the day in view). */
  async askPreset(p, entry) {
    if (this.busy) return new Notice("The assistant is still working on the last request.");
    entry = entry || this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    const areas = splitList(this.plugin.settings.areas).join(", ");
    const question = p.q.replace("{areas}", areas);
    this.input.setAttr("placeholder", "Ask a follow-up…");
    this.titleEl.setText(`Journal assistant · ${p.label}`);

    if (p.scope === "life") {
      const timelines = this.timelineNotes();
      const titles = this.titleIndex();
      if (!timelines.length && !titles.length) {
        return this.addMessage("system", "There's nothing to draw on yet. Use **Summarize this month as a "
          + "timeline** on a few months, or **Title every untitled day this month**, then ask again.");
      }
      this.newChat(`life:${p.save}`, "", () => this.lifeContext(timelines, titles));
      this.addMessage("system", `Reading **${timelines.length} monthly timeline${timelines.length === 1 ? "" : "s"}** `
        + `and **${titles.length} day titles**.`
        + (timelines.length < 3 ? " More timelines give a fuller answer." : "")
        + " Ask follow-ups below.");
      await this.ask(question, p.label, (reply) => this.saveLifeNote(p, reply, timelines.length, titles.length));
      return;
    }

    const periods = this.periodsFor(p.scope, entry);
    if (!periods[0].entries.length) {
      return this.addMessage("system", `No entries in ${periods[0].label} yet.`);
    }
    const compare = periods.length > 1;
    if (compare && !periods[1].entries.length) {
      return this.addMessage("system", `Nothing to compare with: no entries in ${periods[1].label}.`);
    }
    this.newChat(`${p.scope}:${entry.file.path}`, entry.file.path, async () => {
      const blocks = [];
      for (const [i, per] of periods.entries()) {
        const head = compare ? `${i ? "EARLIER" : "CURRENT"} PERIOD: ${per.label}` : `Entries from ${per.label}`;
        blocks.push(`## ${head} (${per.entries.length} entries)\n\n${await this.periodText(per)}`);
      }
      return blocks.join("\n\n");
    });
    const scopeText = periods.map((per) => `${per.label} (${per.entries.length} entries)`).join(" vs ");
    this.addMessage("system", `Looking at **${scopeText}**. Ask follow-ups below.`);
    await this.ask(question, p.label);
  }

  /** Save a "Your life" answer to <summaries>/<name>.md, replacing the previous version. */
  async saveLifeNote(p, reply, timelines, titles) {
    const dir = this.summariesDir();
    const path = normalizePath(`${dir}/${p.save}.md`);
    const fm = stringifyYaml({
      type: "life",
      question: p.label,
      generated: new Date().toISOString().slice(0, 10),
      timelines,
      titled_days: titles,
      model: modelLabel(activeModel(this.plugin.settings)),
    });
    const note = `---\n${fm}---\n\n# ${p.label}\n\n${reply.trim()}\n\n`
      + `*Generated from ${timelines} monthly timelines and ${titles} day titles. `
      + "Ask again from Journal Scroll Assistant to regenerate it.*\n";
    await this.plugin.ensureFolder(dir);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, note);
    else await this.app.vault.create(path, note);
    return `*Saved to [[${path.replace(/\.md$/, "")}|${p.save}]].*`;
  }

  /* ----- compare ----- */

  /** entry: the day to compare (default: the day in view). */
  askPersona(entry) {
    this.awaitingPersona = true;
    this.personaEntry = entry || null;
    this.show();
    const day = entry ? `**${fmtDate(entry.date)}**` : "your day";
    this.addMessage("system", `Who should I compare ${day} with? Type a name.`);
    this.input.setAttr("placeholder", "e.g. Marie Curie");
    this.input.focus();
  }

  /** The journal entry for a file, or the day in view when no file is given. */
  entryFor(file) {
    if (!file) return this.focusEntry();
    return this.entries().find((e) => e.file.path === file.path) || null;
  }

  /** The entry exactly `months` months and `years` years from `entry`, if that date exists and has one. */
  sameDayAs(entry, months, years) {
    const d = entry.date;
    const t = new Date(d.getFullYear() + years, d.getMonth() + months, d.getDate());
    if (t.getDate() !== d.getDate()) return null; // e.g. 31 Oct -> no 31 Sep
    return this.entries().find((e) => e.date.getFullYear() === t.getFullYear()
      && e.date.getMonth() === t.getMonth() && e.date.getDate() === t.getDate()) || null;
  }

  titleOf(e) {
    const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter || {};
    return typeof fm.title === "string" ? fm.title.trim() : "";
  }

  /**
   * The menus behind the action row at the bottom of each day in Journal Scroll:
   *   chat       chat about this day, and the Reflect questions
   *   compare    people, the same day in another month or year, and week/month over time
   *   regenerate this day's title and ratings, everything for this day, or a whole month
   *   summarize  this month, quarter or year
   * `onStart` runs once an action is chosen (Journal Scroll closes its day pop-up).
   * `anchor` is the button, so the menu opens under it.
   */
  async openActionMenu(kind, evt, file, onStart, anchor) {
    const entry = this.entryFor(file);
    if (!entry) return new Notice("That day isn't in this journal.");
    const go = (fn) => () => { if (onStart) onStart(); fn(); };
    const menu = new Menu();
    const build = {
      chat: () => this.chatItems(menu, entry, go),
      compare: () => this.compareItems(menu, entry, go),
      regenerate: () => this.regenerateItems(menu, entry, go),
      summarize: () => this.summarizeItems(menu, entry, go),
    }[kind];
    if (!build) return;
    await build();
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    } else {
      menu.showAtMouseEvent(evt);
    }
  }

  chatItems(menu, entry, go) {
    menu.addItem((i) => i.setTitle(`Chat about ${fmtDate(entry.date)}`).setIcon("message-circle")
      .onClick(go(() => this.startChat(entry))));
    menu.addSeparator();
    for (const p of PRESETS.filter((x) => x.group === "Reflect")) {
      menu.addItem((i) => i.setTitle(p.label).setIcon(p.icon).onClick(go(() => this.askPreset(p, entry))));
    }
  }

  async regenerateItems(menu, entry, go) {
    const month = { y: entry.date.getFullYear(), m: entry.date.getMonth() };
    const label = this.monthLabel(month);
    this.fillEverythingItem(menu, go);
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("This day: title, highlights and life areas").setIcon("heading")
      .onClick(go(() => this.titleDay(entry))));
    const saved = await this.savedComparisons(entry);
    menu.addItem((i) => i.setTitle(saved.length
      ? `This day: everything (title + ${saved.length} comparison${saved.length === 1 ? "" : "s"})`
      : "This day: everything").setIcon("refresh-cw")
      .onClick(go(() => this.regenerateDay(entry))));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(`Title and rate untitled days in ${label}`).setIcon("list-checks")
      .onClick(go(() => this.titleMonth(month))));
    menu.addItem((i) => i.setTitle(`Re-rate life areas for every day in ${label}`).setIcon("refresh-ccw")
      .onClick(go(() => this.titleMonth(month, { rerate: true }))));
    menu.addItem((i) => i.setTitle("Title, rate or re-rate another month…").setIcon("calendar-search")
      .onClick(go(() => this.pickTitleMonth())));
  }

  summarizeItems(menu, entry, go) {
    const y = entry.date.getFullYear(), m = entry.date.getMonth(), q = Math.floor(m / 3) + 1;
    menu.addItem((i) => i.setTitle(`This month · ${MONTHS_LONG[m]} ${y}`).setIcon("calendar-range")
      .onClick(go(() => this.monthTimeline({ y, m }))));
    menu.addItem((i) => i.setTitle(`This quarter · Q${q} ${y}`).setIcon("calendar-days")
      .onClick(go(() => this.periodSummary("quarter", entry))));
    menu.addItem((i) => i.setTitle(`This year · ${y}`).setIcon("calendar-check")
      .onClick(go(() => this.periodSummary("year", entry))));
  }

  /** Labels of the comparisons already saved in a day's note, in file order. */
  async savedComparisons(entry) {
    return Array.from(readComparisons(await this.app.vault.cachedRead(entry.file)).keys());
  }

  /** Re-run everything for one day: its title, highlights and ratings, then each saved comparison. */
  async regenerateDay(entry) {
    const labels = await this.savedComparisons(entry);
    await this.titleDay(entry);
    for (const label of labels) {
      // Day comparisons are saved as "22 Oct 2026 (a month earlier)"; anything else is a person.
      const m = /^(\d{1,2}) (\w{3}) (\d{4}) \(/.exec(label);
      if (m && MONTHS.includes(m[2])) {
        const date = new Date(+m[3], MONTHS.indexOf(m[2]), +m[1]);
        const other = this.entries().find((e) => e.date.getTime() === date.getTime());
        if (other) await this.compareDays(entry, other);
        else await this.addMessage("system", `Skipped ${label}: that day has no entry any more.`);
      } else if (looksLikeName(label)) {
        await this.compare(label, entry);
      } else {
        await this.addMessage("system", `Skipped "${label}": it isn't a person's name, so it was saved by mistake.`);
      }
    }
  }

  /** Compare menu items: people, the same day in another month or year, and week/month over time. */
  compareItems(menu, entry, go) {
    for (const p of splitList(this.plugin.settings.personas)) {
      menu.addItem((i) => i.setTitle(`Compare with ${p}`).setIcon("users")
        .onClick(go(() => this.compare(p, entry))));
    }
    menu.addItem((i) => i.setTitle("Compare with someone else…").setIcon("user-plus")
      .onClick(go(() => this.askPersona(entry))));
    menu.addSeparator();

    const dayItem = (label, icon, other) => menu.addItem((i) => {
      i.setTitle(`${label} · ${other ? fmtDate(other.date) : "no entry"}`).setIcon(icon);
      if (other) i.onClick(go(() => this.compareDays(entry, other)));
      else i.setDisabled(true);
    });
    dayItem("Same day last month", "calendar-minus", this.sameDayAs(entry, -1, 0));
    dayItem("Same day last year", "history", this.sameDayAs(entry, 0, -1));

    // Every other entry on the same day of the month, newest first: other months and other years.
    const sameDom = this.entries()
      .filter((e) => e.date.getDate() === entry.date.getDate() && e.file.path !== entry.file.path)
      .sort((a, b) => b.date - a.date);
    menu.addItem((i) => {
      i.setTitle(sameDom.length ? `Same day in another month or year… (${sameDom.length})`
        : "Same day in another month or year… (none)").setIcon("calendar-search");
      if (!sameDom.length) return i.setDisabled(true);
      i.onClick(() => new DayPickerModal(this.app,
        `Compare ${fmtDate(entry.date)} with… (type to filter by month, year or title)`,
        sameDom, (e) => this.titleOf(e), (other) => go(() => this.compareDays(entry, other))()).open());
    });
    menu.addSeparator();
    for (const p of PRESETS.filter((x) => x.group === "Compare over time")) {
      menu.addItem((i) => i.setTitle(p.label).setIcon(p.icon).onClick(go(() => this.askPreset(p, entry))));
    }
  }

  /**
   * A quarter or a year in review, saved next to the monthly timelines:
   *   <summaries>/<YYYY>/<YYYY>-Q<n> Summary.md   or   <summaries>/<YYYY>/<YYYY> Year Summary.md
   * A quarter reads every entry in full. A year is too long for that, so it reads each day's
   * title and highlights plus any monthly timelines already written for that year.
   */
  async periodSummary(kind, entry) {
    const y = entry.date.getFullYear();
    const q = Math.floor(entry.date.getMonth() / 3) + 1;
    const first = kind === "quarter" ? new Date(y, (q - 1) * 3, 1) : new Date(y, 0, 1);
    const last = kind === "quarter" ? new Date(y, q * 3, 0) : new Date(y, 11, 31);
    const label = kind === "quarter" ? `Q${q} ${y}` : `${y}`;
    const list = this.entries().filter((e) => e.date >= first && e.date <= last);
    this.show();
    if (!list.length) return this.addMessage("system", `No entries in ${label}.`);
    await this.addMessage("user", `Summarize ${label}`);
    await this.run(`Reading ${list.length} entries from ${label}…`, async () => {
      const parts = [];
      if (kind === "quarter") {
        for (const e of list) {
          const title = this.titleOf(e);
          parts.push(`### ${longDate(e.date)}${title ? ` — ${title}` : ""}\n${await this.entryText(e.file)}`);
        }
      } else {
        const root = `${this.summariesDir()}/${y}/`;
        const timelines = this.timelineNotes().filter((f) => f.path.startsWith(root));
        for (const f of timelines) {
          let text = await this.app.vault.cachedRead(f);
          const cache = this.app.metadataCache.getFileCache(f);
          if (cache && cache.frontmatterPosition) text = text.slice(cache.frontmatterPosition.end.offset);
          parts.push(`## Monthly timeline: ${f.basename.replace(/ Timeline$/, "")}\n\n`
            + text.replace(/\n## Titles[\s\S]*$/, "").trim());
        }
        const days = list.map((e) => {
          const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter || {};
          const hl = Array.isArray(fm.highlights) ? fm.highlights.filter((h) => typeof h === "string") : [];
          return `- ${fmtDate(e.date)}${this.titleOf(e) ? ` — ${this.titleOf(e)}` : ""}${hl.length ? `: ${hl.join("; ")}` : ""}`;
        });
        parts.push(`## Every day (title and highlights)\n\n${days.join("\n")}`);
      }
      const areas = splitList(this.plugin.settings.areas);
      const md = await llm(this.plugin.settings, {
        thinking: "high",
        system: [
          `You turn ${kind === "quarter" ? "a quarter" : "a year"} of a private daily journal into a review the author will keep.`,
          "Write Markdown with exactly these sections:",
          "## In a line — one sentence on what the period was about.",
          "## Month by month — a short paragraph per month, with the key dates.",
          "## Highlights — the 5 to 10 moments that defined the period, each with its date.",
          "## People — who mattered and in what context.",
          "## Themes — 3 to 6 recurring threads, one line each.",
          `## Focus — one line each for these areas, on how much attention it got:\n${areaGuide(areas)}`,
          "## Carry forward — open threads and 3 concrete things to do next.",
          "Use only what the material says. Do not invent. First person is fine (\"I\"), matching the author.",
        ].join("\n"),
        contents: [{ role: "user", parts: [{ text: `Journal for ${label}:\n\n${parts.join("\n\n")}` }] }],
      }, this.onRetry);

      const s = this.plugin.settings;
      const folder = normalizePath(`${this.summariesDir()}/${y}`);
      const path = normalizePath(`${folder}/${kind === "quarter" ? `${y}-Q${q} Summary` : `${y} Year Summary`}.md`);
      const fm = stringifyYaml({
        type: kind === "quarter" ? "quarter-summary" : "year-summary",
        period: kind === "quarter" ? `${y}-Q${q}` : `${y}`,
        entries: list.length,
        generated: new Date().toISOString().slice(0, 10),
        model: modelLabel(activeModel(s)),
      });
      const note = `---\n${fm}---\n\n# ${label}\n\n${md.trim()}\n`;
      await this.plugin.ensureFolder(folder);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modify(existing, note);
      else await this.app.vault.create(path, note);
      await this.addMessage("assistant", `${md.trim()}\n\n*Saved to [[${path.replace(/\.md$/, "")}|${label} Summary]].*`,
        { sourcePath: path, copy: true });
    });
  }

  /** Compare the day in focus with another journal day; saved as a callout in the day in focus. */
  async compareDays(entry, other) {
    if (!entry || !other) return;
    const s = this.plugin.settings;
    const areas = splitList(s.areas);
    const times = splitList(s.compareTimes || DEFAULT_SETTINGS.compareTimes);
    const label = fmtDate(other.date);
    const gap = describeGap(entry.date, other.date);
    await this.addMessage("user", `Compare ${fmtDate(entry.date)} with ${label} (${gap})`);
    await this.run(`Comparing with ${label}…`, async () => {
      const now = await this.entryText(entry.file);
      const then = await this.entryText(other.file);
      if (!now) throw new Error(`${fmtDate(entry.date)} has no journal text to compare.`);
      if (!then) throw new Error(`${label} has no journal text to compare.`);
      const res = await llm(s, {
        thinking: "medium",
        system: [
          "You are a candid, encouraging performance coach reading two days from the same person's private journal.",
          `Compare THE DAY IN FOCUS with THE OTHER DAY (${gap}): how the author's days, habits and priorities changed.`,
          "Use only what each entry says. Never invent events. If a day is silent on something, say so.",
          `areas: rate both days on each of these life areas:\n${areaGuide(areas)}`,
          RATING_SCALE,
          "",
          `timeline: an hour-by-hour comparison. Include a row for each of: ${times.join(", ")},`,
          "plus any other time either entry wrote down. Rows in chronological order; time like \"6 AM\" or \"9:30 AM\".",
          "then: what the author was doing at that hour on the other day. now: on the day in focus.",
          "If an entry doesn't say, write exactly \"Not in the journal\". Max 15 words each.",
          "",
          "better: what the day in focus did better. slipped: what the other day did better.",
          "carry_forward: concrete, doable-tomorrow advice drawn from the comparison.",
          "Speak to the author as \"you\".",
        ].join("\n"),
        contents: [{ role: "user", parts: [{ text:
          `THE DAY IN FOCUS: ${longDate(entry.date)}\n${now}\n\n`
          + `THE OTHER DAY (${gap}): ${longDate(other.date)}\n${then}` }] }],
        schema: {
          type: "OBJECT",
          properties: {
            one_line: { type: "STRING" },
            timeline: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { time: { type: "STRING" }, then: { type: "STRING" }, now: { type: "STRING" } },
                required: ["time", "then", "now"],
              },
            },
            better: { type: "ARRAY", items: { type: "STRING" } },
            slipped: { type: "ARRAY", items: { type: "STRING" } },
            carry_forward: { type: "ARRAY", items: { type: "STRING" } },
            areas: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  area: { type: "STRING" },
                  then: { type: "STRING", enum: LEVELS },
                  now: { type: "STRING", enum: LEVELS },
                  change: { type: "STRING" },
                },
                required: ["area", "then", "now", "change"],
              },
            },
          },
          required: ["one_line", "timeline", "better", "slipped", "carry_forward", "areas"],
        },
      }, this.onRetry);

      const LEVEL = { focused: "▂▄▆ Focused", some: "▂▄ Some", neglected: "▂ Neglected", none: "· Not today" };
      const lv = (x) => LEVEL[x] || cell(x);
      const rows = (res.timeline || []).filter((r) => r && r.time)
        .sort((a, b) => dayOrder(a.time) - dayOrder(b.time));
      const list = (xs) => (xs && xs.length ? xs.map((x) => `- ${x}`) : ["- Nothing stood out"]);
      const md = [
        `**${res.one_line}**`,
        "",
        `| Time | ${label} | ${fmtDate(entry.date)} |`,
        "| --- | --- | --- |",
        ...rows.map((r) => `| **${cell(r.time)}** | ${cell(r.then)} | ${cell(r.now)} |`),
        "",
        `**Better than ${label}**`,
        ...list(res.better),
        "",
        `**Better on ${label}**`,
        ...list(res.slipped),
        "",
        "**Carry forward**",
        ...list(res.carry_forward),
        "",
        `| Area | ${label} | ${fmtDate(entry.date)} | What changed |`,
        "| --- | --- | --- | --- |",
        ...(res.areas || []).map((a) => `| ${cell(a.area)} | ${lv(a.then)} | ${lv(a.now)} | ${cell(a.change)} |`),
      ].join("\n");

      // Same home as people comparisons: a folded callout at the end of the day in focus.
      const key = `${label} (${gap})`;
      const callout = `> [!compare]- Compared with ${key}\n${quote(md)}`;
      await this.app.vault.process(entry.file, (text) => writeComparison(text, key, callout));
      const focus = this.focusMap((res.areas || []).map((a) => ({ area: a.area, level: a.now })), areas);
      if (Object.keys(focus).length) await this.plugin.setFrontmatter(entry.file, (fm) => { fm.focus = focus; });
      await this.addMessage("assistant", `### ${fmtDate(entry.date)} vs ${label}\n\n${md}\n\n`
        + `*Saved to ${entry.file.basename}.*`, { sourcePath: entry.file.path, copy: true });
    });
  }

  async compare(persona, entry) {
    entry = entry || this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    const s = this.plugin.settings;
    const areas = splitList(s.areas);
    const times = splitList(s.compareTimes || DEFAULT_SETTINGS.compareTimes);
    await this.addMessage("user", `Compare ${fmtDate(entry.date)} with ${persona}`);
    await this.run(`Comparing with ${persona}…`, async (wait) => {
      const ctx = await this.contextFor(entry, s.contextDays);

      // A living person may have been in the news that day: what they actually did beats a typical day.
      let news = [];
      if (s.personaNews !== false) {
        wait.setText(`Checking the news about ${persona} on ${fmtDate(entry.date)}…`);
        try {
          news = (await personOnDay(persona, entry.date)).items;
        } catch (e) {
          news = []; // no news is fine: the comparison falls back to their usual routine
        }
        wait.setText(`Comparing with ${persona}…`);
      }
      const newsBlock = news.length
        ? `\n\nNEWS ABOUT ${persona.toUpperCase()} published on ${longDate(entry.date)} (headlines; some may be `
          + `about other people or other days):\n${news.map((n, i) => `[${i + 1}] ${n.title} (${n.source})`).join("\n")}`
        : "";
      const newsRules = news.length ? [
        "",
        `The user message ends with news headlines about ${persona} from that day. If some clearly say what ${persona}`,
        "did, said or faced on that day, that is their real day: build their timeline and persona_day around it, with",
        "their usual routine only filling the hours the news doesn't cover. Set from_news on rows the news informs.",
        "in_the_news: 1 to 4 items, each a one-sentence summary of what the news says about them that day, with ref =",
        "the headline's [number]. Use only what the headlines say; never invent details beyond them.",
        "If no headline is clearly about them on that day, return in_the_news as [] and ignore the news entirely.",
      ] : [];

      const res = await llm(s, {
        thinking: "medium",
        system: [
          "You are a candid, encouraging performance coach.",
          `Compare the author's day in focus with how ${persona} would likely spend a comparable day,`,
          "based on what is publicly known about their habits and priorities. Earlier days are background only.",
          "Ground every claim about the author in the journal text. Never invent events in their life.",
          `areas: rate the day in focus on each of these life areas:\n${areaGuide(areas)}`,
          RATING_SCALE,
          "Advice must be concrete and doable tomorrow, adapted to the author's life, not a copy of the persona's.",
          "",
          `timeline: an hour-by-hour comparison of the day in focus. Include a row for each of: ${times.join(", ")}.`,
          "Also add a row for any other time the author wrote down for that day (e.g. \"woke up at 9.30AM\").",
          "Rows in chronological order; time written like \"6 AM\" or \"9:30 AM\".",
          `persona: what ${persona} would typically be doing at that hour, from public accounts of their routine. Max 15 words.`,
          "me: what the author was doing then, in their own terms and times. If the entry clearly implies it",
          "(e.g. still asleep before a stated wake-up time), say so. If it doesn't say, write exactly \"Not in the journal\".",
          "Never fill a gap with a guess about the author. Max 15 words.",
          ...newsRules,
          "",
          "Speak to the author as \"you\".",
        ].join("\n"),
        contents: [{ role: "user", parts: [{ text: `My journal:\n\n${ctx}${newsBlock}` }] }],
        schema: {
          type: "OBJECT",
          properties: {
            one_line: { type: "STRING" },
            persona_day: { type: "STRING" },
            timeline: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  time: { type: "STRING" },
                  persona: { type: "STRING" },
                  me: { type: "STRING" },
                  from_news: { type: "BOOLEAN" },
                },
                required: ["time", "persona", "me", "from_news"],
              },
            },
            in_the_news: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { summary: { type: "STRING" }, ref: { type: "INTEGER" } },
                required: ["summary", "ref"],
              },
            },
            went_well: { type: "ARRAY", items: { type: "STRING" } },
            be_more_effective: { type: "ARRAY", items: { type: "STRING" } },
            areas: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  area: { type: "STRING" },
                  level: { type: "STRING", enum: LEVELS },
                  evidence: { type: "STRING" },
                },
                required: ["area", "level", "evidence"],
              },
            },
          },
          required: ["one_line", "persona_day", "timeline", "in_the_news", "went_well", "be_more_effective", "areas"],
        },
      }, this.onRetry);

      const LEVEL = { focused: "▂▄▆ Focused", some: "▂▄ Some", neglected: "▂ Neglected", none: "· Not today" };
      const rows = (res.timeline || [])
        .filter((r) => r && r.time)
        .sort((a, b) => dayOrder(a.time) - dayOrder(b.time));
      // Only items that point at a real headline count; links come from the feed, never from the model.
      const inNews = (res.in_the_news || [])
        .map((n) => ({ summary: n && n.summary, item: news[(n && n.ref) - 1] }))
        .filter((n) => n.summary && n.item);
      const newsMd = inNews.length ? [
        `> [!info] 📰 ${persona} in the news on ${fmtDate(entry.date)}`,
        ...inNews.map(({ summary, item }) => `> - ${summary} ([${item.source || "source"}](${item.link}))`),
        "",
      ] : [];
      const mark = (r) => (inNews.length && r.from_news ? "📰 " : "");
      const md = [
        `**${res.one_line}**`,
        "",
        ...newsMd,
        `| Time | ${cell(persona)}${inNews.length ? " (📰 = from the news)" : ""} | You |`,
        "| --- | --- | --- |",
        ...rows.map((r) => `| **${cell(r.time)}** | ${mark(r)}${cell(r.persona)} | ${cell(r.me)} |`),
        "",
        `**${persona}'s day ${inNews.length ? "that day" : "in short"}:** ${res.persona_day}`,
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
        Object.assign(focus, this.focusMap(res.areas, areas));
        fm.focus = focus;
      });
      await this.addMessage("assistant", `### ${fmtDate(entry.date)} vs ${persona}\n\n${md}\n\n`
        + `*Saved to ${entry.file.basename}.*`, { sourcePath: entry.file.path, copy: true });
    });
  }

  /* ----- titles ----- */

  /**
   * Title, highlights and life-area ratings for one entry, written to its frontmatter.
   * An existing title and highlights are kept (only missing ratings are added) unless overwrite is set.
   */
  async generateTitle(entry, { overwrite = true } = {}) {
    const text = await this.entryText(entry.file);
    if (!text) return null;
    const areas = splitList(this.plugin.settings.areas);
    const res = await llm(this.plugin.settings, {
      thinking: "low",
      system: `${TITLE_SYSTEM}\nLife areas:\n${areaGuide(areas)}`,
      contents: [{ role: "user", parts: [{ text: `Journal entry for ${longDate(entry.date)}:\n\n${text}` }] }],
      schema: TITLE_SCHEMA,
    }, this.onRetry);
    const title = String(res.title || "").trim().replace(/^["']|["']$/g, "").replace(/\.$/, "");
    const highlights = (res.highlights || []).map((h) => String(h).trim()).filter(Boolean).slice(0, 5);
    const focus = this.focusMap(res.areas, areas);
    if (!title) return null;
    // Without overwrite, only what's missing is written: a title or highlights already there are kept.
    const keepTitle = !overwrite && this.hasTitle(entry);
    const keepHighlights = !overwrite && this.hasHighlights(entry);
    await this.plugin.setFrontmatter(entry.file, (fm) => {
      if (!keepTitle) fm.title = title;
      if (!keepHighlights) fm.highlights = highlights;
      if (Object.keys(focus).length) fm.focus = focus;
    });
    const fm = (this.app.metadataCache.getFileCache(entry.file) || {}).frontmatter || {};
    return {
      title: keepTitle ? String(fm.title) : title,
      highlights: keepHighlights ? [] : highlights,
      focus,
      kept: keepTitle && keepHighlights,
    };
  }

  /** [{area, level}] from Gemini -> { Area: level } in the order of the settings' life areas. */
  focusMap(rows, areas) {
    const out = {};
    const byName = new Map((rows || []).filter((r) => r && r.area && r.level)
      .map((r) => [String(r.area).trim().toLowerCase(), String(r.level).toLowerCase()]));
    for (const a of areas) {
      const lv = byName.get(a.toLowerCase());
      if (LEVELS.includes(lv)) out[a] = lv;
    }
    return out;
  }

  /** Rated on exactly the current life areas (a day rated on old areas, e.g. Self-realization, isn't). */
  hasFocus(e) {
    const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter;
    const focus = fm && fm.focus;
    if (!focus || typeof focus !== "object" || Array.isArray(focus)) return false;
    const have = new Set(Object.keys(focus).map((k) => k.toLowerCase()));
    const want = splitList(this.plugin.settings.areas).map((a) => a.toLowerCase());
    return want.length === have.size && want.every((a) => have.has(a));
  }

  hasHighlights(e) {
    const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter;
    const h = fm && fm.highlights;
    return Array.isArray(h) ? h.some((x) => typeof x === "string" && x.trim()) : typeof h === "string" && !!h.trim();
  }

  /** A day the batch should process: missing a title, highlights, or ratings on the current life areas. */
  needsWork(e) {
    return !this.hasTitle(e) || !this.hasHighlights(e) || !this.hasFocus(e);
  }

  /** The one-button catch-up: title, highlights and life areas for every day in the journal that lacks any. */
  fillEverything() {
    return this.titleMonth("all");
  }

  /** "Fill in everything missing (N days)", or a disabled "Nothing missing" when the journal is complete. */
  fillEverythingItem(menu, go) {
    const n = this.entries().filter((e) => this.needsWork(e)).length;
    menu.addItem((i) => {
      i.setTitle(n ? `Fill in everything missing (${n} day${n === 1 ? "" : "s"})` : "Nothing missing in the journal")
        .setIcon("wand-sparkles");
      if (n) i.onClick(go(() => this.fillEverything()));
      else i.setDisabled(true);
    });
  }

  focusLine(focus) {
    const DOT = { focused: "🟢", some: "🟡", neglected: "🔴", none: "⚪" };
    return Object.entries(focus || {}).map(([a, l]) => `${DOT[l] || ""} ${a}`).join(" · ");
  }

  async titleDay(entry) {
    entry = entry || this.focusEntry();
    if (!entry) return new Notice("No journal entries in this view.");
    await this.run(`Titling ${fmtDate(entry.date)}…`, async () => {
      const r = await this.generateTitle(entry);
      if (!r) return this.addMessage("system", `${fmtDate(entry.date)} has no text to title.`);
      await this.addMessage("assistant", `**${fmtDate(entry.date)} — ${r.title}**\n\n`
        + r.highlights.map((h) => `- ${h}`).join("\n")
        + (Object.keys(r.focus).length ? `\n\n${this.focusLine(r.focus)}` : ""), { sourcePath: entry.file.path });
    });
  }

  /** { y, m } of the day in view, or null. */
  focusMonth() {
    const entry = this.focusEntry();
    return entry ? { y: entry.date.getFullYear(), m: entry.date.getMonth() } : null;
  }

  monthEntries(month) {
    return this.entries().filter((e) => e.date.getFullYear() === month.y && e.date.getMonth() === month.m);
  }

  monthLabel(month) {
    return `${MONTHS_LONG[month.m]} ${month.y}`;
  }

  /** Every month that has entries, newest first: [{ y, m, entries }]. */
  journalMonths() {
    const byKey = new Map();
    for (const e of this.entries()) {
      const y = e.date.getFullYear(), m = e.date.getMonth();
      const key = y * 12 + m;
      if (!byKey.has(key)) byKey.set(key, { y, m, entries: [] });
      byKey.get(key).entries.push(e);
    }
    return Array.from(byKey.entries()).sort((a, b) => b[0] - a[0]).map(([, v]) => v);
  }

  hasTitle(e) {
    const fm = (this.app.metadataCache.getFileCache(e.file) || {}).frontmatter;
    return !!(fm && typeof fm.title === "string" && fm.title.trim());
  }

  timelinePath(month) {
    const mm = String(month.m + 1).padStart(2, "0");
    return normalizePath(`${this.summariesDir()}/${month.y}/${month.y}-${mm} ${MONTHS[month.m]} Timeline.md`);
  }

  /** rerate: redo life-area ratings on every day (titles are kept), e.g. after changing the areas. */
  pickTitleMonth(rerate = false) {
    const months = this.journalMonths();
    if (!months.length) return new Notice("No journal entries in this view.");
    if (rerate) {
      const items = [{ label: "All months", note: `${this.entries().length} days`, value: "all" }]
        .concat(months.map((mo) => ({ label: this.monthLabel(mo), note: `${mo.entries.length} days`, value: mo })));
      return new MonthPickerModal(this.app, "Re-rate life areas in which month? Titles are kept.", items,
        (v) => this.titleMonth(v, { rerate: true })).open();
    }
    const items = [];
    const todoAll = months.reduce((n, mo) => n + mo.entries.filter((e) => this.needsWork(e)).length, 0);
    if (todoAll) {
      items.push({ label: "All months", note: `${todoAll} days to title or rate across ${months.length} months`, value: "all" });
    }
    for (const mo of months) {
      const todo = mo.entries.filter((e) => this.needsWork(e)).length;
      items.push({
        label: this.monthLabel(mo),
        note: todo ? `${todo} of ${mo.entries.length} days to title or rate` : `All ${mo.entries.length} days done`,
        value: mo,
      });
    }
    new MonthPickerModal(this.app, "Title and rate days in which month?", items,
      (v) => this.titleMonth(v)).open();
  }

  /** Title every untitled day in `month` ({ y, m }), or in the whole journal when month is "all". */
  async titleMonth(month, { rerate = false } = {}) {
    if (!month) return new Notice("No journal entries in this view.");
    const all = month === "all";
    const scope = all ? "the whole journal" : this.monthLabel(month);
    const pool = all ? this.entries().slice().reverse() : this.monthEntries(month); // all: newest first
    const todo = rerate ? pool : pool.filter((e) => this.needsWork(e));
    this.show();
    if (!pool.length) return this.addMessage("system", `No entries in ${scope}.`);
    if (!todo.length) {
      return this.addMessage("system", `Nothing missing: every entry in ${scope} has a title, highlights and ratings `
        + `on ${splitList(this.plugin.settings.areas).join(", ")}.`);
    }
    const verb = rerate ? "Re-rate" : "Fill in title, highlights and life areas for";
    await this.addMessage("user", `${verb} ${todo.length} day${todo.length === 1 ? "" : "s"} in ${scope}`);
    let stop = false;
    await this.run(`Working through ${todo.length} entries in ${scope}…`, async (wait) => {
      // Long batches can be stopped; titles written so far are kept (they're already in the notes).
      const stopBtn = todo.length > 3 ? this.messagesEl.createEl("button", { cls: "jsa-stop", text: "Stop" }) : null;
      if (stopBtn) this.registerDomEvent(stopBtn, "click", () => {
        stop = true;
        stopBtn.setText("Stopping after the days in progress…");
        stopBtn.disabled = true;
      });
      // Three days at a time; results are listed in date order at the end, whatever order they finish in.
      const lines = new Array(todo.length).fill(null);
      let done = 0, failed = 0, started = 0, finished = 0, badKey = false;
      const progress = () => {
        const label = `${verb === "Re-rate" ? "Re-rating" : "Filling in"} ${scope}: ${finished} of ${todo.length} done`
          + (failed ? `, ${failed} failed` : "") + "…";
        wait.setText(label);
        this.onRetry = this.retrying(wait, label);
      };
      const worker = async () => {
        while (!stop && !badKey && started < todo.length) {
          const i = started++;
          const e = todo[i];
          try {
            // Never overwrite: a title or highlights already there are kept; ratings are (re)written.
            const r = await this.generateTitle(e, { overwrite: false });
            lines[i] = r ? `- **${fmtDate(e.date)}** — ${r.title}${r.kept ? " (rated)" : ""}  ${this.focusLine(r.focus)}`
              : `- ${fmtDate(e.date)} — skipped (empty)`;
            if (r) done++;
          } catch (err) {
            failed++;
            lines[i] = `- ${fmtDate(e.date)} — failed: ${err.message || err}`;
            if (/^\S+ 4(01|03)\b/.test(err.message || "")) badKey = true; // bad key (any provider): stop
            else await sleep(4000); // likely rate-limited; back off
          }
          finished++;
          progress();
          await sleep(150);
        }
      };
      progress();
      try {
        await Promise.all([worker(), worker(), worker()]);
      } finally {
        if (stopBtn) stopBtn.remove();
      }
      const head = stop || badKey ? `**${scope}: stopped after ${done} of ${todo.length}**`
        : `**${scope}: ${done} filled in${failed ? `, ${failed} failed (run it again to retry just those)` : ""}**`;
      // Keep the summary readable for whole-journal runs.
      const ran = lines.filter(Boolean); // days never started (after Stop) aren't listed
      const shown = ran.length > 40 ? [...ran.slice(0, 40), `- …and ${ran.length - 40} more`] : ran;
      await this.addMessage("assistant", `${head}\n\n${shown.join("\n")}`);
    });
  }

  /* ----- monthly timeline ----- */

  pickTimelineMonth() {
    const months = this.journalMonths();
    if (!months.length) return new Notice("No journal entries in this view.");
    const items = months.map((mo) => ({
      label: this.monthLabel(mo),
      note: `${mo.entries.length} days · `
        + (this.app.vault.getAbstractFileByPath(this.timelinePath(mo)) ? "timeline exists (will be replaced)" : "no timeline yet"),
      value: mo,
    }));
    new MonthPickerModal(this.app, "Summarize which month as a timeline?", items, (v) => this.monthTimeline(v)).open();
  }

  /** Write the timeline note for `target` ({ y, m }). */
  async monthTimeline(target) {
    if (!target) return new Notice("No journal entries in this view.");
    const list = this.monthEntries(target);
    const y = target.y, m = target.m;
    const month = `${MONTHS_LONG[m]} ${y}`;
    this.show();
    if (!list.length) return this.addMessage("system", `No entries in ${month}.`);
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
      const md = await llm(this.plugin.settings, {
        thinking: "high",
        system: [
          "You turn a month of private daily journal entries into a timeline the author will keep.",
          "Write Markdown with exactly these sections:",
          "## In a line — one sentence on what the month was about.",
          "## Timeline — grouped by week (### Week of <d Mon>), bullets that start with the date like \"**3 Nov** —\".",
          "## People — who was around and in what context.",
          "## Themes — 3 to 6 recurring threads, one line each.",
          `## Focus — one line each for these areas, on how much attention it got this month:\n${areaGuide(areas)}`,
          "Use only what the entries say. Do not invent. First person is fine (\"I\"), matching the author.",
        ].join("\n"),
        contents: [{ role: "user", parts: [{ text: `Entries for ${month}:\n\n${parts.join("\n\n")}` }] }],
      }, this.onRetry);

      const s = this.plugin.settings;
      const folder = normalizePath(`${this.view.dir}/${s.summariesFolder || "Summaries"}/${y}`);
      const path = normalizePath(`${folder}/${y}-${String(m + 1).padStart(2, "0")} ${MONTHS[m]} Timeline.md`);
      const fm = stringifyYaml({
        type: "timeline",
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        entries: list.length,
        generated: new Date().toISOString().slice(0, 10),
        model: modelLabel(activeModel(s)),
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
    // Life areas moved to Family, Networking, Health, Career, Hobbies, Growth (Self-realization dropped).
    if ((this.settings.areas || "").trim() === OLD_DEFAULT_AREAS) {
      this.settings.areas = DEFAULT_SETTINGS.areas;
      await this.saveSettings();
    }
    if (this.migrateProviders()) await this.saveSettings();
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
      id: "fill-everything",
      name: "Fill in everything missing (titles, highlights, life areas) across the journal",
      checkCallback: (checking) => {
        const panel = this.activePanel();
        if (!panel) return false;
        if (!checking) panel.fillEverything();
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

  /**
   * Give every provider a config block, and carry the old single-Gemini settings
   * ({ apiKey, model }) over into providers.gemini. Returns true if anything changed.
   */
  migrateProviders() {
    const s = this.settings;
    let changed = false;
    // Never mutate DEFAULT_SETTINGS.providers, which Object.assign hands over when nothing is saved yet.
    s.providers = s.providers && typeof s.providers === "object" && s.providers !== DEFAULT_SETTINGS.providers
      ? s.providers : {};
    for (const def of PROVIDERS) {
      if (s.providers[def.id]) continue;
      s.providers[def.id] = { enabled: false, apiKey: "", baseUrl: def.baseUrl || "", models: def.defaultModels.slice() };
      changed = true;
    }
    const g = s.providers.gemini;
    if (typeof s.apiKey === "string" || typeof s.model === "string") {
      if (s.apiKey && !g.apiKey) {
        g.apiKey = s.apiKey;
        g.enabled = true;
      }
      if (s.model) {
        g.models = [s.model].concat(g.models.filter((m) => m !== s.model));
        if (!s.activeModel) s.activeModel = modelKey("gemini", s.model);
      }
      delete s.apiKey;
      delete s.model;
      changed = true;
    }
    // Gemini 2.x is being retired (2.5 Flash is rerouted to 3.5 Flash-Lite on 1 Dec 2026).
    if (g.models.some((m) => /^gemini-2[.-]/.test(m))) {
      g.models = g.models.filter((m) => !/^gemini-2[.-]/.test(m));
      if (!g.models.length) g.models = PROVIDERS[0].defaultModels.slice();
      if (/^gemini::gemini-2[.-]/.test(s.activeModel || "")) s.activeModel = modelKey("gemini", g.models[0]);
      changed = true;
    }
    return changed;
  }

  /** Switch the model every request uses, from settings or any chat panel, and update every picker. */
  async setActiveModel(key) {
    this.settings.activeModel = key;
    await this.saveSettings();
    this.refreshModelPickers();
  }

  refreshModelPickers() {
    for (const panel of this.panels.values()) panel.refreshModelSelects();
  }

  /**
   * Public entry point for the action row at the bottom of each day in Journal Scroll:
   * app.plugins.plugins["journal-scroll-assistant"]
   *   .openActionMenu("chat" | "compare" | "regenerate" | "summarize", evt, { view, file, onStart, anchor }).
   */
  openActionMenu(kind, evt, { view, file, onStart, anchor } = {}) {
    this.attachAll();
    const panel = view && this.panels.get(view);
    if (!panel) return new Notice("Open the journal in Journal Scroll to use the assistant.");
    panel.openActionMenu(kind, evt, file, onStart, anchor);
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

/* ---------------- tag input (settings) ---------------- */

/*
 * People worth comparing a day with: each is known for a well-documented daily routine and
 * a long-range vision, so Gemini has real material for the hour-by-hour table.
 * hint = the routine or vision they are known for, shown in the dropdown.
 */
const FAMOUS_PEOPLE = [
  { name: "Elon Musk", hint: "Runs his day in 5-minute blocks · multi-planetary vision" },
  { name: "Steve Jobs", hint: "Daily mirror question, walking meetings · product taste" },
  { name: "Jensen Huang", hint: "Long hours, flat team, no 1:1s · accelerated computing" },
  { name: "Bill Gates", hint: "Think Weeks, ~50 books a year · global health" },
  { name: "Jeff Bezos", hint: "8 hours' sleep, key meetings at 10 AM · Day 1 mindset" },
  { name: "Warren Buffett", hint: "Reads 5–6 hours a day · long-term compounding" },
  { name: "Tim Cook", hint: "Up before 4 AM, gym before work" },
  { name: "Satya Nadella", hint: "Learn-it-all growth mindset · reads and listens daily" },
  { name: "Sundar Pichai", hint: "Calm mornings with the news · AI-first vision" },
  { name: "Demis Hassabis", hint: "A second work shift late at night · AI for science" },
  { name: "Sam Altman", hint: "Ruthless focus on few priorities · AGI vision" },
  { name: "Paul Graham", hint: "Maker's schedule, long writing blocks" },
  { name: "Naval Ravikant", hint: "Reads daily, plays long-term games" },
  { name: "Jack Dorsey", hint: "Themed days while running two companies" },
  { name: "Richard Branson", hint: "Up at 5 AM, exercise first" },
  { name: "Oprah Winfrey", hint: "Meditation and a gratitude journal" },
  { name: "Barack Obama", hint: "Morning workout, late-night reading and writing" },
  { name: "Indra Nooyi", hint: "Early starts, relentless preparation" },
  { name: "Ratan Tata", hint: "Early riser · values-led leadership" },
  { name: "N. R. Narayana Murthy", hint: "First into the office · discipline above all" },
  { name: "A. P. J. Abdul Kalam", hint: "Worked late, rose early · vision for India" },
  { name: "Benjamin Franklin", hint: "Famous hourly schedule · 'What good shall I do this day?'" },
  { name: "Charles Darwin", hint: "Three 90-minute work blocks and daily walks" },
  { name: "Marie Curie", hint: "Relentless lab focus · two Nobel Prizes" },
  { name: "Albert Einstein", hint: "Long sleep, daily walks, thought experiments" },
  { name: "Nikola Tesla", hint: "Obsessive work hours · visual thinking" },
  { name: "Richard Feynman", hint: "Protected deep-work time · playful curiosity" },
  { name: "Leonardo da Vinci", hint: "Notebooks of endless curiosity" },
  { name: "Winston Churchill", hint: "Mornings working from bed, afternoon nap" },
  { name: "Mahatma Gandhi", hint: "Daily walks, prayer and spinning · simplicity" },
  { name: "Marcus Aurelius", hint: "Morning reflection · Meditations" },
  { name: "Haruki Murakami", hint: "Up at 4 AM, writes 5–6 hours, runs 10 km" },
  { name: "Maya Angelou", hint: "Wrote daily in a rented hotel room" },
  { name: "Stephen King", hint: "2,000 words every single day" },
  { name: "Ernest Hemingway", hint: "Wrote at first light" },
  { name: "A. R. Rahman", hint: "Composes through the night" },
  { name: "Kobe Bryant", hint: "4 AM workouts · Mamba mentality" },
  { name: "Cristiano Ronaldo", hint: "Strict training, sleep and naps" },
  { name: "Virat Kohli", hint: "Strict fitness and diet discipline" },
  { name: "Sachin Tendulkar", hint: "Endless practice, quiet discipline" },
  { name: "Serena Williams", hint: "Training discipline · competitive drive" },
  { name: "Arnold Schwarzenegger", hint: "Early workouts, written goals" },
  { name: "Dwayne Johnson", hint: "4 AM workouts, 'clank and bang'" },
  { name: "Tim Ferriss", hint: "Morning rituals · self-experiments" },
  { name: "Andrew Huberman", hint: "Morning sunlight, delayed caffeine" },
];

/** Life areas to pick from; the first six have definitions in AREA_DEFS for consistent ratings. */
const LIFE_AREA_SUGGESTIONS = [
  { name: "Family", hint: AREA_DEFS.family },
  { name: "Networking", hint: AREA_DEFS.networking },
  { name: "Health", hint: AREA_DEFS.health },
  { name: "Career", hint: AREA_DEFS.career },
  { name: "Hobbies", hint: AREA_DEFS.hobbies },
  { name: "Growth", hint: AREA_DEFS.growth },
  { name: "Finance", hint: "Rated by name: money, saving, investing, spending" },
  { name: "Fitness", hint: "Rated by name: workouts, sport, movement" },
  { name: "Sleep", hint: "Rated by name: hours and quality of sleep" },
  { name: "Mindfulness", hint: "Rated by name: meditation, calm, presence" },
  { name: "Spirituality", hint: "Rated by name: faith, prayer, meaning" },
  { name: "Relationships", hint: "Rated by name: partner and close friendships" },
  { name: "Learning", hint: "Rated by name: courses, study, new skills" },
  { name: "Reading", hint: "Rated by name: books and long-form reading" },
  { name: "Creativity", hint: "Rated by name: writing, art, music, building" },
  { name: "Community", hint: "Rated by name: giving back, volunteering" },
  { name: "Home", hint: "Rated by name: chores, home projects, errands" },
  { name: "Travel", hint: "Rated by name: trips and exploring" },
  { name: "Fun", hint: "Rated by name: play, rest, leisure" },
];

/**
 * Chips + a combobox. The list of options is always one click away:
 *   - click anywhere in the field, or the ▾ button, to see every option (no typing needed)
 *   - type to filter the same list; anything not listed can still be added as typed
 *   - ↑/↓ move, Enter or Tab adds the highlighted option, Esc closes,
 *     Backspace in an empty field removes the last chip, × on a chip removes it
 * The list is a popover on document.body with position: fixed, like Obsidian's own menus,
 * so the settings window's scrolling and stacking can't clip or cover it.
 * opts: { values, suggestions: [{ name, hint }], placeholder, onChange(values) }
 */
class TagInput {
  constructor(parent, opts) {
    this.opts = opts;
    this.values = (opts.values || []).slice();
    this.active = 0;
    this.matches = [];
    this.custom = null;
    this.open = false;

    this.root = parent.createDiv({ cls: "jsa-tags" });
    this.field = this.root.createDiv({ cls: "jsa-tags-field" });
    this.chipsEl = this.field.createDiv({ cls: "jsa-tags-chips" });
    this.input = createEl("input", {
      cls: "jsa-tags-input",
      attr: {
        type: "text", placeholder: opts.placeholder || "Add…", spellcheck: "false", autocomplete: "off",
        role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list",
      },
    });
    this.toggleBtn = this.field.createEl("button", {
      cls: "jsa-tags-toggle", attr: { type: "button", "aria-label": "Show all options", tabindex: "-1" },
    });
    setIcon(this.toggleBtn, "chevron-down");

    this.pop = createDiv({ cls: "jsa-tags-pop", attr: { role: "listbox" } });
    TagInput.live.add(this);

    // Open on any click in the field; the ▾ button toggles.
    this.field.addEventListener("mousedown", (e) => {
      if (e.target.closest(".jsa-tag-remove")) return;
      if (e.target.closest(".jsa-tags-toggle")) {
        e.preventDefault();
        if (this.open) this.close();
        else { this.input.focus(); this.show(); }
        return;
      }
      if (e.target !== this.input) e.preventDefault();
      this.input.focus();
      this.show();
    });
    this.input.addEventListener("focus", () => this.show());
    this.input.addEventListener("input", () => { this.active = 0; this.show(); });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    // Close when focus leaves for anything other than the popover.
    this.input.addEventListener("blur", () => window.setTimeout(() => {
      if (document.activeElement !== this.input) this.close();
    }, 120));

    this.onOutside = (e) => {
      if (!this.root.isConnected) return this.close();
      if (this.root.contains(e.target) || this.pop.contains(e.target)) return;
      this.close();
    };
    this.onReflow = () => (this.root.isConnected ? this.position() : this.close());
    this.renderChips();
  }

  has(name) {
    return this.values.some((v) => v.toLowerCase() === String(name).toLowerCase());
  }

  add(name) {
    name = String(name || "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    this.input.value = "";
    if (name && !this.has(name)) {
      this.values.push(name);
      this.changed();
    } else {
      this.show();
    }
  }

  remove(i) {
    this.values.splice(i, 1);
    this.changed();
  }

  changed() {
    this.renderChips();
    this.opts.onChange(this.values.slice());
    this.input.focus();
    this.active = 0;
    this.show(); // keep the list open so several can be picked in a row
  }

  renderChips() {
    this.chipsEl.empty();
    this.values.forEach((v, i) => {
      const chip = this.chipsEl.createSpan({ cls: "jsa-tag" });
      chip.createSpan({ cls: "jsa-tag-text", text: v });
      const x = chip.createEl("button", { cls: "jsa-tag-remove", attr: { type: "button", "aria-label": `Remove ${v}` } });
      setIcon(x, "x");
      x.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the field
      x.addEventListener("click", (e) => { e.stopPropagation(); this.remove(i); });
    });
    this.chipsEl.appendChild(this.input);
  }

  /** Options not yet chosen. Empty field: all of them. Typed text: name matches first, then hint matches. */
  filter() {
    const q = this.input.value.trim().toLowerCase();
    const pool = (this.opts.suggestions || []).filter((s) => !this.has(s.name));
    if (!q) return { q, matches: pool };
    const words = (s) => s.name.toLowerCase().split(/[\s./_-]+/);
    const starts = pool.filter((s) => s.name.toLowerCase().startsWith(q) || words(s).some((w) => w.startsWith(q)));
    const rest = pool.filter((s) => !starts.includes(s)
      && (s.name.toLowerCase().includes(q) || (s.hint || "").toLowerCase().includes(q)));
    return { q, matches: starts.concat(rest) };
  }

  show() {
    if (!this.root.isConnected) return;
    const { q, matches } = this.filter();
    this.matches = matches;
    const exact = q && (matches.some((m) => m.name.toLowerCase() === q) || this.has(q));
    this.custom = q && !exact ? this.input.value.trim() : null;
    const rows = matches.length + (this.custom ? 1 : 0);
    this.active = rows ? Math.max(0, Math.min(this.active, rows - 1)) : 0;

    this.pop.empty();
    const total = (this.opts.suggestions || []).filter((s) => !this.has(s.name)).length;
    this.pop.createDiv({
      cls: "jsa-tags-pop-head",
      text: q ? `${matches.length} of ${total} match "${this.input.value.trim()}"`
        : total ? `${total} to choose from. Type to filter, or add your own.` : "All suggestions added. Type to add your own.",
    });
    matches.forEach((m, i) => this.row(i, m.name, m.hint, () => this.add(m.name)));
    if (this.custom) {
      const text = this.custom;
      this.row(matches.length, `Add "${text}"`, matches.length ? "Not in the list: add it as typed" : "No match: add it as typed",
        () => this.add(text), true);
    }

    if (!this.open) {
      document.body.appendChild(this.pop);
      document.addEventListener("mousedown", this.onOutside, true);
      window.addEventListener("resize", this.onReflow);
      window.addEventListener("scroll", this.onReflow, true);
      this.open = true;
      this.root.addClass("is-open");
      this.input.setAttr("aria-expanded", "true");
    }
    this.position();
    const act = this.pop.querySelector(".jsa-tags-option.is-active");
    if (act) act.scrollIntoView({ block: "nearest" });
  }

  /** Below the field, or above it when there's more room there. */
  position() {
    const r = this.field.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    const max = Math.max(140, Math.min(340, up ? above : below));
    setCssProps(this.pop, {
      left: `${Math.round(r.left)}px`,
      width: `${Math.round(r.width)}px`,
      top: up ? "auto" : `${Math.round(r.bottom + 4)}px`,
      bottom: up ? `${Math.round(window.innerHeight - r.top + 4)}px` : "auto",
      "max-height": `${Math.round(max)}px`,
    });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.pop.remove();
    document.removeEventListener("mousedown", this.onOutside, true);
    window.removeEventListener("resize", this.onReflow);
    window.removeEventListener("scroll", this.onReflow, true);
    this.root.removeClass("is-open");
    this.input.setAttr("aria-expanded", "false");
  }

  row(i, title, hint, pick, isCustom) {
    const el = this.pop.createDiv({
      cls: `jsa-tags-option${i === this.active ? " is-active" : ""}${isCustom ? " is-custom" : ""}`,
      attr: { role: "option" },
    });
    el.createDiv({ cls: "jsa-tags-option-name", text: title });
    if (hint) el.createDiv({ cls: "jsa-tags-option-hint", text: hint });
    el.addEventListener("mousedown", (e) => { e.preventDefault(); pick(); });
    el.addEventListener("mouseenter", () => {
      this.active = i;
      this.pop.querySelectorAll(".jsa-tags-option").forEach((o, j) => o.toggleClass("is-active", j === i));
    });
  }

  onKey(e) {
    const rows = this.matches.length + (this.custom ? 1 : 0);
    const typed = this.input.value.trim();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.open) return this.show();
      if (!rows) return;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + rows) % rows;
      this.show();
    } else if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && this.open && typed)) {
      if (e.key !== "Enter" && !typed) return;
      e.preventDefault();
      if (this.open && this.active < this.matches.length && (typed || e.key === "Enter")) {
        this.add(this.matches[this.active].name);
      } else if (typed) {
        this.add(typed);
      }
    } else if (e.key === "Backspace" && !this.input.value && this.values.length) {
      e.preventDefault();
      this.remove(this.values.length - 1);
    } else if (e.key === "Escape" && this.open) {
      e.preventDefault();
      e.stopPropagation(); // close the list, not the settings window
      this.close();
    } else if (e.key === "Tab") {
      this.close();
    }
  }
}

/** Obsidian's setCssProps, with a fallback for older builds. */
function setCssProps(el, props) {
  if (el.setCssProps) el.setCssProps(props);
  else for (const k of Object.keys(props)) el.style.setProperty(k, props[k]);
}

/** Every TagInput made, so the settings tab can close any open list when it redraws or closes. */
TagInput.live = new Set();
TagInput.closeAll = () => {
  for (const t of Array.from(TagInput.live)) {
    t.close();
    if (!t.root.isConnected) TagInput.live.delete(t);
  }
};

class AssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.fetched = {}; // provider id -> model ids loaded from the provider this session
  }

  hide() {
    TagInput.closeAll();
  }

  /* ----- models & providers ----- */

  renderModels(containerEl) {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Models").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description jsa-providers-intro",
      text: "Switch on any providers you have a key for; several can be on at once. Every model you list "
        + "appears in the assistant's model picker, grouped by provider, so when one is down you can switch "
        + "and retry straight from the chat.",
    });

    const models = enabledModels(s);
    const active = activeModel(s);
    new Setting(containerEl)
      .setName("Model in use")
      .setDesc(active ? `Requests go to ${active.def.label}: ${active.model}. Also switchable in the chat header.`
        : "Switch on a provider below and add a model to start.")
      .addDropdown((d) => {
        if (!models.length) d.addOption("", "No model set up");
        for (const m of models) d.addOption(m.key, `${m.def.label} · ${m.model}`);
        d.setValue(active ? active.key : "").onChange(async (v) => {
          await this.plugin.setActiveModel(v);
          this.display();
        });
      });

    const list = containerEl.createDiv({ cls: "jsa-providers" });
    for (const def of PROVIDERS) this.renderProvider(list, def);
  }

  renderProvider(parent, def) {
    const s = this.plugin.settings;
    const cfg = s.providers[def.id];
    const ready = cfg.enabled && cfg.apiKey && cfg.models.length;
    const status = !cfg.enabled ? ["Off", "is-off"]
      : !cfg.apiKey ? ["Needs a key", "is-warn"]
        : !cfg.models.length ? ["No models", "is-warn"] : ["On", "is-on"];
    const card = parent.createDiv({ cls: `jsa-provider ${cfg.enabled ? "is-enabled" : ""} ${ready ? "is-ready" : ""}` });
    const save = async (redraw) => {
      await this.plugin.saveSettings();
      this.plugin.refreshModelPickers();
      if (redraw) this.display();
    };

    const head = new Setting(card).setName(def.label).setDesc(def.blurb);
    head.settingEl.addClass("jsa-provider-head");
    head.nameEl.createSpan({ cls: `jsa-provider-status ${status[1]}`, text: status[0] });
    head.addToggle((t) => t.setValue(cfg.enabled).setTooltip(cfg.enabled ? "Switch off" : "Switch on")
      .onChange(async (v) => {
        cfg.enabled = v;
        await save(true);
      }));
    if (!cfg.enabled) return;

    const body = card.createDiv({ cls: "jsa-provider-body" });
    new Setting(body)
      .setName("API key")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.addClass("jsa-key-input");
        t.setPlaceholder(def.keyPlaceholder).setValue(cfg.apiKey).onChange(async (v) => {
          cfg.apiKey = v.trim();
          await save(false);
        });
        this.keyInput = t.inputEl;
      })
      .addExtraButton((b) => {
        const input = this.keyInput;
        b.setIcon("eye").setTooltip("Show or hide the key").onClick(() => {
          input.type = input.type === "password" ? "text" : "password";
        });
      });

    if (def.kind === "openai") {
      new Setting(body)
        .setName("Base URL")
        .setDesc(`OpenAI-compatible endpoint. Default: ${def.baseUrl}`)
        .addText((t) => t.setPlaceholder(def.baseUrl).setValue(cfg.baseUrl || def.baseUrl).onChange(async (v) => {
          cfg.baseUrl = v.trim() || def.baseUrl;
          await save(false);
        }));
    }

    const modelsSetting = new Setting(body)
      .setName("Models")
      .setDesc("Each one appears in the chat's model picker. Type to pick a suggestion, or type any model "
        + "id and press Enter. \"Load models\" fetches everything your key can use.");
    modelsSetting.settingEl.addClass("jsa-tag-setting");
    const fetched = (this.fetched[def.id] || []).filter((id) => !def.suggestions.some((x) => x.name === id))
      .map((id) => ({ name: id, hint: `Available to your ${def.short} key` }));
    const tags = new TagInput(modelsSetting.controlEl, {
      values: cfg.models,
      suggestions: def.suggestions.concat(fetched),
      placeholder: "Add a model…",
      onChange: async (vals) => {
        cfg.models = vals;
        await save(false);
      },
    });

    const result = body.createDiv({ cls: "jsa-provider-result" });
    const say = (text, cls) => {
      result.setText(text);
      result.className = `jsa-provider-result ${cls || ""}`;
    };
    new Setting(body)
      .addButton((b) => b.setButtonText("Load models").setTooltip("Fetch the model list for this key")
        .onClick(async () => {
          b.setDisabled(true).setButtonText("Loading…");
          try {
            const ids = await fetchProviderModels(def, cfg);
            this.fetched[def.id] = ids;
            tags.opts.suggestions = def.suggestions.concat(ids.filter((id) => !def.suggestions.some((x) => x.name === id))
              .map((id) => ({ name: id, hint: `Available to your ${def.short} key` })));
            say(`${ids.length} models available. Start typing in Models to add one.`, "is-ok");
          } catch (e) {
            say(`Couldn't load models: ${e.message || e}`, "is-error");
          } finally {
            b.setDisabled(false).setButtonText("Load models");
          }
        }))
      .addButton((b) => b.setButtonText("Test").setCta().setTooltip("Send a one-line test to the first model")
        .onClick(async () => {
          const model = cfg.models[0];
          if (!model) return say("Add a model first.", "is-error");
          b.setDisabled(true).setButtonText("Testing…");
          const t0 = Date.now();
          try {
            const reply = await llm(this.plugin.settings, {
              contents: [{ role: "user", parts: [{ text: "Reply with just the word OK." }] }],
            }, null, { pid: def.id, model });
            say(`${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s: "${String(reply).slice(0, 60)}"`, "is-ok");
          } catch (e) {
            say(`${model} failed: ${e.message || e}`, "is-error");
          } finally {
            b.setDisabled(false).setButtonText("Test");
          }
        }));
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    TagInput.closeAll(); // a list left open from the last draw would float over nothing
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Adds an assistant to Journal Scroll. Entries you ask about are sent to the model you pick below. "
        + "Everything it writes goes into your notes: titles, highlights and focus levels into each entry's "
        + "frontmatter, comparisons at the end of the entry, and summaries into the summaries folder. "
        + "Chats are not saved. API keys stay in this plugin's settings, never in your notes.",
    });

    this.renderModels(containerEl);

    new Setting(containerEl).setName("Journal").setHeading();

    // Both lists are tag inputs: chips you remove with ×, a field that suggests as you type,
    // and Enter to add anything that isn't suggested. Stored as before, comma-separated.
    const people = new Setting(containerEl)
      .setName("People to compare with")
      .setDesc("Each gets its own item in the Compare menu. Start typing to pick someone known for a "
        + "great daily routine and a big vision, or type any name and press Enter to add it.");
    people.settingEl.addClass("jsa-tag-setting");
    new TagInput(people.controlEl, {
      values: splitList(s.personas),
      suggestions: FAMOUS_PEOPLE,
      placeholder: "Add a person…",
      onChange: async (vals) => {
        s.personas = vals.join(", ");
        await this.plugin.saveSettings();
      },
    });

    new Setting(containerEl)
      .setName("Use the news about living people")
      .setDesc("When you compare a day with someone who was alive then, check the news about them from that "
        + "day. If there's any, the comparison highlights it and builds their day around what they actually "
        + "did. Only the person's name and the date are looked up (Wikidata, Google News), never your journal.")
      .addToggle((t) => t.setValue(s.personaNews !== false).onChange(async (v) => {
        s.personaNews = v;
        await this.plugin.saveSettings();
      }));

    const areasSetting = new Setting(containerEl)
      .setName("Life areas")
      .setDesc("Rated on each day, in comparisons and in monthly timelines, in this order. Pick from the "
        + "suggestions or type your own and press Enter. After changing them, use Regenerate → "
        + "\"Re-rate life areas\" to update days already rated.");
    areasSetting.settingEl.addClass("jsa-tag-setting");
    new TagInput(areasSetting.controlEl, {
      values: splitList(s.areas),
      suggestions: LIFE_AREA_SUGGESTIONS,
      placeholder: "Add a life area…",
      onChange: async (vals) => {
        s.areas = vals.join(", ");
        await this.plugin.saveSettings();
      },
    });

    new Setting(containerEl)
      .setName("Comparison times")
      .setDesc("Comma-separated times of day for the hour-by-hour table in comparisons. "
        + "Times you wrote in the entry are added too.")
      .addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.compareTimes).setValue(s.compareTimes)
        .onChange(async (v) => {
          s.compareTimes = v.trim() || DEFAULT_SETTINGS.compareTimes;
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
