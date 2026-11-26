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
| 归档 | 把一样东西挪进库里的归档区。不删；默认的找和查不带它，带上要开开关。agent 做得快、废弃得也快，归档是 agent 面上不破坏的「不要了」 |
| 槽 | 一个动词背后插件可以接上的位置 |
| 会话 | agent 产品的一次会话，或人对工具的一次使用 |
| 事件 | 两个面的一次操作及其结果，内核在操作之后发给所有插件 |
| 视图 | 管理界面的一页：一组带类型的块，由内核或插件给出。它是一条只读的命令，`show` 把它印成字。视图不是操作，不改东西，不发事件 |
| 块 | 视图的组成单位：分节、记录表、字段组、列表、时间线、文字、预览、动作、空状态、库外的页面、插件自己画的页。块上挂的动作是 agent 面的一个动词或一条主人面命令 |
| 认知段 | 一个插件拼进说明的那一段话 |
| 本体、缓存 | 插件对自己名下每个目录的声明。本体跟着文件夹走；缓存不同步，删了能重建 |
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
| `packages/kernel` | 打开库、解析配置、识别行动者和会话、七个动词的管线、请求、授权的门、事件、认知的拼装、技能的生成、接上和断开 agent 产品（产品表）、装载和安装库外的插件、本机的密钥。依赖 sdk，并把它原样再导出 | 依赖 sdk 以外的任何包；认识任何插件的事实或目录 |
| `packages/plugin-ledger` | 记账与对账：事实、场景、条目、对账、来历、过期、变化，留存（第 10 节） | 读写别的插件的目录；绕过内核的公开接口；导入别的插件 |
| `packages/plugin-version` | 版本：声明了有版本的东西，每一版都留着（第 11 节） | 同上 |
| `packages/plugin-sync` | 同步：库和一个目标双向同步，不合并、不丢内容（第 12 节） | 同上 |
| `packages/plugin-deploy` | 部署：sdk 的部署库加「本地目录」「命令」两种目标（第 13 节）。只依赖 sdk | 同上 |
| `packages/plugin-search` | 查找：正文和按意思，索引是缓存（第 14 节） | 同上 |
| `packages/viewer` | 管理界面。`src/server/` 是只听本机的 HTTP 服务，用内核的三个面；`web/` 是网页，只渲染块。自带的插件表由调用方传进 `startServer`，服务每次请求再并上本机的插件 | 导入任何插件包或命令行；网页导入内核的代码（只取类型） |
| `packages/cli` | 命令 `pneuma-base`：把命令行翻译成对内核的调用，把结果打印出来；动词的参数表（`verbs.ts`）；内置插件表（记账、版本、同步、部署、查找，`init` 缺省只装记账）；`view` 把内置插件表交给界面的服务；`show` 把一个视图印成字，每个按钮写成做同一件事的命令（`page.ts`）；`mcp` 把一个授权的库作为 MCP 服务给出（`src/mcp/`）；`plugin new` 从 `templates/` 生成插件项目 | 含领域逻辑 |

插件只经契约的类型和上下文对象接触内核：自带的插件从 `packages/kernel` 导入（它再导出 sdk），部署插件和库外的插件只依赖 `packages/sdk`，运行时不导入内核，要用内核的工具就用上下文的 `tools`。插件之间不直接调用，也不互相导入。内核不导入界面，界面不导入任何插件，sdk 不导入内核、命令行、界面和任何插件；lint 的导入规则守这几条，`packages/kernel/test/dependency-direction.test.ts` 在故意违反的例子上看它们变红。

运行时是 Node，语言是 TypeScript，包管理用 pnpm 的工作区，测试用 vitest。

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

type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint; copied: boolean
      notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle' | 'agent-session'; notes: Note[] }
```

**看到的和说的。** 应用会把主人用 Finder 复制进库的文件自动登记成「主人带进来的」。这是看到的，不是谁说的，可能看错：比如 agent 违反说明直接写了文件。所以登记可以带 `observed`（命令行 `put <库内路径> --brought --by owner --observed`）：只有主人能这样放，行动者是 agent 时以 `agent-session` 拒绝，agent 只说来历，不替主人「看到」。`onPut` 收到的 `AcceptedPut` 带着它。记成什么、谁能更正，归记账插件（第 10 节）。

内核自己能看到的是「东西」：一个普通文件，或一个带标记的目录（见下一小节「一个目录算一样东西」）。全化表里「同类」指和放进来的东西同一类：文件对文件，带标记的目录对带标记的目录；「另一类」是另一类的东西，或既不是文件也不是目录的东西。

| 请求 ＼ 目标 | 在库外或授权区域外 | 在带标记的目录里面 | 不存在 | 同类，内容相同 | 同类，内容不同 | 没标记的目录 | 另一类 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 登记 | 拒绝 | 拒绝 | 拒绝：没有这个文件 | 接受（登记的是目标本身的当前内容） | 不适用 | 写标记，它从此是一样东西，接受 | 拒绝：没有这个文件 |
| 放入文件或标准输入 | 拒绝 | 拒绝 | 复制，接受 | 不复制，接受 | 有插件留住旧内容：换上新的。没有：拒绝，目标不动 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 放入库外的目录 | 拒绝 | 拒绝 | 复制整棵树，写标记，接受 | 不复制，接受 | 有插件留住旧内容：整棵换掉。没有：拒绝，目标不动 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 挪 | 拒绝 | 拒绝 | 挪过去，整个目录一起，接受 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

接受之后，内核把请求交给每个插件的 `onPut`，把它们的答复收进 `notes`。`onPut` 收到的 `note` 一定有，由内核规整过：去掉首尾空白，空白或没写就是 `null`，插件不再自己判。

**正在放入的标记。** 一次放先把文件放到目标上，插件后才记下它；这中间看库的人（别的 agent 的 `check`、应用的监看）会看到一个没人登记的文件。所以内核在放动手之前，为它要放入、登记或挪的每个内容路径（挪是来去两个）在 `.pneuma-base/tmp/putting/` 下写一个标记，等放和所有插件的 `revise`、`onPut` 都做完、被拒绝或出错之后删掉（`putting.ts`）。标记写着库内路径，在内核的临时区里，不同步。放在进行时每 2 秒刷新一次标记的修改时间；超过 10 秒没刷新的标记算死了：进程被杀时标记删不掉。10 秒只要盖过一次刷新加事件循环的一次停顿，放多久都不会过期；它也是被杀的那次放留下的文件最多被藏多久，比应用的监看登记一个文件要等的（库里安静 3 秒）长。应用的监看只认对账的答复，不再自己隔一段时间看两次（`app/README.md`）。下一次放写标记时顺手删掉死了的。插件用 `tools.putting()` 问此刻正在放的路径。`observe` 不在标记里面：它听的是做完了的事。

「有插件留住旧内容」的分工：内核问配置里每一个提供了 `revise` 的插件，按配置的次序，一个答了之后照样问下一个。插件把当前内容留到自己名下（`held`）或拒绝（`declined`）。至少一个答 `held`，内核就把新内容先写临时名再改名放到目标上，每个答 `held` 的插件附的那句话都收进 `notes`。一个都没答 `held`，内核拒绝这次放入，目标不动，每个答 `declined` 的插件说的理由收进拒绝的 `notes`：只装了版本插件时，agent 从这里读到要先声明有版本。出错的插件列进 `problems`，算没留住。这样不管插件写得对不对，目标上都不会出现半截内容。

实现里的细化（形状在 `packages/sdk/src/types.ts`）：

- 请求里的路径是调用方写的原样（相对库根，或库内的绝对路径），由内核在入口解析一次。「在库外」那一列就是解析不出库内路径的情形。`.pneuma-base/`、`PNEUMA-BASE.md` 和 `_archive/` 不算内容，放和挪到那里都按「在库外」拒绝；`_archive/` 只经归档和取回进出。
- 放入的来源是 `{ kind: 'file'; path } | { kind: 'directory'; path } | { kind: 'stdin'; content }`。来源是目录时，它要在库外，也不能包含这个库，否则以 `outside-library` 拒绝：复制它会把库复制进库里。
- 每个结果都带 `problems`，拒绝的结果也带，并带 `subject`：拒绝针对的那个输入。`inside-bundle` 的 `subject` 是那个带标记的目录。
- 来历里留空的字段等于没给，和主人面命令的表单一样：带进来的 `source`、`by` 是空白就当 `null`，做出来的 `from`、`outside` 里空白的行去掉。界面的表单留空时送来的是空字符串。
- 做出来的来历里，`from` 的每个路径都要是库里在的东西（主区，或它在归档区的那份）。有一个不在，就以「没有这个文件」拒绝，`subject` 是那个路径，目标不动。写的是带标记的目录里面的文件，依据记为那个目录。

### 一个目录算一样东西

- 标记：目录里有一个 `.pneuma-item` 文件（JSON，`{"format":1}`）的，是一样东西，代码里叫 bundle。没有标记的目录只是文件夹。
- 内核列库里的东西时，遇到带标记的目录不往里走，把它当一项。库内路径是目录的路径，不带斜杠。
- 指纹：目录里每个算进来的文件写成 `<相对路径>\0<内容的 sha256>\n`，按相对路径的 UTF-8 字节排好，连起来取 sha256。不算标记文件，不算任何一层的 `.git`、`node_modules`、`.DS_Store`，放进来时也不复制这三样。只认普通文件和目录，不跟符号链接，空目录不算。看到的 `size` 和 `files` 也只算这些文件。
- 算法归内核。内核导出 `fingerprintOf(路径)`（文件和带标记的目录都给指纹）、`bundleManifest(目录)`（每个文件的相对路径和 sha256）、`fingerprintOfManifest(清单)`（不读文件，只从清单算指纹）、`bundleFiles`、`thingAt(路径)`（`kind` 是 `'file'` 或 `'bundle'`）、`enclosingBundle(库根, 库内路径)`（这个路径在哪个带标记的目录里面）、`copyBundle` 和 `BUNDLE_MARKER`。插件认目录条目靠 `thingAt` 的 `kind`，指纹一律用 `fingerprintOf`。
- 放进来时先把整棵树复制到 `.pneuma-base/tmp/` 下的临时名，再改名到目标，中途出错或被杀，目标上不留半棵树，留下的临时名不算库的内容，重放一次得到同样的结果。换掉一个目录条目时，先把旧的改名到临时名，再把新的改名过去，最后删掉旧的；旧的内容这时已经由插件留住。
- 一个带标记的目录只能整体地变：它里面的路径不是 agent 面写的目标，放、挪、登记、归档到它里面都以 `inside-bundle` 拒绝。要改它，把整个目录重新放进来。
- 找：一个带标记的目录是一个命中，`detail` 是「目录」。看：`FileFacts` 多 `kind: 'file' | 'bundle'` 和 `files`（文件数）。
- 挪、归档、取回：整个目录一起动。取回时原路径上有任何东西，包括没标记的目录，都算原路径被占。
- 符号链接不是东西：列东西、算指纹、同步都不进到链接里，所以一个路径本身是链接、或路径上有一段是链接时，内核当那里有「另一类」的东西（`kindAt`）。登记、挪、归档、看都不认它，往它上面或它里面放以 `would-overwrite` 拒绝，不会经过链接写到库外。解析调用方写的绝对路径时，只解析通到库根的那一段链接，库里的链接不跟（`parseLibraryPath`）。插件的工具用同样的判断，所以 `thing` 和 `things` 说的一样。

### 找、看、说、查、归档

```ts
type FindRequest = { text: string | null; match: 'terms' | 'words'; filters: Record<string, string>; includeArchived: boolean; skipOwnSession: boolean }   // 开关默认关
type Hit = { path: LibraryPath | null; title: string; by: PluginName | 'kernel'; group: string | null; detail: string | null }
type FindResult = { hits: Hit[]; problems: PluginProblem[] }

type InspectRequest = { target: string; content?: { file: string | null } }   // 路径，或某个插件认得的标识；content：也要内容
type InspectResult = { file: FileFacts | null; sections: Section[]; problems: PluginProblem[]; content?: Content }

type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean }
type CheckResult = { sections: Section[]; problems: PluginProblem[] }

type ArchiveRequest = { kind: 'archive' | 'unarchive'; path: string }
type ArchiveResult =   // moved：false 时请求本来就已满足
  | { outcome: 'accepted'; from: LibraryPath; to: LibraryPath; moved: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken' | 'inside-bundle'; subject: string; problems: PluginProblem[] }

type Note    = { plugin: PluginName; text: string; data?: unknown }
type Section = { plugin: PluginName; title: string; body: string; data?: unknown }
type PluginProblem = { plugin: PluginName; message: string }
```

找的两种匹配：`terms` 把文字按空白和常见标点切开，名字里含任一段就算；`words` 用 `Intl.Segmenter` 取一句话里两个字以上的词和拉丁词（它会把「下单」这类两个字的词切成单字，所以相邻的两个单个汉字也连成一个词），按命中的不同词数排，至少命中一个，每个答复者最多给 5 条。`start` 用 `words`，`find` 用 `terms`。切词和排序是内核导出的 `searchTerms` 与 `rankHits`，插件用同一套。`filters` 是插件的用语，内核不懂，所以带了过滤时内核不按名字列文件。

`skipOwnSession` 让答复者不带调用者自己这次会话做的东西。`start` 打开它，因为它找的是库里本来就有的；`find` 不打开，什么都给。内核按名字列文件时分不出是哪次会话放的，不管这个开关。

几个答复者的结果合成一张表：同一个路径的结果排在一起，位置是任何一个答复者给它的最好名次（在自己那张表里的序号）；名次相同时内核在先，插件按配置次序。路径相同的，内核的那条不单列，它的标记（目录、已归档）放在第一个插件那条的细节前面；几个插件命中同一路径各给一条，因为各说各插件知道的。所以记账插件排在查找插件前面时，查找插件按相关度排在前面的文件也排得靠前，不被压在记账插件的位置上。

内核和各插件的 `onFind` 都答完后，内核按配置次序问每个有 `onFound` 的插件：找到的路径里它自己没给命中的那些，它知道什么。没有路径的命中不算；一个路径都不剩就不问。它答的每条命中并进那个路径的那一项，不改名次。一项里的命中按内核在先、插件按配置次序排，不论插件是找到了这个路径还是补了一条，所以只被查找插件找到的条目也带着记账插件给的场景和来历，和两个插件都匹配时一个样子。补的一条就是一条 `Hit`，没有标记说它是补的（K3）。`onFound` 抛错的插件列进 `problems`，命中照给；答了没问它的路径的那条（含没有路径的）不要，也列进 `problems`（K8）。

`group` 是答复者给一条结果定的标题：`group` 相同的结果在文字答复里合在这个标题下，出现在其中排得最前的那条的位置，每条一行；没有路径的那条说的是这个标题本身，排在标题下第一行。内核按名字列出的结果 `group` 为 `null`。

`problems` 是失败语义的落点：某个插件出错时，动词照样给出答复，同时如实说明哪个插件没做成。「已放入，但没有记下」是和「已放入并记下」不同的结果，命令行以非零退出码区分。

归档是内核自己做的，不靠插件，所以空目录里也成立。归档区是库根下的 `_archive/`，里面保持原来的相对路径。全化表：

| 请求 ＼ 目标 | 不存在 | 在主区 | 已在归档区 |
| --- | --- | --- | --- |
| 归档 | 拒绝：没有这个文件 | 挪进归档区，接受。归档区里同一路径已有别的东西时，新来的名字后加指纹的前八位 | 接受，什么都不动 |
| 取回 | 拒绝 | 接受，什么都不动 | 原路径空着：挪回去，接受。原路径被占：拒绝 |

这里的「东西」是文件或带标记的目录，目录整个一起动。实现按四种状态判：两处都没有；只在主区；只在归档区（原路径空着）；两处都有（原路径被占）。两处都有时，归档按「在主区」办，取回按「原路径被占」拒绝。取回时原路径上的任何东西都算占着。路径在一个带标记的目录里面时，归档和取回都以 `inside-bundle` 拒绝。路径写成 `a.md` 或 `_archive/a.md` 都指同一样东西。接受的结果带 `moved`，什么都没动时为 `false`。

找和查默认跳过归档区，`includeArchived` 打开才带上。看一样已归档的东西照常给出，并标明它已归档。命令行里除了 `find` 和 `check`，库的目录树本身也把归档的东西隔开了，agent 用自己的工具翻目录时同样看不到它们混在里面。

**看内容。** 命令行的 agent 自己读文件；经 MCP 的 agent 读不了，只能找和看。所以看可以带上内容：`inspect <库内路径> --content`。文件是 UTF-8 文字、不超过 256 KB 时给全文（`text`），一篇长文档、网站的一页放得下，一份导出的数据放不下；别的给大小和文件名说的媒体类型（`other`，`why` 是 `not-utf8` 或 `too-large`，超过上限的不读）；带标记的目录给它算进指纹的文件清单（`files`），`--content <内部路径>` 读其中一个，只认清单上的，爬不出去；写目录里的文件的库内路径也一样。内容在内核里读（`content.ts`），插件的 `onInspect` 照旧只给它们知道的。授权限在一个区域时，区域外的东西照样给事实（今天的看、找、查都不按区域限读，区域只限写），只是不给内容（`unavailable`，`outside-grant`）；归档的东西按它原来的路径算。只读的授权读得了区域里的内容。

命令行另有一个 `start "<一句话>"`，是「说：在做什么」「查」「找」三个动词的组合，不是第八个动词。

命令行另有一个 `show [<视图编号> [--<参数> <值>…]]`：管理界面的一页，只读，也不是动词（第 6 节「只读的一面：视图」）。不写编号列出这个库的页。

命令行是全部本事的准绳，管理界面和 MCP 服务是它的面，答复一一对应：界面上的每个按钮是一个动词或一条主人命令（`Call`），表单出自命令的参数表；界面上的每一页是一条只读的命令，`show` 把它印成字；MCP 的每个工具是一个动词或一条 agent 能用的命令，输入出自同一份参数表，答的是命令行印的字和 `--json` 的结果（第 6 节「MCP 服务」）。除了管理的那部分归主人，每样本事 agent 和人一样。两个方向都有测试守着（`packages/cli/test/pages.test.ts`、`mcp.test.ts`）：每一页印得出来，字里有每一格和每个按钮的命令，每个按钮调得到一个动词或一条在的命令；每个动词和命令在界面上有按钮，或是一页读的东西，没有的列在测试里，写明为什么；每个动词和 agent 能用的命令是一个工具，管理的命令都不是。

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

主人面三条命令，都只给主人，都不能被请：`request list [--all]` 印的和 `show home` 里请求的那几行一样，`--all` 再列了结的；`request approve <号>` 经 `ownerFace.dispatch` 跑那条命令，主人调用带着 `request`（号和谁请的），所以那条命令自己的事件也带着它（第 5 节的 `Event`）；跑出什么就是结果，拒绝也算，参数后来不合了记成 `no-longer-fits`；那条命令后来成了破坏性的或不能被请的，批准不跑它，以 `no-longer-askable` 拒绝并记成结果，因为批准不是当面确认；`request decline <号> [<理由>]`。了结了的请求不能再决定（`not-pending`）。

在 agent 的会话里被拒的只给主人的命令，能请的，拒绝的话最后一行就是那条 `ask`：`pneuma-base @<授权名> ask "<为什么>" <命令和参数>`。首页的「等你决定」先列请求：为什么是那一句，由提的 agent 署名，下面一行是照原样会跑的命令，按钮是「批准」（推荐）和「拒绝」（可填理由）；决定了的折成一行结果。`check` 多一节「你提的请求」：上次看过之后主人决定了的，各带结果，和还在等的个数；看过的下次不再说。`inspect <号>` 给一个请求的全部。

存放在库的记录区 `.pneuma-base/requests/`，一个请求一个文件 `<号>.jsonl`，号是 `r-` 加 8 位十六进制。文件以独占创建开头，之后只追加行：`asked`（谁、哪次会话、为什么、命令和参数）、`withdrawn`、`decided`（批准带结果，拒绝带理由）、`seen`（提的 agent 看过结果）。读的时候按行归并：决定压过撤回，同步两边各写了一行时主人的决定算数；`seen` 只在了结之后算。同步插件留下的冲突副本（`<号>.conflict-<机器>-<时间>.jsonl`）按号并进同一个请求。去重和上限要看同一个 agent 的全部请求，所以提的时候内核在 `tmp/asking/` 下按 agent 加一把目录锁（10 秒算过期），两个进程同时提也不丢、不重。请求跟着文件夹走，不放在本机的目录里。

### 没有任何插件时的答复

| 动词 | 答复 |
| --- | --- |
| 放 | 按上面的全化表。接受时 `notes` 为空。放入遇到内容不同的同名文件：拒绝 |
| 找 | 按名字列出库里的文件和带标记的目录 |
| 看 | 这样东西本身的情况（文件或带标记的目录），`sections` 为空；要内容时照样给 |
| 说 | `not-heard`，`no-plugin-for-kind`，附一句「这个库没配能记下这句话的插件」 |
| 查 | `sections` 为空 |
| 归档 | 按上面的全化表 |
| 请 | 按上面「请主人做」，和有插件时一样 |

## 5. 扩展点

插件必须做什么、可以依赖什么，写在 `PLUGINS.md`（插件规范）：每个钩子什么时候被调、拿到什么、能答什么，退出码，主人命令的参数表和门，块的字段和插件自己画的页，能写哪里，上下文里的工具，开发包里的库，符合性检查，装和卸。它和库的格式是 1.0 要冻结的两样，`packages/cli/test/plugins-doc.test.ts` 跑它的每条命令、编译它的每段代码，并核对它点名的检查都在。这一节只写内核为什么这样、怎么实现。

```ts
interface Plugin {
  readonly contract: number                     // 按哪一版插件契约写的：sdk 的 CONTRACT（现在是 1）
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
- 钩子收到的上下文另带 `dir`（打开库时内核为每个能运行的已装插件建好它，同步过来、这台机器后来才有这个插件的库也一样）、`cacheDir`、`tools`、`secrets`，由 `pluginContext` 在每次调钩子时造。
- 跟着挪和归档的插件用 `onPut`、`onArchive`：只有这两个钩子收到内核解析过的路径，`observe` 里的请求是调用方写的原样。
- 主人面命令的 `destructive`、`ownerOnly` 由内核在同一处拦（第 6 节），插件不看上下文；`readOnly`、`setup` 只是事件上的记号，记账插件据此决定它算不算给 agent 的消息。主人面的事件带这三个标志，插件不用自己认哪些命令会丢数据、哪些什么都不改。
- `keeps` 定说明里同名时的那句话（第 7 节）：记账插件是 `every`，版本插件是 `some`。
- `onPurged` 让插件不用比命令名、不用读 `archive purge` 的 `data.paths`；`onAdd`、`onRemove` 让插件听得到自己被装上和卸下。`onRemove` 可以拒绝，但主人总能 `--anyway`：插件提醒，主人决定。
- 问主人（`onAsks`）：插件说出它此刻在等主人定的事，每件一句话、关于哪样东西、几个回答（动作）、推荐哪一个。它只读，不写东西：首页每次显示、`check` 每次答都问一遍，插件按自己记的状态答，主人定了，下次就不再问。内核按配置次序问（`asks.ts`），像核对块一样核对每一件（不是一件的、回答调不到的、推荐的不在回答里的，不要，列进问题），盖上插件名（`by`）。`check` 的答复带着它们（`CheckResult.asks`），命令行印在「要主人来做的」下面，每个回答印成主人在自己终端里跑的命令；首页把它们放在最上面。
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

`PluginContext.tools` 是插件正当需要的内核工具，绑在这次操作的库上，没有一个要传库根。类型在 sdk，代码是正在跑的内核的，所以目录条目算哪些文件、指纹怎么算、找怎么切词排序，插件和内核永远一致，库外的插件不再抄一份。这套是从五个自带插件运行时从内核导入的东西归出来的最小一组：

| 组 | 工具 | 覆盖原来的导入 |
| --- | --- | --- |
| 路径 | `resolve(输入)` → `{ path, region, bundle } \| null`；`regionOf`、`archivedPath`、`originalPath`、`abs` | `parseLibraryPath`、`regionOf`、`enclosingBundle`、`archivedPath`、`originalPath`、`abs` |
| 东西 | `thing(路径)`（文件或目录条目，带大小和文件数）、`things()`、`files(目录条目)`、`copyOut(路径, 库外或自己名下的目录)` → 复制件的指纹 | `thingAt`、`libraryFiles`、`bundleFiles`、`copyBundle` |
| 指纹 | `fingerprint(路径)`、`manifest(目录条目)`、`fingerprintOfManifest`、`fingerprintOfFile(绝对路径)` | `fingerprintOf`、`bundleManifest`、`fingerprintOfManifest`、`fingerprintOfFile` |
| 找 | `searchTerms`、`rankHits`、`sentenceHits` | 同名的三样 |
| 放 | `put(请求)`：经 agent 面放入，行动者和会话是这次操作的，所以每个插件都听到、它发自己的事件；`putting()`：此刻正在放的库内路径（第 4 节「正在放入的标记」） | `agentFace.put` |

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

- 两个包文件，`pnpm pack:dist` 打进 `dist-packages/`（不进 git，不发布）：`pneuma-base-<版本>.tgz` 是命令行，内核、五个自带插件、界面的服务和网页都作为捆绑的依赖在里面，另带插件规范 `PLUGINS.md`，`npm install` 它不用别的包，也不用联网；`pneuma-base-sdk-<版本>.tgz` 是 `@pneuma-base/sdk`，不依赖这个仓库的别的包，声明文件自成一体。两个的版本都是 sdk 的 `PNEUMA_BASE_VERSION`，自带的五个插件的 `version` 也是它，每个工作区包的 `package.json` 和它不一样时打包拒绝。实现在 `scripts/pack-dist.mjs`。
- 测试工具 `@pneuma-base/sdk/testkit` 跑真的命令行，不另造一个假的内核：插件在测试里和在主人的机器上走同一条路。调用的环境从空的建起，所以没有任何 agent 产品的会话变量。`serve(handler)` 起一个库外 HTTP 服务的替身、交回地址，沙箱收尾时一起停，所以目标是网络服务的插件不连真的服务也能跑符合性检查和自己的测试；`viewer().item(路径, { plugin })` 只要一个插件的那一节。沙箱建在 `$PNEUMA_BASE_TEST_TMP` 下，没设时在系统的临时目录下。
- `conformance` 把规范里行为上的规矩跑成检查（九项，见 `PLUGINS.md` 第 7 节），每项的规则文字在 `RULES` 里，报告原样引用，规范也原样引用（`plugins-doc.test.ts` 核对）。破坏性的主人命令经界面的服务跑，带着界面那样的当面确认，只许它改自己的目录。`custom` 页不在浏览器里跑：只读页和它直接载入的脚本，看它载入 `/plugin-kit/frame.js`、调用 `pneuma.onData`。仓库自己的测试拿它查自带的五个插件，也拿故意违规的插件看每条检查都会变红（`packages/cli/test/conformance.test.ts`）。
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

主人面的命令都是数据：名字、一句说明、参数表、是否破坏性、是否只给主人、是否只读（可选）、是否配置（可选）、能不能被请（`askable: false`，可选）、`run`。内核自己的二十条在 `owner-commands.ts`、`agent-commands.ts`、`launcher.ts` 和 `request-commands.ts`，都带参数表，和插件的 `OwnerCommand` 同形，只是 `run` 收到整个主人调用（上下文、插件表、环境、是否带授权、怎么问当面确认、怎么读主人另给的值；本机的家目录就是上下文的 `home`），并可交回重开的库。其中十条要一个库（`grant issue`、`grant revoke`、`plugin add`、`plugin remove`、`skill install`、`archive purge`、`agent connect`、`request list`、`request approve`、`request decline`）；十条只动这台机器，有没有库都能跑（`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`、`agent detect`、`agent list`、`agent disconnect`、`launcher install`）：没有库时上下文的 `library` 是 null，没有插件可告诉，不发事件；带着库（比如从界面）时照常在单一出口发事件。

- `ownerFace.commands(插件表)` 列出可用的命令：先内核的，后各插件的，按配置次序；名字已被占的不再列，插件盖不住内核的命令。命令行的 `--help` 用它列出主人命令：带 `--library` 或 `@<授权名>` 时是那个库的，否则是内核的。
- 门：破坏性的和只给主人的，在 agent 的会话里都以 `agent-session` 拒绝；然后按参数表核对；破坏性的再要当面确认。终端里只有输入 `yes` 才算确认；别的回答、输入结束（Ctrl+D）、不在终端里，都以 `not-confirmed` 拒绝。内核自己的命令里，`archive purge` 是破坏性的，`skill install` 和 `plugin list` 谁都能跑，其余只给主人。能被请的命令在 agent 的会话里被拒时，话的最后一行是请主人做它的那条 `ask`（`ownerOnlyRefusal`）；破坏性的和 `askable: false` 的没有这一行。
- `ownerFace.dispatch(主人调用, 命令名, 参数)` 是唯一的入口，命令行和界面的服务都走它。命令经同一道门（K7），在单一出口发事件（K5）。
- 没有这条命令：在任何操作开始前拒绝（`unknown-command`），不发事件。要库的命令没给库，同样在开始前拒绝（`no-library`）。
- 参数不对：以 `usage` 拒绝，说出哪一样不对，带参数表生成的用法；命令行把它当用法错误，退出码 1。表单里留空的可选值等于没给；开关在表单里写成值 `yes` 或 `no`。
- 主人另给的值，比如密钥：命令行从标准输入读，在终端里不回显地问；界面的服务取 `Call` 的 `stdin`。它不在参数里，所以不进事件。

命令行只做三件事：认出命令名（第一个开关之前的那几个词，取字数最多的那条，内核命令的字数多过同名的动词时取内核命令，所以 `archive purge` 不是归档一个叫 purge 的文件），按那条命令的参数表读其余的（第 5 节「命令的参数表」），以及定库。`skill install` 的库由它的授权名经本机的授权副本定出；不用指明库的那几条没给库就不带库跑；其余用 `@<授权名>` 或 `--library`。

### 只读的一面：视图

管理界面是内核的一个客户端：看用视图，改用 agent 面的动词和主人面的命令。视图不是操作，不改东西，不发事件。K5 说的是两个面的操作。

视图是只读的命令，答复是带类型的块。命令行的 `show <视图编号> [--<参数> <值>…]` 和界面走同一个 `viewerFace.show`，`--json` 给的就是界面拿到的答复；不写编号时列出 `viewerFace.views`，每页带是谁给的（`by`）。文字是块的如实转写：分节是标题带说明和数目；表格对齐成列、带表头，标签、外部地址都在，不截短，行的链接写成打开它的 `show` 命令；字段是「名字：值」；时间线和带 `at` 的格按命令行的习惯写 UTC 的时刻；文字的语气是警告或出错时前面写上；预览写路径，外部页面写地址，空状态写标题和提示，`custom` 写它的 `text`。块上的每个动作印成做同一件事的命令（`$ say revised notes/a.md  # 认下这次改动`），agent 的会话会被拒的标「（只给主人）」，要先问的跟着问话，没填的输入照用法写成 `<提示>`。agent 带授权或 `--as` 能看每一页，和 `inspect` 一样什么都不改、不发事件。管理的页声明 `ownerOnly`（内核的 `config` 是），在 agent 的会话里以 `agent-session` 拒绝，话和只给主人的命令被拒时一样（`ownerOnlyRefusal`），判断也在同一处（`agentSign`）。没给的筛选取它的 `default`，由内核填，界面和命令行一样。

界面重取一个视图只在三种时候：库的摘要（`/api/rev`，界面每两秒问一次）变了；做完一个动作；视图的答复带 `refresh: <秒>` 时，每隔这么久一次，少于 5 秒按 5 秒。另外，连不上服务之后又连上时取一次，补上断着时没取到的。没有别的会让视图重算。所以视图可以读库外的东西（比如部署目标上的状态），只要不写；状态来自库外的视图要带 `refresh`，内容随时钟变的视图（比如「最近 30 天」）也可以带。视图在界面的服务所在的机器上运行，用那台机器的时区；格里的 `at` 由网页按浏览器的时区显示。视图写了库里的东西，摘要就变，界面每两秒重取一次，这是插件的错。

```ts
viewerFace.views(library): { views: ViewDecl[]; problems: PluginProblem[] }
viewerFace.show(req: ViewRequest, call: { ctx: Context; table: PluginTable; env: Env; viaGrant: boolean }): Promise<ViewResult>   // 'shown' | 'no-such-view' | 'refused'
```

块、动作、视图的类型在 `types.ts` 的末尾，不含任何插件的类型（K3）。内核自己的视图也用块给出，界面不为它们写专门的页：

| 视图 | 在导航里 | 内容 |
| --- | --- | --- |
| `home` | 是，第一个 | 首页，界面打开时的那一页。库还没用起来时，最上面是「开始」：一个 `steps` 块，三步，按库的状态算出来，不存任何标记（`start.ts`）。「接上你的 agent」：这台机器上找到的和接上的产品各一行，带记号，接上的标「已接上」，没接上的带「接上」，就是 `agent connect` 那条命令，一下就做，不出表单；一个都没找到时一句话说看了哪里。「放进第一样东西」：库里有没有内核文件以外的文件；一个 `drop` 块，放进 `inbox/`。这两步是内核的。第三步「对你的 agent 说一句」由记账插件给（见下面「插件给首页添东西」），做完的条件是有 agent 在库里留下过事实；内核不认识场景。做完的一步折成一行，写着做成了什么；三步都做完，「开始」就没了。然后是「等你决定」：agent 提的、还在等的请求，然后每个插件 `onAsks` 给的事（`asks` 块），插件的由认知段标题署名，没有就是一句灰字；然后按配置次序放每个插件标了 `home` 的视图的块，默认参数。一个都没有时，一句话说明（没装插件，或装着的插件没给首页添内容），下面是库里的文件。`show home` 印的是同一页，步骤写成 `[✓]` 或 `[ ]` 加标题，做完的跟着做成了什么，没做的下面是它的内容和命令 |
| `files` | 是 | 库的一个文件夹，参数 `dir`。先文件夹，后东西；内核的文件和归档区不列。文件夹链到下一层；文件和带标记的目录各是一行，链到 `item` 面板，带标记的目录有自己的图标和文件数，不往里走。「从这台机器放进来」把一个文件以带进来的放入（页给不了标准输入，目录从命令行放） |
| `archive` | 是 | 归档区里的每样东西和它原来的路径，带标记的目录是一行，各带「取回」；整区一个「清空归档区」，先问 |
| `agents` | 是 | 只给主人。接上的 agent 各一行：记号和产品名；灰的一行写接法（技能或 MCP 服务）、区域（整个库或 `区域 x/`）、只读还是读写、授权名和产品名不同时凭哪份授权、接上时写的东西在不在原处（在时写「写在 …」，不在时是一个警示标签，说哪样不在了），然后是各插件对 `inspect @<授权>` 说的，记账插件说它最近一次来是什么时候、几次会话、放进几样；各带「断开」，先问。一个都没接上时是空状态，指向下面的「接上」。这台机器上找到、还没接上的产品各一行，带记号、接法、写到哪和找到它的迹象，各带「接上」，表单问区域和只读；没找到的产品和看了哪里；接上的 agent 能做什么，分三组，用和 MCP 服务同一条规则从命令表生成：自己能做的（动词，和既不破坏也不只给主人的命令，就是 MCP 服务的工具）、要你来做的（只给主人的命令，agent 用 `ask` 请；请不了的标出来）、红线（破坏性的命令）。`show agents` 印的是同一页 |
| `config` | 是 | 只给主人。库的位置；这个 pneuma-base 认识的每个插件和库里装了的每个插件，各带版本和一句说明（没有 `summary` 用认知段的标题，同 `plugin list`），装了的带「卸下」，没装的带「装上」，装到这台机器上来的另带「从这台机器卸掉」，插件不肯卸时提示里带「仍然卸下」；「从目录装一个插件到这台机器」；授权，各带为 Claude 或 Codex 生成技能（目录可以写 `~/…`）、撤回；发授权；Codex 要把库加进可写目录的提示；已装插件声明的密钥，各带设没设、「设」和「删掉」。这些按钮的表单都由内核命令的参数表生成 |
| `item` | 否 | 一样东西，参数 `path`，开在右侧面板，次序固定：先一行说它是什么和一句状态（`文件 · 2.1 KB`，已归档的、是谁的一部分的跟在后面）；每个插件的 `onItemView` 给的一节；「文件」一节是它自己的事实（路径、种类、文件数、大小、改于、指纹）；带标记的目录接着列出里面的文件，各链到自己的 `item`，文件接着是可以折起来的预览。带标记的目录里面的文件说明它是谁的一部分，不给归档。路径上没有东西时说明不在，插件的节照常给。最后是一行动作：归档或取回，没归档的还能挪到别处，然后是各插件节的 `actions`。`_archive/…` 的东西被取回后，面板跟到它原来的路径 |

一样东西的详情是内核的视图，不是某个插件的：内核按配置次序把各插件用 `onItemView` 给的节拼在「它是什么」之后、文件的事实与预览之前，节名由插件给，节上盖着插件名（`plugin`），插件之间互不认识；节带的 `actions` 不留在节里，并进面板底下那一行动作。记账插件的来历、版本插件的版本时间线、部署插件的开关都落在同一个面板里。

`viewerFace.views` 先列插件的视图，按配置次序，后列内核的。

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
- 单元格的 `actor`：`{ kind: 'agent' | 'owner', name, grant? }`，谁做的。界面在文字前画一个记号：agent 是名字的首字，底色由名字定，同一个名字总是同一个颜色；主人是一个灰圆。`text` 是空的时显示名字。
- 块 `feed`：`{ groups: { title, count, link?, rows }[], empty }`，发生过的事，按日或按场景分组；分组的 `link` 打开组名说的东西（比如场景）。一行 `{ key, at, actor, text, meta, whose?, action?, settled?, link }`：何时、谁（`actor` 是记号或一个名字）、一句话、灰的一行（单元格）、谁的动作（agent 自己做的、主人做的、只是看到的，没意义时不写）、一个安静的动作（比如撤销）或 `settled` 一个灰词说它后来怎样了，两样不同时有。没有行时只显示 `empty`，一句灰字。
- 块 `stats`：`{ stats: { label, value, note }[] }`，几个数，每个一张小卡。
- 块 `tree`：`{ param, selected, nodes }`，节点 `{ value, label, count, children }`。选中一个节点，就是把这一页的参数 `param` 设成它的 `value` 再取一次，像筛选一样；`selected` 是当前的值。
- 块 `asks`：`{ asks, empty }`，只有主人能定的事，每件 `{ key, by, text, about, actions, suggested? }`。界面里回答之后，这一件在原处折成一行回执（回答了什么、答复的那句话、什么时候），页面开着时一直在，即使重取之后它已不在答复里。
- 块 `steps`：`{ steps }`，一步 `{ key, title, done, summary, blocks }`。没做的一步展开，显示它的块；做完的折成一行，标题下面是灰的 `summary`（做成了什么），点开再看它的块。第一个没做的是当前的一步。步里的块像分节里的一样逐个核对。首页上的会被并进「开始」（见上面）。
- 块 `drop`：`{ to, command }`，把文件放进库里的文件夹 `to`，记成主人带进来的。在 Mac 外壳里是一块虚线的区域，点了由外壳弹出选文件的面板（文件和文件夹都行，可以多选），选的经命令行放入；拖到窗口任何地方的效果一样。浏览器交不出文件，显示 `command`，可复制。
- 筛选选项的 `count`，和视图答复的 `filters`：答复可以为它声明了的筛选给出这一次看到的选项（比如有哪几个 agent）和每个选项有几条；没声明的筛选不要，列进问题。界面用答复给的选项，只有一个选项的筛选不画。
- 视图的 `home`、条目节的 `actions`：见上面。

内核核对插件给的每一块，段落里的块逐个核：种类不认识、缺了必需的字段（类型里不带 `?` 的）、字段的类型不对、`feed` 的一行既有动作又有 `settled`、`asks` 推荐的不在回答里、`embed` 的地址不是 http 或 https、`custom` 的 `entry` 爬出 `ui` 目录或插件没有 `ui`、输入的 `pattern` 不是正则、动作的 `call` 不是一个动词或这个库里在的一条主人命令、参数不合那条命令的参数表（没填的输入算给了，填的值到分派时再核）、「说」的种类没有插件听、`call` 写了动作没有的输入，这一块换成一段文字，说是哪个插件的块、为什么，并列进问题；页的其余部分照常。`Call` 的解析（`parseCall`）在内核，界面的服务收 `POST /api/call` 时用同一个。`refresh` 不是数字的去掉，也列进问题。比内核旧的网页遇到不认识的种类，仍显示成一行字。

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
- `feed`、`stats`、`tree`、`asks` 和谁做的记号的画法取自 affectUI Pro 的几件（活动屏、决策收件箱、统计卡、树、头像），改成用我们的变量。取来的代码只在 `packages/viewer/web/src/aui/`，每个文件第一行是 affectUI 的许可声明；它们不在开发包、`components.css`、sdk、`plugin new` 的模板和 `plugins/` 里，插件作者拿不到。`packages/viewer/test/licensed-code.test.ts` 守着这两条。
- 主区和详情是两块圆角面板。详情里每样打开的东西一个标签：普通的点击在最前面的标签里往下走，返回走回来；⌘ 点击、中键和命令面板开新的标签，已经开着同一个的就把它调到前面。
- 命令面板（⌘K，或边栏的搜索框）：不打字时列出要去的页和这一页的动作；打了字就用 agent 面的 `find` 在库里找，经 `/api/call`，和按钮同一条路，命中按 `find` 的分组列出，选一条在详情里开。上下键、回车、Esc。

### 界面的服务

- 只听 127.0.0.1。启动时造一个随机令牌，打印的地址带着它。`/api/*` 每次请求核令牌（查询参数 `token` 或头 `x-pneuma-token`）和 Host（`127.0.0.1:<端口>` 或 `localhost:<端口>`）；`/plugin-ui/*` 只核 Host；网页本身和开发包不核。
- `GET /api/state`：是不是库、库的位置（另有一份把家目录写成 `~` 的，给人看）、视图清单和问题、可用的插件。`GET /api/view?view=&<参数>`。`POST /api/call`：一个 `Call` 加 `confirmed`，答复是结果和一行给人看的话；主人面 `Call` 的 `stdin` 是命令向主人要的值，比如密钥。`GET /api/file?path=`：内容区和归档区的文件原样给出；路径经内核解析，链接跟到底后还要在库里、不在内核的地方，否则 404；HTML 一律当文字给，带 `sandbox` 的 CSP，浏览器不会运行库里的文件。`GET /api/rev`：库里每个名字、大小、修改时间的摘要。`POST /api/init`：把目录建成库。
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
- 协议是自己写的（`src/mcp/server.ts`，约两百五十行），没有用官方的 SDK：命令行的包文件里没有任何第三方依赖，SDK 的服务端连同它要的 zod 解开约 14 MB，工具的输入又是从参数表生成的 JSON Schema，用 SDK 也只剩它的低层接口。传输是参数（`Transport`：收到的每一行，和发一条的办法），HTTP 跟着应用来。仓库的测试用官方 SDK 的客户端（只是开发依赖）分别以两代协议连上它。

### 接上一个 agent

主人在应用里的主路是：选一个文件夹，把自己的 agent 一个一个接上，开始干活。接上是一条主人命令，断开是它的逆，界面的按钮就是这两条命令：

- `agent detect`：这台机器上有哪些 agent 产品、各能怎么接上。只看程序和文件夹在不在。
- `agent connect <产品> [--name <授权名>] [--area <子文件夹>] [--read-only] [--via skill|mcp]`：先发授权（缺省以产品命名；这个库里同名、给同一个产品、区域和权限也一样的授权接着用，撞名的拒绝，说用 `--name`），再按产品能用的方式写：读技能的，把技能装进它读技能的目录；不读的，把 MCP 服务 `<本机的命令> @<授权名> mcp` 登记进它的配置。两种都行时装技能，`--via` 改。先看能不能写、再发授权，所以拒绝时什么都没留下。答复说写了什么、写在哪、在那个产品里接着做什么（重启它，或对它说一句话），Codex 另有把库加进可写目录的提示。
- `agent disconnect <授权名> [--keep-grant]`：拿掉接上时写的，再撤回授权。它只动这台机器，不用指明库；授权在记录里的那个库里撤回，作为那个库的一次操作发事件。
- `agent list`：接上的 agent，各自的产品、授权、方式、区域、只读与否，接上时写的还在不在，它运行的本机命令在不在、指向的 node 和命令行在不在。
- `launcher install`：让本机的命令指向现在这个命令行（见下）。

五条都只给主人，不是 MCP 服务的工具。`grant issue`、`grant revoke`、`skill install` 原样留着，接上就是用它们拼出来的。

**产品表**（`products.ts`）是关于每个 agent 产品知道的一切的唯一一处：怎么认出它的会话、找它的对话（第 4 节），怎么看出它装在这台机器上，从哪个目录读技能，MCP 服务登记在哪个文件、什么格式、哪个键下，还要告诉主人什么。一个产品一行；没在产品自己的文档或它自己的行为上核过的事实不写，这个产品就少一种接法：

| 产品 | 看出装着 | 技能 | MCP 服务 | 核过的 |
| --- | --- | --- | --- | --- |
| `claude-code` | PATH 上的 `claude`；`~/.claude` | `~/.claude/skills/` | `~/.claude.json` 的 `mcpServers`，条目带 `"type": "stdio"` | 技能目录和「当前会话里就看得到」按 Claude Code 的文档；MCP 的文件、键和条目的样子按 `claude mcp add --scope user` 在临时家目录里写出的文件；`claude mcp list` 连得上接上写的条目 |
| `codex` | PATH 上的 `codex`；`~/.codex` | `~/.agents/skills/` | `~/.codex/config.toml` 的 `[mcp_servers.<名字>]`，环境变量在 `[mcp_servers.<名字>.env]` | 技能目录按 Codex 的文档；表的写法按 `codex mcp add` 在临时家目录里写出的文件；`codex mcp get` 读得出接上写的表 |
| `claude-desktop` | `~/Library/Application Support/Claude` | 不从目录读技能 | 那个目录里 `claude_desktop_config.json` 的 `mcpServers` | MCP 的文档（modelcontextprotocol.io）：位置、键、条目，要完全退出再打开 |
| `cursor` | `~/.cursor` | `~/.cursor/skills/` | `~/.cursor/mcp.json` 的 `mcpServers`，条目带 `"type": "stdio"` | Cursor 的文档；文档没写它在 PATH 上的程序名，所以只看文件夹 |
| `antigravity` | — | — | — | 只认会话 |

**写别的程序的文件**是危险的部分，规矩是：

- 接上写了什么记在本机的 `$PNEUMA_BASE_HOME/connections/<授权名>/connection.json`，不在库里：哪个文件、哪个键或哪个文件夹、写的东西的指纹、为它造出来的文件夹、授权的编号。第一次改一个已有的文件之前，原样复制一份到旁边的 `before/`，断开时和记录一起删。目录 `0700`，副本 `0600`：配置文件里可能有密钥。
- 文件按字改，不经解析器重写（`config-edit.ts`）。JSON 先用 `JSON.parse` 确认读得懂，再在原文里找出对象和成员的位置，在服务那一层的最后加一个成员，缩进和换行照文件自己的，其余每个字节不动，所以数字、键的次序、格式都还是主人的。读不懂的（带注释、最外层不是对象、键重复）不改，拒绝，答复里给要自己粘的那段和先发授权的命令。TOML（Codex）在末尾空一行追加两张表，拿掉时按追加的原文精确匹配。不引 TOML 库：已经写着这个名字、或服务表写成了一行里的表的，不加，同样给那段。
- 写回时在同一个目录里先写临时名，带原来的权限，再改名；文件是链接时写它指向的那个，链接还是链接。
- 断开只拿掉自己写的，而且只在它还是写的时候的样子：主人改过的，断开说出来，原样留着。接上之后没人动过那个文件时，断开后的文件和接上前一个字节都不差；接上时造出来的文件和文件夹，空了就删。
- 写进去的都按绝对路径指名本机的命令 `$PNEUMA_BASE_HOME/bin/pneuma-base`：MCP 条目的 `command` 是它，`args` 是 `@<授权名> mcp`，没有自己的环境变量；技能里的命令行也用它，并说明说明里写 `pneuma-base` 的地方都用这个路径（技能是这台机器的文件，说明是库的，跟着库走，仍写 `pneuma-base`）。所以没有 shell 配置、PATH 上只有系统工具的应用也启动得了。
- **本机的命令**是一个小脚本：导出它所在的家目录作 `PNEUMA_BASE_HOME`，再 `exec` 一个写明的 node 和一个写明的命令行入口文件。路径从不变，内容由提供命令行的一方保持最新：Mac 应用每次启动时让它指向应用里自带的 node 和命令行；从包装的，`pneuma-base launcher install` 让它指向现在这个命令行（PATH 上的 `node` 就是这个 node 时写 PATH 上的那个：包管理器升级时它不变）。两种都只在内容不同时才写，先写临时名、带上可执行位再改名。`agent connect` 和 `skill install` 在它不在、读不懂、指向的东西不在了或家目录不对时写它，好好的就不动。应用挪了位置或升级了，接上的 agent 不受影响：下次启动应用，命令跟着改；在这之前 `agent list` 说出它指向的东西不在了，再接一次也修好。接上之前写的记录（条目里写 node 和入口文件的）照旧按那两个路径查。
- 接两次，第二次什么都不改；断开两次，第二次安静地说没有这个连接。

**授权**在内核里，只有最小的形状：编号、名字、给谁、哪个区域、读还是读写。没配任何授权时，谁都能用整个库。区域是库里的一个子文件夹。

授权有两处：库的配置里是权威的那份；发给 agent 的那份是它本机的一个小文件，放在 `~/.pneuma-base/grants/<名字>.json`，写着库的位置和授权编号。agent 用 `pneuma-base @<名字> <动词>` 调用，一个名字同时定下是哪个库、是谁。这个文件不是库的状态，丢了重新生成。

**会话和行动者的识别**次序：命令行参数；环境变量；都没有就为这次调用造一个。

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
  PNEUMA-BASE.md              说明（认知的载体，由内核拼）
  .pneuma-base/
    config.json               库标识、格式版本、插件表、授权
    tmp/                      内核写到一半的临时名；putting/ 下是正在放入的标记，asking/ 下是提请求时的锁。不同步
    requests/<号>.jsonl        agent 提的请求，一个一个文件，只追加（第 4 节「请主人做」）
    <插件名>/                  每个插件名下的目录
  _archive/                   归档区，里面保持原来的相对路径
  <某个目录>/.pneuma-item      带这个标记的目录是一样东西
  ……                          其余都是内容，随便怎么放
```

本机还有一个目录，不是库的一部分，缺省是 `~/.pneuma-base`，可以用 `PNEUMA_BASE_HOME` 换：

```
$PNEUMA_BASE_HOME/
  bin/pneuma-base             本机的命令：接上的 agent 按这个路径运行，内容由提供命令行的一方保持最新（第 6 节）
  grants/<名字>.json          发给 agent 的授权副本
  connections/<授权名>/        agent connect 写进别的程序的东西的记录，和改之前那份文件的副本（before/）
  app/                        Mac 应用自己的小配置和日志（app/README.md）
  plugins/<名字>/              装到这台机器上的插件：index.js、它导入的文件、可选的 ui/
  secrets/<插件名>/<密钥名>     插件的凭证，只有用户能读，不进任何库
  cache/<库的 id>/<插件名>/    插件的缓存，删了能重建
```

## 9. 内核的不变式

| 编号 | 性质 | 由什么守 |
| --- | --- | --- |
| K1 | agent 面的任何调用，不让库里已有的内容或已有的记录变得找不回 | 放和归档的全化表；`revise` 的契约；测试 |
| K2 | 没有任何插件时，七个动词都给出确定的答复，不报错 | 空配置的端到端测试 |
| K3 | 换插件不改变七个动词的请求和结果的形状 | 类型 |
| K4 | 内核不依赖任何插件；插件只经内核的公开接口接触内核 | 包的依赖；lint 的导入规则 |
| K5 | 两个面的每次操作都产生一个事件，发给所有插件。视图不是操作，不发事件 | 管线的单一出口；`ownerFace.dispatch` 是主人面的唯一入口；测试 |
| K6 | 说明里许诺的能力不超出已装插件提供的 | 拼装只从配置和插件的认知段取材；测试 |
| K7 | 破坏性的操作只在主人面，要人当面确认，在 agent 的会话里被拒绝 | 主人面命令的声明里带「破坏性」标志，由内核统一拦；只给主人的命令（`ownerOnly`）在同一道门被拒；`ask` 只记下要什么，`request approve` 让那条命令以主人的身份再过这道门；测试 |
| K8 | 一个插件出错不让动词失败，也不被静默吞掉 | `problems`；测试 |
| K9 | 归档的东西不被删除；默认的找和查不带它，开关打开才带 | 归档的全化表；测试 |

## 10. 记账与对账插件

领域模型在 `MODEL.md`。它接上的槽：

| 槽 | 它做什么 |
| --- | --- |
| `onPut` | 记入册；内容变了的记改。带标记的目录入册时，事实带 `bundle: true`。放入带的 `note` 记在这次写的 `item.enter` 或 `item.revise` 上，所以 `check` 里一次放入是一行，`inspect` 把它写在那份内容的那一行后面；内容和记录一致、这次不写事实时，记成关于这样东西的一条备注 |
| `revise` | 把旧内容复制进留存，目录条目整棵复制；新的由内核放上去，`onPut` 收到的 `previous` 是被换下的指纹，记改 |
| `onFind` | 按场景、来历、记录里的文字（含放入带的说明）和文本内容找。目录条目算它里面每个文件的相对文件名，和它的文本文件：从小的读起，读过的不论是不是文本都算数，读满 1 MB 为止，所以图片多的网站不会让一次查找读个没完 |
| `onFound` | 别的插件找到的路径是这次查找它自己也肯给的条目时（`start` 照样不带自己这次会话的），给它所在场景的那一行和来历，和 `onFind` 给条目的那条一样；没人登记过的文件不给。不读正文 |
| `onInspect` | 一样东西的来历、现状、它来自什么、什么来自它；一个场景的卡；`@<授权>` 是那份授权的 agent 来过没有：最近一次的事实是什么时候、几次会话、放进几样（节名「来过」，Agent 页的每一行用它） |
| `onSay` | 听得懂：在做什么、决定、备注、来自、改了 |
| `onArchive` | 记下归档和取回；已归档的条目不出现在可能过期等清单里 |
| `onCheck` | 自某时以来的变化；来历不明的；可能过期的；来源不在的；挪过的（已接回，记一条看到的挪动）；不在了的。每次查记一条「看过了」（`checked`）：「上次」就是这个行动者上次查的时候，没查过时是它上次在别的场景里留下事实的时候。首页的「都看过了」就是主人查一次，所以 agent 的查和主人的「都看过了」是同一件事；同一个会话里再查，只说上次查之后的。「看过了」不是消息，不进活动，也不算一个场景 |
| `observe` | 把做成了的主人面操作记成事实；主人批准的请求跑的那条命令，做成了或被拒都记，带上谁请的和请求号（`owner.op` 的 `request`，被拒的另带 `refused`），`request approve` 自己不另记；agent 提请求和撤回记成 `request` 事实，同一个请求再提不记；清归档时，被删的路径上的条目记为已除 |
| `views`、`onView` | `ledger.items`（库）：左边是文件夹的树，每层带它下面有几样，选一个就只看那里面的（参数 `dir`）；右边一张表，路径、来历（灰字，来历不明的是标签）、谁（可让的列：面板里也有）、现状（一致是灰字；变了、依据上有标记时是标签）、时间；「显示」全部、带进来的、做出来的、已归档，每个选项带数目；行链到内核的 `item` 面板。`ledger.activity`（活动）：最近 200 条事实，新的在前，按天分组，含主人面的操作；一行是何时、谁（记号）、`check` 里的那句话、谁的动作（自己做的、主人做的、主人批准的、看到的；主人批准的另带提的 agent 的记号和请求号）、在哪个场景（链到场景）、凭哪条授权；归档和取回在东西还在原处时带撤销的按钮，后来已被撤回的写一个灰词，别的不写；「谁做的」全部、agent 做的、主人做的，「哪个 agent」列出出现过的每个，选项都带数目。`ledger.scenes`（场景）：每次会话一行，按开始的那天分组，新的在前：谁、在做什么（没说过就是其中的主人面操作）、放了几样、在哪个目录；行链到场景页。`ledger.scene`（场景页，不进导航，参数 `scene`）：四个数（时长、放入几样、依据几样、几个决定），对话在哪（可复制，标着在这台机器上、这台机器上已经没有了或在别的机器上；在这台机器上时下一行是接着聊的命令，可复制）、谁、在哪，然后是这次会话里发生的，新的在前，和活动页一样的行。`ledger.standing`（状况）：`check` 的那几节，用同一份 `standingData`；每节是一个列表，路径链到那样东西的面板，挪过的链到新位置，只在比节名多说了什么时带一句；参数 `kind` 只看一种。`ledger.home`（不进导航，`home`）：首页上「开始」的第三步，和两部分。「自上次以来」：别人在主人上次看过之后做的事，按场景分组，组名是那个场景说的在做什么，和组名一样的那句不再重复成一行；带「都看过了」，它调的就是 agent 面的 `check`。「需要留意」：每种要看的一行，写着几样，链到只看这一种的状况页 |
| `onItemView` | 条目详情里「来历」一节，次序固定：何时、谁、哪个场景（写那个场景在做什么，链到场景页）、在哪，现状只在不一致时写，并入了哪个目录；「怎么来的」：来历与出处、先前的来历，依据（每个依据的现状，一致是灰字，链到上游的 `item`）；「发生过什么」：每次换内容和那次放入带的一句话、说过的决定与备注，新的在前，标出哪一份在留存里；「凭什么」：凭哪条授权，它的区域和读写；被什么依据；留存，每份说是谁放进来的那份内容，不说它放在哪。动作放进面板底下那一行。数据就是 `inspect` 用的 `itemView`。没人登记过的文件说明来历不明；带标记的目录里面从没入册的文件说明它是谁的一部分。动作都经两个面：来历不明的给「记为带进来的」「记为做出来的」（`put` 登记）；被直接改过的给「认下这次改动」（`say revised`）；每份留存给「取回到新路径」（`ledger held restore`）。状况页的「没人登记过的」「被直接改过的」两节，每一项带同样的动作 |

它给主人面加三条命令，名字和别的插件一样以它的名字开头：`ledger held list` 列出留存，只读；`ledger held restore <库内路径或条目号> [--fingerprint <指纹>] --to <新的库内路径>` 把一份留存复制到一个空着的新路径，目录条目整棵复制回去，并把它以「主人带进来的」入册，只给主人；`ledger held drop` 清掉全部留存，是破坏性的。两条都由内核的门拦。

事实的种类、归并函数 `fold`、对账函数 `reconcile` 和输出的形状在 `packages/plugin-ledger/src/` 里，`fold` 和 `reconcile` 是纯函数。实现里和本程细化设计不同的几处：

- `item.enter` 和 `item.revise` 另带 `size`。对账找已搬的候选时先按大小筛，再取指纹；没有这个字段就没法筛。目录条目的 `size` 是它算进指纹的文件的字节数之和。
- 目录条目：`item.enter` 带 `bundle: true`。已经在册、路径在一个后来入册的目录条目下面的条目算「并入」了它，这是 `fold` 推出来的，没有新的事实种类。并入的条目跟着那个目录挪、归档、被清掉；它不报「不在」，不出现在 `find` 和 `check` 的清单里；看它时说明它并入了哪里。依据它的东西照样按它那个文件现在的内容判可能过期。目录里面从没入册的文件，看它时说明它是哪个目录条目的一部分。`say` 写的路径在一个带标记的目录里面时，说的是那个目录。
- 对账用内核的 `fingerprintOf`，文件和目录条目一样；快照列的是东西，目录条目不往里走。
- 用词：被新内容换下的旧内容进**留存**，是给主人的保险，只有主人取得回（`ledger held restore` 只给主人）。记账插件的说明、放的答复、`inspect`、界面都说留存、换了新内容，不说版本或一版：版本归版本插件。`inspect` 列出内容换过的每一次，「被换下，在留存里」标在被留存的那一份上，按留存目录里的指纹认。
- `put --made --from` 写了被换掉的东西自己时，依据里不记它自己：换内容本身就是 `item.revise`，它不是自己的依据。
- 给来历不明的条目补来历的那条 `item.enter` 是它的别名，不多一份内容；它带的 `note` 由 `fold` 放到它登记的那份内容上，那份已有一句时不盖掉。
- 看到的来历和改动（第 4 节「看到的和说的」）：`put --observed` 写的 `item.enter`、`say revised --observed` 写的 `item.revise`，信封的 `how` 是 `observed`，事实本来就记着它是怎么来的。来历显示的每一处都带「（自动登记）」：「带进来的，主人给的（自动登记）」；看到的改动是「直接改的，自动登记」。之后谁再登记同一路径、内容没变、写明了来历，就换掉看到的来历，和今天给来历不明的条目补来历一样（「已更正来历」）；`fold` 把被换掉的那条 enter 留在 `earlier` 里，`inspect` 写成「先前：…」，条目的「谁」「何时」「场景」跟着说的那一条。之后谁再 `say revised`（带不带 `--by owner` 都行）同一份内容，就换掉看到的那条改动的归属，版本不多一个，那一版标「先是自动登记」。说的永远不被看到的换掉：内核和记账插件都不让看到的盖过说的，`fold` 里事实的次序反过来（同步带来的）也一样。`--observed` 只给主人；`say revised --observed` 不和 `--by` 一起写，看到的不知道是谁改的。
- `say revised <库内路径>` 认下一个被直接改过的文件的现内容，记一条 `claimed` 的 `item.revise`。主人说是自己改的，agent 加 `--by owner`：事实体带 `by: 'owner'`，信封的 `actor` 仍是这个 agent，显示时两个人都出现；主人自己说时不带 `by`。信封的 `actor` 是库从授权和会话认出来的，调用方说什么都不改它。
- 主人面操作的事实里，答复写成一行：几行连起来，绝对路径和 `file://` 地址只留最后的名字。它在 `check`、场景卡和动态里给人读，名字就够了。只读的命令（事件的 `readOnly`）照样记，但不算「自上次以来」的消息；只设插件、目标或嵌入器的命令（事件的 `setup`）在某个行动者第一次来之前发生的不算消息（说明里已是最新配置），在它来过之后再改才列出。
- 「一次命令行调用写一个文件」落成「每个钩子写一个文件」：`start` 里「说」和「查」各写一个，`put` 盖掉无主文件时 `revise` 写入册、`onPut` 写改。每个文件照样是新文件、写完不动。
- 发布事实文件用硬链接到最终名再删临时名，最终名已存在时失败重试，而不是覆盖。
- `check` 比设计多一节「不在了的」，验收 C4 要求报告不在；「上游有标记」也单列一节，直接带标记的条目不重复列在里面。
- 放先落文件后记账，所以对账先看一遍：读事实，列库里的东西，取指纹。看出了什么（没人登记过的、被直接改过的、挪过的、不在了的），再用内核的 `tools.putting()` 读正在放的路径，然后重读一次事实：看出的一样东西，路径正在放，或重读时新出现的事实提到了它的路径或条目，就不报，按记录算（`reconcile.ts` 的 `confirm`）。次序是要紧的：标记在看过文件之后读，正在放的路径不报；事实在读过标记之后读，在对账期间开始又做完的放已经记下了，单靠标记挡不住它。新事实只要提到就算，因为一个放记下之后可能紧接着被挪走，路径已经不在册上了。`check`、条目页和状况页都这样对账，`check` 也就不会把正在挪的东西当成看到的挪动记下来。事实文件写完不动，同一个进程里读过的不再读；各个场景的目录并发地列。600 个事实文件的库上，`check` 有要报的东西时也比改之前快（中位约 0.21 秒对 0.24 秒）。
- `find` 什么都给，包括调用者自己这次会话的场景和条目；`start` 的找（`skipOwnSession`）不带调用者自己的场景和在其中放入的条目。找的结果按场景分组，`group` 是场景那一行。`inspect` 一个条目时只看它自己和它直接依据的文件，不找已搬；已搬只在 `check` 和 `start` 里认。
- 界面的视图在 `ui.ts` 和 `feeds.ts`，是纯函数：取自 `fold`、`reconcile`、`itemView`、`sceneView` 背后的同一份归并与 `standingData`，不另算一套来历；都不写事实，不收养没人登记过的文件，看到的挪动也不记，留给 `check`。面板里一样东西没有文件、或一个文件没人登记时，才做一次全量对账，认出挪到这里的条目。
- 「自上次以来」只列改了内容或能力的事。不改两者的主人面操作（`init`、`grant issue`、`grant revoke`、`skill install`）照样记成事实，但不列出；名单是 `views.ts` 里的一个集合。
- 场景号在文字答复里只显示前 8 位（临时场景 `adhoc-…` 显示全），工作目录把家目录写成 `~`、过长时只留最后 45 个字符（内核的 `shortDir`，界面里窄的地方给更短的上限）；`--json` 给全的。`inspect` 和 `find --scene` 接受场景号的前缀，至少 6 个字符；`inspect` 遇到几个场景共用的前缀，列出它们的全号。

存放，都在 `.pneuma-base/ledger/` 下：

| 目录 | 性质 | 内容 |
| --- | --- | --- |
| `facts/` | 本体 | 每次写入是一个名字唯一、写完不动的文件，先写临时名再改名 |
| `held/` | 本体 | 留存：被新内容换下来的旧内容，等主人清 |

这一版不要求 agent 报告读了什么。agent 放东西时写明它依据了哪些，这就是来自。「读了」留给以后的钩子自动记。没有命令行的 agent 只管把文件放进库，它们落在「无主」，由别人补上来历；这一版不定手写记录的格式。

仓储四问：

| 问 | 答 |
| --- | --- |
| 写入 | 一次命令行调用写一个文件，几条到几十条事实；按事实的编号幂等 |
| 查询 | 每次调用读全部事实，在内存里归并成视图；这一版没有索引 |
| I/O | 同步读；写是临时文件加改名；并发的写者各写各的文件，不抢 |
| 容量 | 假设一年几千个场景、几万条事实。先坏的是「每次调用读全部事实」，届时加一个缓存目录，不改本体 |

## 11. 版本插件

`packages/plugin-version`。声明了「有版本」的东西，每一版的内容都留着，任何一版能导出到库外或放回来。声明是 agent 的 `say`：`say versioned <路径> [一句话]` 声明并把当前内容记成第 1 版；`say version <路径> <一句话>` 给当前这一版写说明。路径在带标记的目录里面时，说的是那个目录。

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

`packages/plugin-sync`。库和一个同步目标双向同步：只整份地复制文件，不合并内容；同步前任何一边有过的每一份内容，同步后都还在两边的某处。只有手动的 `sync now`，没有后台进程。

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

**范围。** 整个库文件夹，含 `.pneuma-base/` 里各插件的记录，逐个文件，目录条目连标记一起。不含：`.pneuma-base/config.json` 和 `PNEUMA-BASE.md`（每台机器的配置：授权、插件表和给缓存目录作键的库标识，说明由它拼出）；`.pneuma-base/tmp/`；已装插件声明为缓存的目录；任何一层的 `.git`、`node_modules`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`、`.tmp-*`；目标里的 `.pneuma-sync/`。

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

它是 sdk 的**部署库**加两种目标：`deployPlugin('deploy', [dirTarget, commandTarget])`。部署库（`@pneuma-base/sdk/kit`，代码在 `packages/sdk/src/kit/deploy/`）拿一个插件名和一种或几种目标，交回一个完整的插件；和目标无关的都在它里面，第三方的部署插件只写自己的目标。库不是插件，插件导入库不算插件导入插件；库不导入内核，对库的读写都经 `tools`。状态表、决定表、站点名的规则和目标的接口在 `packages/sdk/src/kit/deploy/README.md`。一个库只装一个部署插件，这是设计：几个部署插件都认领 `deployable`，第二个在 `plugin add` 时以 `name-taken` 拒绝；要发到几种地方，是一个部署插件带几种目标。

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

目标是一个接口（`TargetAdapter`，sdk 的 `defineTarget` 让 `configure` 收到按开关定好类型的值）：怎么配（`params`，`target set` 在 `--kind` 之后的开关，一份 `FlagParam[]`，用法、核对和表单都从它来；`configure` 把核过的值变成要存的配置；给人看的说明；`secrets`，它读的密钥），怎么在边界上解析存下的配置并打开它。部署库把各种目标的 `secrets` 声明成插件的 `secrets`，所以 `secret set <插件名> <名字>` 和配置页都认得；打开目标时给它 `secret(名字)`，读主人在这台机器上设的值，必需的没设就以说明用哪条命令设的错误拒绝，开关的答复里是 `publish-failed` 带这句话，可选的（`optional: true`）没设读出 null；`target set` 的答复提醒还没设的必需密钥，可选的只说要用时怎么设；`configure` 带了 `note` 时答复用它代替这些提醒（凭据能从几处来的目标说用哪一处）。要密钥的目标从不在开关里要它。打开的 `Target` 有标识 `key` 和给人看的 `label`，`publish(站点名, 内容目录, meta) → { url }`、`remove(站点名)`；可选的 `siteName` 换掉缺省的站点名规则，`identify` 换掉内核的指纹作内容的编号，`serving` 报告它真在服务什么，每个站点可以另带一份它自己类型的 `detail`，`view` 往页面和面板里加东西：列、字段、部署库的节前后的块、面板里的块，和目标在 `views` 里声明的自己的页（导航里各一项）。可选的 `close` 在打开它的钩子、命令或视图结束时调一次（失败了也调，它抛的错不算），登录服务的目标在这里退出登录。视图的函数拿到的每个 look 带着 `serving` 对它的站点说的 `detail`，归档了的、待下线的也一样；`defineTarget` 按 `open` 的返回类型 `Target<细节>` 给这些函数定类型。一页先为全部东西问一次 `serving`（问时说明这次要画，`{ detail: true }`），再调视图的函数；钩子和命令问时 `detail` 为假，目标据此只在要画时取贵的数据。目标有 `serving` 时页面带 `refresh`，缺省 30 秒，目标的 `view.refresh` 可以改。部署库导出 `STATUS` 和 `switchAction`，目标自己画的块用它们说和表格一样的状态、给一样的开关。会报告的目标按它报告的对账，对账前先把记录对齐它，所以 `deploy sync` 修得好断在一半的发布和在目标那边被删掉的站点；它读不到时状态是「不知道」，什么都不做。不会报告的按插件自己的记录对账。自带的两种都不报告。发布前用 `tools.copyOut` 把算进内容的文件复制到缓存目录下的临时目录（不带标记），核对编号，再交给目标。`dir` 目标写 `<目录>/<站点名>/…` 和 `index.json`，先写 `.tmp-` 开头的名字再换上，目录不能在库里或包含库；`command` 目标把主人的命令按 shell 的引号规则切成参数、不经 shell 运行，工作目录是库根，超时缺省 120 秒。

存放，都在 `.pneuma-base/deploy/` 下，本体：`config.json` 是目标，带它的 `kind`，经 sdk 的配置文件助手先写临时名再改名；`facts/` 经 sdk 的记录库，每次写入一个名字唯一、写完不动的 jsonl 文件：声明、开关、挪、去掉、发布、下线。「目标上有什么」（目标不会报告时）来自对当前目标（按目标的标识区分）的发布与下线记录；换了目标，开着的东西都成待发布，旧目标上的不撤。缓存目录里只有发布时的临时目录。改用部署库之前写下的记录和配置，格式没变，照样读。

实现里和本程细化设计不同的几处：

- 跟着挪和归档用的是 `onPut`、`onArchive`，不是 `observe`：这两个槽收到的是内核解析过的路径（`observe` 里挪的来源只有调用方写的原样），答复能告诉 agent 重新发布了什么。清归档区用 `onPurged`，不看 `observe`。
- 状态比设计多两种：待下线（不该在线、目标上还有，上次下线失败）和不在（开着、路径上没有东西）。会报告的目标读不到时还有「不知道」。
- 目标的配置是 `config.json`，会被 `deploy target set` 换掉；它是配置，不是记录。

## 14. 查找插件

`packages/plugin-search`。装上它，`find` 也匹配文本文件的正文，按相关度排；主人配了嵌入器时也按意思找。它不听任何 `say` 的种类。

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
- 几个答复者的结果怎样合成一张表，见 §4「找」：同一路径排在任何答复者给它的最好名次上，内核按名字找到的那条并进第一个插件的那条。
