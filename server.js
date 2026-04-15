import express from "express";
import fetch from "node-fetch";
import { exec } from "child_process";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import { promisify } from "util";

dotenv.config();

const app = express();
app.use(express.json());

const execAsync = promisify(exec);

const DRY_RUN = process.env.DRY_RUN === "true";

/**
 * =========================
 * TELEGRAM
 * =========================
 */
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: true
});

/**
 * =========================
 * LIGHT CONTEXT (NO BLOQUEO)
 * =========================
 */
const getContext = () => `
WORKDIR: ${process.cwd()}
`;

/**
 * =========================
 * CLEAN OUTPUT (CRITICAL)
 * =========================
 */
const cleanLLMOutput = (text) => {
  if (!text) return "";

  return text
    .replace(/INPUT:/g, "")
    .replace(/CONTEXT:/g, "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
};

/**
 * =========================
 * SAFE JSON EXTRACTION (LAST VALID)
 * =========================
 */
const extractJSON = (text) => {
  if (!text) return null;

  try {
    const matches = text.match(/\{[\s\S]*?\}/g);
    if (!matches || matches.length === 0) return null;

    const last = matches[matches.length - 1];

    return JSON.parse(last);
  } catch {
    return null;
  }
};

/**
 * =========================
 * ROUTER
 * =========================
 */
const routeLLM = async (input) => {
  const prompt = `
Classify intent.

Return ONLY JSON:

{
  "intent": "chat | plan | tool"
}

INPUT:
${input}
`;

  try {
    const res = await fetch(process.env.LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, temperature: 0.1 })
    });

    const data = await res.json();
    const text = cleanLLMOutput(data.content || data.response || "");

    const parsed = extractJSON(text);

    return parsed || { intent: "chat" };
  } catch {
    return { intent: "chat" };
  }
};

/**
 * =========================
 * MAIN LLM
 * =========================
 */
const callLLM = async (input, context) => {
  const prompt = `
You are a strict assistant.

Return ONLY ONE valid JSON object.

DO NOT:
- repeat INPUT
- repeat CONTEXT
- include explanations
- include extra text

FORMAT:
{
  "type": "chat" | "tool",
  "message": "string",
  "tool": {
    "name": "shell | claude | codex | db_query | telegram_send",
    "input": "string"
  } | null
}

INPUT:
${input}

CONTEXT:
${context}
`;

  try {
    const res = await fetch(process.env.LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        temperature: 0.2
      })
    });

    const data = await res.json();

    const raw = cleanLLMOutput(data.content || data.response || "");

    console.log("\n🧠 RAW:\n", raw);

    const parsed = extractJSON(raw);

    if (!parsed) {
      return {
        type: "chat",
        message: raw || "invalid response",
        tool: null
      };
    }

    return parsed;
  } catch (err) {
    return {
      type: "chat",
      message: "LLM error",
      tool: null
    };
  }
};

/**
 * =========================
 * TOOL EXECUTION (NON BLOCKING)
 * =========================
 */
const runTool = async (tool, chatId) => {
  const { name, input } = tool;

  try {
    if (name === "shell") {
      if (DRY_RUN) return "[DRY RUN] shell skipped";
      const { stdout } = await execAsync(input, { timeout: 10000 });
      return stdout;
    }

    if (name === "claude") {
      if (DRY_RUN) return "[DRY RUN] claude skipped";
      await execAsync(`claude "${input}"`);
      return "claude executed";
    }

    if (name === "codex") {
      if (DRY_RUN) return "[DRY RUN] codex skipped";
      await execAsync(`codex "${input}"`);
      return "codex executed";
    }

    if (name === "db_query") {
      return `DB MOCK: ${input}`;
    }

    if (name === "telegram_send") {
      if (chatId) await bot.sendMessage(chatId, input);
      return "sent to telegram";
    }

    return "unknown tool";
  } catch (err) {
    return `tool error: ${err.message}`;
  }
};

/**
 * =========================
 * DISPATCHER
 * =========================
 */
const handleResponse = async (res, chatId) => {
  if (!res) return;

  if (res.type === "chat") {
    await bot.sendMessage(chatId, res.message);
    return;
  }

  if (res.type === "tool") {
    const output = await runTool(res.tool, chatId);

    await bot.sendMessage(
      chatId,
      `🛠 ${res.tool.name}:\n\n${output}`
    );
  }
};

/**
 * =========================
 * TELEGRAM ENTRY
 * =========================
 */
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log("📩", text);

  try {
    const route = await routeLLM(text);
    const context = getContext();

    console.log("🧭 ROUTE:", route);

    if (route.intent === "chat") {
      const res = await callLLM(text, "chat mode");
      return await handleResponse(res, chatId);
    }

    if (route.intent === "plan") {
      const res = await callLLM(
        "ONLY PLAN IF NEEDED: " + text,
        context
      );
      return await handleResponse(res, chatId);
    }

    if (route.intent === "tool") {
      const res = await callLLM(text, context);
      return await handleResponse(res, chatId);
    }

  } catch (err) {
    console.log("ERROR:", err.message);
    await bot.sendMessage(chatId, "Error interno del agente");
  }
});

/**
 * =========================
 * EXPRESS
 * =========================
 */
app.post("/run", async (req, res) => {
  const result = await callLLM("run", getContext());
  res.json(result);
});

app.get("/", (req, res) => {
  res.send("🚀 Stable LLM agent running");
});

/**
 * =========================
 * START
 * =========================
 */
app.listen(3000, () => {
  console.log("🚀 Server running on 3000");
  console.log("DRY_RUN =", DRY_RUN);
});