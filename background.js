importScripts("shared/resume-storage.js");
globalThis.ResumeStorage?.loadTemplateState().catch((error) => console.error("[library-init]", error));
// Background Service Worker
// 统一代理调用 OpenAI 兼容接口（如 DeepSeek），避免侧边栏/内容脚本的 CORS 问题。

importScripts("shared/model-storage.js", "shared/form-plan.js", "shared/selection-lookup-registration.js");

globalThis.ResumeLookupRegistration?.install(chrome);

// 初始化：点击扩展图标时打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action !== "callAI") return;
  if (sender?.id && sender.id !== chrome.runtime.id) return;

  const mode = request.mode || "resume_import";
  callAI(request.modelId, request.prompt, mode)
    .then((response) => sendResponse({ success: true, data: response }))
    .catch((error) =>
      sendResponse({ success: false, error: error?.message || String(error), code: error?.code })
    );

  return true; // 保持消息通道，用于异步响应
});

async function callAI(modelId, prompt, mode) {
  const modelStorage = globalThis.ResumeModelStorage;
  if (!modelStorage) {
    throw new Error("模型配置模块未加载，请重新加载扩展");
  }

  const config = await modelStorage.getModelConfig(modelId);
  const { baseUrl, apiKey, model } = config || {};

  if (!baseUrl || !apiKey || !model) {
    throw new Error("模型配置不完整：请检查 Base URL / API Key / 模型ID");
  }

  const url = buildApiUrl(baseUrl);
  const normalizedModel = String(model).trim();
  if (!url.endsWith("/chat/completions")) {
    throw new Error("Base URL 必须指向 API 根路径或 /chat/completions");
  }

  const systemPrompts = {
    field_values: globalThis.ResumeFormPlan.SYSTEM_PROMPT,
    resume_import: `你是资料提取助手。根据用户 Markdown 动态建立分组、条目和字段，不受固定简历模板限制。只提取明确信息，不编造事实或意愿，不填缺失信息；保留完整文本和换行。只输出紧凑 JSON，不重复输出原文作为 evidence；仅日期格式转换时需要单个原始日期 evidence。`,

    field_mapping: `你是一个“网页表单字段映射助手”。

你将收到一个 JSON，包含：
- fields：当前页面识别到的表单字段
- fields 中的单个 field 可能额外带有 sectionKey、sectionLabel、sectionEvidence、nearbyLabels，用于表示扫描阶段推断出的区块和邻近标签
- resumeFields：用户实际保存的动态资料字段目录（含 path、label、sectionLabel、itemLabel、hasValue、valuePreview 等）

你的任务：
1) 为每个页面 field 选择最合适的 resumePath
2) 只做“字段映射”，不要生成最终填写值；groups.* 是用户保存的动态字段，综合 label、aliases、itemLabel 判断，只使用已存在的路径
3) 若字段需要简单转换，可返回 transform
4) 若没有合适字段，resumePath 返回空字符串
5) 只输出 JSON（不要输出其它文本，不要 Markdown 代码块）

映射原则：
1) 优先综合 field 的 label、context、options、sectionLabel、sectionEvidence、nearbyLabels、所在区块语义，与 resumeFields 的 label、sectionLabel、itemLabel、path、valuePreview 一起判断
2) 当多个候选语义接近时，优先选择 sectionLabel / itemLabel 更一致、且 hasValue=true 的 resumePath
3) 对同一区块内重复出现的“起止时间”字段，通常前一个映射开始时间，后一个映射结束时间
4) 如果 field.label 为空但 sectionLabel / nearbyLabels 不为空，必须充分利用这些扫描线索，不要把它当成完全无信息字段

不同分组和条目可以使用任意名称；不得假定固定分类或路径。结合分组、条目名称和别名区分同名字段。

保守规则：
1) 如果页面字段只是状态性复选框，例如“没有实习经历”“无实习经历”“暂无项目经历”，只有在 resumeFields 中存在明确语义等价的布尔字段时才映射；否则返回空字符串
2) 不要仅因为字段都出现在同一块区域，就映射到无关分组或条目
3) 没有足够语义证据时，宁可不映射，也不要勉强猜测

输出格式（严格遵守）：
{
  "mappings": [
    {
      "fieldId": "f_1",
      "resumePath": "groups.g-example.items.i-example.fields.f-example.value",
      "reason": "该字段是邮箱",
      "transform": { "type": "none" }
    }
  ]
}

允许的 transform：
- { "type": "none" }
- { "type": "date_part", "part": "year" | "month" | "day" }
- { "type": "phone_part", "part": "countryCode" | "nationalNumber" }
- { "type": "boolean_choice", "trueValue": "...", "falseValue": "..." }
- { "type": "join", "separator": ", " }

不要返回未列出的 transform。`,
  };

  const system = systemPrompts[mode];
  if (!system) {
    throw new Error(`不支持的 AI 模式：${mode}`);
  }

  const timeoutMs = 120_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: normalizedModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: String(prompt || "") },
        ],
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("API 请求超时：请检查网络/Key/模型是否可用后重试");
    }
    throw new Error(`网络请求失败：${err?.message || String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `API 请求失败 (${response.status})`;

    try {
      const errorJson = JSON.parse(errorText);
      const msg = errorJson?.error?.message || errorJson?.message || "";
      if (response.status === 401) {
        errorMsg = "API Key 无效，请检查配置";
      } else if (response.status === 403) {
        errorMsg = "API 访问被拒绝，请检查 Key/权限/余额";
      } else if (response.status === 429) {
        errorMsg = "API 请求过于频繁，请稍后重试";
      } else if ([500, 502, 503].includes(response.status)) {
        errorMsg = "API 服务暂时不可用，请稍后重试";
      } else if (msg) {
        errorMsg = `API 错误：${msg}`;
      }
    } catch (_) {
      // ignore
    }

    console.error("[简历填表助手] API 请求失败:", {
      status: response.status,
      url: sanitizeUrlForLog(url),
      response: redactAndTruncate(errorText),
    });
    throw new Error(errorMsg);
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error("API 返回不是有效 JSON");
  }
  const choice = data?.choices?.[0];
  if (["length", "max_tokens"].includes(choice?.finish_reason)) {
    const error = new Error("AI 输出达到长度上限，返回内容被截断，未保存任何解析结果");
    error.code = "AI_OUTPUT_TRUNCATED";
    throw error;
  }
  if (choice?.finish_reason === "content_filter") throw new Error("AI 服务未返回完整内容，请调整资料后重试");
  const content = choice?.message?.content;
  if (!content) {
    throw new Error("API 返回格式错误：缺少 choices[0].message.content");
  }
  return content;
}

function buildApiUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || "").trim());
  } catch (_) {
    throw new Error("Base URL 不是有效地址");
  }

  const isLocalDevelopmentHost = ["localhost", "127.0.0.1", "::1"].includes(
    parsed.hostname
  );
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalDevelopmentHost)) {
    throw new Error("Base URL 必须使用 HTTPS（本机开发地址可使用 HTTP）");
  }

  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/chat/completions")
    ? path
    : `${path || ""}/chat/completions`;
  return parsed.toString().replace(/\/$/, "");
}

function sanitizeUrlForLog(value) {
  try {
    const parsed = new URL(String(value || ""));
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return "[invalid-url]";
  }
}

function redactAndTruncate(value, maxLength = 500) {
  return String(value || "")
    .replace(/(authorization|api[-_ ]?key|token|password|secret)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]")
    .slice(0, maxLength);
}
