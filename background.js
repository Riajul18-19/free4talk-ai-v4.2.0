/* ============================================================================
 * Free4Talk AI Bot — Auto Reply Pro (v4.2.0 Pro)
 * Background service worker
 *
 * Provider routing:
 *   - Groq (GPT-OSS 120B / 20B)  → ultra-fast LPU replies
 *   - NVIDIA NIM (Nemotron 3)    → high intelligence & long replies
 *   - OpenRouter (Free Router)   → smart auto-switch fallback
 *
 * Reply-only focus + editable welcome for new users.
 * ========================================================================== */

"use strict";

console.log("🤖 Free4Talk AI Bot background starting…");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_ENDPOINT   = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_ENDPOINT       = "https://integrate.api.nvidia.com/v1/chat/completions";
const GROQ_ENDPOINT         = "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_NVIDIA_MODEL  = "nvidia/nemotron-3-ultra-550b-a55b";
const DEFAULT_GROQ_MODEL    = "openai/gpt-oss-120b";
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

// "Keep every message." We no longer cap chatHistory or the persistent
// slice by a fixed row count — users explicitly asked for the full
// conversation history to survive across sessions, not just the recent
// window. The only hard ceiling that remains is chrome.storage.local's
// own 10 MB quota; the safety prune below (see PERSISTENT_SAFETY_*)
// drops the oldest rows ONLY when we would otherwise exceed it, so the
// extension can never be silently disabled by a quota error.
//
// HISTORY_LIMIT used to truncate chatHistory.shift() on every push.
// It's kept (with a much higher value) only as a defense-in-depth
// against a runaway loop pushing millions of rows into RAM before the
// next persist tick can fingerprint-skip them. 50k rows × ~150 bytes
// each ≈ 7.5 MB in memory — well within reason for a long-running
// service worker, and we should never realistically hit it because the
// persistent slice gets pruned to fit the quota long before that.
const HISTORY_LIMIT       = 10_000;
const STATE_SAVE_INTERVAL = 30_000;
// 0 = persist on the *next* microtask. Persisting synchronously here was
// the single biggest culprit behind "messages take a few seconds to appear":
// any debounce > 1 frame means a user-visible delay between the bubble
// landing in the live DOM and the popup/Memory Manager reflecting it. With
// the microtask queue we still coalesce the user+bot pair into one write
// (both push happen in the same async function), but never delay by wall
// time.
const RUNTIME_SAVE_DEBOUNCE_MS = 0;
const PERSISTENT_HISTORY_KEY = "botPersistentHistory";
// Soft upper bound for the persistent slice. chrome.storage.local is 10 MB
// total; we reserve ~1 MB for config, welcome map, etc. and aim to keep
// the message slice under PERSISTENT_SAFETY_BYTES. When the JSON-encoded
// slice exceeds that, we drop the oldest 10% of rows and try again. Users
// who want true "every message ever" can crank this up; the only reason
// it isn't Infinity is that chrome.storage rejects writes over quota with
// a hard error and we'd lose the latest message too.
const PERSISTENT_SAFETY_BYTES = 9 * 1024 * 1024;
const PERSISTENT_PRUNE_FRACTION = 0.10;
// A monotonically increasing token written to storage so subscribers can
// trivially confirm "I saw the latest state" without having to deep-compare
// arrays. Useful when chrome.storage.onChanged fires for unrelated keys.
const RUNTIME_REV_KEY = "botRuntimeRev";

const DEFAULT_WELCOME_TEMPLATE =
  "Welcome {username}";

const DEFAULT_PERSONA =
  "You are a friendly, natural chat partner on Free4Talk. " +
  "Reply the way real people type in casual digital communication, using common contractions (I'm, don't, we'll) and a warm tone. " +
  "Respond directly without filler, robotic phrasing, or em-dashes. Never mention being an AI or bot.";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  botEnabled: true,
  chatRepliesEnabled: true,

  openrouterApiKey: "",
  nvidiaApiKey: "",
  groqApiKey: "",

  openrouterModel: DEFAULT_OPENROUTER_MODEL,
  nvidiaModel: DEFAULT_NVIDIA_MODEL,
  groqModel: DEFAULT_GROQ_MODEL,
  autoSwitch: true,
  longReplyThreshold: 140,

  botUsername: "Bot",
  botPersona: DEFAULT_PERSONA,

  shortCharLimit: 160,
  longCharLimit: 600,
  replyDelayMs: 0,

  ignoreSelfMessages: true,
  mentionUserInReply: false,
  onlyReplyWhenMentioned: false,
  replyToPM: true,
  excludedUsernames: [],

  welcomeEnabled: true,
  welcomeTemplate: DEFAULT_WELCOME_TEMPLATE,
  welcomeCooldownMs: 0,
  welcomeDelaySec: 0,
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let cfg = { ...DEFAULTS };
let chatHistory = [];
let lastBotReplyTo = null;
let lastBotReplyTime = 0;
let lastBotReplyText = "";
let welcomedUsers = {};
let runtimeSaveTimer = null;
let runtimeRev = 0;
// Whenever persistRuntime() runs, it bumps this; setRuntimeDirty() flips
// `runtimeDirty=true` and chains a microtask if no save is pending yet.
let runtimeDirty = false;
let runtimePersistInFlight = null;

// Recent outgoing replies — used by shouldRespond to detect self-echo when
// a message comes back to us with our own bot username on it. Tracking the
// last N replies (not just the last one) closes the "two-message window"
// loop where an older reply still echoes back.
const recentBotReplies = []; // [{ text: string, t: number }]
const RECENT_BOT_REPLIES_TTL_MS = 120_000;
const RECENT_BOT_REPLIES_MAX = 30;

function recordBotReply(text) {
  const t = normalizeEchoText(text);
  if (!t) return;
  const now = Date.now();
  recentBotReplies.push({ text: t, t: now });
  const cutoff = now - RECENT_BOT_REPLIES_TTL_MS;
  while (recentBotReplies.length && recentBotReplies[0].t < cutoff) {
    recentBotReplies.shift();
  }
  if (recentBotReplies.length > RECENT_BOT_REPLIES_MAX) recentBotReplies.shift();
}

function matchesRecentBotReply(content) {
  const c = normalizeEchoText(content);
  if (!c) return false;
  const cutoff = Date.now() - RECENT_BOT_REPLIES_TTL_MS;
  for (const entry of recentBotReplies) {
    if (entry.t < cutoff) continue;
    const a = normalizeEchoText(entry.text);
    if (a === c) return true;
    if (a.length >= 6 && c.startsWith(a)) return true;
    if (c.length >= 6 && a.startsWith(c)) return true;
    if (a.length >= 12 && c.includes(a)) return true;
    if (c.length >= 12 && a.includes(c)) return true;
  }
  return false;
}

/** Same normalization as content script echo matching (unicode ellipsis, NBSP). */
function normalizeEchoText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[`´ʻʼʹˈꞌ＇\u02bc\u02b9]/g, "'")
    .replace(/\*+/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb]/g, '"')
    .trim()
    .toLowerCase()
    .replace(/[\u2026]+\s*$/g, "")
    .replace(/\.{3,}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FRESH_OUTGOING_ECHO_MAX_MS = 25_000;

/**
 * True when this message is almost certainly our own reply echoed from the site
 * under the real account display name (not cfg.botUsername).
 * Uses a short time window + strict similarity to avoid blocking unrelated chat.
 */
function matchesFreshOutgoingEcho(content) {
  const c = normalizeEchoText(content);
  if (c.length < 6) return false;
  const now = Date.now();
  for (const entry of recentBotReplies) {
    if (now - entry.t > FRESH_OUTGOING_ECHO_MAX_MS) continue;
    const a = normalizeEchoText(entry.text);
    if (a.length < 6) continue;
    if (a === c) return true;
    if (a.length >= 10 && c.startsWith(a)) return true;
    if (c.length >= 10 && a.startsWith(c)) return true;
    const maxL = Math.max(a.length, c.length);
    const minL = Math.min(a.length, c.length);
    if (maxL >= 16 && minL / maxL >= 0.82 && (a.includes(c) || c.includes(a))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUsername(name) {
  return (name || "").toLowerCase().trim();
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match the bot name as a *whole token* only — never as a substring inside
// another word. This is critical for "Reply only when bot name is mentioned":
// a substring match would falsely trigger on words like "main"/"rain" when
// the bot is named "Ai", or "robot"/"about" when named "Bot".
//
// Uses Unicode-aware boundaries so names with non-ASCII characters are handled
// correctly and do not accidentally match inside larger words.
function isBotNameMentioned(content, botName) {
  const raw = String(content || "");
  const bot = String(botName || "").trim().toLowerCase();
  if (!bot || bot.length < 2) return false;

  // Escape regex metacharacters, then allow flexible whitespace inside
  // multi-word names (e.g. "My Bot" matches "my  bot").
  const escaped = escapeRegExp(bot).replace(/ +/g, "\\s+");

  // Boundary = start/end of string OR any non letter/number/underscore.
  // Optional leading "@" is allowed (e.g. "@Bot").
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu");
  return re.test(raw);
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function clampLen(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Storage / persistence
// ---------------------------------------------------------------------------

async function loadConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...stored };
  if (typeof cfg.excludedUsernames === "string") {
    cfg.excludedUsernames = cfg.excludedUsernames
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  cfg.excludedUsernames = safeArr(cfg.excludedUsernames);
  console.log("⚙️  Config loaded:", {
    enabled: cfg.botEnabled,
    autoSwitch: cfg.autoSwitch,
    hasGroq: !!cfg.groqApiKey,
    hasNvidia: !!cfg.nvidiaApiKey,
    hasOpenRouter: !!cfg.openrouterApiKey,
    welcome: cfg.welcomeEnabled,
  });
}

// Last-written persistent slice fingerprint, used to skip redundant writes.
// Writing chatHistory unchanged still fires chrome.storage.onChanged in every
// listener, which would in turn cause the popup / Memory Manager to re-render
// even though nothing changed. A cheap length+last-key fingerprint is enough
// here because chatHistory is append-only between mutations.
let lastPersistedFingerprint = "";

function fingerprintForSlice(slice) {
  if (!Array.isArray(slice) || slice.length === 0) return "0|";
  const last = slice[slice.length - 1] || {};
  // Keep the fingerprint short — full content hashes aren't worth the CPU.
  return `${slice.length}|${String(last.username || "")}|${(String(last.content || "")).length}|${last.timestamp ?? ""}|${last.fromAI ? 1 : 0}`;
}

async function persistRuntime() {
  runtimeDirty = false;
  runtimeRev = Date.now();

  // Always write the live (session) slice. Subscribers depend on
  // chrome.storage.session changes for instant UI updates.
  // We keep the recent 150 messages in session storage for instant UI rendering
  // without risking quota errors or slow serialization.
  try {
    const sessionSlice = chatHistory.length > 150 ? chatHistory.slice(-150) : chatHistory.slice();
    await chrome.storage.session.set({
      botRuntimeState: {
        chatHistory: sessionSlice,
        lastBotReplyTo,
        lastBotReplyTime,
        lastBotReplyText,
        welcomedUsers,
        updatedAt: runtimeRev,
        rev: runtimeRev,
      },
    });
  } catch (e) {
    /* session storage may not exist on older builds */
  }

  // Durable chat context across worker/browser restarts (also the source of
  // truth for the Memory Manager UI). We skip writes when the slice
  // is genuinely unchanged so we don't spam chrome.storage.onChanged.
  try {
    if (chatHistory.length > HISTORY_LIMIT) {
      chatHistory = chatHistory.slice(-HISTORY_LIMIT);
    }
    let slice = chatHistory.slice();
    
    // Quota-safe check: only do expensive serialization check if row count is high
    if (slice.length > 3000) {
      let serialized = JSON.stringify(slice);
      if (serialized.length > PERSISTENT_SAFETY_BYTES) {
        const dropPerPass = Math.max(1, Math.ceil(slice.length * PERSISTENT_PRUNE_FRACTION));
        while (serialized.length > PERSISTENT_SAFETY_BYTES && slice.length > 0) {
          slice = slice.slice(dropPerPass);
          serialized = slice.length === 0 ? "[]" : JSON.stringify(slice);
        }
        chatHistory = slice;
        console.warn(`[persist] pruned oldest rows to fit quota; kept ${slice.length} messages.`);
      }
    }

    const fp = fingerprintForSlice(slice);
    if (fp !== lastPersistedFingerprint) {
      lastPersistedFingerprint = fp;
      if (slice.length === 0) {
        await chrome.storage.local.remove(PERSISTENT_HISTORY_KEY);
      } else {
        await chrome.storage.local.set({
          [PERSISTENT_HISTORY_KEY]: slice,
        });
      }
    }
    await chrome.storage.local.set({ [RUNTIME_REV_KEY]: runtimeRev });
  } catch (e) {
    /* ignore local persistence errors */
  }

  try {
    chrome.runtime.sendMessage({
      type: "RUNTIME_STATE_CHANGED",
      rev: runtimeRev,
    }).catch(() => { /* no receiver — fine */ });
  } catch {}
}

// Coalesces back-to-back persistRuntime calls into a single write. With
// RUNTIME_SAVE_DEBOUNCE_MS=0 we still collapse synchronous bursts (push
// twice in the same tick → one write) but never delay by wall time, which
// fixes the visible "messages appear seconds late" complaint.
function queuePersistRuntime() {
  runtimeDirty = true;
  if (runtimePersistInFlight) return runtimePersistInFlight;
  const trigger = async () => {
    try {
      // Loop while writes keep coming in mid-flight, so the final state on
      // disk always reflects the latest in-memory state.
      while (runtimeDirty) {
        await persistRuntime();
      }
    } finally {
      runtimePersistInFlight = null;
    }
  };

  if (RUNTIME_SAVE_DEBOUNCE_MS > 0) {
    runtimePersistInFlight = new Promise((resolve) => {
      runtimeSaveTimer = setTimeout(async () => {
        runtimeSaveTimer = null;
        await trigger();
        resolve();
      }, RUNTIME_SAVE_DEBOUNCE_MS);
    });
  } else {
    // Microtask. Multiple synchronous push() calls in the same tick still
    // collapse into a single write because `trigger`'s while-loop drains
    // `runtimeDirty`.
    runtimePersistInFlight = Promise.resolve().then(trigger);
  }
  return runtimePersistInFlight;
}

async function refreshStrictMentionConfig() {
  try {
    const latest = await chrome.storage.local.get([
      "onlyReplyWhenMentioned",
      "botUsername",
      "botEnabled",
      "chatRepliesEnabled",
      "welcomeEnabled",
      "welcomeDelaySec",
      "welcomeCooldownMs",
      "welcomeTemplate",
      "openrouterApiKey",
      "nvidiaApiKey",
      "groqApiKey",
      "openrouterModel",
      "nvidiaModel",
      "groqModel",
      "autoSwitch",
      "botPersona",
      "shortCharLimit",
      "longCharLimit",
    ]);
    if (latest.openrouterApiKey !== undefined) cfg.openrouterApiKey = String(latest.openrouterApiKey || "").trim();
    if (latest.nvidiaApiKey !== undefined) cfg.nvidiaApiKey = String(latest.nvidiaApiKey || "").trim();
    if (latest.groqApiKey !== undefined) cfg.groqApiKey = String(latest.groqApiKey || "").trim();
    if (latest.openrouterModel !== undefined) cfg.openrouterModel = latest.openrouterModel;
    if (latest.nvidiaModel !== undefined) cfg.nvidiaModel = latest.nvidiaModel;
    if (latest.groqModel !== undefined) cfg.groqModel = latest.groqModel;
    if (latest.autoSwitch !== undefined) cfg.autoSwitch = !!latest.autoSwitch;
    if (latest.botPersona !== undefined) cfg.botPersona = latest.botPersona;
    if (latest.shortCharLimit !== undefined) cfg.shortCharLimit = latest.shortCharLimit;
    if (latest.longCharLimit !== undefined) cfg.longCharLimit = latest.longCharLimit;

    if (latest.onlyReplyWhenMentioned !== undefined) {
      cfg.onlyReplyWhenMentioned = !!latest.onlyReplyWhenMentioned;
    }
    if (latest.botUsername !== undefined) {
      const name = String(latest.botUsername || "").trim();
      cfg.botUsername = name || DEFAULTS.botUsername;
    }
    if (latest.botEnabled !== undefined) {
      cfg.botEnabled = !!latest.botEnabled;
    }
    if (latest.chatRepliesEnabled !== undefined) {
      cfg.chatRepliesEnabled = !!latest.chatRepliesEnabled;
    }
    if (latest.welcomeEnabled !== undefined) {
      cfg.welcomeEnabled = !!latest.welcomeEnabled;
    }
    if (typeof latest.welcomeDelaySec === "number" && Number.isFinite(latest.welcomeDelaySec)) {
      cfg.welcomeDelaySec = Math.max(0, latest.welcomeDelaySec);
    }
    if (typeof latest.welcomeCooldownMs === "number" && Number.isFinite(latest.welcomeCooldownMs)) {
      cfg.welcomeCooldownMs = Math.max(0, latest.welcomeCooldownMs);
    }
    if (typeof latest.welcomeTemplate === "string" && latest.welcomeTemplate.trim()) {
      cfg.welcomeTemplate = latest.welcomeTemplate.trim();
    }
  } catch {
    // Ignore transient storage read errors; existing cfg remains in effect.
  }
}

async function restoreRuntime() {
  try {
    const r = await chrome.storage.session.get("botRuntimeState");
    const s = r?.botRuntimeState;
    if (s) {
      chatHistory = safeArr(s.chatHistory);
      lastBotReplyTo = s.lastBotReplyTo || null;
      lastBotReplyTime = s.lastBotReplyTime || 0;
      lastBotReplyText = s.lastBotReplyText || "";
      welcomedUsers = s.welcomedUsers || {};
    }
  } catch (e) {
    /* ignore */
  }

  // Fallback to durable local history when session state is missing.
  // Load the FULL persistent slice — capping to HISTORY_LIMIT here would
  // silently throw away exactly the older messages the user just told us
  // to preserve. The 50k row safety ceiling in HISTORY_LIMIT applies to
  // *new* pushes (defense against runaway loops), not to restoring what
  // we've already legitimately saved.
  if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
    try {
      const localData = await chrome.storage.local.get(PERSISTENT_HISTORY_KEY);
      const persistent = safeArr(localData?.[PERSISTENT_HISTORY_KEY]);
      if (persistent.length > 0) {
        chatHistory = persistent.slice();
      }
    } catch (e) {
      /* ignore */
    }
  }
}

setInterval(persistRuntime, STATE_SAVE_INTERVAL);

if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(async () => {
    if (runtimeSaveTimer) {
      clearTimeout(runtimeSaveTimer);
      runtimeSaveTimer = null;
    }
    await persistRuntime();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const initPromise = (async function init() {
  await restoreRuntime();
  await loadConfig();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const key of Object.keys(changes)) {
    if (key in DEFAULTS) {
      cfg[key] = changes[key].newValue;
      touched = true;
    }
  }
  if (touched) {
    cfg.excludedUsernames = safeArr(cfg.excludedUsernames);
  }
});

// Deferred welcome alarms — fired by chrome.alarms after welcomeDelaySec.
// Must be registered at the top level so it survives service-worker restarts
// triggered by the alarm itself.
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || !alarm.name || !alarm.name.startsWith(WELCOME_ALARM_PREFIX)) return;
    try {
      await initPromise;
      const pending = await popPendingWelcome(alarm.name);
      if (!pending) {
        console.log(`[welcome-alarm] no pending payload for ${alarm.name}`);
        return;
      }
      // Re-check the kill switches just before firing — the user may have
      // disabled welcomes / the whole bot during the wait.
      await refreshStrictMentionConfig();
      if (!cfg.botEnabled || !cfg.welcomeEnabled) {
        console.log(`[welcome-alarm] skipped (botEnabled=${cfg.botEnabled}, welcomeEnabled=${cfg.welcomeEnabled})`);
        return;
      }
      const text = pending.text || await buildWelcomeText(pending.username);
      lastBotReplyText = text;
      lastBotReplyTime = Date.now();
      recordBotReply(text);
      await dispatchReply(pending.tabId, text, { username: pending.username, isWelcome: true });
      await queuePersistRuntime();
      console.log(`[welcome-alarm] sent welcome for ${pending.username}`);
    } catch (e) {
      console.error("[welcome-alarm] dispatch failed:", e);
    }
  });
}

// ---------------------------------------------------------------------------
// AI Provider Calls — OpenRouter, Groq & NVIDIA NIM
// ---------------------------------------------------------------------------

function extractResponseText(data) {
  if (!data) return "";
  const choice = data?.choices?.[0];
  if (!choice) {
    if (typeof data?.response === "string" && data.response.trim()) return data.response.trim();
    if (typeof data?.text === "string" && data.text.trim()) return data.text.trim();
    return "";
  }

  const msg = choice.message || choice.delta;
  let raw = msg?.content;

  if (Array.isArray(raw)) {
    raw = raw.map((p) => (typeof p === "string" ? p : p?.text || p?.content || "")).join(" ");
  }

  // If content is null, empty or whitespace, check reasoning fields (used by reasoning models like GPT-OSS / DeepSeek / Nemotron)
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim()) {
      raw = msg.reasoning_content;
    } else if (typeof msg?.reasoning === "string" && msg.reasoning.trim()) {
      raw = msg.reasoning;
    } else if (typeof choice.text === "string" && choice.text.trim()) {
      raw = choice.text;
    } else if (typeof choice.delta?.content === "string" && choice.delta.content.trim()) {
      raw = choice.delta.content;
    }
  }

  return typeof raw === "string" ? raw.trim() : "";
}

function cleanReplyText(raw) {
  if (!raw) return "";
  let text = String(raw);
  // Strip <think>...</think>, <thought>...</thought>, <reasoning>...</reasoning> blocks
  text = text.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  // If the entire text was inside <think>...</think>, salvage the thought as text
  if (!text) {
    text = raw.replace(/<\/?(think|thought|reasoning)>/gi, "").trim();
  }
  // If text has "Final Answer:" or "Response:" near the end of a thought block, extract it
  const finalMatch = text.match(/(?:final answer|response|reply)\s*:\s*([\s\S]+)$/i);
  if (finalMatch && finalMatch[1].trim()) {
    text = finalMatch[1].trim();
  }
  // Strip code block wrap if whole message was wrapped in ```
  text = text.replace(/^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/i, "$1").trim();

  // Strict punctuation constraints: Never allow em-dashes (—), en-dashes (–), or double hyphens (--)
  text = text.replace(/\s*—\s*/g, ", ")
             .replace(/\s*–\s*/g, ", ")
             .replace(/\s*--\s*/g, ", ");

  return text;
}

const OPENROUTER_TIMEOUT_MS = 10_000;

async function callOpenRouter(messages, maxTokens) {
  if (!cfg.openrouterApiKey) throw new Error("OpenRouter API key not configured");

  const candidateModels = [
    cfg.openrouterModel || DEFAULT_OPENROUTER_MODEL,
    DEFAULT_OPENROUTER_MODEL,
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "minimax/minimax-m3.1-flash:free",
    "liquid/lfm-2.5-2.6b:free",
    "cohere/north-mini-code:free",
    "poolside/laguna-s-2.1:free"
  ].filter((v, i, a) => !!v && a.indexOf(v) === i);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.openrouterApiKey}`,
    "HTTP-Referer": "https://free4talk.com",
    "X-Title": "Free4Talk AI Bot",
  };

  const tokenLimit = Math.max(800, maxTokens || 800);

  let lastErr;
  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
    try {
      const res = await fetch(OPENROUTER_ENDPOINT, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          max_tokens: tokenLimit,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        let apiErr = "";
        try {
          const parsed = JSON.parse(txt);
          apiErr = parsed?.error?.message || "";
        } catch {}
        throw new Error(apiErr ? `OpenRouter API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = extractResponseText(data);
      if (!text) {
        console.warn("[OpenRouter] empty response payload:", JSON.stringify(data).slice(0, 300));
        throw new Error("Empty response from OpenRouter model");
      }
      return cleanReplyText(text);
    } catch (err) {
      lastErr = err;
      const isAbort = err?.name === "AbortError";
      const msg = (err?.message || "").toLowerCase();
      if (!isAbort && i < candidateModels.length - 1 && (msg.includes("network") || msg.includes("fetch"))) {
        await sleep(300 * (i + 1));
        continue;
      }
      if (i < candidateModels.length - 1) {
        continue;
      }
      break;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  throw lastErr || new Error("Unknown OpenRouter error");
}

function getValidNvidiaModel(model) {
  const validModels = new Set([
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "nvidia/nemotron-4-340b-instruct",
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.1-405b-instruct",
    "deepseek-ai/deepseek-r1",
    "deepseek-ai/deepseek-v3",
    "deepseek-ai/deepseek-v4.1-flash",
    "google/gemma-4-31b-it",
    "google/gemma-3-12b-it",
    "mistralai/mistral-large-2-instruct",
    "moonshotai/kimi-k2.6",
    "z-ai/glm-5.3-flash",
    "ai21labs/jamba-1.5-large-instruct",
    "microsoft/phi-3.5-moe-instruct"
  ]);
  if (validModels.has(model)) return model;
  return DEFAULT_NVIDIA_MODEL;
}

function getValidGroqModel(model) {
  const validModels = new Set([
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "qwen/qwen3.8-27b",
    "canopylabs/orpheus-v1-english"
  ]);
  if (validModels.has(model)) return model;
  return DEFAULT_GROQ_MODEL;
}

const GROQ_TIMEOUT_MS = 8500;

async function callGroq(messages, maxTokens) {
  if (!cfg.groqApiKey) throw new Error("Groq API key not configured");
  const rawModel = cfg.groqModel || DEFAULT_GROQ_MODEL;
  const initialModel = getValidGroqModel(rawModel);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.groqApiKey}`,
  };

  const tokenLimit = Math.max(1024, maxTokens || 1024);

  // Model cascade: try user-selected model first; if it returns empty, fallback to Groq flagship llama-3.3-70b-versatile
  const candidateModels = [initialModel];
  if (initialModel !== "llama-3.3-70b-versatile") {
    candidateModels.push("llama-3.3-70b-versatile");
  }

  let lastErr;
  for (const model of candidateModels) {
    const isReasoning = model.includes("gpt-oss") || model.includes("r1") || model.includes("reason");
    const payload = {
      model,
      messages,
      max_completion_tokens: tokenLimit,
      temperature: 0.7,
    };

    if (isReasoning) {
      payload.reasoning_format = "parsed";
      payload.reasoning_effort = "low";
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
      try {
        const res = await fetch(GROQ_ENDPOINT, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          let apiErr = "";
          try {
            const parsed = JSON.parse(txt);
            apiErr = parsed?.error?.message || "";
          } catch {}

          // If reasoning parameters were rejected by model, strip them and retry
          if ((payload.reasoning_format || payload.reasoning_effort) && (apiErr.toLowerCase().includes("reason") || apiErr.toLowerCase().includes("parameter") || apiErr.toLowerCase().includes("unknown"))) {
            delete payload.reasoning_format;
            delete payload.reasoning_effort;
            continue;
          }
          // If max_completion_tokens was rejected, try with max_tokens
          if (payload.max_completion_tokens && apiErr.toLowerCase().includes("max_completion_tokens")) {
            delete payload.max_completion_tokens;
            payload.max_tokens = tokenLimit;
            continue;
          }

          throw new Error(apiErr ? `Groq API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
        }

        const data = await res.json();
        const text = extractResponseText(data);
        if (!text) {
          console.warn(`[Groq] empty response from ${model}:`, JSON.stringify(data).slice(0, 300));
          // If empty and another model is available in candidateModels, break to try fallback model
          break;
        }
        return cleanReplyText(text);
      } catch (err) {
        lastErr = err;
        const isAbort = err?.name === "AbortError";
        const msg = (err?.message || "").toLowerCase();
        if (!isAbort && attempt < 2 && (msg.includes("network") || msg.includes("fetch"))) {
          await sleep(200 * attempt);
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  }
  throw lastErr || new Error("Unknown Groq error");
}

const NVIDIA_TIMEOUT_MS = 12000;

async function callNvidia(messages, maxTokens) {
  if (!cfg.nvidiaApiKey) throw new Error("NVIDIA API key not configured");

  const rawModel = cfg.nvidiaModel || DEFAULT_NVIDIA_MODEL;
  const initialModel = getValidNvidiaModel(rawModel);

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cfg.nvidiaApiKey}`,
  };

  const tokenLimit = Math.max(1024, maxTokens || 1024);

  // Model cascade: try user-selected model first; if it returns empty, fallback to meta/llama-3.3-70b-instruct
  const candidateModels = [initialModel];
  if (initialModel !== "meta/llama-3.3-70b-instruct") {
    candidateModels.push("meta/llama-3.3-70b-instruct");
  }

  let lastErr;
  for (const model of candidateModels) {
    const body = {
      model,
      messages,
      temperature: 0.7,
      max_tokens: tokenLimit,
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), NVIDIA_TIMEOUT_MS);
      try {
        const res = await fetch(NVIDIA_ENDPOINT, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify(body),
        });

        if (res.status === 401 || res.status === 403) {
          throw new Error("Invalid NVIDIA API key");
        }
        if (res.status === 429) {
          if (attempt < 2) {
            await sleep(350 * attempt);
            continue;
          }
          throw new Error("NVIDIA rate limit exceeded");
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          let apiErr = "";
          try {
            const parsed = JSON.parse(txt);
            apiErr = parsed?.error?.message || parsed?.detail || "";
          } catch {}
          throw new Error(apiErr ? `NVIDIA API Error (${res.status}): ${apiErr}` : `HTTP ${res.status} ${txt.slice(0, 200)}`);
        }

        const data = await res.json();
        const text = extractResponseText(data);
        if (!text) {
          console.warn(`[NVIDIA] empty response from ${model}:`, JSON.stringify(data).slice(0, 300));
          break; // Try next candidate model
        }
        return cleanReplyText(text);
      } catch (err) {
        lastErr = err;
        const isAbort = err?.name === "AbortError";
        const msg = (err?.message || "").toLowerCase();
        if (!isAbort && attempt < 2 && (msg.includes("network") || msg.includes("fetch"))) {
          await sleep(250 * attempt);
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  }
  throw lastErr || new Error("Unknown NVIDIA error");
}

// ---------------------------------------------------------------------------
// Smart routing — short vs long answers
// ---------------------------------------------------------------------------

const LONG_KEYWORDS_RE =
  /\b(advice|help|suggest|recommend|how do i|how to|how can|what should|guide|tips|teach|explain|tutorial|why does|why is|differen[ct])\b/i;
// Use \s+ between "room" and "info" so NBSP (U+00A0) from the site still matches.
const ROOM_INFO_RE =
  /\b(room\s+info|language\s*:|topic\s*:|participants?\s*:|country\s*:|level\s*:|room rules?)\b/i;

function normalizeForRoomMeta(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function isRoomInfoLikeMessage(content) {
  const n = normalizeForRoomMeta(content);
  if (!n) return false;
  if (ROOM_INFO_RE.test(n)) return true;
  if (/room\s+info/i.test(n) && /\b(change|changed|update|updated)\b/i.test(n)) {
    return true;
  }
  return false;
}

function needsLongAnswer(content) {
  if (!content) return false;
  const len = content.length;
  const hasQ = content.includes("?");
  const hasKw = LONG_KEYWORDS_RE.test(content);

  if (hasKw && (hasQ || len > 60)) return true;
  if (hasQ && len > cfg.longReplyThreshold) return true;
  if (len > cfg.longReplyThreshold * 1.5) return true;
  return false;
}

function hasAnyApiKey() {
  return !!(
    (cfg.groqApiKey && cfg.groqApiKey.trim()) ||
    (cfg.nvidiaApiKey && cfg.nvidiaApiKey.trim()) ||
    (cfg.openrouterApiKey && cfg.openrouterApiKey.trim())
  );
}

function pickProvider(message) {
  const haveGroq = !!(cfg.groqApiKey && cfg.groqApiKey.trim());
  const haveNvidia = !!(cfg.nvidiaApiKey && cfg.nvidiaApiKey.trim());
  const haveOpenRouter = !!(cfg.openrouterApiKey && cfg.openrouterApiKey.trim());

  if (haveGroq) return "groq";
  if (haveNvidia) return "nvidia";
  if (haveOpenRouter) return "openrouter";
  return null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(targetUser, isLong) {
  const charLimit = isLong ? cfg.longCharLimit : cfg.shortCharLimit;
  const botName = (cfg.botUsername || "Bot").trim();
  const customPersona = (cfg.botPersona || "").trim();
  const persona = customPersona || DEFAULT_PERSONA;

  let mentionRule;
  if (cfg.mentionUserInReply && targetUser) {
    mentionRule =
      `When relevant, naturally address ${targetUser} by name once near the start. ` +
      "Do not over-mention or @-tag, keep it like real human conversation.";
  } else {
    mentionRule = "Do not address the user by name unless necessary, reply naturally.";
  }

  const lengthRule = isLong
    ? `This is a help or advice request. You may use up to ${charLimit} characters. Be clear, practical, and friendly without filler.`
    : `Keep it short and natural (max ${charLimit} characters). 1 or 2 sentences for casual chat.`;

  return [
    `IDENTITY & NAME:`,
    `- Your display name in this Free4Talk room is "${botName}".`,
    `- If anyone asks what your name is, who you are, or what to call you, answer clearly and naturally that your name is "${botName}".`,
    "",
    persona,
    "",
    "TONE & HUMANIZATION GUIDELINES:",
    `- Sound Natural: Write the way a real person types in everyday digital communication. Use natural phrasing, common contractions (like "I'm", "don't", "we'll"), and a warm, approachable tone.`,
    `- Match the Context: Adapt length and formality to the incoming message. Keep replies concise and direct. Avoid robotic introductions, overly formal sign-offs, or repetitive AI buzzwords (like "delve", "tapestry", "furthermore", "testament", "I hope this message finds you well").`,
    `- Prioritize Clarity: Respond directly to the sender's core point without unnecessary filler.`,
    "",
    "STRICT FORMATTING & PUNCTUATION CONSTRAINTS:",
    "- NO Em-Dashes: NEVER use the em-dash (—) or double hyphens (--) in any response. Em-dashes are a common giveaway of AI-generated text.",
    "- Alternative Punctuation: Instead of an em-dash, break long thoughts into two separate sentences using a period (.), or connect clauses naturally using a comma (,) or parentheses ().",
    "- Never say you are an AI, language model, robot, bot, GPT, LLM, or artificial assistant. You are a real human participant in this chat room.",
    `- When asked for your name or identity, state that your name is ${botName}.`,
    `- Never start or prefix your messages with '${botName}:' or 'Me:'. Just write your message directly.`,
    "- " + lengthRule,
    "- " + mentionRule,
  ].join("\n");
}

function buildMessages(message, history, isLong) {
  const systemPrompt = buildSystemPrompt(message.username, isLong);

  // Exclude current incoming message if already in history to prevent consecutive duplicate user turns
  const priorHistory = (history || []).filter(
    (m) => !(m.username === message.username && m.content === message.content && !m.fromAI)
  );

  const histMsgs = priorHistory.slice(-8).map((m) => ({
    role: m.fromAI ? "assistant" : "user",
    content: m.fromAI ? m.content : `${m.username}: ${m.content}`,
  }));

  const userTurn = {
    role: "user",
    content: `${message.username}: ${message.content}`,
  };

  return [
    { role: "system", content: systemPrompt },
    ...histMsgs,
    userTurn,
  ];
}

// ---------------------------------------------------------------------------
// Should-respond decision
// ---------------------------------------------------------------------------

function shouldRespond(message) {
  if (!cfg.botEnabled) return { ok: false, reason: "bot_disabled" };
  // Chat-replies kill switch — independent from welcomeEnabled so users can
  // greet new joiners while keeping ongoing chat auto-replies silenced.
  if (cfg.chatRepliesEnabled === false) return { ok: false, reason: "chat_replies_disabled" };

  // If no API key is configured, stay silent and do not attempt to reply
  if (!hasAnyApiKey()) return { ok: false, reason: "no_api_key" };

  const username = message.username || "";
  const content  = (message.content || "").trim();
  const lc       = content.toLowerCase();
  const botLC    = normalizeUsername(cfg.botUsername);
  const userLC   = normalizeUsername(username);

  if (!content) return { ok: false, reason: "empty" };

  // Never auto-reply to room metadata / join context messages.
  if (isRoomInfoLikeMessage(content) || userLC === "room info") {
    return { ok: false, reason: "room_info" };
  }

  // Only ignore messages if their text matches an actual recent outgoing bot reply
  if (cfg.ignoreSelfMessages && (matchesFreshOutgoingEcho(content) || matchesRecentBotReply(content))) {
    return { ok: false, reason: "self_echo_recent_outgoing" };
  }

  const sysUsers = ["free4talk system", "coffee notification", "system"];
  if (sysUsers.includes(userLC)) {
    return { ok: false, reason: "system_user" };
  }

  if (cfg.excludedUsernames.map(normalizeUsername).includes(normalizeUsername(username))) {
    return { ok: false, reason: "excluded" };
  }

  if (message.isPM && !cfg.replyToPM) {
    return { ok: false, reason: "pm_disabled" };
  }

  // Strict mention mode: reply ONLY when exact configured bot name is
  // explicitly mentioned in content.
  if (cfg.onlyReplyWhenMentioned) {
    const named = !!message.botMentioned || isBotNameMentioned(content, cfg.botUsername);
    if (!named) {
      return { ok: false, reason: "mention_only_mode" };
    }
    return { ok: true, reason: "name_mentioned_strict" };
  }

  if (message.replyTo && message.replyTo.username) {
    if (normalizeUsername(message.replyTo.username) === botLC) {
      return { ok: true, reason: "reply_to_bot" };
    }
  }

  if (isBotNameMentioned(content, cfg.botUsername)) {
    return { ok: true, reason: "name_mentioned" };
  }

  const now = Date.now();
  if (lastBotReplyTo === normalizeUsername(username) && now - lastBotReplyTime < 60_000) {
    if (lc.length > 3 && !/^(ok|cool|nice|lol|haha|yeah|yup|nope|ty|thanks)$/i.test(lc)) {
      return { ok: true, reason: "followup" };
    }
  }

  if (lc.includes("?") || /^(what|how|why|who|where|when|can\s|could\s|is\s|are\s|do\s|does\s|did\s|would\s|should\s|tell\s)/i.test(lc)) {
    return { ok: true, reason: "question" };
  }

  if (LONG_KEYWORDS_RE.test(lc)) {
    return { ok: true, reason: "engagement_keyword" };
  }

  if (lc.length > 30) {
    return { ok: true, reason: "substantial_message" };
  }

  // Fail-open for reliability: reply to any normal non-empty room message.
  if (lc.length >= 1) {
    return { ok: true, reason: "fallback_any_message" };
  }

  return { ok: false, reason: "not_relevant" };
}

// ---------------------------------------------------------------------------
// Reply generation
// ---------------------------------------------------------------------------

async function generateReply(message) {
  const isLong  = cfg.autoSwitch && needsLongAnswer(message.content);
  const messages = buildMessages(message, chatHistory, isLong);
  const maxTok   = isLong ? 1500 : 1024;

  // Build prioritized list of configured providers
  const providers = [];
  if (cfg.groqApiKey && cfg.groqApiKey.trim()) providers.push("groq");
  if (cfg.nvidiaApiKey && cfg.nvidiaApiKey.trim()) providers.push("nvidia");
  if (cfg.openrouterApiKey && cfg.openrouterApiKey.trim()) providers.push("openrouter");

  if (providers.length === 0) {
    throw new Error("No API key configured. Add Groq, NVIDIA, or OpenRouter API key in popup.");
  }

  let text = "";
  let lastErr = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    console.log(`🚀 Reply via ${provider} (${isLong ? "long" : "short"} mode)${i > 0 ? " [provider fallback #" + i + "]" : ""}`);
    try {
      if (provider === "groq") {
        text = await callGroq(messages, maxTok);
      } else if (provider === "nvidia") {
        text = await callNvidia(messages, maxTok);
      } else {
        text = await callOpenRouter(messages, maxTok);
      }
      if (text && text.trim()) break;
    } catch (err) {
      lastErr = err;
      const nextProvider = i < providers.length - 1 ? providers[i + 1] : null;
      console.warn(`⚠️ ${provider} failed (${err.message})${nextProvider ? "; trying " + nextProvider : ""}`);
    }
  }

  if (!text || !text.trim()) {
    throw lastErr || new Error("All configured AI providers failed to return a response");
  }

  const botName = (cfg.botUsername || "").trim();
  if (botName) {
    const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const botPrefixRe = new RegExp(`^[\\s"'` + "`" + `]*${esc}\\s*[:\\-–—]\\s*`, "i");
    text = text.replace(botPrefixRe, "");
  }
  text = text.replace(/^[\s"'`]*(\w+\s*:\s*)?/, "").trim();

  const limit = isLong ? cfg.longCharLimit : cfg.shortCharLimit;
  return clampLen(text, limit);
}

// ---------------------------------------------------------------------------
// Welcome handling
// ---------------------------------------------------------------------------

// Pending welcomes scheduled via chrome.alarms. Stored to storage so they
// survive service-worker shutdown (MV3 SWs idle out aggressively, which is
// exactly why `setTimeout` for the welcome delay didn't work before).
const PENDING_WELCOMES_KEY = "botPendingWelcomes";
const WELCOME_ALARM_PREFIX = "f4tWelcome:";

async function getPendingWelcomes() {
  try {
    const r = await chrome.storage.local.get(PENDING_WELCOMES_KEY);
    const map = r?.[PENDING_WELCOMES_KEY];
    return (map && typeof map === "object") ? map : {};
  } catch {
    return {};
  }
}

async function savePendingWelcomes(map) {
  try {
    await chrome.storage.local.set({ [PENDING_WELCOMES_KEY]: map });
  } catch {
    /* ignore */
  }
}

async function addPendingWelcome(alarmName, payload) {
  const map = await getPendingWelcomes();
  map[alarmName] = payload;
  await savePendingWelcomes(map);
}

async function popPendingWelcome(alarmName) {
  const map = await getPendingWelcomes();
  const item = map[alarmName];
  if (item) {
    delete map[alarmName];
    await savePendingWelcomes(map);
  }
  return item || null;
}

async function buildWelcomeText(username) {
  // Always read the template from storage just before composing. Welcome
  // events are rare and infrequent enough that the extra read is free, and
  // it eliminates a class of bugs where cfg.welcomeTemplate goes stale
  // (e.g. service worker just woke from idle, popup save raced this handler,
  // multi-tab edits, etc.) and we silently fall back to DEFAULT_WELCOME_TEMPLATE.
  let tplValue = cfg.welcomeTemplate;
  try {
    const stored = await chrome.storage.local.get("welcomeTemplate");
    if (typeof stored?.welcomeTemplate === "string" && stored.welcomeTemplate.trim()) {
      tplValue = stored.welcomeTemplate;
      cfg.welcomeTemplate = tplValue;
    }
  } catch {
    /* fall through to in-memory cfg */
  }
  const tpl = (tplValue || DEFAULT_WELCOME_TEMPLATE).trim();
  const safeName = String(username || "friend").replace(/`+/g, "").trim() || "friend";
  return tpl.replace(/\{username\}/gi, safeName).trim();
}

function buildFallbackReply(message, err) {
  // Stay completely silent on failure — never broadcast API key warnings or error messages into the room chat
  return "";
}

function pruneWelcomedUsers(now) {
  if (cfg.welcomeCooldownMs <= 0) {
    welcomedUsers = {};
    return true;
  }
  const cutoff = now - cfg.welcomeCooldownMs;
  let pruned = false;
  for (const k of Object.keys(welcomedUsers)) {
    if (welcomedUsers[k] < cutoff) {
      delete welcomedUsers[k];
      pruned = true;
    }
  }
  return pruned;
}

function shouldWelcome(username) {
  if (!cfg.botEnabled) return false;
  if (!cfg.welcomeEnabled) return false;
  // Join welcomes are controlled by welcomeEnabled; strict mention mode applies
  // to normal chat messages only, so a user can require @mentions for AI
  // replies while still using auto-greet on join.
  if (!username) return false;
  const norm = normalizeUsername(username);
  if (norm === normalizeUsername(cfg.botUsername)) return false;
  if (cfg.excludedUsernames.map(normalizeUsername).includes(norm)) return false;

  const now = Date.now();
  pruneWelcomedUsers(now);

  const last = welcomedUsers[norm];
  if (cfg.welcomeCooldownMs > 0 && last && (now - last < cfg.welcomeCooldownMs)) return false;

  welcomedUsers[norm] = now;
  return true;
}

// ---------------------------------------------------------------------------
// Reply dispatch
// ---------------------------------------------------------------------------

async function dispatchReply(tabId, text, originalMessage) {
  let targetTabId = tabId;
  if (!targetTabId) {
    try {
      const tabs = await chrome.tabs.query({ url: ["*://*.free4talk.com/*", "*://free4talk.com/*"] });
      targetTabId = tabs?.[0]?.id;
    } catch {}
  }
  if (!targetTabId) {
    console.warn("[dispatchReply] no active free4talk tab found");
    return;
  }
  if (cfg.replyDelayMs > 0) await sleep(cfg.replyDelayMs);
  try {
    await chrome.tabs.sendMessage(targetTabId, {
      type: "SEND_REPLY",
      data: { text, originalMessage },
    });
  } catch (err) {
    console.error("Failed to send reply to tab:", err);
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  (async () => {
    try {
      await initPromise;
      switch (req?.type) {
        case "PING_CONFIG": {
          sendResponse({ ok: true, config: cfg });
          return;
        }
        
        case "UPDATE_BOT_STATUS": {
          cfg.botEnabled = !!req.enabled;
          await chrome.storage.local.set({ botEnabled: cfg.botEnabled });
          sendResponse({ ok: true });
          return;
        }

        case "RESET_HISTORY": {
          chatHistory = [];
          lastBotReplyTo = null;
          lastBotReplyTime = 0;
          lastBotReplyText = "";
          welcomedUsers = {};
          if (runtimeSaveTimer) { clearTimeout(runtimeSaveTimer); runtimeSaveTimer = null; }
          // Force the fingerprint cache to invalidate so the empty slice
          // actually gets written (otherwise lastPersistedFingerprint may
          // match the previous "0|" and we'd skip the write entirely).
          lastPersistedFingerprint = "__reset__";
          await persistRuntime();
          await chrome.storage.local.remove(["botMemoryUi"]);
          sendResponse({ ok: true });
          return;
        }

        case "DELETE_MEMORY_ITEMS": {
          // Delete by stable "key" (username + content + fromAI + timestamp).
          // We can't use array index because the live (session) and persistent
          // (local) slices can disagree, and trusting an index from one of them
          // would silently delete the wrong row in the other.
          const keys = new Set(safeArr(req.keys).map(String));
          if (keys.size === 0) {
            sendResponse({ ok: false, reason: "no_keys" });
            return;
          }
          const keyOf = (m) =>
            `${String(m.username || "")}\u0001${String(m.content || "")}\u0001${m.fromAI ? "1" : "0"}\u0001${m.timestamp ?? ""}`;

          const filterFn = (arr) => safeArr(arr).filter((m) => !keys.has(keyOf(m)));

          chatHistory = filterFn(chatHistory);

          let removed = 0;
          try {
            const localData = await chrome.storage.local.get(PERSISTENT_HISTORY_KEY);
            const persistent = safeArr(localData?.[PERSISTENT_HISTORY_KEY]);
            const next = filterFn(persistent);
            removed = persistent.length - next.length;
            // Bypass the fingerprint cache — the persistent slice is being
            // truncated by the same number of rows the in-memory slice was,
            // so the cached fingerprint may incorrectly mark the next
            // persistRuntime() as a no-op.
            lastPersistedFingerprint = "__deleted__";
            if (next.length === 0) {
              await chrome.storage.local.remove(PERSISTENT_HISTORY_KEY);
            } else {
              await chrome.storage.local.set({ [PERSISTENT_HISTORY_KEY]: next });
            }
          } catch (e) {
            console.warn("DELETE_MEMORY_ITEMS persistent write failed:", e?.message || e);
          }

          await persistRuntime();
          sendResponse({ ok: true, removed, remaining: chatHistory.length });
          return;
        }

        case "STORAGE_USAGE": {
          // chrome.storage.local is 10 MB on Chrome 114+ (5 MB on older
          // builds). Prefer the live constant the browser exposes so the bar
          // matches reality on every channel; only fall back when missing.
          const localQuota = (chrome.storage.local.QUOTA_BYTES) || (10 * 1024 * 1024);
          const sessionQuota = (chrome.storage.session?.QUOTA_BYTES) || (10 * 1024 * 1024);

          let localBytes = 0;
          let sessionBytes = 0;
          let historyBytes = 0;
          try {
            localBytes = await chrome.storage.local.getBytesInUse(null);
          } catch (e) { /* not supported on some channels */ }
          try {
            historyBytes = await chrome.storage.local.getBytesInUse(PERSISTENT_HISTORY_KEY);
          } catch (e) { /* ignore */ }
          try {
            if (chrome.storage.session?.getBytesInUse) {
              sessionBytes = await chrome.storage.session.getBytesInUse(null);
            }
          } catch (e) { /* ignore */ }

          sendResponse({
            ok: true,
            local: { used: localBytes, quota: localQuota, historyUsed: historyBytes },
            session: { used: sessionBytes, quota: sessionQuota },
            limits: {
              historyLimit: HISTORY_LIMIT,
              // No fixed row cap on the persistent slice anymore — we keep
              // every message until we'd otherwise exceed the byte budget.
              // Surface the byte budget instead so the Memory Manager can
              // show "X of Y MB used" if it wants.
              persistentSafetyBytes: PERSISTENT_SAFETY_BYTES,
            },
            rev: runtimeRev,
          });
          return;
        }

        case "GET_RUNTIME_STATE": {
          // Direct snapshot for UIs that want to bootstrap without going
          // through chrome.storage. Faster than a storage round-trip when
          // the worker is already warm. Return the full in-memory history;
          // the safety prune in persistRuntime() is the only thing that
          // ever drops rows, and once a row is gone from chatHistory we
          // genuinely don't have it to hand back.
          sendResponse({
            ok: true,
            rev: runtimeRev,
            chatHistory: chatHistory.slice(),
            lastBotReplyTo,
            lastBotReplyTime,
            lastBotReplyText,
            welcomedUsers,
          });
          return;
        }

        case "JOIN_NOTIFICATION": {
          const { username } = req.data || {};
          // refreshStrictMentionConfig now also re-pulls botEnabled /
          // welcomeEnabled / chatRepliesEnabled / welcomeDelaySec so a stale
          // service-worker cfg doesn't ignore the latest popup edits.
          await refreshStrictMentionConfig();
          if (!shouldWelcome(username)) {
            sendResponse({ ok: true, sent: false });
            return;
          }
          const text = await buildWelcomeText(username);
          const tabId = sender?.tab?.id;

          // Free-form delay: clamp only the lower bound. The user explicitly
          // asked for no upper cap, so a 2-hour wait is allowed if they type
          // 7200. NaN / negative / non-numeric → fall back to 0 = immediate.
          const rawDelay = Number(cfg.welcomeDelaySec);
          const delaySec = Number.isFinite(rawDelay) && rawDelay > 0 ? Math.floor(rawDelay) : 0;

          // Tiny delays (≤ 3s) stay inline — service worker won't shut down
          // that fast and the latency keeps the welcome feeling natural.
          if (delaySec <= 3) {
            if (delaySec > 0) await sleep(delaySec * 1000);
            lastBotReplyText = text;
            lastBotReplyTime = Date.now();
            recordBotReply(text);
            await dispatchReply(tabId, text, { username, isWelcome: true });
            await queuePersistRuntime();
            sendResponse({ ok: true, sent: true, text, delayedSec: delaySec });
            return;
          }

          // Real delay → use chrome.alarms so the worker can sleep and still
          // fire the welcome at the right time. setTimeout/sleep does NOT
          // survive MV3 service-worker shutdown — that was the original bug.
          const alarmName = `${WELCOME_ALARM_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await addPendingWelcome(alarmName, { username, text, tabId, scheduledAt: Date.now() });

          // chrome.alarms uses minutes; convert seconds → minutes.
          // Packed extensions clamp delays below 30s up to 30s — we surface
          // this in the popup help text so users aren't surprised.
          const delayInMinutes = delaySec / 60;
          try {
            chrome.alarms.create(alarmName, { delayInMinutes });
            console.log(`[welcome] scheduled alarm ${alarmName} for ${username} in ${delaySec}s`);
          } catch (e) {
            console.error("[welcome] alarm create failed; firing inline:", e);
            await popPendingWelcome(alarmName);
            lastBotReplyText = text;
            lastBotReplyTime = Date.now();
            recordBotReply(text);
            await dispatchReply(tabId, text, { username, isWelcome: true });
            await queuePersistRuntime();
          }

          sendResponse({ ok: true, sent: true, text, delayedSec: delaySec, alarmName });
          return;
        }

        case "NEW_MESSAGE": {
          const data = req.data;
          if (!data || !data.username || !data.content) {
            sendResponse({ ok: false, reason: "invalid" });
            return;
          }

          // Drop echoes before mutating history (content script can still race).
          if (cfg.ignoreSelfMessages && matchesFreshOutgoingEcho(data.content)) {
            sendResponse({ ok: true, replied: false, reason: "self_echo_recent_outgoing" });
            return;
          }

          const incomingTs = (typeof data.timestamp === "number" && Number.isFinite(data.timestamp))
            ? data.timestamp
            : Date.now();
          const incomingDisplayTs = (typeof data.timestamp === "string" && data.timestamp.trim())
            ? data.timestamp
            : new Date(incomingTs).toLocaleTimeString();
          chatHistory.push({
            ...data,
            fromAI: false,
            timestamp: incomingTs,
            displayTime: incomingDisplayTs,
          });
          if (chatHistory.length > HISTORY_LIMIT) chatHistory.shift();
          
          // Non-blocking persistence: save history in the background so AI generation begins immediately!
          queuePersistRuntime();

          const decision = shouldRespond(data);
          if (!decision.ok) {
            sendResponse({ ok: true, replied: false, reason: decision.reason });
            return;
          }

          let text = "";
          try {
            text = await generateReply(data);
          } catch (err) {
            console.warn("AI generation failed; using fallback reply:", err?.message || err);
            text = buildFallbackReply(data, err);
          }
          if (!text) {
            sendResponse({ ok: true, replied: false, reason: "empty_reply" });
            return;
          }

          const replyTs = Date.now();
          chatHistory.push({
            username: cfg.botUsername,
            content: text,
            fromAI: true,
            timestamp: replyTs,
            displayTime: new Date(replyTs).toLocaleTimeString(),
          });
          if (chatHistory.length > HISTORY_LIMIT) chatHistory.shift();

          lastBotReplyTo   = normalizeUsername(data.username);
          lastBotReplyTime = Date.now();
          lastBotReplyText = text;
          recordBotReply(text);

          const tabId = sender?.tab?.id;
          await dispatchReply(tabId, text, data);
          queuePersistRuntime();

          sendResponse({ ok: true, replied: true, text, reason: decision.reason });
          return;
        }

        default:
          sendResponse({ ok: false, reason: "unknown_request" });
      }
    } catch (err) {
      console.error("Background error:", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

console.log("✅ Free4Talk AI Bot background ready");
