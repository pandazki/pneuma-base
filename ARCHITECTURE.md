# Pneuma Base 架构

这份文档写 Pneuma Base 是怎样建起来的、为什么这样建。它是项目的正式约束：要改这里写的边界或不变式，先改这份文档。

- 产品定义和主人定过的事在 `CONTEXT.md`。
- 存储的契约在 `STORAGE.md`，存储提供者怎么登记、安装、运行在 `PROVIDERS.md`，本机文件夹这个实现的线上形式在 `core/README.md`。
- 插件规范在 `PLUGINS.md`，Mac 应用在 `app/README.md`。
- 这里写的类型是签名层面的。代码里的形状在 `packages/sdk/src/types.ts` 和 `packages/sdk/src/storage.ts`，实现可以细化，不能改变形状表达的约束。

## 1. 问题和前提

Pneuma Base 是一个人和自己的 agent 共用的资料库。带进来的资料和做出来的东西都放在库里，每样东西回得到它出现的那次会话，叫**场景**。主人用界面，agent 用命令行或 MCP。除了管理归主人，两边的本事一样。

**前提**：库的文件夹里可以有任意多的噪音（依赖目录、缓存、版本库的内部），人和 agent 在意的东西相对很少。所以一切代价跟着在意的那部分走，不跟着文件夹走。

由这个前提定下三条：

1. **账说库里有什么。** 存储只在账、事件或人指到的那一点上被查看。磁盘上有什么不是「库里有什么」的依据。
2. **不随便全量。** 没有人声明过的扫描一次都不做。读或写整个库、整个目录的一趟是**有名字的全量动作**：先说范围，边做边报进度，可以停下。别的动作不会顺带触发它。
3. **登记不超过一级。** 文件只看一眼存储已经知道的元数据，目录只取它的一层、最多 200 条。内容只在需要时读。

一个装好依赖、八万多个文件、其中只登记了一篇笔记的库上，agent 的一次 `start` 和空库一样快，输出不到 2 KB（第 13 节）。

另外两条贯穿全文：

- **底线**：破坏性的改动不能由 agent 造成，无论有意还是无意。主人做什么都可以。主人和 agent 的每次操作都留下痕迹，让对方感知得到。
- **库只做确定性的事。** 存东西、记谁做了什么、发现原始资料变了、按名字和文字查找、管版本和授权，库做；摘要、分类、判断什么值得留，库不做，留给人或 agent。一个没装任何插件的库里，每个动词照样给出确定的答复（第 6 节「没有任何插件时的答复」）。

## 2. 六层

每层只认识它下面那一层，经那一层写成文的契约。

| 层 | 是什么 | 今天在哪 | 不许有 |
| --- | --- | --- | --- |
| 0 格式 | 库在一种存储上的落盘形式：记录区、缓存区、库根的声明和说明里各有什么，什么同步、什么不同步（第 11 节） | 库的文件夹 | 行为 |
| 1 存储 | 存储抽象的一个实现，唯一看库的文件夹的东西 | Rust：`core/`，程序 `pneuma-base-core` | 给人看的话、身份、授权、动词、插件机制、任何插件自己的含义 |
| 2 内核 | 领域：动词和命令表、主人和 agent 的门、授权、请求、配对、说明的生成、插件机制 | TypeScript：`packages/kernel`、`packages/sdk` | 自己读文件夹或记录区；第 1 层任何东西的第二份实现 |
| 3 插件 | 经内核的插槽加进来的含义：账、版本、同步、部署、查找、第三方的 | `packages/plugin-*`；库外的装在 `$PNEUMA_BASE_HOME/plugins/` | 知道存储的实现存在：只用内核递给它的工具 |
| 4 面 | 进来的路：命令行（基准）、页面、MCP、本机的 endpoint，都由命令表生成 | `packages/cli`、`packages/viewer` | 自己的能力 |
| 5 壳 | Mac 应用：窗口、托盘、拖放、监看、这台机器的设置 | Swift：`app/` | 库的状态；不经过面的改动 |

底层用 Rust 追求速度，上面各层可以是任何技术：今天第 2 到 4 层是 TypeScript，运行在 Node 上，第 5 层是 Swift。插件机制在第 2 层，不在存储里。

只有两处跨层，都写明了理由：

- 壳直接用存储的只读操作（常驻模式和订阅变化，`glance`、`declaration.read`），因为它们不改任何东西；它不另外直接读库的文件夹。壳要改库时，经命令行。
- 内核把插件对它自己记录处的操作原样递给存储，不理解其中的含义。对存储来说，记录处只是一个名字。

### 包和依赖方向

```
packages/cli ──▶ packages/viewer ──▶ packages/kernel ◀── packages/plugin-ledger
      │                                   ▲  │       ◀── packages/plugin-version
      ├───────────────────────────────────┘  │       ◀── packages/plugin-sync
      │                                      ▼       ◀── packages/plugin-search
      │                               packages/sdk ◀──── packages/plugin-deploy
      │                                      ▲
      │                                      └────────── 库外的插件（只依赖 sdk）
      └──────── 内置插件表：五个插件包 ──────────────────────────┘

packages/kernel/src/storage.ts ──起──▶ 存储提供者的程序（core/ 的 pneuma-base-core 或装上来的）
```

| 包 | 职责 | 不许 |
| --- | --- | --- |
| `core/` | 存储：cargo 工作区。`storage` 是抽象（`Storage` trait，不认识文件系统），`local` 是本机文件夹的实现，`cli` 是程序 `pneuma-base-core`，`contract` 是契约测试的程序 `pneuma-base-contract`，`bench` 是量存储指标的 `pneuma-base-bench` | 懂事实和行的意思；答复里写给人看的句子；跟着库里的链接走；报告或进入噪音 |
| `packages/sdk` | 插件契约 `@pneuma-base/sdk`：全部类型、契约版本 `CONTRACT`（2）、`definePlugin`、`defineCommand`、生成用法和表单的 `usageOf`、`formOf`、分页的 `paging.ts`、图标名、版本号 `PNEUMA_BASE_VERSION`。另三个入口：`/kit` 是插件打进自己包里的库（记录库、配置文件助手、部署库），`/testkit` 是测试工具和符合性检查，`/frame` 是插件自己画的页的类型 | 导入内核、命令行、界面或任何插件；含内核的逻辑 |
| `packages/kernel` | 领域（第 4、5 节）。存储唯一的门是 `src/storage.ts`。依赖 sdk 并原样再导出它 | 依赖 sdk 以外的包；认识任何插件的事实或目录；不经门读写库的文件夹或记录区 |
| `packages/plugin-*` | 自带的五个插件（第 8 节）。部署插件只依赖 sdk，其余四个从内核导入（内核再导出 sdk） | 导入别的插件；读写别的插件的记录处；绕过上下文的 `tools` |
| `packages/viewer` | 管理界面：`src/server/` 是只听本机的 HTTP 服务，也是给 agent 的 endpoint；`web/` 是网页，只渲染块（第 9 节） | 导入任何插件或命令行；网页导入内核的代码（只取类型） |
| `packages/cli` | 命令 `pneuma-base`：动词的参数表 `src/verbs.ts`、内置插件表 `src/plugins.ts`、把一页印成字的 `src/page.ts`、MCP 服务 `src/mcp/`、插件项目的模板 `templates/` | 含领域逻辑 |

插件只经契约的类型和上下文对象接触内核，运行时要用内核的工具就用上下文的 `tools`。插件之间不互相导入、不直接调用。内核不导入界面，界面不导入任何插件，sdk 不导入内核、命令行、界面和任何插件。lint 的导入规则守这几条（`eslint.config.js`），`packages/kernel/test/dependency-direction.test.ts` 在故意违反的例子上看它们变红。存储的门由另一组 lint 规则守着（第 12 节 K10）。

运行时是 Node（22.18 以上），包管理用 pnpm 的工作区，测试用 vitest 和 Playwright。`pnpm build` 先用 `cargo build --release` 构建 `core/`，再编译各包、构建网页。CI 的 `ci.yml` 为此装 Rust 工具链；`core.yml` 在 `core/` 变了时跑它的格式检查、clippy 和测试。

## 3. 存储

领域概念建在一个存储抽象上。抽象归领域所有，不归哪个实现所有，全文在 `STORAGE.md`：它的词（位置、一层、状态令牌、面、内容、游标、记录处、事实、行、噪音），任何实现都要守的十条规则，每个操作问的是什么、代价的上界，和每个操作在对象存储上对应的能力。契约里出现这之外的词，就是领域概念漏了下去。这里只写内核怎样用它。

**存储提供者。** 存储抽象的一个实现叫存储提供者：任何讲 `STORAGE.md`、答得出 `describe` 的可执行程序都是。库的地址有写法（这台机器上的一个文件夹，或 `<scheme>://…`），每种写法由装在这台机器上的一个提供者来答。安装包自带本机文件夹的提供者 `local-folder`，就是 `core/` 构建出的 `pneuma-base-core`。别的提供者从 GitHub 仓库的发布装上来，对过校验和、跑过契约测试才能用；一个库用的是哪个，记在这台机器上。这些都在 `PROVIDERS.md`。提供者是第 1 层自己的扩展点，不是第 3 层的插件机制：插件站在内核上，内核站在存储上。

**门。** 内核通往存储只有一扇门，`packages/kernel/src/storage.ts`。它为每个库、每个进程起一个提供者的常驻进程（`serve --root <地址>`），一次收发一行 JSON，只在有请求等着时让这个进程开着；线上的形式在 `core/README.md`。起哪个程序由 `providers.ts` 定：这台机器记给这个库的提供者；没有记录时，答这个地址写法的那一个，自带的优先。自带的程序按这个次序找：环境变量 `PNEUMA_BASE_CORE`，内核包的 `bin/`（包文件把它带在那里），仓库里的 `core/target/release` 和 `core/target/debug`。内核的动词、页、请求、声明和说明，插件经 `tools.storage` 做的一切，都经这扇门。

**令牌是不透明的。** 内核和插件只存着令牌、交回去，从不解读。比较由存储做：`look` 拿预期的令牌比，每次写带着预期。令牌是几个来源的分量拼成的组合键，本机文件夹的分量是大小、修改时刻、改变时刻和 inode（`STORAGE.md` 第 3 节、第 7 节）。

**面（facet）。** 一个位置上可以并排有几组元数据，每组来自一个了解它的来源，叫一个面：本机文件夹给 `fs`、`macos`（下载来源、带进来的程序、标签）和 `placeholder`（同步服务只在本机留了占位）。内核的逻辑只依赖中性的部分（种类、令牌、大小、修改时刻）；面用来显示，给认识它的插件读。同步服务只留了占位的文件，取元数据和列一层都不触发下载。

**进度。** 存储读或写一个目录（`content`、`write`、`remove`）时，在答复之前发进度行 `{ id, progress: { files, bytes, total_files, total_bytes } }`。门把它交给那个请求的听者，不上线；插件经 `tools.storage` 读写目录时，内核把它接在全量动作的进度后面（第 5 节「上下文里的工具」）。

**平台。** 这一版的产品只有 Apple 芯片的 Mac：系统变更日志、`macos` 面、性能指标都只对它负责。存储的程序在 Linux 上能编、能过契约测试，那里没有可靠的游标，`changed` 和 `subscribe` 总答 `cannot_say`。

## 4. 领域怎样建在存储上

### 领域概念在存储上靠什么

| 领域概念 | 在存储上靠什么 |
| --- | --- |
| 库 | 一个存储：放东西的地方、放记录的地方、根上的声明 |
| 条目（一样东西） | 一个位置和它的令牌。文件靠看一眼，目录靠一览 |
| 来历、依据、可能过期 | 存储里没有。领域从记录和令牌的比较里推出 |
| 场景、记录、线索 | 记录处里的事实，和由事实推出的行 |
| 区域 | 位置的一个前缀 |
| 归档 | 一次带预期的移动 |
| 请求、配对、版本、可部署 | 内核或插件的记录 |

**记录处**是放记录的地方里的一个命名空间：只追加的**事实**，由事实推出、可以整个丢掉重建的**行**，和事实以外的**自己的地方**（放留存、版本这类内容）。内核有两个记录处，`requests`（第 5 节「请主人做」）和 `kernel`（第 5 节「补上」）；每个插件一个，名字就是插件名。

### 目录的三种

每个目录是哪一种由记录推出，不存在任何地方（`packages/kernel/src/places.ts`，代码里叫 `open`、`thing`、`closed`）：

- **展开的目录**：它里面或更深处有登记过的东西。库根总是。只看它自己这一层。
- **带标记的目录**：整个目录登记成一样东西（下面「一个目录算一样东西」）。
- **没登记的目录**：以上都不是。它是上一层里的一个条目，不往里走。名字是噪音的，提都不提。

插件用 `openDirs` 说它的记录让哪些目录展开，内核再加上库根。没有一个插件有 `openDirs`（没有插件记登记）时，文件夹都只是文件夹，没有这三种。内核和插件只在这三种说到的地方问存储：展开的目录列一层；没登记的目录只做一次带预算的探查，不进去，除非主人用有名字的全量动作明说（`ledger register <目录> --inside`）。

### 认识一样东西的三个深度

| 深度 | 做什么 | 存储的操作 |
| --- | --- | --- |
| 看一眼 | 只取存储已经知道的：种类、令牌、大小、修改时刻、面 | `glance` |
| 一览 | 目录的一层，最多 200 条；多的记「至少还有 M 条」 | `overview` |
| 内容 | 读字节，算指纹 | `content`，或 `write` 复制的同一趟 |

登记停在第一个深度：登记一个文件只看一眼，登记一个目录只看一眼它和它的标记，再取一览。所以一样东西靠**令牌**认：令牌没变就是没变。**指纹**（内容的 sha256）可以没有，只在这几种时候读：

- 内容本来就经过内核：从库外复制放入，同一趟算出。
- 要判一处差别：放到一个大小相同的文件上；归档区的那个位置已被占着。
- 有人要：`inspect --content`，插件的 `tools.storage.content`。
- 有名字的全量动作：`check --deep`。

一样东西此刻的样子是存储的描述（`ThingNow`：令牌、种类、修改时刻、文件的大小）。带标记的目录另有它的第一层（`Level`：前 200 项和「至少还有几项」）。目录的字节数和文件数只在它被复制进来时知道，别的时候是 `null`：数它们要走整棵树。

### 一个目录算一样东西

- **标记。** 目录里有一个 `.pneuma-item` 文件（JSON，`{"format":1}`）的，是一样东西，叫**带标记的目录**，代码里叫 bundle。没有标记的目录只是文件夹。库内路径是目录的路径，不带斜杠。写标记的只有内核（`things.ts`，插件经 `tools.markBundle`）。
- **认。** 一个位置上是什么，内核只看一眼那个位置和它的标记该在的位置（`things.ts` 的 `whatIs`，插件的 `tools.what`）：文件、带标记的目录、文件夹、别的（链接、设备）或没有。一个路径在哪个带标记的目录里面，也只看一眼它上面每一级的标记。都不走目录。
- **内容规则**（`THING_RULE`）：带标记的目录的内容是它下面的每个普通文件，除去噪音（任何一层）、标记文件，和它里面的 `.gitignore` 排除的（每一层的都读，最近的说了算）。链接和设备不是内容，空目录不算。规则由内核给，存储照做。内容超过 5000 个文件的目录不复制进来（`too-many`）。
- **指纹。** 把每个算进的文件写成 `<相对路径>\0<内容的 sha256>\n`，按相对路径的 UTF-8 字节排好，连起来取 sha256。由存储算（`content`，或 `write` 复制的同一趟）。
- **令牌和深令牌。** 目录自己的令牌只说它这一层：这一层多了、少了或改了名的条目，令牌就变；里面的文件改了内容不算。同步、留一版、部署要的是「里面哪个文件都没变」，所以它们在做事的那一刻深看：`look` 带 `deep` 时，存储照内容规则走遍这个目录，取每个算进的文件的状态，不读内容，算出一个**深令牌**；深令牌只和深令牌比，超过 5000 个文件答 `too_many`（`tools.ts` 的 `DEEP`）。代价随目录里的文件数，5000 个文件约 10 毫秒（`core/bench`）。`check` 和 `start` 不深看：深处的改动靠变化日志（下面「变化由谁来学」）。
- **整体地变。** 存储先把整份写进它的临时区，同一趟算指纹，再一次改名或原子交换放到目标上；预期不成立就什么都不改。中途出错或被杀，目标上要么是原来的，要么是新的，不留半棵树。带标记的目录里面的路径不是 agent 面写的目标：放、挪、登记、归档到它里面都以 `inside-bundle` 拒绝。要改它，把整个目录重新放进来。挪、归档、取回整个目录一起动。
- **链接不是东西。** 存储把链接本身答成 `other`，链接下面的位置答 `outside`，从不跟着链接走。所以路径本身是链接时，内核当那里有「另一类」的东西：登记、挪、归档、看都不认它，往它上面放以 `would-overwrite` 拒绝。路径上有一段是链接时，那里在库外，往那里放以 `outside-library` 拒绝。解析调用方写的绝对路径时，只解析通到库根的那一段链接（`paths.ts` 的 `parseLibraryPath`）。

### 没经过库的改动

记录说应该是什么，存储说现在是什么，两者之差就是没经过库的改动：

- 令牌对不上，是**被直接改过的**。只在记录有指纹时才读一次内容判：内容一样只是碰过，新令牌记成基线；不一样才是改过。
- 存储报了记录里没有的位置，是**没人登记过的**。文件和目录都一样；目录是一个条目，不往里走。
- 记录里有、存储说没有了，是**不在了的**。

这个定义在任何存储上都一样，发现也只落在登记过的东西和展开的目录那一层上。来历不明是一种正常状态：库把它显示出来，由人或 agent 补上。记账插件做这件事（第 8 节「记账与对账」）；Mac 应用把主人直接拷进来的文件按「看到的」登记（第 10 节）。

### 噪音

噪音是从来不是成果的名字和路径：依赖目录、缓存、版本库的内部。它们写在库根的 `.pneuma-base/noise.json` 里：名字（任何一层叫这个名字的都算），和库内路径（它和它下面的一切）。存储从不报告、不进入噪音：列一层时不列，数的时候不进去，对噪音位置的操作答 `noise`。`init` 经存储写下缺省的名单（26 个名字，`.git`、`node_modules`、`.DS_Store` 这类，见 `core/README.md`）；没有这个文件的库按缺省的名单算。

内核的三条命令在 `noise-commands.ts`：`noise list` 列出，agent 也能跑；`noise add <库内路径>` 或 `noise add --name <名字>`，和同样写法的 `noise remove`，只给主人。主人对一个没登记的目录答「不用管」，就是把它加进噪音。

### 变化由谁来学

存储能回放系统的变更日志，但回放要读这个卷上的每个事件（至少 13 毫秒），代价跟着整个卷走。所以分两条路：

- **常驻的进程去听。** 界面的服务第一次为一个库答请求时订阅它的变化（存储的 `subscribe`），关掉时退订；Mac 应用的监看也订阅（第 10 节）。订阅开始时从游标回放一次，补上没人在听的那一段，之后是实时的。存储把听到的记进缓存区里一份有界的小日志（最多一万个位置），有进程在听时，任何进程的 `changed` 都从这份日志答，代价只跟变了的东西走。
- **一次性的命令不回放。** `start`、`check` 这类命令问「自上次的游标以来变了什么」时带 5 毫秒的预算（`changes.ts` 的 `CHANGED_BUDGET`）。有进程在听就从日志答；没有，存储立刻答说不出，读的一方就让存储拿它记过的令牌比（`lookRows`，在存储里一页一万行，只把不同的交回来）。一次答出超过一万个位置也算说不出。

两条路答的是同一个问题，结果一样，只是代价不同（`packages/cli/test/listener.test.ts`）。没有哪条路会遍历。

听到的位置可以在任意深处，而带标记的目录自己的令牌和它第一层的令牌看不出更深处的变化。所以内核把每个变了的位置归到它所在的带标记的目录（看一眼它上面每一层的标记），在答复的 `within` 里列出，读的一方把它们当作变了（`changes.ts` 的 `changesWithin`）。

## 5. 内核

内核是三样：agent 被告知的那套心智（说明），agent 手里的动词，和每个动词背后插件可以接上的槽。其余都是插件。它站在存储上，自己不读库的文件夹。

### 动词

agent 手里有七个动词：**放**（`put`）、**找**（`find`）、**看**（`inspect`）、**说**（`say`）、**查**（`check`）、**归档**（`archive`，和它的逆 `unarchive`）、**请**（`ask`）。前六个背后各有插件的槽，`ask` 没有，由内核自己做。命令行另有两个组合，都不是第八个动词：`start "<一句话>"` 是「说：在做什么」「查」「找」三个动词一起，`show` 印管理界面的一页（第 9 节）。

```ts
// 语义基元：在边界解析一次，进来之后不再判
type LibraryPath = string & { readonly __brand: 'LibraryPath' }   // 库内相对路径
type Fingerprint = string & { readonly __brand: 'Fingerprint' }   // 内容的 sha256，可以没有
type PluginName  = string & { readonly __brand: 'PluginName' }
type Instant     = string & { readonly __brand: 'Instant' }       // ISO 8601，UTC

type Actor =
  | { kind: 'agent'; name: string; grant: GrantId | null }
  | { kind: 'owner' }
  | { kind: 'plugin'; name: PluginName }

type Session = { id: string; source: 'flag' | 'env' | 'minted'; cwd: string; machine: string; transcript: Transcript | null }
type Context = { library: Library; actor: Actor; session: Session; now: Instant; home: string; pass?: Pass }
// home：本机的 $PNEUMA_BASE_HOME。pass：有名字的全量动作报进度、听停下的通道，由发起它的面给

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

会话和行动者按这个次序识别：命令行参数（`--session`、`--as`、`@<授权名>`）；环境变量（`PNEUMA_BASE_SESSION`，或 agent 产品自己的会话变量）；都没有就为这次调用造一个。会话怎样指回 agent 产品里的那段对话，见下面「接上一个 agent」。

每个结果都带 `problems`：某个插件出错时，动词照样给出答复，同时如实说出哪个插件没做成。「已放入，但没有记下」和「已放入并记下」是不同的结果，命令行以退出码 3 区分（第 9 节「命令行」）。

#### 放

```ts
type Origin =
  | { kind: 'brought'; source: string | null; by: string | null }   // 带进来的：出处，谁带的
  | { kind: 'made'; from: LibraryPath[]; outside: string[] }        // 做出来的：依据库里的哪些，库外的各写一句

type PlaceSource = { kind: 'file'; path: string } | { kind: 'directory'; path: string } | { kind: 'stdin'; content: Uint8Array }

type PutRequest =   // 路径是调用方写的原样；note：一句话，说这次放入改了什么
  | { kind: 'register'; path: string; origin: Origin; note?: string | null; observed?: true }   // 已经在库里
  | { kind: 'place'; from: PlaceSource; to: string; origin: Origin; note?: string | null }      // 从库外的文件、目录或标准输入放进来
  | { kind: 'move'; from: string; to: string }                                                  // 在库里挪位置

type PutResult =   // fingerprint：内容经过内核时才有，登记和挪是 null
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint | null; copied: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle' | 'agent-session' | 'noise' | 'busy' | 'too-many'
      subject: string; notes: Note[]; problems: PluginProblem[] }
```

每次改动都是存储的一次带预期的写或挪（`put.ts`）。放在每种位置上做什么，全化表在第 6 节「放」。

- **路径**由内核在入口解析一次：相对库根，或库内的绝对路径。解析不出库内路径就是「在库外」。`.pneuma-base/`、`PNEUMA-BASE.md` 和 `_archive/` 不算内容，放和挪到那里都按在库外拒绝；`_archive/` 只经归档和取回进出。
- **来源**：库外的文件和目录由存储在复制时读；写成库内绝对路径的文件是库里的一个位置，存储在库里复制它；标准输入是请求里带的字节。来源是目录时，它要在库外，也不能包含这个库，否则以 `outside-library` 拒绝。
- **来历**里留空的字段等于没给：`source`、`by` 是空白就当 `null`，`from`、`outside` 里空白的行去掉。做出来的来历里，`from` 的每个路径都要是库里在的东西（主区，或它在归档区的那份），有一个不在就以 `no-such-file` 拒绝，`subject` 是那个路径。依据写的是带标记的目录里面的文件时，记为那个目录。
- **拒绝**带 `subject`：拒绝针对的那个输入。`inside-bundle` 的 `subject` 是那个带标记的目录；`too-many` 的 `subject` 说至少几个文件；位置被别的写占着，或在这次放的中途变了（预期不成立），是 `busy`，什么都没改。

**看到的和说的。** Mac 应用会把主人用 Finder 拷进库的文件自动登记成「主人带进来的」。这是看到的，不是谁说的，可能看错：比如 agent 违反说明直接写了文件。所以登记可以带 `observed`（`put <库内路径> --brought --by owner --observed`）。只有主人能这样放；行动者是 agent 时以 `agent-session` 拒绝：agent 只说来历，不替主人「看到」。记成什么、谁能更正，归记账插件。

**放的时候占住位置。** 东西先放到目标上，插件后才记下它。这中间看库的人（别的 agent 的 `check`、应用的监看）不该把它当成一个没人登记的文件，也不该把挪走的当成不在了。所以内核在写之前让存储占住这次要改的位置（`hold`）：登记是那个位置，展开的目录是每页的那些文件，放入是目标，挪是来去两处。写带着这个占位，等所有插件的 `revise`、`onPut` 都做完、被拒或出错之后放开。被占着的位置，存储的 `look` 和 `overview` 标成 `held`，别的写以 `held` 拒绝，内核说成 `busy`。占位有存活时间：文件 2 分钟，目录 10 分钟，进程被杀时它最多占这么久。比这更久的写在占位过期之后照样做完，只是不再挡别人。

**有插件留住旧内容时才换上。** 放入一个内容不同的同类东西时，内核按配置的次序问每一个有 `revise` 的插件，一个答了照样问下一个。插件收到 `PlaceOverExisting`：路径、那里现在的令牌（内核的写就预期它）、现在内容的指纹（读过才有）、新内容的指纹（目录还没复制进来时没有）。插件把当前内容留到自己名下（`held`）或拒绝（`declined`）。至少一个答 `held`，内核就带着那个令牌把新内容写上去，每个答 `held` 的插件附的那句话收进 `notes`；那里在这中间又变了，写不成，以 `busy` 拒绝。一个都没答 `held`，内核拒绝这次放入，目标不动，每个 `declined` 的理由收进 `notes`：只装了版本插件时，agent 从这里读到要先声明有版本。出错的插件列进 `problems`，算没留住。存储的写要么整个做成，要么什么都没改，所以不管插件写得对不对，目标上都不会有半截内容。

**接受之后**，内核把放交给每个插件的 `onPut`，把答复收进 `notes`。插件收到的 `AcceptedPut`：

```ts
type ThingNow = { token: string; kind: 'file' | 'bundle'; size: number | null; files: number | null; modifiedAt: Instant }
// 存储此刻说的它。目录的字节数和文件数只在它被复制进来时知道

type AcceptedPut =
  | { kind: 'register'; path; fingerprint: null; now: ThingNow; origin; note; observed? }
  | { kind: 'place'; path; fingerprint: Fingerprint; now: ThingNow; origin; note; source; copied: boolean
      previous: { token: string; fingerprint: Fingerprint | null } | null }   // 经 revise 换下的那份
  | { kind: 'move'; from; path; fingerprint: null; now: ThingNow }
  | { kind: 'register-files'; path; files: { path; now: ThingNow }[]; origin; note; observed? }   // 展开的目录这一层的一页文件
```

放入的指纹是复制的同一趟算的；登记和挪不读内容，东西靠 `now.token` 认。`note` 由内核规整过：去掉首尾空白，空白或没写就是 `null`。`register-files` 里插件登记它不认识的，认识的照原样留着。

### 找、看、说、查、归档

```ts
type FindRequest = { text: string | null; match: 'terms' | 'words'; filters: Record<string, string>; includeArchived: boolean; skipOwnSession: boolean }
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
  | { kind: 'level'; path; level: Level } | { kind: 'elsewhere'; path; size: number | null; provider: string | null }
  | { kind: 'unavailable'; path; reason: 'outside-grant' | 'no-such-file' | 'not-a-bundle' }

type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean; deep?: { dir: LibraryPath | null } }   // deep：深查，dir 为 null 是整个库
type CheckResult = { sections: Section[]; asks: Ask[]; requests: { ended: OwnerRequest[]; pending: number; more?: number }; problems: PluginProblem[] }   // ended：前 20 个，more 个下次说

type ArchiveRequest = { kind: 'archive' | 'unarchive'; path: string }
type ArchiveResult =   // moved：false 时请求本来就已满足
  | { outcome: 'accepted'; from: LibraryPath; to: LibraryPath; moved: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken' | 'inside-bundle' | 'noise' | 'busy'; subject: string; problems: PluginProblem[] }
```

**找。** 内核自己不找：按名字找要走一遍库。命中全来自插件的索引（各插件的 `onFind`）；没有会找的插件，什么都找不到。内核只为找到的路径看一眼，把它的标记（`目录`、`已归档`）放在那个路径第一条命中的细节前面（`agent.ts`）。

- 两种匹配。`terms` 把文字按空白和常见标点切开，名字里含任一段就算。`words` 用 `Intl.Segmenter` 取一句话里两个字以上的词和拉丁词，相邻的两个单个汉字也连成一个词（它会把「下单」切成单字），按命中的不同词数排，至少命中一个，每个答复者最多给 5 条（`tools.sentenceHits`）。`start` 用 `words`，`find` 用 `terms`。切词和排序是内核导出的 `searchTerms` 与 `rankHits`，插件经 `tools` 用同一套。`filters` 是插件的用语，内核不懂。
- `skipOwnSession` 让答复者不带调用者自己这次会话做的东西。`start` 打开它，因为它找的是库里本来就有的；`find` 不打开。
- 几个答复者的结果合成一张表：同一个路径的结果排在一起，位置是任何一个答复者给它的最好名次；名次相同时按配置次序。几个插件命中同一路径各给一条，各说各插件知道的。
- 各插件的 `onFind` 都答完后，内核按配置次序问每个有 `onFound` 的插件：找到的路径里它自己没给命中的那些，它知道什么。一个路径都不剩就不问。它答的每条命中并进那个路径的那一项，不改名次，也没有标记说它是补的（K3）。所以只被查找插件找到的条目也带着记账插件给的场景和来历。答了没问它的路径的那条不要，和抛错一样列进 `problems`（K8）。
- `group` 是答复者给一条结果定的标题：`group` 相同的结果在文字答复里合在这个标题下，出现在其中排得最前的那条的位置；没有路径的那条说的是这个标题本身，排在第一行。

**看。** 目标是一样东西时（主区的先，再是它在归档区的那份；写成 `_archive/…` 就是归档区的），`file` 是存储此刻说的它：令牌、修改时刻、文件的大小、带标记的目录的第一层；`fingerprint` 只在要了内容时读。目标是一个不是东西的目录时，`place` 按它是哪一种答：展开的，给它的第一层；没登记的，给一次预算 500 的探查（至少几个文件、是否超出预算、顶上有哪些项目标记，`package.json`、`.git` 这类）；噪音，说是哪个名字或哪条路径让它是噪音。目标是一个请求号时给那个请求。插件的 `onInspect` 只给它们知道的。

**看内容。** 命令行上的 agent 自己读文件；经 MCP 的 agent 读不了，所以看可以带上内容：`inspect <库内路径> --content`。内容经存储读（`content.ts`），只因为要了才读。

- 文件是 UTF-8 文字、不超过 256 KB 时给全文（`text`）；别的给大小和文件名说的媒体类型（`other`，`why` 是 `not-utf8` 或 `too-large`，超过上限的不读）。
- 同步服务只在本机留了占位的文件（`placeholder` 面）给内容在哪、多大（`elsewhere`），不下载。带 `--fetch` 时先让存储取回来再给；对象存储上取回是异步的，还没回来时照样答 `elsewhere`。
- 带标记的目录给它的第一层（`level`）；`--content <内部路径>` 给里面那个目录的一层或那个文件的内容。标记文件不给，爬不出去。
- 授权限在一个区域时，区域外的东西照样给事实，只是不给内容（`unavailable`，`outside-grant`）：今天的看、找、查都不按区域限读，区域只限写。归档的东西按它原来的路径算。只读的授权读得了区域里的内容。

**说。** 「说」的种类都归插件：内核自己不听任何种类，把请求交给声明了这个种类的那个插件（`statements`）。没有插件听这个种类，答 `not-heard`、`no-plugin-for-kind`。

**查和深查。** `check` 不读内容：插件拿存储的令牌比它记过的位置。`--since <时刻>` 或 `last` 定从哪里说起。`check --deep [<目录>]` 是有名字的全量动作：读登记过的每样东西的内容（写了目录只读那下面的），比出真正改了的。内核把它原样交给插件（`CheckRequest.deep`；命令行写 `.` 是整个库），先说范围、报进度、可以打断，归做这一趟的插件，经 `ctx.pass` 说（下面「插件机制」）。目录只和 `--deep` 一起写，否则是用法错误。

**归档。** 归档是内核自己做的，不靠插件，所以空目录里也成立。归档区是库根下的 `_archive/`，里面保持原来的相对路径。全化表在第 6 节「归档」。每次挪是存储的一次带预期的 `move`（`archive.ts`）：来处预期是看到的令牌，去处预期是空的（或内容相同的那份的令牌）；来去两处在挪和所有插件的 `onArchive` 期间被占着 2 分钟。取回之后，挪走的那样东西在归档区留下的空文件夹逐层去掉，直到 `_archive/` 为止：先看一眼它的令牌，再确认它是空的，然后带着这个令牌删掉；这中间有东西放进去，删除不成立，文件夹留着。

找和查默认跳过归档区，`--include-archived` 打开才带上。看一样已归档的东西照常给出，并标明它已归档。库的目录树本身也把归档的东西隔开了，agent 用自己的工具翻目录时看不到它们混在里面。清空归档区是主人的破坏性命令 `archive purge`。

### 主人和 agent 的门

内核有两个入口：**agent 面**（`agentFace`）是上面的七个动词，**主人面**（`ownerFace`）是主人命令。另有只读的一面 `viewerFace`，给出管理界面的页（第 9 节「页面和块」）。

| | agent 面 | 主人面 |
| --- | --- | --- |
| 能做什么 | 七个动词，其中「请」把一条只给主人的命令交给主人决定；看管理界面的每一页，管理的页除外 | 建库、改配置、装卸插件、发和撤授权、生成技能、接上和断开 agent、清留存、清归档、丢数据；在这台机器上装卸插件和存储提供者、设密钥 |
| 破坏性 | 没有 | 有。要人在终端当面确认；在 agent 的会话里被拒 |
| 只给主人 | 不适用 | 不丢数据、但替主人做决定的命令（对外发布、设部署和同步的目标、设嵌入器、发撤授权、接上和断开 agent、装卸插件、取回留存、设密钥）：在 agent 的会话里被拒，不用确认；agent 可以用 `ask` 请主人做 |
| 留痕 | 每次调用之后发一个事件，给所有插件 | 同样 |

**在 agent 的会话里**的判断（`session.ts` 的 `agentSign`）：环境里有 agent 产品的会话变量，或调用带着授权，或行动者被 `--as` 写成了一个 agent。拒绝的话说出是哪一样让它这样判的。这是第二级的拦法，和说明里的「不该做」一起构成默认的强度；让 agent 对库的目录没有直接写权限是第三级，靠 agent 产品自己的沙箱。本机上的授权是约定，不是强制：有磁盘权限的 agent 硬要越界，拦不住，事后由「没经过库的改动」发现（第 4 节）。

**门的次序**：破坏性的和只给主人的，在 agent 的会话里都以 `agent-session` 拒绝；然后按参数表核对；破坏性的再要当面确认。终端里只有输入 `yes` 才算确认；别的回答、输入结束（Ctrl+D）、不在终端里，都以 `not-confirmed` 拒绝。界面上的确认是动作的 `confirm` 对话框（第 9 节）。能被请的命令在 agent 的会话里被拒时，话的最后一行是请主人做它的那条 `ask`（`ownerOnlyRefusal`）；破坏性的和标了 `askable: false` 的没有这一行。

**授权**只有最小的形状：编号、名字、给谁、哪个区域、只读还是读写。没配任何授权时，谁都能用整个库。**区域**是库里的一个子文件夹，只限写。授权有两处：库的配置里是权威的那份；发给 agent 的那份是本机的一个小文件 `$PNEUMA_BASE_HOME/grants/<名字>.json`，写着库的位置和授权编号，丢了重新生成。agent 用 `pneuma-base @<名字> <动词>` 调用，一个名字同时定下是哪个库、是谁。

### 请主人做

管理的事归主人。agent 要其中一件时，`ask` 把它记成一个**请求**：一句为什么，和那条主人命令连同参数，照原样。主人批准就以主人此刻的身份照原样跑，或拒绝，可以带一句理由；agent 下次 `check` 时看到结果。管理的决定仍然只由主人做，门一道没少（K7），agent 只多了一种说出它要什么的办法。请求没有插件的槽，内核自己做，所以空目录里也成立。

```ts
type AskRequest = { kind: 'ask'; why: string; command: string; args: OwnerArgs } | { kind: 'withdraw'; id: string }
type RequestStatus = { kind: 'pending' } | { kind: 'withdrawn'; at } | { kind: 'declined'; at; reason: string | null } | { kind: 'approved'; at; outcome: RequestOutcome }
type RequestOutcome = { outcome: 'done'; text } | { outcome: 'refused'; reason; text } | { outcome: 'failed'; error }
type OwnerRequest = { id: RequestId; by: { name; grant }; at; why; command; args; line; status: RequestStatus; seen: boolean }   // line：照原样会跑的那一行
type AskResult = { outcome: 'asked'; request; again: boolean } | { outcome: 'withdrawn'; request } | { outcome: 'refused'; reason: AskRefusal; text }
```

**提的时候就核对**，错了马上回给 agent：只有 agent 能提（`not-an-agent`）；命令要在（`unknown-command`）；参数按那条命令自己的 `params` 核对，为什么不能空（`usage`，命令行退出码 1）。能请的只有只给主人、不破坏、没标 `askable: false` 的命令：破坏性的以 `red-line` 拒绝，它要主人当面确认；标了 `askable: false` 的以 `not-askable` 拒绝，它们是 `secret set`（值要主人亲手给）、`storage install` 和 `storage update`（信任的那一句要主人自己认）、三条请求命令和三条配对命令；agent 自己能跑的以 `run-it-yourself` 拒绝，话里带它自己跑的那一行。同一个 agent 还在等的、`line` 相同的是同一个请求，再提答同一个号（`again`）；一个 agent 最多 20 个在等的（`too-many`）。`ask --withdraw <号>` 只撤自己的、还在等的（`no-such-request`、`not-yours`、`not-pending`）。

**主人的三条命令**，都只给主人，都不能被请：

- `request list [--all] [--older]` 印的和首页里请求的那几行一样；`--all` 再列最近 50 个了结的，并说更早的还有几个，`--older` 全列。
- `request approve <号>` 经 `ownerFace.dispatch` 跑那条命令。主人调用带着 `request`（号和谁请的），所以那条命令自己的事件也带着它。跑出什么就是结果，拒绝也算；参数后来不合了记成 `no-longer-fits`；那条命令后来成了破坏性的或不能被请的，批准不跑它，以 `no-longer-askable` 拒绝并记成结果，因为批准不是当面确认。
- `request decline <号> [<理由>]`。了结了的请求不能再决定（`not-pending`）。

**一件事只问一次。** agent 请的那条命令连同参数，和某个插件 `onAsks` 的一个回答调的主人命令和参数一样时（参数里的旗子不论次序），请求代替那一问：请求在等时，首页和 `check` 只给请求，带着它的为什么；主人拒绝之后两样都不再提。这是内核的通则（`asks.ts` 的 `standsIn`），不认识任何插件。

**在哪里看到。** 在 agent 的会话里被拒的、能请的命令，拒绝的话最后一行就是那条 `ask`：`pneuma-base @<授权名> ask "<为什么>" <命令和参数>`。首页的「等你决定」先列请求：为什么，由提的 agent 署名，下面一行是照原样会跑的命令，按钮是「批准」（推荐）和「拒绝」（可填理由）。`check` 多一节「你提的请求」：上次看过之后主人决定了的，各带结果，和还在等的个数；看过的下次不再说。`inspect <号>` 给一个请求的全部。

**记在哪。** 请求是内核的记录处 `requests` 的事实（`requests.ts`），经存储写在 `.pneuma-base/requests/facts/` 下，只追加，跟着文件夹和同步走。号是 `r-` 加 8 位十六进制。每条事实带它说的请求号，是四种之一：`asked`（谁、哪次会话、为什么、命令和参数）、`withdrawn`、`decided`（批准带结果，拒绝带理由）、`seen`（提的 agent 看过结果）。一个请求的现状是从这些事实推出的一行，按提的人和在不在等可查。归并时决定压过撤回，有两条决定时早的那条算数，`seen` 只在了结之后算。去重和上限在折事实时定：一条 `asked` 折进来时，同一个 agent 已经在等同一行，它就记成那个请求的重复；已经有 20 个在等，它就记成超了。两个进程同时提，各自按存储给的次序折同样的事实，定出的一样，不用锁。

### 配对

还没接上的 agent 请主人允许它接上，叫**配对**（`pairing.ts`）。它让每个 agent 以自己的名字接上，审计因此说得出是哪个 agent 做的。

- agent 用 `pneuma-base pair request <产品> "<为什么>"`（或 endpoint 的 `POST /pair`，第 9 节）提出，得到配对号和配对码（`NNN-NNN`），把码给自己的用户看。
- 主人在首页「等你决定」里看到「<产品> 想接入这个库：允许吗？」，带着同一个码、那句为什么、允许会做什么：发什么名字的授权（产品名；这台机器上这个名字已经给了别的产品或别的库时是 `<产品>-2`、`-3`……），写什么技能或 MCP 条目（产品表里没有的产品以 `mcp-http` 接上，什么都不写）。主人点「允许」（可选区域、只读）或「拒绝」。码是把这次请求和主人面前那个 agent 对上的办法：码对不上就不该允许，所以「允许」不是推荐的回答。
- 允许就是以主人的身份跑 `agent connect`，接上只有这一个机制。
- agent 每隔几秒问 `pneuma-base pair status <号>`（或 `GET /pair/<号>`）：在等、拒绝了、过期了，或接上了（带授权名、它运行的命令、MCP 的地址、接着读什么）。
- 主人面的 `pair list [--all]`、`pair allow <号>`、`pair decline <号>` 做同样的事，只给主人，不能被请。

配对是本机的状态，不是库的：没接上的 agent 在库里还没有身份。它放在 `$PNEUMA_BASE_HOME/pairings/`，一个请求一个文件、一个决定一个文件，都以独占创建写一次，第二个决定以 `not-pending` 拒绝。文件都留着：允许的、拒绝的、过期的，`pair list --all` 和 Agent 页都列出来。10 分钟没人回答就过期；同一个产品对同一个库还在等时再请，得到同一个号和码；全机最多 5 个在等。产品名要合授权名的格式；为什么去掉控制字符，不超过 200 个字。允许和拒绝是那个库的操作，照常发事件；请求不是，还没有谁可记。

这台机器上授权是约定，不是秘密：知道授权名的本机进程都能用它。配对要的不是保密，是主人明确的一句「允许」，和每个 agent 一个自己的名字。

### 接上一个 agent

主人的主路是：选一个文件夹，把自己的 agent 一个一个接上，开始干活。接上是一条主人命令，断开是它的逆，界面的按钮就是这两条命令：

- `agent detect`：这台机器上有哪些 agent 产品、各能怎么接上。只看程序和文件夹在不在。
- `agent connect <产品> [--name <授权名>] [--area <子文件夹>] [--read-only] [--via skill|mcp|mcp-http]`：先发授权（缺省以产品命名；这个库里同名、给同一个产品、区域和权限也一样的授权接着用，撞名的拒绝，说用 `--name`），再按产品能用的方式写：读技能的，把技能装进它读技能的目录；不读的，把 MCP 服务 `<本机的命令> @<授权名> mcp` 登记进它的配置。两种都行时装技能，`--via` 改。`--via mcp-http` 登记的是 endpoint 上的地址；产品表里没有的产品只能这样接，什么都不写。先看能不能写、再发授权，所以拒绝时什么都没留下。答复说写了什么、写在哪、在那个产品里接着做什么，Codex 另有把库加进可写目录的提示。
- `agent disconnect <授权名> [--keep-grant]`：拿掉接上时写的，再撤回授权。它只动这台机器，不用指明库；授权在记录里的那个库里撤回，作为那个库的一次操作发事件。
- `agent list`：接上的 agent，各自的产品、授权、方式、区域、只读与否，接上时写的还在不在，它运行的本机命令在不在、指向的 node 和命令行在不在。
- `launcher install`：让本机的命令指向现在这个命令行（下面）。

五条都只给主人，不是 MCP 服务的工具。`grant issue`、`grant revoke`、`skill install` 原样留着，接上就是用它们拼出来的。

**产品表**（`products.ts`）是关于每个 agent 产品知道的一切的唯一一处：怎么认出它的会话、找它的对话，怎么看出它装在这台机器上，从哪个目录读技能，MCP 服务登记在哪个文件、什么格式、哪个键下，还要告诉主人什么。一个产品一行；没在产品自己的文档或行为上核过的事实不写，这个产品就少一种接法。

| 产品 | 看出装着 | 技能 | MCP 服务 | 收 URL 的 MCP 条目 | 核过的 |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | PATH 上的 `claude`；`~/.claude` | `~/.claude/skills/` | `~/.claude.json` 的 `mcpServers`，条目带 `"type": "stdio"` | 同一个键，条目 `{"type": "http", "url"}` | 技能目录按 Claude Code 的文档；MCP 的文件、键和条目按 `claude mcp add --scope user`（URL 的加 `--transport http`）在临时家目录里写出的文件；`claude mcp list` 连得上接上写的条目 |
| `codex` | PATH 上的 `codex`；`~/.codex` | `~/.agents/skills/` | `~/.codex/config.toml` 的 `[mcp_servers.<名字>]`，环境变量在 `[mcp_servers.<名字>.env]` | 同一张表，只一行 `url = "…"` | 技能目录按 Codex 的文档；表的写法按 `codex mcp add`（URL 的加 `--url`）在临时家目录里写出的文件；`codex mcp get` 读得出接上写的表，URL 的读成 `streamable_http` |
| `claude-desktop` | `~/Library/Application Support/Claude` | 不从目录读技能 | 那个目录里 `claude_desktop_config.json` 的 `mcpServers` | 不收 | MCP 的文档（modelcontextprotocol.io）：位置、键、条目，要完全退出再打开 |
| `cursor` | `~/.cursor` | `~/.cursor/skills/` | `~/.cursor/mcp.json` 的 `mcpServers`，条目带 `"type": "stdio"` | 同一个键，条目 `{"url"}` | Cursor 的文档；文档没写它在 PATH 上的程序名，所以只看文件夹 |
| `antigravity` | — | — | — | — | 只认会话 |

每个能接上的产品还有一份给 agent 的说明（第 9 节「本机的 endpoint」），里面手写的「已知的」几句也在产品表里。

**会话指回对话。** 会话号来自某个 agent 产品的环境变量时，内核按产品表找这次会话的对话文件，找到了就放进 `session.transcript`：只是一个指针，不复制、也不读里面的内容，只看文件在不在。

| 产品 | 会话号 | 对话文件 | 接着聊 |
| --- | --- | --- | --- |
| `claude-code` | `CLAUDE_CODE_SESSION_ID` | `~/.claude/projects/<目录>/<会话号>.jsonl`（设了 `CLAUDE_CONFIG_DIR` 就在它下面）。`<目录>` 是会话开始时所在的目录，字母和数字以外的字符都换成 `-`；调用可能在它下面的目录里，所以往上逐级试。目录名超过 200 个字符时不给指针 | `cd <目录> && claude --resume <会话号>` |
| `codex` | `CODEX_THREAD_ID` | `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<会话号>.jsonl`（设了 `CODEX_HOME` 就在它下面），日期是会话开始的那天，从新到旧找 | `codex resume <会话号>` |
| `antigravity` | `ANTIGRAVITY_CONVERSATION_ID` | 没见过它的目录，不给规则 | 无 |

会话号要是一个干净的名字（字母、数字和 `-`），否则不找。会话号来自 `--session` 或 `PNEUMA_BASE_SESSION`、文件不在、产品没有规则时，`transcript` 是 `null`；经 MCP 的会话号是连接自己的，也是 `null`。路径在家目录下时写成 `~/…`，在哪台机器上由 `session.machine` 记。Claude Code 里的子代理带的是主会话的号，指针指向主会话的对话。Claude Desktop 和 Cursor 没有见过的会话变量，不从环境认。

**写别的程序的文件**是危险的部分，规矩是：

- 接上写了什么记在本机的 `$PNEUMA_BASE_HOME/connections/<授权名>/connection.json`，不在库里：哪个文件、哪个键或哪个文件夹、写的东西的指纹、为它造出来的文件夹、授权的编号。第一次改一个已有的文件之前，原样复制一份到旁边的 `before/`，断开时和记录一起删。目录 `0700`，副本 `0600`：配置文件里可能有密钥。
- 文件按字改，不经解析器重写（`config-edit.ts`）。JSON 先用 `JSON.parse` 确认读得懂，再在原文里找出对象和成员的位置，在服务那一层的最后加一个成员，缩进和换行照文件自己的，其余每个字节不动。读不懂的（带注释、最外层不是对象、键重复）不改，拒绝，答复里给要自己粘的那段和先发授权的命令。TOML（Codex）在末尾空一行追加两张表，拿掉时按追加的原文精确匹配；已经写着这个名字、或服务表写成了一行里的表的，不加，同样给那段。
- 写回时在同一个目录里先写临时名，带原来的权限，再改名；文件是链接时写它指向的那个，链接还是链接。
- 断开只拿掉自己写的，而且只在它还是写的时候的样子：主人改过的，断开说出来，原样留着。接上之后没人动过那个文件时，断开后的文件和接上前一个字节都不差；接上时造出来的文件和文件夹，空了就删。
- 接两次，第二次什么都不改；断开两次，第二次安静地说没有这个连接。

**本机的命令。** 写进别的程序的都按绝对路径指名本机的命令 `$PNEUMA_BASE_HOME/bin/pneuma-base`：MCP 条目的 `command` 是它，`args` 是 `@<授权名> mcp`，没有自己的环境变量；技能里的命令行也用它，并说明说明里写 `pneuma-base` 的地方都用这个路径。所以没有 shell 配置、PATH 上只有系统工具的应用也启动得了。它是一个小脚本：导出它所在的家目录作 `PNEUMA_BASE_HOME`，再 `exec` 一个写明的 node 和一个写明的命令行入口文件。路径从不变，内容由提供命令行的一方保持最新：Mac 应用每次启动时让它指向应用自带的 node 和命令行；从包装的，`launcher install` 让它指向现在这个命令行（PATH 上的 `node` 就是这个 node 时写 PATH 上的那个，包管理器升级时它不变）。两种都只在内容不同时才写，先写临时名、带上可执行位再改名。`agent connect`、`skill install`、`guide` 和 `view` 在它不在、读不懂、指向的东西不在了或家目录不对时写它，好好的就不动。应用挪了位置或升级了，下次启动应用，命令跟着改；在这之前 `agent list` 说出它指向的东西不在了，再接一次也修好。

### 说明和技能

库根的 `PNEUMA-BASE.md` 是**说明**：写给人和 agent 的那份自我描述，没装软件的 agent 读到它也知道规矩。内核拼出它，经存储写（带预期），每次改配置都重拼（`cognition.ts`）。它由四部分拼成：

1. 内核的那几句（`packages/kernel/cognition/1-kernel-intro.md`）：这是你的库，带进来的和做出来的放这里，下次从这里找；动词怎么用；主人在管理界面上看到的每一页都能用 `show` 看。
2. 每个已装插件的**认知段**，按配置次序。每段以一个说出它带来什么的标题开头（「来历：每样东西从哪来」「版本：留住每一版」），第一句是「这个库装了**X**插件。」。一段不重复别的段管的规矩：归档和 `--include-archived`、「在库外写好再 put」归内核。
3. 内核的规矩（`3-kernel-rules.md`）：不要覆盖或删除已有的东西，不用了就归档；要主人做管理的事时怎么用 `ask`，带一个例子。其中同名时的那句话按已装插件的 `keeps` 三选一：没有插件有 `revise`，放入内容不同的同名东西被拒绝；有 `revise` 的都只留一部分，有插件留住时才换上；有一个留住全部，换下的旧内容由插件留着。
4. 当前的配置：装了哪些插件，各自的说明在哪。

说明里许诺的能力不超出已装插件提供的（K6）：没装记账插件，说明里就没有「每样东西都能回到它出现的场景」这句话。五个插件都装上时说明不到 160 行；只装记账插件时不比装插件之前长。`packages/cli/test/description-commands.test.ts` 读拼好的说明，把其中每个命令示例照原样在 agent 的会话里跑一遍，所以哪一段都不会和命令走样。

**技能**是一个指向说明的短文件（`packages/kernel/cognition/SKILL.md`），带着库的位置、授权的名字和这台机器上的命令，为每个 agent 产品各放一份。`skill install <授权名> --dir <目录>` 写它，`agent connect` 也写它。技能是这台机器的文件，说明是库的，跟着库走，仍写 `pneuma-base`。

### 命令表

主人命令都是数据：名字、一句说明、参数表 `params`、是否破坏性（`destructive`）、是否只给主人（`ownerOnly`）、是否只读（`readOnly`，可选）、是否配置（`setup`，可选）、能不能被请（`askable: false`，可选）、`run`。插件的 `OwnerCommand` 和内核自己的同形，只是内核的 `run` 收到整个主人调用（上下文、插件表、环境、是否带授权、怎么问当面确认、怎么读主人另给的值），并可交回重开的库。动词的参数也是数据，和主人命令的参数表同形，在 `packages/cli/src/verbs.ts` 的一张表里。这两样合起来是**命令表**；第 4 层的每个面都由它生成（第 9 节）。

**内核自己的三十一条**在 `owner-commands.ts`、`agent-commands.ts`、`launcher.ts`、`request-commands.ts`、`pair-commands.ts`、`noise-commands.ts` 和 `storage-commands.ts`：

- 十七条要一个库：`grant issue`、`grant revoke`、`plugin add`、`plugin remove`、`plugin catch-up`、`skill install`、`archive purge`、`agent connect`、`request list`、`request approve`、`request decline`、`pair list`、`pair allow`、`pair decline`、`noise list`、`noise add`、`noise remove`。
- 十四条只动这台机器，有没有库都能跑：`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`、`agent detect`、`agent list`、`agent disconnect`、`launcher install`、`storage list`、`storage install`、`storage remove`、`storage update`。没有库时上下文的 `library` 是 null，没有插件可告诉，不发事件；带着库（比如从界面）时照常发事件。
- `archive purge` 是破坏性的；`skill install`、`plugin catch-up`、`plugin list`、`noise list` 谁都能跑；其余只给主人。
- `init <地址> [--bare] [--provider <名字>]` 不在命令表里：它在库存在之前跑，由命令行直接调内核（第 11 节）。

**分派。** `ownerFace.commands(插件表)` 列出可用的命令：先内核的，后各插件的，按配置次序；名字已被占的不再列，插件盖不住内核的命令。`ownerFace.dispatch(主人调用, 命令名, 参数)` 是唯一的入口，命令行和界面的服务都走它：命令经同一道门（K7），在单一出口发事件（K5）。

- 没有这条命令：在任何操作开始前拒绝（`unknown-command`），不发事件。要库的命令没给库，同样在开始前拒绝（`no-library`）。
- 参数不对：内核在门里、`run` 之前核对（`params.ts`），以 `usage` 拒绝，说出哪一样不对，带参数表生成的用法；命令行把它当用法错误，退出码 1。值去掉两头空白，空的算没给，所以表单留空的一项等于没写；开关在表单里写成值 `yes` 或 `no`。装载插件时核对参数表的形状。
- 主人另给的值，比如密钥：命令行从标准输入读，在终端里不回显地问；界面的服务取 `Call` 的 `stdin`。它不在参数里，所以不进事件。
- 事件带 `destructive`、`readOnly`、`setup` 三个标志，插件不用自己认哪些命令会丢数据、哪些什么都不改；记账插件据后两个决定它算不算给 agent 的消息。

### 插件机制

插件必须做什么、可以依赖什么，写在 `PLUGINS.md`：每个钩子什么时候被调、拿到什么、能答什么，主人命令的参数表和门，块的字段和插件自己画的页，能写哪里，上下文里的工具，开发包里的库，符合性检查，装和卸。它和库的格式是 1.0 要冻结的两样。这一节只写内核为什么这样、怎么实现。

```ts
interface Plugin {
  readonly contract: number                     // 按哪一版插件契约写的：sdk 的 CONTRACT（2），内核只跑这一版
  readonly name: PluginName
  readonly version?: string                     // 它自己的版本，给人看
  readonly summary?: string                     // 一句中文，说它带来什么，给人看
  readonly cognition: CognitionSection | null   // 拼进说明的那一段
  readonly keeps?: 'every' | 'some'             // 有 revise 时：换下的内容都留住，还是只留一部分（缺省）
  readonly storage: StorageDecl[]               // 它记录处里的目录，各是本体还是缓存
  readonly statements: string[]                 // 「说」里它听得懂的种类
  readonly secrets?: SecretDecl[]               // 它用 ctx.secrets.get 读的凭证
  readonly ownerCommands: OwnerCommand[]        // 它给主人面加的命令，名字以 `<插件名> ` 开头；每条带参数表

  // 钩子都是函数类型的属性，不是方法，所以参数按契约严格检查
  readonly onPut?: (req: AcceptedPut, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly revise?: (req: PlaceOverExisting, ctx: PluginContext) => Promise<ReviseOutcome>
  readonly onFind?: (req: FindRequest, ctx: PluginContext) => Promise<PluginFindAnswer>
  readonly onFound?: (paths: LibraryPath[], req: FindRequest, ctx: PluginContext) => Promise<PluginHit[]>
  readonly onInspect?: (req: InspectRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onSay?: (req: SayRequest, ctx: PluginContext) => Promise<SayAnswer>
  readonly onCheck?: (req: CheckRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onAsks?: (ctx: PluginContext) => Promise<PluginAsk[]>          // 只有主人能定的事
  readonly onArchive?: (req: AcceptedArchive, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly observe?: (event: Event, ctx: PluginContext) => Promise<void>  // 两个面的每次操作之后
  readonly onPurged?: (paths: LibraryPath[], ctx: PluginContext) => Promise<void>   // archive purge 删了东西之后
  readonly onAdd?: (ctx: PluginContext) => Promise<void | { problems: string[] }>   // plugin add 装上它之后，一次
  readonly onRemove?: (ctx: PluginContext) => Promise<void | { refuse: string }>    // plugin remove 卸下它之前
  readonly catchUp?: (things: readonly RegisteredThing[], ctx: PluginContext) => Promise<void>   // 装上之前登记过的东西的一页
  readonly openDirs?: (ctx: PluginContext) => Promise<LibraryPath[]>                // 它的记录让哪些目录展开
  readonly registered?: (req: { after: string | null; limit: number }, ctx: PluginContext) => Promise<RegisteredPage>   // 记着登记的插件答登记的一页

  readonly views?: ViewDecl[]                   // 它给管理界面加的页，编号以 `<插件名>.` 开头
  readonly onView?: (req: ViewRequest, ctx: PluginContext) => Promise<ViewAnswer>
  readonly onItemView?: (path: LibraryPath, ctx: PluginContext, panel?: { params: Record<string, string>; size: number }) => Promise<ItemSection | null>
  readonly ui?: string                          // 它自己画的页所在的目录，绝对路径
}
type PluginContext = Context & { cacheDir: string; tools: PluginTools; secrets: PluginSecrets }
```

一个只有契约版本、名字、其余全空的对象是合法的插件，所以「什么都不装」和「装了一个什么都不做的插件」走同一条路，空实现不用特判。sdk 的 `definePlugin(plugin)` 原样交回它，只为让钩子在写的地方就按契约检查；钩子写成属性而不是方法，因为方法的参数在 TypeScript 里是双变的，写错了参数类型也能赋给 `Plugin`。

内核这边：

- **按配置次序调，一个出错不连累别的。** 每个钩子由 `eachPlugin`（`pipeline.ts`）按配置次序调，一个插件抛错记成它的问题，其余照样调（K8）。答复不写插件名，由内核盖上（`PluginNote`、`PluginSection`、`PluginHit`）。`onPut`、`onArchive` 和 `onFind` 的答复可以在说明或命中旁边带 `problems`：部署插件这样说「放入成功了，上线没跟上」。
- **跟着挪和归档的插件用 `onPut`、`onArchive`**：只有这两个钩子收到内核解析过的路径，`observe` 里的请求是调用方写的原样。`onPurged` 让插件不用比命令名；`onAdd`、`onRemove` 让插件听得到自己被装上和卸下。`onRemove` 可以拒绝，但主人总能 `plugin remove <名字> --anyway`：插件提醒，主人决定。
- **问主人**（`onAsks`）：插件说出它此刻在等主人定的事，每件一句话、关于哪样东西、几个回答（动作）、推荐哪一个。它只读，不写东西：首页每次显示、`check` 每次答都问一遍，插件按自己记的状态答，主人定了下次就不再问。内核按配置次序问（`asks.ts`），像核对块一样核对每一件，盖上插件名。`check` 的答复带着它们（`asks`），命令行印在「要主人来做的」下面，每个回答印成主人在自己终端里跑的命令；首页把它们放在最上面。
- **`keeps`** 定说明里同名时的那句话：记账插件是 `every`，版本插件是 `some`。
- **展开的目录**（`openDirs`）：插件说它的记录让哪些目录展开，内核再加上库根（`places.ts` 的 `openDirectories`）。登记一个展开的目录是登记它这一层的散文件；看一个展开的目录给它的第一层；界面的变化摘要只看这些目录（第 9 节「界面的服务」）。
- **页的槽**：编号不以插件名加点开头的页不列出，记成问题；`onView`、`onItemView` 抛错或答的不是一页、一节，那里换成说明出错的块（K8）。页不是操作，内核不为它们发事件。
- **契约只有第 2 版**（sdk 的 `CONTRACT`）。声明了别的版本的插件在装载时被拒，`plugin install`、`plugin add` 的答复说原因和 `PLUGINS.md` 里讲从第 1 版到第 2 版要改什么的那一节。

**名字只归一个插件。** 插件认领的名字是三样：「说」的种类、主人命令名、页的编号。`plugin add` 遇到一个名字已被已装的插件认领，以 `name-taken` 拒绝，说出每个名字归谁、要换用它先卸下哪个；`init` 一次装几个插件时同样核对。配置被手改或同步过来、已经有这样的撞名时，库照样打开：按配置次序，后面那个插件撞上的名字不接上，每个记成它的问题，在每个答复里列出（K8）。实现在 `claims.ts`。插件名也是它记录处的名字和命令的头一个词，所以内核的记录处 `kernel`、`requests`，存储自己占的 `tmp`、`trash`、`holds`、`cache`，和命令行与内核命令的头一个词都不能做插件名（sdk 的 `RESERVED_PLUGIN_NAMES`）。

**有名字的全量动作。** 读或写整个库、整个目录的一趟（`check --deep`、`ledger register <目录> --inside`、补上）是有名字的：先说要做多少，边做边报，能停下，停下时留下做过的，答复说做了多少。插件经可选的 `ctx.pass` 说：`report({ done, total, atLeast?, text })`，`total` 不知道时是 `null`；每步之间看 `stopped()`。谁在看着谁给：命令行把每次报告印在标准错误上，第一次后面写「（Ctrl-C 停下）」，第一个 Ctrl-C 让 `stopped()` 为真（`main.ts` 的 `terminalPass`）；界面的服务把它流给网页（第 9 节）；没人看着时没有 `ctx.pass`，照做。

### 上下文里的工具

`PluginContext.tools` 是插件正当需要的内核工具，绑在这次操作的库上，没有一个要传库根。类型在 sdk，代码是正在跑的内核的，所以带标记的目录算哪些文件、找怎么切词排序，插件和内核永远一致。工具用存储的词，只在插件的记录指到的地方问存储；没有一个工具走库，列出的都是一页。

| 组 | 工具 |
| --- | --- |
| 路径 | `resolve(输入)` → `{ path, region, bundle } \| null`；`regionOf`、`archivedPath`、`originalPath` |
| 东西 | `what(路径们)`：每个路径上是文件、带标记的目录、文件夹、别的还是没有，带存储的描述，一次看一眼这些路径和它们的标记。`markBundle(目录)`：写上内核的标记，标记的内容只在内核里 |
| 找 | `searchTerms`、`rankHits`、`sentenceHits` |
| 放 | `put(请求)`：经 agent 面放入，行动者和会话是这次操作的，所以每个插件都听到、它发自己的事件 |
| 登记 | `registered({ after, limit })`：库里登记过的东西的一页（一页 500 样，最多 1000），由记着登记的插件答（下面「补上」） |
| 存储 | `storage`，见下 |

`tools.storage` 是存储的操作，绑在插件自己的记录处上，记录处的名字就是插件名：

- 放东西的地方：`glance`（几个位置各是什么）、`overview`（一个目录一层的一页，缺省 200 项，最多 1000）、`look`（拿存着的令牌比，答哪些变了、不在了、被占着；预期写 `empty` 是那里该什么都没有；带 `deep` 时目录深看）、`lookRows`（预期在它自己的一张行表里：存储按行比，一页至多一万行，只答不同的；也可以带 `deep`）、`content`（读内容取指纹；目录按内容规则，超过 5000 个文件答 `too_many`，带 `manifest` 时另答清单的一页）、`read`（字节，或写到库外的一个文件）、`write`（带预期；来源是库外的路径、字节或库里的一个位置，后者就是复制，`own: true` 指它自己记录处里的位置）、`move`、`remove`（都带预期）。
- `probe`（一个目录至少有多大，数到预算为止，缺省 500）、`noise()`（库根声明的噪音）、`hold`、`release`、`changed(mark)`（下面）。
- `own`：它记录处自己的地方，同一组放东西的操作。第一次写就建立它；内核不替它建。
- `records`：它的事实（`append`、`since`）和行（`put`、`get`、`under`、`where`、`count`、`reset`）。事实只追加；行从事实推出，在存储的缓存区，可以丢掉。
- `recordPlaces()`：内核在这个库里认得的记录处的名字（它自己的 `requests` 和每个装着的插件的）。`recordPlace(名字)`：读一个记录处，它的事实（`since`）和它自己的地方（看、比、取内容、读），名字可以不在 `recordPlaces` 里（别的机器上的插件写的）。
- 插件只写自己的记录处。`carry(名字)` 给把整个库搬到别处的插件（同步）：它把一个记录处要同步的那部分按字节从库外复制进来，自己的地方里的文件复制上去或拿掉（都带预期），在别处写下的事实文件按它的名字整个放进来（存储的 `facts.carry`）。它不能追加一条事实、写一行，也不能改已有的事实文件，所以搬运的插件不能替谁说话。符合性检查的 `writes` 拒绝往自己的记录处以外写的插件。

`tools.storage.changed(mark)` 带着插件上次拿到的游标、5 毫秒的预算问，答这之后动过的位置、新的游标和 `within`（第 4 节「变化由谁来学」）。说不出时位置是 `null`：插件就把对每个位置的预期存成自己的一张行表，让存储在里面比（`lookRows`），只把不同的交回来。

插件经 `tools.storage` 读写目录时，内核把存储的进度接在最后一次报告的话后面（「正在读 notes/：120 / 900 个文件」，`tools.ts` 的 `relayedPass`），插件不用管。测试里设了 `PNEUMA_BASE_TOOL_LOG` 时，内核把插件向存储要的每次一览、探查、取内容和读记成一行（`tool-log.ts`），符合性检查的 `bounded` 读它。

### 补上

插件从听到的放学库里登记了什么。装进一个已经在用的库时，装上之前登记过的东西它没听到。登记归记账插件（`registered`，按位置一页一页地答，带一共几样），插件之间互不认识，所以经内核问（`catch-up.ts`）：

- 工具 `tools.registered` 答的是配置里第一个有 `registered` 钩子的插件，没有时是空的一页。
- `plugin add` 装上一个有 `catchUp` 的插件、调过 `onAdd` 之后，内核一页 500 样地取登记交给它。这是一次有名字的全量动作：先说一共几样，每页报一次，停下就停在那一页之后。
- 每页之后，内核在自己的记录处 `kernel` 追加一条事实（哪个插件、补到哪个位置之后、几样、完没完），行从它推出。`plugin catch-up <名字>`（主人和 agent 都能用，不改内容）从没补完的那一页接着补，补完了的从头再补；插件学两次和学一次一样。
- 没补完时，这个插件的找的命中、查的节、主人命令的答复和它的页上多一行，说补到哪里、接着补的命令（`catchingUpLine`）。配置页上装着的有 `catchUp` 的插件带「补上装上之前登记的」。钩子抛错时停在那一页，答复列出它的问题和接着补的命令。
- 补到哪里不随同步走：记录处 `kernel` 不在 `recordPlaces()` 里，别的机器上装上同一个插件时自己补。只记着一部分东西的插件（版本插件只记声明过的）不用它。

### 库外的插件与缓存

- **插件表** = 命令行自带的五个插件 + 本机的 `$PNEUMA_BASE_HOME/plugins/<名字>/`。加载在内核导出的 `loadPlugins(home, 自带的表)` 里，命令行每次调用、界面的服务每次请求都用它建表。自带插件的名字不会被本机的插件占用。
- **装和启用是两件事。** `plugin install <目录>` 和 `plugin uninstall <名字>` 是这台机器上有没有；`plugin add <名字>` 和 `plugin remove <名字>` 是一个库里启用和停用，库的配置里只写名字。装、卸都先写临时名再改名，没有装了一半的插件被载入。没有 `package.json` 的目录，`plugin install` 写一个 `{ "type": "module" }`。装载器不替插件设 `ui`：插件自己写，比如 `new URL('./ui/', import.meta.url)`。
- **改了就重新载入。** 装载器按目录里每个文件的名字、大小、修改时间算一个戳，`index.js` 带着戳导入，一个模块钩子（Node 的 `registerHooks`）让它从目录里导入的每个模块带上同一个戳。目录里任何文件一变，下一次 `loadPlugins` 就载入整套新的；一直开着的界面服务在下一次请求就用新代码。
- **装载时核对**不调钩子就能核对的一切（`plugin-table.ts` 的 `whatIsWrong`，清单在 `PLUGINS.md` 第 8 节「装载时核对什么」）；钩子和命令的 `run` 答什么、抛不抛错，插件往哪里写，留到调用时（K8）。自带插件过同一道检查：过不了是这个 pneuma-base 自己的错，`loadPlugins` 抛错。
- **加载失败**的本机插件不进插件表；装了它的库照「装了但这台机器不认识」处理（K8）：每个答复的 `problems` 里有它，消息是加载失败的原因（`whyNotLoaded`）。
- **缓存目录** `PluginContext.cacheDir` 是 `$PNEUMA_BASE_HOME/cache/<库的 id>/<插件名>/`。它放在库外，因为库会被同步工具整个同步，而索引这类文件经不起同步。内核不建它；删了只影响时间。
- **密钥**放在 `$PNEUMA_BASE_HOME/secrets/<插件名>/<密钥名>`，一个密钥一个文件，内容就是值；目录 `0700`，文件 `0600`，先写临时名再改名。放在库外，所以任何同步都带不走；值不出现在任何答复、事件、页里。插件声明的密钥可以标 `optional: true`。主人用 `secret set <插件名> <密钥名>` 设，值从标准输入读，从不取命令行的参数（参数会留在 shell 的历史和进程列表里）；`secret list`、`secret remove` 同样只给主人。界面的配置页设密钥时，值作为命令的标准输入送去（`Call` 的 `stdin`），不进事件。

**写一个库外的插件**要的都在仓库里，`PLUGINS.md` 从五分钟走通讲到完整的参考：

- 两个包文件，`pnpm pack:dist` 打进 `dist-packages/`（不进 git）：`pneuma-base-<版本>.tgz` 是命令行，内核、五个自带插件、界面的服务和网页都作为捆绑的依赖在里面，内核的 `bin/` 里是这台机器上构建的存储程序和契约测试的程序，另带 `PLUGINS.md`；`pneuma-base-sdk-<版本>.tgz` 是 `@pneuma-base/sdk`，不依赖这个仓库的别的包。两个的版本都是 sdk 的 `PNEUMA_BASE_VERSION`，每个工作区包的 `package.json` 和它不一样时打包拒绝（`scripts/pack-dist.mjs`）。
- 测试工具 `@pneuma-base/sdk/testkit` 跑真的命令行，不另造一个假的内核。`conformance` 把规范里行为上的规矩跑成检查（`PLUGINS.md` 第 7 节），仓库自己的测试拿它查自带的五个插件，也拿故意违规的插件看每条检查都会变红（`packages/cli/test/conformance.test.ts`）。
- 脚手架 `pneuma-base plugin new <目录> [--kind blank|deploy]` 是命令行的命令，不是内核的：它只从命令行包里的 `templates/` 写一个项目目录，不碰库，不碰 `$PNEUMA_BASE_HOME`，不发事件。两种项目都不改一行就通过自己的测试（`packages/cli/test/scaffold.slow.test.ts`，在 `pnpm test:slow` 里，要联网）。
- `plugins/` 下有三个照第三方的做法、只依赖两个包文件写的插件：`space`（发布到 PneumaSpace）、`links`、`pulse`。它们也是契约的回归测试（`plugins/README.md`）。

插件的规矩在 `PLUGINS.md` 第 3.7 节和第 6 节：只往自己名下写，不改别的插件的东西，不认识的内容原样留着，agent 面上做的事主人撤得回。记录只新增；只有破坏性的主人命令删、改写插件自己名下的文件，主人总能丢掉数据。插件可以做要模型、要联网、带判断的事；内核不做。

## 6. 每个动作在每种位置上做什么

一个动作碰到的位置是五种之一：登记过的文件、带标记的目录、展开的目录、没登记的目录、噪音（第 4 节）。

| 动作 | 登记过的文件 | 带标记的目录 | 展开的目录 | 没登记的目录 | 噪音 |
| --- | --- | --- | --- | --- | --- |
| 放入（从库外复制） | 有插件留住旧内容时，带预期地换上；同一趟取指纹 | 同左，按内容规则整棵换 | 放进它里面 | 放进它里面，之后它就是展开的 | 拒绝 |
| 登记（已在原地） | 看一眼，更正来历 | 看一眼它和它的第一层，更正来历 | 这一层的散文件各登记成文件 | 写标记，登记成一样东西；「登记里面的全部」是有名字的全量动作 | 拒绝 |
| 看（`inspect`） | 存储此刻说的它，插件说的记录 | 同左，加它的第一层 | 它的第一层 | 一次预算 500 的探查：至少几个文件、顶上有没有项目标记 | 说它是噪音、按哪一条 |
| 找（`find`） | 查插件的索引 | 查插件的索引 | 不涉及 | 不在结果里 | 不在结果里 |
| 开工和查（`start`、`check`） | 比令牌 | 比它和它第一层的令牌，加变化日志说的更深处 | 目录自己的令牌变了才重列这一层 | 一行，只在它是新出现或还没被答复时 | 不提 |
| 归档 | 带预期的移动 | 同左，整个目录 | 拒绝：它不是一样东西 | 拒绝 | 拒绝 |
| 深查（`check --deep`） | 读内容 | 按内容规则读 | 只查其中登记过的 | 不进 | 不进 |

下面两张表是放和归档的全化：每一格都有确定的答复，`packages/kernel/test/put-table.test.ts` 和 `archive-table.test.ts` 一格一个测试。

### 放

内核自己看得到的「东西」是一个普通文件，或一个带标记的目录。表里「同类」指和放进来的东西同一类：文件对文件，带标记的目录对带标记的目录；「另一类」是另一类的东西，或既不是文件也不是目录的东西（链接、设备）。代码里的表是 `put.ts` 的 `PUT_TABLE`。

| 请求 ＼ 目标 | 在库外或授权区域外 | 在带标记的目录里面 | 噪音 | 不存在 | 同类，内容相同 | 同类，内容不同 | 没有标记的目录 | 另一类 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 登记 | 拒绝 | 拒绝 | 拒绝 | 拒绝：没有这个文件 | 接受：看一眼它现在的样子，不读内容 | 不适用：登记的东西就是目标本身 | 没登记的：写标记，整个登记成一样东西，接受，不读内容。展开的：这一层的散文件各登记成文件，接受，不写标记，文件夹和更深处不碰 | 拒绝：没有这个文件 |
| 放入文件或标准输入 | 拒绝 | 拒绝 | 拒绝 | 复制，预期那里是空的，接受 | 不复制，接受 | 有插件留住旧内容：换上新的，预期那里还是看到的令牌。没有：拒绝，目标不动 | 拒绝：那是个文件夹，里面可能有别的东西 | 拒绝 |
| 放入库外的目录 | 拒绝 | 拒绝 | 拒绝 | 按内容规则复制整棵树，写标记，接受；超过 5000 个文件拒绝 | 不适用：目录对目录一律当作内容不同 | 同上一行，整棵换掉 | 拒绝：那是个文件夹 | 拒绝 |
| 挪 | 拒绝 | 拒绝 | 拒绝 | 挪过去，预期来处还是看到的令牌、去处是空的，整个目录一起，接受 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |

- 「内容相同」只在可能相同时才读来判：文件对文件、大小一样，才读两边的指纹比；大小不同就是不同。判目录要读整棵树，所以不判。
- 拒绝的理由：在库外 `outside-library`，在区域外 `outside-grant`，在带标记的目录里面 `inside-bundle`，噪音 `noise`，目标上有别的东西 `would-overwrite`，目录超过 5000 个文件 `too-many`，位置被占着或在中途变了 `busy`。
- 登记一个展开的目录时，内核按存储的一览一页一页地取它这一层的文件，每页最多 200 个，告诉插件的是一页一个 `register-files`；这一层没有文件时以「没有这个文件」拒绝。

### 归档

| 请求 ＼ 目标 | 不存在 | 在主区 | 已在归档区 |
| --- | --- | --- | --- |
| 归档 | 拒绝：没有这个文件 | 挪进归档区，接受。归档区里同一路径已有别的东西时：内容相同就挪到它上面，不同就在新来的名字后加指纹的前八位 | 接受，什么都不动 |
| 取回 | 拒绝 | 接受，什么都不动 | 原路径空着：挪回去，接受。原路径被占：以 `original-path-taken` 拒绝 |

- 「东西」是文件或带标记的目录，目录整个一起动；展开的和没登记的目录都不是东西，以「没有这个文件」拒绝。
- 实现按四种状态判（`archive.ts` 的 `ARCHIVE_TABLE`）：两处都没有；只在主区；只在归档区；两处都有。两处都有时，归档按「在主区」办，取回按「原路径被占」拒绝。取回时原路径上的任何东西都算占着，没有标记的目录也算。
- 路径在一个带标记的目录里面时以 `inside-bundle` 拒绝；路径是噪音时以 `noise` 拒绝；位置被占着或在中途变了以 `busy` 拒绝，什么都没动。路径写成 `a.md` 或 `_archive/a.md` 都指同一样东西。
- 归档区的那个位置空着时不读任何内容；被占着时才读两边的指纹，判是不是同一份、加什么后缀。

### 没有任何插件时的答复

| 动词 | 答复 |
| --- | --- |
| 放 | 按上面的全化表。接受时 `notes` 为空。放入遇到内容不同的同名东西：拒绝 |
| 找 | 一条都没有：内核不按名字找，那要走一遍库 |
| 看 | 这样东西此刻的样子，或这个目录、这处噪音是什么（`place`），`sections` 为空；要内容时照样给 |
| 说 | `not-heard`，`no-plugin-for-kind`，附一句「这个库没配能记下这句话的插件」 |
| 查 | `sections` 为空 |
| 归档 | 按上面的全化表 |
| 请 | 和有插件时一样 |

没有插件记登记时，也没有展开的目录：文件夹都只是文件夹（第 4 节「目录的三种」）。

## 7. 有界，写成数字

| 什么 | 上限 | 在哪 |
| --- | --- | --- |
| 一览：目录的一层 | 200 条，多的说「至少还有 M 条」 | `things.ts` 的 `LEVEL` |
| 探查 | 预算 500 条 | 存储的缺省 |
| 一个带标记的目录 | 5000 个文件；放入、深看、取内容到了就停，答「至少」 | `things.ts` 的 `THING_FILES` |
| 命令行里的任何清单，和 agent 的结构化答复（`--json`、MCP 的结构化内容）里的 | 前 20 条，加总数和看其余的命令；字里和 JSON 里一样 | sdk 的 `TEXT_ROWS` |
| 页面里的任何清单 | 一页 50 条 | sdk 的 `PAGE_ROWS` |
| agent 的 `start` 和 `check` | 字不超过 8 KB，JSON 不超过 32 KB；两种形式在同一处停，说少了什么、在哪看 | `packages/cli/src/format.ts` 的 `AGENT_TEXT_LIMIT`、`AGENT_JSON_LIMIT` |
| agent 的 `find` | 一页 20 样，多了说一共几样和下一页的命令 | `format.ts` 的 `FIND_ROWS` |
| `check` 里你提的请求的结果 | 前 20 个，其余的下次 `check` 说 | `requests.ts` |
| 「看」给的全文 | 256 KB 的 UTF-8 文字 | `content.ts` 的 `CONTENT_LIMIT` |
| 一次性的命令问「变了什么」 | 预算 5 毫秒；一次超过一万个位置算说不出 | `changes.ts` |
| 存储拿行比令牌 | 一页一万行 | `STORAGE.md` 的 `look` |
| 插件的一览 | 缺省 200 项，最多 1000 | `tools.storage.overview` |
| 补上 | 一页 500 样 | `catch-up.ts` |
| 一个 agent 在等的请求 | 20 个 | `requests.ts` |
| 在等的配对 | 全机 5 个，10 分钟过期 | `pairing.ts` |

全量的动作都有名字、先说范围、有进度、可打断：深查（`check --deep`）、登记一个目录里的全部（`ledger register <目录> --inside`）、补上（`plugin add`、`plugin catch-up`）、重建查找的索引（`search rebuild`）。别的动作不会顺带触发它们。

## 8. 自带的插件

命令行自带五个插件：记账与对账（`ledger`）、版本（`version`）、同步（`sync`）、部署（`deploy`）、查找（`search`），名单在 `packages/cli/src/plugins.ts`。每个都按插件契约第 2 版写，碰库只经 `ctx.tools`：存储的词（看一眼、一览、比令牌、内容），自己的记录处和行；`node:fs` 只用在库外。`pneuma-base init <地址>` 只装记账，`--bare` 什么都不装，别的由主人 `plugin add <名字>` 装上。契约在 `PLUGINS.md`，机制在 第 5 节「插件机制」。

### 记账与对账

`packages/plugin-ledger`。它记下每样东西是哪次会话、哪个 agent 为了什么放进来的，依据了什么，之后谁改过、挪过、说过什么；再拿记录和存储比，说出哪些东西和记录对不上。场景、线索、来历、可能过期都由它推出。它是登记的保管者（`registered`），也给出展开的目录（`openDirs`），所以补上（第 5 节「补上」）和内核分辨三种目录都靠它。`MODEL.md` 是它的第一份领域模型草稿。

它听的「说」是 `doing`、`decided`、`note`、`from`、`revised`。`keeps` 是 `every`：任何东西被换掉时它都留住旧内容。库外只碰 agent 的对话记录（只看在不在，`conversation.ts`）和主人导出的文件（`export-file.ts`）。事实种类在 `facts.ts`，归并在 `fold.ts`，看库在 `look.ts`，标记在 `settle.ts`，查询在 `queries.ts`，留存在 `held.ts`，没人登记的东西在 `unowned.ts`。

#### 记什么

事实经 `tools.storage.records.append` 追加，写了不改；一个钩子的事实一次写下。信封是 `id`、`at`、`scene`、`actor`（`agent`、`owner` 或 `plugin`，带名字和授权）、`where`（工作目录、机器、会话号从哪来、对话记录的指针）和 `how`：`tool` 是工具做的，`reported` 是行动者说的，`observed` 是看到的。种类：

| 种类 | 记的是 |
| --- | --- |
| `item.enter` | 一样东西入册：路径、来历（`brought`、`made` 或来历不明 `adopted`）、`token`、`modified`、`size`、`fingerprint`（没读过是 `null`），可选 `bundle`、`note` |
| `items.enter` | 一次登记许多样，共一个来历；`fold` 当成一样一条 `item.enter` |
| `item.revise` | 换了内容：`base`、新的 `fingerprint`、`size`、`token`、`held`（留存位置或 `null`）、`claimed`，可选 `basis`、`by: 'owner'`、`note` |
| `item.move` | 挪：`from`、`to`、`archive`（`in`、`out` 或 `null`） |
| `item.basis`、`item.remove` | `say from` 补的依据；随归档区清掉 |
| `said` | 在做什么、决定、备注（`flavor`），可以关于一样东西 |
| `owner.op` | 一次做成了的主人面操作（`observe` 记）：命令、一行答复 `summary`（绝对路径只留最后的名字）、`destructive`、`readOnly`、`setup`，可选 `request`、`refused`、`declined` |
| `request` | agent 请主人做（`asked`）或撤回（`withdrawn`） |
| `checked`、`unowned.left` | 这个行动者看过了；主人留着不登记的路径 |

规则：

- 一样东西的身份是令牌；指纹只在内容经过内核（复制放入）或有人读过时才有。两份是不是同一份（`sameVersion`）：两边都有指纹比指纹，否则都有令牌比令牌，都说不出就当不同。依据记下来源当时的令牌和指纹，可能过期按同样的规则判。
- 带标记的目录入册后，路径在它下面的已在册条目「并入」它（`fold` 推出，没有新的事实种类）：跟着它挪、归档、被清掉，不进 `find` 和 `check` 的清单。依据并入条目的东西照记着的那份判；那个目录变了算「不知道」，也标可能过期。`say` 写的路径在带标记的目录里面时，说的是那个目录。
- 换下的旧内容进**留存**，是给主人的保险，只有主人取得回。记账的说明、答复和界面说留存，不说版本：版本归版本插件。
- 看到的来历和改动（`put --observed`、`say revised --observed`，只给主人，后者不和 `--by` 一起写）显示时带「（自动登记）」。之后有人说了来历，换掉看到的那条，答「已更正来历」，被换掉的留在 `inspect` 的「先前：…」里；有人 `say revised` 同一份内容，换掉那条改动的归属。说的永远不被看到的换掉，事实次序反过来也一样。
- `say revised` 加 `--by owner` 时事实体带 `by: 'owner'`，信封的 `actor` 仍是这个 agent。信封的 `actor` 是库从授权和会话认出来的，调用方说什么都不改它。
- 主人批准的请求跑的命令，`owner.op` 带 `request`（请求号和谁请的），被拒时另带 `refused`。`request approve` 自己、`ledger stats`、没做成的不记。`request decline` 带 `declined`，从行 `requests` 找出当初是谁请的。`archive purge` 之后，被删的条目各记一条 `item.remove`。
- `put --made --from` 写了被换掉的东西自己时，依据里不记它自己。`inspect` 和 `find --scene` 接受至少 6 个字符的场景号前缀，对上几个场景时列出它们（最多 10 个）。

#### 存放和行

在 `.pneuma-base/ledger/` 下，经存储读写：

| 目录 | 性质 | 内容 |
| --- | --- | --- |
| `facts/` | 本体 | `<YYYY-MM-DD>/<时刻>-<写者>-<序号>.jsonl`，每次写入一个名字唯一、写完不动的文件。旧的 `<场景号>/` 和直接放在 `facts/` 下的照样读 |
| `held/` | 本体 | 留存：`<条目>/<键>/<名字>`，等主人清 |

行在存储的缓存区 `.pneuma-base/cache/rows/ledger.sqlite`，答复都从行里查，一次一页。行从事实一步步推出：读游标之后的事实，一页 2000 条，只取这页点到的行和由它们够得着的几行，把改了的行和新游标在一次提交里存下（`rows.ts` 的 `Tx`）。两个进程同时折时后存的重读再来（`rows.put` 的 `expect`）。`meta` 里的形状（`ROWS_VERSION` 3）和代码不同，或游标对不上了，行全部丢掉从头推。

从头推（`look.ts` 的 `rebuild`）在没有行时发生。推的进程先存下 `meta/build` 认领，每 2 秒更新；另一个进程等它，它不在了或 60 秒没更新就丢掉半成品重推。行都在内存里，超过一百万行先存；只写不读的表（`log`、`find`、`bytime`、`sceneOrder`、`hrev`）每 25000 行一存。事实文件有 5000 个以上时，在标准错误上先说至少几条，每秒报「已推出 n / N」，推完说几条、几秒。

| 表 | 一行是 | 可查的字段 |
| --- | --- | --- |
| `meta`、`ids` | 形状、计数、第一条事实的时刻、存储的变化标记、上次看库的方式、重建的认领；折过的事实号 | |
| `items` | 一样东西：路径、来历、依据、记着的那一版（令牌、指纹、大小、修改时刻，带标记的目录另有第一层每项的令牌）、现状、标记 | |
| `paths`、`alias` | 路径上记着的条目；别名指向的条目 | `paths.parent` |
| `dirs` | 展开的目录和它下面登记了几样 | `parent` |
| `seen` | 展开的目录上次列出的一层：令牌、前 200 项、至少还有几项、散文件 | `loose`、`more`、`token` |
| `tokens` | 看库对一个登记过的位置的预期 | `token` |
| `marks` | 一样东西的标记或现状，或展开的目录里一个没人登记的东西 | `kind`、`sig` |
| `taken`、`left` | 看库认出挪到这里的条目；主人留着不登记的路径 | |
| `log` | 活动的一行，新的在前 | `who`、`agent`、`scene`、`news` |
| `scenes`、`sceneOrder` | 一个场景；场景按开始时刻，新的在前 | |
| `touch` | 一个场景动过的一样东西；一个行动者来过的一个场景 | |
| `actors` | 一个行动者：第一次来、上次查、上次的场景、几次会话、放进几样 | `kind`、`grant` |
| `history`、`held` | 一样东西的每一版和说过的话；一份留存 | |
| `find`、`bytime` | 找要配的东西或场景；按最近改动排的位置 | `scene`、`origin`；`show`、`live` |
| `stats`、`hrev`、`requests` | 一个 UTC 小时的计数；每小时结束时要收拾的有多少；一个请求的现状 | |

#### 入册和改

- `onPut` 的事实带存储说的令牌和修改时刻；复制放入带内核给的指纹，登记和挪不带，也不为它读内容。
- 同一路径已在册：令牌相同，或令牌不同而记录有指纹、读一次内容相同，就是同一份，不写事实，新令牌记成基线（`rebase`）。记录的来历不明或只是看到的、这次说了来历时，写一条别名 `item.enter`，答「已补上来历」或「已更正来历」。
- 一页散文件的登记（`register-files`）写一条 `items.enter`。带标记的目录入册时另记它第一层每项的令牌（一览，最多 200 项）。挪来的东西没人登记过，以来历不明入册。
- 放入带的 `note` 记在这次的 `item.enter` 或 `item.revise` 上；这次不写事实时，记成关于它的一条备注。
- `revise`：经存储把旧内容复制进 `held/<条目>/<键>/<名字>`。键是指纹，没有时是令牌 sha256 的前 16 位；已有的那份不再复制。知道指纹而复制出来的对不上，就不留，答 `declined`。之后 `onPut` 记一条带留存位置的 `item.revise`。
- `onSay`：只说一句、不关于任何东西的话只写一条事实，不读行。`say revised` 只在令牌变了、记录有指纹时读一次内容。`onArchive` 记 `item.move` 带 `archive`。

#### 怎么看库

`check`、`start`、首页、库页、状况页、条目面板、`onAsks` 和不写目录的 `ledger register` 先看一遍库（`look.ts` 的 `refresh`），同一时刻、同一会话只看一遍。看库只改行，不写事实；改了现状只重算它和依据它的东西的标记（`settle.ts`）。`inspect`、找、场景、活动、统计、留存只折新事实，不看库。

- 变了什么问 `tools.storage.changed`，带上次存下的标记。答得出、动过的位置不多于 1000 个时，只看那些位置上、里面一层和上面的登记过的东西和展开的目录。否则（存储说不准、多于 1000 个，或这次折的事实点到的多于 1000 个）让存储拿行比：先 `seen` 再 `tokens`（`lookRows`），只看答回来的不同的。从不走库。
- `tokens` 一个位置一行：一致的存记着的令牌，变了的存上次看到的令牌，不在了的存 `empty`。还不知道令牌的、挪走了的不写，存储总把它答回来。
- 令牌没变就是记着的那份。变了，只在有指纹（或依据它的东西记过指纹）时读内容判，一次最多 8 个：一样就是只碰过，记成新基线；不一样是被直接改过的。没有指纹的、种类变了的，算被直接改过的。正被写入的位置按记录算。
- 带标记的目录比它自己和第一层每项的令牌。更深处的改动只从变化日志看得到（`changed` 的 `within`）；`inspect` 说「上次看：<时刻>，到第一层」或「…，按变化日志，到任意深处」。
- 展开的目录只在自己的令牌变了时再列一层，最多 200 项。没人登记的文件是「没人登记过的」，目录是「没登记的目录」，里面不进。
- 挪动只认展开的目录里的文件：恰有一个散文件和一个不在了的条目大小、修改时刻都对得上才算，`check` 把它记成看到的 `item.move`。

#### 查和深查

`onCheck` 带 `deep` 时先深查，再看库，然后从行里取：自上次以来；可能过期的；来源不在的；上游有标记的；没人登记过的；没登记的目录；被直接改过的；不在了的；挪过的。

- 每节最多点名 20 样，多的写「……共 N 样，看全部：show ledger.standing --kind <种类>」，节的 `data` 是 `{ count, shown }`。计数到 10000 时说「至少」。
- 每次记一条 `checked`。「上次」是这个行动者上次查的时候，没查过时是它上次在别的场景里留下事实的时候。首页的「都看过了」就是主人查一次。
- 「自上次以来」不列自己的事实和这次会话的事实，最多 20 条，最多翻 2000 行活动；带 `setup` 的主人命令在这个行动者第一次来之前的不算，`init`、`grant issue`、`grant revoke`、`skill install` 不列。

`check --deep [<目录>]` 是有名字的全量动作：先从计数说要读几样，一页 100 样、一次 8 个地读登记过的每样东西的内容，每页报进度、存一次，停下时做完手上那页。有指纹的：不同是变了，相同而令牌变了是只碰过。没有指纹的：令牌没变就记下读到的指纹。读不了的另列。没人登记的和噪音不读。答复第一节「按内容查」每种最多点名 20 样。

#### 找和看

- `onFind` 只问行，不读文件：按路径、说过的话、放入的说明、出处配条目（每样最多 12 句，每句 300 字），按说过的话配场景，每个场景带最多 20 样；最多取 2000 条来排。`find --scene`、`find --origin brought|made` 只读那部分行。`start` 的找里，调用者这次会话的东西只按路径配。
- `onFound`：别的插件找到的路径，给它的场景和来历。
- `onInspect`：一样东西的来历、现状、依据和依据它的；一个场景的卡；`@<授权>` 给「来过」一节。行里没有的路径才经 `tools.resolve` 和存储看一眼。

#### 问主人

`onAsks` 为没人登记过的东西一处一问，最多 20 问（`unowned.ts`）：

- 有散文件的展开的目录：「<目录>有 N 个文件还没登记。都记为你带进来的吗？」（只列了前 200 项时写「至少 N」）。推荐「都记为我带进来的」（`ledger register <目录>`），另一个「不登记，不再问」（`ledger leave <目录>`）。
- 没登记的目录：「<目录>/ 没登记：<探查的话>。」三个回答没有推荐的：「登记成一样东西」（`put` 登记，主人带进来的）；「登记里面的文件」（`ledger register <目录> --inside`，先问「要登记 <目录>/ 里任意深处的全部文件：N 个，不含噪音。」）；「不用管」（`noise add <目录>`）。
- 多于 20 处时，第 20 问说还有几处，都在 `pneuma-base show ledger.standing --kind unowned`。

#### 命令

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `ledger held list [--all]` | 主人和 agent，只读 | 列前 20 份留存，`--all` 全列 |
| `ledger held restore <库内路径或条目号> [--fingerprint <指纹>] --to <新的库内路径>` | 只有主人 | 把一份留存取回到空着的新路径 |
| `ledger held drop` | 只有主人，破坏性 | 拿掉整个 `held/` |
| `ledger register [<目录>] [--inside]` | 只有主人 | 把没人登记过的文件以「主人带进来的」入册 |
| `ledger leave [<目录>]` | 只有主人 | 散文件照原样留着，不再问；状况页仍列着 |
| `ledger stats [--period 7d\|30d\|all]` | 主人和 agent，只读 | 用字回答统计页，不留记录 |
| `ledger export --to <库外的文件> [--since] [--until] [--format jsonl\|csv]` | 只有主人，只读 | 导出活动 |

- `held restore`：`--fingerprint` 按键的开头认，不写取最近的。目标要在内容里、不在带标记的目录里、空着；已是同一份内容时不复制。目录整棵取回并写上标记。取回的以主人带进来的入册，出处「留存：<路径> 换下的旧内容 <键前 8 位>」。拒绝：`no-such-item`、`no-such-held`、`outside-library`、`inside-bundle`、`would-overwrite`。
- `register` 不读内容，每样带一览给的令牌、大小、修改时刻，每 500 样一条 `items.enter`。不写目录登记所有展开的目录里的散文件，写了目录（`.` 是根）只登记那一层。
- `register --inside` 要写目录，是有名字的全量动作：先用预算 5000 的 `probe` 说有多少，再逐层一页 1000 项地取，报进度；停下时写完手上那批，说还剩几个。噪音、内核在根上的名字、已登记的和带标记的目录里面的不登记。

#### 页

长的列表一页 50 行（`PAGE_ROWS`）。

- `ledger.items`（库）：左边文件夹的树（最多 2000 个），选一个只看那里；右边一张表，按最近改动排，文件夹里按路径排。列是路径、来历、谁、现状、时间。「显示」有全部、带进来的、做出来的、已归档。表下列出这个文件夹的没登记的目录，前 20 个带探查的话和三个回答。
- `ledger.activity`（活动）：一节折着的「导出」给出 `pneuma-base ledger export --to ~/Desktop/pneuma-base-活动-<日期>.csv`；事实按天分组，新的在前；筛选「谁做的」（全部、agent 做的、主人做的）和「哪个 agent」；归档和取回带撤销。
- `ledger.scenes`（场景）和 `ledger.scene`（场景页，不进导航）：场景页有时长、放入、依据、决定四个数，对话在哪和接着聊的命令，这次会话里发生的。
- `ledger.standing`（状况）：`check` 的那几节，参数 `kind` 只看一种。全部的和被直接改过的页上有「按内容查」，先说要读几样。
- `ledger.held`（留存）：东西、留存、大小，「清掉全部留存」先确认。
- `ledger.home`（首页的一部分）：「对你的 agent 说一句」；「自上次以来」按场景分组，带「都看过了」；「需要留意」每种一行，没人登记过的和没登记的目录不在这里，它们是问。

#### 条目面板里的「来历」

数据是 `inspect` 用的 `itemView`，面板先看一遍库。次序：现状、内容（「还没读过」或「读过 · <指纹前 12 位>」）、何时、谁、场景、在哪；然后「怎么来的」「发生过什么」「凭什么」「被什么依据」「留存」，长的各自分页。动作都经两个面，已归档的没有：

- 「读内容」（`check --deep` 只读这一样），在有东西依据它而内容从没读过，或它被直接改过而现在的还没读时给。
- 来历不明的给「记为带进来的」「记为做出来的」；被直接改过的给「认下这次改动」（`say revised`）。
- 总有「补上依据」（`say from`）、「记一条决定」、「记一条备注」；每份留存给「取回到新路径」。

#### 统计与导出

`ledger.stats` 和 `ledger stats` 是同一个答复：`fold` 把每条事实数进它那个 UTC 小时的一行（`stats`），每小时结束时要收拾的另记一行（`hrev`）。统计只读这段时间的那些小时，不读文件、不看库，所以和库多大无关；第四问的数是「按账上的记录」，页上这么写。

- 四节：用起来了吗、以前的东西被接着用了吗、谁做了什么、库收拾得怎么样。每节一句带数的话，加一张图。
- 时段：`7d`、`30d`（缺省）、`all`，从本地零点算。图按天分格；多于 31 天按周（周一起），多于 26 周按月。被接着用得最多的列前 5 个；agent 多于 4 个时会话图只画最多的 3 个，其余并成「其他」。
- 请求按现状分：还在等、撤回、拒绝、批准了做成、批准了没做成。

每个数的意思（`stats.ts`）：

- 放进来的：这段时间里第一次入册、来历是带进来的或做出来的东西，按入册时的来历分。别名、来历不明的入册、`ledger register` 一次登记的原有东西都不算，最后一样记在主人那一行。
- 会话：这段时间里开始的会话。开始指某个 agent 在这个场景里留下第一条事实，「看过了」不算。会话归在那个 agent 名下，按开始的那天数。
- 用了库里已有的：这段时间做出来的东西里，依据里至少有一样库里的东西。依据是现在记着的，含之后 `say from` 补的，不含它自己。
- 用了别的会话留下的：依据里至少有一样是在别的会话里入册的。
- 用了别的 agent 带来或做出的：依据里至少有一样是另一个 agent 入册的。agent 按名字比，不看授权；主人入册的不算。
- 被接着用得最多的：这段时间做出来的东西里，有几样的依据写了它，带上是谁做的；已清掉的不列。
- 谁做了什么：每个 agent 这段时间开始的会话、带进来和做出来的东西、决定、备注、请主人做的事。主人这一行是做了几次操作（只读的不算），其中批准和拒绝了几个请求，放进几样，记了几条决定和备注，一次登记了几样原有的。
- 可能过期：没清掉、没并入带标记的目录、没归档的东西，依据里有一样记着的内容后来换了，或已清掉。
- 直接改过、还没人认的：同上的东西，最新一份内容是看到的直接改动（`how` 为 `observed` 的 `claimed` 改），还没人说是谁改的。
- 来历不明：同上的东西，入册时没人知道来历，之后也没人补上。
- 已归档：没清掉、在归档区的东西。另说这段时间归档、取回、清掉了几样，记下了几次直接改动（`claimed` 的改，说的和看到的都算）。
- 要收拾的怎么变：每一格结束时前三样各有多少；「开始时」是这段时间开始的那一刻。

`ledger export` 写的每一行就是活动页的一行，新的在前，从 `log` 一页 1000 条地读写。`--since` 含那一刻，`--until` 不含；只写一天时按本地时间，到那天结束。不写 `--format` 时 `.csv` 结尾写 CSV，否则写 JSON Lines。文件要在库外（`inside-library`），不覆盖（`would-overwrite`），时刻不对是 `bad-moment`。导出本身是一次只读的主人面操作，照样记成一条事实，出现在下一次的导出里。CSV 带表头和 UTF-8 字节序标记，按 RFC 4180 加引号，行尾 CRLF；JSON Lines 的键就是列名。列依次是：

- `id`（事实号）、`at`（ISO 8601 的 UTC 时刻）、`actor`（agent 名，主人写「主人」）、`actor_kind`（`agent`、`owner`、`plugin`）；
- `grant`（授权名，撤回了写授权号，没有是空的）、`session`（全的场景号）、`kind`（事实的种类）；
- `path`（入册和挪动写事实记的路径，别的写那样东西现在的路径）、`text`（活动页上的那句话）；
- `whose`（`agent`、`owner`、`approved`、`observed`）、`request`（这条涉及的请求号）。

有进程在听时，`check` 和首页的代价跟着变了的东西走；没人在听时存储拿行全比，跟着登记过的东西个数线性长；从头推行跟着事实文件个数走。量它的脚本是 `scripts/bench-line.mjs`、`bench-changes.mjs`、`bench-register.mjs`、`bench-ledger.mjs`，数在 第 13 节「性能目标和基准」。

### 版本

`packages/plugin-version`。声明了「有版本」的东西，每一版的内容都留着，任何一版能导出到库外或放回来。它只留住声明过的东西的旧版（`keeps` 是 `some`）：没声明的东西被换掉、又没有别的插件留住时，内核以 `would-overwrite` 拒绝，带上它的话「先 say versioned …」。

`say versioned <路径> [一句话]` 声明并把当前内容记成第 1 版，已声明过时那句话写在当前这一版上。`say version <路径> <一句话>` 给当前这一版写说明，当前内容在工具之外改过时先记成一版。路径在带标记的目录里面时，说的是那个目录。

| 钩子 | 它做什么 |
| --- | --- |
| `onPut` | 放入或登记后，内容和最近一版不同就记新一版，`note` 是这一版的说明；挪动跟着改路径，`onArchive` 也是 |
| `revise` | 只对声明过的答 `held`，先把工具外的改动记成一版；没声明的答 `declined` |
| `onCheck` | 一节「有版本的东西」：工具外改过、已记成第几版的；不在了的 |
| `onInspect` | 时间线，最新的在前，最多 10 版 |
| `observe` | `archive purge` 后记 `gone`，各版内容照样留着 |
| `onView`、`onItemView` | 页 `version.things`；面板里的时间线和动作，没声明的给「声明有版本」 |

版本号数全部的版，清掉的也算，号码永远不变；和更早一版相同的标「同第 N 版」。页 `version.things` 一张表一页一页地列出：路径、版本、最近一版、说明、状态，只为这一页上令牌不同的读状态；筛选「归档的」缺省不显示。

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `version list <路径>` | 主人和 agent，只读 | 列出每一版 |
| `version export <路径> --version <n> --to <库外的目录或文件>` | 主人和 agent，只读 | 把那一版写到库外 |
| `version restore <路径> --version <n>` | 主人和 agent | 把那一版放回来，作为新的一版 |
| `version prune <路径> --keep <n>` | 只有主人，破坏性 | 只留最近 n 版 |

- 导出：`--to` 是已有目录时写到它下面的同名处；先写 `.tmp-` 名再改名；每个文件拿 sha256 核对。在库里（`inside-library`）、已有东西（`would-overwrite`）都拒绝。
- 放回：导出到系统临时目录，再经 `ctx.tools.put` 放到原路径，出处「<路径> 的第 n 版」，所以别的插件看得到、授权的门照样拦。已归档的以 `archived` 拒绝。
- 清掉只删别的版本和东西都不再要的内容，另删 `pending/` 里超过一小时的残留。拒绝还有 `not-versioned`、`no-such-version`、`pruned`、`content-missing`、`export-failed`；随归档区清掉的东西是 `gone`，它的各版内容留在存放里，没有命令再到得了。

**怎么知道变了。** 行 `tokens` 以现在的路径为键，字段 `token` 是最近一版或上次查时的令牌。`check` 和页面让存储按这张表比（`lookRows`），只读不同的，一次最多 8 个：和最近一版不同就记新一版，相同只更新令牌。`check --deep` 是有名字的全量动作：令牌不同的照上面先比，范围内其余没归档的东西，先说几样，一页 100 样地按内容读，每页报进度、存一次，停下时做完手上那页，答复说读了几样。

- 带标记的目录的令牌只代表第一层；深处改动 `check` 看不出，`check --deep` 看得出。写说明时比深令牌（存在 `tokens` 行的值里），所以深处的改动在写说明之前记成一版。
- 放入要换掉一个目录时不信令牌，照样复制比较；放入带来的指纹等于最近一版就不复制。
- `say` 和 `check` 复制前后各看一次令牌，变了就不记，`say` 答「正在被改动」。

| 存放（`.pneuma-base/version/`） | 性质 | 内容 |
| --- | --- | --- |
| `objects/` | 本体 | 文件的一版，`<sha256 前两位>/<sha256>`，相同内容只存一份 |
| `trees/` | 本体 | 带标记的目录的一版，`<指纹前两位>/<指纹>` |
| `pending/` | 缓存 | 复制进来、还没移到地址上的内容 |
| `facts/` | 本体 | `declare`、`version`、`note`、`move`、`gone`、`prune`；旧的 `<场景号>/…jsonl` 照样读 |

行在缓存区：`things`（可按 `path`、`gone` 查）和 `tokens`，丢了从事实重推，下一次 `check` 各读一次内容。

### 同步

`packages/plugin-sync`。库和一个同步目标双向同步：只整份复制，不合并；同步前任何一边有过的每一份内容，同步后都还在两边的某处，主人有意删掉的除外。只有手动的 `sync now`，没有后台进程。不听任何「说」。`node:fs` 只用在目标目录（`target.ts`）和缓存目录里的基线（`baseline.ts`）。

| 钩子 | 它做什么 |
| --- | --- |
| `onPut`、`onArchive`、`onPurged`、`catchUp` | 把登记、放入、挪动、归档、清空和补上的每一页记成同步自己的事实（`things`、`moved`、`gone`） |
| `observe` | 破坏性的主人面命令做完后记 `deleted` |
| `onCheck`、`onView`、`onItemView` | 「同步冲突」：还在原处的冲突副本；页 `sync.status`；冲突副本和有冲突副本的东西的一节 |

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `sync target set --kind dir --to <目录>` | 只有主人 | 设这台机器的同步目标 |
| `sync now` | 主人和 agent | 现在同步 |
| `sync status` | 主人和 agent，只读 | 目标、上次同步、待同步的数目、冲突副本 |

**带什么。** 登记过的东西（内容区和归档区；带标记的目录按内容规则连同标记），没人登记过的不带也不看。记录区里，`recordPlaces()` 名下每个记录处的事实和自己的地方，插件声明为缓存的目录除外；推这些，拉目标上有的每一个。不带 `.pneuma-base/config.json`、`PNEUMA-BASE.md`、存储的 `tmp`、`trash`、`holds`、`cache`、行和 `noise.json`。

**比什么，什么时候读内容。** 同步不走库。

- 本地：表 `things` 以库内路径为键，字段 `token` 是上次读时的令牌（带标记的目录是深令牌）。存储带 `deep` 一页一页地比（`lookRows`），只读不同的、没读过的、只在基线里的，一次 16 个。多于 5000 个文件的目录算变了。
- 记录处自己的内容：每处一张表 `own:<记录处>`；变了的文件重读，变了的目录只重列那一层。
- 事实：每个记录处在目标上一个游标，一页 10000 条 `facts.since`；事实以规范 JSON 的 SHA-256 认，推不推拉来的。拉是把别的库的流里没读过的文件整个带进那个记录处（`carry`），名字由流和文件定，同一个文件带两次等于一次；文件里的事实这里都有了就不带。
- 目标：各 `lstat` 一次（大小、修改时刻、inode）和基线比，变了的才算指纹；目录指纹是每个文件 `<路径>\0<SHA-256>\n` 按字节序排，标记和噪音除外。

| 目标上的位置 | 内容 |
| --- | --- |
| `<目标>/<库内路径>` | 登记过的东西 |
| `.pneuma-sync/id` | 目标的标识；没有它基线不适用，当第一次同步 |
| `.pneuma-sync/tmp/` | 临时名，写完改名到位 |
| `.pneuma-sync/own/<记录处>/<位置>` | 每个记录处自己的内容 |
| `.pneuma-sync/facts/<记录处>/<库标识>/<序号>.jsonl` | 每个库写的事实，每次同步每处一个新文件 |

**一次同步。** 拉事实，折进行；建本地、目标、基线三张表，按键 `decide` 和 `plan`；执行；记 `conflict`、`things` 和 `run`，推本库的事实，存基线。`sync status` 和页面算同一个计划，不执行，没拉的事实只折在这次计划上。

- `decide` 按三处指纹定不动、推、拉、冲突、删；没有基线时两边不同算冲突。
- `plan` 再补一遍：会从两边都消失的内容，冲突时目标那份拉成 `<名字>.conflict-<机器>-<时刻><扩展名>`（重名加 `-<n>`），本地那份同次推上去；内容区以外被删的放回原处；其余复制进 `_archive/<路径>`，重名加指纹前 8 位。
- 执行先留存、再复制、最后删除；每步核对是计划看到的那份，不是就跳过留到下次。库这边经存储带预期写（`write`，目录再 `markBundle`；记录处的内容经 `carry(<名>)` 复制进去），删带令牌；不经 put。目标出错停下，以 `target-failed` 拒绝，做完的记进基线。

**主人有意的删除。** `archive purge`、`ledger held drop`、`version prune` 删掉的内容不再被放回。`observe` 在破坏性命令做完后，把基线里有、行说库里已没有的键连同指纹记成 `deleted`。一条删除只在指纹等于这个键的基线时算数；没有基线时宁可留下。了结的删除记进基线，不再算数。上次同步后、破坏性命令前手动删掉的东西也会算进去。

**目标。** 只有 `dir` 一种。按机器记：用这台机器最后设的，没设过用任何机器最后设的。拒绝：建不了目录 `target-unreachable`，和库互相包含 `target-overlaps`，没设 `no-target`，目录在这台机器上不存在 `target-missing`（不替它建，没挂上的盘会被当成空目标）。

| 存放 | 性质 | 内容 |
| --- | --- | --- |
| 同步记录处的事实 | 本体，同步 | `target.set`、`run`、`deleted`、`things`、`moved`、`gone`、`conflict`；旧的 `facts/*.jsonl` 照样读 |
| 同步记录处的行 | 缓存 | `things`、`copies`、`deleted`、`meta`、`own:<记录处>`；丢了只是重读内容 |
| `<缓存目录>/baseline-2.json` | 本机 | 按目标：两边都有的键和指纹、目标上的状态、每处的游标和读到的流文件、了结的删除；只认 `format: 2` |

### 部署

`packages/plugin-deploy`，名字 `deploy`。agent 用 `say deployable <库内路径> [一句话]` 声明一样东西可以部署，声明不让它上线；主人的开关决定在不在线；开着的东西，目标上跟着库里当前的内容。

它是 sdk 的部署库加两种目标：`deployPlugin('deploy', [dirTarget, commandTarget])`。部署库（`packages/sdk/src/kit/deploy/`）拿插件名和目标交回整个插件，第三方只写目标；它不导入内核，读写都经 `tools.storage`。决定表、状态表、状态 × 操作的全化表、站点名规则和目标接口在那里的 `README.md`。几个部署插件都认领 `deployable`，第二个在 `plugin add` 时以 `name-taken` 拒绝；要发到几种地方，是一个插件带几种目标。

| 钩子 | 它做什么 |
| --- | --- |
| `onSay` | 听 `deployable`；已归档的以「取回之后再声明」拒绝 |
| `onPut`、`onArchive` | 放入、登记、挪动、归档、取回之后对那样东西对一遍 |
| `onInspect`、`onCheck` | 状态、地址、开关、站点名；「线上和库里不一致」，读不懂的记录另列一节 |
| `onAsks` | 主人从没动过开关的，每样问「<路径> 可以部署，还没上线。要上线吗？」，推荐「上线」，另一个「不上线」；两个都记下开关 |
| `onPurged` | 先撤下站点，再去掉声明；撤不下就报错，`deploy sync` 再试 |
| `onRemove` | 还有站点在线时拒绝卸下；`plugin remove deploy --anyway` 照样卸 |
| `onView`、`onItemView` | 页 `deploy.sites` 和目标自己的页；面板里状态、开关、地址，没声明的给「声明可以部署」 |

目标失败时放入、挪、归档照样成功：答复带 `problems`，命令行退出码 3，并说上线等主人跑 `deploy sync`。没配目标只是一句答复。

目标上该有什么只看开关、在不在归档区、路径上有没有东西（`model.ts` 的 `want`）。对账（`plan`）先发布再撤旧名，一样就不动；开关、放、挪、归档、`deploy sync` 都跑它，所以重跑结果一样。`deploy sync` 另撤下当前目标上不属于任何声明的站点。状态：在线、待发布、离线、待下线、已归档、不在，目标读不到时不知道。

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `deploy on <库内路径>`、`deploy off <库内路径>` | 只有主人 | 开关，并发布或下线 |
| `deploy target set --kind dir --to <目录>` | 只有主人 | 目标是一个本地目录 |
| `deploy target set --kind command --publish <命令>… --unpublish <命令>… [--url <模板>] [--timeout <秒>]` | 只有主人 | 目标是一对命令 |
| `deploy sync` | 主人和 agent | 把全部声明对一遍 |
| `deploy list` | 主人和 agent，只读 | 声明过的东西、状态、地址 |

- 开关在目标失败时照样记下，以 `publish-failed`、`unpublish-failed` 或 `no-target` 拒绝；没声明的是 `not-declared`。`target set` 的参数由各种目标的开关拼成，`--kind` 只有一种时可不写；选定那种的必填开关由部署库核对（`usage`）。答复提醒没设的密钥，换目标时说开着的还没发到新目标、旧目标上的没撤。

**目标。** 接口是 `TargetAdapter`（`defineTarget`）：`params`、`configure`、`secrets`，打开后是 `publish(站点名, 内容目录, meta)` 和 `remove(站点名)`，可选 `identify`、`serving`、`view`。目标的 `secrets` 成为插件的 `secrets`，经 `pneuma-base secret set <插件名> <名字>` 设。有 `serving` 的目标按它报告的对账，读不到时不动，页面每 30 秒刷新。自带的两种都不报告：

- `dir`：写 `<目录>/<站点名>/` 和 `index.json`（`format: 1`），先写 `.tmp-` 名再换上；地址是 `file://`。目录不能在库里，也不能包含库（`inside-library`）。
- `command`：按引号规则切词，不经 shell 运行；`{dir}`、`{name}` 换成内容复制件和站点名；下线在空目录里跑；超时缺省 120 秒；`--url` 的 `{name}` 换成站点名。

**什么时候读内容。** 只认开着、没归档的。带标记的目录先深看：行 `identified` 存着上次的深令牌和内容编号，相同就不读。发布前向存储要清单（`content` 带 `manifest`），逐个文件 `read` 进 `<缓存目录>/stage/` 的临时目录，拿 sha256 核对，再交给目标；对不上这次不发。多于 5000 个文件的目录存储答 `too_many`：不发也不撤，状态待发布。

| 存放（`.pneuma-base/deploy/`） | 内容 |
| --- | --- |
| `config.json` | 目标 `{ format: 1, target: { kind, … } }`，经 `configFile` 带预期整份写，冲突重试最多 3 次，后写的算数 |
| `facts/` | 经 `recordStore` 写：`declare`、`switch`、`move`、`remove`、`publish`、`unpublish`；读不懂的原样留着，`check` 里列出 |

不报告的目标，「上面有什么」来自对当前目标（按 `key`）的发布与下线记录；换目标后开着的都成待发布。事实折成行（`folded.ts`）：`things` 是声明了的，`alias` 是两台机器各声明一次的同一路径，`sites` 是每个目标上的每个站，`fold` 记着折到的最后一个事实的 id 和读不懂的行。每次钩子、命令和页面从行取，只折游标之后的新事实；折按事实的 id 排，新事实里有排在已折的之前的（同步带来的别的机器的），就从头折一遍。行另有 `identified`。

### 查找

`packages/plugin-search`。装上后 `find` 也匹配登记过的文本文件的正文，按相关度排；主人配了嵌入器时也按意思找。它只索引听到登记过的东西，从不走库，不听任何「说」。

| 钩子 | 它做什么 |
| --- | --- |
| `onPut` | 记 `seen` 或 `moved`，读这次放入的东西进索引，最多 200 个文件 |
| `onArchive`、`onPurged` | 记 `moved` 或 `gone`，索引跟着换路径或去掉 |
| `catchUp` | 补上的每页里不认识的记 `seen`，整页读进索引，不限 200 个 |
| `onFind` | 按词和按意思找 |
| `onView`、`onItemView` | 页 `search.status`；这样东西索引了没有、几块、几块有向量 |

**找。** `onFind` 先补行、问存储变了什么、读待读的（最多 200 个文件），再按词（FTS5 的 bm25）和按意思（余弦，最多 5 样，不到最近那样一半近的不要）各排一次，用倒数排名融合（k = 60）。按词的细节是「正文：」加一段上下文（前 24 字、后 56 字），按意思的是「按意思：…」，只索引了前 1 MB 的写明。带标记的目录里的文件命中时，路径是那个目录。空文字和带过滤的请求答空。`find` 最多 20 条，多出的用一条没有路径的命中说还有几样；`start` 最多 5 条。嵌入失败只按文字找，答 `{ hits, problems }`。几个答复者怎样合成一张表见 第 5 节「找、看、说、查、归档」。

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `search embedder set --kind hash` | 只有主人 | 用特征哈希按意思找 |
| `search embedder set --kind http --url <地址> --model <模型名>` | 只有主人 | 用 OpenAI 兼容的服务 |
| `search embedder clear` | 只有主人 | 只按文字找 |
| `search rebuild` | 主人和 agent，只动缓存 | 删掉索引，全部重读 |
| `search status` | 主人和 agent，只读 | 索引多少、待读多少、嵌入器 |

`embedder set` 设好后试嵌入一次。`search rebuild` 是有名字的全量动作：删掉整个缓存目录，先说要读几样，一页 100 样地读，每页报进度；配了嵌入器时再一批 32 块地建向量，每批报一次。停下时做完手上那页或那批，没读的留着待读，下次 `find` 接着读。向量没建完时以 `embedder-failed` 拒绝，全文部分已重建。

| 存放 | 性质 | 内容 |
| --- | --- | --- |
| `.pneuma-base/search/facts/` | 本体 | `seen`、`moved`、`gone` |
| `.pneuma-base/search/embedder/` | 本体 | 主人选的嵌入器，`<数字>-<十六进制>.json`，每次写一个新文件，名字最大的有效一份算数；不写密钥 |
| 记录处的行 | 缓存 | `things`、`pending`（待读）、`tokens`（读时每个位置的令牌，读不到写 `empty`）、`meta`（索引标识、变化标记） |
| `$PNEUMA_BASE_HOME/cache/<库的 id>/search/index.sqlite` | 缓存 | 索引：`docs`、`chunks`（约 800 字一块）、`fts`、`vectors`（按嵌入器和块的 sha256，挪动的块不重嵌）。删了下次 `find` 重建，登记过的都变成待读 |

- 什么时候读内容：`onPut` 读这次放入的；`find` 和 `rebuild` 开头问 `changed(mark)`，说得出且不多于 200 处时只对那些地方 `look` 比令牌，否则对 `tokens` 整表 `lookRows`。令牌不同的变成待读再读，没变化时 `find` 一个文件都不读。
- 有界：每个文件只读前 1 MB；带标记的目录取 `content` 的清单（一页 10000 条），只读指纹和索引不同的文件；多于 5000 个文件的不索引；一次钩子最多读 200 个文件，剩下的留在待读里。被占、忙、取消的也留在待读里。先写索引再写令牌行，中途断了下次重读，结果一样。
- 文本是合法 UTF-8、不含 NUL 的文件。网页（`.html`、`.htm`、`.xhtml`）只取看得到的字。入索引和查询都用 `searchTerms(…, 'words')`，正文先按句切开。
- 嵌入一批 32 块。`hash` 是 256 维的特征哈希。`http` 调 `/v1/embeddings`，超时 30 秒，地址结尾的 `/v1` 可写可不写；密钥是 `pneuma-base secret set search key` 设的 `key`，作 Bearer 令牌发。旧记录里的 `keyEnv` 照样读，只用来告诉主人改用 `secret set search key`；环境变量不读。
- 索引不是 sqlite 或版本不对就重建；被锁时等最多 30 秒。

## 9. 面

面是进来的路：命令行、管理界面的页、MCP 服务、本机的 endpoint。面没有自己的本事：每一样都经内核的 agent 面、主人面或只读的视图做，各面答的是同一份结果对象。

### 一张命令表生成各个面

命令行是全部本事的准绳，别的面是它的面，答复一一对应：

- 页上的每个按钮是一个动词或一条主人命令（`Call`）；每一页是一条只读的命令，`show` 把它印成字。
- MCP 的每个工具是一个动词，或一条既不破坏也不只给主人的命令；管理的命令不是工具。
- 管理归主人；别的本事 agent 和人一样。

命令表有两部分：动词的参数表（`packages/cli/src/verbs.ts` 的 `VERBS`），和主人命令的 `params`（第 5 节「命令表」）。两者同形：每个位置参数和开关有名字、`hint`、种类，可选 `pattern`、`options`。`VERBS` 有十项：内核的七个动词（`archive` 和 `unarchive` 是同一个动词的两种请求），和命令行加的 `start`、`show`。每项带一句中文的 `summary` 和 `readOnly`。动词的表另有几样主人命令没有的：

- `words`：其余的词用空格连成一句（`start`、`find` 的文字）。
- `more`：没声明的开关收在一个名字下。`say` 的归听这个种类的插件，每个一列值；`show` 的是页的参数，每个一个值。
- `stdin`：这个位置参数写 `-` 时读标准输入（`put` 的）。
- `fromEnd`：写的位置参数比声明的少时，可选的从后面填（`say <种类> <内容>`）。
- `raw`：这个位置参数照原样收下其余的整行，开关也算（`ask` 收的那条主人命令）。

从这张表生成的有：命令行怎样读一个动词的词、定参数个数（`main.ts` 的 `specOf`、`verbValues`）；MCP 服务每个工具的输入；页上调主人命令的按钮的表单（sdk 的 `formOf`）；`show` 把一个按钮印成的命令行（`page.ts` 的 `commandOf`）；`--help` 列出的主人命令；Agent 页「接上的 agent 能做什么」的三组。命令行和 MCP 把读出的值交给同一个 `run`。页上调动词的按钮是内核和插件写出的 `Call`，由内核核对（下面「内核核对块」）。

两个方向都有测试守着：

- `packages/cli/test/pages.test.ts` 顺着链接走遍一个装了全部自带插件的库的每一页。每一页 `show` 印得出，字里有每一格、每个按钮的命令和翻页的命令；每个按钮调得到一个动词或这个库里在的命令，参数合它的参数表（`actionFault`）。每个动词和命令要么在某页上有按钮，要么有一页读的是同样的东西（`READS`，比如 `plugin list` 读 `config`），要么列在 `NO_PLACE` 里写明为什么。
- `mcp.test.ts`：工具是每个动词和每条业务命令，没有管理的命令；按名字调管理的命令，拒绝的理由和字同命令行；输入出自参数表；同样的参数，工具和命令行答的一样。
- `mcp-http.test.ts`：HTTP 上和标准输入输出上列出同样的工具，对同一组调用（`mcp-cases.ts`）给同样的答复，两代协议各走一遍。
- `endpoint-story.test.ts`：`/guide` 和 `pneuma-base guide` 是同一段说明，经 HTTP 和经命令行配对走到同一个状态，一个 agent 从读说明走到它的场景记在它名下。

### 命令行

#### 读一行命令

`main.ts` 分三步读：

1. 拿出到处都能写的：开头的 `@<授权名>`，和全局开关 `--library`、`--as`、`--session`、`--json`。
2. 认出命令名：第一个开关之前的那几个词，取字数最多的那条。内核的主人命令字数多过同名的动词时取主人命令，所以 `archive purge` 不是归档一个叫 purge 的文件。写在命令名前面的开关，`UNDECLARED_FLAGS` 知道它带几个值的，挪到后面再读。
3. 按那条命令自己的开关读其余的。不带值的开关从不吃掉后面的词；带一个值的取下一个词，`--名字=值` 也行；列表取到下一个开关为止。没声明的开关：动词以用法错误拒绝；`say` 的按 `UNDECLARED_FLAGS` 读，表里没有的取到下一个开关；`show` 的各取一个值；主人命令把它当开关，主人面再以 `usage` 拒绝。

`pneuma-base <目录>`，除了开关别无他词，就是 `pneuma-base view <目录>`。

定库：`@<授权名>` 同时定下库和身份，再写 `--library` 或 `--as` 是用法错误；没有授权文件时用 `--library <库的目录>`，可加 `--as <agent 名>`。不用指明库的主人命令不带库跑；`skill install` 的库由它的授权名经本机的授权副本定出。

`VERBS` 之外，命令行自己的命令还有 `guide`、`pair request`、`pair status`、`mcp`、`init`、`plugin new`、`view`，都不经主人面。`guide` 和 `pair` 给还没接上的 agent（第 5 节「配对」），`mcp` 见「MCP 服务」，`view` 见「界面的服务」。`--help` 印用法和主人命令的清单：带 `--library` 或 `@<授权名>` 时是那个库能用的，否则是内核的。

#### 退出码

| 码 | 什么时候 |
| --- | --- |
| 0 | 答了：接受，或只是读 |
| 1 | 用法错误（标准错误上一句「用法错误：…」和用法），或出错；什么都不写的 `pneuma-base` 印用法，也是 1 |
| 2 | 拒绝；`say` 被听它的插件拒绝也是 |
| 3 | 接受了，但有插件报了问题 |

`--json` 印结果对象，不印字。

#### `start`、`show` 和 8 KB

`start "<一句话>"` 是三个动词的组合，不是第八个动词：先「说」在做什么（`doing`），再查上次以来的变化（`--since last`），再按这句话的词找库里可能相关的，跳过这次会话自己的。字分三段：【记下】【库的变化与状况】【库里可能相关的】。

`show [<视图编号> [--<参数> <值>…]]` 印管理界面的一页，只读，也不是动词（「页面和块」）。不写编号列出这个库的页；没有这一页是用法错误。

`start` 和 `check` 的上限属于答复，不属于印法（`format.ts` 的 `checkAnswer`、`startAnswer`），所以命令行的字、`--json` 和 MCP 的结构化内容是同一份答复：

- 每张清单带前 20 条、总数和看其余的命令，节的 `data` 里和字里一样（记账插件的 `{ count, shown, more }`）。
- 整份的字不超过 8 KB，JSON（照 `--json` 印的算）不超过 32 KB。JSON 用字段给字里一行说的东西，一件要主人做的事还带着各个回答的表单，所以是字的四倍。
- 答复按字印的次序一部分一部分地放：各节、你提的请求、各件要主人做的、可能相关的各样东西。放下一部分会越过任何一个上限时就停：它和它后面的，两种形式都不带；`cut` 说少了哪几种、各几个、全部在哪看（状况在 `show ledger.standing`，要主人做的在首页的「等你决定」，可能相关的用 `find`），字的最后一行说同样的话。

库再大，这两个答复也放得进 agent 的上下文。`find` 一页 20 样（同一路径的几条命中算一样），多了答一共几样和下一页的命令（`--page`）。`inspect` 印一个目录的一层时只列前 20 项，后面写总数和 `show files --dir <目录>`，JSON 带一览的 200 项。`show` 的每一页按「分页」分页。

### 页面和块

管理界面是内核的一个客户端：看东西用视图，改东西用 agent 面的动词和主人面的命令。

#### 视图是只读的命令

```ts
viewerFace.views(library): ViewList   // { views: ListedView[]; problems }
viewerFace.show(req: ViewRequest, call: { ctx; table; env; viaGrant }): Promise<ViewResult>   // 'shown' | 'no-such-view' | 'refused'
```

- 视图不是操作：不改东西，不发事件。K5 说的是两个面的操作。
- 答复是带类型的块：`ViewAnswer` 有 `title`、`subtitle`、`blocks`，可选 `refresh`、`filters`、`open`。块、动作、视图的类型在 sdk 的 `types.ts`，不含任何插件的类型（K3）。
- `views` 先列插件的视图，按配置次序，后列内核的（`viewer.ts` 的 `KERNEL_VIEWS`）；每个带是谁给的（`by`）。插件的视图编号不以 `<插件名>.` 开头的不列，列进问题。
- 没给的筛选取它的 `default`，由内核填。
- 管理的页声明 `ownerOnly`（内核的 `agents` 和 `config`），在 agent 的会话里以 `agent-session` 拒绝，话和判断同只给主人的命令（`ownerOnlyRefusal`、`agentSign`）。别的页 agent 带授权或 `--as` 都能看。
- 插件的 `onView` 抛错或答的不是一页，那一页换成一个空状态，说插件出错了（K8）。插件还在补装上之前登记的时，它的每一页最上面多一节「装上之前登记的」，带「接着补」。
- 视图在界面的服务所在的机器上运行，用那台机器的时区；格里的 `at` 由网页按浏览器的时区显示。

#### 什么时候重取

界面重取一个视图只在这几种时候：打开的视图、参数或标签变了；库的摘要（`/api/rev`，每两秒问一次）变了；做完一个动作；答复带 `refresh: <秒>` 时每隔这么久（少于 5 秒按 5 秒）；连不上服务之后又连上；Mac 应用说它做了什么。所以视图可以读库外的东西（比如部署目标上的状态），只要不写。状态来自库外的视图带 `refresh`，内容随时钟变的（比如「最近 30 天」）也可以带。视图记了事实，或在展开的目录里写了东西，摘要就变，界面每两秒重取一次：这是插件的错。

#### `show` 的文字

`show <编号>` 和界面走同一个 `viewerFace.show`，文字是块的如实转写（`packages/cli/src/page.ts`）：

- 页的标题、副标题；筛选写成「标签（--名字）：选项 数目 · …」，正在用的标 `*`。
- 分节是 `#` 标题带数目，下面是说明；字段是「名字：值」；语气是警告或出错的文字，前面写「警告：」「错误：」；时刻按命令行的习惯写 UTC 的分钟（`YYYY-MM-DD HH:MMZ`）。
- 表格对齐成列，带表头，不截短；标签写成 `[标签]`，外部地址照写；行的链接在最后一列，写成打开它的 `show` 命令。
- 预览写路径，外部页面写地址，空状态写标题和提示，`custom` 写它的 `text`，图表写那句话和一张数表。
- 时间线和 `feed` 一行一条；树的每个节点印成打开它的命令；步骤写成 `[✓]` 或 `[ ]` 加标题。
- 块上的每个动作印成做同一件事的命令，比如 `$ ledger register scans --inside  # 登记里面的文件（只给主人）`。agent 的会话会被拒的标「（只给主人）」，要先问的跟着「；先问：」和问话，没填的输入照用法写成 `<提示>`。
- 长列表下印「第 21–40 项，共 523 项」和「下一页 → show …」「上一页 → show …」。
- `--json` 给的是同一份答复对象，一页的行数和印的一样（「分页」）。

不写编号时，每页一行：编号、标题、谁给的、筛选（`[--名字 值|值]`），只给主人的和只从链接打开的另外标出。

#### 首页（`home`）

界面打开时的那一页（`home.ts`），从上到下：

1. 「开始」：还有没做完的步骤时才有（`start.ts`）。步骤每次按库和这台机器的状态算出，不存任何标记。内核给两步，插件的首页视图可以再加（下面）。做完的一步折成一行，写着做成了什么；全都做完，「开始」就没了。
2. 「等你决定」：一个 `asks` 块。先是还在等的配对（第 5 节「配对」），再是 agent 提的、还在等的请求（第 5 节「请主人做」），然后是每个插件 `onAsks` 给的事，由它的认知段标题署名。没有时一句灰字。
3. 每个插件标了 `home` 的视图的块，按配置次序，用默认参数。
4. 一个这样的视图都没有时，一句话说明（没装插件，或装着的插件没给首页添内容），下面是库的根目录，就是文件页。

内核的两步：

- 「接上你的 agent」：这台机器上找到的或已接上的产品各一行，带记号。接上的标「已接上」，写接法和授权；没接上的带「接上」，就是 `agent connect <产品>`，一下就做，不出表单。一个都没找到时一句话说看了哪里。这个库的 endpoint 在跑时，下面是那句可以复制的话。有 agent 接上就算做完。
- 「放进第一样东西」：一个 `drop` 块，放进 `inbox/`。只看库的根目录的一页（前 50 项）：有内核自己的和以 `.` 开头的名字以外的东西就算做完，写「库的根目录里有 N 样东西」，这一页没列完时写「至少 N 样」。

插件给首页添东西：视图声明 `home: true`，它的块就放在「等你决定」之后；它照样可以不进导航（`nav: false`）。答复里的 `steps` 块不放在原处：它的步骤接在内核的两步后面，并进「开始」，「开始」在不在由合起来的步骤定。要主人回答的事不画在自己的块里，用 `onAsks` 说（第 5 节「插件机制」），首页和 `check` 都带上。记账插件这样给出「自上次以来」「需要留意」和第三步「对你的 agent 说一句」（第 8 节「记账与对账」）。

#### 文件页（`files`）

库的一个文件夹的一层，参数 `dir`（`files-page.ts`）：

- 存储的一览，一页 50 项，按名字排，文件夹和东西混排。根上的 `PNEUMA-BASE.md` 和 `_archive/`、各处的标记文件不列；藏起来的项由后面的项补满一页，数目照实。不在根上时第一行是 `..`。
- 展开的目录链到下一层。
- 没登记的目录一行：图标 `folder-dot`、标签「没登记」、一次探查的话（「31 个文件，像一个项目（package.json、.git）」「至少 500 个文件」），和它的回答：插件为这个地方问的那几个（记账插件的三个），没有就是内核的两个，「登记成一样东西」「不用管」（`noise add`）。点这一行照样走进去。一样东西里面的文件夹，和没有插件记登记时的文件夹，都只是文件夹。
- 文件和带标记的目录各一行，链到条目面板。带标记的目录图标是 `package`，标着它第一层的项数，不往里走。内容只在别处的文件标「只有占位」，大小一格写内容在哪、多大。链接和特殊文件灰着写「链接或特殊文件，不算库里的东西」。
- 最上面「从这台机器放进来」：以带进来的放入一个文件。页交不出标准输入，目录从命令行放。

#### 归档区（`archive`）

`_archive/` 的一个文件夹的一层，同样一页 50 项、分页。每样东西写它原来的路径和在归档区的位置，带「取回」；带标记的目录是一行；文件夹链到下一层。要看的文件夹已经没了（最后一样被取回）时给归档区的根。整区一个「清空归档区」（`archive purge`），先问。

#### Agent 页（`agents`）

只给主人（`agents-page.ts`），四节：

- 「接上的 agent」：各一行，记号和产品名。灰的一行写接法、区域（整个库，或「区域 x/」）、只读还是读写、授权名和产品名不同时凭哪份授权、接上时写的东西在哪，然后是各插件对 `inspect @<授权名>` 说的（记账插件说它最近一次来）。接上时写的东西不在原处时是一个警示标签，说哪样不在了。各带「断开」，先问。一个都没有时是空状态。
- 「让 agent 自己接上」：endpoint 在跑时那句可以复制的话，和这个库最近 20 个配对，各带状态，在等的带「允许」「拒绝」。endpoint 没在跑、也没有过配对时没有这一节。
- 「这台机器上找到的」：找到、还没接上的产品各一行，带记号、接法、写到哪和找到它的迹象，各带「接上」，表单问区域和只读；然后是没找到的产品和看了哪里。
- 「接上的 agent 能做什么」：三组，用和 MCP 服务同一条规则从命令表生成。自己能做的：动词，和既不破坏也不只给主人的命令。要你来做的：只给主人的命令，agent 用 `ask` 请，请不了的标出来。红线：破坏性的命令。

#### 配置页（`config`）

只给主人（`viewer.ts` 的 `configPage`）。按钮的表单都由内核命令的参数表生成：

- 库的位置、库标识、说明文件。
- 「插件」：这个 pneuma-base 认识的和库里装了的每个插件，带版本和一句说明（没有 `summary` 用认知段的标题，同 `plugin list`）。装了的带「卸下」，有 `catchUp` 的另带「补上装上之前登记的」；没装的带「装上」，装到这台机器上来的另带「从这台机器卸掉」。另有「从目录装一个插件到这台机器」。
- 「授权与技能」：每份授权带「为 Claude 生成技能」「为 Codex 生成技能」（目录可以写 `~/…`）和「撤回」；「发授权」；Codex 要把库加进可写目录的提示。
- 「密钥」：已装插件声明的密钥，各带设没设和「设」（设过的是「换一个」），设过的另带「删掉」。值经 `Call` 的 `stdin` 交给命令，不进事件。
- 「存储」（`storage-commands.ts` 的 `storageSection`，数据同 `storage list`）：这台机器上的存储提供者，各带版本、地址的写法、来历；这个库在用的标「这个库在用」，带它给得出的面。装上来的带「换新版本」「卸掉」，官方的、没装的带「装上」，最后是「安装别的存储…」（第 3 节；`packages/viewer/e2e/config-storage.spec.ts` 在页上走一遍）。里面一节「噪音」：库根上声明的每个名字和路径，各带「去掉」，和「加一条」。

#### 条目面板（`item`）

一样东西，参数 `path`，开在右侧面板，不在导航里（`item-page.ts`）。次序固定：

1. 一行说它是什么和一句状态（`文件 · 2.1 KB`，已归档的、是谁的一部分的跟在后面）。
2. 每个插件 `onItemView` 给的一节，按配置次序。节名由插件给，节上盖着插件名（`plugin`），插件之间互不认识；节带的 `actions` 并进底下那一行。`onItemView` 的第三个参数是面板的参数和 `size`。插件抛错时那一节说它出错了（K8）。
3. 「文件」：存储此刻说的它（路径、种类、大小、改于，知道指纹时它的前 16 位）和它的面：建于（和改于不在同一分钟时）、下载自（每个地址一行，http 和 https 的可点）、带进来的程序、标签、「这台机器上」（只有占位时，说内容在哪、多大）；不认识的面每个字段照原样一行。带标记的目录里面的文件说它是谁的一部分。
4. 带标记的目录接着是「第一层」，在面板里分页，文件链到自己的面板，文件夹链到文件页。文件接着是可以折起来的「预览」。只有占位的不给预览（读它会把内容拉回来），那里是「取回内容」：调 `inspect` 带内容和 `fetch`，存储取回来后，面板重取时预览就在了。
5. 最后一行动作：没归档的「归档」「挪到」，已归档的「取回」，带标记的目录里面的文件都没有；然后是各插件节的 `actions`。

路径上不是一样东西时：展开的目录说里面有登记过的东西，带「在文件页打开」；没登记的目录写「没登记。」和探查的话，带它的回答；两种都接着是分页的第一层和插件的节。噪音说按哪个名字或哪条路径，带「不再当作噪音」（`noise remove`）。路径上没有东西时说不在，插件的节照常给；`_archive/…` 的东西被取回后，面板跟到它原来的路径。答复带 `icon`（`file`、`image`、`package`、`folder`、`folder-dot`），面板的标题和标签用它，不用视图的。

#### 块

块的种类有十八个：`section`、`table`、`fields`、`list`、`timeline`、`text`、`preview`、`actions`、`empty`、`embed`、`custom`、`feed`、`stats`、`tree`、`asks`、`steps`、`drop`、`chart`。每种的字段，和 `Cell`、`Action`、`Call`、`Paging` 这些类型，完整的参考在 PLUGINS.md 第 4.4 节；插件自己画的页在第 4.5 节。这里只写内核和网页做什么。块的字段只加不改，新加的都是可选的，写好的插件不用跟着改。动作的 `confirm` 由网页弹框问，人点了确认就是内核要的当面确认；主人命令的 `Call` 带的 `stdin`（比如密钥）不进事件。

#### 内核核对块

内核在边界核对插件给的每一块（`blocks.ts`），分节和步骤里的块逐个核。不合的有：

- 种类不认识；缺了必需的字段（类型里不带 `?` 的）；字段的类型不对。
- `feed` 的一行既有 `action` 又有 `settled`；`asks` 的 `suggested` 不在回答里。
- `embed` 的地址不是 http 或 https；`custom` 的 `entry` 不是 `ui` 目录里的相对路径，或插件没有 `ui`。
- `chart` 的系列不是 1 到 4 个（sdk 的 `CHART_SERIES_MAX`），某个系列的数和 `x` 不一样多，叠起来的柱有负数。
- 输入的 `pattern` 不是正则。
- 动作的 `call` 不是一个动词或这个库里在的一条主人命令（`parseCall`）；参数不合那条命令的参数表（没填的输入算给了，填的值到分派时再核）；「说」的种类没有插件听；`call` 写了动作没有的输入。

不合的一块换成一段出错的文字，说是哪个插件的块、为什么，并列进问题；页的其余部分照常（K8）。`custom` 块盖上插件名，插件写的不算。答复的 `refresh` 不是数字、`filters` 说了没声明的筛选、`open` 不是开在面板里的链接，都去掉，列进问题。`POST /api/call` 用同一个 `parseCall`。比内核旧的网页遇到不认识的种类，显示成一行字。

#### 分页

存储和行都只从一个游标往后列，不往回，所以一页在哪是两个视图参数：`after`，这一页从哪个游标往后，第一页没有；`back`，前面每一页的游标，一个 JSON 列表。参数在地址里，翻到的一页能重新载入、能粘贴。sdk 的 `paging.ts`：

- `pageAt(参数)` 读出这一页在哪。
- `pagingOf` 从参数、这一页的行数和下一页的游标生成 `Paging`：从第几行起、几行、共多少（或至少多少）、上一页和下一页的链接。
- `pageOfList` 给整个拿在手里的列表按位置切页。

一个视图上几个列表各用一个前缀，互不牵动（条目面板里记账插件的 `basis.`、`history.`、`dependents.`、`held.`）。一页几行由面说，`ViewRequest.size`：网页不给，是 50（`PAGE_ROWS`）；`show` 给 20（`TEXT_ROWS`），`--json` 也是。浏览器里的翻页、没登记的目录的回答、全量动作的进度和停下、条目面板的现状和面，由 `packages/viewer/e2e/storage-pages.spec.ts` 守着；`tour.spec.ts` 在设了 `PNEUMA_BASE_TOUR_SHOTS` 时给每一页拍浅色深色、宽窄两种窗口的截图，平时跳过。

#### 插件自己画的页

带类型的块说不出的，插件画自己的页：一个 `custom` 块，带一个 `text`，用字说这一块画的。agent 看不到画，只看得到 `text`：`show` 印它，框架的 `aria-label` 是它，页打不开时网页显示它。

- 网页把它放进 `<iframe sandbox="allow-scripts">`，地址是 `/plugin-ui/<插件名>/<entry>`，不带令牌；开始时 `height` 高，之后跟着框架报的高度，最高 4000。
- 框架发来的第一条合格的消息就算准备好了。网页这时发给它一条 `data`，以后每次重取视图、换配色都再发一条。消息都带 `pneuma: 1`，只有四种：网页到框架的 `data`（块的 `data`、配色、网页此刻的变量 `tokens`，取自 sdk 的 `FRAME_TOKENS`，和没有 `call` 的动作），框架到网页的 `run`、`open`、`height`。别的消息、别的来源的消息都不理。
- 具名动作走和按钮完全一样的路：同一个对话框问这个动作的 `confirm`，表单里先填好框架给的值（只取声明了的输入），同样经两个面分派，同样的提示和重取。框架拿不到 `Call`，跑不了块没声明的动作。不让框架直接调接口，是因为「破坏性的要当面确认」「每次操作留痕」只在两个面的入口守得住。
- 5 秒内没准备好，那一块换成一段说明，写出插件名和 `entry`，跟着块的 `text`；页的其余部分照常（K8）。
- 沙箱为的是隔离样式和崩溃，不是防插件：插件的 `index.js` 本来就在本机以主人的身份跑。
- 开发包是 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css`，由 `packages/viewer/web/kit` 构建，`frame.css` 带上和网页共用的 `components.css`。`packages/viewer/test/server.test.ts` 核对开发包给出 `@pneuma-base/sdk/frame` 说的每个调用和每个类（`FRAME_CLASSES`）。

#### 网页渲染块的规矩

网页（`packages/viewer/web/src`）渲染块时自己定的几条，插件写块时可以指望：

- 时刻按看的人的本地时间写：一小时内「刚刚」「N 分钟前」，今天「今天 15:34」，昨天「昨天 15:34」，今年更早的「11月5日 15:34」，更早的年份只写日期；悬停给到秒的完整时间，每半分钟自己走一次。插件写在字里的 `YYYY-MM-DD HH:MMZ` 在副标题、节的说明、一段文字、列表的说明、时间线的行、数的说明和命令面板里也换成这样。
- 网页的图标表按 sdk 的类型 `IconName` 写，所以 `ICON_NAMES` 和画得出的一样；别的名字画成拼图。
- `href` 只有 http 和 https 算链接，在新标签页打开（`rel="noopener noreferrer"`），别的照文字显示；表格里放不下时从中间截短，悬停给全文。
- 谁做的记号：字母的规则在 `marks.ts`（PLUGINS.md 第 4.4 节的 `ActorMark`），只看屏上同时有的名字；agent 的底色由名字定；主人是一个灰圆，里面是名字的首字母。
- 表格的每一列先量出自然宽度。放得下就都不截短，多出的宽度给最宽的一列。放不下时，可让的列（`optional`）从后往前让开，再截短文字，最后截短路径，路径截掉的是前面的文件夹；各列都截到最短一档还放不下时，表格横着滚。窄的地方要让路径完整，用列表，不用表格。
- 没有行的表格只显示它的 `empty`，画成空状态：第一句是标题，其余是说明。
- 一页的块以 `tree` 开头、后面还有块时，树在左边一栏，其余的在右边；地方不够时树在上面。
- `feed` 只画不寻常的「谁的动作」：主人做的、主人批准的、看到的；agent 自己做的几乎是每一行，不画。时刻在行左边的一列；`feed` 窄的时候，时刻挪到灰的一行的开头。
- `asks` 回答之后在原处折成一行回执（回答了什么、答复的那句话、什么时候），记在网页里，页面开着时一直在，即使重取之后它已不在答复里。
- `drop` 在 Mac 应用里是一块虚线的区域，点了请壳选文件（第 10 节）；浏览器交不出文件，显示 `command`，可复制。
- `chart` 的颜色按系列的次序取自 `theme.css` 的 `--series-1` 到 `--series-4`，浅色深色各一套，不由插件定。只有一个系列时不画图例；线的末端放得下就直接标系列名，否则画图例。悬停或键盘（←→、Home、End）移到一处，给出每个系列的数和单位；读屏另有一张同样的数表。不做入场动画。一页里接连的几张图，宽的时候并排。
- `embed` 放在沙箱框架里，能跑脚本；地址和网页不同源时另给 `allow-same-origin`，保留它自己的源，它自己的存储照常能用。带「在新标签页打开」。
- 输入的 `pattern` 按 `^(?:…)$` 和 `u` 标志整个匹配，`multiple` 的每一行都要，留空不算不匹配。只有一个选项的筛选不画。
- 答复的 `open`：网页打开这一页、面板关着、窗口放得下页和面板（不用把侧栏收成窄条）时，在面板里打开它；换了参数也算又来了一次。它替换当前的历史记录，不多一步「后退」。
- 带 `page` 的块下面一行：左边「51–100，共 523 项」（只数到一部分时写「至少」），右边上一页、下一页两个按钮，到头的一个灰掉。翻页就是打开 `page` 给的链接：主区的换地址里的 `view.` 参数，面板里的换那个标签的参数；同一个列表翻页时旧的行留着直到新的来。焦点在这一行时 ← → 也翻页。
- 右侧面板里排在最后的那一行动作贴在面板底部，内容在它上面滚。
- 表格里有链接的行，只有一行在 Tab 的顺序里；上下键、Home、End 在这些行之间走，回车或空格打开，按着 ⌘ 或 Ctrl、或用中键，开在新的标签里。Esc 先关对话框和命令面板，都没有时关掉右侧面板最前面的标签。对话框开着时 Tab 不出框，关掉后焦点回到原来的按钮。
- 提示叠在右下角，新的在前，最多 4 条。做一个动作时提示立刻出现，写着正在进行，答复来了就在原处变成答复。成功的和警告的 4.5 秒后自己消失；拒绝和出错的一直留着，等人关掉。
- 主人命令的拒绝带 `offer` 时，提示里有它的按钮，点了照按钮走（先问它的 `confirm`），提示关掉。`plugin remove` 被插件的 `onRemove` 拒绝时，`offer` 是「仍然卸下」：用插件的那句话问，确认后带 `--anyway` 卸下。块说不出「被拒绝后可以改做另一个」，所以这一样放在答复里。
- 有名字的全量动作在它的提示里：做的一方报来的话，一根细条（不知道总数时来回滑），和「停下」；点了变成「正在停下…」，手上那一步做完就停，提示变成答复。报过进度的，答复留着等人关掉。
- 打开的视图、它的参数和右侧面板每个标签最前面的视图记在地址的片段里：`#view=<编号>&view.<参数>=…&panel=<编号>&panel.<参数>=…&panel2=…&tab=2`，`tab` 是最前面的标签（从 1 数，只有一个标签时不写）。重新载入或粘贴这个地址，打开的是同一套，只是各标签里的「返回」不在地址里；浏览器的后退、前进一步步走回去。

#### 界面的样子

- 样子只有一层变量，在 `theme.css`，浅色深色各一套，跟着系统切换，不用重新载入：字是黑或白的五档透明度；面从后往前是页底、面板、卡片、浮层（`--page`、`--panel`、`--surface`、`--overlay`）；边是阴影里 0.5px 的环；阴影有卡片、卡片悬停、浮层、对话框四个；圆角七档。主要按钮近黑；蓝色给键盘焦点、`info` 的语气和图表，界面没有自己的强调色。按钮、字段、标签这些基础部件在 `components.css`，和开发包共用。
- 边栏坐在页底上：库名和自动更新的小点，一个打开命令面板的搜索按钮，下面是页，分组。首页和第一个插件的页在最上面，不带组名，界面打开时就在首页；别的插件的页在「插件」下；内核的页在「库」下；配置在最底下。小点连不上服务时变红，它的提示说最近一次看到变化是什么时候，读屏也读得到。
- 边栏能收成一列图标；主区窄于 520px 时它自己让开，打开详情时也算。边栏和详情的宽度能拖，记在 cookie `pneuma-ui` 里（服务每次换端口，cookie 不分端口），不是库的状态。
- `feed`、`asks`、`stats`、`tree`、`chart`、翻页的一行和谁做的记号是管理界面自己的部件，在 `pieces/`，一个一个文件，样式在 `pieces.css`，只用 `theme.css` 的变量。它们画的是块，不进开发包。
- 主区和详情是两块圆角面板。详情里每样打开的东西一个标签：普通的点击在最前面的标签里往下走，返回走回来；⌘ 点击、中键和命令面板开新的标签，已经开着同一个的就把它调到前面。
- 命令面板（⌘K，或边栏的搜索按钮）：列出要去的页和这一页的动作，打了字按标题筛；打了字也用 agent 面的 `find` 在库里找，经 `/api/call`，和按钮同一条路，命中按 `find` 的分组列在后面，选一条在详情的新标签里开。上下键、回车、Esc。

### 界面的服务

`packages/viewer/src/server`，Node 的 http。`pneuma-base view [<目录>] [--port <端口>] [--no-open]` 启动它：印出带令牌的地址和对 agent 说的那句话，打开浏览器，Ctrl+C 关掉。Mac 应用启动的是同一个服务（第 10 节）。

#### 谁能进来

- 只听回环地址，端口见「本机的 endpoint」。
- 启动时造一个随机令牌，打印的地址带着它（`/?token=…`）。
- 每个请求核 Host：`127.0.0.1:<端口>`、`localhost:<端口>` 或 `[::1]:<端口>`，别的是 403，挡 DNS 重绑定。
- 除了 `/plugin-ui/` 和 `/plugin-kit/`，都核来源：`Origin` 不是这个服务自己的（`null` 也算），或 `Sec-Fetch-Site` 是 `cross-site`、`same-site`，是 403。别的答复都不带 `Access-Control-Allow-Origin`。
- `/api/*` 另核令牌：头 `x-pneuma-token` 或查询参数 `token`，按常量时间比较，不对是 401。网页从自己的地址拿到令牌，每次请求带在头上；`/api/file` 的地址带在查询参数里。
- 页本身、开发包和给 agent 的路由（`/guide`、`/pair`、`/mcp`）不要令牌。
- `/api` 的请求体不超过 1 MiB，超了是 413。

#### 路由

- `GET /api/state`：`{ dir, library, views, problems, available }`。`library` 是 `null` 时这个目录还不是库；否则是库的位置（另有一份把家目录写成 `~` 的，给人看）和标识。另有视图清单和问题、这台机器上可用的插件。
- `GET /api/view?view=<编号>&<参数>=…`：`viewerFace.show` 的答复。
- `POST /api/call`：`{ call, confirmed }`，答复是 `{ tone, text, result }`，一句给人看的话和结果。`call` 不合是 400。`confirmed` 是网页的确认框，就是当面确认。从页上放进来只能给一个文件的路径，标准输入归命令行。
- 请求另带 `pass`（网页每次给一个新的号）时，答复是一行一个 JSON 的流（`application/x-ndjson`）：做的一方经 `ctx.pass` 每报一次进度是一行 `{ progress }`，最后一行 `{ reply }` 是平常的答复。连接在答复之前断了，就当请了停下。`POST /api/stop { pass }` 请那一趟在手上那一步做完后停下，答 `{ running }`，说它还在不在跑。
- `GET /api/file?path=<库内路径>`：内容区和归档区的文件原样给出，经内核从存储读（`content.ts` 的 `libraryFile`）。路径经内核解析；内核的文件、库外的、读不成一个文件的（目录、指向库外的链接）都是 404。请求带 `Range` 时只给那一段（206，越界 416），否则整个给；每次向存储读 1 MB，读到一半文件变了就断开。同步服务只留了占位的文件答 409 和它的大小，带 `fetch=1` 才让存储取下来。
- `/api/file` 的类型：图片按扩展名，UTF-8 文字是 `text/plain`，别的是 `application/octet-stream`，所以 HTML 也当文字给。答复带 `sandbox` 的 CSP 和 `nosniff`，浏览器不会运行库里的文件。
- `GET /api/rev`：`{ rev }`，一个摘要，见下面。
- `POST /api/init { plugins }`：把目录建成库，装上选的插件。网页在目录还不是库时给出这一步。
- `GET /plugin-ui/<插件名>/<路径>`：这个库装了的插件的 `ui` 目录里的文件，只读。路径的段解码后是空、`.`、`..` 或含斜杠的，链接跟到底不在 `ui` 里面的，没装的插件、没有 `ui` 的插件，都是 404。
- `/plugin-ui/` 不要令牌：框架拿着令牌就能绕过对话框直接调 `/api/call`，所以它的地址不带令牌，答复带 `Referrer-Policy: no-referrer`（网页的地址里有令牌）。它带 `Content-Security-Policy: sandbox allow-scripts; frame-ancestors 'self'`，单独打开也拿不到网页的源；带 `Access-Control-Allow-Origin: *`，因为沙箱里的框架是不透明的源，模块脚本和字体要 CORS 才载得进来。
- `GET /plugin-kit/frame.js`、`/plugin-kit/frame.css`：开发包，同样带 CORS。
- 其余路径是构建出的网页：`/` 是 `index.html`，不缓存；还没构建时答 503，说怎么构建。

`/api/rev` 的摘要由两部分拼成。一部分是内核的 `changeStamp`（`places.ts`）：每个插件的事实现在到哪、展开的目录的令牌、存储报来的展开的目录那一层里的文件最近一次改动；最后这一样，服务在内存里为每个库留一个游标，每次轮询从它问一次（第 5 节「上下文里的工具」）。另一部分是本机 `$PNEUMA_BASE_HOME/pairings/` 这个文件夹自己的修改时刻：配对的文件只加不改，加一个就动它，所以新的配对和主人的决定都让首页重取；只看一次，不随配对变多而变贵。摘要从不走库的文件夹：没人看过的目录里、一样东西里面的改动，以及存储说不出变化时在原处改了的文件，不改摘要，等页因为别的原因重取时才显示出来。

#### 服务不持有库的状态

- 服务在内存里只记两样：正在跑的几趟全量动作的号和停没停（为了「停下」，跑完就丢）；它在听的库（`listenTo`），关掉时停听。
- 每次请求重新建插件表（调用方给的自带插件，加本机 `$PNEUMA_BASE_HOME/plugins/` 里的，文件变了就载入新的），重新打开库。
- 行动者是主人；会话按服务的环境识别，没有就每次请求造一个。服务若跑在 agent 的会话里，破坏性命令照常被拒（K7，第 5 节「主人和 agent 的门」）。
- lint 守着边界：`packages/viewer` 不导入命令行和任何插件，插件表和 MCP 的实现都由调用方交给 `startServer`；网页从内核只取类型。

#### 壳里的网页

壳本身见第 10 节。这里是网页这一侧（`shell.ts`、`tray.tsx`）：

- 地址带 `shell=mac` 时：`<html>` 标上 `data-shell`，字体用系统的，边栏顶部给窗口的三个按钮留出位置，外框的字不能选中，只对浏览器有意义的提示换掉。壳在窗口成为或不再是前台窗口时发 `pneuma-shell` 事件，网页标上 `data-window`，窗口在后面时把外框调淡。`data-drag` 标出能拖动窗口的区域，壳据此拖窗口；浏览器里这个标记什么都不做。
- 再带 `panel=tray` 时，网页是菜单栏面板的排法。它取首页的同一份答复，不认识任何插件的视图：顶上是库名（点了是壳的库的菜单）和「N 件等你」；还有没做的步骤时一行「开始：还有 N 步没做」；「等你决定」是首页所有 `asks` 块里的前三件，在这里就能回答，多的写一行「还有 N 件，在窗口里看」；回答跑起有名字的全量动作时，提示里和窗口里一样有进度和「停下」；「自上次以来」是首页所有 `feed` 块里最新的五行，没有时用第一个不空的 `empty`，再没有是「还没有谁做过什么。」；底下是「打开窗口」和「退出」。只在面板显示着时每两秒问一次摘要。
- 网页对壳说的话经 `window.webkit.messageHandlers.shell.postMessage` 发出。壳注入的 `shell.js` 发 `ready`、`painted`、`regions`。网页发 `{ type: 'choose', to }`（`drop` 块的「选择…」）、`{ type: 'open', link? }`（打开窗口，给了链接就在窗口里打开它）、`{ type: 'libraries' }`、`{ type: 'quit' }`；面板另发 `{ type: 'height', height }`（壳照它定面板的高）和 `{ type: 'waiting', count }`（图标上的点）。
- 壳对网页说的都是 `pneuma-shell` 事件：`{ window }`（见上）；`{ link }`，窗口照点了这个链接那样打开它；`{ notice: { tone, text } }`，窗口显示成一条提示并重取，说的是拖放和监看做了什么；`{ panel: 'shown' }`，面板又显示出来，重取。

### MCP 服务

给不能跑 shell、也不能装技能的 agent 应用（桌面的对话应用、编辑器）的一面。`pneuma-base @<授权名> mcp` 在标准输入输出上跑一个 MCP 服务（`packages/cli/src/mcp/`）：

- 库和身份都由授权定：行动者是授权的 agent，不收 `--library`、`--as`。授权解析不了时在标准错误上说拒绝的理由，退出码 2。标准输出只走协议，插件打印的日志改到标准错误。
- 一次连接是一次会话，所以是一个场景：客户端用 `--session <名字>` 起了名就用那个名字，没起就造一个；不并进这个 agent 当天的零散场景。
- 只读的授权、限在一个区域的授权和命令行一样。
- 服务不持有库的状态：每个请求重建插件表、经授权重开库，所以插件装卸、授权撤回立刻生效。

**工具**都是生成的（`tools.ts`），没有为哪个工具手写的代码：

- `VERBS` 的每一项一个工具。每条既不破坏也不只给主人的主人命令一个，名字是命令名的词用 `_` 连起来（`space list` 是 `space_list`）。
- 输入出自参数表：位置参数和开关是同名的属性，种类（文字、文字的列表、`true` 或 `false`）、必填、`pattern`（要整个匹配）、`options`（写成 `enum`）照搬，`hint` 是属性的说明，别的属性不收；`more` 是一个对象属性。`put` 读标准输入的那个位置参数在这里可以不写，内容写在 `text`（文字）或 `base64`（字节）里。
- 工具的说明是 `summary`；`readOnlyHint` 取 `readOnly`，`destructiveHint` 总是 `false`。
- 管理的命令不列出；按名字调，它照样经主人面的门，以命令行同样的理由和话拒绝。没有这个名字的工具是协议层的错。

**答复**和命令行的一样：命令行印的字是工具答的文字，`--json` 印的结果对象是 `structuredContent`。拒绝（退出码 2 的那些）标 `isError`，字和理由不变。用法错误是 `reason: 'usage'` 的拒绝，字是命令行在标准错误印的那句「用法错误：…」。插件的问题和命令行一样写在字里和 `problems` 里。退出码在这里没有意义，看 `outcome`。

**认知**随连接来：服务的 `instructions` 是库的说明（内核此刻拼出的 `PNEUMA-BASE.md`，第 5 节「说明和技能」），前面加一段写给这一面的话（`tools.ts` 的 `PREAMBLE`）：说明里的命令行就是同名的工具、参数相同；`put` 怎么给内容；内容用 `inspect` 加 `content` 读；这次连接是一次会话；管理由主人在界面上做，这里没有它们的工具；要主人做其中一件用 `ask`（`command` 是那条命令的词和参数）。`pneuma-base://library/description` 是同一段文字；导航里不只给主人的每一页是 `pneuma-base://library/show/<编号>`，读它得到 `show <编号>` 印的字。

**变化**：服务每两秒重读一次工具表、资源表和被订阅的资源，变了就发协议的通知（`notifications/tools/list_changed`、`notifications/resources/list_changed`、`notifications/resources/updated`）。插件在连着时装上或卸下，三样都会变。

**协议**：新旧两代都接（`server.ts`）。

- 2026-07-28 版每个请求在 `_meta` 里带协议版本和客户端能力，有 `server/discover`，通知经 `subscriptions/listen` 来。可缓存的结果写 `ttlMs: 0` 和 `cacheScope: 'private'`：库随时在变，答复因授权而异。这一版说一条连接不算会话，这里仍把一次连接记成一个场景。
- 更早的版本（`LEGACY_VERSIONS`：2024-11-05 到 2025-11-25）以 `initialize` 开头，`notifications/initialized` 之后的通知直接发，资源用 `resources/subscribe` 订阅。
- 协议是自己写的，没有用官方的 SDK：命令行的包的运行依赖只有本仓库的包，工具的输入又是从参数表生成的 JSON Schema。传输是参数（`Transport`：收到的每一行，和发一条的办法），HTTP 上的那一种见下面。仓库的测试用官方的 MCP 客户端（`@modelcontextprotocol/client`，只是开发依赖）分别以两代协议、经标准输入输出和 HTTP 连上它。

### 本机的 endpoint

主人对任何一个 agent 说一句话，它就自己接上：「读一下 http://127.0.0.1:7638/guide，接上我的 Pneuma Base 库。」endpoint 是界面的服务里给 agent 的那一部分（`agent.ts`），和管理界面同一个进程、同一个端口。它是命令行的又一个面：`/guide` 给的就是 `pneuma-base guide` 印的字，`/pair` 就是 `pneuma-base pair request` 和 `pair status`，`/mcp/<授权名>` 就是 `pneuma-base @<授权名> mcp`。说明写什么、配对的状态、允许之后接上做什么，见第 5 节「配对」「接上一个 agent」「说明和技能」；这里只写 HTTP 的一面。

#### 路由

- `GET /guide`、`/guide/<产品>`、`/guide?for=<产品>`：说明，`text/markdown`，不缓存。产品名不合授权名的格式是 404；目录还不是库时答 409 和一句话。不按 User-Agent 猜是哪个产品：agent 用 shell 里的 curl 来取，curl 说不出是谁，所以靠地址里的产品名。
- `POST /pair`：正文 `{ "product", "why" }`，要 `content-type: application/json`（否则 415），不超过 4 KiB。答 201 和 `{ outcome, id, code, expires, again, poll, text }`，`poll` 是 `/pair/<配对号>` 的地址。内核拒绝时按理由给状态：`usage` 400、`too-many` 429、`not-a-library` 409。
- `GET /pair/<配对号>`：配对号是 `p-` 加 8 位十六进制；答这次配对现在怎样，没有这个号是 404。
- `/mcp/<授权名>`：MCP over HTTP，收 `POST`、`GET`、`DELETE`。`POST` 要 `application/json`，不超过 8 MiB。名字不合授权名的格式，或服务启动时没给 MCP 的实现，是 404。
- 方法不对是 405，带 `Allow`。

#### MCP over HTTP

`/mcp/<授权名>` 是规范的 streamable HTTP，新旧两代都接，工具出自同一张表，协议是同一份代码：`packages/cli/src/mcp/http.ts` 把 HTTP 请求接到 `serve` 的传输上，`view` 把它交给界面的服务（界面不导入命令行）。

- 旧一代以 `initialize` 开一条连接，答复带 `Mcp-Session-Id`，之后的请求都要带它（没带是 400，不认识的是 404）。一条连接是一个场景，和标准输入输出上一样，`?session=<名字>` 给它起名。`GET`（要 `Accept: text/event-stream`）是这条连接的通知流，新的替掉旧的；`DELETE` 结束它；闲 30 分钟自己结束。最多 32 条：再开一条时，闲得最久的那条结束。
- 2026-07-28 版没有连接：每个请求一个 POST，各跑一次 `serve`。`MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 三个头要和正文一致，不一致是 400 和 `-32020`；`Mcp-Name` 可以写成 `=?base64?…?=`。没有的方法是 404（`-32601`），不支持的版本是 400（`-32022`）。一次只收一条消息：批量是 400，通知答 202。通知经 `subscriptions/listen` 的 SSE 流来，关掉流就是取消。
- 2026-07-28 版没有「一次连接」可记成场景，所以地址可以带 `?session=<名字>` 给场景起名，和 `--session` 一样；不带的，每个请求像一次没带会话的命令行调用，记账插件把它并进这个 agent 当天的零散场景。
- SSE 流每 15 秒发一行注释，免得中间的程序在安静时把它关掉。
- 授权解析不了（没有、撤回了、库不在了）时照样经协议答：工具和调用以授权的理由拒绝，和标准输入输出上连着时一样，agent 能告诉用户为什么。
- 地址里有端口，界面的服务不在跑时连不上；标准输入输出的 MCP 条目没有这个限制（第 5 节「接上一个 agent」）。

#### 端口和地址的记录

- 优先 7638（`PREFERRED_PORT`），主人每天说的那句话不变。被占了依次试后面的 19 个，都占了就任意一个空端口。`--port` 写了就只用那一个，被占了启动失败；`--port 0` 是任意一个。
- 每个端口同时听 127.0.0.1 和 ::1，不听通配地址：只听 127.0.0.1 时，别的进程能占住 ::1 的同一个端口，接住解析成 ::1 的 `localhost`。机器没有 IPv6 的回环时只听 127.0.0.1。
- 用到的地址写进本机的 `$PNEUMA_BASE_HOME/endpoints/<端口>.json`（`url`、`port`、进程号、服务的库、时刻，没有令牌），关掉时删掉；进程不在了的记录不算。
- `pneuma-base guide --url` 印出地址；`pneuma-base view` 在地址下面印出那句话；首页「开始」的第一步和 Agent 页显示它，带复制按钮。`view` 启动时也确保本机的命令在，因为说明里的命令行都用它。
- 没有在跑的服务时，`guide` 和 `pair request` 要写 `--library`，说明里只有命令行的配对。

#### 安全

每条都有测试（`packages/viewer/test/endpoint.test.ts`、`server.test.ts`）：

- 只听两个回环地址。
- Host 和来源的核对同「界面的服务」。`POST /pair` 和 `POST /mcp` 要 `content-type: application/json`：浏览器发这种请求先要预检，预检拿不到许可。
- 给 agent 的路由碰不到主人的路由。它们在自己的模块里（`agent.ts`），拿不到令牌；lint 不许它导入 `api.ts`、`index.ts`，和内核的 `ownerFace`、`agentFace`、`viewerFace`、`initLibrary`。`/mcp/<授权名>` 的行动者是那个授权的 agent，主人命令在主人面的门前以 `agent-session` 拒绝。
- 主人的路由（`/api/*`）由每次启动造的令牌守着。令牌只印在服务的标准输出上，应用从管道里读，日志和 endpoint 的记录都不写它；别的网站的页读不到 `/api` 的答复。
- 限速，每个服务每分钟：`GET /guide*` 120 次，`POST /pair` 20 次，`GET /pair/*` 240 次，超了是 429，带 `Retry-After`。
- 请求体限大小：`POST /pair` 4 KiB，`POST /mcp` 8 MiB，`/api` 1 MiB，超了是 413。
- 这台机器上授权是约定，不是秘密：知道授权名的本机进程都能用 `/mcp/<授权名>`，和命令行的 `@<授权名>` 一样。
- 留下的：这台机器上别的用户能先占住 7638，假冒 endpoint。首页和 Agent 页显示的总是实际用到的地址，主人照着说就不会被接走。

## 10. 壳

壳是 Mac 应用（`app/`，Swift，不用 Xcode 工程）：窗口、菜单栏的面板、拖放、监看、这台机器的设置。它不持有任何库的状态：对库做的一切都经命令行，它只记着这台机器认识哪些库、当前是哪个、监看上次听到的游标和它自己的设置（`$PNEUMA_BASE_HOME/app/`）。怎么构建、怎么打开、测过什么，在 `app/README.md`。

- **自带的东西。** 应用里有一个 Node 和命令行的包（包里有管理界面、五个自带插件、本机文件夹的存储提供者和契约测试的程序），只跑这几样。`app/build.sh [--node <路径>] [--dist]` 从这个仓库构建它，`--dist` 另打一个 zip。缺省的家目录是 `~/.pneuma-base`。每次启动，应用让本机的命令 `$PNEUMA_BASE_HOME/bin/pneuma-base` 指向自带的 Node 和命令行（第 5 节「接上一个 agent」）。
- **窗口和面板。** 窗口里是界面的服务给的页，带 `shell=mac`；菜单栏的面板是同一个服务给的 `shell=mac&panel=tray`，首页的块画小。网页和壳之间的每一条消息在第 9 节「壳里的网页」。服务是应用起的子进程 `pneuma-base view <库> --no-open`，死了重起，应用退出时停。
- **第一次打开。** 还没有库时问库放在哪：装着的提供者、官方的没装的、「安装别的存储…」；只有一个提供者时就是选一个文件夹。建库就是 `init`。
- **监看就是存储的订阅。** 应用起当前库的提供者的常驻模式（`serve --root <库>`），从上次的游标 `subscribe`，按听到的做；它自己不另开事件流。这是第 2 节允许的那一处跨层：订阅只读，不改任何东西。应用别的时候看库也只经存储的只读操作，不直接读文件夹：拖放时为放进来的文件找一个空着的名字（Finder 给副本起名的写法）问 `glance`，自动登记时的下载来源是 `glance` 的 `macos` 面里的 `where_from`，一个文件夹是不是库看 `declaration.read` 有没有声明，和内核的判断一样。监看在跑时经它的进程问，没在跑时起一次提供者的程序问。拖进来的文件在库外，进库前读它自己的下载来源属性，那不是看库。
- **「直接放进来的文件算主人的」**是一个开关，缺省开。开着时，监看等库安静 3 秒，读一次记账插件的状况页，对它列出的、自上次以来听到的路径经命令行做事：新出现的文件以主人带进来、看到的来历登记（`put --brought --by owner --observed`）；被直接改过的文件记成看到的改动（`say revised --observed`）；新目录只在一次预算 500 的探查发现它小而普通（顶上没有项目标记）时登记成一样东西，其余仍是记账插件的问题。一次放入正在写时，存储占着它的位置，所以监看不会抢先登记。
- **设置**（⌘,）：「直接放进来的文件算主人的」，「在终端里用 pneuma-base」（把本机的命令链进主人终端的 PATH），「登录时打开」。后两样缺省关。
- **拖放。** 拖到窗口任何地方的文件和文件夹，和首页「放进第一样东西」的 `drop` 块一样，经命令行以主人带进来的放入。

这一版没有签名和公证：从 zip 打开要在「系统设置 › 隐私与安全性」里点「仍要打开」（`app/README.md`「发给别人」）。

## 11. 机器的状态和库的状态

库是一个拷走就完整的文件夹：所有记录跟着它走。软件不持有任何库的状态，删掉软件，库完好。另有一个本机的目录，放这台机器自己的东西，不是库的一部分。

### 库

```
<库>/
  PNEUMA-BASE.md              说明（内核拼，经存储写）
  .pneuma-base/
    config.json               库根的声明：库标识、格式版本、插件表、授权
    noise.json                噪音：存储不报告、不进入的名字和路径
    requests/facts/           内核的记录处 requests 的事实：agent 提的请求
    kernel/facts/             内核的记录处 kernel 的事实：补上补到哪里
    <插件名>/                  每个插件的记录处：facts/ 下是它的事实，其余是它自己的地方
    tmp/                      存储写到一半的东西：中断的写由下一次写清掉或补完
    trash/                    存储删东西时先改名到这里再删
    holds/                    存储的占位：正在写、记录随后就到的位置
    cache/                    存储的缓存区：每个记录处的行（rows/<名字>.sqlite）、大目录排好的名字（names/）、
                              有进程在听时的变化日志（changes/）
  _archive/                   归档区，里面保持原来的相对路径
  <某个目录>/.pneuma-item      带这个标记的目录是一样东西
  ……                          其余都是内容，随便怎么放
```

| 位置 | 是什么 | 本体还是缓存 | 同步插件带不带 |
| --- | --- | --- | --- |
| 内容和 `_archive/` | 带进来的和做出来的东西 | 本体 | 带登记过的；没人登记过的不带 |
| `.pneuma-base/<记录处>/facts/` | 事实：只追加，每次写入一个名字唯一、写完不动的文件，按日期分目录 | 本体 | 带（`kernel` 的除外） |
| `.pneuma-base/<记录处>/` 里事实以外的 | 记录处自己的地方：留存、版本这类内容 | 本体，插件声明为缓存的目录除外 | 带本体 |
| `config.json`、`PNEUMA-BASE.md` | 这个库在这台机器上的配置（授权、插件表、给缓存目录作键的库标识），和由它拼出的说明 | 本体 | 不带：每个副本有自己的 |
| `noise.json` | 噪音名单 | 本体 | 不带：每个库用自己的 |
| `tmp/`、`trash/`、`holds/`、`cache/` | 存储自己用的 | 不同步；`cache/` 随时可删 | 不带 |

**行是缓存。** 删掉 `.pneuma-base/cache/`，存储的答复不变，只变慢：行从事实重新推出，名字重新列，听的进程一秒内发觉、重新记一份日志，这之前的问都说不出。每个插件的行由它自己从事实推出，形状变了或游标对不上（事实被删了）时整个丢掉、从头推。所以从一个旧版本升级之后，第一次运行会从事实重建各个记录处的行；事实多时，命令在标准错误上报重建的进度。

**声明和说明。** 库的配置是库根的声明，经存储的 `declaration.read`、`declaration.write` 读写（`library.ts`）：写带预期，就是读到时的令牌，还没有声明时是空；别的写者插进来，就重读再写。内核不认识的字段原样留着。每次改配置都重拼说明，经存储的 `write` 写，同样带预期。

**建库**是 `init <地址> [--bare] [--provider <名字>]`，只给主人（`owner.ts` 的 `initLibrary`）：按地址的写法选提供者（`--provider` 写了就用它，否则自带的答就用自带的），把库用的是哪个记在本机，再让存储建库（记录区、缓存区、缺省的噪音名单），再写声明和说明。缺省装上记账插件，`--bare` 什么插件都不装。那里已有声明时，读得懂读不懂都一样，以 `already-a-library` 拒绝。

### 这台机器

缺省是 `~/.pneuma-base`，可以用环境变量 `PNEUMA_BASE_HOME` 换：

```
$PNEUMA_BASE_HOME/
  bin/pneuma-base             本机的命令：接上的 agent 按这个路径运行，内容由提供命令行的一方保持最新
  grants/<名字>.json          发给 agent 的授权副本
  endpoints/<端口>.json       在跑的界面服务各一份：地址、进程、服务的库；不带令牌，关掉时删
  pairings/<号>.json          agent 的配对请求，<号>.decided.json 是主人的决定；各写一次，都留着
  connections/<授权名>/        agent connect 写进别的程序的东西的记录，和改之前那份文件的副本（before/）
  app/                        Mac 应用自己的小配置和日志
  plugins/<名字>/              装到这台机器上的插件：index.js、它导入的文件、可选的 ui/
  secrets/<插件名>/<密钥名>     插件的凭证，只有用户能读，不进任何库
  cache/<库的 id>/<插件名>/    插件的缓存，删了能重建
  storage/providers/<名字>/    装上来的存储提供者：provider.json 和各版本的程序；自带的不写在这里
  storage/libraries/<键>.json  一个库用的是哪个存储提供者，建库时写
  storage/tmp/                装到一半的提供者
```

这些都不随库走：换一台机器，授权副本、配对、连接、密钥、缓存和提供者的记录都要在那里重新有。库用哪个提供者记在机器上而不记在库里，因为库自己的声明要先有存储才读得到；没有记录的库（在别的机器上建的）用答它的地址写法的那一个，自带的优先（`PROVIDERS.md`）。缓存目录按库的 id 分，所以库的 id 只能是字母、数字、连字符和下划线。

## 12. 不变式

| 编号 | 性质 | 由什么守 |
| --- | --- | --- |
| K1 | agent 面的任何调用，不让库里已有的内容或已有的记录变得找不回 | 放和归档的全化表（`packages/kernel/test/put-table.test.ts`、`archive-table.test.ts`）；每次写都带预期，存储的写要么做成要么没发生（契约测试的 `writes`、`interruption`、`concurrency`）；`revise` 的契约 |
| K2 | 没有任何插件时，每个动词都给出确定的答复，不报错 | `packages/cli/test/bare-library.test.ts`、`packages/kernel/test/viewer.test.ts` |
| K3 | 换插件不改变动词的请求和结果的形状 | 类型（`packages/sdk/src/types.ts`），`tsc -b` |
| K4 | 内核不依赖任何插件；插件只经内核的公开接口接触内核，互不导入；界面不导入插件 | 包的依赖；lint 的导入规则，`packages/kernel/test/dependency-direction.test.ts` 在故意违反的例子上看它们变红 |
| K5 | 两个面的每次操作都产生一个事件，发给所有插件。页不是操作，不发事件 | 管线的单一出口；`ownerFace.dispatch` 是主人面的唯一入口；`packages/kernel/test/owner.test.ts`、`packages/cli/test/plugin-mechanism.test.ts` |
| K6 | 说明里许诺的能力不超出已装插件提供的 | 拼装只从配置和插件的认知段取材；`packages/cli/test/description.test.ts`、`description-commands.test.ts` |
| K7 | 破坏性的操作只在主人面，要人当面确认，在 agent 的会话里被拒；只给主人的命令在同一道门被拒；`ask` 只记下要什么，批准让那条命令以主人的身份再过这道门 | 主人命令声明里的标志，由内核统一拦；`owner.test.ts`、`plugin-mechanism.test.ts`、`requests.test.ts` |
| K8 | 一个插件出错不让动词失败，也不被静默吞掉 | `problems`；`plugin-mechanism.test.ts`、`external-plugins.test.ts`、`deploy.test.ts`、`viewer.test.ts` |
| K9 | 归档的东西不被删除；默认的找和查不带它，开关打开才带 | 归档的全化表；`archive-table.test.ts` |
| K10 | 存储之上的一切只经存储读写库的文件夹和记录区 | lint 的门（下面）；`packages/kernel/test/storage-door.test.ts` 在每个包里故意违反的例子上（含一个新文件）看它变红，也看列着的文件、测试和脚本不被拦 |
| K11 | 代价跟着登记过的东西走：没有哪个动作走库；没登记的目录只是一个条目，它不可读也照常；agent 的 `start` 和 `check` 有界 | `packages/cli/test/sparse.test.ts`、`unregistered.test.ts`；符合性检查的 `bounded`（插件也守）；`scripts/bench-line.mjs` |
| K12 | 存储守 `STORAGE.md` 的十条规则 | 契约测试 `pneuma-base-contract`：只驱动程序，按 `STORAGE.md` 逐句核对；`core/cli/tests/contract.rs` 对自带的程序跑它，`storage install` 对每个装上来的跑它 |
| K13 | 命令行、页面、MCP 一一对应 | `packages/cli/test/pages.test.ts`、`mcp.test.ts`、`mcp-http.test.ts`、`endpoint-story.test.ts`（第 9 节） |

**K10 的门。** lint 守着每个包的运行时源码：`packages/*/src`、`plugins/*/src` 和 `plugin new` 的模板（`packages/cli/templates/*/src`）。那里的文件不导入 `node:child_process`；用文件系统只为读自己包里的文件（`readFileSync(new URL(…, import.meta.url))`），也不经动态导入、`require` 或 `getBuiltinModule` 拿到它们。内核的文件不导入 `machine-files.ts`，不用 `paths.ts` 的 `abs`、`canonical`；插件不从内核取直接碰文件夹的助手（`thingAt`、`fingerprintOf` 这些）；谁都不用插件契约第 1 版的工具和上下文的 `dir`。

`eslint.config.js` 的 `MAY_TOUCH_FILES` 列出可以用文件系统、起程序的文件，各写着为什么。它们碰的都不是库的文件夹和记录区：

- 门本身（`storage.ts`）；这台机器上的存储提供者（`providers.ts`、`provider-install.ts`）；存储能答之前的库的地址（`address.ts`）；调用方写的绝对路径（`paths.ts`）；放的来源在库外（`outside.ts`）；包自己的文字（`cognition.ts`）；插件向存储要了什么的日志（`tool-log.ts`）。
- 本机 `$PNEUMA_BASE_HOME` 下的状态：授权、endpoint、配对、密钥、插件、本机的命令、连接的记录（`machine-files.ts`、`grants.ts`、`endpoint.ts`、`pairing.ts`、`secrets.ts`、`plugin-table.ts`、`launcher.ts`、`connections.ts`）；agent 产品的配置、技能目录和对话（`products.ts`、`agent-commands.ts`）；主人命令写到主人指定处的技能文件（`owner-commands.ts`）。
- 插件在库外的东西：记账插件读 agent 的对话、写主人指定的导出文件；版本插件导出到主人指定处或还原用的临时目录；查找插件缓存里的索引；同步插件的目标和它缓存里的基线；部署库读进插件缓存的 `stage/`，部署插件的目标，`space` 的凭据文件。
- 面：界面的服务读建好的网页和插件的 `ui` 目录；命令行看人敲的词是不是一个目录，`plugin new` 在人指定处写插件项目；测试工具在临时目录里造沙盒库、像人的文件管理器那样从库外看插件改了什么。

测试和脚本不查：测试代表库外的世界（agent 自己的工具也会往库里写），脚本是建、测、演示用的。

## 13. 性能目标和基准

目标写成和空库比的倍数，和存储单独的毫秒数。

**动作的目标。** 在真实的库（克隆了 React 仓库并装好依赖，86,161 个文件）和合成的库（两万样登记过的东西、十万条事实、一个六万文件且设成不可读的没登记的目录）上，`start`、`check`、首页、`inspect`、`find`、放一个文件，耗时都在空库的小常数倍之内，输出不超过上限，内存不随文件夹增长。测得：真实的库上 agent 的一次 `start` 约 0.12 秒、输出不到 2 KB，和空库一样。

**存储的目标**（`core/bench`，`pneuma-base-bench`，一次性的命令含进程启动，先热身 3 次，取 30 次的中位数）：

| 操作 | 目标 |
| --- | --- |
| `glance` 一个位置 | 5 毫秒 |
| `overview` 六万条目的目录，取 200 条（热的） | 10 毫秒 |
| `probe` 预算 500 | 10 毫秒 |
| `look` 两万个位置，或从一张两万行的表比 | 50 毫秒 |
| `facts.since` 十万条事实里没有新的 | 5 毫秒 |
| `rows.get` 两万行里的一个键 | 5 毫秒 |
| `changed` 什么都没变；变了 1000 个 | 25 毫秒；50 毫秒 |
| `content` 一个 10 MB 的文件 | 15 毫秒 |
| `write` 1000 个小文件作一个目录 | 150 毫秒 |
| `move`、`remove` 一个文件 | 8 毫秒、5 毫秒 |

`changed`、`content`、`write`、`move`、`remove` 的目标取自存储做成时的实测：`changed` 的代价跟着游标之后卷上发生的事，所以只对新的游标、不忙的卷成立。`pneuma-base-bench --library <路径>` 另在一个真实的库上量只读的操作，不改那里的任何东西。它只报告，不拦。

**上层的基准**都在 `scripts/` 里，`pnpm build` 之后跑，各自的开头写着用法：

| 脚本 | 量什么 |
| --- | --- |
| `bench-line.mjs` | agent 的 `start`、`check`、`inspect`、`find`、放一个文件、`archive`，主人的 `show home`，界面取首页和它的轮询：空库、合成的库和 `--real` 给的库上各用多久、印多少字、占多少内存；`--listener` 让一个进程在命令运行时一直听着库 |
| `bench-changes.mjs` | 合成的库上什么都没变、变了一样、变了 1000 样之后的 `start`、`check`、`show home`，有进程在听和没有的各一列 |
| `bench-register.mjs` | 在库的写时复制的克隆上，把一个大目录登记成一样东西，和登记它里面的全部；`--lock` 先把里面的文件都设成不可读：读了任何内容的登记会失败 |
| `bench-ledger.mjs` | 第一条命令（把全部事实折进行一次）和每个时间段的统计及它的页 |
| `bench-plugins.mjs` | 四个插件都装上时，放、找、看、查、留一版、`deploy sync`、什么都没变的 `sync now` |
| `bench-sync.mjs` | 合成的库上什么都没变的 `sync now`，和空库比 |
| `bench-catch-up.mjs` | 两千样东西登记之后再装各个插件，`plugin add` 补上的代价，和补完之后它知不知道旧的东西 |

先坏的是记账插件没人在听时的全比：存储拿 `tokens` 和 `seen` 的行比每个登记过的位置和展开的目录，两万行约 25 毫秒，`start`、`check`、`show home` 约 0.2 秒，跟着登记过的东西的个数线性地长。十万条事实（一个文件一条）从头推行约 4 到 5 秒（`bench-ledger.mjs`），最大的一块是存储打开十万个文件。
