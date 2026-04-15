import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const DRY_RUN = true;

/**
 * 1. LOAD TASKS FROM MD
 */
const loadTasks = () => {
  const content = fs.readFileSync(process.env.PLAN_PATH, "utf-8");

  return content
    .split("\n")
    .filter(l => l.startsWith("- "))
    .map(l => l.replace("- ", "").trim());
};

/**
 * 2. REPO CONTEXT (MINIMAL Y ESTABLE)
 */
const getRepoContext = () => {
  let gitStatus = "";

  try {
    gitStatus = execSync("git status --porcelain").toString();
  } catch (e) {
    gitStatus = "no git repo";
  }

  return `
WORKDIR: ${process.cwd()}
GIT_STATUS:
${gitStatus || "clean"}
`;
};

/**
 * 3. CALL LLM (llama.cpp SAFE VERSION)
 */
const callLLM = async (task, context) => {
  const prompt = `
You are a strict execution orchestrator.

Return ONLY valid JSON. No markdown. No explanation.

TASK:
${task}

CONTEXT:
${context}

RULES:
- choose tool: "claude" | "codex" | "shell"
- instruction must be executable
- no questions
- no extra keys

OUTPUT FORMAT:
{
  "tool": "claude",
  "instruction": "string",
  "done": true
}
`;

  try {
    const res = await fetch(process.env.LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        temperature: 0.2,
        stop: ["```"]
      })
    });

    const data = await res.json();

    const text = data.content || data.response || "";

    console.log("\n🧠 RAW LLM OUTPUT:\n", text);

    // SAFE JSON PARSE
    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(cleaned);
  } catch (err) {
    console.log("❌ LLM ERROR OR INVALID JSON:", err.message);

    return {
      tool: "shell",
      instruction: "echo 'LLM FAILED'",
      done: true
    };
  }
};

/**
 * 4. EXECUTORS
 */
const runClaude = (instruction) => {
  console.log("▶ CLAUDE:", instruction);

  if (DRY_RUN) return console.log("[DRY RUN] Claude skipped");

  execSync(`claude "${instruction}"`, { stdio: "inherit" });
};

const runCodex = (instruction) => {
  console.log("▶ CODEX:", instruction);

  if (DRY_RUN) return console.log("[DRY RUN] Codex skipped");

  execSync(`codex "${instruction}"`, { stdio: "inherit" });
};

const runShell = (instruction) => {
  console.log("▶ SHELL:", instruction);

  if (DRY_RUN) return console.log("[DRY RUN] Shell skipped");

  execSync(instruction, { stdio: "inherit" });
};

/**
 * 5. GIT SYNC
 */
const gitCommit = (task) => {
  if (DRY_RUN) return console.log("[DRY RUN] git skipped");

  try {
    execSync("git add .");
    execSync(`git commit -m "task: ${task}"`);
    execSync("git push");
  } catch (e) {
    console.log("⚠️ Git error:", e.message);
  }
};

/**
 * 6. PIPELINE CORE (ORQUESTADOR REAL)
 */
const runPipeline = async () => {
  const tasks = loadTasks();

  console.log("\n🚀 TASKS LOADED:", tasks.length);

  for (const task of tasks) {
    console.log("\n======================");
    console.log("📌 TASK:", task);

    const context = getRepoContext();

    const plan = await callLLM(task, context);

    console.log("🧩 PLAN:", plan);

    if (!plan || !plan.tool || !plan.instruction) {
      console.log("❌ INVALID PLAN, SKIPPING");
      continue;
    }

    try {
      if (plan.tool === "claude") {
        runClaude(plan.instruction);
      }

      if (plan.tool === "codex") {
        runCodex(plan.instruction);
      }

      if (plan.tool === "shell") {
        runShell(plan.instruction);
      }

      gitCommit(task);

      if (!plan.done) {
        console.log("⛔ STOP FLAG RECEIVED");
        break;
      }
    } catch (err) {
      console.log("❌ EXECUTION ERROR:", err.message);
      break;
    }
  }

  console.log("\n✅ PIPELINE FINISHED");
};

/**
 * 7. API TRIGGERS
 */
app.post("/run", async (req, res) => {
  runPipeline();
  res.json({ status: "started" });
});

app.post("/dry-run", async (req, res) => {
  console.log("🧪 DRY RUN MODE");
  runPipeline();
  res.json({ status: "dry-running" });
});

app.get("/", (req, res) => {
  res.send("🚀 Orchestrator alive");
});

/**
 * 8. START SERVER
 */
app.listen(3000, () => {
  console.log("🚀 Orchestrator running on port 3000");
  console.log("DRY_RUN =", DRY_RUN);
});