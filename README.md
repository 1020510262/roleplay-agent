# Roleplay Agent（拾光）

私有的角色扮演 agent 应用：单页 Web 界面 + 角色扮演 agent，基于 [pi](https://github.com/earendil-works/pi)（`pi-agent-core` / `pi-ai` / `pi-coding-agent`）的 **SDK 模式**嵌入，Postgres 存储人设 / 长期记忆 / 场景状态 / 会话日志。

## 架构

```
            ┌──────────────────────────── 单轮对话流程 ────────────────────────────┐
 Web 前端 ──▶ POST /api/sessions/:id/messages (SSE 流)
            │   用户输入 → 清洗(输入守卫) → 检索长期记忆/世界观(关键词评分)
            │   → 组装动态块(场景+记忆+纠正提示; before_agent_start 钩子)
            │   → pi agent loop(可调用 3 个 Extension 工具)
            │   → 消息落库 → 分离式后台任务(轮末抽取 / 每20轮角色核查)
            └──▶ 流式返回 + 场景状态
```

### 三层记忆架构

| 层 | 载体 | 注入方式 |
|---|---|---|
| ① 核心人设 | 结构化 YAML（`data/personas/*.yaml`）→ `persona` 表 | 会话创建时渲染为 system prompt，**恒定不变** |
| ② 长期剧情记忆 | `memory_summaries` 表（事件/关系/伏笔/事实 + 实体/标签/重要度） | 每轮按当前用户输入**检索式注入** top-K（关键词 + 实体/标签重叠评分），不整库塞入 |
| ③ 当前场景状态 | `scene_state` 表（地点/时间/情绪/进行中事件/好感度） | 每轮动态拼接入动态块，`update_scene_state` 工具实时更新 |

上下文压缩保护：`session_before_compact` 钩子在 pi 压缩前，先把即将被丢弃的对话**抽取摘要入库**（`source='compaction'`），再走默认压缩。

### 分离式（独立线程）调用

轮末记忆抽取、压缩前抽取、每 N 轮角色核查，全部通过 `modelRuntime.complete()` 独立调用——**不进入 pi 会话上下文**，主对话线程零污染。

## 目录结构

```
src/
├── agent/            # agent 逻辑层
│   ├── runtime.ts        # ModelRuntime + 自定义 provider（阿里云 MaaS / DeepSeek）
│   ├── session.ts        # pi SDK 嵌入（AgentSession 工厂 + before_agent_start 动态块）
│   ├── orchestrator.ts   # 单轮对话流水线 + 会话池 + 事件流
│   ├── prompt-builder.ts # 动态块组装（场景/记忆/纠正提示）
│   ├── retrieval.ts      # 检索式记忆注入（关键词评分）
│   ├── extraction.ts     # 分离式抽取（轮末 + 压缩前）
│   ├── consistency-check.ts # 每 N 轮角色核查（分离式）
│   └── persona*.ts       # 人设结构 + 校验 + 核心 prompt 渲染
├── extensions/       # pi Extension 工具
│   ├── worldbook.tool.ts  # query_worldbook  检索世界观
│   ├── memory.tool.ts     # save_memory_summary 写长期记忆
│   └── scene.tool.ts      # update_scene_state 更新场景/情绪/好感度
├── db/               # 数据库访问层（全部参数化查询）
├── security/         # 输入守卫 / 工具参数深度校验 / token 鉴权(HTTP-only cookie)
└── web/              # Express + SSE + 前端（textContent 渲染，防 XSS）
```

## 多角色共存

- **角色即数据**：每个角色是一个结构化 YAML（`data/personas/<id>.yaml`），会话按 `persona_id` 隔离，互不干扰。
- **页面动态展示**：顶栏角色名、页面标题、场景芯片、消息气泡、场景面板全部随当前会话的角色动态切换。
- **新剧情弹窗**：点「新剧情」→ 选择已有角色开始，或填表创建全新角色，创建后立即开新剧情。创建表单为**三标签页**：
  - **扮演角色**：角色名/身份/外貌/性格/语言风格/行为边界/与玩家关系（次要项收在「更多设定」里）
  - **玩家角色**：称呼/身份/性格特点/背景经历——让角色知道玩家是谁（**不含语言风格**，玩家话语由玩家自己掌控）
  - **世界观**：世界观背景 + 初始地点/时间/情绪
  - 对应 PersonaDoc 新增 `player`（玩家角色）与 `world`（世界观）两个可选节，均经服务端校验。
- **切换与删除**：顶部下拉切换任意剧情；「删除」按钮移除当前剧情（含 pi 会话文件与记忆）。
- 默认角色由 `.env` 的 `DEFAULT_PERSONA` 指定；若该角色文件不存在，自动回退到第一个可用角色并告警。
- 角色创建、会话创建均经服务端 schema 校验（`persona-io.ts` / `tool-validation.ts`），非法字段直接拒绝。

## 快速开始

```bash
npm install
npm run build
cp .env.example .env        # 填入模型 key / DB 密码 / APP_TOKEN
node scripts/init-db.mjs    # 建表 + pg_trgm
node scripts/seed-worldbook.mjs  # 世界观种子数据
npm run dev                 # http://127.0.0.1:3000
```

> 提示：`seed-worldbook.mjs` 的种子条目是林晚晴专用世界观；新创建的角色如需世界观检索，可在 `worldbook` 表补充对应条目（或直接用 `query_worldbook` 工具按需校验设定）。

### 测试

```bash
npm run smoke                 # 阶段 1/2：SDK 最小 agent loop（CLI，不接 DB）
node test/chat-cli.mjs --turns "你好"   # 阶段 3：全链路（DB+工具+抽取）
node test/tools.mjs           # 工具参数校验（含恶意参数）
node test/security.mjs        # 输入守卫 / XSS 转义 / SQL 注入安全
```

## 安全设计

- **Prompt injection**：用户输入只作为 `user` message 进入 pi，绝不拼入 system prompt；系统提示中显式要求忽略玩家消息里的"出戏指令"；工具 schema（TypeBox）+ 深度校验双保险。
- **结构化输出校验**：`save_memory_summary` / `update_scene_state` 入库前经类型/长度/字段白名单/值域校验（`security/tool-validation.ts`），控制字符清洗，clamp 到合法范围。
- **XSS**：前端全部 `textContent`/`createElement` 渲染，无 `innerHTML`；服务端另有 `escapeHtml` 兜底。
- **SQL 注入**：全部参数化查询；检索关键词仅作为 ILIKE 参数。
- **鉴权**：单用户 `APP_TOKEN` + HttpOnly/SameSite cookie 登录，timing-safe 比较，`/api` 与 `/chat.html` 全部在门禁后。

## 配置（.env）

| 变量 | 说明 |
|---|---|
| `ALIYUN_MAAS_API_KEY` | 模型 API key（OpenAI 兼容端点） |
| `MODEL_PROVIDER` / `MODEL_ID` | 默认 `aliyun-maas` / `deepseek-v4-flash-0731` |
| `PGHOST` … `PGPASSWORD` | Postgres |
| `APP_TOKEN` | 登录令牌 |
| `CHECK_EVERY_TURNS` | 角色核查间隔（默认 20） |
| `EXTRACT_EVERY_TURN` | 是否每轮做分离式抽取（默认 true） |

模型 catalog 在 `data/models.json`（`openai-completions` 协议 + 100 万上下文窗口）。