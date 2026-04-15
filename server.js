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
 * TELEGRAM BOT
 * =========================
 */
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: true
});

/**
 * =========================
 * LOAD TASKS
 * =========================
 */
const loadTasks = () => {
  try {
    const content = fs.readFileSync(process.env.PLAN_PATH, "utf-8");

    return content
      .split("\n")
      .filter(l => l.startsWith("- "))
      .map(l => l.replace("- ", "").trim());
  } catch {
    return [];
  }
};

/**
 * =========================
 * CONTEXT
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
 * SAFE JSON EXTRACTION
 * =========================
 */
const extractJSON = (text) => {
  if (!text) return null;

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const cleaned = match[0]
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(cleaned);
  } catch {
    return null;
  }
};

/**
 * =========================
 * LLM CALL
 * =========================
 */
const callLLM = async (input, context) => {
  const prompt = `
You are a hybrid assistant.

You can:
- respond normally (chat)
- or use tools

TOOLS:
- shell
- claude
- codex
- db_query
- telegram_send

RETURN EXACTLY ONE JSON OBJECT.

FORMAT:
{
  "type": "chat" | "tool",
  "message": "string",
  "tool": {
    "name": "shell | claude | codex | db_query | telegram_send",
    "input": "string"
  } | null
}

RULES:
- ONLY ONE JSON OBJECT
- NO explanations
- NO multiple outputs
- INVALID if duplicated

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
    const text = data.content || data.response || "";

    console.log("\n🧠 RAW LLM:\n", text);

    const parsed = extractJSON(text);

    if (!parsed) {
      return {
        type: "chat",
        message: text || "No valid JSON returned",
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
 * TOOL EXECUTOR
 * =========================
 */
const executeTool = async (tool, chatId) => {
  const { name, input } = tool;

  console.log("🛠 TOOL:", name, input);

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
      output = `DB (mock): ${input}`;
    }

    if (name === "telegram_send") {
      if (chatId) {
        bot.sendMessage(chatId, input);
      }
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
    const output = await executeTool(res.tool, chatId);

    if (chatId) {
      bot.sendMessage(
        chatId,
        `🛠 ${res.tool.name}:\n\n${output}`
      );
    }
  }
};

/**
 * =========================
 * PIPELINE MODE
 * =========================
 */
const runPipeline = async (chatId = null) => {
  const tasks = loadTasks();

  console.log("\n🚀 TASKS:", tasks.length);

  for (const task of tasks) {
    console.log("\n📌 TASK:", task);

    const context = getContext();

    const res = await callLLM(task, context);

    await handleResponse(res, chatId);
  }

  console.log("\n✅ PIPELINE DONE");
};

/**
 * =========================
 * TELEGRAM
 * =========================
 */
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  console.log("📩 Telegram:", text);

  if (text === "/run") {
    runPipeline(chatId);
    return;
  }

  const context = getContext();
  const res = await callLLM(text, context);

  await handleResponse(res, chatId);
});

/**
 * =========================
 * EXPRESS API
 * =========================
 */
app.post("/run", async (req, res) => {
  runPipeline();
  res.json({ status: "started" });
});

app.get("/", (req, res) => {
  res.send("🚀 Hybrid Agent Stable");
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