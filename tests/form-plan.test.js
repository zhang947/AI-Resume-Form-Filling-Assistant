const test = require("node:test");
const assert = require("node:assert/strict");
const plan = require("../shared/form-plan.js");

test("arbitrary factual fields, descriptions and missing facts receive distinct results", () => {
  const markdown = "导师：王老师。使用 JavaScript 开发了浏览器插件。";
  const fields = [{fieldId:"mentor",kind:"text",label:"导师"}, {fieldId:"summary",kind:"textarea",label:"自我评价"}, {fieldId:"id",kind:"text",label:"证件号码"}];
  const answers = plan.normalizeAnswers([
    {fieldId:"mentor",source:"extracted",value:"王老师",evidence:["导师：王老师"]},
    {fieldId:"summary",source:"generated",value:"具备 JavaScript 浏览器插件开发经验。",evidence:["使用 JavaScript 开发了浏览器插件"]},
    {fieldId:"id",source:"missing",value:null,reason:"请补充证件号码"},
  ], fields, markdown);
  assert.deepEqual(answers.map((a)=>a.source),["extracted","generated","missing"]);
  assert.equal(answers[2].value,null);
});

test("unknown is not no, and generated preferences cannot be filled", () => {
  const fields = [{fieldId:"f",kind:"radio_group",label:"无实习经历",options:["是","否"]}];
  const result = plan.normalizeAnswers([{fieldId:"f",source:"generated",value:"是",evidence:["本科在读"]}],fields,"本科在读");
  assert.equal(result[0].source,"missing");
  assert.equal(plan.isDescriptive({kind:"textarea",label:"期望薪资说明"}),false);
});

test("native value types and complete option membership are validated", () => {
  assert.match(plan.validateValue({kind:"text"}, {x:1}),/有效/);
  assert.match(plan.validateValue({kind:"text"}, ["A"]),/类型/);
  assert.match(plan.validateValue({kind:"select",options:["A"]},"B"),/可选项/);
  assert.equal(plan.validateValue({kind:"checkbox_group",options:["Java","JavaScript"]},["JavaScript"]),"");
  assert.equal(plan.validateValue({kind:"text"},0),"");
  assert.equal(plan.validateValue({kind:"text"},false),"");
});

test("length, numeric range, step, email, URL and date precision constraints are enforced", () => {
  for (const [field,value] of [
    [{maxLength:2},"abc"], [{minLength:3},"ab"], [{inputType:"number",min:"1"},"0"],
    [{inputType:"number",max:"5"},"6"], [{inputType:"number",step:"0.5"},"1.2"],
    [{inputType:"email"},"bad"], [{inputType:"url"},"javascript:alert(1)"],
    [{inputType:"date"},"2026-11"], [{inputType:"month"},"2026"]
  ]) assert.notEqual(plan.validateValue(field,value),"",JSON.stringify({field,value}));
  assert.equal(plan.validateValue({inputType:"number",step:"any"},"1.2"),"");
});

test("factual formatting transformations retain evidence and invented numbers are rejected", () => {
  const field={fieldId:"f",kind:"text",label:"入学日期"};
  assert.equal(plan.normalizeAnswers([{fieldId:"f",value:"2020-09",source:"extracted",evidence:["2020年09月"]}],[field],"2020年09月")[0].source,"extracted");
  assert.equal(plan.normalizeAnswers([{fieldId:"f",value:"2020-09-01",source:"derived",evidence:["2020年09月"]}],[field],"2020年09月")[0].source,"missing");
  assert.equal(plan.normalizeAnswers([{fieldId:"f",value:"提升效率50%",source:"generated",evidence:["参与项目"]}],[{...field,kind:"textarea",label:"项目描述"}],"参与项目")[0].source,"missing");
});
