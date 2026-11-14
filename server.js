// Тексер — сервер. Проверка фото работы по дескрипторам через OpenAI Responses API.
import express from "express";
import { readFileSync } from "node:fs";

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-6.1-sol";
const LIMIT = Number(process.env.LIMIT_PER_HOUR || 5);

const tasks = JSON.parse(readFileSync(new URL("./data/tasks.json", import.meta.url)));
const app = express();
app.set("trust proxy", 1); // за Caddy: настоящий IP для лимита
app.use(express.json({ limit: "8mb" }));
app.use(express.static(new URL("./public", import.meta.url).pathname));

app.get("/api/status", (_req, res) => res.json({ live: Boolean(KEY), model: KEY ? MODEL : null, limitPerHour: LIMIT }));
app.get("/api/tasks", (_req, res) => res.json(tasks));
app.get("/api/demo", (_req, res) => res.sendFile(new URL("./data/demo.json", import.meta.url).pathname));

// Простой лимит: не больше LIMIT проверок в час с одного IP.
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= LIMIT) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["readable", "transcript", "descriptors", "first_error", "hint", "error_tags"],
  properties: {
    readable: { type: "boolean" },
    transcript: { type: "string" },
    descriptors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "met", "comment"],
        properties: { id: { type: "string" }, met: { type: "boolean" }, comment: { type: "string" } },
      },
    },
    first_error: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["part", "text"],
          properties: { part: { type: "string" }, text: { type: "string" } },
        },
      ],
    },
    hint: { type: "string" },
    error_tags: { type: "array", items: { type: "string" } },
  },
};

function buildPrompt(task, lang) {
  const L = lang === "kk" ? "казахском" : "русском";
  return [
    "Ты проверяешь письменную работу ученика по математике (фото) по дескрипторам суммативного оценивания (БЖБ).",
    `Задание:\n${task.parts.map((p) => `${p.id}) ${p.text}`).join("\n")}`,
    `Эталон:\n${task.parts.map((p) => `${p.id}) ${p.answer}`).join("\n")}`,
    `Дескрипторы (по 1 баллу):\n${task.descriptors.map((d) => `${d.id}: ${d.text}`).join("\n")}`,
    `Коды типичных ошибок: ${task.errorTags.map((e) => `${e.id} — ${e.ru}`).join("; ")}.`,
    "Правила:",
    "- Сначала перепиши решение с фото в transcript (кратко, как есть). Если фото нечитаемо — readable=false и все дескрипторы met=false.",
    "- Дескриптор засчитывается, только если в работе есть верное действие/ответ по нему. Верный ответ другим верным способом засчитывается.",
    "- first_error: первая существенная ошибка (часть задания и что именно не так) или null, если ошибок нет.",
    `- hint: одна короткая подсказка ученику на ${L} языке к первой ошибке, без полного решения и без ответа. Если ошибок нет — «Все правильно.»`,
    "- error_tags: коды из списка для всех найденных ошибок (можно пустой массив).",
    `- comment к дескрипторам — до 12 слов на ${L} языке.`,
  ].join("\n");
}

function outputText(r) {
  if (typeof r.output_text === "string") return r.output_text;
  for (const item of r.output || []) for (const c of item.content || []) if (c.type === "output_text") return c.text;
  return "";
}

app.post("/api/check", async (req, res) => {
  if (!KEY) return res.status(503).json({ error: "Проверка своих фото выключена: нет ключа API. Работает демо-режим." });
  const { taskId, image, lang } = req.body || {};
  const task = tasks.find((t) => t.id === taskId);
  if (!task || typeof image !== "string" || !image.startsWith("data:image/")) return res.status(400).json({ error: "Нужны задание и фото." });
  if (!allowed(req.ip)) return res.status(429).json({ error: `Лимит: ${LIMIT} фото в час. Попробуйте позже или используйте демо-работы.` });
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: [{ role: "user", content: [
          { type: "input_text", text: buildPrompt(task, lang) },
          { type: "input_image", image_url: image },
        ] }],
        text: { format: { type: "json_schema", name: "bzhb_check", schema, strict: true } },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "Ошибка OpenAI" });
    const result = JSON.parse(outputText(data));
    res.json({ ...result, model: MODEL }); // фото нигде не сохраняется
  } catch (e) {
    res.status(500).json({ error: "Не удалось проверить: " + e.message });
  }
});

app.listen(PORT, () => console.log(`Тексер: http://localhost:${PORT} · проверка ${KEY ? "через " + MODEL : "выключена — нет OPENAI_API_KEY"}`));
