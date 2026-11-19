const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function editorHarness() {
  const elements = new Map();
  function element(id = "") {
    const handlers = {};
    return { id, value:"", textContent:"", disabled:false, dataset:{}, files:[],
      classList:{add(){},remove(){}}, focus(){},click(){},
      replaceChildren(...children){this.children=children;},
      addEventListener(type,fn){handlers[type]=fn;},
      async emit(type,extra={}) { return handlers[type]?.({target:this,...extra}); },
    };
  }
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element(id));return elements.get(id);},createElement(){return element();}};
  let templates=[{id:"a",name:"资料A",markdown:"# A\n原始内容"},{id:"b",name:"资料B",markdown:"# B"}], activeTemplateId="a";
  const saves=[], downloads=[], listeners=[];
  const storage={keys:{templates:"docs",activeTemplateId:"active"},
    async loadTemplateState(){return structuredClone({templates,activeTemplateId});},
    async saveTemplateContent(id,{markdown}){saves.push({id,markdown});templates.find((t)=>t.id===id).markdown=markdown;},
    async setActiveTemplateId(id){activeTemplateId=id;},
    async duplicateTemplate(id){const source=templates.find((t)=>t.id===id);const copy={...source,id:"copy",name:"copy"};templates.push(copy);return copy;},
  };
  const window={ResumeStorage:storage,confirm:()=>true,addEventListener(){}};
  const context={window,document,chrome:{storage:{onChanged:{addListener(fn){listeners.push(fn);}}}},
    URL:{createObjectURL(blob){downloads.push(blob);return "blob:test";},revokeObjectURL(){}},Blob,setTimeout(){}};
  vm.createContext(context);vm.runInContext(fs.readFileSync("shared/document-editor.js","utf8"),context);
  const editor=window.ResumeDocumentEditor.create();await editor.ready;
  return {editor,el:(id)=>document.getElementById(id),saves,downloads,listeners,changeExternal(markdown){templates[0].markdown=markdown;}};
}

test("Markdown editor preserves flexible dates and arbitrary content without schema controls",async()=>{
 const h=await editorHarness();const input=h.el("markdownEditor");
 const markdown="# 未预设的信息\n导师：王老师\n时间：2025-06\n<script>不执行</script>\n  ";
 input.value=markdown;await input.emit("input");await h.editor.save();
 assert.equal(h.saves[0].markdown,markdown);assert.equal(input.value,markdown);
 assert.equal(h.el("saveResumeBtn").disabled,true);
});

test("switching and duplicating save edits before changing documents",async()=>{
 const h=await editorHarness();h.el("markdownEditor").value="修改A";await h.el("markdownEditor").emit("input");
 h.el("resumeTemplateSelect").value="b";await h.el("resumeTemplateSelect").emit("change");
 assert.equal(h.saves[0].id,"a");assert.equal(h.saves[0].markdown,"修改A");assert.equal(h.editor.getMarkdown(),"# B");
 await h.el("duplicateTemplateBtn").emit("click");assert.equal(h.editor.getActiveId(),"copy");assert.equal(h.editor.getMarkdown(),"# B");
});

test("Markdown import requires save and export produces the exact document text",async()=>{
 const h=await editorHarness();const input=h.el("importResumeJsonFile");
 input.files=[{name:"个人.md",async text(){return "# 自定义\n完整资料";}}];await input.emit("change");
 assert.equal(h.saves.length,0);assert.equal(h.editor.getMarkdown(),"# 自定义\n完整资料");
 await h.el("exportResumeJsonBtn").emit("click");
 assert.equal(h.saves.length,1);assert.equal(await h.downloads[0].text(),"# 自定义\n完整资料");
});

test("external edits never overwrite dirty text and busy views refresh when released",async()=>{
 const h=await editorHarness();h.el("markdownEditor").value="未保存";await h.el("markdownEditor").emit("input");
 h.changeExternal("外部变更");h.listeners[0]({docs:{}},"local");
 assert.equal(h.editor.getMarkdown(),"未保存");assert.match(h.el("documentStatus").textContent,/未保存/);
 await h.editor.save();h.editor.setBusy(true);h.changeExternal("新外部内容");h.listeners[0]({docs:{}},"local");
 assert.equal(h.editor.getMarkdown(),"未保存");h.editor.setBusy(false);await new Promise(setImmediate);
 assert.equal(h.editor.getMarkdown(),"新外部内容");
});
