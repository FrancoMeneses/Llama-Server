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
 * SAFE SEND (ANTI CRASH)
 * =========================
 */
const safeSend = async (chatId, text) => {
  try {
    if (!text) return;
    await bot.sendMessage(chatId, text);
  } catch (err) {
    console.log("❌ TELEGRAM ERROR:", err.message);
  }
};

/**
 * =========================
 * CONTEXT
 * =========================
 */
const getContext = () => `
WORKDIR: ${process.cwd()}
`;

/**
 * =========================
 * CLEAN OUTPUT
 * =========================
 */
const cleanLLMOutput = (text) => {
  if (!text) return "";

  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
};

/**
 * =========================
 * EXTRACT JSON
 * =========================
 */
const extractJSON = (text) => {
  try {
    const matches = text.match(/\{[\s\S]*?\}/g);
    if (!matches) return null;

    return JSON.parse(matches[matches.length - 1]);
  } catch {
    return null;
  }
};

/**
 * =========================
 * CALL LLM (OLLAMA)
 * =========================
 */
const callLLM = async (input, context) => {
  const prompt = `
Return ONLY valid JSON.

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
        model: process.env.LLM_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.2
        }
      })
    });

    const data = await res.json();

    const raw = cleanLLMOutput(data.response);

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
    console.log("❌ LLM ERROR:", err.message);

    return {
      type: "chat",
      message: "LLM error",
      tool: null
    };
  }
};

/**
 * =========================
 * TOOL EXECUTION
 * =========================
 */
const runTool = async (tool, chatId) => {
  const { name, input } = tool;

  try {
    if (name === "shell") {
      if (DRY_RUN) return "[DRY RUN] shell skipped";
      const { stdout } = await execAsync(input, { timeout: 15000 });
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
      if (chatId) await safeSend(chatId, input);
      return "sent";
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
    await safeSend(chatId, res.message);
    return;
  }

  if (res.type === "tool") {
    const output = await runTool(res.tool, chatId);

    await safeSend(
      chatId,
      `🛠 ${res.tool.name}:\n\n${output}`
    );
  }
};

/**
 * =========================
 * TELEGRAM ENTRY (LOCK)
 * =========================
 */
let processing = false;

bot.on("message", async (msg) => {
  if (processing) return;

  processing = true;

  try {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    console.log("📩", text);

    const context = getContext();
    const res = await callLLM(text, context);

    await handleResponse(res, chatId);

  } catch (err) {
    console.log("ERROR:", err.message);
  }

  processing = false;
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
  res.send("🚀 Ollama agent running");
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