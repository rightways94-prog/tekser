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
app.use(express.json({ limit: "20mb" }));
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
  required: ["readable", "variant", "transcript", "descriptors", "first_error", "hint", "error_tags"],
  properties: {
    readable: { type: "boolean" },
    variant: { type: "string" },
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

function buildPrompt(task, lang, pages) {
  const L = lang === "kk" ? "казахском" : "русском";
  const key = task.variants
    ? Object.entries(task.variants).map(([v, ps]) => `ВАРИАНТ ${v}:\n` + ps.map((p) => `${p.id}) ${p.text} → эталон: ${p.answer}`).join("\n")).join("\n\n")
    : `Задание и эталон:\n${task.parts.map((p) => `${p.id}) ${p.text} → эталон: ${p.answer}`).join("\n")}`;
  return [
    "Ты проверяешь письменную работу ученика по математике (фото) по дескрипторам суммативного оценивания (БЖБ/СОР).",
    pages > 1 ? `Работа одного ученика на ${pages} фото (страницах) — оцени её целиком.` : "",
    task.variants ? "Номер варианта напечатан на листе (VARIANT NN). Определи его, запиши в variant и используй эталон этого варианта. Если номер не виден — variant=\"?\", подбери вариант по условиям." : 'variant = "".',
    key,
    `Дескрипторы (по 1 баллу; номер задания в скобках):\n${task.descriptors.map((d) => `${d.id} (задание ${d.part}): ${d.text}`).join("\n")}`,
    `Коды типичных ошибок: ${task.errorTags.map((e) => `${e.id} — ${e.ru}`).join("; ")}.`,
    "Правила:",
    "- Сначала перепиши решение в transcript кратко, по номерам заданий. Имя ученика НЕ переписывай. Если фото нечитаемо — readable=false и все дескрипторы met=false.",
    "- Дескриптор засчитывается, только если в работе есть верное действие/ответ по нему. Черновик (DRAFT) учитывай как показ хода решения. Верный ответ другим верным способом засчитывается.",
    "- Если символ читается двояко (запятая/точка, минус в показателе), не угадывай в пользу ученика: укажи это в comment дескриптора словами «прочитано неуверенно».",
    "- first_error: первая существенная ошибка (номер задания и что не так) или null.",
    `- hint: одна короткая подсказка ученику на ${L} языке к первой ошибке, без решения и без ответа. Если ошибок нет — «Все правильно.»`,
    "- error_tags: коды из списка для всех найденных ошибок.",
    `- comment к дескрипторам — до 12 слов на ${L} языке.`,
  ].filter(Boolean).join("\n");
}

function outputText(r) {
  if (typeof r.output_text === "string") return r.output_text;
  for (const item of r.output || []) for (const c of item.content || []) if (c.type === "output_text") return c.text;
  return "";
}

app.post("/api/check", async (req, res) => {
  if (!KEY) return res.status(503).json({ error: "Проверка своих фото выключена: нет ключа API. Работает демо-режим." });
  const { taskId, image, lang } = req.body || {};
  const images = (Array.isArray(req.body?.images) ? req.body.images : [image]).filter((x) => typeof x === "string" && x.startsWith("data:image/")).slice(0, 4);
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !images.length) return res.status(400).json({ error: "Нужны задание и фото." });
  if (!allowed(req.ip)) return res.status(429).json({ error: `Лимит: ${LIMIT} фото в час. Попробуйте позже или используйте демо-работы.` });
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: [{ role: "user", content: [
          { type: "input_text", text: buildPrompt(task, lang, images.length) },
          ...images.map((im) => ({ type: "input_image", image_url: im })),
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
