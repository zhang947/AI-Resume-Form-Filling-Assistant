const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness({local = {}, sync = {}, failKey = null, locks = null} = {}) {
  const state = {local: structuredClone(local), sync: structuredClone(sync)};
  const writes = [];
  const area = (name) => ({
    async get(keys) { return Object.fromEntries(keys.filter((key) => Object.hasOwn(state[name], key)).map((key) => [key, structuredClone(state[name][key])])); },
    async set(values) { if (Object.hasOwn(values, failKey)) throw new Error("write failed"); writes.push({name, values: structuredClone(values)}); Object.assign(state[name], structuredClone(values)); },
    async remove(keys) { for (const key of keys) delete state[name][key]; }
  });
  const storage = {local: area("local"), sync: area("sync")};
  const context = {window: locks ? {navigator:{locks}} : {}, console}; vm.createContext(context);
  vm.runInContext(fs.readFileSync("shared/resume-schema.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("shared/resume-storage.js", "utf8"), context);
  return {api: context.window.ResumeStorage, storage, state, writes};
}

test("legacy templates migrate losslessly to Markdown with original recovery backup", async () => {
  const old = {a: {id:"a", name:"开发", profile:{personal:{fullName:"张三", phoneNumber:"123", customFact:"字段库以外的事实"}, educations:Array.from({length:20},(_,i)=>({school:`学校${i}`}))}, rawText:"历史原文"}, b:{id:"b",name:"测试",profile:{personal:{fullName:"李四"}}}};
  const h = harness({local:{resumeTemplates:old, activeResumeTemplateId:"b"}});
  const result = await h.api.loadTemplateState(h.storage);
  assert.equal(result.activeTemplateId,"b");
  const markdown = result.templates[0].markdown;
  for (const text of ["姓名：张三","字段库以外的事实","学校19","历史原文","待核对"]) assert.ok(markdown.includes(text),text);
  assert.equal("profile" in result.templates[0],false);
  assert.deepEqual(h.state.local.resumeMarkdownMigrationBackupV1.local.resumeTemplates,old);
  assert.equal("resumeTemplates" in h.state.local,false);
  assert.equal(h.writes.some((call)=>call.name === "sync"),false);
  const before = structuredClone(h.state.local.resumeMarkdownMigrationBackupV1);
  await h.api.loadTemplateState(h.storage);
  assert.deepEqual(h.state.local.resumeMarkdownMigrationBackupV1,before);
});

test("sync and old single-profile records are backed up before cleanup",async()=>{
  const h = harness({sync:{resumeStructured:{personal:{fullName:"旧用户"}}, resumeRawText:"原始资料"}});
  const state = await h.api.loadTemplateState(h.storage);
  assert.match(state.templates[0].markdown,/旧用户/);
  assert.match(state.templates[0].markdown,/原始资料/);
  assert.deepEqual(h.state.sync,{});
  assert.match(JSON.stringify(await h.api.exportMigrationBackup(h.storage)),/旧用户/);
});

test("empty local profile falls back to meaningful synchronized profile",async()=>{
  const h = harness({local:{resumeProfile:{personal:{fullName:""}}},sync:{resumeProfile:{personal:{fullName:"同步用户"}}}});
  const state = await h.api.loadTemplateState(h.storage);
  assert.match(state.templates[0].markdown,/同步用户/);
});

for (const failKey of ["resumeMarkdownMigrationBackupV1", "resumeDocumentsV1"]) {
  test(`failed migration write (${failKey}) leaves old information intact`,async()=>{
    const h = harness({local:{resumeProfile:{personal:{fullName:"保留"}}}, failKey});
    await assert.rejects(h.api.loadTemplateState(h.storage),/write failed/);
    assert.equal(h.state.local.resumeProfile.personal.fullName,"保留");
  });
}

test("Markdown is preserved exactly, including unknown information, false and zero",async()=>{
  const h = harness(); const state = await h.api.loadTemplateState(h.storage);
  const markdown = "# 任意章节\n\n- 玩过的游戏：星际争霸\n- 自定义：0\n  ";
  const saved = await h.api.saveTemplateContent(state.activeTemplateId,{markdown},h.storage);
  assert.equal(saved.markdown,markdown);
  assert.equal(h.state.local.resumeDocumentsV1[state.activeTemplateId].markdown,markdown);
  const converted = h.api.profileToMarkdown({custom:{zero:0,flag:false}});
  assert.match(converted,/zero：0/); assert.match(converted,/flag：false/);
});

test("multiple documents can be copied, switched, renamed and exported independently",async()=>{
  const h = harness(); let state = await h.api.loadTemplateState(h.storage);
  await h.api.saveTemplateContent(state.activeTemplateId,{markdown:"A"},h.storage);
  const copy = await h.api.duplicateTemplate(state.activeTemplateId,h.storage);
  await h.api.setActiveTemplateId(copy.id,h.storage);
  await h.api.renameTemplate(copy.id,"新名称",h.storage);
  await h.api.saveTemplateContent(copy.id,{markdown:"B"},h.storage);
  const exported = await h.api.exportTemplateData(h.storage);
  assert.equal(exported.version,2); assert.equal(exported.activeTemplateId,copy.id);
  assert.equal(exported.templates[0].markdown,"A"); assert.equal(exported.templates[1].markdown,"B");
  const h2 = harness(); await h2.api.importTemplateData(JSON.parse(JSON.stringify(exported)),h2.storage);
  const active = await h2.api.exportActiveTemplateData(h2.storage);
  assert.equal(active.name,"新名称"); assert.equal(active.markdown,"B");
  await h.api.deleteTemplate(copy.id,h.storage);
  state = await h.api.loadTemplateState(h.storage);
  assert.equal(state.templates.length,1); assert.equal(state.templates[0].markdown,"A");
});

test("old JSON imports convert unknown fields and back up existing documents",async()=>{
  const h = harness(); const state = await h.api.loadTemplateState(h.storage);
  await h.api.saveTemplateContent(state.activeTemplateId,{markdown:"原有内容"},h.storage);
  await h.api.importTemplateData({templates:[{id:"legacy",profile:{anything:"任意信息"},rawText:"原文"}]},h.storage);
  assert.equal(h.state.local.resumeDocumentsImportBackupV1.templates[0].markdown,"原有内容");
  assert.match((await h.api.exportActiveTemplateData(h.storage)).markdown,/任意信息/);
  await h.api.importActiveTemplateData({profile:{extra:"单份旧数据"}},h.storage);
  assert.match((await h.api.exportActiveTemplateData(h.storage)).markdown,/单份旧数据/);
});

test("invalid imports and saves do not silently erase existing information",async()=>{
  const h = harness(); const state = await h.api.loadTemplateState(h.storage);
  await h.api.saveTemplateContent(state.activeTemplateId,{markdown:"保留资料"},h.storage);
  await assert.rejects(h.api.importTemplateData({templates:[{unexpected:true}]},h.storage),/没有有效资料/);
  await assert.rejects(h.api.saveTemplateContent(state.activeTemplateId,{profile:{}},h.storage),/Markdown/);
  assert.equal((await h.api.exportActiveTemplateData(h.storage)).markdown,"保留资料");
});


test("Web Locks serialize simultaneous document mutations across editor contexts",async()=>{
  const queues=new Map();
  const locks={request(name,fn){const next=(queues.get(name)||Promise.resolve()).then(fn);queues.set(name,next.catch(()=>{}));return next;}};
  const h=harness({locks}), other=harness({locks});
  await h.api.loadTemplateState(h.storage);
  await Promise.all([h.api.createTemplate("A",h.storage),other.api.createTemplate("B",h.storage)]);
  const result=await h.api.loadTemplateState(h.storage);
  assert.equal(result.templates.length,3);
  assert.ok(result.templates.some((t)=>t.name === "A"));assert.ok(result.templates.some((t)=>t.name === "B"));
});
