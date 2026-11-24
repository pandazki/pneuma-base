# Pneuma Base 架构

2026-11-25。这份文档定内核、插件边界和包的依赖方向。它是项目的正式约束：要改这里写的边界或不变式，先改这份文档。

- 产品定义和你定过的事在 `CONTEXT.md`。
- 记账与对账插件的领域模型在 `MODEL.md`。
- 这里的类型是签名层面的设计，实现时可以细化，不能改变形状所表达的约束。

## 1. 中心

内核是三样：**认知**、**工具面**、**扩展点**。其余都是插件。

- **认知**：agent 被告知的那套心智，载体是库根目录的说明。技能指向它。
- **工具面**：agent 手里的六个动词，形状不随插件变化。
- **扩展点**：每个动词背后的槽，每个槽都有空实现。

没有任何插件的空目录，六个动词都给出确定的答复。

**底线：破坏性的改动不能由 agent 造成，无论有意还是无意。主人做什么都可以。** 两个面的操作默认都留痕，让 agent 能感知变化。

## 2. 用词

| 词 | 意思 |
| --- | --- |
| 库 | 一个文件夹，根目录有说明，`.pneuma-base/` 下有配置和各插件名下的目录 |
| 行动者 | 做事的一方：agent、主人、插件 |
| agent 面 | agent 能调用的全部：六个动词，全部不破坏 |
| 主人面 | 配置、装卸插件、发授权、生成技能、丢数据。破坏性的要人当面确认 |
| 动词 | 放、找、看、说、查、归档 |
| 归档 | 把一样东西挪进库里的归档区。不删；默认的找和查不带它，带上要开开关。agent 做得快、废弃得也快，归档是 agent 面上不破坏的「不要了」 |
| 槽 | 一个动词背后插件可以接上的位置 |
| 会话 | agent 产品的一次会话，或人对工具的一次使用 |
| 事件 | 两个面的一次操作及其结果，内核在操作之后发给所有插件 |
| 认知段 | 一个插件拼进说明和技能的那一段话 |
| 本体、缓存 | 插件对自己名下每个目录的声明。本体跟着文件夹走；缓存不同步，删了能重建 |

## 3. 包和依赖方向

```
packages/cli ──▶ packages/kernel ◀── packages/plugin-ledger
      │                                      ▲
      └──────────── 内置插件表 ───────────────┘
```

| 包 | 职责 | 不许 |
| --- | --- | --- |
| `packages/kernel` | 打开库、解析配置、识别行动者和会话、六个动词的管线、授权的门、事件、认知的拼装、技能的生成 | 依赖任何插件；认识任何插件的事实或目录 |
| `packages/plugin-ledger` | 记账与对账：事实、场景、条目、对账、来历、过期、变化 | 读写别的插件的目录；绕过内核的公开接口 |
| `packages/cli` | 命令 `pneuma-base`：把命令行翻译成对内核的调用，把结果打印出来；内置插件表 | 含领域逻辑 |

插件只经 `packages/kernel` 导出的类型和上下文对象接触内核。插件之间不直接调用。

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
  transcript: string | null
}

type Context = { library: Library; actor: Actor; session: Session; now: Instant }

interface AgentFace {
  put(req: PutRequest, ctx: Context): Promise<PutResult>
  find(req: FindRequest, ctx: Context): Promise<FindResult>
  inspect(req: InspectRequest, ctx: Context): Promise<InspectResult>
  say(req: SayRequest, ctx: Context): Promise<SayResult>
  check(req: CheckRequest, ctx: Context): Promise<CheckResult>
  archive(req: ArchiveRequest, ctx: Context): Promise<ArchiveResult>
}
```

### 放

```ts
type Origin =
  | { kind: 'brought'; source: string | null; by: string | null }   // 带进来的：出处，谁带的
  | { kind: 'made'; from: string[]; outside: string[] }             // 做出来的：依据库里的哪些，库外的各写一句

type PutRequest =
  | { kind: 'register'; path: LibraryPath; origin: Origin }                 // 文件已经在库里
  | { kind: 'place'; from: string | 'stdin'; to: LibraryPath; origin: Origin }   // 从库外的文件或标准输入放进来
  | { kind: 'move'; from: LibraryPath; to: LibraryPath }                         // 在库里挪位置

type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint; copied: boolean
      notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' }
```

内核自己能看到的只有文件。全化表：

| 请求 ＼ 目标 | 在库外或授权区域外 | 不存在 | 存在，内容相同 | 存在，内容不同 |
| --- | --- | --- | --- | --- |
| 登记 | 拒绝 | 拒绝：没有这个文件 | 接受 | 接受（登记的是当前内容） |
| 放入 | 拒绝 | 复制，接受 | 不复制，接受 | 有插件提供可撤回的改：交给它。没有：拒绝，目标不动 |
| 挪 | 拒绝 | 挪过去，接受 | 拒绝 | 拒绝 |

接受之后，内核把请求交给每个插件的 `onPut`，把它们的答复收进 `notes`。

「交给它」的分工：内核只问配置里排在最前、提供了 `revise` 的那个插件。插件把当前内容留到自己名下（`held`）或拒绝（`declined`）；答复 `held` 之后，由内核把新内容先写临时名再改名放到目标上。插件拒绝或出错，内核拒绝这次放入，目标不动，出错的插件列进 `problems`。这样不管插件写得对不对，目标上都不会出现半截内容。

实现里的细化（形状在 `packages/kernel/src/types.ts`）：

- 请求里的路径是调用方写的原样（相对库根，或库内的绝对路径），由内核在入口解析一次。「在库外」那一列就是解析不出库内路径的情形。`.pneuma-base/`、`PNEUMA-BASE.md` 和 `_archive/` 不算内容，放和挪到那里都按「在库外」拒绝；`_archive/` 只经归档和取回进出。
- 放入的来源是 `{ kind: 'file'; path } | { kind: 'stdin'; content }`。
- 每个结果都带 `problems`，拒绝的结果也带，并带 `subject`：拒绝针对的那个输入。
- 做出来的来历里，`from` 的每个路径都要是库里在的文件（主区，或它在归档区的那份）。有一个不在，就以「没有这个文件」拒绝，`subject` 是那个路径，目标不动。

### 找、看、说、查、归档

```ts
type FindRequest = { text: string | null; match: 'terms' | 'words'; filters: Record<string, string>; includeArchived: boolean }   // 开关默认关
type Hit = { path: LibraryPath | null; title: string; by: PluginName | 'kernel'; detail: string | null }
type FindResult = { hits: Hit[]; problems: PluginProblem[] }

type InspectRequest = { target: string }                    // 路径，或某个插件认得的标识
type InspectResult = { file: FileFacts | null; sections: Section[]; problems: PluginProblem[] }

type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string> }
type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused'; note: string }

type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean }
type CheckResult = { sections: Section[]; problems: PluginProblem[] }

type ArchiveRequest = { kind: 'archive' | 'unarchive'; path: LibraryPath }
type ArchiveResult =
  | { outcome: 'accepted'; from: LibraryPath; to: LibraryPath; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken' }

type Note    = { plugin: PluginName; text: string; data?: unknown }
type Section = { plugin: PluginName; title: string; body: string; data?: unknown }
type PluginProblem = { plugin: PluginName; message: string }
```

找的两种匹配：`terms` 把文字按空白和常见标点切开，名字里含任一段就算；`words` 用 `Intl.Segmenter` 取一句话里两个字以上的词和拉丁词，按命中的不同词数排，至少命中一个，每个答复者最多给 5 条。`start` 用 `words`，`find` 用 `terms`。切词和排序是内核导出的 `searchTerms` 与 `rankHits`，插件用同一套。`filters` 是插件的用语，内核不懂，所以带了过滤时内核不按名字列文件。

`problems` 是失败语义的落点：某个插件出错时，动词照样给出答复，同时如实说明哪个插件没做成。「已放入，但没有记下」是和「已放入并记下」不同的结果，命令行以非零退出码区分。

归档是内核自己做的，不靠插件，所以空目录里也成立。归档区是库根下的 `_archive/`，里面保持原来的相对路径。全化表：

| 请求 ＼ 目标 | 不存在 | 在主区 | 已在归档区 |
| --- | --- | --- | --- |
| 归档 | 拒绝：没有这个文件 | 挪进归档区，接受。归档区里同一路径已有内容不同的文件时，新来的文件名后加指纹的前八位 | 接受，什么都不动 |
| 取回 | 拒绝 | 接受，什么都不动 | 原路径空着：挪回去，接受。原路径被占：拒绝 |

实现按四种状态判：两处都没有；只在主区；只在归档区（原路径空着）；两处都有（原路径被占）。两处都有时，归档按「在主区」办，取回按「原路径被占」拒绝。路径写成 `a.md` 或 `_archive/a.md` 都指同一样东西。接受的结果带 `moved`，什么都没动时为 `false`。

找和查默认跳过归档区，`includeArchived` 打开才带上。看一样已归档的东西照常给出，并标明它已归档。命令行里除了 `find` 和 `check`，库的目录树本身也把归档的东西隔开了，agent 用自己的工具翻目录时同样看不到它们混在里面。

命令行另有一个 `start "<一句话>"`，是「说：在做什么」「查」「找」三个动词的组合，不是第七个动词。

### 没有任何插件时的答复

| 动词 | 答复 |
| --- | --- |
| 放 | 按上面的全化表。接受时 `notes` 为空。放入遇到内容不同的同名文件：拒绝 |
| 找 | 按名字列出库里的文件 |
| 看 | 文件本身的情况，`sections` 为空 |
| 说 | `not-heard`，`no-plugin-for-kind`，附一句「这个库没配能记下这句话的插件」 |
| 查 | `sections` 为空 |
| 归档 | 按上面的全化表 |

## 5. 扩展点

```ts
interface Plugin {
  readonly name: PluginName
  readonly cognition: CognitionSection | null   // 拼进说明和技能的那一段
  readonly storage: StorageDecl[]               // 它名下的目录，各是本体还是缓存
  readonly statements: string[]                 // 「说」里它听得懂的种类

  onPut?(req: AcceptedPut, ctx: Context): Promise<Note | null>
  revise?(req: PlaceOverExisting, ctx: Context): Promise<ReviseOutcome>   // 可撤回的改
  onFind?(req: FindRequest, ctx: Context): Promise<Hit[]>
  onInspect?(req: InspectRequest, ctx: Context): Promise<Section[]>
  onSay?(req: SayRequest, ctx: Context): Promise<SayResult>
  onCheck?(req: CheckRequest, ctx: Context): Promise<Section[]>
  onArchive?(req: AcceptedArchive, ctx: Context): Promise<Note | null>

  observe?(event: Event, ctx: Context): Promise<void>   // 两个面的每次操作之后
  readonly ownerCommands: OwnerCommand[]                // 它给主人面加的命令
}
```

一个只有名字、其余全空的对象是合法的插件。

实现里的细化：钩子收到的上下文另带 `dir`，即这个插件名下的目录；钩子的答复不写插件名，由内核盖上（`PluginNote`、`PluginSection`、`PluginHit`）；`onSay` 答复 `SayAnswer`，处理它的插件出错时结果是 `not-heard`、`plugin-failed`。主人面命令 `OwnerCommand` 带 `destructive` 标志，由内核在同一处拦。插件名同时是目录名，用 `pluginName()` 解析。主人面的事件带 `destructive`，插件不用自己认哪些命令会丢数据；`archive purge` 的答复在 `data.paths` 里列出被删的库内路径，记账插件据此记「已除」。

规矩：

1. 插件登记在库的配置里。说明列出当前用了哪些。
2. 插件写下的东西只进它自己名下的目录，每个目录声明是本体还是缓存。
3. 插件不改别的插件的东西。
4. 内核和别的插件遇到不认识的内容，原样留着。
5. 插件可以做要模型、要联网、带判断的事。内核不做。
6. 插件给 agent 面加的任何动作都必须能由主人撤回。

## 6. 两个面

| | agent 面 | 主人面 |
| --- | --- | --- |
| 能做什么 | 六个动词 | 建库、改配置、装卸插件、发和撤授权、生成技能、清留存、清归档、丢数据 |
| 破坏性 | 没有 | 有。要人在终端当面确认；在 agent 的会话里被拒绝 |
| 留痕 | 每次调用之后发一个事件 | 同样。主人可以关 |

「在 agent 的会话里」的判断：环境里有 agent 产品的会话变量，或调用带着授权。这是第二级的拦法，和认知里的「不该做」一起构成默认强度。让 agent 对库的目录没有直接写权限是第三级，靠 agent 产品自己的沙箱，是装的时候可选的。

**授权**在内核里，只有最小的形状：编号、名字、给谁、哪个区域、读还是读写。没配任何授权时，谁都能用整个库。区域是库里的一个子文件夹。

授权有两处：库的配置里是权威的那份；发给 agent 的那份是它本机的一个小文件，放在 `~/.pneuma-base/grants/<名字>.json`，写着库的位置和授权编号。agent 用 `pneuma-base @<名字> <动词>` 调用，一个名字同时定下是哪个库、是谁。这个文件不是库的状态，丢了重新生成。

**会话和行动者的识别**次序：命令行参数；环境变量；都没有就为这次调用造一个。

## 7. 认知的拼装

库根目录的说明由三部分拼成，配置一变就重拼：

1. 内核的那几句：这是你的库，带进来的和做出来的放这里，下次从这里找；六个动词怎么用；不要覆盖或删除已有的东西，不用了就归档。
2. 每个已装插件的认知段。
3. 当前的配置：装了哪些插件，各自的说明在哪。

说明里许诺的能力不超出已装插件提供的。没装记账插件，说明里就没有「每样东西都能回到它出现的场景」这句话。

技能是一个指向说明的短文件，带着库的位置和授权的编号，为每个 agent 产品各放一份。

## 8. 库的结构

```
<库>/
  PNEUMA-BASE.md              说明（认知的载体，由内核拼）
  .pneuma-base/
    config.json               库标识、格式版本、插件表、授权
    <插件名>/                  每个插件名下的目录
  _archive/                   归档区，里面保持原来的相对路径
  ……                          其余都是内容，随便怎么放
```

## 9. 内核的不变式

| 编号 | 性质 | 由什么守 |
| --- | --- | --- |
| K1 | agent 面的任何调用，不让库里已有的内容或已有的记录变得找不回 | 放和归档的全化表；`revise` 的契约；测试 |
| K2 | 没有任何插件时，六个动词都给出确定的答复，不报错 | 空配置的端到端测试 |
| K3 | 换插件不改变六个动词的请求和结果的形状 | 类型 |
| K4 | 内核不依赖任何插件；插件只经内核的公开接口接触内核 | 包的依赖；lint 的导入规则 |
| K5 | 两个面的每次操作都产生一个事件，发给所有插件 | 管线的单一出口；测试 |
| K6 | 说明里许诺的能力不超出已装插件提供的 | 拼装只从配置和插件的认知段取材；测试 |
| K7 | 破坏性的操作只在主人面，要人当面确认，在 agent 的会话里被拒绝 | 主人面命令的声明里带「破坏性」标志，由内核统一拦；测试 |
| K8 | 一个插件出错不让动词失败，也不被静默吞掉 | `problems`；测试 |
| K9 | 归档的东西不被删除；默认的找和查不带它，开关打开才带 | 归档的全化表；测试 |

## 10. 记账与对账插件

领域模型在 `MODEL.md`。它接上的槽：

| 槽 | 它做什么 |
| --- | --- |
| `onPut` | 记入册；内容变了的记改 |
| `revise` | 把旧内容挪进留存；新的由内核放上去，`onPut` 收到的 `previous` 是被换下的指纹，记改 |
| `onFind` | 按场景、来历、记录里的文字找 |
| `onInspect` | 一样东西的来历、现状、它来自什么、什么来自它；一个场景的卡 |
| `onSay` | 听得懂：在做什么、决定、备注、来自、改了 |
| `onArchive` | 记下归档和取回；已归档的条目不出现在可能过期等清单里 |
| `onCheck` | 自某时以来的变化；来历不明的；可能过期的；来源不在的；挪过的（已接回，记一条看到的挪动）；不在了的 |
| `observe` | 把做成了的主人面操作记成事实；清归档时，被删的路径上的条目记为已除 |

它给主人面加三条命令：`held list` 列出留存；`held restore <库内路径或条目号> [--fingerprint <指纹>] --to <库内路径>` 把一份留存复制到一个空着的新路径，并把那个文件以「主人带进来的」入册；`held drop` 清掉全部留存，是破坏性的，由内核的门拦。

事实的种类、归并函数 `fold`、对账函数 `reconcile` 和输出的形状在 `packages/plugin-ledger/src/` 里，`fold` 和 `reconcile` 是纯函数。实现里和本程细化设计不同的几处：

- `item.enter` 和 `item.revise` 另带 `size`。对账找已搬的候选时先按大小筛，再取指纹；没有这个字段就没法筛。
- 「一次命令行调用写一个文件」落成「每个钩子写一个文件」：`start` 里「说」和「查」各写一个，`put` 盖掉无主文件时 `revise` 写入册、`onPut` 写改。每个文件照样是新文件、写完不动。
- 发布事实文件用硬链接到最终名再删临时名，最终名已存在时失败重试，而不是覆盖。
- `check` 比设计多一节「不在了的」，验收 C4 要求报告不在；「上游有标记」也单列一节，直接带标记的条目不重复列在里面。
- 找的结果里不含调用者自己的场景。`inspect` 一个条目时只看它自己和它直接依据的文件，不找已搬；已搬只在 `check` 和 `start` 里认。

存放，都在 `.pneuma-base/ledger/` 下：

| 目录 | 性质 | 内容 |
| --- | --- | --- |
| `facts/` | 本体 | 每次写入是一个名字唯一、写完不动的文件，先写临时名再改名 |
| `held/` | 本体 | 留存：被新的一版换下来的旧内容，等主人清 |

这一版不要求 agent 报告读了什么。agent 放东西时写明它依据了哪些，这就是来自。「读了」留给以后的钩子自动记。没有命令行的 agent 只管把文件放进库，它们落在「无主」，由别人补上来历；这一版不定手写记录的格式。

仓储四问：

| 问 | 答 |
| --- | --- |
| 写入 | 一次命令行调用写一个文件，几条到几十条事实；按事实的编号幂等 |
| 查询 | 每次调用读全部事实，在内存里归并成视图；这一版没有索引 |
| I/O | 同步读；写是临时文件加改名；并发的写者各写各的文件，不抢 |
| 容量 | 假设一年几千个场景、几万条事实。先坏的是「每次调用读全部事实」，届时加一个缓存目录，不改本体 |
