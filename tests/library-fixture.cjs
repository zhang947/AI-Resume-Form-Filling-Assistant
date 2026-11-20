const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function loadSchema() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shared/resume-schema.js'), 'utf8'), context);
  return context.window.ResumeSchema;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
function profileFor(fields, { group = '自主资料', item = '我的条目' } = {}) {
  return plain(loadSchema().normalizeResumeProfile({ groups: [{ name: group, items: [{ name: item, fields }] }] }));
}
module.exports = { loadSchema, plain, profileFor };
