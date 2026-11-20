import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.match(/const store=[\s\S]*?let mem=\[\][^;]*;/)[0];
function storage(backing, writesFail = false) {
  const context = vm.createContext({ localStorage: {
    getItem() { return backing; },
    setItem(_key, value) { if (writesFail) throw new Error("quota"); backing = value; },
  }});
  vm.runInContext(source, context);
  return vm.runInContext("store", context);
}
test("approval remains in memory when storage writes fail but reads succeed", () => {
  const store = storage("[]", true);
  store.set([{ taskId: "custom-test", student: "У-01", tags: [] }]);
  assert.equal(store.get().length, 1);
  assert.equal(store.get()[0].student, "У-01");
});
test("successful storage writes remain readable", () => {
  const store = storage("[]");
  store.set([{ taskId: "custom-test", student: "У-01", tags: [] }]);
  assert.equal(store.get()[0].student, "У-01");
});
