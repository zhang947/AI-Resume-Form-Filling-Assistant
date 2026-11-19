const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const formPlan = require("../shared/form-plan.js");

function setup(fields, responder, existing = {}) {
  const source = fs.readFileSync("content.js","utf8");
  const snippet = source.slice(source.indexOf("  async function handleStartFill("),source.indexOf("  function normalizeDeepScanText("));
  const calls = [], logs = [], writes = [];
  const runtimes = fields.map((field)=>({fieldId:field.fieldId,kind:field.kind,el:{value:existing[field.fieldId] || "",isConnected:true,getAttribute(){return null;}}}));
  const context = { formPlan, calls, logs, writes, runtimes, fields,
    location:{href:"https://example.com/form?secret=1#part"},document:{title:"表单"},
    async triggerExpandableSections() { calls.push({expand:true}); },
    async requestSelectionRect() { return {left:1,top:1,width:100,height:100}; },
    scanFields(options) { calls.push({scan:options}); return {fields,runtime:runtimes}; },
    aiClient:{async callAI(model,prompt,mode) { const data=JSON.parse(prompt); calls.push({model,data,mode}); return JSON.stringify(await responder(data,runtimes)); }},
    hasExistingFieldValue(runtime) { return Boolean(runtime.el.value); },
    async fillOne(runtime,value) { writes.push({fieldId:runtime.fieldId,value}); runtime.el.value=value; return {filled:true}; },
    sendLog(level,text) { logs.push({level,text}); },sendStats() {},
    sanitizePageUrl(value) { return value.split(/[?#]/)[0]; },
  };
  vm.createContext(context);
  vm.runInContext(`let isWorking=false,lastFieldCount=0,lastMappedCount=0,lastFilledCount=0;const fieldRuntimeMap=new Map();${snippet}`,context);
  return {run:context.handleStartFill,calls,logs,writes,runtimes};
}

test("Markdown -> answers -> local fill supports arbitrary information and reports missing facts",async()=>{
  const fields=[{fieldId:"f1",kind:"text",label:"导师"},{fieldId:"f2",kind:"textarea",label:"自我评价"},{fieldId:"f3",kind:"text",label:"身份证"}];
  const h=setup(fields,()=>({answers:[
    {fieldId:"f1",source:"extracted",value:"王老师",evidence:["导师王老师"]},
    {fieldId:"f2",source:"generated",value:"具备开发经验",evidence:["开发插件"]},
    {fieldId:"f3",source:"missing",value:null,reason:"请补充身份证"}]}));
  const result=await h.run("model","导师王老师，开发插件",{});
  assert.equal(result.success,true,JSON.stringify(result)); assert.equal(result.filledCount,2);
  assert.deepEqual(Array.from(result.report,(r)=>r.status),["filled","generated","missing"]);
  const request=h.calls.find((call)=>call.mode);
  assert.equal(request.mode,"field_values"); assert.equal(request.data.url,"https://example.com/form");
  assert.equal("resumeFields" in request.data,false);
  assert.equal(JSON.stringify(h.logs).includes("王老师"),false);
});

test("incremental mode excludes existing values and protects edits made during the AI request",async()=>{
  const fields=[{fieldId:"a",kind:"text",label:"A"},{fieldId:"b",kind:"text",label:"B"}];
  const h=setup(fields,(data,runtimes)=>{
    assert.deepEqual(data.fields.map((f)=>f.fieldId),["b"]);
    runtimes[1].el.value="用户刚输入";
    return {answers:[{fieldId:"b",source:"extracted",value:"资料值",evidence:["资料值"]}]};
  },{a:"原有值"});
  const result=await h.run("model","资料值",{fillMode:"incremental"});
  assert.equal(result.success,true,JSON.stringify(result)); assert.equal(h.writes.length,0);
  assert.ok(result.report.every((r)=>r.status === "skipped"));
});

test("selection mode limits the scan and never expands the page",async()=>{
  const h=setup([{fieldId:"f",kind:"text",label:"任意字段"}],()=>({answers:[{fieldId:"f",source:"extracted",value:"信息",evidence:["信息"]}]}));
  const result=await h.run("model","信息",{scope:"selection"});
  assert.equal(result.filledCount,1,JSON.stringify(result)); assert.equal(h.calls.some((call)=>call.expand),false);
  assert.equal(h.calls.find((call)=>call.scan).scan.scope,"selection");
});

test("a changed document always triggers a new model request with its current contents",async()=>{
  const h=setup([{fieldId:"f",kind:"text",label:"任意字段"}],(data)=>({answers:[{fieldId:"f",source:"extracted",value:data.markdown,evidence:[data.markdown]}]}));
  await h.run("model","资料A",{}); await h.run("model","资料B",{});
  assert.deepEqual(h.calls.filter((call)=>call.mode).map((call)=>call.data.markdown),["资料A","资料B"]);
  assert.equal(h.writes[1].value,"资料B");
});

test("malformed AI responses do not write any field and subsequent attempts can run",async()=>{
  const h=setup([{fieldId:"f",kind:"text",label:"任意字段"}],()=>({bad:true}));
  for(let i=0;i<2;i++) assert.equal((await h.run("model","资料",{})).success,false);
  assert.equal(h.writes.length,0);
});
