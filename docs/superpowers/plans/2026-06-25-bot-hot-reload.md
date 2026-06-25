# Plan: bot 热加载(provision 不再全量重启 gateway)— #157

## 背景 / 动机

当前 daemon provision 一个新 bot:写 per-bot config + 注册进全局 `~/.cc-channel-octo/config.json` 的 `bots[]` + 执行 **`cc-channel-octo restart`**(全量重启)。重启期间**所有已运行 bot 短暂离线**,会话/streaming 中断,代价随 bot 数放大。openclaw 用 atomic config write + gateway file-watcher 做到加 bot 不重启。本任务让 cc 对齐:gateway 监听 config.json,**新增 bot 只 startBot 那一个、移除 bot 只 shutdown 那一个**,不再全量重启。

## 范围

- **主仓 cc-channel-octo**:gateway 新增 config watcher + 运行时 bot 集合管理 + 单 bot 热加载/热卸载 + 空集合回 idle。
- **配套 octo-daemon-cli**:`adapter/claude.go` 改为 **atomic 写 config**(temp+rename,防 watcher 读半写),provision 主路径**去掉 restart**(不做能力探测、不兜底旧版,见 F)。
- 分支:cc `feat/bot-hot-reload`(从 main);daemon 另开 `feat/claude-atomic-config-hot-reload`(从 main)。

## 设计要点(关键不变量)

### A. 触发方式:文件 watcher,不加新命令
gateway 进程 `fs.watch` 全局 `config.json`(及其目录,防 rename 后 inode 变化丢监听)。daemon 仍通过**写文件**加/删 bot,不引入 `add-bot` 命令(那需要进程间 IPC,过重)。

### B. 防串话是双向的(热加载比全量重启多出的复杂度)
`knownBotUids` loop guard 防的是**同群多 bot 互相回复成死循环**(不是 session 隔离——session/数据本就按 bot 独立)。全量重启时所有 bot 一起起,`registerKnownBot` 在 main() 一次性交叉注册。热加载必须**手动维护双向**:
- **新 bot 加入**:新 bot 的 router 注册所有现存 bot 的 robot uid;**且每个现存 bot 的 router 都要 `registerKnownBot(新bot robot uid)`**。
- **bot 移除**:每个现存 bot 的 router 要能 `unregisterKnownBot(被删bot robot uid)`(需新增此方法,当前只有 register)。

### B2. 两个身份不能混用(configId vs robotUid)
- **configId** = config.json `bots[].id`(daemon 写的,= bot_uid 字符串),是**期望集合 diff 的 key**。
- **robotUid** = bot register 到 Octo 后返回的 robot id,是 **knownBotUids 注册/注销的 key**。
- BotStack 显式保存两者(`configId` + `robotUid`)。BotManager 的 `Map` 用 **configId** 做集合 diff;SessionRouter register/unregister 只用 **robotUid**。两者混用会导致 diff 漏判或 loop guard 失效。

### C. 运行时 bot 集合提升为长生命周期结构 + 串行 applyLatestConfig
当前 `stacks` 是 main() 局部数组。改为模块级 **BotManager**,持有 `Map<configId, BotStack>`,提供 `addBot(cfg)` / `removeBot(configId)` / snapshot。
**并发模型(C6)**:watcher 不在回调里直接算 diff,而是把"应用最新 config"作为**串行队列任务** `applyLatestConfig()`:
- 队列**串行**执行,同一时刻只有一个 apply 在跑。
- 每个 apply 任务**执行时才重新 load 最新 config + 算 diff**(不预计算,避免"add 后紧跟 remove 仍启动已删 bot")。
- 用 **generation 计数**丢弃过期任务:连续抖动只让最后一次真正 apply。
- 每个 configId 标 `starting`/`stopping` 状态,防 startBot 与 shutdown 竞争同一 botId。

### D. 完整 desired snapshot + 半写保护(不止 JSON 解析)
watcher 触发后,先**完整 `loadConfig` + `resolveBotConfigs` 出一个有效的 desired snapshot**;**任何**下列问题都只记录日志并**保持当前运行集合不变**(不应用部分集合):
- 读文件失败 / JSON 不完整(半写)
- resolveBotConfigs 语义错误:缺 botToken、重复 id/token、unsafe apiUrl、per-bot config 损坏
daemon 侧用 atomic rename 保证 watcher 只看到完整文件。watcher 去抖(debounce ~200ms)合并连续写。坏掉一个 bot 配置**不能**让整次 apply 异常或误删其他 bot。

### E. 空集合回 idle 而非退出
当前热卸载光所有 bot 后进程会 exit(只有初始 idle 分支)。BotManager 在集合变空时**保持 keepalive**(不 process.exit),等下一个 provision。即 idle 是运行态的一个状态,不只是启动态。

### F. 不做 fallback 探测(假定 gateway 已升级)
本次发布假定 daemon 与 cc gateway **同批升级**到带 watcher 的新版(daemon 升级会把 cc 包也带到新版)。所以:**daemon provision 主路径只 atomic 写文件,不再 restart,也不做能力探测**。不兼容"还没带 watcher 的旧 gateway"——本任务不为旧版兜底(旧版已被升级覆盖)。

### G. 已知局限:同 bot re-provision 的 config 热更不生效(MVP 边界)
本任务 watcher **只监听全局 `bots[]` 的增/删**,不监听 per-bot config.json 内容变化。后果(必须明确告知运维):
- daemon re-provision **同一个 bot** 改了 token/apiUrl 时,全局 `bots[]` 因幂等不变 → watcher 无 diff → **新 token/apiUrl 静默不生效**(且已去 restart,不会被动重启)。
- **缓解**:此场景需**人工 `cc-channel-octo restart`** 让新 per-bot config 生效。在 plan/PR/代码注释里写明此局限。per-bot config 热更留作后续增强(见"不做")。

## 步骤(bite-sized,每步可测)

### cc-channel-octo
1. **重构:抽出 BotManager** — 把 main() 里 stacks 生命周期收敛成模块级结构,持有 `Map<configId, BotStack>`,提供 add/remove/snapshot;现有启动流程改为"初始 config → 逐个 addBot"。BotStack 显式带 `configId` + `robotUid`(B2)。先不接 watcher,保证重构后行为等价(测试全过)。
2. **SessionRouter.unregisterKnownBot** — 新增方法 + 单测(register/unregister 对称,key 用 robotUid)。
3. **addBot 热路径(时序对齐两阶段启动)** — addBot(cfg) 内部顺序必须是:`startBot`(register+装 handler,**不开 socket**)→ **双向交叉注册 knownBotUids**(新 bot 注册所有现存 robotUid;所有现存注册新 bot robotUid)→ **再 connect**(开 socket)。这样不会出现"socket 已开但双向注册没完成"的串话窗口(对齐现有 main() 的两阶段)。**connect 失败要回滚**:撤销刚加的 knownBotUid + shutdown 该 bot + 从 Map 移除。单测:加 bot 后所有 router 的 knownBotUids 正确;connect 失败后集合无残留。
4. **removeBot 热路径** — removeBot(configId):shutdown 该 bot + 所有现存 router `unregisterKnownBot(其 robotUid)` + 从 Map 删。单测:移除后资源释放(锁/socket/interval/db)+ 其他 router 不再知道它。
5. **config watcher + applyLatestConfig** — fs.watch 全局 config.json,debounce ~200ms → 入串行队列 `applyLatestConfig`;任务执行时**重新 load+resolve desired snapshot**(D 的完整校验,坏配置保持现状)→ diff(key=configId)→ 调 add/removeBot;generation 丢弃过期任务;configId 加 starting/stopping 状态防竞争(C/C6)。单测:用临时目录驱动 config 变化(增/删/坏写/抖动连写)验证 diff 与跳过行为。
6. **空集合回 idle** — manager 集合空时维持 keepalive 不退出;再加 bot 能恢复。单测覆盖空→非空→空。

### octo-daemon-cli
7. **claude.go atomic 写** — `Provision` 写 per-bot config + `registerClaudeBot` 写全局 config 改为 temp+rename + mutex(照搬 openclaw_config.go 模式),保持文件 mode。这样 cc watcher 永远读到完整文件(D 的前提)。
8. **去 restart** — provision 主路径**不再 restart**,只 atomic 写文件(F:假定 gateway 已带 watcher,不做能力探测、不兜底旧版)。Deprovision(删 bot)留给 #57,本任务不做删 bot 的 daemon 侧(但 cc 的 removeBot 能力先就位,供 #57 复用)。

## 验证标准

- [ ] cc:`npm run type-check` / `npm run lint`(max-warnings 0)/ `npm test` 全过
- [ ] daemon:`go build ./...` / `go vet ./...` / `go test ./...` 全过
- [ ] 单测覆盖:add/remove 双向注册、watcher diff、半写跳过、空集合回 idle
- [ ] 本地端到端(⑤):web 建第 2 个 bot 时,**第 1 个 bot 的 gateway 进程 PID 不变**(证明没重启),两个 bot 都能对话
- [ ] daemon 写 config 期间用 watcher 读不到半写(atomic 生效)

## 已决策(② plan review 敲定)

1. **fallback 形态**:不做能力探测,假定 gateway 已同批升级带 watcher,daemon 只 atomic 写不 restart(见 F)。
2. **config 热更范围**:MVP 只热加/卸 bot,**不**监听 per-bot config 内容变化;同 bot re-provision 改 token/apiUrl 静默不生效,需人工 restart(见 G,已知局限,写进 PR/注释)。
3. **watcher 实现**:Node 原生 `fs.watch`(监听目录,防 atomic rename 换 inode 丢监听)+ debounce + applyLatestConfig 重新 load 兜底不可靠事件;不用轮询 watchFile。

## 不做(本任务边界)

- per-bot config 热更(同 bot 改 token/model/apiUrl 自动生效)→ 后续增强,本任务需人工 restart
- 删 bot 的 daemon 侧联动(Deprovision)→ 属 #57,本任务只让 cc 具备 removeBot 能力
- 不改 cc 的 CLI 命令集(不加 add-bot / remove-bot 命令)
- 不兼容无 watcher 的旧 gateway(假定已升级)
- 不碰 server / fleet / matter
