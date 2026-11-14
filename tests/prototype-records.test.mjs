import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../prototypes/egypt-trip/", import.meta.url);
const source = readFileSync(new URL("app.js", root), "utf8");
const bootstrap = source.slice(0, source.indexOf("function resultKey()"));
const say = source.slice(source.indexOf("function say("), source.indexOf("function start("));
const key = "antu-f1-f2-v1";

function boot(storage) {
  const context = vm.createContext({
    localStorage: storage,
    document: { getElementById: () => null },
  });
  for (const file of ["assets/egypt-places.js", "assets/city-experiences.js"]) {
    vm.runInContext(readFileSync(new URL(file, root), "utf8"), context);
  }
  vm.runInContext(bootstrap + say, context);
  return code => {
    const result = vm.runInContext(`JSON.stringify(${code})`, context);
    return result === undefined ? undefined : JSON.parse(result);
  };
}

function memoryStorage(initial = null) {
  let stored = initial;
  return {
    getItem: name => name === key ? stored : null,
    setItem(name, value) { assert.equal(name, key); stored = value; },
  };
}

test("reload restores user and template messages without losing interests or itinerary", () => {
  const storage = memoryStorage(JSON.stringify({ active: true, feedback: { giza: "yes" }, itinerary: { id: "saved" }, draft: { id: "draft" } }));
  const app = boot(storage);
  app("messages.splice(0)");
  app("messages.push({who:'user',text:'喜欢卢克索，但怕转场太累'})");
  app("say('先核对转场条件。')");
  const reloaded = boot(storage);
  assert.deepEqual(reloaded("messages"), [
    { who: "user", text: "喜欢卢克索，但怕转场太累" },
    { who: "ai", text: "先核对转场条件。" },
  ]);
  assert.deepEqual(reloaded("state.feedback"), { giza: "yes" });
  assert.deepEqual(reloaded("state.itinerary"), { id: "saved" });
  assert.deepEqual(reloaded("state.draft"), { id: "draft" });
});

test("legacy state loads without inventing historical chat", () => {
  const app = boot(memoryStorage(JSON.stringify({ active: true, feedback: { sail: "no" } })));
  assert.deepEqual(app("state.feedback"), { sail: "no" });
  assert.equal(app("messages.length"), 1);
  assert.match(app("messages[0].text"), /上次浏览/);
});

test("non-trip conversation is saved even before Egypt exploration starts", () => {
  const storage = memoryStorage();
  const app = boot(storage);
  app("messages.push({who:'user',text:'你好'})");
  app("say('目前可以先探索埃及。')");
  assert.equal(boot(storage)("messages.length"), 2);
});

test("invalid local records and unsupported message roles do not break startup", () => {
  for (const invalid of ["{", "[]", "null", "42"]) {
    assert.deepEqual(boot(memoryStorage(invalid))("messages"), []);
  }
  const app = boot(memoryStorage(JSON.stringify({ conversation: { version: 1, messages: [null, { who: "system", text: "bad" }, { who: "ai", text: "原有回答" }] } })));
  assert.deepEqual(app("messages"), [{ who: "ai", text: "原有回答" }]);
});

test("storage failure leaves current chat visible and reports saving failure", () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  const app = boot(storage);
  app("say('当前回答仍在。')");
  assert.equal(app("error"), true);
  assert.equal(app("messages[0].text"), "当前回答仍在。");
});
