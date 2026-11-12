# 交接文档

> 写给下一个接手这个项目的 agent / 工程师。
> 目标：30 分钟内能跑起来、看懂结构、知道哪里容易踩坑、下一步该做什么。

---

## 1. 这是什么

**Step Coding** 是一个"看得见过程的 AI 编码演示器"。

用户说一句话（"写个登录页" / "改深色背景" / "讲讲中间件怎么串"），
模型**一步一步**调用工具把东西做出来：想 → 看 → 搜 → 计划 → 写文件 → 自检。
右边的时间线把每一步都摊开，中间是真实的代码，左侧是当前项目文件。

**它不是 IDE**：没有编辑、没有多标签编辑、没有 LSP。
**它默认不碰用户磁盘**：文件在浏览器内存里，只有点「导出代码」才会下载 zip。

产品定位上的取舍（重要，改代码前先读）：

- 核心资产是**过程可见**，不是功能多。任何让"过程"变黑箱的改动都要慎重。
- 小项目演示优先：不引入构建工具、框架、多目录工程。
- 一次只做一个动作，宁可多轮调用，也不要"一轮出全套"。

---

## 2. 十分钟跑起来

```bash
cd step-coding

# 后端
python3 -m venv .venv
.venv/bin/pip install fastapi "uvicorn[standard]"
cp .env.example .env          # 填 DEEPSEEK_API_KEY
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8790

# 前端（另开一个终端）
cd web && pnpm install && pnpm build     # build 会先跑 tsc --noEmit
```

打开 http://127.0.0.1:8790 。

改前端代码之后**必须重新 `pnpm build`**（没有 HMR，FastAPI 直接托管 `web/dist`）。
改后端会由 uvicorn 自动 reload。

健康检查：`curl localhost:8790/api/health`

```json
{"ok":true,"model":"deepseek-chat","configured":true,"search":"deepseek"}
```

---

## 3. 架构总览

```
浏览器（React）
  ├─ 驱动循环：POST /api/step（只发 session_id + seq + 本条用户消息）
  ├─ 收到 1 个动作 → 渲染时间线 → 文件动作交给 player 逐字"演"出来
  └─ 现场快照存 localStorage（刷新/返回可恢复）

服务端（FastAPI）
  ├─ 会话在内存 + 落盘（var/sessions/<id>.json）
  ├─ 每轮一次 function calling：模型返回 tool_calls[0]
  ├─ 执行工具（改文件 / 搜索 / 记录）
  └─ 只回变化的文件（changed），不回整份
```

**关键点：循环由前端驱动。** 服务端是无状态的单步执行器（会话状态在服务端，
但"何时请求下一步"由前端决定）。这样做是为了让每一步都能在界面上停下来。

### 一轮请求的完整形状

```
POST /api/step
{ "session_id": "s-...", "seq": 3, "message": "把背景改成深色", "pending_search": null }

→ 200
{
  "event": {"action": "edit", "path": "style.css", "label": "改背景", "find": "...", "replace": "..."},
  "seq": 4,
  "changed": {"style.css": "……完整新内容……"},
  "stop": false
}
```

- `seq` 必须等于服务端当前 seq：小了 → **回放上次结果**（幂等，可安全重试）；大了 → 409。
- `message` 只有"用户这一轮说的话"才带；继续跑下一步时为 null。
- `pending_search` 用于两段式搜索：先返回"正在搜"，再由前端带着 query 请求一次拿结果。

---

## 4. 协议：11 个工具

schema 在 `backend/tools.py`，名字 → 动作的映射也在那里。

| 工具 | 说明 | 会不会结束这一轮 |
|---|---|---|
| `think(text)` | 说清在确认什么 | 否 |
| `look(path)` | 看项目内容 | 否 |
| `search(query)` | 联网查资料 | 否（两段式） |
| `plan(steps)` | 列出接下来几步 | 否 |
| `ask(questions)` | 缺信息时提问（1/n 逐个问） | **是** |
| `say(text)` | 只回一句话（寒暄） | **是** |
| `write_file(path, content, lang, label, overwrite)` | 新建/覆盖 | 否 |
| `edit_file(path, find, replace, label)` | 改一段 | 否 |
| `delete_file(path, label)` | 删除 | 否 |
| `finish(text)` | 收工 | **是** |
| `decline(text, suggestions)` | 超范围时礼貌挡回 | **是** |

几处硬规则（都有对应代码，别只改 prompt）：

1. **不能撒谎**：`say` / `finish` 里提到某个文件名，但项目里没有 → 把话退回去逼它真写
   （`backend/guards.py::claims_missing`）。
2. **不能打转**：连续重复同一个调用，按 3 / 5 / 8 分级提醒，第 8 次收尾
   （`guards.py::repeat_streak`，参数会先排序再比较）。
3. **不能默默覆盖**：`write_file` 目标是已存在的文件时必须带 `overwrite=true`，
   否则报错引导去用 `edit_file`（`backend/fs.py`）。
4. **改必须对得上**：`edit_file` 的 `find` 必须逐字出现在原文里，否则错误回传。

---

## 5. 后端模块

| 文件 | 行数 | 职责 |
|---|---|---|
| `main.py` | ~138 | FastAPI 路由、会话端点 |
| `agent.py` | ~270 | **唯一的循环**：调模型 → 执行 → 返回事件 |
| `tools.py` | ~85 | 工具 schema（唯一一份，既给模型也用来自省） |
| `actions.py` | ~112 | tool_call → 内部动作，**唯一做参数校验的地方** |
| `prompt.py` | ~57 | 系统提示词 |
| `context.py` | ~29 | 给模型看的项目上下文 |
| `fs.py` | ~39 | 文件操作 + 写入/编辑保护 |
| `guards.py` | ~72 | 撒谎守卫 + 重复守卫 |
| `session.py` | ~151 | 服务端会话：内存 LRU + 落盘 + 增量 diff |
| `search.py` | ~164 | 联网搜索（默认 DeepSeek 自研 Search API） |

### 会话文件长什么样

`var/sessions/<id>.json`（gitignored）：

```json
{
  "id": "s-1794480000000",
  "messages": [ {"role":"user",...}, {"role":"assistant","tool_calls":[...]}, {"role":"tool",...} ],
  "files": {"index.html": "<!doctype html>…"},
  "seq": 6,
  "last_event": {"action":"write",...},
  "updated_at": 1794480000.0
}
```

注意：`messages` 是完整的 OpenAI 工具调用历史，裁剪时要保证
`assistant(tool_calls)` 和它的 `tool` 结果不被拆散（`session.py::_trim` 已处理）。

---

## 6. 前端模块

| 文件 | 行数 | 职责 |
|---|---|---|
| `App.tsx` | ~1500 | 循环驱动、三栏布局、时间线、提问卡、恢复现场 |
| `player.ts` | ~317 | 播放器：把 write/edit 逐字"演"出来，支持中途 splice |
| `check.ts` | ~121 | 写完自检：引用/类名/id/括号 |
| `zip.ts` | ~112 | 前端打 zip（STORE + CRC32，不引依赖） |

### 循环的写法（重要）

只有**一个** `pump()`（`App.tsx`），状态机：

```
idle → running → (paused | waiting | done)
```

- 所有入口（开跑 / 发送 / 回答提问 / 恢复）都只做一件事：置状态 + 调 `pump()`。
- **不要再加 `setTimeout(nextRound)` 之类的第二驱动力**——历史上这里出过重复请求和互相等死。
- `pump()` 不等动画播完；文件动作只是把播放器"喂"一段，新动作来了就 `finishNow()` 收尾。

### 暂停 / 返回 / 刷新

| 操作 | 行为 |
|---|---|
| 暂停 | 停循环 + 停动画；输入框解禁，可以说话 |
| 返回 | 回首页，现场冻结保存，首页出现「上次没做完 · 接着做 / 不要了」 |
| 刷新 | 同上（localStorage + 服务端会话都能接回） |

**运行中不接受输入**（输入框 disabled）。这是刻意的：不要偷偷做"插话排队"，语义会糊。

---

## 7. 关键决定与踩过的坑

这些不是可有可无的历史，多数是踩出来的：

### 7.1 换成真正的 function calling（别再退回 JSON）

早期用 `response_format=json_object` + 手写协议，长文件（Markdown/代码）里
转义一错整轮就废，出现过大量「模型返回的不是合法 JSON」。现在用 `tools`，
文件正文走 `content` 参数，由协议保证转义。**不要再往 JSON 里塞大段文本。**

### 7.2 服务端会话 + 幂等 seq

之前每轮把整份对话 + 整份文件发给后端，1 个文件就到 12KB，还随文件增长；
网络一抖这轮就废。现在客户端只发 `session_id + seq + message`（约 80 字节），
重发同一个 seq 是安全的（服务端回放上次结果）。

### 7.3 循环与动画解耦

曾经循环 `await` 播放器演完才请求下一步，低速（cps=40）打一个 1.5KB 文件要 40 秒，
后续全堵住——这就是用户反复说的"卡住了"。现在模型返回就继续。

### 7.4 工具结果必须回灌

写完文件如果不告诉模型"已写入 x（n 行）"，它会反复重写同一个文件。
现在每次文件动作后都有一条 `role:"tool"` 结果。

### 7.5 工具调用一次只取第一个

`tool_calls` 可能一次返回多个；我们只取 `[0]`，其余忽略。
这是为了"一步一屏"的产品选择，不是疏忽。

### 7.6 上下文缓存：system 必须固定

模型侧按**前缀**做缓存，前缀一变整段重算。之前 system 里塞了全部文件正文
（1 个登录页就有 8KB），写一次文件前缀就变，缓存全部失效、输入按全价重复计费。

现在：

- system 里**只有固定内容**（提示词 + 是否可搜索），一次会话内逐字符不变
- 项目清单和正文都不进 system：清单用 `look("")` 拿，正文用 `look(path)` 拿
- 每次写文件的结果里带"当前文件：a, b"，模型靠它跟踪
- 副作用：改文件前必须先 `look`（`fs.py` 会拒绝没读过的文件）

实测：一轮"建 3 个文件"的会话，system 每轮都是 1506 字符，前缀零变化。

### 7.7 参考了 DSH 的源码

本地 DSH 的 `app.asar` 里有 329 个 `@deepseek-ai/dsh-*` 包，可直接读：

- `dsh-repeat-tool-reminder` → 我们的分级提醒
- `dsh-fs-observation-policy` → 我们的写入/编辑保护
- 还没抄的：`dsh-tool-call-timeout-policy`、`dsh-compaction-basic`、
  `dsh-session-persistence-jsonl`

解包方法：`app.asar` 前 12 字节后是 JSON 头，按 `entries` 里的 `offset/size`
切片即可（`/tmp/asar_entries.json` 那套脚本）。

---

## 8. 已知问题 / 没做完

按优先级：

1. **没有工具调用超时策略**：目前只有 HTTP 超时（180s）。模型偶尔很慢，
   界面会一直"进行中"。DSH 的做法是给每次工具调用加 deadline，超时返回结构化错误。
2. **上下文是粗暴截断**：`session.py` 只保留最近 80 条消息。长会话会丢早期信息，
   也没有摘要压缩。
3. **单步调用没有流式**：模型生成一个动作期间界面没有中间反馈（只有"进行中"）。
4. **`search` 有时检索质量一般**：query 由模型写，偶尔搜偏；`dedupe` 只按域名限两条。
5. **自检（check.ts）只覆盖前端项目**：HTML/CSS/JS 的引用、类名、id、括号。
   Python/Node 脚本没有针对性的检查。
6. **没有端到端测试**：验证目前靠脚本 + CDP 手测（见下一节）。
7. **`App.tsx` 1500 行**：循环、布局、时间线都在一个文件里，还没拆。

---

## 9. 怎么验证（重要，别用错方法）

### 9.1 后端单轮验证

```bash
curl -s -X POST localhost:8790/api/session \
  -H 'Content-Type: application/json' \
  -d '{"id":"s-test","messages":[],"files":{},"seq":0}' >/dev/null

curl -s -X POST localhost:8790/api/step \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"s-test","seq":0,"message":"写一个快速排序，用 js"}' | python3 -m json.tool
# 之后 seq 递增继续调用，直到 stop=true
```

### 9.2 浏览器验证：**不要用 `--virtual-time-budget` 判断"是否完成"**

虚拟时钟不会等真实网络，截图经常抓在"请求还在飞"的瞬间，看起来像卡住。
可靠做法是用 CDP（Chrome DevTools Protocol）连上页面，等真实时间再取状态：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir=/tmp/cdp-check about:blank
```

然后用 Node（自带 WebSocket）连 `http://127.0.0.1:9333/json` 取页面 ws，
`Runtime.evaluate` 读 DOM，`Page.captureScreenshot` 截图。

**Chrome 的 `--user-data-dir` 一律放 `/tmp`**，并在结束时删掉。
之前写死在项目根目录，攒了 14 个 `.chrome*` 目录共 77MB。

### 9.3 出问题先看哪里

- 前端：右上角「日志」按钮（或 `?trace=1`），记录每次 send / 事件 / 状态迁移
- 后端：`logs/trace.jsonl`（每行一个 JSON 事件）和 uvicorn stdout
- 会话现场：`var/sessions/<id>.json`（能直接看到 messages / files / last_event）

---

## 10. 改这个项目的约定

1. **不要整体重写 `App.tsx`**。1500 行，一次全量重写会丢细节（历史上丢过一次工作区）。
   用精确替换，改完 `pnpm build`（会先跑 tsc）。
2. **加工具 = 改三处**：`tools.py` 加 schema、`actions.py` 加校验、`agent.py` 加执行分支。
   缺一处就会静默失败。
3. **不要在 prompt 里写死具体场景**（比如"新闻怎么回"）。写**方法**，
   让模型自己套用。之前写死过，换个领域就不灵。
4. **不要用 setTimeout 驱动循环**，只走 `pump()`。
5. **不要偷偷加用户没要的功能**（"插话排队"就是被要求删掉的）。
6. 中文界面、中文注释；文案避免"您好，我是您的助手"这种腔调。

---

## 11. 下一步建议（按价值排序）

1. **工具超时 + 重试策略**（照 `dsh-tool-call-timeout-policy` / `dsh-llm-retry`）：
   长会话最容易在这里翻车。
2. **上下文压缩**（照 `dsh-compaction-basic`）：先做"工具结果裁剪 + 早期摘要"。
3. **拆 `App.tsx`**：把时间线、提问卡、恢复卡拆成组件，循环单独一个 hook。
4. **端到端测试脚本**：把 9.1 的流程写进 `scripts/e2e.py`，覆盖
   建文件 / 编辑 / 提问 / 搜索 / 拒绝 / 恢复 六条路径。
5. **部署形态**（如果要给别人看）：纯静态前端 + 服务端会话，注意 API key 不能进前端。

---

## 12. 一句话总结

> 这个项目的价值不在"能写代码"，在**每一步都看得见、停得住、能接着做**。
> 任何让过程变黑箱、或者让循环出现第二个驱动力的改动，都是在拆它。

有问题先看 `logs/trace.jsonl` 和 `var/sessions/`，比读代码快。