import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import { execSync } from "child_process";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const app = express();
app.use(express.json());

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
 * CONTEXT (ligero)
 * =========================
 */
const getContext = () => {
  let gitStatus = "";

  try {
    gitStatus = execSync("git status --porcelain").toString();
  } catch {
    gitStatus = "no git repo";
  }

  return `
WORKDIR: ${process.cwd()}
GIT:
${gitStatus || "clean"}
`;
};

/**
 * =========================
 * SAFE JSON PARSE
 * =========================
 */
const extractJSON = (text) => {
  if (!text) return null;

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

/**
 * =========================
 * ROUTER LLM (INTENT CLASSIFIER)
 * =========================
 */
const routeLLM = async (input) => {
  const prompt = `
Classify user intent.

Return ONLY JSON.

INTENTS:
- chat (normal conversation)
- plan (user wants tasks or planning)
- tool (needs execution or repo action)

INPUT:
${input}

OUTPUT:
{
  "intent": "chat | plan | tool"
}
`;

  try {
    const res = await fetch(process.env.LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, temperature: 0.1 })
    });

    const data = await res.json();
    const text = data.content || data.response || "";

    const parsed = extractJSON(text);

    return parsed || { intent: "chat" };
  } catch {
    return { intent: "chat" };
  }
};

/**
 * =========================
 * MAIN LLM (CHAT / PLAN / TOOL)
 * =========================
 */
const callLLM = async (input, context) => {
  const prompt = `
You are a hybrid assistant.

You may:
- chat normally
- generate plans (only if asked)
- suggest tool usage

TOOLS:
- shell
- claude
- codex
- db_query
- telegram_send

Return ONLY JSON.

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
      body: JSON.stringify({ prompt, temperature: 0.2 })
    });

    const data = await res.json();
    const text = data.content || data.response || "";

    const parsed = extractJSON(text);

    if (!parsed) {
      return {
        type: "chat",
        message: text || "No valid response",
        tool: null
      };
    }

    return parsed;
  } catch {
    return {
      type: "chat",
      message: "LLM error",
      tool: null
    };
  }
};

/**
 * =========================
 * TOOL EXECUTOR
 * =========================
 */
const runTool = async (tool, chatId) => {
  const { name, input } = tool;

  let output = "";

  try {
    if (name === "shell") {
      if (DRY_RUN) return "[DRY RUN] shell skipped";
      output = execSync(input).toString();
    }

    if (name === "claude") {
      if (DRY_RUN) return "[DRY RUN] claude skipped";
      execSync(`claude "${input}"`, { stdio: "inherit" });
      output = "claude executed";
    }

    if (name === "codex") {
      if (DRY_RUN) return "[DRY RUN] codex skipped";
      execSync(`codex "${input}"`, { stdio: "inherit" });
      output = "codex executed";
    }

    if (name === "db_query") {
      output = `DB MOCK: ${input}`;
    }

    if (name === "telegram_send") {
      if (chatId) bot.sendMessage(chatId, input);
      output = "sent to telegram";
    }
  } catch (err) {
    output = `error: ${err.message}`;
  }

  return output;
};

/**
 * =========================
 * DISPATCHER
 * =========================
 */
const handleResponse = async (res, chatId) => {
  if (!res) return;

  if (res.type === "chat") {
    if (chatId) bot.sendMessage(chatId, res.message);
    return;
  }

  if (res.type === "tool") {
    const output = await runTool(res.tool, chatId);

    if (chatId) {
      bot.sendMessage(chatId, `🛠 ${res.tool.name}:\n\n${output}`);
    }
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

  const route = await routeLLM(text);

  console.log("🧭 ROUTE:", route);

  const context = getContext();

  if (route.intent === "chat") {
    const res = await callLLM(text, "chat mode");
    return handleResponse(res, chatId);
  }

  if (route.intent === "plan") {
    const res = await callLLM(
      "Generate structured plan ONLY if needed: " + text,
      context
    );
    return handleResponse(res, chatId);
  }

  if (route.intent === "tool") {
    const res = await callLLM(text, context);
    return handleResponse(res, chatId);
  }
});

/**
 * =========================
 * EXPRESS API
 * =========================
 */
app.post("/run", async (req, res) => {
  const result = await callLLM("run pipeline", getContext());
  res.json(result);
});

app.get("/", (req, res) => {
  res.send("🚀 Agent Router Running");
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