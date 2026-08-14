# dsh-tool-underseal

[English](README.md) | **中文**

![CI](https://github.com/Hyperionjust/dsh-tool-underseal/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/dsh-tool-underseal)
![license](https://img.shields.io/npm/l/dsh-tool-underseal)

> **一句话定位：** 聊天是运输，不是授权。授权 = 哈希密封的 assignment 文件；证据 = 只追加、任何第三方可重算；所有边界都 fail-closed——密封工具、worker 签到锁、字节级供应链哨兵，一条 `dsh plugin add dsh-tool-underseal` 全部到手。

> **已在 DSH 0.1.0-rc.5 实测** —— 运行时挂载冒烟测试通过：`dsh plugin add` + `dsh --dump-config` 挂载双层（`underseal` 与 `underseal-guard`），完整仪式链（doctor → seal → start → event → audit → retire）在真实 Git 仓库中经 vendored 适配器端到端跑通。两条实战笔记：`dsh plugin add` 接**含空格的本地路径**时要用字面双引号包裹（`dsh plugin --profile p add '"D:\项目路径"'`，CLI 经 shell 拼 pnpm 参数不加引号）；seal 之后、worker 开始之前必须先提交 lead plane（`.underseal/`、`.underseal-runs/`），否则规范性范围审计会对未提交的控制面文件 fail-closed（见随包 skill）。

面向 DeepSeek Harness 的类型化模型工具，包装冻结的、经审阅的 underseal 适配器。

Underseal 是一个哈希密封的文件授权协议，用于在 AI agent 之间委托有边界的工作。它冻结的 Python 验证器是唯一权威；本包只是**进程外壳**——从不重新实现验证逻辑。每个工具经 `ctx.subprocess` seam 启动 vendored 适配器，要求适配器输出规范的 `UNDERSEAL_ADAPTER_*` 成功标记，失败则抛出适配器的 `E_*` 诊断码。

本包还随附一个 DSH skill（`skills/underseal-delegation/SKILL.md`），用 DSH 语义（subagent / subagent_fork / workflow / goal）记录整个委托工作流，参考文件位于 `skills/underseal-delegation/references/`。

## 实战记录：仪式在生产中的形状

原版 underseal 工作流（Codex 任 lead、DeepSeek 任 worker）在 2026 年 8 月
连续三天的生产运行留下了 OpenAI 侧计量，值得作为设计信号一读——但有两点
保留：它早于本 DSH 插件；且 Codex 自身上下文与 underseal 混在一起，无法
干净地按部分归因。

| 指标（三天，加权） | 数值 |
|---|---|
| 输入缓存命中率 | **99.164%** |
| 总输入 | 289,510,152 tokens |
| 总输出 | 1,669,568 tokens |
| 输入/输出比 | ≈ **173:1** |
| 按 0.1× 缓存读取折算的有效输入成本 | ≈ 31.1M tokens（约省 89%） |

两读：

1. **99% 缓存命中率是值得保留的性质。** 密封 assignment、receipt、dispatch
   绑定与仪式规则都是稳定、被哈希约束的文本，长提示前缀几乎完全命中缓存。
   协议的稳定性即缓存友好性。
2. **173:1 是"仪式活在聊天里"的税。** 同一个约 100K token 的前缀被重复读取
   数千次；缓存让它便宜，却没有让它变轻——速率限制、延迟与暴露的提示面
   都在为它买单。

本插件就是修正：权威住在文件里，不住在提示词里。稳态回合只携带 8 个工具
schema（约 1–2K tokens）加上有界的工具结果（`{marker, payload, exitCode,
stdout, stderr}`）；assignment 只被必须服从它的 worker 精确读一次，证据
永不重新进入上下文。按任务归一化（同任务密封 vs 不密封）的基准见
[BENCHMARK.md](BENCHMARK.md)——跑一遍，填一行真实的 Δ。

实测于 DSH 0.1.0-rc.5、`deepseek-v4-flash`：密封开销是**每个任务恒定的
~10.4K 未缓存 token，不是按比例的税**（墙钟另加数十秒：微型任务 +10s、
真实任务 +54s）——微型写文件任务里它占总输入的 42%；真实编码任务
（Python 模块 + 16 个测试）里降到 14%，且任务越大占比越低。完整表格与
注意事项见 [BENCHMARK.md](BENCHMARK.md)。

## 基准：密封到底花多少

在 DSH 0.1.0-rc.5、`deepseek-v4-flash` 上端到端实测，同一任务跑两遍——
不密封（A）vs 完整密封仪式（B）：

| 任务（A → B） | 未缓存 Δ | 墙钟 Δ | 占总输入比例 |
|---|---:|---:|---:|
| 微型：写一个文件 | +10,420 token | +10.2s | 41.7% |
| 真实：Python 模块 + 16 个测试 | +10,282 token | +54.3s | **13.8%** |

**密封是每个任务恒定的 ~10.4K 未缓存 token，不是按比例的税。** 任务越大，
token 账单几乎不动（+10,420 → +10,282），于是它占总输入的比例从微型任务
的 42% 降到真实任务的 14%，且继续趋近于零。（墙钟略涨，因为仪式多出的
几次模型往返耗时随思考量走。）完整表格、方法与注意事项见
[BENCHMARK.md](BENCHMARK.md)。

## 状态：出树 bundle

本目录是一个**出树**插件包，同时是可安装的 DSH **bundle**：`package.json` 声明 `dsh.bundle = { patch: "./cordis.patch.yml" }`，因此 `dsh plugin add` 会自动激活它的层。用普通 `tsc -p .` 即可编译（见 `tsconfig.json`），尚未注册进 monorepo 的 `tsconfig.host.json` / `knip.json` / 根 workspaces。见[并入 monorepo](#并入-monorepo)。

## 安装

三种官方形态（[发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)）：

```sh
# 1. npm（首选）：预构建的 lib/ 随发布包分发
dsh plugin --profile <name> add dsh-tool-underseal

# 2. Git 直装：pnpm 在拉取后会运行本包的 `prepare`（tsc -p .）；
#    首次 add 会失败，直到你在 profile 的 pnpm-workspace.yaml 里授权构建
#    （照抄 pnpm 打印的确切键）：
#      allowBuilds:
#        dsh-tool-underseal: true
#    然后重新执行，建议锁定 commit：
dsh plugin --profile <name> add github:you/dsh-tool-underseal#<sha>

# 3. Tarball：完全不需要构建授权
pnpm pack
dsh plugin --profile <name> add ./dsh-tool-underseal-0.1.0.tgz
```

不开机验证层，然后开机：

```sh
dsh --profile <name> --dump-config   # 应看到 "# == dsh-tool-underseal" 层
dsh --profile <name>
```

卸载：`dsh plugin --profile <name> remove dsh-tool-underseal` 会同时移除依赖与它的层。

请如实看待 `allowBuilds`：它意味着允许在**安装期**、在 agent 沙箱之外执行本包的代码。不想授予该权限时，请优先用 npm 或 tarball 形态。

## 服务 API

本包内含两个插件：

- 插件名：`tool-underseal`
- `inject`：`['tools', 'subprocess']` —— 只有当工具注册表（`ctx.tools`）与子进程提供方（`ctx.subprocess`）都存在时插件才加载。
- 贡献：在 `ctx.tools` 上注册八个模型可用的工具。

- 插件名：`underseal-guard`（子路径 `dsh-tool-underseal/guard`）
- `inject`：`['tools']`
- 贡献：在 `ctx.tools` 上注册一个单调执行守卫——worker 签到锁（见 [Worker 签到锁（guard）](#worker-签到锁guard)）。

### 配置

`tool-underseal`：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `adapterPath` | string | vendored `python/underseal_adapter.py`（绝对路径，加载时解析） | 适配器脚本；当 `pythonPath` 为空时改为可执行文件名或绝对路径。 |
| `pythonPath` | string | `python`（Windows）/ `python3`（POSIX） | `.py` 适配器脚本的解释器前缀。空字符串表示把 `adapterPath` 直接当作可执行文件启动。 |
| `cwd` | string | `process.cwd()` | 子进程工作目录。适配器靠 `--workspace-root` 解析工作区，此配置只影响 PATH 相对的工具。 |
| `graceMs` | number | `30000` | 子进程终止升级的宽限时间（毫秒）。 |
| `outputMaxBytes` | number | `65536` | 每个输出流的内存上限，超出保留尾部。 |
| `spillMaxBytes` | number | `4194304` | 每个输出流的整流落盘上限。 |

`underseal-guard`：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `blockedTools` | string[] | `['write', 'edit', 'pwsh', 'bash']` | 缺失 READY 证据时被拒绝变更的工具名列表。 |
| `cacheTtlMs` | number | `2000` | 每个仓库的判定缓存寿命（毫秒）；过期后重读那几个很小的 underseal 状态文件。 |

默认值即自包含：经审阅的适配器 vendored 在包内，所以裸 `dsh plugin add` 只需要宿主上有 Python 解释器。想改用独立安装的控制台脚本，覆盖 `pythonPath: ''` + `adapterPath: underseal-adapter` 即可。

## Vendored 验证器

`python/` 携带的是**经审阅的确切字节**，不是会移动的分支：

- 上游：`https://github.com/Hyperionjust/underseal`
- 审阅的上游 commit：`18f85a6b3bc89a8b3325a9bd665ee51a8ab3d225`
- `underseal.py` 的字节与 `python/underseal.pin.json` 一致（SHA-256 `130c86e0…`）；`python/.gitattributes` 强制 LF，杜绝 checkout 时的 CRLF 改写漂移 pin 字节。
- Apache-2.0：`LICENSE` 与 `NOTICE` 随包分发。

每次更新 vendored 验证器，都要当作一次新的供应链审查（`skills/underseal-delegation/references/maintenance.md`）。

## 供应链哨兵

插件在 `apply()` 内、注册任何工具**之前**运行三道字节级防伪检查，被篡改的包无法静默激活：

- **E1 —— vendored 验证器字节。** `python/underseal.py` 的 SHA-256 必须等于 `python/underseal.pin.json` 中的 pin；`python/underseal_adapter.py` 必须存在。任何不匹配，插件记录 `error` 并**不注册任何东西**（宁可整包静默，也不运行漂移过的验证器）。
- **E2 —— skill 正文 pin。** 对 `skills/underseal-delegation/SKILL.md` 正文的每一个字节（frontmatter 结尾 `---` 行之后的范围）做哈希，与 frontmatter 中 `metadata.pin` 值比对。漂移记录 `warn` 但仍加载 skill——skill 是指导而非权威，所以 E2 永不阻止工具注册。
- **E3 —— bundle 补丁字节。** `cordis.patch.yml` 的 SHA-256 必须等于 `cordis.pin.json` 中的 pin。不匹配记录 `error` 且不注册任何东西，防止被供应链改写的层激活。

Pin 文件位置：`python/underseal.pin.json`（E1）、`skills/underseal-delegation/SKILL.md` frontmatter 的 `metadata.pin` 行（E2）、`cordis.pin.json`（E3）。期望哈希永远从 pin 文档本身读取，因此 pin 缺失、损坏或畸形本身就是一种 fail-closed 状态。

**重 pin 是一次新的审阅动作。** 对验证器、skill 正文或 bundle 补丁做出经审阅的修改后，用以下命令重算 pin：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\repin.ps1
```

脚本会打印三个新的 SHA-256 值，重写两个 pin JSON 文件，并更新 SKILL.md frontmatter 的 `metadata.pin` 行（正文字节永不改动）。它是幂等的：什么都没改时重跑，所有文件保持字节一致。请人工检查打印值，并把 pin 文件的变更当作一次新的供应链审查提交。

## 工具

每个工具成功时返回同一个规范值（`output.schema`，`additionalProperties: false`）：

```ts
{ marker: string, payload: JsonValue, exitCode: 0, stdout: string, stderr: string }
```

`marker` 是适配器的确切成功标记；`payload` 是适配器随后输出的已解析 JSON。**任何**失败（非零退出，或缺预期标记）都会使工具**抛出**适配器的 `E_*` 码与 stderr——不存在"带着失败标记的成功值"。任何工具都不运行验收命令、不执行 Git 提交、不进行网络操作；每个工具与适配器的一个子命令一一对应。

| 工具 | 适配器子命令 | 必需标记 | 参数 | lead / worker |
|---|---|---|---|---|
| `underseal_doctor` | `doctor` | `UNDERSEAL_ADAPTER_OK` | `workspaceRoot` | 只读，皆可 |
| `underseal_pin` | `pin` | `UNDERSEAL_ADAPTER_PIN_OK` | `workspaceRoot`, `replace?` | lead |
| `underseal_seal` | `seal` | `UNDERSEAL_ADAPTER_SEALED` | `workspaceRoot`, `taskName`, `expectedMode` (`owner\|mechanical`), `expectedRole`, `dispatchId?` | lead |
| `underseal_start` | `start` | `UNDERSEAL_ADAPTER_READY` | `workspaceRoot`, `taskName`, `expectedMode`, `expectedRole`, `summary?` | worker |
| `underseal_event` | `event` | `UNDERSEAL_ADAPTER_EVENT_OK` | `workspaceRoot`, `taskName`, `expectedMode`, `expectedRole`, `state`, `summary` | worker |
| `underseal_resume` | `resume` | `UNDERSEAL_ADAPTER_RESUMED` | `workspaceRoot`, `expectedRole`, `hostSameAgentConfirmed` | lead |
| `underseal_audit` | `audit` | `UNDERSEAL_ADAPTER_AUDIT_OK` | `workspaceRoot`, `taskName`, `expectedMode`, `expectedRole` | lead |
| `underseal_retire` | `retire` | `UNDERSEAL_ADAPTER_RETIRED` | `workspaceRoot`, `expectedRole` | lead |

对协议有承重作用的说明：

- **`expectedRole` 是自由字符串**，按 Underseal 角色语法 `[a-z][a-z0-9_]{0,63}` 校验（适配器的 `--expected-role` 是 `type=_role_name`，不是封闭枚举）。`deepseek_owner` / `deepseek_coder` 是本 skill 的约定，不是适配器的封闭集合。
- **`underseal_event.state`** 是适配器的 `PROGRESS_STATES` 减去 `READY`。CLI 把 `READY` 视为合法选项，但 `READY` 是 `underseal_start` 拥有的激活边界；枚举排除它，以免 worker 通过通用事件路径发出第二个激活事件。
- **`underseal_resume.hostSameAgentConfirmed`** 是必填布尔值；为 `false` 时工具不调用适配器直接拒绝，只有 `true` 才传递 `--host-same-agent-confirmed`。
- **`underseal_seal.dispatchId`** 对 `full` 仪式 assignment 必填，对 `lite` 必须省略（适配器双向强制）。

## Skill

随包 skill 用 DSH 语义记录了整个仪式。DSH 的 filesystem skill provider 不扫描 npm 包目录，所以每台机器/每个项目链接一次到被扫描的根：

```sh
# 项目级（提交进仓库）：
mkdir -p .dsh/skills
cp -r node_modules/dsh-tool-underseal/skills/underseal-delegation .dsh/skills/

# 或用户级：
cp -r node_modules/dsh-tool-underseal/skills/underseal-delegation ~/.agents/skills/
```

之后会话 skill 目录会列出 `underseal-delegation`；加载它（`skill` 工具或 `/underseal-delegation` 手势）会注入整个工作流，其中每个步骤都点名这些工具。

## Worker 签到锁（guard）

第二个插件（`dsh-tool-underseal/guard`，插件名 `underseal-guard`）把"动工程文件前先调 `underseal_start`"从 skill 指导变成工具管线里的机器规则。

### 强制 seam

守卫通过 `ctx.tools.guard()` 注册，**而不是**可重排的 `tools/pre-execute` 瀑布。契约（packages/core/tools README，"Public API"）把差别说得很明确：

> `ctx.tools.guard(guard: ToolGuard): () => void` —— 在 `tools/pre-execute` **之后**注册一个**单调的同步执行守卫**：返回原因即拒绝该调用，返回 `undefined` 则原样放行。plain-context 守卫全局生效……**之后的瀑布监听器无法把守卫的拒绝改回允许。**

`ToolGuard` 是 `(execution) => string | undefined`，在"可重排的 pre-execute 瀑布之后、派发之前"求值。机器规则绝不能被重排瀑布所逆转，所以单调守卫 API 才是强制点。守卫收到完整的、身份受保护的 `Readonly<ToolExecution>`（`name`、`arguments`、`agent`），从中取得调用 agent 的 `session.header.cwd` 用于仓库定位。

### 判定（v1，仅 full 仪式）

每次派发，当工具名在 `blockedTools`（默认 `write`、`edit`、`pwsh`、`bash`）中时：

1. 从 `session.header.cwd` 向上走到 Git 仓库根（任何 `.git` 条目）。无 `.git`（或无可用 cwd）→ 放行。
2. 扫描 `<repo>/.underseal/assignments/*.assignment.json`；要求至少存在一个 `ceremony == "full"` 且 `gate.status == "OPEN"` 的 assignment。没有 → 放行。`lite` 仪式不在 v1 范围内。
3. 该 assignment 的 role 必须在 `.underseal/dispatch/<role>.current.json` 有 INITIAL 代的 current dispatch（resume dispatch——非 INITIAL activation kind 或 generation > 1——不满足此条件）。
4. `.underseal-runs/<task>.events.jsonl` 必须不含 `READY` 事件行。

三条同时成立 → 拒绝该工具调用，原因里点名 assignment 并指向 `underseal_start`（附上它所需的 `workspaceRoot`/`taskName`/`expectedRole`/`expectedMode` 参数）。**Fail-closed：** 任何读错误，只要不是被显式归类的"不存在"答案（无 assignments 目录 → 放行；无 current dispatch → 放行；无事件日志 → 拒绝），一律拒绝调用；任何畸形 JSON 同样拒绝。判定核心是纯函数（`src/guard-core.ts`），只依赖一个最小注入式读取接口，因此无需 DSH 运行时即可在 `tests/run-guard-tests.mjs` 中运行。

### 缓存

判定按仓库根缓存，命中时派发路径 O(1)。缓存在三种情况下失效：(a) 仓库下的 `fs/observed` 事件（fs 工具在读/写后发出）；(b) 任何 `underseal_*` 工具成功后立即失效——`underseal_start` 的 READY 追加走子进程 seam、不发 `fs/observed`，因此这是让"拦→放"转变即时发生的关键；(c) 短 TTL（`cacheTtlMs`，默认 2000 ms）作为对两种信号都不发的子进程改动的陈旧性上限。缓存未命中时同步重读那几个小状态文件，与同步的 `ToolGuard` 契约一致。

### 该 seam 的已知局限

这是**工具管线内的程序闸，不是 OS 沙箱**：

- 它只看得见流经 DSH 注册表的工具派发。模型绕过工具层直达宿主、工具层不经手的宿主级子进程、或经 ACP 到达的远程后端，会完全绕过它。
- 它按工具名而非目标路径拦截：v1 在证据缺失时对任何位置的 `write`/`edit`/`pwsh`/`bash` 一律拒绝，即使写入在仓库之外。
- 权威验收复核仍是 `underseal_audit`；守卫是卫生闸门，不是证据。

## 模型体验

### 工具 schema

#### 模型看到什么

八个工具 schema：`underseal_doctor`、`underseal_pin`、`underseal_seal`、`underseal_start`、`underseal_event`、`underseal_resume`、`underseal_audit`、`underseal_retire`，各自携带[工具](#工具)一节所述的参数与共享规范结果 schema。Schema 经 `ctx.tools` 自动汇入提示词组装。

#### Token 影响

每个可见工具每请求固定的 schema 成本，外加工具的 `description` 文案。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定；限制、遮蔽或插件生命周期变化可能使该 schema 的复用失效。

### 工具结果

#### 模型看到什么

成功时 `output.render` 输出一个文本块：

```markdown
underseal <label> succeeded (<marker>, exit 0)
<payload 缩进 JSON>
```

失败时工具抛出；模型看到的是 `Error: underseal <label> failed [E_*] (exit N): <stderr>` 消息，而不是成功卡片。

#### Token 影响

数据依赖的工具结果 token；失败只增加有界的错误消息（适配器已把自己的 `git` stderr 截断到 500 字符）。

#### KV Cache 影响

仅追加；新可见内容跟随可复用的请求前缀。

### Skill 目录

#### 模型看到什么

当随包 `skills/underseal-delegation/SKILL.md` 被链接进扫描根（见 [Skill](#skill)）后，会话目录列出 `underseal-delegation` 及其 `description` 摘要。加载它注入 DSH 优先的委托工作流，其步骤点名这些工具。

#### Token 影响

可用时一条目录摘要行；完整 skill 正文只在按需时经 `skill` 工具或 `/underseal-delegation` 手势加载。

#### KV Cache 影响

仅追加；目录替换会重发整个 `<available_skills>` 列表。

## 并入 monorepo

把本包移入 `packages/` 时：

1. 把 `tsconfig.json` 换成包模板形态（`extends: "../../../tsconfig.base.json"`、`rootDir: "src"`、`outDir: "lib/types"`，项目 `references` 指向 `vendor/cordis`、`vendor/schemastery`、`core/tools`、`subprocess/subprocess`）。
2. 在 `tsconfig.host.json` 的 `references` 中注册本包（只属于一个聚合——Host），必要时在 `knip.json` 中登记。
3. 重新加上 workspace 约束不变量（`private: true`、根版本一致、完整的 `files` 门禁）。当前 `package.json` 故意省略 `private`，因为它是可分发出树包。

## 已知局限与待办

- **未在 monorepo 工具链内构建** —— 本包用独立 overlay（`tsconfig.verify.json` 把四个 `@deepseek-ai/*` 说明符映射到 checkout 的已构建类型入口）验证：严格 `tsc` 退出码 0，guard/sentinel 套件通过（54 + 39 断言），DSH 0.1.0-rc.5 上运行时冒烟测试挂载双层并跑通完整仪式链。尚未经过 monorepo 的 tsdown/tsc 项目引用构建。
- **发布线漂移** —— peer 范围已按 npm registry 钉死：`@deepseek-ai/cordis@^4.0.1` 与 `@deepseek-ai/schemastery@^3.18.1` 与 vendored 构建源完全一致；`@deepseek-ai/dsh-tools`/`@deepseek-ai/dsh-subprocess@^0.1.0-rc.0` 会接受已发布的 `0.1.0-rc.6` 线，后者新于本地测试的 `0.1.0-rc.5`。首次真实安装解析完版本后请重跑冒烟测试；若 rc.6 改变了本包使用的 seam，则收紧范围。
- **Windows 子进程捕获** —— 插件刻意让所有 spawn 走 `ctx.subprocess` 而非 `node:child_process`，因为 harness 沙箱拒绝裸 Node spawn 的管道 stdio 捕获（命名管道 EPERM）；`ctx.subprocess` 的 collect 模式是受认可路径，也是本包唯一使用的路径。
- **需要 Python 解释器** —— vendored 适配器在宿主的 `python`/`python3` 下运行；本包不携带也不安装解释器。
- **`graceMs` 上限** —— 子进程 seam 把宽限时间封顶在 `MAX_TIMER_DELAY_MS`；插件只断言正整数，上限留给 seam 并在此记录。
- **`resume` 的 host-same-agent** —— `hostSameAgentConfirmed` 是人/模型做出的断言，不是插件能验证的事实；插件只拒绝 `false` 并把 `true` 转发给适配器。
- **无 UI 卡片** —— 工具落回通用卡片；terminal/diff 呈现与 `presentationMeta` 投影器待做。
- **守卫是管线闸，不是 OS 沙箱** —— worker 签到锁（[Worker 签到锁（guard）](#worker-签到锁guard)）在 READY 证据缺失时拒绝变更形态的工具派发，但它看不见工具层不经手的宿主级进程或远程 ACP 后端，且 v1 按工具名而非目标路径拦截。权威复核仍是 `underseal_audit`；适配器的 fail-closed 验证器与人工工作流仍拥有最终边界。
- **无常驻 watcher** —— 哨兵（[供应链哨兵](#供应链哨兵)）只在插件 `apply()` 时运行一次。针对 `python/`（或 bundle 补丁/skill 文件）的 `fs/observed` 变更立即报警的常驻 watcher 尚未实现；漂移会在下次插件加载或重 pin 时浮出。
