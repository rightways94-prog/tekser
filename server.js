// Тексер — сервер. Проверка фото работы по дескрипторам через OpenAI Responses API.
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-6.1-sol";
const LIMIT = Number(process.env.LIMIT_PER_HOUR || 5);

const tasks = JSON.parse(readFileSync(new URL("./data/tasks.json", import.meta.url)));
const app = express();
app.set("trust proxy", 1); // за Caddy: настоящий IP для лимита
app.use(express.json({ limit: "20mb" }));
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

app.get("/api/status", (_req, res) => res.json({ live: Boolean(KEY), model: KEY ? MODEL : null, limitPerHour: LIMIT }));
app.get("/api/tasks", (_req, res) => res.json(tasks));
app.get("/api/schedule", (_req, res) => res.sendFile(fileURLToPath(new URL("./data/schedule.json", import.meta.url))));
app.get("/api/demo", (_req, res) => res.sendFile(fileURLToPath(new URL("./data/demo.json", import.meta.url))));

const T = {
  ru: {
    noKey: "Проверка фото выключена: нет ключа API. Работает демо-режим.",
    missing: "Нужны задание и фото.",
    customInvalid: "Укажите название (до 120 знаков), условие и эталон (до 10 000 знаков), 1–30 дескрипторов (до 500 знаков каждый).",
    criterionError: (text) => `Не выполнено: ${text}`,
    criterionTip: "Повторите этот шаг на похожем задании.",
    limit: (n) => `Лимит: ${n} проверок в час. Попробуйте позже или используйте демо-работы.`,
    upstream: "Ошибка OpenAI. Попробуйте позже.",
    failed: "Не удалось проверить фото. Попробуйте ещё раз.",
  },
  kk: {
    noKey: "Фотоны тексеру өшірулі: API кілті жоқ. Демо режимі жұмыс істейді.",
    missing: "Тапсырма мен фото қажет.",
    customInvalid: "Атауын (120 таңбаға дейін), шартын және үлгі жауабын (10 000 таңбаға дейін), 1–30 дескрипторды (әрқайсысы 500 таңбаға дейін) көрсетіңіз.",
    criterionError: (text) => `Орындалмады: ${text}`,
    criterionTip: "Осы қадамды ұқсас тапсырмада қайталаңыз.",
    limit: (n) => `Шектеу: сағатына ${n} тексеру. Кейінірек қайталаңыз немесе демо жұмыстарды пайдаланыңыз.`,
    upstream: "OpenAI қатесі. Кейінірек қайталаңыз.",
    failed: "Фотоны тексеру мүмкін болмады. Қайта көріңіз.",
  },
};

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
    task.custom ? "Ты проверяешь письменную работу ученика (фото) по заданию, эталону и дескрипторам учителя." : "Ты проверяешь письменную работу ученика по математике (фото) по дескрипторам суммативного оценивания (БЖБ/СОР).",
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

function customAssignment(value) {
  const text = (s, max) => typeof s === "string" && s.trim().length > 0 && s.length <= max;
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !/^custom-[a-zA-Z0-9-]{1,80}$/.test(value.id)
    || !text(value.title, 120) || !text(value.prompt, 10000) || !text(value.answer, 10000)
    || !Array.isArray(value.descriptors) || !value.descriptors.length || value.descriptors.length > 30
    || !value.descriptors.every(d => text(d, 500))) return null;
  const descriptors = value.descriptors.map((d, i) => ({ id: `D${i + 1}`, part: "1", text: d.trim(), kk: d.trim() }));
  return {
    id: value.id, custom: true,
    parts: [{ id: "1", text: value.prompt.trim(), answer: value.answer.trim() }],
    descriptors,
    errorTags: descriptors.map(d => ({ id: d.id, ru: T.ru.criterionError(d.text), kk: T.kk.criterionError(d.text) })),
  };
}

app.post("/api/check", async (req, res) => {
  const messages = T[req.body?.lang === "kk" ? "kk" : "ru"];
  if (!KEY) return res.status(503).json({ error: messages.noKey });
  const { taskId, image, lang } = req.body || {};
  const images = (Array.isArray(req.body?.images) ? req.body.images : [image]).filter((x) => typeof x === "string" && x.startsWith("data:image/")).slice(0, 4);
  const hasCustom = req.body?.customTask !== undefined;
  const task = hasCustom ? customAssignment(req.body.customTask) : tasks.find((t) => t.id === taskId);
  if (hasCustom && (!task || (taskId && taskId !== task.id))) return res.status(400).json({ error: messages.customInvalid });
  if (!task || !images.length) return res.status(400).json({ error: messages.missing });
  if (!allowed(req.ip)) return res.status(429).json({ error: messages.limit(LIMIT) });
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
    if (!r.ok) return res.status(502).json({ error: messages.upstream });
    const result = JSON.parse(outputText(data));
    if (task.custom) {
      if (!Array.isArray(result.descriptors) || result.descriptors.length !== task.descriptors.length
        || task.descriptors.some(d => result.descriptors.filter(x => x.id === d.id && typeof x.met === "boolean").length !== 1)) {
        return res.status(502).json({ error: messages.upstream });
      }
      result.error_tags = result.descriptors.filter(d => !d.met).map(d => d.id);
    }
    res.json({ ...result, model: MODEL }); // фото нигде не сохраняется
  } catch {
    res.status(500).json({ error: messages.failed });
  }
});

app.listen(PORT, () => console.log(`Тексер: http://localhost:${PORT} · проверка ${KEY ? "через " + MODEL : "выключена — нет OPENAI_API_KEY"}`));
