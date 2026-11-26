# Pneuma Base 架构

2026-11-25。这份文档定内核、插件边界和包的依赖方向。它是项目的正式约束：要改这里写的边界或不变式，先改这份文档。

- 产品定义和你定过的事在 `CONTEXT.md`。
- 记账与对账插件的领域模型在 `MODEL.md`。
- 这里的类型是签名层面的设计，实现时可以细化，不能改变形状所表达的约束。

## 1. 中心

内核是三样：**认知**、**工具面**、**扩展点**。其余都是插件。

- **认知**：agent 被告知的那套心智，载体是库根目录的说明。技能指向它。
- **工具面**：agent 手里的七个动词，形状不随插件变化。
- **扩展点**：每个动词背后的槽，每个槽都有空实现。

没有任何插件的空目录，七个动词都给出确定的答复。

**底线：破坏性的改动不能由 agent 造成，无论有意还是无意。主人做什么都可以。** 两个面的操作默认都留痕，让 agent 能感知变化。

## 2. 用词

| 词 | 意思 |
| --- | --- |
| 库 | 一个文件夹，根目录有说明，`.pneuma-base/` 下有配置和各插件名下的目录 |
| 行动者 | 做事的一方：agent、主人、插件 |
| agent 面 | agent 能调用的全部：七个动词，全部不破坏 |
| 主人面 | 配置、装卸插件、发授权、生成技能、丢数据。破坏性的要人当面确认 |
| 动词 | 放、找、看、说、查、归档、请 |
| 请求 | agent 用「请」（`ask`）记下的一件要主人做的事：一句为什么，和一条照原样的主人命令。主人批准就以主人的身份跑它，或拒绝；agent 下次查时看到结果 |
| endpoint | 界面的服务里给 agent 的那一部分：说明（`/guide`）、配对（`/pair`）、MCP over HTTP（`/mcp/<授权名>`）。它是命令行的又一个面 |
| 配对 | 还没接上的 agent 请主人允许它接上。主人允许就是跑 `agent connect`，它以自己的名字接上，记录说得出是哪个 agent 做的 |
| 归档 | 把一样东西挪进库里的归档区。不删；默认的找和查不带它，带上要开开关。agent 做得快、废弃得也快，归档是 agent 面上不破坏的「不要了」 |
| 槽 | 一个动词背后插件可以接上的位置 |
| 会话 | agent 产品的一次会话，或人对工具的一次使用 |
| 事件 | 两个面的一次操作及其结果，内核在操作之后发给所有插件 |
| 视图 | 管理界面的一页：一组带类型的块，由内核或插件给出。它是一条只读的命令，`show` 把它印成字。视图不是操作，不改东西，不发事件；它可以往存储的缓存区写（比如记账插件的行和令牌的基线），那里不算库的东西 |
| 块 | 视图的组成单位：分节、记录表、字段组、列表、时间线、文字、预览、动作、空状态、库外的页面、插件自己画的页。块上挂的动作是 agent 面的一个动词或一条主人面命令 |
| 认知段 | 一个插件拼进说明的那一段话 |
| 本体、缓存 | 插件对自己名下每个目录的声明。本体跟着文件夹走；缓存不同步，删了能重建 |
| 存储 | 库最底下的一层，程序 `pneuma-base-core`（`core/`）：看和写库的文件夹，存每个记录处的事实和行，读写库根的声明。内核是它唯一的调用方，插件经 `tools.storage` 用它 |
| 令牌 | 存储对一个位置此刻状态的不透明标记。一样东西靠它认：令牌没变就是没变。内核和插件只存着、交回去，比较由存储做 |
| 指纹 | 内容的 sha256，目录条目按内容规则算（第 4 节「一个目录算一样东西」）。只在内容经过内核、要判一处差别或有人要时才读，所以一样东西可以没有指纹 |
| 噪音 | 库根的 `.pneuma-base/noise.json` 声明的名字和路径。存储从不报告、不进入它们 |
| 打开的目录 | 任意深处有登记过的东西的目录，库根总是。另两种：整个登记成一样东西的目录；关着的目录，其余的，只算上一层的一项，从不打开。三种都由记录推出，不存 |
| 留存 | 记账插件替主人留下的、被新内容换下的旧内容。给主人的保险，只有主人取回 |
| 版本 | 版本插件为声明了有版本的东西留下的每一版。agent 自己能列出、导出、放回。说明里「版本」只指这个 |

## 3. 包和依赖方向

```
packages/cli ──▶ packages/viewer ──▶ packages/kernel ◀── packages/plugin-ledger
      │                                   ▲  │       ◀── packages/plugin-version
      ├───────────────────────────────────┘  │       ◀── packages/plugin-sync
      │                                      ▼       ◀── packages/plugin-search
      │                               packages/sdk（含 kit）◀── packages/plugin-deploy
      │                                      ▲
      │                                      └────── 库外的插件（只依赖 sdk）
      └──────── 内置插件表：五个插件包 ────────────────────────────┘
```

| 包 | 职责 | 不许 |
| --- | --- | --- |
| `packages/sdk` | 插件契约（`@pneuma-base/sdk`）：全部类型、契约版本 `CONTRACT`、`definePlugin`、`defineCommand`，从命令的参数表生成用法和表单的 `usageOf`、`formOf`，和插件自己造带品牌的值用的 `pluginName`、`instant`、`PLUGIN_NAME`、`SECRET_NAME`，插件不能用的名字 `KERNEL_COMMAND_NAMES`、`RESERVED_PLUGIN_NAMES`，这一版的版本号 `PNEUMA_BASE_VERSION`。另一个入口 `@pneuma-base/sdk/kit` 是插件打进自己包里的库：只新增文件的记录库 `recordStore`、配置文件助手 `configFile`、部署库 `deployPlugin` 和写目标用的 `defineTarget`（第 13 节）。第三个入口 `@pneuma-base/sdk/testkit` 是测试工具和符合性检查（第 5 节「写一个库外的插件」）。库外的插件只依赖它 | 导入内核、命令行、界面或任何插件；含内核的逻辑（内核的工具经上下文的 `tools` 给，库也只用 `tools`） |
| `packages/kernel` | 打开库、解析配置、识别行动者和会话、七个动词的管线、请求、授权的门、事件、认知的拼装、技能的生成、接上和断开 agent 产品（产品表）、给 agent 的说明和配对、装载和安装库外的插件、本机的密钥、存储的门（`storage.ts`）、目录的三种（`places.ts`）、变化由谁来学（`changes.ts`：常驻的进程订阅，一次性的命令带预算问）、噪音的命令。依赖 sdk，并把它原样再导出 | 依赖 sdk 以外的任何包；认识任何插件的事实或目录；不经存储读写库的文件夹或记录区 |
| `core/` | 存储：Rust 的 cargo 工作区。`storage` 是抽象（`Storage` trait，不认识文件系统），`local` 是本地文件夹的实现，`cli` 是程序 `pneuma-base-core`（单次操作，或 `serve`：每行一个请求、一个答复），它的测试 `core/cli/tests/` 只经程序走，是契约的测试；`bench` 量存储的目标。线上的形式在 `core/README.md`：看内容的 `glance`、`overview`、`probe`、`look`（预期可以列在请求里，也可以是一个记录处的一张表的行：存储在里面比，只答不同的）、`changed`，读写内容的 `content`（目录可另答它算出的清单，一页一页地）、`read`、`write`（带预期；来源可以是库里的一个位置，那就是复制）、`move`、`remove`，占位的 `hold`、`release`，`serve` 里的订阅 `subscribe`（常驻的进程听变化，存储把听到的记进缓存区里的一份小日志，任何进程的 `changed` 都从它答），记录处的事实（`facts.append`、`facts.since`）、行（`rows.*`）和它自己的地方，库根的声明（`declaration.read`、`declaration.write`），噪音和 `init` | 被内核以外的东西调用（内核唯一的门是 `packages/kernel/src/storage.ts`，插件经 `tools.storage`）；懂事实和行的意思；答复里写给人看的句子；跟着库里的链接走；报告或进入噪音 |
| `packages/plugin-ledger` | 记账与对账：事实、场景、条目、对账、来历、过期、变化，留存（第 10 节） | 读写别的插件的目录；绕过内核的公开接口；导入别的插件 |
| `packages/plugin-version` | 版本：声明了有版本的东西，每一版都留着（第 11 节） | 同上 |
| `packages/plugin-sync` | 同步：库和一个目标双向同步，不合并、不丢内容（第 12 节） | 同上 |
| `packages/plugin-deploy` | 部署：sdk 的部署库加「本地目录」「命令」两种目标（第 13 节）。只依赖 sdk | 同上 |
| `packages/plugin-search` | 查找：正文和按意思，索引是缓存（第 14 节） | 同上 |
| `packages/viewer` | 管理界面。`src/server/` 是只听本机的 HTTP 服务，用内核的三个面，也是给 agent 的 endpoint（说明、配对、MCP over HTTP，第 6 节）；`web/` 是网页，只渲染块。自带的插件表和 MCP 的 HTTP 传输由调用方传进 `startServer`，服务每次请求再并上本机的插件 | 导入任何插件包或命令行；网页导入内核的代码（只取类型） |
| `packages/cli` | 命令 `pneuma-base`：把命令行翻译成对内核的调用，把结果打印出来；动词的参数表（`verbs.ts`）；内置插件表（记账、版本、同步、部署、查找，`init` 缺省只装记账）；`view` 把内置插件表交给界面的服务；`show` 把一个视图印成字，每个按钮写成做同一件事的命令（`page.ts`）；`mcp` 把一个授权的库作为 MCP 服务给出（`src/mcp/`），`src/mcp/http.ts` 是同一个服务在 HTTP 上的传输，交给 `view` 的服务；`guide` 印给 agent 的说明，`pair request`、`pair status` 是还没接上的 agent 的配对；`plugin new` 从 `templates/` 生成插件项目 | 含领域逻辑 |

插件只经契约的类型和上下文对象接触内核：自带的插件从 `packages/kernel` 导入（它再导出 sdk），部署插件和库外的插件只依赖 `packages/sdk`，运行时不导入内核，要用内核的工具就用上下文的 `tools`。插件之间不直接调用，也不互相导入。内核不导入界面，界面不导入任何插件，sdk 不导入内核、命令行、界面和任何插件；lint 的导入规则守这几条，`packages/kernel/test/dependency-direction.test.ts` 在故意违反的例子上看它们变红。

内核和记账插件只经存储的门读写库的文件夹和记录区（K10）。lint 守着：`packages/kernel/src` 和 `packages/plugin-ledger/src` 下的文件不导入 `node:fs`、`node:child_process`；内核的文件不导入 `machine-files.ts`，不用 `paths.ts` 的 `abs`、`canonical`；记账插件不从内核取直接碰文件夹的助手（`abs`、`thingAt`、`fingerprintOf` 这些）；两边都不用 `tools` 的第 1 版工具（第 5 节「上下文里的工具」）。`eslint.config.js` 的 `OFF_STORAGE` 列出可以用文件系统的几个文件，各写着为什么，它们碰的都不是库的文件夹和记录区：门本身（`storage.ts`：起存储的程序，找它在哪）；存储能答之前的库的地址（`address.ts`：调用方写的文件夹的真实路径，`init` 建的文件夹）；调用方写的绝对路径经链接解析成库内路径（`paths.ts`）；放的来源在库外（`outside.ts`：它的种类、大小、sha256）；第 1 版的兼容层（`contract-v1.ts`：库外文件的 sha256，`copyOut` 写到的库外目录）；包自己的文字（`cognition.ts`）；本机 `$PNEUMA_BASE_HOME` 下的状态（授权、endpoint、配对、密钥、插件、启动器、连接的记录）；agent 产品的配置、技能目录和对话；主人命令写到主人指定处的技能文件；记账插件读 agent 的对话记录（`conversation.ts`）。`packages/kernel/test/storage-door.test.ts` 在故意违反的例子上看这条变红，也看这几个文件不被拦。

运行时是 Node，语言是 TypeScript，包管理用 pnpm 的工作区，测试用 vitest。存储 `core/` 是 Rust：`pnpm build` 先构建它（`build:core`，`cargo build --release`）；CI 的 `ci.yml` 为此装 Rust 工具链，`core.yml` 在 `core/` 变了时跑它的格式检查、clippy 和测试。

## 4. 工具面

```ts
// 语义基元：在边界解析一次，进来之后不再判
type LibraryPath = string & { readonly __brand: 'LibraryPath' }   // 库内相对路径
type Fingerprint = string & { readonly __brand: 'Fingerprint' }   // 内容的 sha256
type PluginName  = string & { readonly __brand: 'PluginName' }
type Instant     = string & { readonly __brand: 'Instant' }       // ISO 8601

type Actor =
  | { kind: 'agent'; name: string; grant: GrantId | null }
  | { kind: 'owner' }
  | { kind: 'plugin'; name: PluginName }

type Session = {
  id: string
  source: 'flag' | 'env' | 'minted'     // 会话标识是怎么拿到的
  cwd: string
  machine: string
  transcript: Transcript | null         // 这次会话的对话在哪，见下
}

type Transcript = { path: string; resume: string | null }   // path 把家目录写成 ~；resume：接着这段对话的命令

type Context = { library: Library; actor: Actor; session: Session; now: Instant; home: string }   // home：本机的 $PNEUMA_BASE_HOME

interface AgentFace {
  put(req: PutRequest, ctx: Context): Promise<PutResult>
  find(req: FindRequest, ctx: Context): Promise<FindResult>
  inspect(req: InspectRequest, ctx: Context): Promise<InspectResult>
  say(req: SayRequest, ctx: Context): Promise<SayResult>
  check(req: CheckRequest, ctx: Context): Promise<CheckResult>
  archive(req: ArchiveRequest, ctx: Context): Promise<ArchiveResult>
  ask(req: AskRequest, ctx: Context): Promise<AskResult>
}
```

**会话指回对话。** 会话号来自某个 agent 产品的环境变量时，内核按产品表（`products.ts`，见第 6 节「接上一个 agent」）找这次会话的对话文件，找到了就放进 `session.transcript`：只是一个指针，不复制、也不读里面的内容，只看文件在不在。表里关于会话的是每个产品带会话号的变量、只表示它在跑的变量、怎么找对话；没见过会话变量的产品（Claude Desktop、Cursor）不从环境认：

| 产品 | 会话号 | 对话文件 | 接着聊 |
| --- | --- | --- | --- |
| `claude-code` | `CLAUDE_CODE_SESSION_ID` | `~/.claude/projects/<目录>/<会话号>.jsonl`（设了 `CLAUDE_CONFIG_DIR` 就在它下面），`<目录>` 是会话开始时所在的目录，字母和数字以外的字符都换成 `-`；调用可能在它下面的目录里，所以往上逐级试。目录名超过 200 个字符时 Claude Code 在后面加一段内核不知道的散列，不给指针 | `cd <目录> && claude --resume <会话号>` |
| `codex` | `CODEX_THREAD_ID` | `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<会话号>.jsonl`（设了 `CODEX_HOME` 就在它下面），日期是会话开始的那天，从新到旧找 | `codex resume <会话号>` |
| `antigravity` | `ANTIGRAVITY_CONVERSATION_ID` | 没见过它的目录，不给规则 | 无 |

两条规则都按这台机器上真的会话核过：按会话号找到了文件，也只看了名字；两个接着聊的命令都在各自的 `--help` 里。会话号要是一个干净的名字（字母、数字和 `-`），否则不找。会话号来自 `--session` 或 `PNEUMA_BASE_SESSION`、文件不在、产品没有规则时，`transcript` 是 `null`。经 MCP 的会话号是连接自己的，也是 `null`。路径在家目录下时写成 `~/…`，指针里不写家目录的绝对路径；在哪台机器上由 `session.machine` 记。Claude Code 里的子代理带的是主会话的号，指针指向主会话的对话。记账插件把它记在事实的 `where.transcript` 上，`inspect <场景号>` 和场景卡显示对话在哪、此刻在不在这台机器上，在的话给接着聊的命令（第 10 节）。

### 放

```ts
type Origin =
  | { kind: 'brought'; source: string | null; by: string | null }   // 带进来的：出处，谁带的
  | { kind: 'made'; from: string[]; outside: string[] }             // 做出来的：依据库里的哪些，库外的各写一句

type PutRequest =   // note：一句话，说这次放入改了什么
  | { kind: 'register'; path: LibraryPath; origin: Origin; note?: string | null; observed?: true } // 文件或目录已经在库里；observed：来历是看到的，不是谁说的
  | { kind: 'place'; from: string | 'stdin'; to: LibraryPath; origin: Origin; note?: string | null }   // 从库外的文件、目录或标准输入放进来
  | { kind: 'move'; from: LibraryPath; to: LibraryPath }                                               // 在库里挪位置

type PutResult =   // fingerprint：内容经过内核时才有，登记和挪是 null
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint | null; copied: boolean
      notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle' | 'agent-session' | 'noise' | 'busy' | 'too-many'
      subject: string; notes: Note[]; problems: PluginProblem[] }
```

**看到的和说的。** 应用会把主人用 Finder 复制进库的文件自动登记成「主人带进来的」。这是看到的，不是谁说的，可能看错：比如 agent 违反说明直接写了文件。所以登记可以带 `observed`（命令行 `put <库内路径> --brought --by owner --observed`）：只有主人能这样放，行动者是 agent 时以 `agent-session` 拒绝，agent 只说来历，不替主人「看到」。`onPut` 收到的 `AcceptedPut` 带着它。记成什么、谁能更正，归记账插件（第 10 节）。

内核自己能看到的是「东西」：一个普通文件，或一个带标记的目录（见下一小节「一个目录算一样东西」）。全化表里「同类」指和放进来的东西同一类：文件对文件，带标记的目录对带标记的目录；「另一类」是另一类的东西，或既不是文件也不是目录的东西。每次改动都是存储的一次带预期的写或挪（`put.ts`）：

| 请求 ＼ 目标 | 在库外或授权区域外 | 在带标记的目录里面 | 噪音 | 不存在 | 同类，内容相同 | 同类，内容不同 | 没标记的目录 | 另一类 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 登记 | 拒绝 | 拒绝 | 拒绝 | 拒绝：没有这个文件 | 接受：看一眼它现在的样子，不读内容（登记的东西就是目标本身，所以同类只有这一格） | 不适用 | 关着的：写标记，整个登记成一样东西，接受，不读内容。打开的：它这一层的散文件各登记成文件，接受，不写标记，文件夹和更深处不碰 | 拒绝：没有这个文件 |
| 放入文件或标准输入 | 拒绝 | 拒绝 | 拒绝 | 复制，预期那里是空的，接受 | 不复制，接受 | 有插件留住旧内容：换上新的，预期那里还是看到的令牌。没有：拒绝，目标不动 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 放入库外的目录 | 拒绝 | 拒绝 | 拒绝 | 按内容规则复制整棵树，写标记，接受；超过 5000 个文件拒绝 | 不适用：目录对目录条目一律当作内容不同 | 同上一行，整棵换掉 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 挪 | 拒绝 | 拒绝 | 拒绝 | 挪过去，预期来处还是看到的令牌、去处是空的，整个目录一起，接受 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

- 「内容相同」只在可能相同时才读来判：文件对文件、大小一样，才读两边的指纹比；大小不同就是不同。判目录要读整棵树，所以不判。
- 拒绝的理由：噪音是 `noise`；目录超过 5000 个文件是 `too-many`，`subject` 说至少几个；位置被别的写占着，或在这次放的中途变了（预期不成立），是 `busy`，什么都没改。
- 「打开的」「关着的」由插件的记录推出（第 2 节「打开的目录」）。登记一个打开的目录时，内核按存储的一览一页一页地取它这一层的文件，每页最多 200 个，告诉插件的是一页一个 `register-files`；这一层没有文件时以「没有这个文件」拒绝。

接受之后，内核把放交给每个插件的 `onPut`（`AcceptedPut`），把它们的答复收进 `notes`。`onPut` 收到的 `note` 一定有，由内核规整过：去掉首尾空白，空白或没写就是 `null`，插件不再自己判。

```ts
type ThingNow = { token: string; kind: 'file' | 'bundle'; size: number | null; files: number | null; modifiedAt: Instant }
// 存储此刻说的它。令牌就是它的身份，直到有人读它的内容。目录条目的字节数和文件数只在它被复制进来时知道

type AcceptedPut =
  | { kind: 'register'; path; fingerprint: null; now: ThingNow; origin; note; observed? }
  | { kind: 'place'; path; fingerprint: Fingerprint; now: ThingNow; origin; note; source; copied: boolean
      previous: { token: string; fingerprint: Fingerprint | null } | null }   // 经 revise 换下的那份
  | { kind: 'move'; from; path; fingerprint: null; now: ThingNow }
  | { kind: 'register-files'; path; files: { path; now: ThingNow }[]; origin; note; observed? }   // 打开的目录这一层的一页文件
```

放入的指纹是复制的同一趟算的；登记和挪不读内容，指纹是 `null`，东西靠 `now.token` 认。`register-files` 里插件登记它不认识的，认识的照原样留着。按第 1 版契约写的插件收到的照第 1 版（第 5 节「上下文里的工具」）。

**放的时候占住位置。** 一次放先把东西放到目标上，插件后才记下它；这中间看库的人（别的 agent 的 `check`、应用的监看）不该把它当成一个没人登记的文件，也不该把挪走的当成不在了。所以内核在写之前让存储占住这次要改的位置（`hold`：登记是那个位置，打开的目录是每页的那些文件，放入是目标，挪是来去两个），写带着这个占位，等所有插件的 `revise`、`onPut` 都做完、被拒绝或出错之后放开。被占着的位置，存储的 `look` 和 `overview` 标成 `held`，别的写以 `held` 拒绝，内核把它说成 `busy`。占位有存活时间：文件 2 分钟，目录 10 分钟，进程被杀时它最多占这么久；比这更久的写在占位过期之后照样做完，只是不再挡别人。`observe` 不在占位里面：它听的是做完了的事。

「有插件留住旧内容」的分工：内核问配置里每一个提供了 `revise` 的插件，按配置的次序，一个答了之后照样问下一个。插件收到 `PlaceOverExisting`：路径，那里现在的令牌（内核的写就预期它），现在内容的指纹（读过才有，否则 `null`），新内容的指纹（目录还没复制进来时是 `null`）。插件把当前内容留到自己名下（`held`）或拒绝（`declined`）。至少一个答 `held`，内核就带着那个令牌把新内容写上去，每个答 `held` 的插件附的那句话都收进 `notes`；那里在这中间又变了，写不成，以 `busy` 拒绝。一个都没答 `held`，内核拒绝这次放入，目标不动，每个答 `declined` 的插件说的理由收进拒绝的 `notes`：只装了版本插件时，agent 从这里读到要先声明有版本。出错的插件列进 `problems`，算没留住。存储的写要么整个做成，要么什么都没改，所以不管插件写得对不对，目标上都不会出现半截内容。

实现里的细化（形状在 `packages/sdk/src/types.ts`）：

- 请求里的路径是调用方写的原样（相对库根，或库内的绝对路径），由内核在入口解析一次。「在库外」那一列就是解析不出库内路径的情形。`.pneuma-base/`、`PNEUMA-BASE.md` 和 `_archive/` 不算内容，放和挪到那里都按「在库外」拒绝；`_archive/` 只经归档和取回进出。
- 放入的来源是 `{ kind: 'file'; path } | { kind: 'directory'; path } | { kind: 'stdin'; content }`。库外的文件和目录由存储在复制时读；写成库内绝对路径的文件是库里的一个位置，存储在库里复制它；标准输入是请求里带的字节。来源是目录时，它要在库外，也不能包含这个库，否则以 `outside-library` 拒绝：复制它会把库复制进库里。
- 每个结果都带 `problems`，拒绝的结果也带，并带 `subject`：拒绝针对的那个输入。`inside-bundle` 的 `subject` 是那个带标记的目录。
- 来历里留空的字段等于没给，和主人面命令的表单一样：带进来的 `source`、`by` 是空白就当 `null`，做出来的 `from`、`outside` 里空白的行去掉。界面的表单留空时送来的是空字符串。
- 做出来的来历里，`from` 的每个路径都要是库里在的东西（主区，或它在归档区的那份）。有一个不在，就以「没有这个文件」拒绝，`subject` 是那个路径，目标不动。写的是带标记的目录里面的文件，依据记为那个目录。

### 一个目录算一样东西

- 标记：目录里有一个 `.pneuma-item` 文件（JSON，`{"format":1}`）的，是一样东西，代码里叫 bundle。没有标记的目录只是文件夹。库内路径是目录的路径，不带斜杠。
- 认：一个位置上是什么，内核只看一眼那个位置和它的标记该在的位置（`things.ts` 的 `whatIs`，插件的 `tools.what`）：文件、目录条目、文件夹、别的（链接、设备）或没有。一个路径在哪个目录条目里面，也只看一眼它上面每一级的标记。都不走目录。
- 内容规则（`THING_RULE`）：目录条目的内容是它下面的每个普通文件，除去库的噪音（任何一层）、标记文件，和它里面的 `.gitignore` 排除的（每一层的都读，最近的说了算）。链接和设备不是内容，空目录不算。规则由内核给，存储照做。放进来时按它复制；超过 5000 个文件不复制，以 `too-many` 拒绝。
- 现状：一样东西此刻的样子是存储的描述（`ThingNow`）：令牌、修改时刻，文件的大小。目录条目另有它的第一层：存储的一览，最多 200 项，多的说至少还有几项（`Level`）。目录条目的字节数和文件数只在它被复制进来时知道，别的时候是 `null`：数它们要走整棵树。
- 指纹：文件的是内容的 sha256；目录条目的是把每个算进来的文件写成 `<相对路径>\0<内容的 sha256>\n`，按相对路径的 UTF-8 字节排好，连起来取 sha256。指纹由存储算（`content`，或 `write` 复制的同一趟），内核的 `fingerprintOfManifest` 从清单算出同一个数。只在这几种时候读：内容本来就经过内核（复制放入）；要判一处差别（放到一个大小相同的文件上；归档区的那个位置已被占着）；有人要（`inspect --content`、插件的 `tools.storage.content`）；有名字的全量动作（`check --deep`）。登记和挪不读内容。
- 写：存储先把整份写进它的临时区，同一趟算指纹，再一次改名或原子交换放到目标上；预期不成立就什么都不改。中途出错或被杀，目标上要么是原来的，要么是新的，不留半棵树（`STORAGE.md` 第 2 节第 9 条）。
- 一个带标记的目录只能整体地变：它里面的路径不是 agent 面写的目标，放、挪、登记、归档到它里面都以 `inside-bundle` 拒绝。要改它，把整个目录重新放进来。
- 找：命中的路径是一个目录条目时，细节前面标「目录」。看：`FileFacts` 的 `kind` 是 `bundle`，带它的第一层 `level`。
- 挪、归档、取回：整个目录一起动。取回时原路径上有任何东西，包括没标记的目录，都算原路径被占。
- 符号链接不是东西：存储把链接本身答成 `other`，链接下面的位置答 `outside`，从不跟着链接走。所以一个路径本身是链接时，内核当那里有「另一类」的东西：登记、挪、归档、看都不认它，往它上面放以 `would-overwrite` 拒绝；路径上有一段是链接时，那里在库外，往那里放以 `outside-library` 拒绝，不会经过链接写到库外。解析调用方写的绝对路径时，只解析通到库根的那一段链接，库里的链接不跟（`parseLibraryPath`）。

### 找、看、说、查、归档

```ts
type FindRequest = { text: string | null; match: 'terms' | 'words'; filters: Record<string, string>; includeArchived: boolean; skipOwnSession: boolean }   // 开关默认关
type Hit = { path: LibraryPath | null; title: string; by: PluginName | 'kernel'; group: string | null; detail: string | null }
type FindResult = { hits: Hit[]; problems: PluginProblem[] }

type InspectRequest = { target: string; content?: { file: string | null } }   // 路径，或某个插件认得的标识；content：也要内容
type InspectResult = { file: FileFacts | null; place?: PlaceFacts; sections: Section[]; problems: PluginProblem[]; content?: Content; request?: OwnerRequest }
type FileFacts = { path; kind: 'file' | 'bundle'; size: number | null; modifiedAt; token: string; fingerprint: Fingerprint | null; archived: boolean; level?: Level }
type Level = { entries: { name; kind: 'file' | 'dir' | 'other'; size: number | null }[]; more: number }   // 一层的前 200 项；more：至少还有几项
type PlaceFacts =   // 目标是一个不是东西的目录，或噪音
  | { kind: 'open'; path; level: Level }
  | { kind: 'closed'; path; files: number; exceeded: boolean; markers: string[] }
  | { kind: 'noise'; path; by: { name: string } | { path: string } }
type Content = { kind: 'text'; path; size; text } | { kind: 'other'; path; size; type; why: 'not-utf8' | 'too-large' }
  | { kind: 'level'; path; level: Level } | { kind: 'unavailable'; path; reason: 'outside-grant' | 'no-such-file' | 'not-a-bundle' }

type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean; deep?: { dir: LibraryPath | null } }   // deep：深查，dir 为 null 是整个库
type CheckResult = { sections: Section[]; asks: Ask[]; requests: { ended: OwnerRequest[]; pending: number }; problems: PluginProblem[] }

type ArchiveRequest = { kind: 'archive' | 'unarchive'; path: string }
type ArchiveResult =   // moved：false 时请求本来就已满足
  | { outcome: 'accepted'; from: LibraryPath; to: LibraryPath; moved: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken' | 'inside-bundle' | 'noise' | 'busy'; subject: string; problems: PluginProblem[] }

type Note    = { plugin: PluginName; text: string; data?: unknown }
type Section = { plugin: PluginName; title: string; body: string; data?: unknown }
type PluginProblem = { plugin: PluginName; message: string }
```

找的两种匹配：`terms` 把文字按空白和常见标点切开，名字里含任一段就算；`words` 用 `Intl.Segmenter` 取一句话里两个字以上的词和拉丁词（它会把「下单」这类两个字的词切成单字，所以相邻的两个单个汉字也连成一个词），按命中的不同词数排，至少命中一个，每个答复者最多给 5 条。`start` 用 `words`，`find` 用 `terms`。切词和排序是内核导出的 `searchTerms` 与 `rankHits`，插件用同一套。`filters` 是插件的用语，内核不懂。

**内核自己不找。** 按名字找要走一遍库，所以命中全来自插件的索引（各插件的 `onFind`）；没有会找的插件，什么都找不到。内核只为找到的路径看一眼，把它的标记（`目录`、`已归档`）放在那个路径第一条命中的细节前面（`agent.ts`）。

`skipOwnSession` 让答复者不带调用者自己这次会话做的东西。`start` 打开它，因为它找的是库里本来就有的；`find` 不打开，什么都给。

几个答复者的结果合成一张表：同一个路径的结果排在一起，位置是任何一个答复者给它的最好名次（在自己那张表里的序号）；名次相同时按配置次序。几个插件命中同一路径各给一条，因为各说各插件知道的。所以记账插件排在查找插件前面时，查找插件按相关度排在前面的文件也排得靠前，不被压在记账插件的位置上。

各插件的 `onFind` 都答完后，内核按配置次序问每个有 `onFound` 的插件：找到的路径里它自己没给命中的那些，它知道什么。没有路径的命中不算；一个路径都不剩就不问。它答的每条命中并进那个路径的那一项，不改名次。一项里的命中按配置次序排，不论插件是找到了这个路径还是补了一条，所以只被查找插件找到的条目也带着记账插件给的场景和来历，和两个插件都匹配时一个样子。补的一条就是一条 `Hit`，没有标记说它是补的（K3）。`onFound` 抛错的插件列进 `problems`，命中照给；答了没问它的路径的那条（含没有路径的）不要，也列进 `problems`（K8）。

`group` 是答复者给一条结果定的标题：`group` 相同的结果在文字答复里合在这个标题下，出现在其中排得最前的那条的位置，每条一行；没有路径的那条说的是这个标题本身，排在标题下第一行。

`problems` 是失败语义的落点：某个插件出错时，动词照样给出答复，同时如实说明哪个插件没做成。「已放入，但没有记下」是和「已放入并记下」不同的结果，命令行以非零退出码区分。

归档是内核自己做的，不靠插件，所以空目录里也成立。归档区是库根下的 `_archive/`，里面保持原来的相对路径。全化表：

| 请求 ＼ 目标 | 不存在 | 在主区 | 已在归档区 |
| --- | --- | --- | --- |
| 归档 | 拒绝：没有这个文件 | 挪进归档区，接受。归档区里同一路径已有别的东西时：内容相同就挪到它上面，不同就把新来的名字后加指纹的前八位 | 接受，什么都不动 |
| 取回 | 拒绝 | 接受，什么都不动 | 原路径空着：挪回去，接受。原路径被占：拒绝 |

这里的「东西」是文件或带标记的目录，目录整个一起动；打开的和关着的目录都不是东西，以「没有这个文件」拒绝。实现按四种状态判：两处都没有；只在主区；只在归档区（原路径空着）；两处都有（原路径被占）。两处都有时，归档按「在主区」办，取回按「原路径被占」拒绝。取回时原路径上的任何东西都算占着。路径在一个带标记的目录里面时，归档和取回都以 `inside-bundle` 拒绝；路径是噪音时以 `noise` 拒绝。路径写成 `a.md` 或 `_archive/a.md` 都指同一样东西。接受的结果带 `moved`，什么都没动时为 `false`。

每次挪是存储的一次带预期的 `move`（`archive.ts`）：来处预期是看到的令牌，去处预期是空的（或内容相同的那份的令牌）；来去两处在挪和所有插件的 `onArchive` 期间被占着。归档区的那个位置空着时不读任何内容；被占着时才读两边的指纹，判是不是同一份、加什么后缀。位置被别的写占着，或在这中间变了，以 `busy` 拒绝，什么都没动；取回时原路径在这中间被占了，是 `original-path-taken`。取回之后，挪走的那样东西在归档区留下的空文件夹逐层去掉，直到 `_archive/` 为止：先瞥一眼它的令牌，再看它确实是空的（也没有噪音），然后带着这个令牌删掉；这中间有东西放进去，删除不成立，文件夹留着。

找和查默认跳过归档区，`includeArchived` 打开才带上。看一样已归档的东西照常给出，并标明它已归档。命令行里除了 `find` 和 `check`，库的目录树本身也把归档的东西隔开了，agent 用自己的工具翻目录时同样看不到它们混在里面。

**看。** 目标是一样东西时（主区的先，再是它在归档区的那份；写成 `_archive/…` 就是归档区的），`file` 是存储此刻说的它：令牌、修改时刻、文件的大小、目录条目的第一层；`fingerprint` 只在要了内容时读，否则是 `null`。目标是一个不是东西的目录时，`place` 按它是哪一种答：打开的，给它的第一层；关着的，给一次预算 500 项的探查：至少几个文件、是否超出预算、顶上有哪些项目标记（`package.json`、`.git` 这类）；噪音，说是哪个名字或哪条路径让它是噪音。目标是一个请求号时给那个请求。插件的 `onInspect` 照旧只给它们知道的。

**看内容。** 命令行的 agent 自己读文件；经 MCP 的 agent 读不了，只能找和看。所以看可以带上内容：`inspect <库内路径> --content`。文件是 UTF-8 文字、不超过 256 KB 时给全文（`text`），一篇长文档、网站的一页放得下，一份导出的数据放不下；别的给大小和文件名说的媒体类型（`other`，`why` 是 `not-utf8` 或 `too-large`，超过上限的不读，内容不在本机的也不下载）；带标记的目录给它的第一层（`level`），`--content <内部路径>` 给里面那个目录的一层或那个文件的内容，标记文件不给，爬不出去；写目录里的文件的库内路径也一样。内容经存储读（`content.ts`），只因为要了才读。授权限在一个区域时，区域外的东西照样给事实（今天的看、找、查都不按区域限读，区域只限写），只是不给内容（`unavailable`，`outside-grant`）；归档的东西按它原来的路径算。只读的授权读得了区域里的内容。

**查和深查。** `check` 不读内容：插件拿存储的令牌比它记过的位置。`check --deep [<目录>]` 是有名字的全量动作：读登记过的每样东西的内容（写了目录就只读那下面的），比出真正改了的。内核把它原样交给插件（`CheckRequest.deep`，`dir` 为 `null` 是整个库，命令行写 `.` 也是），先说范围、报进度、可以打断，归做这一趟的插件。目录只和 `--deep` 一起写，否则是用法错误。命令行、界面的 `Call`（`parseCall`）和 MCP 的 `check` 工具收的是同一份请求。

命令行另有一个 `start "<一句话>"`，是「说：在做什么」「查」「找」三个动词的组合，不是第八个动词。

`start` 和 `check` 印的字最多 8 KB（`packages/cli/src/format.ts` 的 `bounded`）。再多就停，最后一行说后面的没有印出，状况的全部在 `show ledger.standing`，要主人做的在首页的「等你决定」。库再大，这两个答复也放得进 agent 的上下文。

命令行另有一个 `show [<视图编号> [--<参数> <值>…]]`：管理界面的一页，只读，也不是动词（第 6 节「只读的一面：视图」）。不写编号列出这个库的页。

命令行是全部本事的准绳，管理界面、MCP 服务和本机的 endpoint 是它的面，答复一一对应：界面上的每个按钮是一个动词或一条主人命令（`Call`），表单出自命令的参数表；界面上的每一页是一条只读的命令，`show` 把它印成字；MCP 的每个工具是一个动词或一条 agent 能用的命令，输入出自同一份参数表，答的是命令行印的字和 `--json` 的结果（第 6 节「MCP 服务」）。除了管理的那部分归主人，每样本事 agent 和人一样。两个方向都有测试守着（`packages/cli/test/pages.test.ts`、`mcp.test.ts`）：每一页印得出来，字里有每一格和每个按钮的命令，每个按钮调得到一个动词或一条在的命令；每个动词和命令在界面上有按钮，或是一页读的东西，没有的列在测试里，写明为什么；每个动词和 agent 能用的命令是一个工具，管理的命令都不是。

动词的参数也是数据，和主人命令的参数表同形，只有一张表（`packages/cli/src/verbs.ts`）：每个动词的位置参数和开关各带名字、`hint`、种类，另有三样主人命令没有的：`words`（其余的词用空格连成一句，`start` 和 `find` 的文字），`more`（没声明的开关收在一个名字下：`say` 的归听这个种类的插件，`show` 的是页的参数），`stdin`（这个位置参数写 `-` 时读标准输入，`put` 的）。命令行按它读一个动词的词、定参数个数，MCP 服务按它生成工具的输入，两边都把读出的值交给同一个 `run`。`--help` 的用法那几行仍是写给人看的。

### 请主人做

管理的事归主人（第 6 节「只给主人」）。agent 要其中一件时，第七个动词 `ask` 把它记成一个请求：一句为什么，和那条主人命令连同参数，照原样。主人批准就以主人此刻的身份照原样跑，或拒绝，可以带一句理由；agent 下次 `check` 时看到结果。它守的是 K7：管理的决定仍然只由主人做，门一道没少，agent 只多了一种说出它要什么的办法。请求没有插件的槽，内核自己做，所以空目录里也成立。

```ts
type AskRequest = { kind: 'ask'; why: string; command: string; args: OwnerArgs } | { kind: 'withdraw'; id: string }
type RequestStatus = { kind: 'pending' } | { kind: 'withdrawn'; at } | { kind: 'declined'; at; reason: string | null } | { kind: 'approved'; at; outcome: RequestOutcome }
type RequestOutcome = { outcome: 'done'; text } | { outcome: 'refused'; reason; text } | { outcome: 'failed'; error }
type OwnerRequest = { id: RequestId; by: { name; grant }; at; why; command; args; line; status: RequestStatus; seen: boolean }   // line：照原样会跑的那一行
type AskResult = { outcome: 'asked'; request; again: boolean } | { outcome: 'withdrawn'; request } | { outcome: 'refused'; reason: AskRefusal; text }
```

提的时候内核就核对，用法错误马上回给 agent：只有 agent 能提（`not-an-agent`）；命令要在（`unknown-command`）；参数按那条命令自己的 `params` 核对，为什么不能空（`usage`，命令行退出码 1）。能请的只有只给主人、不破坏、没标 `askable: false` 的命令：破坏性的以 `red-line` 拒绝，它要主人当面确认；`secret set`（值要主人亲手给）和三条请求命令标了 `askable: false`，以 `not-askable` 拒绝；agent 自己能跑的以 `run-it-yourself` 拒绝，话里带它自己跑的那一行。同一个 agent 还在等的、`line` 相同的是同一个请求，再提答同一个号（`again`）；一个 agent 最多 20 个在等的（`too-many`）。`ask --withdraw <号>` 只撤自己的、还在等的（`no-such-request`、`not-yours`、`not-pending`）。

主人面三条命令，都只给主人，都不能被请：`request list [--all] [--older]` 印的和 `show home` 里请求的那几行一样，`--all` 再列最近 50 个了结的，并说更早的还有几个，`--older` 全列；请求的事实一条不删，它们就是记录；`request approve <号>` 经 `ownerFace.dispatch` 跑那条命令，主人调用带着 `request`（号和谁请的），所以那条命令自己的事件也带着它（第 5 节的 `Event`）；跑出什么就是结果，拒绝也算，参数后来不合了记成 `no-longer-fits`；那条命令后来成了破坏性的或不能被请的，批准不跑它，以 `no-longer-askable` 拒绝并记成结果，因为批准不是当面确认；`request decline <号> [<理由>]`。了结了的请求不能再决定（`not-pending`）。

**一件事只问一次。** agent 请的那条命令连同参数，和某个插件 `onAsks` 的一个回答调的主人命令和参数一样时，请求代替那一问：请求在等时，首页和 `check` 只给请求，带着它的为什么；主人拒绝之后，两样都不再提；批准就跑了那条命令，插件之后还问的就是新的事。这是内核的通则（`asks.ts` 的 `standsIn`：同一条命令、同样的参数，参数里的旗子不论次序），不认识部署或任何插件。

在 agent 的会话里被拒的只给主人的命令，能请的，拒绝的话最后一行就是那条 `ask`：`pneuma-base @<授权名> ask "<为什么>" <命令和参数>`。首页的「等你决定」先列请求：为什么是那一句，由提的 agent 署名，下面一行是照原样会跑的命令，按钮是「批准」（推荐）和「拒绝」（可填理由）；决定了的折成一行结果。`check` 多一节「你提的请求」：上次看过之后主人决定了的，各带结果，和还在等的个数；看过的下次不再说。`inspect <号>` 给一个请求的全部。

请求是内核的记录处 `requests` 的事实（`requests.ts`），经存储写在 `.pneuma-base/requests/facts/` 下，只追加，跟着文件夹和同步走，不放在本机的目录里。号是 `r-` 加 8 位十六进制。每条事实带它说的请求号，是四种之一：`asked`（谁、哪次会话、为什么、命令和参数）、`withdrawn`、`decided`（批准带结果，拒绝带理由）、`seen`（提的 agent 看过结果）。一个请求的现状是从这些事实推出的一行，在记录处的行里（存储的缓存区），按提的人和在不在等可查；归并时决定压过撤回，有两条决定时早的那条算数，`seen` 只在了结之后算。去重和上限在折事实时定：一条 `asked` 折进来时，同一个 agent 已经在等同一行，它就记成那个请求的重复，答原来的号（`again`）；已经有 20 个在等，它就记成超了，答 `too-many`。两个进程同时提，各自按存储给的次序折同样的事实，定出的一样，不用锁。此前版本一个请求一个文件（`requests/<号>.jsonl`），新版不读它们：旧库除了事实文件不迁移。

### 没有任何插件时的答复

| 动词 | 答复 |
| --- | --- |
| 放 | 按上面的全化表。接受时 `notes` 为空。放入遇到内容不同的同名文件：拒绝 |
| 找 | 一条都没有：内核不按名字找，那要走一遍库 |
| 看 | 这样东西此刻的样子（文件或带标记的目录），或这个目录、这处噪音是什么（`place`），`sections` 为空；要内容时照样给 |
| 说 | `not-heard`，`no-plugin-for-kind`，附一句「这个库没配能记下这句话的插件」 |
| 查 | `sections` 为空 |
| 归档 | 按上面的全化表 |
| 请 | 按上面「请主人做」，和有插件时一样 |

## 5. 扩展点

插件必须做什么、可以依赖什么，写在 `PLUGINS.md`（插件规范）：每个钩子什么时候被调、拿到什么、能答什么，退出码，主人命令的参数表和门，块的字段和插件自己画的页，能写哪里，上下文里的工具，开发包里的库，符合性检查，装和卸。它和库的格式是 1.0 要冻结的两样，`packages/cli/test/plugins-doc.test.ts` 跑它的每条命令、编译它的每段代码，并核对它点名的检查都在。这一节只写内核为什么这样、怎么实现。

```ts
interface Plugin {
  readonly contract: number                     // 按哪一版插件契约写的：sdk 的 CONTRACT（现在是 2）；内核跑 1 和 2
  readonly name: PluginName
  readonly version?: string                     // 它自己的版本，给人看
  readonly summary?: string                     // 一句中文，说它带来什么，给人看
  readonly cognition: CognitionSection | null   // 拼进说明的那一段
  readonly keeps?: 'every' | 'some'             // 有 revise 时：换下的内容都留住，还是只留一部分（缺省）
  readonly storage: StorageDecl[]               // 它名下的目录，各是本体还是缓存
  readonly statements: string[]                 // 「说」里它听得懂的种类
  readonly secrets?: SecretDecl[]               // 它用 ctx.secrets.get 读的凭证，各带一句中文说明做什么用

  // 钩子都是函数类型的属性，不是方法，所以参数按契约严格检查
  readonly onPut?: (req: AcceptedPut, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly revise?: (req: PlaceOverExisting, ctx: PluginContext) => Promise<ReviseOutcome>   // 可撤回的改
  readonly onFind?: (req: FindRequest, ctx: PluginContext) => Promise<PluginFindAnswer>
  readonly onFound?: (paths: LibraryPath[], req: FindRequest, ctx: PluginContext) => Promise<PluginHit[]>   // 别人找到、它没给命中的路径，它知道什么
  readonly onInspect?: (req: InspectRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onSay?: (req: SayRequest, ctx: PluginContext) => Promise<SayAnswer>
  readonly onCheck?: (req: CheckRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onAsks?: (ctx: PluginContext) => Promise<PluginAsk[]>   // 只有主人能定的事：首页的「等你决定」和 check 的「要主人来做的」
  readonly onArchive?: (req: AcceptedArchive, ctx: PluginContext) => Promise<PluginNoteAnswer | null>

  readonly observe?: (event: Event, ctx: PluginContext) => Promise<void>   // 两个面的每次操作之后
  readonly onPurged?: (paths: LibraryPath[], ctx: PluginContext) => Promise<void>   // archive purge 删了东西之后，路径是它们在归档区时的
  readonly onAdd?: (ctx: PluginContext) => Promise<void | { problems: string[] }>   // plugin add 装上它之后，一次
  readonly onRemove?: (ctx: PluginContext) => Promise<void | { refuse: string }>    // plugin remove 卸下它之前
  readonly openDirs?: (ctx: PluginContext) => Promise<LibraryPath[]>                // 它的记录让哪些目录成为打开的
  readonly ownerCommands: OwnerCommand[]                // 它给主人面加的命令，名字以 `<插件名> ` 开头；每条带参数表 params

  readonly views?: ViewDecl[]                           // 它给管理界面加的视图，编号以 `<插件名>.` 开头
  readonly onView?: (req: ViewRequest, ctx: PluginContext) => Promise<ViewAnswer>
  readonly onItemView?: (path: LibraryPath, ctx: PluginContext) => Promise<ItemSection | null>   // 「看」在界面上的对应物
  readonly ui?: string                                  // 它自己画的页所在的目录，绝对路径（第 6 节）
}

type PluginNoteAnswer = PluginNote | { note: PluginNote | null; problems: string[] }   // onFind 的 { hits, problems } 同理
```

一个只有契约版本、名字、其余全空的对象是合法的插件，所以「什么都不装」和「装了一个什么都不做的插件」走同一条路，空实现不用特判。sdk 的 `definePlugin(plugin)` 原样交回它，只为让钩子在写的地方就按契约检查。钩子写成属性而不是方法：方法的参数在 TypeScript 里是双变的，写错了参数类型也能赋给 `Plugin`。

内核这边的实现：

- 每个钩子由 `eachPlugin` 按配置次序调，一个插件抛错记成它的问题，其余照样调（K8）；答复不写插件名，由内核盖上（`PluginNote`、`PluginSection`、`PluginHit`）。`onPut`、`onArchive` 的答复和 `onSay` 听到时的答复可以在说明旁边带 `problems`：部署插件这样说「放入成功了，上线没跟上」，不用再拿抛错表达一半成功。
- 钩子收到的上下文另带 `dir`、`cacheDir`、`tools`、`secrets`，由 `pluginContext` 在每次调钩子时造。`dir` 是插件记录处的路径 `.pneuma-base/<插件名>/`，内核不建它：第 2 版的插件经 `tools.storage.own` 读写那里，第一次写就建立它；`tools.storage.records` 是它的事实和行。
- 跟着挪和归档的插件用 `onPut`、`onArchive`：只有这两个钩子收到内核解析过的路径，`observe` 里的请求是调用方写的原样。
- 主人面命令的 `destructive`、`ownerOnly` 由内核在同一处拦（第 6 节），插件不看上下文；`readOnly`、`setup` 只是事件上的记号，记账插件据此决定它算不算给 agent 的消息。主人面的事件带这三个标志，插件不用自己认哪些命令会丢数据、哪些什么都不改。
- `keeps` 定说明里同名时的那句话（第 7 节）：记账插件是 `every`，版本插件是 `some`。
- `onPurged` 让插件不用比命令名、不用读 `archive purge` 的 `data.paths`；`onAdd`、`onRemove` 让插件听得到自己被装上和卸下。`onRemove` 可以拒绝，但主人总能 `--anyway`：插件提醒，主人决定。
- 问主人（`onAsks`）：插件说出它此刻在等主人定的事，每件一句话、关于哪样东西、几个回答（动作）、推荐哪一个。它只读，不写东西：首页每次显示、`check` 每次答都问一遍，插件按自己记的状态答，主人定了，下次就不再问。内核按配置次序问（`asks.ts`），像核对块一样核对每一件（不是一件的、回答调不到的、推荐的不在回答里的，不要，列进问题），盖上插件名（`by`）。`check` 的答复带着它们（`CheckResult.asks`），命令行印在「要主人来做的」下面，每个回答印成主人在自己终端里跑的命令；首页把它们放在最上面。
- 打开的目录（`openDirs`）：插件说它的记录让哪些目录打开，内核再加上库根（`places.ts` 的 `openDirectories`）。界面的变化轮询看这些目录（第 6 节「界面的服务」）；登记一个打开的目录是登记它这一层的散文件（第 4 节「放」）；看一个打开的目录给它的第一层。
- 视图槽（第 6 节）：编号不以插件名加点开头的视图不列出，记成问题；`onView`、`onItemView` 抛错或答的不是一页、一节，那里换成说明出错的块（K8）。视图不是操作，内核不为它们发事件。

### 命令的参数表

每条主人命令都声明参数表 `params`，命令行、核对、帮助和界面的表单都从这一份来，不会说两样。试做的插件里，命令行按自己的表读参数、帮助是手写的一句、表单是另一份手写的输入，三处各说各的。

- 命令行先取出每条命令都有的 `--library`、`--as`、`--session`、`--json`，认出命令名，再按这条命令的参数表读其余的：开关不吞后面的参数，列表正好收它的值。参数表没声明的开关读成开关，再由内核以「不认识」拒绝。只有 `say` 不按参数表读：它的参数是插件的。
- 内核在门里、`run` 之前核对（`params.ts`），不对就以 `usage` 拒绝，`run` 不被调；值去掉两头空白，空的算没给，所以表单留空的一项等于没写。
- `usageOf` 和 `formOf` 在 sdk 里，插件和内核共用：`--help` 的用法和界面上运行带参数的命令的表单都由它们生成。
- 装载插件时（自带的和库外的一样）核对参数表的形状。

### 名字只归一个插件

插件认领的名字是三样：「说」的种类、主人命令名、视图编号。`plugin add` 遇到一个名字已被已装的插件认领，就以 `name-taken` 拒绝，说出每个名字归谁、要换用它先卸下哪个；`init` 一次装几个插件时同样核对，撞名就以 `name-taken` 拒绝，不建库。配置被手改或同步过来、已经有这样的撞名时，库照样打开：按配置次序，后面那个插件撞上的名字不接上，每个记成它的问题，在每个答复里列出，和坏掉的插件一样（K8）。实现在 `claims.ts`。这条的来由：试做时两个插件都听 `say deployable`，后装的那个悄悄地什么都听不到。

### 上下文里的工具

`PluginContext.tools` 是插件正当需要的内核工具，绑在这次操作的库上，没有一个要传库根。类型在 sdk，代码是正在跑的内核的，所以目录条目算哪些文件、找怎么切词排序，插件和内核永远一致，库外的插件不再抄一份。第 2 版的工具用存储的词，只在插件的记录指到的地方问存储，没有一个工具走库，列出的都是一页：

| 组 | 工具 |
| --- | --- |
| 路径 | `resolve(输入)` → `{ path, region, bundle } \| null`；`regionOf`、`archivedPath`、`originalPath` |
| 东西 | `what(路径)`：每个路径上是文件、目录条目、文件夹、别的还是没有，带存储的描述；一次看一眼这些路径和它们的标记。`markBundle(目录)`：写上内核的标记，让它成为一样东西，标记的内容只在内核里 |
| 找 | `searchTerms`、`rankHits`、`sentenceHits` |
| 放 | `put(请求)`：经 agent 面放入，行动者和会话是这次操作的，所以每个插件都听到、它发自己的事件 |
| 存储 | `storage`：放东西的地方的 `glance`（几个位置各是什么）、`overview`（一个目录的一层的一页，缺省 200 项，最多 1000）、`look`（拿存着的令牌比，答哪些变了、不在了、被占着；预期写 `empty` 是那里该什么都没有）、`lookRows`（预期在它自己的一张表里：存储按行比，一页至多一万行，只答不同的）、`content`（读内容取指纹；目录按内容规则，超过 5000 个文件答 `too_many`，带 `manifest` 时另答它算出的清单的一页）、`read`（字节，或写到库外的一个文件）、`write`（带预期；来源是库外的路径、字节或库里的一个位置，后者就是复制，`own: true` 指它自己记录处里的位置）、`move`、`remove`（都带预期）；`probe`（一个目录至少有多大，数到预算为止）、`noise()`（库根声明的噪音）、`hold`、`release`、`changed(mark)`；`own`：它记录处自己的地方，同一组放东西的操作；`records`：它的事实（`append`、`since`）和行（`put`、`get`、`under`、`where`、`count`、`reset`） |

**存储。** 库最底下的一层是存储，程序 `pneuma-base-core`，契约在 `STORAGE.md`，线上的形式在 `core/README.md`。内核唯一的门是 `packages/kernel/src/storage.ts`：每个库、每个进程起一个 `serve`，一次收发一行 JSON，只在有请求等着时让这个进程开着。找程序的次序是 `PNEUMA_BASE_CORE`、内核包的 `bin/`（包文件把它带在那里）、仓库里的 `core/target/release` 和 `core/target/debug`。内核的动词、页、请求、声明和说明都经它。插件拿到的 `tools.storage` 绑在它自己的记录处上，记录处的名字就是插件名：事实在 `.pneuma-base/<插件名>/facts/` 下，只追加；它自己的地方是 `.pneuma-base/<插件名>/` 里事实以外的部分，留存、版本这类内容放在这里，从库里复制过去就是一次 `write`；行从事实推出，在存储的缓存区（第 8 节），可以丢掉。`content` 和 `write` 对目录总按内容规则。令牌对内核和插件是不透明的，只存着、交回去；比较由存储在 `look` 和每次写的预期里做。

**变化。** 存储的 `changed` 答自一个游标以来动过的位置，带一个时间预算。常驻的进程去听，一次性的命令不回放（`changes.ts`）：界面的服务第一次为一个库答请求时订阅它的变化（存储的 `subscribe`），关掉时退订；存储把听到的记进缓存区里的一份小日志，有进程在听时，任何进程的 `changed` 都从这份日志答，代价只跟变了的东西走。插件的 `tools.storage.changed(mark)` 带着它上次拿到的游标、5 毫秒的预算问，答这之后动过的位置和新的游标；没有进程在听，存储立刻说不出（回放系统的变更日志要读这个卷上的每个事件，至少 13 毫秒，不在 5 毫秒里），位置是 `null`：读的一方拿令牌比它记过的位置，从不走库；它把对每个位置的预期存成自己的一张表，存储在里面比（`lookRows`），只把不同的交回来。一次答出超过一万个位置也算说不出。两条路答的是同一个问题，结果一样（`packages/cli/test/listener.test.ts`）。存储没有可靠的游标时（Linux 上就是），没有什么可听，每次都说不出。

**目录的三种。** 每个目录是哪一种由记录推出，不存在任何地方（`places.ts`）：打开的，任意深处有登记过的东西，库根总是；是一样东西的，整个目录登记成一样东西；关着的，其余的，只算上一层的一项，从不打开。插件用 `openDirs` 说它的记录让哪些目录打开。内核和插件只在这三种说到的地方问存储：打开的目录列一层，关着的目录只探查，不进去，除非主人明说（`ledger register <目录> --inside`）。

**第 1 版。** `tools` 上还有第 1 版的工具（`abs`、`thing`、`things`、`files`、`copyOut`、`fingerprint`、`manifest`、`fingerprintOfManifest`、`fingerprintOfFile`、`putting`），给还没挪到第 2 版的插件用，sdk 的类型里标着弃用。它们写在存储的操作上（`contract-v1.ts`），不直接读库：`things` 和 `files` 经存储一层一层地走，`fingerprint` 和 `manifest` 经存储读内容，代价是第 1 版本来就有的；`putting()` 总是空的，正在写的位置在 `look` 和 `overview` 里标着被占。声明了第 1 版的插件听到的放也照第 1 版：`onPut` 的 `fingerprint` 总有，放没读内容时内核为它读；`register-files` 拆成每个文件一个 `register`；`previous` 是一个指纹；装着这样一个有 `revise` 或 `onPut` 的插件时，被换下的那份的指纹在写之前读好。这一层下一步随还没挪的插件一起删。

`shortDir` 和 `withSuffix` 只是把字写给人看，不涉库的事实，不进 `tools`；`pluginName` 是 sdk 的构造。自带插件这一程照旧直接导入内核。

### 库外的插件与缓存

- 插件表 = 命令行自带的插件 + 本机的 `$PNEUMA_BASE_HOME/plugins/<名字>/`。加载在内核导出的 `loadPlugins(home, 自带的表)` 里，命令行每次调用用它建表，界面的服务每次请求用它建表。自带插件的名字不会被本机的插件占用。
- 装载器不替插件设 `ui`：插件自己写，比如 `new URL('./ui/', import.meta.url)`。没有 `package.json` 的目录，`plugin install` 写一个 `{ "type": "module" }`，让 `.js` 怎么载不取决于 `$PNEUMA_BASE_HOME` 上面有什么。
- 改了就重新载入：装载器按目录里每个文件的名字、大小、修改时间算一个戳，`index.js` 带着戳导入，一个模块钩子（`registerHooks`）让它从目录里导入的每个模块带上同一个戳。目录里任何文件一变，下一次 `loadPlugins` 就载入整套新的；没变就用进程里已有的。所以一直开着的界面服务在插件的文件变了之后的下一次请求就用新代码，不用重启。同一个目录的两份副本、装之前核对的那份，各是各的模块，互不影响。
- 装载时核对不必调钩子就能核对的一切（`whatIsWrong`，清单在 `PLUGINS.md` 第 8 节）；留到调用时的是钩子和命令的 `run` 答什么、抛不抛错（K8），插件往哪里写。自带插件过同一道检查，没有例外：过不了是这个 pneuma-base 自己的错，`loadPlugins` 抛错。内核自己不听任何「说」的种类，所以种类只会和别的插件撞，那由 `plugin add` 管。
- `plugin add` 和 `plugin remove` 是一个库里的启用和停用，`plugin install` 和 `plugin uninstall` 是这台机器上有没有；装、卸都先写临时名再改名，没有装了一半的插件被载入。库的配置里只写名字。
- 本机的插件加载失败，它不进插件表；装了它的库照「装了但这台机器不认识」处理（K8）：每个答复的 `problems` 里有它，消息是加载失败的原因（`whyNotLoaded`，中文）。
- 缓存目录 `PluginContext.cacheDir` 是 `$PNEUMA_BASE_HOME/cache/<库的 id>/<插件名>/`。放在库外，因为库会被同步工具整个同步，而索引这类文件经不起同步。内核不建它。库的 id 因此只能是字母、数字、连字符和下划线。`Context` 带 `home`，即本机的 `$PNEUMA_BASE_HOME`，由建上下文的地方传进来；`cacheDir` 由它算出。
- 密钥放在 `$PNEUMA_BASE_HOME/secrets/<插件名>/<密钥名>`，一个密钥一个文件，内容就是值；目录是 `0700`，文件是 `0600`，先写临时名再改名。放在库外，所以任何同步都带不走；值不出现在任何答复、事件、视图里。插件声明的密钥可以标 `optional: true`：配置页写「没设（可选）」，`secret list` 另列一行。主人用 `secret set` 设，值从标准输入读，从不取命令行的参数：参数会留在 shell 的历史和进程列表里。界面的配置页设密钥时，值作为命令的标准输入送去（`Call` 的 `stdin`），不进事件；界面的服务读写同一处。

### 写一个库外的插件

- 两个包文件，`pnpm pack:dist` 打进 `dist-packages/`（不进 git，不发布）：`pneuma-base-<版本>.tgz` 是命令行，内核、五个自带插件、界面的服务和网页都作为捆绑的依赖在里面，内核的 `bin/` 里是这台机器上 `pnpm build` 构建的存储程序（所以包文件只在和打包的机器同一种系统和处理器上能用），另带插件规范 `PLUGINS.md`，`npm install` 它不用别的包，也不用联网；`pneuma-base-sdk-<版本>.tgz` 是 `@pneuma-base/sdk`，不依赖这个仓库的别的包，声明文件自成一体。两个的版本都是 sdk 的 `PNEUMA_BASE_VERSION`，自带的五个插件的 `version` 也是它，每个工作区包的 `package.json` 和它不一样时打包拒绝。实现在 `scripts/pack-dist.mjs`。
- 测试工具 `@pneuma-base/sdk/testkit` 跑真的命令行，不另造一个假的内核：插件在测试里和在主人的机器上走同一条路。调用的环境从空的建起，所以没有任何 agent 产品的会话变量。`serve(handler)` 起一个库外 HTTP 服务的替身、交回地址，沙箱收尾时一起停，所以目标是网络服务的插件不连真的服务也能跑符合性检查和自己的测试；`viewer().item(路径, { plugin })` 只要一个插件的那一节。沙箱总设 `PNEUMA_BASE_TOOL_LOG`（`toolLog`），内核把插件向存储要的每次一览、探查、取内容和读记成一行。沙箱建在 `$PNEUMA_BASE_TEST_TMP` 下，没设时在系统的临时目录下。
- `conformance` 把规范里行为上的规矩跑成检查（十项，见 `PLUGINS.md` 第 7 节），每项的规则文字在 `RULES` 里，报告原样引用，规范也原样引用（`plugins-doc.test.ts` 核对）。`loads` 要插件按 sdk 的 `CONTRACT`（2）写。`bounded` 读工具日志里每一步、每个视图新添的行：插件对内容的一览和探查合起来不超过 1000 条，也不碰脚本放进库里、没人登记的两个目录（一个有 1,200 个文件，一个谁都读不了，收尾前把权限还回去）。破坏性的主人命令经界面的服务跑，带着界面那样的当面确认，只许它改自己的目录。各项检查比较库里改了什么时都不看存储的临时区和缓存区（`.pneuma-base/tmp`、`.pneuma-base/cache`）：缓存区里是存储为每个插件推出的行，随时可能改写。`custom` 页不在浏览器里跑：只读页和它直接载入的脚本，看它载入 `/plugin-kit/frame.js`、调用 `pneuma.onData`。仓库自己的测试拿它查自带的五个插件，也拿故意违规的插件看每条检查都会变红（`packages/cli/test/conformance.test.ts`）。
- 脚手架 `pneuma-base plugin new` 是命令行的命令，不是内核的：它只从命令行包里的 `templates/` 写一个项目目录，不碰库，不碰 `$PNEUMA_BASE_HOME`，不发事件。生成的项目按绝对路径依赖两个包文件（`--packages` 给的目录；没给时按包名，发布之后才装得上），所以项目挪到哪里都装得上；`plugin new --help` 说它自己的用法；esbuild 打成一个 `dist/index.js`，旁边是 `cognition.md` 和 `ui/`；测试用 Node 自己的测试运行器，直接导入 `src/` 的源码。它的答复和生成的 `README.md` 指向插件规范。两种项目都不改一行就通过自己的测试：`packages/cli/test/scaffold.slow.test.ts`（`pnpm test:slow`，要联网）把生成的项目先挪到别处，再从安装一直走到装进库、调命令、开视图；`plugins-doc.slow.test.ts` 照原样跑规范里从安装开始的例子。

插件的规矩写在 `PLUGINS.md` 第 3.7 和第 6 节：只往自己名下写，不改别的插件的东西，不认识的内容原样留着，agent 面上做的事主人撤得回。记录只新增；只有破坏性的主人命令删、改写插件自己名下的文件，主人总能丢掉数据，同步插件把这样删掉的文件在别的副本上也删掉（第 12 节）。插件可以做要模型、要联网、带判断的事；内核不做。

## 6. 两个面

| | agent 面 | 主人面 |
| --- | --- | --- |
| 能做什么 | 七个动词，其中「请」把一条只给主人的命令交给主人决定；看管理界面的每一页（`show`），管理的页除外 | 建库、改配置、装卸插件、发和撤授权、生成技能、接上和断开 agent、清留存、清归档、丢数据；在这台机器上装卸插件、设密钥 |
| 破坏性 | 没有 | 有。要人在终端当面确认；在 agent 的会话里被拒绝 |
| 只给主人 | 不适用 | 不丢数据、但替主人做决定的命令（对外发布、设部署和同步的目标、设嵌入器、发撤授权、接上和断开 agent、装卸插件、取回留存、设密钥）：在 agent 的会话里被拒绝，不用确认；agent 可以用 `ask` 请主人做（第 4 节「请主人做」） |
| 留痕 | 每次调用之后发一个事件 | 同样。主人可以关 |

「在 agent 的会话里」的判断：环境里有 agent 产品的会话变量，或调用带着授权，或行动者被 `--as` 写成了一个 agent。拒绝的话说出是哪一样让它这样判的。这是第二级的拦法，和认知里的「不该做」一起构成默认强度。让 agent 对库的目录没有直接写权限是第三级，靠 agent 产品自己的沙箱，是装的时候可选的。

### 主人面的一个入口

主人面的命令都是数据：名字、一句说明、参数表、是否破坏性、是否只给主人、是否只读（可选）、是否配置（可选）、能不能被请（`askable: false`，可选）、`run`。内核自己的二十六条在 `owner-commands.ts`、`agent-commands.ts`、`launcher.ts`、`request-commands.ts`、`pair-commands.ts` 和 `noise-commands.ts`，都带参数表，和插件的 `OwnerCommand` 同形，只是 `run` 收到整个主人调用（上下文、插件表、环境、是否带授权、怎么问当面确认、怎么读主人另给的值；本机的家目录就是上下文的 `home`），并可交回重开的库。其中十六条要一个库（`grant issue`、`grant revoke`、`plugin add`、`plugin remove`、`skill install`、`archive purge`、`agent connect`、`request list`、`request approve`、`request decline`、`pair list`、`pair allow`、`pair decline`、`noise list`、`noise add`、`noise remove`）；十条只动这台机器，有没有库都能跑（`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`、`agent detect`、`agent list`、`agent disconnect`、`launcher install`）：没有库时上下文的 `library` 是 null，没有插件可告诉，不发事件；带着库（比如从界面）时照常在单一出口发事件。

- `ownerFace.commands(插件表)` 列出可用的命令：先内核的，后各插件的，按配置次序；名字已被占的不再列，插件盖不住内核的命令。命令行的 `--help` 用它列出主人命令：带 `--library` 或 `@<授权名>` 时是那个库的，否则是内核的。
- 门：破坏性的和只给主人的，在 agent 的会话里都以 `agent-session` 拒绝；然后按参数表核对；破坏性的再要当面确认。终端里只有输入 `yes` 才算确认；别的回答、输入结束（Ctrl+D）、不在终端里，都以 `not-confirmed` 拒绝。内核自己的命令里，`archive purge` 是破坏性的，`skill install`、`plugin list` 和 `noise list` 谁都能跑，其余只给主人。能被请的命令在 agent 的会话里被拒时，话的最后一行是请主人做它的那条 `ask`（`ownerOnlyRefusal`）；破坏性的和 `askable: false` 的没有这一行。
- `ownerFace.dispatch(主人调用, 命令名, 参数)` 是唯一的入口，命令行和界面的服务都走它。命令经同一道门（K7），在单一出口发事件（K5）。
- 没有这条命令：在任何操作开始前拒绝（`unknown-command`），不发事件。要库的命令没给库，同样在开始前拒绝（`no-library`）。
- 参数不对：以 `usage` 拒绝，说出哪一样不对，带参数表生成的用法；命令行把它当用法错误，退出码 1。表单里留空的可选值等于没给；开关在表单里写成值 `yes` 或 `no`。
- 主人另给的值，比如密钥：命令行从标准输入读，在终端里不回显地问；界面的服务取 `Call` 的 `stdin`。它不在参数里，所以不进事件。

命令行只做三件事：认出命令名（第一个开关之前的那几个词，取字数最多的那条，内核命令的字数多过同名的动词时取内核命令，所以 `archive purge` 不是归档一个叫 purge 的文件），按那条命令的参数表读其余的（第 5 节「命令的参数表」），以及定库。`skill install` 的库由它的授权名经本机的授权副本定出；不用指明库的那几条没给库就不带库跑；其余用 `@<授权名>` 或 `--library`。

### 只读的一面：视图

管理界面是内核的一个客户端：看用视图，改用 agent 面的动词和主人面的命令。视图不是操作，不改东西，不发事件。K5 说的是两个面的操作。

视图是只读的命令，答复是带类型的块。命令行的 `show <视图编号> [--<参数> <值>…]` 和界面走同一个 `viewerFace.show`，`--json` 给的就是界面拿到的答复；不写编号时列出 `viewerFace.views`，每页带是谁给的（`by`）。文字是块的如实转写：分节是标题带说明和数目；表格对齐成列、带表头，标签、外部地址都在，不截短，行的链接写成打开它的 `show` 命令；字段是「名字：值」；时间线和带 `at` 的格按命令行的习惯写 UTC 的时刻；文字的语气是警告或出错时前面写上；预览写路径，外部页面写地址，空状态写标题和提示，`custom` 写它的 `text`。块上的每个动作印成做同一件事的命令（`$ say revised notes/a.md  # 认下这次改动`），agent 的会话会被拒的标「（只给主人）」，要先问的跟着问话，没填的输入照用法写成 `<提示>`。agent 带授权或 `--as` 能看每一页，和 `inspect` 一样什么都不改、不发事件。管理的页声明 `ownerOnly`（内核的 `config` 是），在 agent 的会话里以 `agent-session` 拒绝，话和只给主人的命令被拒时一样（`ownerOnlyRefusal`），判断也在同一处（`agentSign`）。没给的筛选取它的 `default`，由内核填，界面和命令行一样。

界面重取一个视图只在三种时候：库的摘要（`/api/rev`，界面每两秒问一次）变了；做完一个动作；视图的答复带 `refresh: <秒>` 时，每隔这么久一次，少于 5 秒按 5 秒。另外，连不上服务之后又连上时取一次，补上断着时没取到的。没有别的会让视图重算。所以视图可以读库外的东西（比如部署目标上的状态），只要不写；状态来自库外的视图要带 `refresh`，内容随时钟变的视图（比如「最近 30 天」）也可以带。视图在界面的服务所在的机器上运行，用那台机器的时区；格里的 `at` 由网页按浏览器的时区显示。视图记了事实，或在打开的目录里写了东西，摘要就变，界面每两秒重取一次，这是插件的错。

```ts
viewerFace.views(library): { views: ViewDecl[]; problems: PluginProblem[] }
viewerFace.show(req: ViewRequest, call: { ctx: Context; table: PluginTable; env: Env; viaGrant: boolean }): Promise<ViewResult>   // 'shown' | 'no-such-view' | 'refused'
```

块、动作、视图的类型在 `types.ts` 的末尾，不含任何插件的类型（K3）。内核自己的视图也用块给出，界面不为它们写专门的页：

| 视图 | 在导航里 | 内容 |
| --- | --- | --- |
| `home` | 是，第一个 | 首页，界面打开时的那一页（`home.ts`）。库还没用起来时，最上面是「开始」：一个 `steps` 块，三步，按库的状态算出来，不存任何标记（`start.ts`）。「接上你的 agent」：这台机器上找到的和接上的产品各一行，带记号，接上的标「已接上」，没接上的带「接上」，就是 `agent connect` 那条命令，一下就做，不出表单；一个都没找到时一句话说看了哪里；这个库的 endpoint 在跑时，下面还有那句可以复制的话（「本机的 endpoint」）。「放进第一样东西」：库的根目录的一页（前 50 项）里有没有内核自己的和隐藏的名字以外的东西，做完写「库的根目录里有 N 样东西」，这一页没列完时写「至少 N 样」；一个 `drop` 块，放进 `inbox/`。这两步是内核的。第三步「对你的 agent 说一句」由记账插件给（见下面「插件给首页添东西」），做完的条件是有 agent 在库里留下过事实；内核不认识场景。做完的一步折成一行，写着做成了什么；三步都做完，「开始」就没了。然后是「等你决定」：还在等的配对（「<产品> 想接入这个库：允许吗？」，带配对码、为什么、允许会做什么，「允许」可选区域和只读，没有推荐的回答），agent 提的、还在等的请求，然后每个插件 `onAsks` 给的事（`asks` 块），插件的由认知段标题署名，没有就是一句灰字；然后按配置次序放每个插件标了 `home` 的视图的块，默认参数。一个都没有时，一句话说明（没装插件，或装着的插件没给首页添内容），下面是库里的文件。`show home` 印的是同一页，步骤写成 `[✓]` 或 `[ ]` 加标题，做完的跟着做成了什么，没做的下面是它的内容和命令 |
| `files` | 是 | 库的一个文件夹的一层，参数 `dir`，一页 50 项（存储的一览，参数 `after` 续页），按名字排，文件夹和东西混排；内核的文件和归档区不列。文件夹链到下一层；文件和带标记的目录各是一行，链到 `item` 面板，带标记的目录有自己的图标和它第一层的项数，不往里走。还有下一页时，最后一行是「下一页（至少还有 N 项）」。「从这台机器放进来」把一个文件以带进来的放入（页给不了标准输入，目录从命令行放） |
| `archive` | 是 | 归档区的一个文件夹的一层，一页 50 项，同样有下一页的那一行：每样东西和它原来的路径，带标记的目录是一行，各带「取回」；文件夹链到下一层；要看的文件夹已经没了（最后一样被取回）时给归档区的根；整区一个「清空归档区」，先问 |
| `agents` | 是 | 只给主人。接上的 agent 各一行：记号和产品名；灰的一行写接法（技能或 MCP 服务）、区域（整个库或 `区域 x/`）、只读还是读写、授权名和产品名不同时凭哪份授权、接上时写的东西在不在原处（在时写「写在 …」，不在时是一个警示标签，说哪样不在了），然后是各插件对 `inspect @<授权>` 说的，记账插件说它最近一次来是什么时候、几次会话、放进几样；各带「断开」，先问。一个都没接上时是空状态，指向下面的「接上」。「让 agent 自己接上」：endpoint 在跑时那句可以复制的话，和这个库最近 20 个配对，各带状态，在等的带「允许」「拒绝」；endpoint 没在跑、也没有过配对时没有这一节。这台机器上找到、还没接上的产品各一行，带记号、接法、写到哪和找到它的迹象，各带「接上」，表单问区域和只读；没找到的产品和看了哪里；接上的 agent 能做什么，分三组，用和 MCP 服务同一条规则从命令表生成：自己能做的（动词，和既不破坏也不只给主人的命令，就是 MCP 服务的工具）、要你来做的（只给主人的命令，agent 用 `ask` 请；请不了的标出来）、红线（破坏性的命令）。`show agents` 印的是同一页 |
| `config` | 是 | 只给主人。库的位置；这个 pneuma-base 认识的每个插件和库里装了的每个插件，各带版本和一句说明（没有 `summary` 用认知段的标题，同 `plugin list`），装了的带「卸下」，没装的带「装上」，装到这台机器上来的另带「从这台机器卸掉」，插件不肯卸时提示里带「仍然卸下」；「从目录装一个插件到这台机器」；授权，各带为 Claude 或 Codex 生成技能（目录可以写 `~/…`）、撤回；发授权；Codex 要把库加进可写目录的提示；已装插件声明的密钥，各带设没设、「设」和「删掉」；「噪音」：库根上声明的每个名字和路径，各带「去掉」，和「加一条」。这些按钮的表单都由内核命令的参数表生成 |
| `item` | 否 | 一样东西，参数 `path`，开在右侧面板，次序固定：先一行说它是什么和一句状态（`文件 · 2.1 KB`，已归档的、是谁的一部分的跟在后面）；每个插件的 `onItemView` 给的一节；「文件」一节是存储此刻说的它（路径、种类、文件的大小、改于）；带标记的目录接着是「第一层」一节，前 50 项里文件链到自己的 `item`、文件夹链到文件页的那个文件夹，多的是一行，链到文件页的这个目录；文件接着是可以折起来的预览。带标记的目录里面的文件说明它是谁的一部分，不给归档。路径上没有东西时说明不在，插件的节照常给。最后是一行动作：归档或取回，没归档的还能挪到别处，然后是各插件节的 `actions`。`_archive/…` 的东西被取回后，面板跟到它原来的路径 |

一样东西的详情是内核的视图，不是某个插件的：内核按配置次序把各插件用 `onItemView` 给的节拼在「它是什么」之后、文件的事实与预览之前，节名由插件给，节上盖着插件名（`plugin`），插件之间互不认识；节带的 `actions` 不留在节里，并进面板底下那一行动作。记账插件的来历、版本插件的版本时间线、部署插件的开关都落在同一个面板里。

`viewerFace.views` 先列插件的视图，按配置次序，后列内核的。插件的视图和它给的一页在 `plugin-views.ts`，首页也用它。

**插件给首页添东西。** 视图声明 `home: true`，它的块就放在首页上「等你决定」之后，按配置次序，用默认参数；它照样可以不进导航（`nav: false`）。记账插件这样给出「自上次以来」和「需要留意」。首页视图答复里的 `steps` 块不放在原处：它的步骤接在内核的两步后面，并进「开始」，「开始」在不在由合起来的步骤定。记账插件这样给出「对你的 agent 说一句」：一句可复制的话（`FIRST_WORDS`，「看看我的 Pneuma Base 库里有什么。」），做完写着哪些 agent 在这里做过事。要主人回答的事不画在自己的块里，用 `onAsks` 说（第 5 节），首页和 `check` 都带上，回答后由插件自己不再提。

动作的 `call` 里的字符串可以含 `{输入名}`，界面用输入的值替换。动作的 `confirm` 是一句问话，界面弹框问；人点了确认，就是内核要的当面确认。

块的字段只加不改，新加的都是可选的，所以已经写好的插件不用跟着改：

- 单元格的 `at`：这一格是一个时刻。界面按看的人的本地时间给短的写法，悬停给完整的时间；`text` 是不认识时刻的读者看到的。
- 单元格的 `icon`：文字前面的一个 lucide 图标名，比如文件夹 `folder`、文件 `file`、带标记的目录 `package`。视图的 `icon` 也是。能用的名字是 sdk 的 `ICON_NAMES`，类型 `IconName`；网页的图标表按这个类型写，所以清单和网页画得出的一样。别的名字（不经 sdk 的类型写的插件才给得出）画成拼图。
- 动作输入的 `multiple`：可以填几个值，一行一个。`call` 的列表里正好是 `{输入名}` 的那一项，换成每行一项。
- 分节的 `collapse`：这一节可以折起来，值是开始时开着还是折着。
- 表格列的 `optional`：放不下每一列的全部时，这一列先让开，后面的先让；别的列只在可让的都让开了之后才截短。
- 单元格的 `href`：库外的地址，在新标签页打开（`rel="noopener noreferrer"`）；只有 http 和 https 算链接，别的照文字显示。表格里放不下时从中间截短，两头都看得见，悬停给全文。`copy`：旁边一个复制按钮，复制 `href`，没有 `href` 就复制 `text`。
- 时间线条目的 `actions`：这一条上的小按钮，比如「放回这一版」。
- 动作输入的 `pattern` 和 `hint`：填了的值要整个匹配 `pattern`（`u` 标志，`multiple` 的每一行都要），不匹配时表单不提交，`hint` 变红；`hint` 平时就写在输入下面。留空不算不匹配。
- 动作输入的 `secret`：输入时不显示，像密码。主人面 `Call` 的 `stdin`：命令当作标准输入读的值，可以含 `{输入名}`；它不进事件。配置页设密钥的表单就是这两样。
- 块 `embed`：`{ url, title, height }`，库外的一个 http 或 https 页面，放在沙箱框架里：能跑脚本，拿不到界面的源，和界面不同源时保留它自己的源，它自己的存储照常能用。带「在新标签页打开」。给发布出去的网站做实时预览。
- 块 `custom`：插件自己画的页，见下面。
- 视图答复的 `refresh`：见上面。
- 视图答复的 `open`：一个开在面板里的链接，比如列表的第一行。界面打开这一页、面板关着、窗口放得下页和面板（不用把侧栏收成窄条）时，在面板里打开它；每到这一页一次，主人关了就不再开，直到下次来。替换当前的历史记录，不多一步「后退」。文字的呈现不印它。不是开在面板里的链接，去掉，列进问题。
- 单元格的 `actor`：`{ kind: 'agent' | 'owner', name, grant? }`，谁做的。界面在文字前画一个记号：agent 是两个字母，底色由名字定，同一个名字总是同一个颜色；主人是一个灰圆。字母不靠颜色也分得开，一条规则，每页一样（`web/src/marks.ts`）：名字头两个词的首字母（claude-code 是 CC），只有一个词的取它的头两个字母（codex 是 Co），汉字这样宽的字一个就是记号（小助手是「小」）；屏上（页和面板一起）两个名字的字母还一样时，各取首字母加上第一个和对方同位不同的字母（codex 和 copilot 是 Cd 和 Cp）。`text` 是空的时显示名字。
- 块 `feed`：`{ groups: { title, count, link?, rows }[], empty }`，发生过的事，按日或按场景分组；分组的 `link` 打开组名说的东西（比如场景）。一行 `{ key, at, actor, text, meta, whose?, action?, settled?, link }`：何时、谁（`actor` 是记号或一个名字）、一句话、灰的一行（单元格）、谁的动作（agent 自己做的、主人做的、只是看到的，没意义时不写）、一个安静的动作（比如撤销）或 `settled` 一个灰词说它后来怎样了，两样不同时有。没有行时只显示 `empty`，一句灰字。界面只在不寻常时画「谁的动作」：主人做的、主人批准的、看到的；agent 自己做的几乎是每一行，不画，文字的呈现每行照写。时刻在行左边的一列，比别处短：一小时内写「刚刚」「N 分钟前」，今天只写钟点，昨天写「昨天 15:34」，更早的只写日期，悬停给完整的时间。窄的时候（比如在面板里）时刻挪到灰的一行的开头，用别处的写法，那句话整句折行。
- 块 `stats`：`{ stats: { label, value, note }[] }`，几个数，每个一张小卡。
- 块 `tree`：`{ param, selected, nodes }`，节点 `{ value, label, count, children }`。选中一个节点，就是把这一页的参数 `param` 设成它的 `value` 再取一次，像筛选一样；`selected` 是当前的值。
- 块 `asks`：`{ asks, empty }`，只有主人能定的事，每件 `{ key, by, text, about, actions, suggested? }`。界面里回答之后，这一件在原处折成一行回执（回答了什么、答复的那句话、什么时候），页面开着时一直在，即使重取之后它已不在答复里。
- 块 `steps`：`{ steps }`，一步 `{ key, title, done, summary, blocks }`。没做的一步展开，显示它的块；做完的折成一行，标题下面是灰的 `summary`（做成了什么），点开再看它的块。第一个没做的是当前的一步。步里的块像分节里的一样逐个核对。首页上的会被并进「开始」（见上面）。
- 块 `drop`：`{ to, command }`，把文件放进库里的文件夹 `to`，记成主人带进来的。在 Mac 外壳里是一块虚线的区域，点了由外壳弹出选文件的面板（文件和文件夹都行，可以多选），选的经命令行放入；拖到窗口任何地方的效果一样。浏览器交不出文件，显示 `command`，可复制。
- 块 `chart`：`{ form, text, unit, x, series }`，几个数随时间怎么变：`form` 是并排的柱（`bars`）、叠起来的柱（`stacked`）或线（`line`），一根轴，单位是 `unit`；`text` 是说这张图在说什么的一句话，数在这句话里，图只给形状。系列最多 4 个（sdk 的 `CHART_SERIES_MAX`），各有一个和 `x` 一样多的数，叠起来的不能是负数。颜色按系列的次序取自一套四色（`theme.css` 的 `--series-1` 到 `--series-4`，浅色深色各一套，用 dataviz 的校验脚本核过色盲下相邻可分），不由插件定；只有一个系列时不画图例；线的末端放得下就直接标系列名，否则画图例；悬停或键盘（←→、Home、End）移到一处，给出那一处每个系列的数和单位，读屏另有一张同样的数表。不做入场动画，免得一页几张图一起动。`show` 印那句话和一张数表，一行一个横轴标签，一列一个系列，表头带单位。一页里接连的几张图，宽的时候并排。
- 筛选选项的 `count`，和视图答复的 `filters`：答复可以为它声明了的筛选给出这一次看到的选项（比如有哪几个 agent）和每个选项有几条；没声明的筛选不要，列进问题。界面用答复给的选项，只有一个选项的筛选不画。
- 视图的 `home`、条目节的 `actions`：见上面。

内核核对插件给的每一块，段落里的块逐个核：种类不认识、缺了必需的字段（类型里不带 `?` 的）、字段的类型不对、`feed` 的一行既有动作又有 `settled`、`asks` 推荐的不在回答里、`embed` 的地址不是 http 或 https、`custom` 的 `entry` 爬出 `ui` 目录或插件没有 `ui`、`chart` 的系列不是 1 到 4 个或数和 `x` 不一样多或叠起来的柱有负数、输入的 `pattern` 不是正则、动作的 `call` 不是一个动词或这个库里在的一条主人命令、参数不合那条命令的参数表（没填的输入算给了，填的值到分派时再核）、「说」的种类没有插件听、`call` 写了动作没有的输入，这一块换成一段文字，说是哪个插件的块、为什么，并列进问题；页的其余部分照常。`Call` 的解析（`parseCall`）在内核，界面的服务收 `POST /api/call` 时用同一个。`refresh` 不是数字的去掉，也列进问题。比内核旧的网页遇到不认识的种类，仍显示成一行字。

**插件自己画的页。** 带类型的块说得出的用块；说不出的，插件画自己的页：

- 块 `{ kind: 'custom'; entry; height; text; data; actions: Record<名字, Action> }`。`text` 必需，用字说这一块画的，出自给框架的同一份数据：`show` 印它，框架的 `aria-label` 是它，页打不开时界面显示它；agent 看不到画，只看得到它。`entry` 是插件 `ui` 目录里的相对路径。`ui` 是插件对象上的绝对路径，插件自己设；从文件装载的插件，是 `index.js` 旁边的一个目录。内核给这一块盖上插件名，插件写的不算。插件自己的页里、条目面板里它那一节，都能放。
- 界面把它放进 `<iframe sandbox="allow-scripts">`，地址是 `/plugin-ui/<插件名>/<entry>`，开始时 `height` 高，之后跟着框架报的高度。
- 框架发来第一条消息就算准备好了。界面这时发给它一条，以后每次重取视图、换配色都再发一条；它能回的只有三种，别的消息、别的来源的消息都不理：

  ```
  界面 → 框架  { pneuma: 1, type: 'data', data, scheme: 'light' | 'dark', tokens: { '--surface': '…', … }, actions: { <名字>: { label, tone, inputs } } }
  框架 → 界面  { pneuma: 1, type: 'run', name, values }
               { pneuma: 1, type: 'open', link: { view, params, target } }  或  { pneuma: 1, type: 'open', href }
               { pneuma: 1, type: 'height', height }
  ```

- 具名动作走和按钮完全一样的路：同一个对话框问这个动作自己的 `confirm`，有输入的表单里先填好框架给的值（只取它声明了的输入），同样经两个面分派，同样的结果提示，同样的重取。框架拿不到 `Call`，也就跑不了块没声明的动作；视图照旧不发事件。不让框架直接调接口，是因为「破坏性的要当面确认」「每次操作留痕」只在两个面的入口守得住：框架只是另一种按钮。
- 5 秒内没说准备好（文件不在、加载失败、没用开发包），那一块换成一段说明，写出插件名，跟着块的 `text`；页的其余部分照常（K8）。
- 沙箱为的是隔离样式和崩溃，不是防插件：插件的 `index.js` 本来就在本机以主人的身份跑。
- 开发包由界面的服务给出，地址固定：`/plugin-kit/frame.js` 做握手，给出 `pneuma.onData(callback)`、`pneuma.run(name, values)`、`pneuma.open(link)`，自己报告高度；`/plugin-kit/frame.css` 用和界面相同的变量名（`--surface`、`--ink`、`--primary`……）铺好底，带界面的组件（`card`、`btn`、`tag`、`field`、`segmented`、`link` 等，和界面共用一份 `components.css`）和字体。插件的页跟着浅色深色走，不用抄颜色。`@pneuma-base/sdk/frame` 给插件作者 `window.pneuma` 的类型（`onData` 收到什么、`run`、`open`）和样式表给的类与变量的清单；界面发给框架的变量就取自这份清单，仓库的测试核对样式表里有清单上的每个类。

网页渲染块时自己定的几条，插件写块时可以指望：

- 表格的每一列先按它的内容量出自然宽度；放得下就都不截短，多出的宽度给最宽的一列文字或路径。放不下时可让的列先让开，再截短文字，最后截短路径，路径截掉的是前面的文件夹。窄的地方，比如右侧面板，要让路径完整，就用列表，不用表格。
- 没有行的表格只显示它的 `empty`，画成空状态：第一句是标题，其余是说明。
- 放不下时可让的列让开、文字和路径截到最短的一档之后，再往下截到只剩几个字和省略号，表格不横着滚。
- 一页的块以 `tree` 开头时，树在左边一栏，其余的在右边；地方不够时树在上面。
- 时刻按看的人的本地时间写：一小时内写「刚刚」「N 分钟前」，今天写「今天 15:34」，昨天写「昨天 15:34」，悬停给到秒的完整时间，每半分钟自己走一次。插件写在字里的 `YYYY-MM-DD HH:MMZ`（命令行的写法）在页的副标题、节的说明、一段文字、列表的说明、时间线的行、数的说明和命令面板里也换成这样。命令行照旧印准确的 UTC。
- 右侧面板里，排在最后的那一行动作贴在面板底部，内容在它上面滚。
- 一个正常的状态是灰字，只有偏离正常的才是带颜色的标签。
- 表格里有链接的行，只有一行在 Tab 的顺序里（打开着的那行，没有就第一行）；上下键、Home、End 在这些行之间走，回车或空格打开，按着 ⌘ 或 Ctrl、或用中键，开在新的标签里。Esc 先关对话框和命令面板，都没有时关掉右侧面板最前面的标签。对话框开着时 Tab 不出框，关掉后焦点回到原来的按钮。
- 边栏顶上库名旁边一个小点说明这一页在自动更新（连不上服务时变红），最近一次从库里看到变化是什么时候写在它的提示里，读屏也读得到。提示叠在右下角，新的在前；做一个动作时提示立刻出现，写着正在进行，答复来了就在原处变成答复。成功的提示自己消失；拒绝和出错的提示一直留着，等人关掉。主人命令的拒绝带 `offer` 时，提示里有它的按钮，点了照按钮走（先问它的 `confirm`），提示关掉；`plugin remove` 被插件的 `onRemove` 拒绝时，`offer` 是「仍然卸下」：用插件的那句话问，确认后带 `--anyway` 卸下。块和动作说不出「这个动作被拒绝后可以改做另一个」，所以这一样放在答复里，不放在块里。
- 打开的视图、它的参数和右侧面板的每个标签记在地址的片段里：`#view=<编号>&view.<参数>=…&panel=<编号>&panel.<参数>=…&panel2=…&tab=2`，`panel`、`panel2`……是各标签现在显示的视图，`tab` 是最前面的那个（从 1 数，只有一个标签时不写）。重新载入或粘贴这个地址，打开的是同一套；浏览器的后退、前进一步步走回去。

### 界面的外壳

- 样子只有一层变量，在 `theme.css`，浅色深色各一套，跟着系统切换，不用重新载入：字是黑或白的几档透明度，面从后往前是页底、面板、卡片、浮层，边是 0.5px 的环，阴影三档，圆角七档。主要按钮近黑；蓝色只给键盘焦点和「进行中」，界面没有自己的强调色。按钮、字段、标签这些基础部件在 `components.css`，和开发包共用。
- 边栏坐在页底上：库名和自动更新的小点，一个打开命令面板的搜索框，下面是页，分组：首页和第一个插件的页在最上面，不带组名，界面打开时就在首页；别的插件的页在「插件」下；内核的页在「库」下；配置在最底下。边栏能收成一列图标；主区窄于 520px 时它自己让开，打开详情时也算。边栏和详情的宽度能拖，记在 cookie 里（服务每次换端口，cookie 不分端口），不是库的状态。
- `feed`、`asks`、`stats`、`tree`、`chart` 和谁做的记号是管理界面自己的部件，在 `packages/viewer/web/src/pieces/`，一块一个文件，样式在同一处的 `pieces.css`，只用 `theme.css` 的变量。它们画的是块，不进开发包：插件自己的页用 `components.css` 的基础部件。
- 主区和详情是两块圆角面板。详情里每样打开的东西一个标签：普通的点击在最前面的标签里往下走，返回走回来；⌘ 点击、中键和命令面板开新的标签，已经开着同一个的就把它调到前面。
- 命令面板（⌘K，或边栏的搜索框）：不打字时列出要去的页和这一页的动作；打了字就用 agent 面的 `find` 在库里找，经 `/api/call`，和按钮同一条路，命中按 `find` 的分组列出，选一条在详情里开。上下键、回车、Esc。

### 界面的服务

- 只听回环地址，127.0.0.1 和 ::1 的同一个端口，优先 7638（见下面「本机的 endpoint」）。启动时造一个随机令牌，打印的地址带着它。每个请求核 Host（`127.0.0.1:<端口>`、`localhost:<端口>` 或 `[::1]:<端口>`），除了 `/plugin-ui/*` 和开发包都核 Origin；`/api/*` 另核令牌（查询参数 `token` 或头 `x-pneuma-token`）。给 agent 的 `/guide`、`/pair`、`/mcp` 不要令牌，见「本机的 endpoint」。
- `GET /api/state`：是不是库、库的位置（另有一份把家目录写成 `~` 的，给人看）、视图清单和问题、可用的插件。`GET /api/view?view=&<参数>`。`POST /api/call`：一个 `Call` 加 `confirmed`，答复是结果和一行给人看的话；主人面 `Call` 的 `stdin` 是命令向主人要的值，比如密钥。`GET /api/file?path=`：内容区和归档区的文件原样给出；路径经内核解析，链接跟到底后还要在库里、不在内核的地方，否则 404；HTML 一律当文字给，带 `sandbox` 的 CSP，浏览器不会运行库里的文件。`GET /api/rev`：一个摘要，由每个插件的事实现在到哪、打开的目录的令牌（一项来了或走了）、存储报来的打开的目录那一层里的文件最近一次改动（`places.ts` 的 `changeStamp`：服务在内存里为每个库留一个游标，每次轮询从它问一次；服务在听，所以从它听到的答，第 5 节「上下文里的工具」里「变化」），和这台机器上的配对算出。它从不走一遍库的文件夹：没人看过的目录里、一样东西里面的改动，以及存储说不出变化时在原处改了的文件，不改摘要，等页因为别的原因重取时才显示出来。`POST /api/init`：把目录建成库。
- `GET /plugin-ui/<插件名>/<路径>`：这个库装了的插件的 `ui` 目录里的文件，只读。路径的段解码后是空、`.`、`..` 或含斜杠的，链接跟到底不在 `ui` 里面的，没装的插件、没有 `ui` 的插件，都是 404。不要令牌：框架拿着令牌就能绕过对话框直接调 `/api/call`，所以它的地址不带令牌，载入它时也不发 Referer（界面的地址里有令牌）。答复带 `Content-Security-Policy: sandbox allow-scripts; frame-ancestors 'self'`，单独打开也拿不到界面的源；带 `Referrer-Policy: no-referrer`；带 `Access-Control-Allow-Origin: *`，因为沙箱里的框架是不透明的源，模块脚本和字体要 CORS 才载得进来。
- `GET /plugin-kit/frame.js`、`/plugin-kit/frame.css`：开发包，同样带 CORS。
- 网页的地址带 `shell=mac` 时，它在 Mac 外壳（`app/`）里：`<html>` 标上 `data-shell`，改用系统字体，左边栏顶部给窗口的三个按钮留出位置，外框部分不能选中文字，只对浏览器有意义的提示换掉。外壳在窗口成为或不再是前台窗口时发 `pneuma-shell` 事件，网页标上 `data-window`，窗口在后面时把外框调淡。`data-drag` 标出能拖动窗口的区域，外壳据此拖窗口；浏览器里这个标记什么都不做。
- 再带 `panel=tray` 时，网页是菜单栏面板的那一种排法（`tray.tsx`），外壳在图标下的小窗口里载入它。它取的是首页的同一份答复，不认识任何插件的视图：顶上是库名（点了是外壳的库的菜单）和「N 件等你」；还有没做完的「开始」时一行「开始：还有 N 步没做」；「等你决定」是首页所有 `asks` 块里的前三件，在这里就能回答，多的写一行「还有 N 件，在窗口里看」；「自上次以来」是首页所有 `feed` 块里最新的五行，没有时用那块自己的 `empty`；底下是「打开窗口」和「退出」。只在面板显示着时每两秒问一次摘要。
- 网页对外壳说的话经 `window.webkit.messageHandlers.shell.postMessage` 发出。除了 `shell.js` 发的 `ready`、`painted`、`regions`，还有：`{ type: 'choose', to }`（`drop` 块的「选择…」）、`{ type: 'open', link? }`（打开窗口，给了链接就在窗口里打开它）、`{ type: 'libraries' }`、`{ type: 'quit' }`；面板另发 `{ type: 'height', height }`（外壳照它定面板的高）和 `{ type: 'waiting', count }`（图标上的点）。外壳对网页说的都是 `pneuma-shell` 事件：`{ window }`（见上）、`{ link }`（网页照点了这个链接那样打开它）、`{ notice: { tone, text } }`（网页显示成一条提示，并重取，说的是拖放和监看做了什么）、`{ panel: 'shown' }`（面板又显示出来，重取）。外壳自带一个 Node 和命令行的包，只跑这两样，缺省的家目录是 `~/.pneuma-base`，每次启动用 `launcher install` 让本机的命令指向它们（第 6 节「接上一个 agent」）。外壳做什么、怎么监看，见 `app/README.md`。
- 服务不持有状态，每次请求重新建插件表（自带的加本机的，本机的插件文件变了就载入新的）、重新打开库。行动者是主人；会话按环境识别，同命令行。服务若跑在 agent 的会话里，破坏性命令照常被拒（K7），拒绝的话说出是哪个环境变量或授权让它这样判的。

### MCP 服务

给不能跑 shell、也不能装技能的 agent 应用（桌面的对话应用、编辑器）的一面。`pneuma-base @<授权名> mcp` 在标准输入输出上跑一个 MCP 服务，库和身份都由授权定：行动者是授权的 agent，和命令行的 `@<授权名>` 一样，没有 `--as`、`--library`。一次连接是一次会话，所以是一个场景：客户端用 `--session <名字>` 给它起了名就用那个名字，没起就在连上时造一个；不会并进这个 agent 当天的零散场景。只读的授权、限在一个区域的授权和命令行一样。服务不持有库的状态：每个请求重建插件表、经授权重开库，所以插件装卸、授权撤回立刻生效。

- **工具**都是生成的，没有为哪个工具手写的代码。每个动词和 `show` 一个，输入是那个动词的参数表；`put` 读标准输入的那个位置参数在这里可以不写，内容写在 `text`（文字）或 `base64`（字节）里，库外的文件或目录照旧写这台机器上的路径。每条既不破坏也不只给主人的命令一个，名字是命令名的词用 `_` 连起来（`space list` 是 `space_list`），输入由它的 `params` 生成：位置参数和开关是同名的属性，种类、必填、`pattern`、`options` 照搬，`hint` 是属性的说明。工具的说明是动词或命令的一句中文说明。管理的命令不列出；按名字调，它照样经主人面的门，以命令行同样的理由和话拒绝。没有这个名字的工具，是协议层的错。
- **答复**和命令行的一样：命令行印的字是工具答的文字，`--json` 印的结果对象是结构化的内容。拒绝（退出码 2 的那些）标成出错，字和理由不变；用法错误是 `reason: 'usage'` 的拒绝，字是命令行在标准错误印的那句；插件的问题和命令行一样写在字里和 `problems` 里。退出码在这里没有意义，看 `outcome`。
- **认知**随连接来：服务的 `instructions` 是库的说明（内核此刻拼出的 `PNEUMA-BASE.md`），前面加六句写给这一面的话：说明里的命令行就是同名的工具、参数相同，`put` 怎么给内容，内容用 `inspect` 加 `content` 读，管理由主人在界面上做，要主人做其中一件用 `ask`（`command` 是那条命令的词和参数）。说明也是一个资源；管理界面导航里不只给主人的每一页也是一个资源，读它得到 `show <编号>` 印的字。
- **变化**：服务每两秒重读一次工具表、资源表和被订阅的资源，变了就发协议的通知（工具表变了、资源表变了、某个资源更新了）。插件在连着时装上或卸下，三样都会变。
- **协议**：新旧两代都接。2026-07-28 版每个请求在 `_meta` 里带版本，有 `server/discover`，通知经 `subscriptions/listen` 来，可缓存的结果写 `ttlMs: 0` 和 `cacheScope: 'private'`（库随时在变，答复因授权而异）；更早的版本以 `initialize` 开头，`notifications/initialized` 之后的通知直接发。2026-07-28 版说一条连接不算会话，这里按上面定的仍把一次连接记成一个场景。
- 协议是自己写的（`src/mcp/server.ts`，约两百五十行），没有用官方的 SDK：命令行的包文件里没有任何第三方依赖，SDK 的服务端连同它要的 zod 解开约 14 MB，工具的输入又是从参数表生成的 JSON Schema，用 SDK 也只剩它的低层接口。传输是参数（`Transport`：收到的每一行，和发一条的办法），HTTP 上的那一种见下面「本机的 endpoint」。仓库的测试用官方 SDK 的客户端（只是开发依赖）分别以两代协议、经标准输入输出和 HTTP 连上它。

### 接上一个 agent

主人在应用里的主路是：选一个文件夹，把自己的 agent 一个一个接上，开始干活。接上是一条主人命令，断开是它的逆，界面的按钮就是这两条命令：

- `agent detect`：这台机器上有哪些 agent 产品、各能怎么接上。只看程序和文件夹在不在。
- `agent connect <产品> [--name <授权名>] [--area <子文件夹>] [--read-only] [--via skill|mcp|mcp-http]`：先发授权（缺省以产品命名；这个库里同名、给同一个产品、区域和权限也一样的授权接着用，撞名的拒绝，说用 `--name`），再按产品能用的方式写：读技能的，把技能装进它读技能的目录；不读的，把 MCP 服务 `<本机的命令> @<授权名> mcp` 登记进它的配置。两种都行时装技能，`--via` 改。`--via mcp-http` 登记的是 endpoint 上的地址，表里没有的产品只能这样接，什么都不写（见「本机的 endpoint」）。先看能不能写、再发授权，所以拒绝时什么都没留下。答复说写了什么、写在哪、在那个产品里接着做什么（重启它，或对它说一句话），Codex 另有把库加进可写目录的提示。
- `agent disconnect <授权名> [--keep-grant]`：拿掉接上时写的，再撤回授权。它只动这台机器，不用指明库；授权在记录里的那个库里撤回，作为那个库的一次操作发事件。
- `agent list`：接上的 agent，各自的产品、授权、方式、区域、只读与否，接上时写的还在不在，它运行的本机命令在不在、指向的 node 和命令行在不在。
- `launcher install`：让本机的命令指向现在这个命令行（见下）。

五条都只给主人，不是 MCP 服务的工具。`grant issue`、`grant revoke`、`skill install` 原样留着，接上就是用它们拼出来的。

**产品表**（`products.ts`）是关于每个 agent 产品知道的一切的唯一一处：怎么认出它的会话、找它的对话（第 4 节），怎么看出它装在这台机器上，从哪个目录读技能，MCP 服务登记在哪个文件、什么格式、哪个键下，还要告诉主人什么。一个产品一行；没在产品自己的文档或它自己的行为上核过的事实不写，这个产品就少一种接法：

| 产品 | 看出装着 | 技能 | MCP 服务 | 收 URL 的 MCP 条目 | 核过的 |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | PATH 上的 `claude`；`~/.claude` | `~/.claude/skills/` | `~/.claude.json` 的 `mcpServers`，条目带 `"type": "stdio"` | 同一个键，条目 `{"type": "http", "url"}` | 技能目录和「当前会话里就看得到」按 Claude Code 的文档；MCP 的文件、键和条目的样子按 `claude mcp add --scope user`（URL 的加 `--transport http`）在临时家目录里写出的文件；`claude mcp list` 连得上接上写的条目 |
| `codex` | PATH 上的 `codex`；`~/.codex` | `~/.agents/skills/` | `~/.codex/config.toml` 的 `[mcp_servers.<名字>]`，环境变量在 `[mcp_servers.<名字>.env]` | 同一张表，只一行 `url = "…"` | 技能目录按 Codex 的文档；表的写法按 `codex mcp add`（URL 的加 `--url`）在临时家目录里写出的文件；`codex mcp get` 读得出接上写的表，URL 的读成 `streamable_http` |
| `claude-desktop` | `~/Library/Application Support/Claude` | 不从目录读技能 | 那个目录里 `claude_desktop_config.json` 的 `mcpServers` | 不收 | MCP 的文档（modelcontextprotocol.io）：位置、键、条目，要完全退出再打开 |
| `cursor` | `~/.cursor` | `~/.cursor/skills/` | `~/.cursor/mcp.json` 的 `mcpServers`，条目带 `"type": "stdio"` | 同一个键，条目 `{"url"}` | Cursor 的文档；文档没写它在 PATH 上的程序名，所以只看文件夹 |
| `antigravity` | — | — | — | — | 只认会话 |

每个能接上的产品还有一份说明（「本机的 endpoint」），里面手写的「已知的」几句也在产品表里。

**写别的程序的文件**是危险的部分，规矩是：

- 接上写了什么记在本机的 `$PNEUMA_BASE_HOME/connections/<授权名>/connection.json`，不在库里：哪个文件、哪个键或哪个文件夹、写的东西的指纹、为它造出来的文件夹、授权的编号。第一次改一个已有的文件之前，原样复制一份到旁边的 `before/`，断开时和记录一起删。目录 `0700`，副本 `0600`：配置文件里可能有密钥。
- 文件按字改，不经解析器重写（`config-edit.ts`）。JSON 先用 `JSON.parse` 确认读得懂，再在原文里找出对象和成员的位置，在服务那一层的最后加一个成员，缩进和换行照文件自己的，其余每个字节不动，所以数字、键的次序、格式都还是主人的。读不懂的（带注释、最外层不是对象、键重复）不改，拒绝，答复里给要自己粘的那段和先发授权的命令。TOML（Codex）在末尾空一行追加两张表，拿掉时按追加的原文精确匹配。不引 TOML 库：已经写着这个名字、或服务表写成了一行里的表的，不加，同样给那段。
- 写回时在同一个目录里先写临时名，带原来的权限，再改名；文件是链接时写它指向的那个，链接还是链接。
- 断开只拿掉自己写的，而且只在它还是写的时候的样子：主人改过的，断开说出来，原样留着。接上之后没人动过那个文件时，断开后的文件和接上前一个字节都不差；接上时造出来的文件和文件夹，空了就删。
- 写进去的都按绝对路径指名本机的命令 `$PNEUMA_BASE_HOME/bin/pneuma-base`：MCP 条目的 `command` 是它，`args` 是 `@<授权名> mcp`，没有自己的环境变量；技能里的命令行也用它，并说明说明里写 `pneuma-base` 的地方都用这个路径（技能是这台机器的文件，说明是库的，跟着库走，仍写 `pneuma-base`）。所以没有 shell 配置、PATH 上只有系统工具的应用也启动得了。
- **本机的命令**是一个小脚本：导出它所在的家目录作 `PNEUMA_BASE_HOME`，再 `exec` 一个写明的 node 和一个写明的命令行入口文件。路径从不变，内容由提供命令行的一方保持最新：Mac 应用每次启动时让它指向应用里自带的 node 和命令行；从包装的，`pneuma-base launcher install` 让它指向现在这个命令行（PATH 上的 `node` 就是这个 node 时写 PATH 上的那个：包管理器升级时它不变）。两种都只在内容不同时才写，先写临时名、带上可执行位再改名。`agent connect`、`skill install`、`guide` 和 `view`（说明里的命令行都用它）在它不在、读不懂、指向的东西不在了或家目录不对时写它，好好的就不动。应用挪了位置或升级了，接上的 agent 不受影响：下次启动应用，命令跟着改；在这之前 `agent list` 说出它指向的东西不在了，再接一次也修好。接上之前写的记录（条目里写 node 和入口文件的）照旧按那两个路径查。
- 接两次，第二次什么都不改；断开两次，第二次安静地说没有这个连接。

**授权**在内核里，只有最小的形状：编号、名字、给谁、哪个区域、读还是读写。没配任何授权时，谁都能用整个库。区域是库里的一个子文件夹。

授权有两处：库的配置里是权威的那份；发给 agent 的那份是它本机的一个小文件，放在 `~/.pneuma-base/grants/<名字>.json`，写着库的位置和授权编号。agent 用 `pneuma-base @<名字> <动词>` 调用，一个名字同时定下是哪个库、是谁。这个文件不是库的状态，丢了重新生成。

**会话和行动者的识别**次序：命令行参数；环境变量；都没有就为这次调用造一个。

### 本机的 endpoint

主人对任何一个 agent 说一句话，它就自己接上：「读一下 http://127.0.0.1:7638/guide，接上我的 Pneuma Base 库。」endpoint 是界面的服务里给 agent 的那一部分，和管理界面同一个进程、同一个端口。它是命令行的又一个面：`/guide` 给的就是 `pneuma-base guide` 印的字，配对就是 `pneuma-base pair`，`/mcp/<授权名>` 就是 `pneuma-base @<授权名> mcp`。两边一样由测试守着：`packages/cli/test/endpoint-story.test.ts` 核对同一段说明、配对走到同一个状态，并把一个 agent 从读说明走到它的场景记在它名下；`mcp-http.test.ts` 核对 MCP 的两种传输列出同样的工具、对同一组调用给同样的答复（`mcp-cases.ts`）。

- **说明**（`guide.ts`）。`pneuma-base guide [<产品>] [--library <库>]` 和 `GET /guide`、`/guide/<产品>`（或 `/guide?for=<产品>`）是同一段 Markdown。通用的一份：这个库是什么，怎么配对，各产品的说明在哪，接上之后读库的说明、用哪条命令，只能接 MCP 的应用用哪个地址。产品表里能接上的产品各一份：怎么接（技能还是 MCP、写在哪）由产品表生成，再加产品行里手写的几句「已知的」（Codex 的沙箱、Claude Code 的 WebFetch 不取本机地址这类）。表里没有的产品拿到通用的那份，名字填进去，接的方式是 MCP。不按 User-Agent 猜是哪个产品：agent 用 shell 里的 curl 来取，curl 的 User-Agent 说不出是谁，所以靠地址里的产品名。命令行没有在跑的服务时，说明里只有命令行的配对。
- **配对**（`pairing.ts`）。还没接上的 agent 请主人允许：`POST /pair`（`{ "product", "why" }`）或 `pneuma-base pair request <产品> "<为什么>"`，得到配对号和配对码（`NNN-NNN`），把码给自己的用户看。主人在首页「等你决定」里看到「<产品> 想接入这个库：允许吗？」，带着同一个码、那句为什么、允许会做什么（发什么名字的授权：产品名，这台机器上这个名字已经给了别的产品、别的库时是 `<产品>-2`、`-3`……；写什么技能或 MCP 条目；表里没有的产品以 `mcp-http` 接上，什么都不写），点「允许」（可选区域、只读）或「拒绝」。允许就是以主人的身份跑 `agent connect`，接上只有这一个机制。码是把这次请求和主人面前那个 agent 对上的办法：码对不上就不该允许，所以「允许」不是推荐的回答。agent 每隔几秒问 `GET /pair/<号>`（或 `pneuma-base pair status <号>`）：在等、拒绝了、过期了，或接上了：带授权名、它运行的命令、MCP 的地址、接着读什么。主人面的 `pair list [--all]`、`pair allow <号>`、`pair decline <号>` 是同样的事，只给主人，不能被请。
  - 配对是本机的状态，不是库的：没接上的 agent 在库里还没有身份。放在 `$PNEUMA_BASE_HOME/pairings/`，一个请求一个文件、一个决定一个文件，都以独占创建写一次，第二个决定以 `not-pending` 拒绝。文件都留着：允许的、拒绝的、过期的，`pair list --all` 和 Agent 页都列出来。10 分钟没人回答就过期；同一个产品对同一个库还在等时再请，得到同一个号和码；全机最多 5 个在等。产品名要合授权名的格式；为什么去掉控制字符，不超过 200 个字。允许和拒绝是那个库的操作，照常发事件；请求不是，还没有谁可记。
  - 这台机器上授权是约定，不是秘密：知道授权名的本机进程都能用它，和命令行的 `@<授权名>` 一样。配对要的不是保密，是主人明确的一句「允许」，和每个 agent 一个自己的名字，记录因此说得出哪个 agent 做了什么。
- **MCP over HTTP**。`/mcp/<授权名>` 是规范的 streamable HTTP，新旧两代都接，工具出自同一张表，协议是同一份代码：`src/mcp/http.ts` 把 HTTP 请求接到 `serve` 的传输上，界面的服务把它当参数收下（界面不导入命令行）。旧一代（2025-03-26 到 2025-11-25）以 `initialize` 开一条连接，答复带 `Mcp-Session-Id`，一条连接是一个场景，和标准输入输出上一样；`GET` 是这条连接的通知流，`DELETE` 结束它，闲 30 分钟自己结束，最多 32 条。2026-07-28 版没有连接：每个请求一个 POST，`MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 三个头要和正文一致，不一致是 400 和 `-32020`；通知经 `subscriptions/listen` 的 SSE 流来，关掉流就是取消。没有连接，就没有「一次连接」可记成场景，所以地址可以带 `?session=<名字>` 给场景起名，和 `--session` 一样；不带的，每个请求像一次没带会话的命令行调用，记账插件把它并进这个 agent 当天的零散场景。授权解析不了（没有、撤回了、库不在了）时照样经协议答：工具和调用以授权的理由拒绝，和标准输入输出上连着时一样，agent 能告诉用户为什么。
  - `agent connect <产品> --via mcp-http` 把这个地址写进产品的配置，只给核过它的配置收 URL 的产品（产品表的 `mcpUrl`：Claude Code、Codex、Cursor）。表里没有的产品只能这样接：发授权，什么都不写，答复给地址和标准输入输出的命令，由它自己加进配置。地址里有端口，界面的服务不在跑时连不上；标准输入输出的条目没有这个限制，所以缺省仍是技能和标准输入输出。
- **端口**。优先 7638，主人每天说的那句话不变；被占了用往后最近的空端口（最多试 20 个），都占了就任意一个。`--port` 写了就只用那一个。每个端口同时听 127.0.0.1 和 ::1，不听通配地址：只听 127.0.0.1 时，别的进程能占住 ::1 的同一个端口，接住解析成 ::1 的 `localhost`。用到的地址写进本机的 `$PNEUMA_BASE_HOME/endpoints/<端口>.json`（地址、进程、服务的库），关掉时删掉，进程不在了的记录不算。`pneuma-base guide --url` 印出它，`pneuma-base view` 在地址那一行下面印出那句话；首页「开始」的第一步和 Agent 页显示它，带复制按钮。`view` 启动时也确保本机的命令在，因为说明里的命令行都用它。
- **安全**，每条都有测试（`packages/viewer/test/`）：
  - 只听两个回环地址。
  - 每个请求核 Host：`127.0.0.1:<端口>`、`localhost:<端口>` 或 `[::1]:<端口>`，别的是 403，挡 DNS 重绑定。页本身和开发包现在也核。
  - 不许跨源：`Origin` 不是这个服务自己的（`null` 也算），或 `Sec-Fetch-Site` 是 `cross-site`、`same-site`，都是 403。只有 `/plugin-ui/` 和 `/plugin-kit/` 例外：它们给沙箱里的框架（不透明的源）用，本来就带 CORS，只给插件自己的文件。别的答复都不带 `Access-Control-Allow-Origin`。`POST /pair` 和 `POST /mcp` 还要 `content-type: application/json`，浏览器发这种请求先要预检，预检拿不到许可。
  - 给 agent 的路由碰不到主人的路由。它们在自己的模块里（`agent.ts`），拿不到令牌，不调主人面，lint 守着它不导入 `api.ts` 和内核的几个面；`/mcp/<授权名>` 的行动者是那个授权的 agent，主人命令在主人面的门前以 `agent-session` 拒绝。主人的路由（`/api/*`）在 endpoint 之前就由每次启动造的随机令牌守着，这次没有改：页从自己的地址里拿到它，每次请求带上，按常量时间比较。本机别的进程拿不到它：它只印在服务的标准输出上，应用从管道里读，日志和 endpoint 的记录都不写它。别的网站的页也拿不到它，读不到 `/api` 的答复。
  - 配对和说明限速，每个服务每分钟：`GET /guide*` 120 次，`POST /pair` 20 次，`GET /pair/*` 240 次，超了是 429，带 `Retry-After`。
  - 请求体限大小：`POST /pair` 4 KiB，`POST /mcp` 8 MiB，`/api` 1 MiB，超了是 413。
  - 留下的：这台机器上别的用户能先占住 7638，假冒 endpoint。应用显示的总是实际用到的地址，主人照着说就不会被接走。

## 7. 认知的拼装

库根目录的说明由三部分拼成，配置一变就重拼：

1. 内核的那几句：这是你的库，带进来的和做出来的放这里，下次从这里找；动词怎么用；主人在管理界面上看到的每一页都能用 `show` 看，`show` 列出它们；归档；不要覆盖或删除已有的东西，不用了就归档。
2. 每个已装插件的认知段，按配置次序。每段以一个说出它带来什么的标题开头（「来历：每样东西从哪来」「版本：留住每一版」），第一句是「这个库装了**X**插件。」。一段不重复别的段管的规矩：归档和 `--include-archived`、「在库外写好再 put」归内核。
3. 内核的规矩，和要主人做管理的事时怎么用 `ask` 请，带一个例子。其中同名时的那句话按已装插件的 `keeps` 三选一：没有插件有 `revise`，放入内容不同的同名东西被拒绝；有 `revise` 的都只留一部分，有插件留住时才换上，不然拒绝，答复会说；有一个留住全部，换下的旧内容由插件留着。
4. 当前的配置：装了哪些插件，各自的说明在哪。

五个插件都装上时说明不到 160 行；只装记账插件时不比装别的插件之前长。`packages/cli/test/description-commands.test.ts` 读拼好的说明，把其中每个命令示例照原样在 agent 的会话里跑一遍，所以哪一段都不会和命令走样。

说明里许诺的能力不超出已装插件提供的。没装记账插件，说明里就没有「每样东西都能回到它出现的场景」这句话。

技能是一个指向说明的短文件，带着库的位置、授权的名字和这台机器上的命令（第 6 节「接上一个 agent」），为每个 agent 产品各放一份。

## 8. 库的结构

```
<库>/
  PNEUMA-BASE.md              说明（认知的载体，由内核拼，经存储写）
  .pneuma-base/
    config.json               库根的声明：库标识、格式版本、插件表、授权
    noise.json                噪音：存储不报告、不进入的名字和路径。跟着库走
    tmp/                      存储写到一半的东西：中断的写由下一次写清掉或补完。不同步
    trash/                    存储删东西时先改名到这里再删。不同步
    holds/                    存储的占位：正在写、记录随后就到的位置。不同步
    cache/                    存储的缓存区：每个记录处的行（rows/<名字>.sqlite）、大目录排好的名字（names/）。随时可删，不同步
    requests/facts/           内核的记录处 requests 的事实：agent 提的请求（第 4 节「请主人做」）
    <插件名>/                  每个插件的记录处：facts/ 下是它的事实，其余是它自己的地方
  _archive/                   归档区，里面保持原来的相对路径
  <某个目录>/.pneuma-item      带这个标记的目录是一样东西
  ……                          其余都是内容，随便怎么放
```

有进程在听时，缓存区里还有存储的变化日志（`changes/`）。`.pneuma-base/cache/` 删了，存储的答复不变，只变慢：行从事实重新推出，名字重新列，听的进程一秒内发觉，重新记一份日志，这之前的问都说不出。同步插件不同步它（第 12 节），符合性检查也不比较它（第 5 节）。

**声明和说明。** 库的配置是库根的声明，经存储的 `declaration.read`、`declaration.write` 读写（`library.ts`）：写带预期，就是读到时的令牌，还没有声明时是空；别的写者插进来，就重读再写。内核不认识的字段原样留着。每次改配置都重拼说明 `PNEUMA-BASE.md`，经存储的 `write` 写，同样带预期（第 7 节）。`init` 先让存储建库（记录区、缓存区、缺省的噪音名单），再写声明和说明；文件夹里已有声明时，读得懂读不懂都一样，以 `already-a-library` 拒绝。

**噪音。** `noise.json` 声明名字（任何一层叫这个名字的都算）和库内路径（它和它下面的一切）。存储从不报告、不进入噪音：列一层时不列，数的时候不进去，对噪音位置的操作答 `noise`。`init` 经存储写下缺省的名单（`core/README.md`：`.git`、`node_modules`、`.DS_Store` 这类）；没有这个文件的库按缺省的名单算。内核的三条命令在 `noise-commands.ts`：`noise list` 列出，agent 也能跑；`noise add <库内路径>`（或 `--name <名字>`）和 `noise remove`，只给主人。配置页有「噪音」一节；主人对一个关着的目录答「不用管」，就是 `noise add` 它（第 10 节）。插件名就是它记录处的名字，所以内核的记录处 `kernel`、`requests` 和存储自己占的 `tmp`、`trash`、`holds`、`cache` 都不能做插件名；`noise` 是这三条命令的头一个词，也不能（sdk 的 `RESERVED_PLUGIN_NAMES`）。

本机还有一个目录，不是库的一部分，缺省是 `~/.pneuma-base`，可以用 `PNEUMA_BASE_HOME` 换：

```
$PNEUMA_BASE_HOME/
  bin/pneuma-base             本机的命令：接上的 agent 按这个路径运行，内容由提供命令行的一方保持最新（第 6 节）
  grants/<名字>.json          发给 agent 的授权副本
  endpoints/<端口>.json       在跑的界面服务各一份：地址、进程、服务的库；不带令牌，关掉时删（第 6 节「本机的 endpoint」）
  pairings/<号>.json          agent 的配对请求，<号>.decided.json 是主人的决定；各写一次，都留着
  connections/<授权名>/        agent connect 写进别的程序的东西的记录，和改之前那份文件的副本（before/）
  app/                        Mac 应用自己的小配置和日志（app/README.md）
  plugins/<名字>/              装到这台机器上的插件：index.js、它导入的文件、可选的 ui/
  secrets/<插件名>/<密钥名>     插件的凭证，只有用户能读，不进任何库
  cache/<库的 id>/<插件名>/    插件的缓存，删了能重建
```

## 9. 内核的不变式

| 编号 | 性质 | 由什么守 |
| --- | --- | --- |
| K1 | agent 面的任何调用，不让库里已有的内容或已有的记录变得找不回 | 放和归档的全化表；每次写都带预期；`revise` 的契约；测试 |
| K2 | 没有任何插件时，七个动词都给出确定的答复，不报错 | 空配置的端到端测试 |
| K3 | 换插件不改变七个动词的请求和结果的形状 | 类型 |
| K4 | 内核不依赖任何插件；插件只经内核的公开接口接触内核 | 包的依赖；lint 的导入规则 |
| K5 | 两个面的每次操作都产生一个事件，发给所有插件。视图不是操作，不发事件 | 管线的单一出口；`ownerFace.dispatch` 是主人面的唯一入口；测试 |
| K6 | 说明里许诺的能力不超出已装插件提供的 | 拼装只从配置和插件的认知段取材；测试 |
| K7 | 破坏性的操作只在主人面，要人当面确认，在 agent 的会话里被拒绝 | 主人面命令的声明里带「破坏性」标志，由内核统一拦；只给主人的命令（`ownerOnly`）在同一道门被拒；`ask` 只记下要什么，`request approve` 让那条命令以主人的身份再过这道门；测试 |
| K8 | 一个插件出错不让动词失败，也不被静默吞掉 | `problems`；测试 |
| K9 | 归档的东西不被删除；默认的找和查不带它，开关打开才带 | 归档的全化表；测试 |
| K10 | 内核和记账插件只经存储读写库的文件夹和记录区 | lint 的规则（`eslint.config.js`，第 3 节）；`storage-door.test.ts` 在故意违反的例子上看它变红 |

## 10. 记账与对账插件

领域模型在 `MODEL.md`。它按插件契约第 2 版写，只经 `ctx.tools.storage` 读写库：事实经 `records.append` 写，答复都从由事实推出的行里查，一次一页；留存经存储复制进它自己的地方。库外的两样不经存储：agent 的对话记录（只看在不在），和主人导出的文件。它接上的槽：

| 槽 | 它做什么 |
| --- | --- |
| `onPut` | 记入册；内容变了的记改。事实带存储说的令牌和修改时刻；内容经过内核时（复制放入）带指纹，登记和挪没有指纹（`null`），不为它读内容。同一路径已在册时，令牌相同，或令牌不同而记录有指纹、读一次内容相同，就是同一份：不写事实，新令牌记成基线。打开的目录的一页散文件（`register-files`）是一条 `items.enter`，已在册的照原样留着。带标记的目录入册时，事实带 `bundle: true`，行里记下它的令牌和它第一层每一项的令牌。放入带的 `note` 记在这次写的 `item.enter` 或 `item.revise` 上，所以 `check` 里一次放入是一行，`inspect` 把它写在那份内容的那一行后面；内容和记录一致、这次不写事实时，记成关于这样东西的一条备注 |
| `revise` | 把旧内容经存储复制进它自己的地方：`held/<条目>/<键>/<名字>`，键是那一版的指纹，没有指纹时是它令牌的 sha256 的前 16 位；目录条目整棵复制。知道那份的指纹而复制出来的对不上（这中间又变了），就不留，答 `declined`。没人登记过的先以来历不明入册。新的由内核放上去；`onPut` 收到的 `previous` 带被换下那份的令牌和指纹（读过时），记一条带留存位置的 `item.revise` |
| `onFind` | 只问记录，不读任何文件：按路径、说过的话、放入带的说明、出处配条目（每样最多记 12 句，每句 300 字），按说过的话配场景；配上的场景带上在其中入册的东西，每个场景最多 20 样。没人登记过的东西不在命中里。`start` 的找（`skipOwnSession`）里，调用者自己这次会话的东西只按路径配，给出时不带场景。行 `find` 一页一页地读，配上的最多取 2000 条来排 |
| `onFound` | 别的插件找到的路径是这次查找它自己也肯给的条目时（`start` 照样不带自己这次会话的），给它所在场景的那一行和来历，和 `onFind` 给条目的那条一样；没人登记过的文件不给。只读行 |
| `onInspect` | 一样东西的来历、现状、它来自什么、什么来自它；一个场景的卡；`@<授权>` 是那份授权的 agent 来过没有：最近一次的事实是什么时候、几次会话、放进几样（节名「来过」，Agent 页的每一行用它）。从行答；行里没有的路径才经 `tools.resolve` 和存储看一眼，说它是哪个目录条目的一部分，或没人登记过 |
| `onSay` | 听得懂：在做什么、决定、备注、来自、改了。`say revised` 只在令牌变了、记录有指纹时读一次内容 |
| `onArchive` | 记下归档和取回；已归档的条目不出现在可能过期等清单里 |
| `onCheck` | 自某时以来的变化；可能过期的；来源不在的；上游有标记的；没人登记过的；没登记的目录（关着的目录）；被直接改过的；不在了的；挪过的（已接回，记一条看到的挪动）。先按稀疏的规则看一遍库（见下面「怎么看库」），再从行里取。每节最多点名 20 样，多的写一行「……共 N 样，看全部：show ledger.standing --kind <种类>」；节的 `data` 是 `{ count, shown }`。带 `deep` 时先做深查，多一节「按内容查」。每次查记一条「看过了」（`checked`）：「上次」就是这个行动者上次查的时候，没查过时是它上次在别的场景里留下事实的时候。首页的「都看过了」就是主人查一次，所以 agent 的查和主人的「都看过了」是同一件事；同一个会话里再查，只说上次查之后的。「看过了」不是消息，不进活动，也不算一个场景 |
| `onAsks` | 没人登记过的东西，一处一问，最多 20 问（`unowned.ts`）。打开的目录里有没人登记、主人也没说过不登记的散文件：「<目录>有 N 个文件还没登记。都记为你带进来的吗？」（这一层只看了前面的时写「至少 N」），推荐的回答是 `ledger register <目录>`，另一个是 `ledger leave <目录>`。关着的目录：「<目录>/ 没登记。」三个回答，没有推荐的：登记成一样东西（`put` 登记，主人带进来的）、登记里面的文件（`ledger register <目录> --inside`）、不用管（`noise add <目录>`）。多过 20 处时，前 19 问照给，第 20 问说还有几处、都在 `show ledger.standing --kind unowned`。一个刚建成库的文件夹的头一分钟就是这样，所以它们是问题，不是首页「需要留意」里的问题；后来又来一堆，同一问再问 |
| `openDirs` | 行 `dirs` 的键：任意深处有登记过的东西的目录。先把新事实折进行 |
| `observe` | 把做成了的主人面操作记成事实；主人批准的请求跑的那条命令，做成了或被拒都记，带上谁请的和请求号（`owner.op` 的 `request`，被拒的另带 `refused`），`request approve` 自己不另记，`ledger stats` 不记；`request decline` 记下它拒绝的请求号和当初是谁请的（`declined`，从行 `requests` 里找；在这之前写的拒绝只在答复的那句话里有请求号，统计和导出从那句话里认）；agent 提请求和撤回记成 `request` 事实，同一个请求再提不记；清归档时，被删的路径上的条目记为已除 |
| `views`、`onView` | 每一页是行上有界的查询，长的一页接一页，最后一行链到下一页。`ledger.items`（库）：左边是文件夹的树（行 `dirs`，每层带它下面有几样，最多 2000 个文件夹），选一个就只看那里面的（参数 `dir`）；右边一张表，一页 200 样，整个库按最近改动排（行 `bytime`），一个文件夹里按路径排；路径、来历（灰字，来历不明的是标签）、谁（可让的列：面板里也有）、现状（一致是灰字；变了、依据上有标记时是标签）、时间；「显示」全部、带进来的、做出来的、已归档，每个选项带数目；行链到内核的 `item` 面板。`ledger.activity`（活动）：最上面一节「导出」，折着，给出导出全部记录的命令；然后是事实，新的在前，一页 50 条，按天分组，含主人面的操作；一行是何时、谁（记号）、`check` 里的那句话、谁的动作（自己做的、主人做的、主人批准的、看到的；主人批准的另带提的 agent 的记号和请求号）、在哪个场景（链到场景）、凭哪条授权；归档和取回在东西还在原处时带撤销的按钮，后来已被撤回的写一个灰词，别的不写；「谁做的」全部、agent 做的、主人做的，「哪个 agent」列出出现过的每个，选项都带数目。`ledger.stats`（统计）：四个问题，参数 `period`，见下面「统计与导出」。`ledger.scenes`（场景）：每次会话一行，一页 50 次，按开始的那天分组，新的在前：谁、在做什么（没说过就是其中的主人面操作）、放了几样、在哪个目录；行链到场景页。`ledger.scene`（场景页，不进导航，参数 `scene`）：四个数（时长、放入几样、依据几样、几个决定），对话在哪（可复制，标着在这台机器上、这台机器上已经没有了或在别的机器上；在这台机器上时下一行是接着聊的命令，可复制）、谁、在哪，然后是这次会话里发生的，新的在前，一页 50 条，和活动页一样的行。`ledger.standing`（状况）：`check` 的那几节，用同一份 `standingSections` 的取法；每节是一个列表，路径链到那样东西的面板，挪过的链到新位置，只在比节名多说了什么时带一句；参数 `kind` 只看一种，一页 200 样。`ledger.held`（留存）：每份留存、它是哪样东西换下的、大小，最多 200 份。`ledger.home`（不进导航，`home`）：首页上「开始」的第三步，和两部分。「自上次以来」：别人在主人上次看过之后做的事，按场景分组，组名是那个场景说的在做什么，和组名一样的那句不再重复成一行；带「都看过了」，它调的就是 agent 面的 `check`。「需要留意」：每种要看的一行，写着几样，链到只看这一种的状况页；没人登记过的和没看过的目录不在这里，它们是 `onAsks` 的问。主人看过之后没有新事时，「自上次以来」写上次看过是什么时候，下面一行链到活动页。只说了在做什么的场景，那一句就是它的一行。`ledger.scenes` 的答复带 `open`，是最新的那个场景：窗口放得下时，界面在旁边的面板里打开它 |
| `onItemView` | 条目详情里「来历」一节，次序固定：何时、谁、哪个场景（写那个场景在做什么，链到场景页）、在哪，现状只在不一致时写，并入了哪个目录；「怎么来的」：来历与出处、先前的来历，依据（每个依据的现状，一致是灰字，链到上游的 `item`）；「发生过什么」：每次换内容和那次放入带的一句话、说过的决定与备注（决定由标签说，灰的一行不再写「决定」），新的在前，标出哪一份在留存里；「凭什么」：凭哪条授权，它的区域和读写；被什么依据；留存，每份说是谁放进来的那份内容，不说它放在哪。动作放进面板底下那一行。数据就是 `inspect` 用的 `itemView`。路径上记着的条目，或看库时认出挪到这里的条目（行 `taken`），就是面板说的那样东西；没人登记过的文件说明来历不明；带标记的目录里面从没入册的文件说明它是谁的一部分。动作都经两个面：来历不明的给「记为带进来的」「记为做出来的」（`put` 登记）；被直接改过的给「认下这次改动」（`say revised`）；每份留存给「取回到新路径」（`ledger held restore`）。状况页的「没人登记过的」「被直接改过的」两节，每一项带同样的动作；「没登记的目录」一节，每一项带对关着的目录的三个回答（见 `onAsks`） |

它给主人面加七条命令，名字和别的插件一样以它的名字开头：`ledger held list` 列出留存（最多 200 份，多的说共几份），只读；`ledger held restore <库内路径或条目号> [--fingerprint <指纹>] --to <新的库内路径>` 经存储把一份留存复制到一个空着的新路径（`--fingerprint` 按留存的键的开头认，不写是最近换下的那份），目录条目整棵复制回去、写上标记，并把它以「主人带进来的」入册，只给主人；`ledger held drop` 经存储拿掉整个 `held/`，是破坏性的；`ledger register [<目录>] [--inside]` 把没人登记过、主人没说过不登记的散文件以「主人带进来的」入册：不写目录是所有看过的打开的目录里的，写了只登记那一层的；`--inside` 登记那个目录任意深处的全部文件（噪音除外，`.` 是整个库），先用一次预算 5000 的 `probe` 说有多少（超出时说「至少」），再一层一层地经 `overview` 取，每 500 样写一条事实，在标准错误上报进度，Ctrl-C 在手上那批写完后停下，登记过的不会重来；只给主人。登记不读任何内容：每样东西带着它所在那一层的一览说的令牌、大小和修改时刻入册。`ledger leave [<目录>]` 把那些散文件照原样留着，记下这一堆，不再为它们问，只给主人，状况页照样列着它们；`ledger stats [--period 7d|30d|all]` 用字回答统计页的四个问题，只读，agent 也能跑，和看那一页一样不留记录，`--json` 给全部的数，含按天（按周、按月）的；`ledger export --to <库外的文件> [--since <时刻>] [--until <时刻>] [--format jsonl|csv]` 把活动的每一条导出到库外的一个文件，给审计用，只读，只给主人（见下面「统计与导出」）。都由内核的门拦。

事实的种类在 `facts.ts`，归并在 `fold.ts`，看库在 `look.ts`，要留意的标记在 `settle.ts`，查询在 `queries.ts`。

**记下来的。**

- 事实经存储写（`facts.append`），放在 `.pneuma-base/ledger/facts/<YYYY-MM-DD>/<时刻>-<写者>-<序号>.jsonl`：每次写入一个名字唯一、写完不动的文件。一个钩子的事实一起写；`check` 记的挪动一页一次，一次登记许多样时每 500 样一次。按场景分目录的旧布局（`facts/<场景号>/`）和直接放在 `facts/` 下的文件照样读（`core/README.md`）。
- `item.enter`、`items.enter`、`item.revise`、`item.move` 带 `token`、`modified` 和 `fingerprint`（没读过内容时是 `null`）。`item.enter` 和 `item.revise` 另带 `size`；目录条目的 `size` 只在它被复制进来时知道。
- `items.enter`：一次登记许多样东西，共一个来历（`register-files` 的一页，或 `ledger register` 的每 500 样），每样是 `{ item, path, fingerprint, size, token, modified }`。`fold` 把它当成一样一条 `item.enter` 来归并，事实还是一条；活动和「自上次以来」不单列它，那条命令的 `owner.op` 一行就说了这件事。`unowned.left`：主人留着不登记的路径（`ledger leave` 写的），`fold` 收进 `left`；同样不单列。
- 目录条目：`item.enter` 带 `bundle: true`。已经在册、路径在一个后来入册的目录条目下面的条目算「并入」了它，这是 `fold` 推出来的，没有新的事实种类。并入的条目跟着那个目录挪、归档、被清掉；它不报「不在」，不出现在 `find` 和 `check` 的清单里；看它时说明它并入了哪里。依据它的东西照它记着的那份判可能过期，那个目录变了就算「不知道」，也标可能过期。目录里面从没入册的文件，看它时说明它是哪个目录条目的一部分。`say` 写的路径在一个带标记的目录里面时，说的是那个目录。
- 两份是不是同一份（`sameVersion`）：两边都有指纹就比指纹，否则两边都有令牌就比令牌，都说不出就当不同。依据记下的是那个来源当时的令牌和（知道时的）指纹，可能过期按同样的规则比。
- 用词：被新内容换下的旧内容进**留存**，是给主人的保险，只有主人取得回（`ledger held restore` 只给主人）。记账插件的说明、放的答复、`inspect`、界面都说留存、换了新内容，不说版本或一版：版本归版本插件。`inspect` 列出内容换过的每一次，「被换下，在留存里」标在被留存的那一份上。
- `put --made --from` 写了被换掉的东西自己时，依据里不记它自己：换内容本身就是 `item.revise`，它不是自己的依据。
- 给来历不明的条目补来历的那条 `item.enter` 是它的别名，不多一份内容；它带的 `note` 由 `fold` 放到它登记的那份内容上，那份已有一句时不盖掉。
- 看到的来历和改动（第 4 节「看到的和说的」）：`put --observed` 写的 `item.enter`、`say revised --observed` 写的 `item.revise`，信封的 `how` 是 `observed`，事实本来就记着它是怎么来的。来历显示的每一处都带「（自动登记）」：「带进来的，主人给的（自动登记）」；看到的改动是「直接改的，自动登记」。之后谁再登记同一路径、内容没变、写明了来历，就换掉看到的来历，和今天给来历不明的条目补来历一样（「已更正来历」）；`fold` 把被换掉的那条 enter 留在 `earlier` 里，`inspect` 写成「先前：…」，条目的「谁」「何时」「场景」跟着说的那一条。之后谁再 `say revised`（带不带 `--by owner` 都行）同一份内容，就换掉看到的那条改动的归属，版本不多一个，那一版标「先是自动登记」。说的永远不被看到的换掉：内核和记账插件都不让看到的盖过说的，`fold` 里事实的次序反过来（同步带来的）也一样。`--observed` 只给主人；`say revised --observed` 不和 `--by` 一起写，看到的不知道是谁改的。
- `say revised <库内路径>` 认下一个被直接改过的文件的现内容，记一条 `claimed` 的 `item.revise`。主人说是自己改的，agent 加 `--by owner`：事实体带 `by: 'owner'`，信封的 `actor` 仍是这个 agent，显示时两个人都出现；主人自己说时不带 `by`。信封的 `actor` 是库从授权和会话认出来的，调用方说什么都不改它。
- 主人面操作的事实里，答复写成一行：几行连起来，绝对路径和 `file://` 地址只留最后的名字。它在 `check`、场景卡和动态里给人读，名字就够了。只读的命令（事件的 `readOnly`）照样记，但不算「自上次以来」的消息；只设插件、目标或嵌入器的命令（事件的 `setup`）在某个行动者第一次来之前发生的不算消息（说明里已是最新配置），在它来过之后再改才列出。
- 「自上次以来」只列改了内容或能力的事。不改两者的主人面操作（`init`、`grant issue`、`grant revoke`、`skill install`）照样记成事实，但不列出；名单是 `facts.ts` 里的一个集合。
- 场景号在文字答复里只显示前 8 位（临时场景 `adhoc-…` 显示全），工作目录把家目录写成 `~`、过长时只留最后 45 个字符（内核的 `shortDir`，界面里窄的地方给更短的上限）；`--json` 给全的。`inspect` 和 `find --scene` 接受场景号的前缀，至少 6 个字符；`inspect` 遇到几个场景共用的前缀，列出它们的全号。

**行。** 状态是记录处里的行，从事实一步步推出：读存着的游标之后的事实，一页 2000 条，折进行，把改了的行和新游标在一次提交里存下（`rows.ts` 的 `Tx`）。一次折只读这一页事实点到的行和由它们够得着的几行（目录条目并入的、来源的依据者），没有一处把整份事实读进内存。行的形状记在 `meta` 里，和代码的不一样，或者游标对不上了（事实被删了），行全部丢掉，从头推。两个进程同时折同样的事实时，后存的那个不写，重读再来（`rows.put` 的 `expect`）。表和可查的字段：

| 表 | 一行是 | 按什么查 |
| --- | --- | --- |
| `meta` | 行的形状、计数、存储给的变化的号 | |
| `ids` | 折过的事实号 | |
| `items` | 一样东西：路径、来历、依据、记着的那一版（令牌、指纹、大小、修改时刻、目录条目第一层每项的令牌）、上次看到的现状、它的标记 | |
| `paths` | 路径上记着的条目 | `parent` |
| `alias` | 别名指向的条目 | |
| `dirs` | 打开的目录和它下面登记了几样 | `parent` |
| `seen` | 打开的目录上次列出的一层：令牌、前 200 项、至少还有几项、它的散文件 | `loose`、`more`、`token` |
| `tokens` | 看库对一个登记过的位置的预期，值是那样东西 | `token` |
| `marks` | 要留意的一行：一样东西的标记或现状，或打开的目录里一个没人登记的东西 | `kind`、`sig` |
| `taken` | 看库时认出挪到这个路径的条目 | |
| `left` | 主人留着不登记的路径 | |
| `log` | 活动的一行，新的在前 | `who`、`agent`、`scene`、`news` |
| `scenes`、`sceneOrder` | 一个场景；场景按开始的时刻，新的在前 | |
| `touch` | 一个场景动过的一样东西 | |
| `actors` | 一个行动者：第一次来、上次查、上次在哪个场景、几次会话、放进几样 | `kind`、`grant` |
| `history` | 一样东西的每一版和说过的话 | |
| `held` | 一份留存 | |
| `find` | 找要配的一样东西或一个场景 | `scene`、`origin` |
| `bytime` | 一样东西按最近改动排的位置 | `show`、`live` |
| `stats`、`hrev` | 统计：一个 UTC 小时一行；每个小时结束时要收拾的有多少 | |
| `requests` | 一个请求和它现在的结果，给统计 | |

**怎么看库。** `check`、`start` 里查的部分、首页、库页、状况页和条目面板先看一遍库（`look.ts` 的 `refresh`），一次操作只看一遍：`check` 和它的问、首页和它的问共用一次。

- 变了什么从存储的游标学来：带上次存下的游标问 `tools.storage.changed`。答得出、动过的位置不多过 1000 个时，只看那些位置上、它们里面一层和它们上面的登记过的东西，和它们之中、它们上一层的打开的目录。答不出（没有常驻的进程在听、这台机器没有可靠的游标、游标不认识），或多过 1000 个时，让存储拿行比：先比 `seen` 里每个打开的目录这一层的令牌，再比 `tokens` 里每个登记过的位置的预期（`lookRows`，在存储里一页一万行），只看答回来的不同的，一次存下。从不走库。
- `tokens` 一个位置一行，存着看库对它的预期：一致的是记着的令牌，变了的是上次看到的令牌，不在了的是 `empty`（那里该什么都没有）；令牌或目录条目的第一层还不知道的、挪走了的不写预期，存储总把它答回来，挪走了的每次看都重新认出它去了哪；目录条目的第一层每项各一行。改一样东西的行时一起写（`putItem`）；不再有东西预期的行，存储答回来时删掉。打开的目录一打开就有一行 `seen`，还没列过的不写令牌，库根在第一次折事实时就有。
- 令牌没变就是记着的那份。令牌变了，只在记录有指纹（或依据它的东西记过它的指纹）时读内容判，一次最多读 8 个：内容一样，只是碰过，静静地把新令牌记成基线；不一样，是被直接改过的。没有指纹的，令牌变了就是被直接改过的。种类变了也是。不在了是「不在了的」。正被写入的位置（存储标着被占）按记录算，不报。
- 目录条目比它自己和它第一层每一项的令牌，变化说在这样东西上，不说它里面的文件；更深处的改动看不到。
- 一个打开的目录只在它自己的令牌变了（或从没列过）时再列一层，每次最多 200 项，多的在「没人登记过的」里说至少还有几个没看。其中没人登记、不是打开的目录、没被认作挪动的：文件是「没人登记过的」，目录是「没登记的目录」（关着的目录），里面不打开。噪音存储不报，这里也不提。
- 挪动只在打开的目录里认，按种类、大小和修改时刻：恰有一个散的东西对得上，也只有一个不在了的条目要它，才算挪过的。`check` 把它记成一条看到的 `item.move`，记下之后不再提。
- 事实带着写下时的令牌，折进行就是新的基线。目录条目入册后、同一份内容换了令牌后，另把那里现在的令牌（目录条目连同它的第一层）取一次存下（`rebase`）。
- 每次改了一样东西的现状，只重算它和依据它的东西的标记（可能过期、来源不在、上游有标记、来历不明），和改了的打开的目录的散的东西（`settle.ts`）。
- 看库只改行，不写事实；看到的挪动留给 `check` 记。`inspect` 和条目面板的「来历」不看库，只读行。

**深查。** `check --deep [<目录>]` 读登记过的每样东西的内容（写了目录就只读那下面的）：先从行里的计数说要读多少，一页 100 样、一次 8 个地读，每页在标准错误上报进度、存一次，Ctrl-C 在手上那页做完后停下，查过的都记下。记录有指纹的：内容不一样是变了；一样而令牌变了，是只碰过，按现在的记下。没有指纹的：令牌没变（或没记令牌），就把读到的指纹记成记录的，此后按内容判；令牌变了的照看库的判法，不改。读不了的另列。没人登记的散文件、关着的目录、噪音都不读。答复的一节「按内容查」说查了几样、哪些变了、哪些只是碰过、哪些读不了，每种最多点名 20 样。

**统计与导出。** `ledger.stats`（统计，导航里在「活动」后面）和 `ledger stats` 是同一个答复。`fold` 把每条事实数进它那个 UTC 小时的一行（行 `stats`），每个小时结束时要收拾的有多少另记一行（`hrev`）；`stats.ts` 的 `statsFrom` 只读这段时间的那些小时的行，加起来；`stats-page.ts` 把它排成四节，每节先是一句带数的话，形状随时间有意思的地方跟一张 `chart`；只有一格或全是 0 时只留那句话。命令的字从这一页的块里读出来，所以两边说的一样；`--json` 另给按格的数。它不读库里的文件，也不看库，所以不论库多大都一样快：第四问的数是「按账上的记录」，页上这么写，文件现在对不对得上看「状况」。时间：`7d` 是今天和之前 6 天，`30d` 是今天和之前 29 天，`all` 从有第一条事实的那天到今天；都从这台机器的本地零点算起；图按天分格，`all` 超过 31 天按周（从周一起），超过 26 周按月。每个数的意思：

- 放进来的：这段时间里第一次入册、来历是带进来的或做出来的东西，按入册时的来历分；别名、来历不明的入册、`ledger register` 一次登记的原有东西都不算（最后一样记在主人那一行）。
- 会话：这段时间里开始的会话，开始指某个 agent 在这个场景里留下第一条事实（「看过了」不算）；归在那个 agent 名下，按开始的那天数；图里会话最多的三个 agent 各一个系列，再多的并成「其他」。
- 用了库里已有的：这段时间做出来的东西里，依据（现在记着的，含之后 `say from` 补的，不含它自己）里至少有一样库里的东西。
- 用了别的会话留下的：依据里至少有一样是在别的会话里入册的（那样东西的「谁、哪个场景」说的那次入册）。
- 用了别的 agent 带来或做出的：依据里至少有一样是另一个 agent 入册的，agent 按名字比，不看授权；主人入册的不算。
- 被接着用得最多的：依据里写了它的、这段时间做出来的东西有几样，前 5 个，带上是谁做的；已清掉的不列。
- 谁做了什么：每个 agent 这段时间开始的会话、带进来和做出来的东西、决定、备注、请主人做的事；请的事按现在的结果分：批准了做成、批准了但命令没做成、拒绝、自己撤回、还在等。主人：做了几次操作（只读的不算），其中批准和拒绝了几个请求，放进几样，记了几条决定和备注，一次登记了几样原有的。
- 可能过期：没清掉、没并入目录条目、没归档的东西，依据里有一样记着的内容后来换了，或已清掉。
- 直接改过、还没人认的：同上的东西，最新一份内容是看到的直接改动（`how` 为 `observed` 的 `claimed` 改），还没人说是谁改的。
- 来历不明：同上的东西，入册时没人知道来历，之后也没人补上。
- 已归档：没清掉、在归档区的东西；另说这段时间归档、取回、清掉了几样，记下了几次直接改动（`claimed` 的改，说的和看到的都算）。
- 要收拾的怎么变：每一格结束时前三样各有多少；「开始时」是这段时间开始的那一刻。

`ledger export` 写的每一行就是活动页的一行，次序也一样，新的在前（不含「看过了」和一次登记的那条，和活动一样），不分页：从行 `log` 一页 1000 条地读，读一页写一页，读过了 `--since` 就停；`--since` 含那一刻，`--until` 不含；只写一天（`2026-11-20`）时按本地时间，`--since` 从那天零点起，`--until` 到那天结束。不写 `--format` 时，文件名以 `.csv` 结尾的写 CSV，否则写 JSON Lines。文件要在库外，已有的文件不覆盖（`export-file.ts`）。列名不变，次序如下：`id`（事实号）、`at`（ISO 8601 的 UTC 时刻）、`actor`（agent 名，主人写「主人」）、`actor_kind`（`agent`、`owner`、`plugin`）、`grant`（凭的授权名，授权撤回了写授权号，没有授权是空的）、`session`（场景号，全的）、`kind`（事实的种类）、`path`（这条说的库内路径：入册和挪动写事实记的那个，别的写那样东西现在的路径，没有就空）、`text`（活动页上的那句话）、`whose`（`agent`、`owner`、`approved`、`observed`，同活动页）、`request`（这条提出、撤回、批准或拒绝的请求号，没有就空）。CSV 带表头、按 RFC 4180 加引号（字段里有逗号、引号、换行时整格加引号，引号写两遍），行尾是 CRLF，开头有 UTF-8 的字节序标记，让表格软件认得中文；JSON Lines 一行一个对象，键就是这些列名。导出本身是一次只读的主人面操作，照样记成一条事实，出现在下一次的导出里。活动页最上面的「导出」给出这条命令，可复制：页交不出文件，也不替主人选位置。

**量。** `scripts/bench-line.mjs` 量 agent 的 `start`、`check`、`inspect`、`find`、放一个文件、`archive`，主人的 `show home`，和界面取首页及它的轮询，在空库、约两万样东西和十万条事实（另有一个六万个文件、设成不可读的关着的目录）的库和 `--real` 给的库上，各用多久、印多少字、占多少内存；`--listener` 让一个进程在命令运行时一直听着库。`scripts/bench-changes.mjs` 在两万样东西的库上量什么都没变、变了一样、变了 1000 样之后的 `start`、`check` 和 `show home`，有进程在听和没有的各一列。`scripts/bench-register.mjs` 在库的写时复制的克隆上量把一个大目录登记成一样东西和登记它里面的全部，`--lock` 先把里面的文件都设成不可读：读了任何内容的登记会失败。`scripts/bench-ledger.mjs` 造同样大小的库，量第一条命令（把全部事实折进行一次）和每个时间段的统计及它的页，都作为命令跑。

存放，都在 `.pneuma-base/ledger/` 下，经存储读写：

| 目录 | 性质 | 内容 |
| --- | --- | --- |
| `facts/` | 本体 | 事实，`<YYYY-MM-DD>/<时刻>-<写者>-<序号>.jsonl`：每次写入是一个名字唯一、写完不动的文件；旧的 `<场景号>/` 和直接放在 `facts/` 下的照样读 |
| `held/` | 本体 | 留存：被新内容换下来的旧内容，`<条目>/<键>/<名字>`，等主人清 |

行在存储的缓存区，`.pneuma-base/cache/rows/ledger.sqlite`（第 8 节），删了从事实重新推出，再看一遍库。

这一版不要求 agent 报告读了什么。agent 放东西时写明它依据了哪些，这就是来自。「读了」留给以后的钩子自动记。没有命令行的 agent 只管把文件放进库，它们落在「没人登记过的」，由别人补上来历；这一版不定手写记录的格式。

仓储四问：

| 问 | 答 |
| --- | --- |
| 写入 | 一个钩子一般一次写入，几条到几十条事实；一次登记许多样时每 500 样一条；按事实的编号幂等 |
| 查询 | 每个答复是行上有界的查询：按键取、按前缀或可查的字段取一页、计数。行从事实一步步推出，只折新的事实 |
| I/O | 都经存储：事实只追加，并发的写者各写各的文件，不抢；行和游标一次提交，两个进程同时写时后到的重来；内容只在判差别、深查和留存时读 |
| 容量 | 两万样东西、十万条事实的库上，有进程在听时，`check` 和首页的轮询的代价跟着变了的东西走，不跟着库走（`bench-changes.mjs`）。没人在听时是全比：存储在它里面拿 `tokens` 和 `seen` 的行比每个登记过的位置和打开的目录，只把不同的交回来，两万行约 25 毫秒（`core/bench`），`start`、`check`、`show home` 约 0.2 秒。先坏的还是它：它跟着登记过的东西的个数线性地长 |

## 11. 版本插件

`packages/plugin-version`。声明了「有版本」的东西，每一版的内容都留着，任何一版能导出到库外或放回来。声明是 agent 的 `say`：`say versioned <路径> [一句话]` 声明并把当前内容记成第 1 版；`say version <路径> <一句话>` 给当前这一版写说明。路径在带标记的目录里面时，说的是那个目录。它还按插件契约第 1 版写，经第 1 版的工具读写库（第 5 节「第 1 版」）。

| 槽 | 它做什么 |
| --- | --- |
| `onPut` | 放入之后，声明过的东西内容和最近一版不同就记新的一版，答复里说是第几版；放入带的 `note` 是这一版的说明，内容没变时写在当前这一版上；挪动跟着改路径 |
| `revise` | 只对声明过的路径答「留住了」，而且要当前内容已经是最近一版；不是就先把它记成一版（标明在工具之外改的）。没声明过的答「不留」 |
| `onArchive` | 归档和取回跟着改路径 |
| `onCheck` | 声明过的东西在工具之外被改了，把现在的内容记成新的一版并报告一次；路径上没东西了，每次都报告 |
| `onInspect` | 版本的时间线：第几版、何时、谁、说明、怎么来的、指纹，最新的在前，最多 10 版 |
| `observe` | 清归档区删掉的东西记为「不在库里了」，它的各版内容照样留着 |
| `onView`、`onItemView` | 页 `version.things`：每样有版本的东西一行，版数、最近一版、状态；条目面板：时间线，带「导出到库外」和「放回这一版」 |

主人面的命令：`version list <路径>`，只读；`version export <路径> --version <n> --to <库外的目录或文件>`，也是只读的：它只写到库外，库里什么都不改，`--to` 是已有的目录时导出到它下面的同名处，目标在库里或已有东西都拒绝；`version restore <路径> --version <n>`；`version prune <路径> --keep <n>`。只有 `prune` 是破坏性的：导出写在库外，放回时当前内容先已是一版。agent 能用前三条。

`keeps` 是 `some`：只有声明过的东西它才留住，所以只装它时，说明里同名的那句话说「有插件留住时才换上」，没声明的东西被拒绝时，拒绝的 `notes` 里它说要先 `say versioned`。

**清归档区删掉的东西，它的各版内容留在版本存放里，没有命令再到得了它们。** 这是定下的，不加 `version prune --purged`：这一程不加能力；清归档区丢的是归档区里的那份，要不要连历史也丢，是主人另一个决定。所以 `archive purge` 之后，版本存放还占着那些内容的空间；对那个路径的 `version` 命令以 `gone` 拒绝，说它随归档区清掉了、有几版内容还在存放里，不说它没声明过。

实现里和本程细化设计不同的几处：

- 记新的一版放在 `onPut` 而不是 `observe`：`onPut` 能把「记为第几版」放进放入的答复里给 agent 看。挪和归档跟着改路径也走 `onPut`、`onArchive`。
- 放回经内核的放：命令把那一版导出到系统临时目录，再调 `agentFace.put` 放到原路径。所以别的插件都看得到，事件照发，授权的门照样拦。内核没有给主人命令「经放写库」的专门接口，这样做不用改内核。
- 版本号数全部的版，清掉的也算，所以号码永远不变。一版和更早的某一版内容相同时，标「同第几版」，放回的那一版就是这样。
- 清掉的版本只删只属于它们的内容文件：别的东西、同一样东西留着的版本还要用的内容不删。

存放，都在 `.pneuma-base/version/` 下：

| 目录 | 性质 | 内容 |
| --- | --- | --- |
| `objects/` | 本体 | `<sha256 前两位>/<sha256>`，按内容寻址，写了不改，相同内容只存一份。先写临时名、核过 sha256 再链接到最终名 |
| `facts/` | 本体 | `<场景号>/…jsonl`：声明、每一版的清单（每个文件的相对路径和 sha256，单个文件只有一行，路径为空）、说明、挪动、不在库里了、清掉。和记账插件一样，每次写一个名字唯一的新文件 |

## 12. 同步插件

`packages/plugin-sync`。库和一个同步目标双向同步：只整份地复制文件，不合并内容；同步前任何一边有过的每一份内容，同步后都还在两边的某处。只有手动的 `sync now`，没有后台进程。它还按插件契约第 1 版写，经第 1 版的工具读写库（第 5 节「第 1 版」）。

| 槽 | 它做什么 |
| --- | --- |
| 主人面命令 | `sync target set --kind dir --to <目录>`，只给主人；`sync now`；`sync status`，只读。都不是破坏性的，后两条 agent 也能跑 |
| `observe` | 破坏性的主人面命令做完之后，记下主人有意删掉的内容（见下面「主人有意的删除」） |
| `onCheck` | 「同步冲突」：还在的冲突副本（归档区里的不算） |
| `views` / `onView` | `sync.status`：目标、这台机器上次同步、待同步的数目（按一次空跑算）、冲突副本各带「归档」，按钮「现在同步」「设同步目标」 |
| `onItemView` | 冲突副本：它是哪个文件的另一份，带「归档」；有冲突副本的文件或目录条目：列出它们。别的东西没有这一节 |

它不听任何 `say` 种类。挪和归档是按内容认出来的，`observe` 只用来接破坏性的主人面命令。

**规则。** 每个路径按本地、目标、基线三处的指纹（不在为空）由纯函数 `decide` 定成不动、推、拉、冲突、删五种之一，就是设计里那张表的全化：没有基线（第一次同步，或基线丢了）时，只在一边的复制过去，两边相同的不动，两边不同的算冲突。然后 `plan` 算出同步完两边应有的文件，再补一遍：同步前任何一边有、而同步完哪里都没有的内容，冲突时目标那份拉成 `<名字>.conflict-<机器>-<时刻><扩展名>`；内容区以外（归档区、`.pneuma-base/`）被另一边删掉的，原样放回；其余的复制进 `_archive/<路径>`，名字被占时加指纹的前八位。所以设计表里「同样的内容别处还有（是挪）就删，否则进 `_archive/`」也管到了推和拉换下的旧内容：同一个路径上被换掉的内容，要是别处（比如记账插件的留存）没有副本，也进 `_archive/`。冲突时本地的那份留在原处，并在同一次同步里推上去，两边一次就一致。

**执行。** 步骤的次序是先留存、再复制、最后删除。每一步动手前核对文件还是计划看到的那份，不是就跳过，留到下次。写一律先写临时名再改名。目标出错时停下，以 `target-failed` 拒绝，做完的步骤记进基线，重跑从现状重新算。

**范围。** 整个库文件夹，含 `.pneuma-base/` 里各插件的记录，逐个文件，目录条目连标记一起。不含：`.pneuma-base/config.json` 和 `PNEUMA-BASE.md`（每台机器的配置：授权、插件表和给缓存目录作键的库标识，说明由它拼出）；`.pneuma-base/tmp/`；存储的缓存区 `.pneuma-base/cache/`；已装插件声明为缓存的目录；任何一层的 `.git`、`node_modules`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`、`.tmp-*`；目标里的 `.pneuma-sync/`。

存放：

| 位置 | 性质 | 内容 |
| --- | --- | --- |
| `.pneuma-base/sync/facts/` | 本体，同步 | 每个事实一个名字唯一、写完不动的文件：`target.set`（哪台机器、目标）、`run`（计数、冲突、留下的、成败）与 `deleted`（哪条破坏性命令、删掉的路径和指纹） |
| `.pneuma-base/sync/tmp/` | 缓存 | 写到一半的临时名 |
| `<缓存目录>/baseline.json` | 本机，不同步 | 这台机器上次同步完两边的清单，带目标的标识和已了结的 `deleted` 事实的编号 |
| `<目标>/.pneuma-sync/id` | 目标里，不同步 | 目标的标识。目标是新的或被清空时没有它，基线就不适用，当第一次同步 |

**目标。** 接口是 `list`、`read`、`write`、`remove`，库自己也按这个接口当另一边。自带的只有 `dir`。目标按机器记：用这台机器最后设的；这台机器没设过，用任何机器最后设的。`sync target set` 建不了那个目录（盘没挂上、没有写权限）时以 `target-unreachable` 拒绝。目录在这台机器上不存在时，`sync now` 以 `target-missing` 拒绝，什么都不动（不替它建目录：没挂上的盘会被当成一个空目标），`sync status` 和视图都说明它是哪台机器设的。目标和库互相包含时以 `target-overlaps` 拒绝。

**一次同步自己的记录也在这次同步里。** `run` 事实写好后马上推到目标并记进基线，所以一次什么都没变的同步不会留下待同步的东西。记账插件在命令之后记下的那条主人面操作，下一次同步带走。

和设计不同的几处：推和拉换下的内容也按「别处没有就进 `_archive/`」留存，因为不这样做，同步前有过的内容会在两边都没有；配置文件和说明不同步；`.git` 和 `node_modules` 不同步；多了目标的标识；目标按机器记。主人有意的删除经同步传到另一边，见下一段。

**主人有意的删除。** 主人用破坏性命令（`archive purge`、`ledger held drop`、`version prune`）删掉的内容经同步传到另一边，不再被放回来。插件接 `observe`：破坏性的主人面命令做完（`done`）后，把这台机器基线里有、库里已经没有的路径连同基线里的指纹记成一条 `deleted` 事实，它和别的同步事实一样同步。`plan` 把这些删除当输入：一条删除只在它的指纹就是这个路径的基线时算数，这份内容在这个路径上不再留存，`decide` 原有的「删」就在还有它的那一边删掉它，`decide` 本身不变。路径上的内容换过了（这边改过，或删除后放回了别的内容），或这台机器没有基线，就按原来的规则走：没有基线时分不清是被删的内容还是放回的内容，宁可留下。`sync now` 也读目标上还没到这边的 `deleted` 事实，所以另一个库在带来它的那次同步里就照办。基线记下已了结的删除事实（它的每个路径的步骤都做了，或没有步骤）；了结的事实不再算数，所以以后在同一路径放回同样的内容、再被手动删掉，仍按不丢内容的规则留存。步骤跳过或没做到的，下次同步再算。别的删除（手动删的文件、被拒绝的破坏性命令）照旧不丢内容。已知的不精确：上次同步之后、破坏性命令之前手动删掉的基线里的文件，也算进这条事实。

## 13. 部署插件

包 `packages/plugin-deploy`，名字 `deploy`。agent 用 `say deployable <库内路径> [一句话]` 声明一样东西（文件或带标记的目录）可以部署，声明不让它上线；主人用开关决定它在不在线；开着的东西，目标上跟着库里当前的内容。

它是 sdk 的**部署库**加两种目标：`deployPlugin('deploy', [dirTarget, commandTarget])`。部署库（`@pneuma-base/sdk/kit`，代码在 `packages/sdk/src/kit/deploy/`）拿一个插件名和一种或几种目标，交回一个完整的插件；和目标无关的都在它里面，第三方的部署插件只写自己的目标。库不是插件，插件导入库不算插件导入插件；库不导入内核，对库的读写都经 `tools.storage`。状态表、决定表、站点名的规则和目标的接口在 `packages/sdk/src/kit/deploy/README.md`。一个库只装一个部署插件，这是设计：几个部署插件都认领 `deployable`，第二个在 `plugin add` 时以 `name-taken` 拒绝；要发到几种地方，是一个部署插件带几种目标。

它接上的槽（别的部署插件一样，命令和页面以它自己的名字开头）：

| 槽 | 它做什么 |
| --- | --- |
| `onSay` | 听得懂 `deployable`：路径要是库里在主区的东西，带标记的目录里面的路径算那个目录 |
| `onPut` | 放入了新内容、登记了在工具外改过的内容、挪了位置：对那样东西对一遍，答复里说重新发布了什么；目标失败时答复带 `problems`，放照样成功（K8），退出码 3。这句话先说放入本身已经成功、只是没跟着上线；调用者是 agent 时（比如沙箱里写不到目标）再说这不是它的放入出了问题、不用重做，上线等主人在自己的终端里跑 `deploy sync` |
| `onArchive` | 归档的东西下线；取回的按开关重新上线；目标失败同样经 `problems` |
| `onInspect` | 状态、地址、开关、站点名 |
| `onCheck` | 「线上和库里不一致」：待发布、待下线、开着但路径上没有东西的、读不到目标的。已归档但目标上还有的也列，因为它还对外可见。记录里读不懂的行另列一节 |
| `onAsks` | 声明了可以部署、主人从没动过开关、还在库里的东西，每样问一句要不要上线，推荐「上线」，另一个回答是「不上线」。哪个回答都记下一条开关（开关本来就关着，「不上线」也记），所以「主人定过了」是记录推出来的，之后不再问 |
| `onPurged` | `archive purge` 清掉的声明：先把目标上剩下的撤下，再去掉声明 |
| `onRemove` | 目标上还有它的站点时拒绝卸下，说有几样在线、先用 `deploy off` 关上；主人 `--anyway` 卸下时，答复复述这句话，列出留在线上的 |
| `views` / `onView` / `onItemView` | 页 `deploy.sites`：目标和配每种目标的按钮；可部署的东西一张表，路径、状态、地址（可复制，网址可点开）、每行一个开关，「对一遍」。条目面板里的「部署」节：状态、开关、地址、站点名、开关按钮。目标可以在两处加列、字段和块，含 `custom` 块 |

一个决定：目标上该有什么，只看开关、是否在归档区、路径上有没有东西（`model.ts` 的 `want`）。对账（`plan`）拿它和目标上有的比，先发布再撤下旧名，两边一样就什么都不做。开关、放、挪、归档、取回、`deploy sync` 都跑同一个对账，所以 `deploy sync` 跑几遍结果一样。

主人面命令，都不是破坏性的：`deploy on <路径>`、`deploy off <路径>`、`deploy target set --kind dir --to <目录>` 或 `--kind command --publish <发布命令>… --unpublish <下线命令>… [--url <地址模板>] [--timeout <超时秒数>]`、`deploy sync`、`deploy list`（只读）。对外发布是对外的动作，所以前三条是 `ownerOnly`，由内核的门在 agent 的会话里拒绝（第 6 节），插件自己不再看上下文。`deploy sync` 和 `deploy list` agent 也能用，它们只照主人的开关办。开关在目标失败时照样记下，答复以 `publish-failed` / `unpublish-failed` 或 `no-target` 拒绝并说明现在的状态。每条命令都有参数表；`target set` 的由各种目标的开关拼成：`--kind` 选目标（只有一种时可不写），其余是每种目标的开关，几种目标都有的开关意思要一样，否则 `deployPlugin` 抛错；有几种目标时，选定的那种必填的开关、不收别的种类的开关，由部署库在 `configure` 之前核对。页面上每种目标一个按钮，表单用 `formOf` 从那种目标的开关生成。

目标是一个接口（`TargetAdapter`，sdk 的 `defineTarget` 让 `configure` 收到按开关定好类型的值）：怎么配（`params`，`target set` 在 `--kind` 之后的开关，一份 `FlagParam[]`，用法、核对和表单都从它来；`configure` 把核过的值变成要存的配置；给人看的说明；`secrets`，它读的密钥），怎么在边界上解析存下的配置并打开它。部署库把各种目标的 `secrets` 声明成插件的 `secrets`，所以 `secret set <插件名> <名字>` 和配置页都认得；打开目标时给它 `secret(名字)`，读主人在这台机器上设的值，必需的没设就以说明用哪条命令设的错误拒绝，开关的答复里是 `publish-failed` 带这句话，可选的（`optional: true`）没设读出 null；`target set` 的答复提醒还没设的必需密钥，可选的只说要用时怎么设；`configure` 带了 `note` 时答复用它代替这些提醒（凭据能从几处来的目标说用哪一处）。要密钥的目标从不在开关里要它。打开的 `Target` 有标识 `key` 和给人看的 `label`，`publish(站点名, 内容目录, meta) → { url }`、`remove(站点名)`；可选的 `siteName` 换掉缺省的站点名规则，`identify` 换掉存储给的指纹作内容的编号，`serving` 报告它真在服务什么，每个站点可以另带一份它自己类型的 `detail`，`view` 往页面和面板里加东西：列、字段、部署库的节前后的块、面板里的块，和目标在 `views` 里声明的自己的页（导航里各一项）。可选的 `close` 在打开它的钩子、命令或视图结束时调一次（失败了也调，它抛的错不算），登录服务的目标在这里退出登录。视图的函数拿到的每个 look 带着 `serving` 对它的站点说的 `detail`，归档了的、待下线的也一样；`defineTarget` 按 `open` 的返回类型 `Target<细节>` 给这些函数定类型。一页先为全部东西问一次 `serving`（问时说明这次要画，`{ detail: true }`），再调视图的函数；钩子和命令问时 `detail` 为假，目标据此只在要画时取贵的数据。目标有 `serving` 时页面带 `refresh`，缺省 30 秒，目标的 `view.refresh` 可以改。部署库导出 `STATUS` 和 `switchAction`，目标自己画的块用它们说和表格一样的状态、给一样的开关。会报告的目标按它报告的对账，对账前先把记录对齐它，所以 `deploy sync` 修得好断在一半的发布和在目标那边被删掉的站点；它读不到时状态是「不知道」，什么都不做。不会报告的按插件自己的记录对账。自带的两种都不报告。发布前向存储要这样东西的清单（`content` 带 `manifest`，存储按内容规则算：不带标记、不含噪音，也不含目录里的 `.gitignore` 排除的），不走这个目录；逐个文件用 `read` 读进缓存目录下 `stage/` 里的一个临时目录，拿 sha256 和清单里它的指纹比，再核对编号，交给目标；对不上就是这中间又变了，这次不发。超过 5000 个文件的目录存储答 `too_many`：不发，也不撤下线上的，状态是待发布，答复说它至少有多少个文件。部署库里的 `node:fs` 只碰缓存里的这个临时目录。`dir` 目标写 `<目录>/<站点名>/…` 和 `index.json`，先写 `.tmp-` 开头的名字再换上，目录不能在库里或包含库；`command` 目标把主人的命令按 shell 的引号规则切成参数、不经 shell 运行，工作目录是 `{dir}`（内容的复制件；下线时是一个空目录），不在库里，超时缺省 120 秒。两种目标都不读库。

存放，都在 `.pneuma-base/deploy/` 下，本体：`config.json` 是目标，带它的 `kind`，经 sdk 的配置文件助手（`configFile`）经存储整份写下，以上次读到的令牌作预期，中间有别的写入就重读再写，后写的算数；`facts/` 是它记录处的事实，经 sdk 的记录库（`recordStore`）写，每次写入一个名字唯一、写完不动的文件：声明、开关、挪、去掉、发布、下线。「目标上有什么」（目标不会报告时）来自对当前目标（按目标的标识区分）的发布与下线记录；换了目标，开着的东西都成待发布，旧目标上的不撤。缓存目录里只有发布时的临时目录。改用部署库之前写下的记录和配置，格式没变，照样读。

实现里和本程细化设计不同的几处：

- 跟着挪和归档用的是 `onPut`、`onArchive`，不是 `observe`：这两个槽收到的是内核解析过的路径（`observe` 里挪的来源只有调用方写的原样），答复能告诉 agent 重新发布了什么。清归档区用 `onPurged`，不看 `observe`。
- 状态比设计多两种：待下线（不该在线、目标上还有，上次下线失败）和不在（开着、路径上没有东西）。会报告的目标读不到时还有「不知道」。
- 目标的配置是 `config.json`，会被 `deploy target set` 换掉；它是配置，不是记录。

## 14. 查找插件

`packages/plugin-search`。装上它，`find` 也匹配文本文件的正文，按相关度排；主人配了嵌入器时也按意思找。它不听任何 `say` 的种类。它还按插件契约第 1 版写，经第 1 版的工具读写库（第 5 节「第 1 版」）。

| 槽 | 它做什么 |
| --- | --- |
| `onFind` | 先把索引补到最新，再按词（FTS5 的 bm25）和按意思（余弦，最多 5 样，不到最近那样一半近的不要）各排一次，用倒数排名融合（k = 60）成一个次序。按词的命中细节是「正文：」加一段上下文，按意思的是「按意思：」加那一块的第一行。目录条目里的文件命中时，路径是那个目录，细节以里面的文件名开头。归档的东西只在 `includeArchived` 时给；带过滤的请求不答，过滤是别的插件的用语。`find` 最多 20 条，多出的用一条没有路径的命中说还有几样；`start` 照内核的规矩最多 5 条 |
| `onView` | `search.status`：文件数、块数、待更新数、建于何时、缓存位置；嵌入器和有向量的块数；按钮「重建索引」「设嵌入器」「清除嵌入器」 |
| `onItemView` | 这样东西的正文索引了没有、几块、几块有向量 |

主人面的命令都不是破坏性的：`search embedder set --kind hash`，或 `--kind http --url <地址> --model <模型名>`，设好后试嵌入一次并说出结果，`http` 而密钥没设时说怎么设；`search embedder clear`；这两条选的是主人的嵌入器，只给主人。`search rebuild`，删掉索引从文件重建，向量没建完时以 `embedder-failed` 拒绝，并说明全文部分已重建；`search status`。后两条只读（只动缓存），agent 也能跑。

| 存放 | 性质 | 内容 |
| --- | --- | --- |
| `.pneuma-base/search/embedder/` | 本体 | 主人选的嵌入器。每次改写一个名字唯一、写完不动的 JSON，名字最大的一份算数。不写密钥 |
| `$PNEUMA_BASE_HOME/cache/<库的 id>/search/index.sqlite` | 缓存 | 索引。删了下次 `find` 重建，答复不变 |

索引的四张表：`docs` 是每个文件（是不是文本都记）的库内路径、目录里的内部路径、大小和修改时刻；`chunks` 是文本按段落切成的约 800 字的块；`fts` 是每块的词；`vectors` 按嵌入器和块内容的 sha256 存，挪动或复制的块不再嵌入，换了嵌入器旧向量就删掉。

- 新鲜度是一个纯函数 `freshness`：比对盘上和索引里每个文件的路径、内部路径、大小和修改时刻，只重读变了的，忘掉不在的。挪动和归档就是路径变了，不靠事件。
- 文本是合法的 UTF-8、不含 NUL 的文件，只读前 1 MB，读不全的命中写明「只索引了前 1 MB」。网页（`.html`、`.htm`）只取读者看得到的字。
- 入索引和查询都用内核的 `searchTerms(…, 'words')`。正文先按句切开再交给它，一个词出现在几句里就算几次。
- `http` 嵌入器的密钥是这个插件在这台机器上的密钥 `key`（`secret set search key`），设了就作 Bearer 令牌发，不设就不发。改用密钥之前写下的记录里的 `keyEnv` 照样读得懂，只用来在 `search status`、页面和按意思找失败的问题里告诉主人：密钥现在要用 `secret set search key` 设；环境变量不再读。
- 嵌入器的接口是 `embed(文本[]) → 单位向量[]`。`hash` 是词和字对的特征哈希，256 维，不带符号位：维数这么少，符号相反的碰撞会抵消共有的特征。`http` 是 OpenAI 兼容的 `/v1/embeddings`，超时 30 秒，地址结尾的 `/v1` 可写可不写。嵌入失败不让 `find` 失败：按词的命中照给，失败进 `problems`。
- 几个 `find` 同时补索引：读文件在事务外，写是按文件的整份替换，跑两次结果一样；排名和取块在同一个读事务里。缓存里的文件不是 sqlite 或是别的版本的，就重建；被锁时等，不重建。

内核为它改了找（§4）的两处：

- `onFind` 可以答 `{ hits, problems }`，给出命中的同时说明没做成的部分（K8）。
- 几个答复者的结果怎样合成一张表，见 §4「找」：同一路径排在任何答复者给它的最好名次上。
