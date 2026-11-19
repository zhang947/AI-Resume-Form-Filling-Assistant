const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../shared/form-plan.js");
test("switching or editing documents always produces a payload with current content",()=>{
 const fields=[{fieldId:"f1",label:"新信息"}];
 assert.equal(plan.buildPayload(fields,"资料A").markdown,"资料A");
 assert.equal(plan.buildPayload(fields,"资料B").markdown,"资料B");
 assert.equal(plan.buildPayload(fields,"资料A的修改").markdown,"资料A的修改");
});
