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
| 视图 | 管理界面的一页：一组带类型的块，由内核或插件给出。视图不是操作，不改东西，不发事件 |
| 块 | 视图的组成单位：分节、记录表、字段组、列表、时间线、文字、预览、动作、空状态。块上挂的动作是 agent 面的一个动词或一条主人面命令 |
| 认知段 | 一个插件拼进说明和技能的那一段话 |
| 本体、缓存 | 插件对自己名下每个目录的声明。本体跟着文件夹走；缓存不同步，删了能重建 |

## 3. 包和依赖方向

```
packages/cli ──▶ packages/viewer ──▶ packages/kernel ◀── packages/plugin-ledger
      │                                   ▲                      ▲
      ├───────────────────────────────────┘                      │
      └──────────────────── 内置插件表 ───────────────────────────┘
```

| 包 | 职责 | 不许 |
| --- | --- | --- |
| `packages/kernel` | 打开库、解析配置、识别行动者和会话、六个动词的管线、授权的门、事件、认知的拼装、技能的生成 | 依赖任何插件；认识任何插件的事实或目录 |
| `packages/plugin-ledger` | 记账与对账：事实、场景、条目、对账、来历、过期、变化 | 读写别的插件的目录；绕过内核的公开接口 |
| `packages/viewer` | 管理界面。`src/server/` 是只听本机的 HTTP 服务，用内核的三个面；`web/` 是网页，只渲染块。插件表由调用方传进 `startServer` | 导入任何插件包或命令行；网页导入内核的代码（只取类型） |
| `packages/cli` | 命令 `pneuma-base`：把命令行翻译成对内核的调用，把结果打印出来；内置插件表；`view` 把内置插件表交给界面的服务 | 含领域逻辑 |

插件只经 `packages/kernel` 导出的类型和上下文对象接触内核。插件之间不直接调用。内核不导入界面，界面不导入任何插件；lint 的导入规则守这三条，`packages/kernel/test/dependency-direction.test.ts` 在故意违反的例子上看它们变红。

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

type Context = { library: Library; actor: Actor; session: Session; now: Instant; home: string }   // home：本机的 $PNEUMA_BASE_HOME

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
  | { kind: 'register'; path: LibraryPath; origin: Origin }                 // 文件或目录已经在库里
  | { kind: 'place'; from: string | 'stdin'; to: LibraryPath; origin: Origin }   // 从库外的文件、目录或标准输入放进来
  | { kind: 'move'; from: LibraryPath; to: LibraryPath }                         // 在库里挪位置

type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint; copied: boolean
      notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle' }
```

内核自己能看到的是「东西」：一个普通文件，或一个带标记的目录（见下一小节「一个目录算一样东西」）。全化表里「同类」指和放进来的东西同一类：文件对文件，带标记的目录对带标记的目录；「另一类」是另一类的东西，或既不是文件也不是目录的东西。

| 请求 ＼ 目标 | 在库外或授权区域外 | 在带标记的目录里面 | 不存在 | 同类，内容相同 | 同类，内容不同 | 没标记的目录 | 另一类 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 登记 | 拒绝 | 拒绝 | 拒绝：没有这个文件 | 接受（登记的是目标本身的当前内容） | 不适用 | 写标记，它从此是一样东西，接受 | 拒绝：没有这个文件 |
| 放入文件或标准输入 | 拒绝 | 拒绝 | 复制，接受 | 不复制，接受 | 有插件留住旧内容：换上新的。没有：拒绝，目标不动 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 放入库外的目录 | 拒绝 | 拒绝 | 复制整棵树，写标记，接受 | 不复制，接受 | 有插件留住旧内容：整棵换掉。没有：拒绝，目标不动 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 挪 | 拒绝 | 拒绝 | 挪过去，整个目录一起，接受 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

接受之后，内核把请求交给每个插件的 `onPut`，把它们的答复收进 `notes`。

「有插件留住旧内容」的分工：内核问配置里每一个提供了 `revise` 的插件，按配置的次序，一个答了之后照样问下一个。插件把当前内容留到自己名下（`held`）或拒绝（`declined`）。至少一个答 `held`，内核就把新内容先写临时名再改名放到目标上，每个答 `held` 的插件附的那句话都收进 `notes`。一个都没答 `held`，内核拒绝这次放入，目标不动。出错的插件列进 `problems`，算没留住。这样不管插件写得对不对，目标上都不会出现半截内容。

实现里的细化（形状在 `packages/kernel/src/types.ts`）：

- 请求里的路径是调用方写的原样（相对库根，或库内的绝对路径），由内核在入口解析一次。「在库外」那一列就是解析不出库内路径的情形。`.pneuma-base/`、`PNEUMA-BASE.md` 和 `_archive/` 不算内容，放和挪到那里都按「在库外」拒绝；`_archive/` 只经归档和取回进出。
- 放入的来源是 `{ kind: 'file'; path } | { kind: 'directory'; path } | { kind: 'stdin'; content }`。来源是目录时，它要在库外，也不能包含这个库，否则以 `outside-library` 拒绝：复制它会把库复制进库里。
- 每个结果都带 `problems`，拒绝的结果也带，并带 `subject`：拒绝针对的那个输入。`inside-bundle` 的 `subject` 是那个带标记的目录。
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

### 找、看、说、查、归档

```ts
type FindRequest = { text: string | null; match: 'terms' | 'words'; filters: Record<string, string>; includeArchived: boolean; skipOwnSession: boolean }   // 开关默认关
type Hit = { path: LibraryPath | null; title: string; by: PluginName | 'kernel'; group: string | null; detail: string | null }
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

找的两种匹配：`terms` 把文字按空白和常见标点切开，名字里含任一段就算；`words` 用 `Intl.Segmenter` 取一句话里两个字以上的词和拉丁词（它会把「下单」这类两个字的词切成单字，所以相邻的两个单个汉字也连成一个词），按命中的不同词数排，至少命中一个，每个答复者最多给 5 条。`start` 用 `words`，`find` 用 `terms`。切词和排序是内核导出的 `searchTerms` 与 `rankHits`，插件用同一套。`filters` 是插件的用语，内核不懂，所以带了过滤时内核不按名字列文件。

`skipOwnSession` 让答复者不带调用者自己这次会话做的东西。`start` 打开它，因为它找的是库里本来就有的；`find` 不打开，什么都给。内核按名字列文件时分不出是哪次会话放的，不管这个开关。

`group` 是答复者给一条结果定的标题：`group` 相同的结果在文字答复里合在这个标题下，出现在其中排得最前的那条的位置，每条一行；没有路径的那条说的是这个标题本身，排在标题下第一行。内核按名字列出的结果 `group` 为 `null`。

`problems` 是失败语义的落点：某个插件出错时，动词照样给出答复，同时如实说明哪个插件没做成。「已放入，但没有记下」是和「已放入并记下」不同的结果，命令行以非零退出码区分。

归档是内核自己做的，不靠插件，所以空目录里也成立。归档区是库根下的 `_archive/`，里面保持原来的相对路径。全化表：

| 请求 ＼ 目标 | 不存在 | 在主区 | 已在归档区 |
| --- | --- | --- | --- |
| 归档 | 拒绝：没有这个文件 | 挪进归档区，接受。归档区里同一路径已有别的东西时，新来的名字后加指纹的前八位 | 接受，什么都不动 |
| 取回 | 拒绝 | 接受，什么都不动 | 原路径空着：挪回去，接受。原路径被占：拒绝 |

这里的「东西」是文件或带标记的目录，目录整个一起动。实现按四种状态判：两处都没有；只在主区；只在归档区（原路径空着）；两处都有（原路径被占）。两处都有时，归档按「在主区」办，取回按「原路径被占」拒绝。取回时原路径上的任何东西都算占着。路径在一个带标记的目录里面时，归档和取回都以 `inside-bundle` 拒绝。路径写成 `a.md` 或 `_archive/a.md` 都指同一样东西。接受的结果带 `moved`，什么都没动时为 `false`。

找和查默认跳过归档区，`includeArchived` 打开才带上。看一样已归档的东西照常给出，并标明它已归档。命令行里除了 `find` 和 `check`，库的目录树本身也把归档的东西隔开了，agent 用自己的工具翻目录时同样看不到它们混在里面。

命令行另有一个 `start "<一句话>"`，是「说：在做什么」「查」「找」三个动词的组合，不是第七个动词。

### 没有任何插件时的答复

| 动词 | 答复 |
| --- | --- |
| 放 | 按上面的全化表。接受时 `notes` 为空。放入遇到内容不同的同名文件：拒绝 |
| 找 | 按名字列出库里的文件和带标记的目录 |
| 看 | 这样东西本身的情况（文件或带标记的目录），`sections` 为空 |
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

  readonly views?: ViewDecl[]                           // 它给管理界面加的视图，编号以 `<插件名>.` 开头
  onView?(req: ViewRequest, ctx: Context): Promise<ViewAnswer>
  onItemView?(path: LibraryPath, ctx: Context): Promise<ItemSection | null>   // 「看」在界面上的对应物
}
```

一个只有名字、其余全空的对象是合法的插件。

视图槽（第 6 节「只读的一面」）：插件声明它的视图，每个视图返回带类型的块，界面只渲染块，不知道块来自哪个插件。编号不以插件名加点开头的视图不列出，记成问题。`onView` 或 `onItemView` 抛错、或答复的不是一个视图或一节，内核在那一页或那一节里给出说明出错的块，并把问题列进结果（K8）。视图不是操作：插件在这两个钩子里不写东西，内核也不为它们发事件。

实现里的细化：钩子收到的上下文另带 `dir`，即这个插件名下的目录，和 `cacheDir`，即这个插件在库外的缓存目录（见下面「库外的插件与缓存」）；钩子的答复不写插件名，由内核盖上（`PluginNote`、`PluginSection`、`PluginHit`）；`onSay` 答复 `SayAnswer`，处理它的插件出错时结果是 `not-heard`、`plugin-failed`。主人面命令 `OwnerCommand` 带 `destructive` 标志，由内核在同一处拦。插件名同时是目录名，用 `pluginName()` 解析。主人面的事件带 `destructive`，插件不用自己认哪些命令会丢数据；`archive purge` 的答复在 `data.paths` 里列出被删的库内路径，记账插件据此记「已除」。

### 库外的插件与缓存

- 插件表 = 命令行自带的插件 + 本机的 `$PNEUMA_BASE_HOME/plugins/<名字>/index.js`。`index.js` 是 ESM，缺省导出一个 `Plugin`，名字和目录名相同；它是普通的 JS 文件，运行时不必导入内核。自带插件的名字不会被本机的插件占用。加载在内核导出的 `loadPlugins(home, 自带的表)` 里，命令行每次调用用它建表，别的入口用同一个函数。
- 库的配置里只写名字。`plugin add <名字>` 从自带的和本机的里找。
- 本机的插件加载失败（导入时抛错、缺 `index.js`、缺省导出不是插件），它不进插件表。装了它的库照「装了但这台机器不认识」处理（K8）：每个答复的 `problems` 里有它，消息是加载失败的原因（`whyNotLoaded`）。`plugin add` 一个加载失败的插件以 `plugin-failed-to-load` 拒绝，并说明原因。
- 缓存目录：`PluginContext.cacheDir` 是 `$PNEUMA_BASE_HOME/cache/<库的 id>/<插件名>/`。放在库外，因为库会被同步工具整个同步，而索引这类文件经不起同步。插件第一次用时自己建，内核不建。删掉它什么都不丢。库的 id 因此只能是字母、数字、连字符和下划线。
- `Context` 带 `home`，即本机的 `$PNEUMA_BASE_HOME`，由建上下文的地方传进来；`cacheDir` 由它算出。

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

### 主人面的一个入口

主人面的命令都是数据：名字、一句说明、是否破坏性、`run`。内核自己的六条（`grant issue`、`grant revoke`、`plugin add`、`plugin remove`、`skill install`、`archive purge`）在 `owner-commands.ts`，和插件的 `OwnerCommand` 同形，只是 `run` 收到整个主人调用，并可交回重开的库。

- `ownerFace.commands(插件表)` 列出可用的命令：先内核的，后各插件的，按配置次序；名字已被占的不再列，插件盖不住内核的命令。
- `ownerFace.dispatch(主人调用, 命令名, 参数)` 是唯一的入口，命令行和界面的服务都走它。命令经同一道门（K7），在单一出口发事件（K5）。
- 没有这条命令：在任何操作开始前拒绝（`unknown-command`），不发事件。
- 参数不对：以 `usage` 拒绝，命令行把它当用法错误，退出码 1。表单里留空的可选值等于没给；`--read-only` 在表单里写成值 `yes` 或 `no`。

命令行只做两件事：认出命令名（字数最多的那条，内核命令的字数多过同名的动词时取内核命令，所以 `archive purge` 不是归档一个叫 purge 的文件），以及定库。`skill install` 的库由它的授权名经本机的授权副本定出，其余用 `@<授权名>` 或 `--library`。

### 只读的一面：视图

管理界面是内核的一个客户端：看用视图，改用 agent 面的动词和主人面的命令。视图不是操作，不改东西，不发事件；界面每两秒轮询一次，发事件只会是噪音。K5 说的是两个面的操作。

```ts
viewerFace.views(library): { views: ViewDecl[]; problems: PluginProblem[] }
viewerFace.show(req: ViewRequest, call: { ctx: Context; table: PluginTable }): Promise<ViewResult>
```

块、动作、视图的类型在 `types.ts` 的末尾，不含任何插件的类型（K3）。内核自己的视图也用块给出，界面不为它们写专门的页：

| 视图 | 在导航里 | 内容 |
| --- | --- | --- |
| `files` | 是 | 库的一个文件夹，参数 `dir`。先文件夹后文件；内核的文件和归档区不列。文件夹链到下一层，文件链到 `item` 面板 |
| `archive` | 是 | 归档区里的每个文件和它原来的路径，各带「取回」；整区一个「清空归档区」，先问 |
| `config` | 是 | 库的位置；装了的插件和可装的插件；授权，各带为 Claude 或 Codex 生成技能、撤回；发授权；Codex 要把库加进可写目录的提示 |
| `item` | 否 | 一样东西，参数 `path`，开在右侧面板：文件的事实、归档或取回、预览，再接每个插件的 `onItemView` 给的一节。路径上没有文件时说明文件不在，插件的节照常给。`_archive/…` 的东西被取回后，面板跟到它原来的路径 |

一样东西的详情是内核的视图，不是某个插件的：内核按配置次序把各插件用 `onItemView` 给的节拼在文件的事实和预览之后，节名由插件给，插件之间互不认识。记账插件的来历、以后版本插件的版本时间线、部署插件的开关都落在同一个面板里。

`viewerFace.views` 先列插件的视图，按配置次序，后列内核的。

动作的 `call` 里的字符串可以含 `{输入名}`，界面用输入的值替换。动作的 `confirm` 是一句问话，界面弹框问；人点了确认，就是内核要的当面确认。

### 界面的服务

- 只听 127.0.0.1。启动时造一个随机令牌，打印的地址带着它。`/api/*` 每次请求核令牌（查询参数 `token` 或头 `x-pneuma-token`）和 Host（`127.0.0.1:<端口>` 或 `localhost:<端口>`）；网页本身不核。
- `GET /api/state`：是不是库、库的位置、视图清单和问题、可用的插件。`GET /api/view?view=&<参数>`。`POST /api/call`：一个 `Call` 加 `confirmed`，答复是结果和一行给人看的话。`GET /api/file?path=`：内容区和归档区的文件原样给出；路径经内核解析，链接跟到底后还要在库里、不在内核的地方，否则 404；HTML 一律当文字给，带 `sandbox` 的 CSP，浏览器不会运行库里的文件。`GET /api/rev`：库里每个名字、大小、修改时间的摘要。`POST /api/init`：把目录建成库。
- 服务不持有状态，每次请求重新打开库。行动者是主人；会话按环境识别，同命令行。服务若跑在 agent 的会话里，破坏性命令照常被拒（K7）。

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
    tmp/                      内核写到一半的临时名
    <插件名>/                  每个插件名下的目录
  _archive/                   归档区，里面保持原来的相对路径
  <某个目录>/.pneuma-item      带这个标记的目录是一样东西
  ……                          其余都是内容，随便怎么放
```

本机还有一个目录，不是库的一部分，缺省是 `~/.pneuma-base`，可以用 `PNEUMA_BASE_HOME` 换：

```
$PNEUMA_BASE_HOME/
  grants/<名字>.json          发给 agent 的授权副本
  plugins/<名字>/index.js     主人自己的插件
  cache/<库的 id>/<插件名>/    插件的缓存，删了能重建
```

## 9. 内核的不变式

| 编号 | 性质 | 由什么守 |
| --- | --- | --- |
| K1 | agent 面的任何调用，不让库里已有的内容或已有的记录变得找不回 | 放和归档的全化表；`revise` 的契约；测试 |
| K2 | 没有任何插件时，六个动词都给出确定的答复，不报错 | 空配置的端到端测试 |
| K3 | 换插件不改变六个动词的请求和结果的形状 | 类型 |
| K4 | 内核不依赖任何插件；插件只经内核的公开接口接触内核 | 包的依赖；lint 的导入规则 |
| K5 | 两个面的每次操作都产生一个事件，发给所有插件。视图不是操作，不发事件 | 管线的单一出口；`ownerFace.dispatch` 是主人面的唯一入口；测试 |
| K6 | 说明里许诺的能力不超出已装插件提供的 | 拼装只从配置和插件的认知段取材；测试 |
| K7 | 破坏性的操作只在主人面，要人当面确认，在 agent 的会话里被拒绝 | 主人面命令的声明里带「破坏性」标志，由内核统一拦；测试 |
| K8 | 一个插件出错不让动词失败，也不被静默吞掉 | `problems`；测试 |
| K9 | 归档的东西不被删除；默认的找和查不带它，开关打开才带 | 归档的全化表；测试 |

## 10. 记账与对账插件

领域模型在 `MODEL.md`。它接上的槽：

| 槽 | 它做什么 |
| --- | --- |
| `onPut` | 记入册；内容变了的记改。带标记的目录入册时，事实带 `bundle: true` |
| `revise` | 把旧内容复制进留存，目录条目整棵复制；新的由内核放上去，`onPut` 收到的 `previous` 是被换下的指纹，记改 |
| `onFind` | 按场景、来历、记录里的文字找 |
| `onInspect` | 一样东西的来历、现状、它来自什么、什么来自它；一个场景的卡 |
| `onSay` | 听得懂：在做什么、决定、备注、来自、改了 |
| `onArchive` | 记下归档和取回；已归档的条目不出现在可能过期等清单里 |
| `onCheck` | 自某时以来的变化；来历不明的；可能过期的；来源不在的；挪过的（已接回，记一条看到的挪动）；不在了的 |
| `observe` | 把做成了的主人面操作记成事实；清归档时，被删的路径上的条目记为已除 |
| `views`、`onView` | 视图 `ledger.items`（条目）：每个没除掉的条目的路径、来历、谁、当时在做什么、现状（对账后的状态，依据上有标记时显示标记）、时间；过滤来历、现状、是否带归档的，默认不带；行链到内核的 `item` 面板 |
| `onItemView` | 条目详情里「来历」一节：怎么来的与出处、谁、何时、在哪、场景、当时在做、现状；依据（每个依据的现状，链到上游的 `item`）；被什么依据；决定与备注；版本；留存的旧版。数据就是 `inspect` 用的 `itemView`，没人登记过的文件说明来历不明 |

它给主人面加三条命令：`held list` 列出留存；`held restore <库内路径或条目号> [--fingerprint <指纹>] --to <库内路径>` 把一份留存复制到一个空着的新路径，目录条目整棵复制回去，并把它以「主人带进来的」入册；`held drop` 清掉全部留存，是破坏性的，由内核的门拦。

事实的种类、归并函数 `fold`、对账函数 `reconcile` 和输出的形状在 `packages/plugin-ledger/src/` 里，`fold` 和 `reconcile` 是纯函数。实现里和本程细化设计不同的几处：

- `item.enter` 和 `item.revise` 另带 `size`。对账找已搬的候选时先按大小筛，再取指纹；没有这个字段就没法筛。目录条目的 `size` 是它算进指纹的文件的字节数之和。
- 目录条目：`item.enter` 带 `bundle: true`。已经在册、路径在一个后来入册的目录条目下面的条目算「并入」了它，这是 `fold` 推出来的，没有新的事实种类。并入的条目跟着那个目录挪、归档、被清掉；它不报「不在」，不出现在 `find` 和 `check` 的清单里；看它时说明它并入了哪里。依据它的东西照样按它那个文件现在的内容判可能过期。目录里面从没入册的文件，看它时说明它是哪个目录条目的一部分。`say` 写的路径在一个带标记的目录里面时，说的是那个目录。
- 对账用内核的 `fingerprintOf`，文件和目录条目一样；快照列的是东西，目录条目不往里走。
- `inspect` 的版本列表里，「被换下，留存着」标在被留存的那一版上，按留存目录里的指纹认。
- 「一次命令行调用写一个文件」落成「每个钩子写一个文件」：`start` 里「说」和「查」各写一个，`put` 盖掉无主文件时 `revise` 写入册、`onPut` 写改。每个文件照样是新文件、写完不动。
- 发布事实文件用硬链接到最终名再删临时名，最终名已存在时失败重试，而不是覆盖。
- `check` 比设计多一节「不在了的」，验收 C4 要求报告不在；「上游有标记」也单列一节，直接带标记的条目不重复列在里面。
- `find` 什么都给，包括调用者自己这次会话的场景和条目；`start` 的找（`skipOwnSession`）不带调用者自己的场景和在其中放入的条目。找的结果按场景分组，`group` 是场景那一行。`inspect` 一个条目时只看它自己和它直接依据的文件，不找已搬；已搬只在 `check` 和 `start` 里认。
- 界面的两个视图在 `ui.ts`，是纯函数：条目表取自 `fold` 与 `reconcile`，详情取自 `itemView`，不另算一套来历；两者都不写事实，也不收养没人登记过的文件。
- 「自上次以来」只列改了内容或能力的事。不改两者的主人面操作（`init`、`grant issue`、`grant revoke`、`skill install`）照样记成事实，但不列出；名单是 `views.ts` 里的一个集合。
- 场景号在文字答复里只显示前 8 位（临时场景 `adhoc-…` 显示全），工作目录把家目录写成 `~`、过长时只留最后 45 个字符；`--json` 给全的。`inspect` 和 `find --scene` 接受场景号的前缀，至少 6 个字符；`inspect` 遇到几个场景共用的前缀，列出它们的全号。

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

## 11. 版本插件

`packages/plugin-version`。声明了「有版本」的东西，每一版的内容都留着，任何一版能导出到库外或放回来。声明是 agent 的 `say`：`say versioned <路径> [一句话]` 声明并把当前内容记成第 1 版；`say version <路径> <一句话>` 给当前这一版写说明。路径在带标记的目录里面时，说的是那个目录。

| 槽 | 它做什么 |
| --- | --- |
| `onPut` | 放入之后，声明过的东西内容和最近一版不同就记新的一版，答复里说是第几版；挪动跟着改路径 |
| `revise` | 只对声明过的路径答「留住了」，而且要当前内容已经是最近一版；不是就先把它记成一版（标明在工具之外改的）。没声明过的答「不留」 |
| `onArchive` | 归档和取回跟着改路径 |
| `onCheck` | 声明过的东西在工具之外被改了，把现在的内容记成新的一版并报告一次；路径上没东西了，每次都报告 |
| `onInspect` | 版本的时间线：第几版、何时、谁、说明、怎么来的、指纹，最新的在前，最多 10 版 |
| `observe` | 清归档区删掉的东西记为「不在库里了」，它的各版内容照样留着 |
| `onView`、`onItemView` | 页 `version.things`：每样有版本的东西一行，版数、最近一版、状态；条目面板：时间线，带「导出到库外」和「放回这一版」 |

主人面的命令：`version list <路径>`；`version export <路径> --version <n> --to <库外的目录或文件>`，`--to` 是已有的目录时导出到它下面的同名处，目标在库里或已有东西都拒绝；`version restore <路径> --version <n>`；`version prune <路径> --keep <n>`。只有 `prune` 是破坏性的：导出写在库外，放回时当前内容先已是一版。agent 能用前三条。

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

## 同步插件

`packages/plugin-sync`。库和一个同步目标双向同步：只整份地复制文件，不合并内容；同步前任何一边有过的每一份内容，同步后都还在两边的某处。只有手动的 `sync now`，没有后台进程。

| 槽 | 它做什么 |
| --- | --- |
| 主人面命令 | `sync target set --kind dir --to <目录>`、`sync now`、`sync status`，都不是破坏性的，agent 也能跑 |
| `onCheck` | 「同步冲突」：还在的冲突副本（归档区里的不算） |
| `views` / `onView` | `sync.status`：目标、这台机器上次同步、待同步的数目（按一次空跑算）、冲突副本各带「归档」，按钮「现在同步」「设同步目标」 |
| `onItemView` | 冲突副本：它是哪个文件的另一份，带「归档」；有冲突副本的文件或目录条目：列出它们。别的东西没有这一节 |

它不听任何 `say` 种类，也不接 `observe`：挪和归档是按内容认出来的。

**规则。** 每个路径按本地、目标、基线三处的指纹（不在为空）由纯函数 `decide` 定成不动、推、拉、冲突、删五种之一，就是设计里那张表的全化：没有基线（第一次同步，或基线丢了）时，只在一边的复制过去，两边相同的不动，两边不同的算冲突。然后 `plan` 算出同步完两边应有的文件，再补一遍：同步前任何一边有、而同步完哪里都没有的内容，冲突时目标那份拉成 `<名字>.conflict-<机器>-<时刻><扩展名>`；内容区以外（归档区、`.pneuma-base/`）被另一边删掉的，原样放回；其余的复制进 `_archive/<路径>`，名字被占时加指纹的前八位。所以设计表里「同样的内容别处还有（是挪）就删，否则进 `_archive/`」也管到了推和拉换下的旧内容：同一个路径上被换掉的内容，要是别处（比如记账插件的留存）没有副本，也进 `_archive/`。冲突时本地的那份留在原处，并在同一次同步里推上去，两边一次就一致。

**执行。** 步骤的次序是先留存、再复制、最后删除。每一步动手前核对文件还是计划看到的那份，不是就跳过，留到下次。写一律先写临时名再改名。目标出错时停下，以 `target-failed` 拒绝，做完的步骤记进基线，重跑从现状重新算。

**范围。** 整个库文件夹，含 `.pneuma-base/` 里各插件的记录，逐个文件，目录条目连标记一起。不含：`.pneuma-base/config.json` 和 `PNEUMA-BASE.md`（每台机器的配置：授权、插件表和给缓存目录作键的库标识，说明由它拼出）；`.pneuma-base/tmp/`；已装插件声明为缓存的目录；任何一层的 `.git`、`node_modules`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`、`.tmp-*`；目标里的 `.pneuma-sync/`。

存放：

| 位置 | 性质 | 内容 |
| --- | --- | --- |
| `.pneuma-base/sync/facts/` | 本体，同步 | 每个事实一个名字唯一、写完不动的文件：`target.set`（哪台机器、目标）与 `run`（计数、冲突、留下的、成败） |
| `.pneuma-base/sync/tmp/` | 缓存 | 写到一半的临时名 |
| `<缓存目录>/baseline.json` | 本机，不同步 | 这台机器上次同步完两边的清单，带目标的标识 |
| `<目标>/.pneuma-sync/id` | 目标里，不同步 | 目标的标识。目标是新的或被清空时没有它，基线就不适用，当第一次同步 |

**目标。** 接口是 `list`、`read`、`write`、`remove`，库自己也按这个接口当另一边。自带的只有 `dir`。目标按机器记：用这台机器最后设的；这台机器没设过，用任何机器最后设的。目录在这台机器上不存在时，`sync now` 以 `target-missing` 拒绝，什么都不动（不替它建目录：没挂上的盘会被当成一个空目标），`sync status` 和视图都说明它是哪台机器设的。目标和库互相包含时以 `target-overlaps` 拒绝。

**一次同步自己的记录也在这次同步里。** `run` 事实写好后马上推到目标并记进基线，所以一次什么都没变的同步不会留下待同步的东西。记账插件在命令之后记下的那条主人面操作，下一次同步带走。

和设计不同的几处：推和拉换下的内容也按「别处没有就进 `_archive/`」留存，因为不这样做，同步前有过的内容会在两边都没有；配置文件和说明不同步；`.git` 和 `node_modules` 不同步；多了目标的标识；目标按机器记。主人清空归档区或清掉留存这类破坏性操作不会经同步传到另一边：另一边还有的内容会被放回来。

## 11. 部署插件

包 `packages/plugin-deploy`，名字 `deploy`。agent 用 `say deployable <库内路径> [一句话]` 声明一样东西（文件或带标记的目录）可以部署，声明不让它上线；主人用开关决定它在不在线；开着的东西，目标上跟着库里当前的内容。状态表、决定表和站点名的规则在包里的 `README.md`。

它接上的槽：

| 槽 | 它做什么 |
| --- | --- |
| `onSay` | 听得懂 `deployable`：路径要是库里在主区的东西，带标记的目录里面的路径算那个目录 |
| `onPut` | 放入了新内容、登记了在工具外改过的内容、挪了位置：对那样东西对一遍，答复里说重新发布了什么；目标失败时抛错，内核把它列进 `problems`，放照样成功（K8） |
| `onArchive` | 归档的东西下线；取回的按开关重新上线 |
| `onInspect` | 状态、地址、开关、站点名 |
| `onCheck` | 「线上和库里不一致」：待发布、待下线、开着但路径上没有东西的。已归档但目标上还有的也列，因为它还对外可见 |
| `observe` | `archive purge` 清掉的声明：先把目标上剩下的撤下，再去掉声明 |
| `views` / `onView` / `onItemView` | 页 `deploy.sites`：目标和配目标的动作；可部署的东西一张表，路径、状态、地址、每行一个开关，「对一遍」。条目面板里的「部署」节：状态、开关、地址、站点名、开关按钮 |

一个决定：目标上该有什么，只看开关、是否在归档区、路径上有没有东西（`model.ts` 的 `want`）。对账（`plan`）拿它和记录里这个目标上有的比，先发布再撤下旧名，两边一样就什么都不做。开关、放、挪、归档、取回、`deploy sync` 都跑同一个对账，所以 `deploy sync` 跑几遍结果一样。

主人面命令，都不是破坏性的：`deploy on <路径>`、`deploy off <路径>`、`deploy target set --kind dir --to <目录>` 或 `--kind command --publish "<命令>" --unpublish "<命令>" [--url <模板>] [--timeout <秒>]`、`deploy sync`、`deploy list`。对外发布是对外的动作，所以前三条只给主人：内核的门只拦破坏性的命令，插件在这三条里自己看上下文，行动者是 agent、或会话来自环境变量时以 `agent-session` 拒绝。`deploy sync` 和 `deploy list` agent 也能用，它们只照主人的开关办。开关在目标失败时照样记下，答复以 `publish-failed` / `unpublish-failed` 或 `no-target` 拒绝并说明现在的状态。

目标是一个接口：`publish(站点名, 内容目录) → { url }`、`unpublish(站点名)`。发布前把算进指纹的文件复制到缓存目录下的临时目录（不带标记），核对指纹，再交给目标。`dir` 目标写 `<目录>/<站点名>/…` 和 `index.json`，先写 `.tmp-` 开头的名字再换上，目录不能在库里或包含库；`command` 目标把主人的命令按 shell 的引号规则切成参数、不经 shell 运行，工作目录是库根，超时缺省 120 秒。

存放，都在 `.pneuma-base/deploy/` 下，本体：`config.json` 是目标，先写临时名再改名；`facts/` 每次写入一个名字唯一、写完不动的 jsonl 文件：声明、开关、挪、去掉、发布、下线。「目标上有什么」来自对当前目标（按目标的标识区分）的发布与下线记录；换了目标，开着的东西都成待发布，旧目标上的不撤。缓存目录里只有发布时的临时目录。

实现里和本程细化设计不同的几处：

- 跟着挪和归档用的是 `onPut`、`onArchive`，不是 `observe`：这两个槽收到的是内核解析过的路径（`observe` 里挪的来源只有调用方写的原样），答复能告诉 agent 重新发布了什么。`observe` 只用来接 `archive purge`。
- 状态比设计多两种：待下线（不该在线、目标上还有，上次下线失败）和不在（开着、路径上没有东西）。
- 目标的配置是 `config.json`，会被 `deploy target set` 换掉；它是配置，不是记录。

## 11. 查找插件

`packages/plugin-search`。装上它，`find` 也匹配文本文件的正文，按相关度排；主人配了嵌入器时也按意思找。它不听任何 `say` 的种类。

| 槽 | 它做什么 |
| --- | --- |
| `onFind` | 先把索引补到最新，再按词（FTS5 的 bm25）和按意思（余弦，最多 5 样，不到最近那样一半近的不要）各排一次，用倒数排名融合（k = 60）成一个次序。按词的命中细节是「正文：」加一段上下文，按意思的是「按意思：」加那一块的第一行。目录条目里的文件命中时，路径是那个目录，细节以里面的文件名开头。归档的东西只在 `includeArchived` 时给；带过滤的请求不答，过滤是别的插件的用语。`find` 最多 20 条，多出的用一条没有路径的命中说还有几样；`start` 照内核的规矩最多 5 条 |
| `onView` | `search.status`：文件数、块数、待更新数、建于何时、缓存位置；嵌入器和有向量的块数；按钮「重建索引」「设嵌入器」「清除嵌入器」 |
| `onItemView` | 这样东西的正文索引了没有、几块、几块有向量 |

主人面的命令都不是破坏性的：`search embedder set --kind hash`，或 `--kind http --url <地址> --model <模型名> [--key-env <存密钥的环境变量名>]`，设好后试嵌入一次并说出结果；`search embedder clear`；`search rebuild`，删掉索引从文件重建，向量没建完时以 `embedder-failed` 拒绝，并说明全文部分已重建；`search status`。

| 存放 | 性质 | 内容 |
| --- | --- | --- |
| `.pneuma-base/search/embedder/` | 本体 | 主人选的嵌入器。每次改写一个名字唯一、写完不动的 JSON，名字最大的一份算数。只写密钥所在环境变量的名字 |
| `$PNEUMA_BASE_HOME/cache/<库的 id>/search/index.sqlite` | 缓存 | 索引。删了下次 `find` 重建，答复不变 |

索引的四张表：`docs` 是每个文件（是不是文本都记）的库内路径、目录里的内部路径、大小和修改时刻；`chunks` 是文本按段落切成的约 800 字的块；`fts` 是每块的词；`vectors` 按嵌入器和块内容的 sha256 存，挪动或复制的块不再嵌入，换了嵌入器旧向量就删掉。

- 新鲜度是一个纯函数 `freshness`：比对盘上和索引里每个文件的路径、内部路径、大小和修改时刻，只重读变了的，忘掉不在的。挪动和归档就是路径变了，不靠事件。
- 文本是合法的 UTF-8、不含 NUL 的文件，只读前 1 MB，读不全的命中写明「只索引了前 1 MB」。网页（`.html`、`.htm`）只取读者看得到的字。
- 入索引和查询都用内核的 `searchTerms(…, 'words')`。正文先按句切开再交给它，一个词出现在几句里就算几次。
- 嵌入器的接口是 `embed(文本[]) → 单位向量[]`。`hash` 是词和字对的特征哈希，256 维，不带符号位：维数这么少，符号相反的碰撞会抵消共有的特征。`http` 是 OpenAI 兼容的 `/v1/embeddings`，超时 30 秒，地址结尾的 `/v1` 可写可不写。嵌入失败不让 `find` 失败：按词的命中照给，失败进 `problems`。
- 几个 `find` 同时补索引：读文件在事务外，写是按文件的整份替换，跑两次结果一样；排名和取块在同一个读事务里。缓存里的文件不是 sqlite 或是别的版本的，就重建；被锁时等，不重建。

内核为它改了找（§4）的两处：

- `onFind` 可以答 `{ hits, problems }`，给出命中的同时说明没做成的部分（K8）。
- 内核按名字找到、插件也找到的同一路径只给一条：用第一个插件的那条，在它的位置，内核的标记（目录、已归档）放在它的细节前面。两个插件命中同一路径照旧各给一条。
