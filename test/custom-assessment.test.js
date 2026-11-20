import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(new URL("../server.js", import.meta.url).href));
const customTask = { id: "custom-test", title: "Мой СОР", prompt: "Вычислите 2²", answer: "4", descriptors: ["Показывает умножение", "Получает ответ 4"] };
const result = { readable: true, variant: "", transcript: "2·2=5", descriptors: [{ id: "D1", met: true, comment: "" }, { id: "D2", met: false, comment: "Ошибка" }], first_error: { part: "1", text: "Ответ" }, hint: "Проверь умножение", error_tags: [] };

function server(aiResult = result, key = "test-only", env = {}) {
  const routes = new Map(), calls = [];
  const app = { set() {}, use() {}, get() {}, post(path, handler) { routes.set(path, handler); }, listen() {} };
  const express = Object.assign(() => app, { json() {}, static() {} });
  vm.runInNewContext(source, { express, readFileSync, fileURLToPath, URL, process: { env: { OPENAI_API_KEY: key, ...env } }, console: { log() {} }, fetch: async (_url, init) => {
    const payload = JSON.parse(init.body);calls.push(payload);
    const output = typeof aiResult === "function" ? aiResult(payload, calls.length) : aiResult;
    return { ok: true, json: async () => ({ output_text: JSON.stringify(output) }) };
  }});
  async function post(path, body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    const handler = routes.get(path);
    assert.ok(handler, `${path} route is registered`);
    await handler({ body, ip: "127.0.0.1" }, res);
    return res;
  }
  return { calls, check: body => post("/api/check", body), draft: body => post("/api/task-draft", body), batch: body => post("/api/batch-check", body) };
}
const request = (task = customTask) => ({ customTask: task, images: ["data:image/jpeg;base64,AA=="], lang: "ru" });

test("custom assignment is sent with teacher's rubric and yields descriptor error tags", async () => {
  const app = server();
  const res = await app.check(request());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body.error_tags), ["D2"]);
  const prompt = app.calls[0].input[0].content[0].text;
  for (const text of [customTask.prompt, customTask.answer, ...customTask.descriptors]) assert.ok(prompt.includes(text));
});
test("invalid custom assignments are rejected before calling AI", async () => {
  for (const patch of [{ prompt: "" }, { answer: " " }, { title: "x".repeat(121) }, { id: "alg7-bzhb-exponents" }, { id: ["custom-array"] }, { descriptors: [] }, { descriptors: [""] }, { descriptors: Array(31).fill("x") }, { prompt: "x".repeat(10001) }]) {
    const app = server();
    const res = await app.check(request({ ...customTask, ...patch }));
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.equal(app.calls.length, 0);
  }
});
test("incomplete AI rubric is rejected", async () => {
  const app = server({ ...result, descriptors: [result.descriptors[0]] });
  assert.equal((await app.check(request())).statusCode, 502);
});
test("duplicate or unknown AI descriptor IDs are rejected", async () => {
  for (const descriptors of [[result.descriptors[0], result.descriptors[0]], [result.descriptors[0], { id: "D9", met: false }]]) {
    assert.equal((await server({ ...result, descriptors }).check(request())).statusCode, 502);
  }
});
test("custom definition cannot be substituted for a different selected task", async () => {
  const app = server();
  const res = await app.check({ ...request(), taskId: "alg7-bzhb-exponents" });
  assert.equal(res.statusCode, 400);
  assert.equal(app.calls.length, 0);
});
test("custom checks use the existing per-IP limit", async () => {
  const app = server();
  for (let i = 0; i < 5; i++) assert.equal((await app.check(request())).statusCode, 200);
  assert.equal((await app.check(request())).statusCode, 429);
});
test("missing key returns localized demo-mode response without an AI call", async () => {
  for (const lang of ["ru", "kk"]) {
    const app = server(result, "");
    const res = await app.check({ ...request(), lang });
    assert.equal(res.statusCode, 503);
    assert.ok(res.body.error.includes(lang === "ru" ? "нет ключа" : "API кілті жоқ"));
    assert.equal(app.calls.length, 0);
  }
});
test("existing task still uses the stored assignment", async () => {
  const app = server();
  const res = await app.check({ taskId: "alg7-bzhb-exponents", images: ["data:image/jpeg;base64,AA=="], lang: "kk" });
  assert.equal(res.statusCode, 200);
  assert.ok(app.calls[0].input[0].content[0].text.includes("казахском"));
});

const draftResult = { title: "Степени", prompt: "1. Найдите 2²", answer: "1. 4", descriptors: ["Записывает произведение 2·2", "Получает ответ 4"] };
const photo = "data:image/jpeg;base64,AA==";
test("task draft uses supplied photos and rubric, same model and strict bounded schema", async () => {
  const app = server(draftResult);
  const res = await app.draft({ images: [photo], rubricImages: [photo], rubricText: "Ключ: 1. 4", text: "7 класс", lang: "kk" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), draftResult);
  const call = app.calls[0];
  assert.equal(call.model, "gpt-6.1-sol");
  const content = call.input[0].content;
  assert.equal(content.filter(c => c.type === "input_image").length, 2);
  const prompt = content.filter(c => c.type === "input_text").map(c => c.text).join("\n");
  for (const text of ["Ключ: 1. 4", "7 класс", "казахском", "точно", "РК", "по номерам", "ключевое действие", "верный ответ"]) assert.ok(prompt.includes(text), text);
  assert.equal(call.text.format.strict, true);
  assert.equal(call.text.format.schema.properties.descriptors.maxItems, 30);
});
test("text-only task draft is supported and invalid input does not call AI", async () => {
  assert.equal((await server(draftResult).draft({ text: "Найди 2²", lang: "ru" })).statusCode, 200);
  for (const body of [{}, { rubricText: "Критерий" }, { images: ["https://example.com/x.jpg"] }, { images: Array(5).fill(photo) }, { images: [photo], rubricImages: ["bad"] }, { text: "x".repeat(10001) }, { text: "Задание", rubricText: 4 }]) {
    const app = server(draftResult);
    assert.equal((await app.draft(body)).statusCode, 400);
    assert.equal(app.calls.length, 0);
  }
});
test("task draft rejects unusable AI results without truncating teacher criteria", async () => {
  for (const patch of [{ answer: "" }, { descriptors: [] }, { descriptors: Array(31).fill("Критерий") }, { descriptors: ["x".repeat(501)] }, { descriptors: ["Шаг\nОтвет"] }, { title: "x".repeat(121) }]) {
    assert.equal((await server({ ...draftResult, ...patch }).draft({ images: [photo] })).statusCode, 502);
  }
});
test("task draft and photo checking share the same limit", async () => {
  const app = server(result);
  for (let i = 0; i < 5; i++) assert.equal((await app.check(request())).statusCode, 200);
  assert.equal((await app.draft({ images: [photo] })).statusCode, 429);
  assert.equal(app.calls.length, 5);
});
test("task draft without key gives a localized 503", async () => {
  for (const lang of ["ru", "kk"]) {
    const app = server(draftResult, "");
    const res = await app.draft({ images: [photo], lang });
    assert.equal(res.statusCode, 503);
    assert.ok(res.body.error.includes(lang === "ru" ? "ключ" : "кілт"));
    assert.equal(app.calls.length, 0);
  }
});

const batchAI = payload => payload.text.format.name === "task_draft" ? draftResult : result;
test("batch work derives its own task before grading and excludes handwriting from the answer key", async () => {
  const app = server(batchAI);
  const res = await app.batch({ images: [photo, photo], rubricText: "Ключ учителя: 4", lang: "kk" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.task.answer, draftResult.answer);
  assert.deepEqual(Array.from(res.body.result.error_tags), ["D2"]);
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[0].model, app.calls[1].model);
  const draftPrompt = app.calls[0].input[0].content[0].text;
  assert.ok(draftPrompt.includes("Рукописное решение ученика НЕ является ключом"));
  assert.ok(draftPrompt.includes("Ключ учителя: 4"));
  const checkPrompt = app.calls[1].input[0].content[0].text;
  assert.ok(checkPrompt.includes(draftResult.answer));
  assert.equal(app.calls[1].input[0].content.filter(c => c.type === "input_image").length, 2);
});
test("separate batch works do not reuse the first variant's answer", async () => {
  let variant = 0;
  const app = server(payload => {
    if (payload.text.format.name === "task_draft") { variant++; return { ...draftResult, prompt: `Вариант ${variant}`, answer: `Ответ ${variant}` }; }
    return result;
  });
  const a = await app.batch({ images: [photo] });
  const b = await app.batch({ images: [photo] });
  assert.equal(a.body.task.answer, "Ответ 1");assert.equal(b.body.task.answer, "Ответ 2");
  assert.ok(app.calls[3].input[0].content[0].text.includes("Ответ 2"));
});
test("batch has a bounded per-work quota independent from single checks", async () => {
  const app = server(batchAI, "test-only", { BATCH_LIMIT_PER_HOUR: "2" });
  for (let i = 0; i < 2; i++) assert.equal((await app.batch({ images: [photo] })).statusCode, 200);
  assert.equal((await app.batch({ images: [photo] })).statusCode, 429);
  assert.equal(app.calls.length, 4);
  assert.equal((await app.check(request())).statusCode, 200);
});
test("a five-student batch works after the ordinary five-check quota is spent", async () => {
  const app = server(batchAI);
  for (let i = 0; i < 5; i++) assert.equal((await app.check(request())).statusCode, 200);
  assert.equal((await app.check(request())).statusCode, 429);
  for (let i = 0; i < 5; i++) assert.equal((await app.batch({ images: [photo, photo] })).statusCode, 200);
});
test("invalid batch work is rejected before spending quota or calling AI", async () => {
  const app = server(batchAI, "test-only", { BATCH_LIMIT_PER_HOUR: "1" });
  for (const body of [{}, { images: [] }, { images: Array(5).fill(photo) }, { images: ["https://bad.test/x.jpg"] }, { images: [photo], rubricText: 42 }]) {
    assert.equal((await app.batch(body)).statusCode, 400);
  }
  assert.equal(app.calls.length, 0);
  assert.equal((await app.batch({ images: [photo] })).statusCode, 200);
});
test("failed draft or grade is reported as a failure, never a zero score", async () => {
  const draftFailure = server(result);
  assert.equal((await draftFailure.batch({ images: [photo] })).statusCode, 502);
  assert.equal(draftFailure.calls.length, 1);
  const gradeFailure = server(payload => payload.text.format.name === "task_draft" ? draftResult : { ...result, descriptors: [] });
  const response = await gradeFailure.batch({ images: [photo] });
  assert.equal(response.statusCode, 502);assert.equal(response.body.result, undefined);
});
test("unreadable batch work is flagged for new photos instead of receiving a zero", async () => {
  const app = server(payload => payload.text.format.name === "task_draft" ? draftResult : { ...result, readable: false });
  const response = await app.batch({ images: [photo] });
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.result, undefined);
});
test("batch without key returns localized 503", async () => {
  for (const lang of ["ru", "kk"]) {
    const app = server(batchAI, "");
    const response = await app.batch({ images: [photo], lang });
    assert.equal(response.statusCode, 503);
    assert.ok(response.body.error.includes(lang === "ru" ? "ключ" : "кілт"));
    assert.equal(app.calls.length, 0);
  }
});

test("batch reference fixes descriptors once, solves another variant and reuses identical answer", async () => {
  let variant = 0;
  const app = server(payload => {
    if (payload.text.format.name === "task_draft") return draftResult;
    if (payload.text.format.name === "batch_variant") { variant++; return { sameVariant: variant === 2, referenceTaskNumbers: ["1", "2"], taskNumbers: ["1", "2"], title: "Вариант 2", prompt: "1. Найдите 3²", answer: "1. 9" }; }
    return result;
  });
  const first = await app.batch({ images: [photo] });
  assert.ok(first.body.referenceTask, "First work returns the fixed scale");
  const ref = first.body.referenceTask;
  const second = await app.batch({ images: [photo], referenceTask: ref });
  const third = await app.batch({ images: [photo], referenceTask: ref });
  assert.equal(second.body.task.answer, "1. 9");
  assert.equal(third.body.task.answer, ref.answer);
  for (const response of [first, second, third]) {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Array.from(response.body.task.descriptors), Array.from(ref.descriptors));
  }
  assert.equal(app.calls.filter(p => p.text.format.name === "task_draft").length, 1);
  assert.equal(app.calls.filter(p => p.text.format.name === "batch_variant").length, 2);
  assert.ok(app.calls[3].input[0].content[0].text.includes("1. 9"));
});
test("different task count gets its own scale and is still graded", async () => {
  const own = { ...draftResult, prompt: "1. Пример 2. Пример 3. Пример", descriptors: ["Шаг 1", "Шаг 2", "Шаг 3"] };
  const app = server(payload => {
    if (payload.text.format.name === "batch_variant") return { sameVariant: false, referenceTaskNumbers: ["1", "2"], taskNumbers: ["1", "2", "3"], title: own.title, prompt: own.prompt, answer: own.answer };
    if (payload.text.format.name === "task_draft") return own;
    return { ...result, descriptors: [...result.descriptors, { id: "D3", met: true, comment: "" }] };
  });
  const response = await app.batch({ images: [photo], referenceTask: draftResult });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.differentScale, true);
  assert.equal(response.body.task.descriptors.length, 3);
  assert.equal(response.body.referenceTask.descriptors.length, 2);
  assert.equal(app.calls.length, 3);
});
test("a prepared reference survives first grading failure and invalid references are rejected", async () => {
  const app = server(payload => payload.text.format.name === "task_draft" ? draftResult : { ...result, readable: false });
  const response = await app.batch({ images: [photo] });
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.referenceTask.answer, draftResult.answer);
  const invalid = server(batchAI);
  assert.equal((await invalid.batch({ images: [photo], referenceTask: {} })).statusCode, 400);
  assert.equal(invalid.calls.length, 0);
});

test("real worksheet variants 22, 21 and 25 all use the common 20-point scale", async () => {
  const worksheet = JSON.parse(readFileSync(new URL("../data/tasks.json", import.meta.url))).find(t => t.id === "alg7-sa1-exponents");
  const order=["22","21","25"];let current=0;
  const definition=v=>({ title:`Вариант ${v}`,prompt:worksheet.variants[v].map(p=>`${p.id}. ${p.text}`).join("\n"),answer:worksheet.variants[v].map(p=>`${p.id}. ${p.answer}`).join("\n"),descriptors:worksheet.descriptors.map(d=>d.text) });
  const app=server(payload=>{
    if(payload.text.format.name==="task_draft")return definition(order[current]);
    if(payload.text.format.name==="batch_variant"){
      current++;const d=definition(order[current]);
      return {...d,sameVariant:false,compatible:false,referenceTaskNumbers:["1","2","3","4","5","6"],taskNumbers:["1","2","3","4","5","6"]};
    }
    return {...result,first_error:null,descriptors:worksheet.descriptors.map(d=>({id:d.id,met:true,comment:""}))};
  });
  let reference;
  for(const v of order){
    const response=await app.batch({images:[photo,photo],...(reference?{referenceTask:reference}:{})});
    assert.equal(response.statusCode,200,`Variant ${v} must not be rejected`);
    reference ||= response.body.referenceTask;
    assert.equal(response.body.task.title,`Вариант ${v}`);
    assert.equal(response.body.differentScale,false);
    assert.equal(response.body.result.descriptors.length,20);
    assert.deepEqual(Array.from(response.body.task.descriptors),Array.from(reference.descriptors));
  }
  assert.equal(app.calls.filter(p=>p.text.format.name==="task_draft").length,1);
  assert.ok(app.calls.at(-1).input[0].content[0].text.includes(worksheet.variants["25"][0].answer));
});
