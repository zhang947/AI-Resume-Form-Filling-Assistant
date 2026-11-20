> 后续更新：字段资料已按新的空白起步要求改为动态资料库，首次加载清空旧资料，显式 Markdown 解析改为预览后合并保存；详见 [动态资料库](CUSTOM_FIELDS.md)。下文记录最初功能移植的边界，旧固定结构与替换式转换不再适用。

# Markdown＋AI 可选功能移植

## 基线核对

- `76c052d`：包含结构化字段库、独立编辑器、多模板 CRUD、整库及单份 JSON 导入导出、模型配置、文本／Markdown／PDF 转字段、字段映射缓存和整页／增量／选区填写。
- `6d34d30`：将字段资料改为 Markdown，替换了存储、编辑器和填写链路，相对原版删除约 4,814 行；此次不合并该提交。
- 此分支直接基于 `76c052d`，只移植其独立的全表答案规划思路及校验模块。原目录保持在 `6d34d30`，未执行 reset、clean 或推送。
- 原仓库的 `.git` 只读，不能登记工作树；在 `agent-workspace/optional-markdown-ai` 建立独立 Git 仓库，保留原历史对象，并创建 `feat/optional-markdown-ai` 分支。

## 初次 Markdown 移植的保留范围（bcb0204）

以下核心文件与原版一致：`shared/resume-schema.js`、`shared/resume-storage.js`、`shared/model-storage.js`、`shared/resume-prompts.js`、`resume-editor.html/js/css`、模板管理界面及 `modules/`。原有测试文件全部保留。后续的[自定义信息功能](CUSTOM_FIELDS.md)在此基础上扩展了字段目录和编辑器。

默认仍走 `resumeProfile → field_mapping → resumePath → 原控件填写`，映射缓存继续使用原键。原来的选区填写仍可在固定字段模式使用。没有将字段库转换为 Markdown，也没有新增选区功能。

## 使用方式

1. 在 Chrome／Edge 的扩展开发者模式中加载此目录；更新后刷新已有表单页，避免旧内容脚本继续运行。
2. 默认使用“原有固定字段模式”。字段编辑、原 Markdown 识别、JSON 备份、多模板和模型配置按原方式使用。
3. 在“简历资料”页为当前模板编辑或导入 Markdown，点击“保存 Markdown”；可单独导出 `.md`。未保存的当前编辑内容也可用于填写。
4. 在“自动填充”页切换到“Markdown＋AI 模式”，使用整页或增量填写。Markdown 会发送到已配置的模型接口。
5. 缺失信息、保护项、生成内容与验证失败会显示在结果列表。自行核对，手动提交表单。
6. 如需从 Markdown 更新字段库，点击“AI 转为字段（预览）”，核对 JSON 后点击“确认替换当前模板字段”。仅这一显式确认会写入字段库；转换期间字段发生变化会拒绝覆盖。

两个资料表示通过当前模板 ID 关联。Markdown 使用独立的 `resumeMarkdownDocumentsV1` 键，不读写字段库或旧键，也不自动同步或转换。原 JSON 备份格式保持不变；Markdown 通过 `.md` 单独导入导出。切换模板时保留未保存的 Markdown 草稿，关闭窗口前会提醒保存。

## 新模块边界

| 文件 | 职责 |
| --- | --- |
| `shared/markdown-storage.js` | 按模板 ID 保存独立 Markdown，无迁移及清理逻辑 |
| `shared/markdown-editor.js` | 编辑、保存、导入导出、草稿及显式转换入口 |
| `shared/form-plan.js` | 模型提示词、完整资料及全表字段载荷、来源／引用／类型／约束校验 |
| `shared/markdown-fill.js` | 全表规划后填写、增量保护、逐项及整表复核，无资料写入 |
| `shared/markdown-controls.js` | 严格候选匹配、异步候选等待、控件适配和结果验证 |

现有文件只添加接入点：`background.js` 在原模型网关增加 `field_values` 模式；`content.js` 根据显式 `fillMethod` 分流，复用扫描、展开、写值、事件及日志；`popup.html/js` 增加模式切换、独立编辑区、转换预览和结果展示。

Markdown 模式先扫描整页所有表单字段，再请求并校验全表目标值，随后才进行下拉搜索及写入，最后复核整表。自定义下拉要求可识别的 `combobox` 和通过 `aria-controls`／`aria-owns` 关联的候选列表；候选超时、模糊或重复时报告失败，不选择相近项。未识别的特殊控件需手动处理。

增量保护同时检查初始内容、AI 返回后的当前内容，以及等待期间的可信用户编辑事件，包括修改后清空；下拉候选确认前再次检查。后续联动导致前面字段被清空时，整表复核会标记失败。不会自动将生成答案保存到任何资料，也不会点击提交按钮。

## 验证

- `npm test`：保留原有 70 项测试，新增模式、资料隔离、模型网关、先规划后搜索、缺失事实与意愿、描述生成、异步候选、增量保护、转换预览及整表复核测试。
- 所有应用与共享模块通过 `node --check`；`git diff --check` 无空白错误。
- 将测试命令改为 `node --test tests`，解决 Windows／Node 20 不展开 `tests/*.js` 的问题；`.gitattributes` 固定 `content.js` 为 LF，兼容原有代码片段提取测试。
- `tests/fixtures/markdown-browser-smoke.html` 为本地模拟表单，无真实资料或模型请求，用于手动浏览器联调。浏览器安全策略阻止自动打开本地文件，因此未完成浏览器级联调；未访问真实招聘网站或验证真实模型输出。
