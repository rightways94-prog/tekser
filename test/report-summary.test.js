import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = html.match(/\/\/ BEGIN CLASS REPORT([\s\S]*?)\/\/ END CLASS REPORT/);
test("top three groups are sorted by distinct pupils", () => {
  const descriptors=["Строит график", "Обосновывает вывод", "Указывает область", "Выбирает формулу"];
  const entries=Array.from({length:4},(_,i)=>({student:`У-${i}`,score:i,max:4,tags:Array.from({length:4-i},(_,n)=>`D${n+1}`),descriptors,hint:"Подумай"}));
  assert.deepEqual(report(entries).errors.map(e=>e.count),[4,3,2]);
});
function report(entries) {
  assert.ok(block);
  const context = vm.createContext({});
  vm.runInContext(block[1], context);
  return JSON.parse(JSON.stringify(vm.runInContext("classReport", context)(entries)));
}
const descriptors = ["Сохраняет знак степени", "Верно определяет знак ответа"];
const entry = (student, score, tags, hint = "Проверь знак") => ({ student, score, max: 2, tags, descriptors, comments: [], hint });
test("mean, range and histogram describe checked students only", () => {
  const r = report([entry("У-01", 2, []), entry("У-02", 1, ["D2"]), entry("У-03", 0, ["D1", "D2"]), { student: "error", score: null, max: null }]);
  assert.equal(r.n, 3);assert.equal(r.mean, 50);assert.equal(r.min, 0);assert.equal(r.max, 100);
  assert.deepEqual(r.bins, [1, 0, 1, 0, 1]);
});
test("similar criteria count a pupil once and reuse existing hints", () => {
  const r = report([entry("У-01", 2, []), entry("У-02", 1, ["D2"]), entry("У-03", 0, ["D1", "D2"], "Сравни знаки")]);
  assert.equal(r.errors.length, 1);assert.equal(r.errors[0].category, "sign");
  assert.equal(r.errors[0].count, 2);assert.equal(r.errors[0].hints.length, 2);
});
test("teacher corrections remove the corresponding error from the report", () => {
  const r = report([entry("У-01", 2, []), entry("У-02", 1, ["D2"]), entry("У-03", 2, [])]);
  assert.equal(Math.round(r.mean), 83);assert.equal(r.errors[0].count, 1);
  assert.equal(report([]).n, 0);
});
test("approved rows expose only the first error to the compact table", () => {
  const source = html.slice(html.indexOf("function batchDetails(row)"), html.indexOf("function renderBatch()"));
  const context = vm.createContext({ batchApproval: () => ({ tags: ["D1", "D2"], score: 0, hint: "Подумай" }), t: () => "Ошибок нет", scoreOf: () => 0 });
  vm.runInContext(source, context);
  const details = vm.runInContext("batchDetails", context)({ task: { descriptors: ["Первый критерий", "Второй критерий"] }, result: { error_tags: ["D1", "D2"], hint: "Подумай" } });
  assert.equal(details.firstError, "Первый критерий");
  assert.ok(details.error.includes("Второй критерий"), "CSV retains all error criteria");
});
