"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const editor = window.ResumeDocumentEditor.create();
  editor.ready.catch((error) => {
    document.getElementById("documentStatus").textContent = `资料加载失败：${error.message}`;
  });
});
