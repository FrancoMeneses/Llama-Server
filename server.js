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
You are an intelligent assistant with access to tools.

CRITICAL RULES:

- Use "chat" for normal conversation, explanations, or questions.
- Use "tool" ONLY when a real-world action must be executed.
- NEVER use tools for simple questions or conversation.
- NEVER hallucinate tool usage.
- NEVER execute tools unless explicitly required.
- If unsure → ALWAYS choose "chat".

TOOLS AVAILABLE:

- shell → execute system commands
- claude → complex coding tasks
- codex → coding tasks
- db_query → query database
- telegram_send → send message to user

OUTPUT FORMAT (STRICT JSON ONLY, NO EXTRA TEXT):

{
  "type": "chat" | "tool",
  "message": "string",
  "tool": {
    "name": "shell | claude | codex | db_query | telegram_send",
    "input": "string"
  } | null
}

BEHAVIOR RULES:

- "message" should ALWAYS be present.
- If type = "chat" → tool MUST be null.
- If type = "tool" → tool MUST be filled.
- Be concise.
- Do NOT repeat INPUT or CONTEXT.

EXAMPLES:

User: "Hola"
→ { "type": "chat", "message": "Hola!", "tool": null }

User: "Qué puedes hacer?"
→ { "type": "chat", "message": "Puedo ayudarte con tareas, ejecutar comandos, trabajar con código, etc.", "tool": null }

User: "Lista archivos del directorio"
→ { "type": "tool", "message": "Listando archivos", "tool": { "name": "shell", "input": "ls" } }

User: "Crea un script en node para leer un archivo"
→ { "type": "tool", "message": "Creando script", "tool": { "name": "codex", "input": "Create a Node.js script that reads a file" } }

User: "Guardas contexto?"
→ { "type": "chat", "message": "No guardo contexto persistente actualmente, pero puedo trabajar con el contexto de esta conversación.", "tool": null }

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