const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../shared/form-plan.js");

test("payload includes arbitrary Markdown and complete field constraints without a resume catalog",()=>{
 const markdown="# 自定义\n- 导师：王老师\n- 游戏经验：星际争霸";
 const fields=[{fieldId:"f1",label:"导师",maxLength:30,pattern:".*",options:Array.from({length:100},(_,i)=>`选项${i}`)}];
 const result=plan.buildPayload(fields,markdown,{url:"https://example.com"});
 assert.equal(result.markdown,markdown); assert.equal(result.fields,fields);
 assert.equal(result.fields[0].options.length,100); assert.equal("resumeFields" in result,false);
 assert.match(result.date,/^\d{4}-\d{2}-\d{2}$/);
});

test("documents are never silently truncated",()=>{
 assert.throws(()=>plan.buildPayload([],"x".repeat(plan.MAX_MARKDOWN_LENGTH+1)),/不会截断/);
 assert.throws(()=>plan.buildPayload([],"  "),/先填写/);
});
