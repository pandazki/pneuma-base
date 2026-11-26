# links 开发与试装记录

## 契约第 2 版（2026-11-27）

插件现在按插件契约第 2 版写（`contract: CONTRACT`），不走库，也不直接读库里的文件。下面各节记的是按第 1 版写的那一版；其中按本机文件系统判断存在性、跟着符号链接走的说法，现在不成立。

- 查哪些文档：只查它听到的。`onPut`（放入、登记、登记一个目录这一层的散文件、挪）、`onArchive` 和 `onPurged` 把 Markdown 和 HTML 文档记进它自己的记录处（开发包的 `recordStore`，记录库 `documents`）。带标记的目录，记下存储的清单（`storage.content(路径, { manifest })`）里的文档。
- 插件装上之前放进来的文档不查，再放一次（比如 `put <库内路径>` 登记一次）才查。
- 每份文档用 `storage.read(路径, { length })` 读，最多读前 1 MiB；更长的文档只查前 1 MiB 里的链接。
- 目标在不在问 `tools.what`：那里什么都没有才算坏链接。符号链接本身算在；符号链接下面的地方和噪音（比如 `node_modules`）里的地方，存储不看，算不在，会报成坏链接。

使用本目录提供的两个 0.9.0 包，插件契约为 1。保留的试验库在 `.local/library/`，安装副本在 `.local/pneuma-home/plugins/links/`。这个库有两份文档、三处坏链接，可以直接复查。

## 哪些地方需要补证据

| 规范位置 | 我遇到的问题 | 如何确定，以及对插件的影响 |
| --- | --- | --- |
| §4.2，`tools.files()` | 段首说路径都是库内路径；表格没给返回元素的结构，也没说成员路径的起点。把它当成库根相对路径会漏扫整包。 | SDK 的 `BundleFile` 注释写的是相对于带标记的目录。探针中 `things()` 给 `site`，`files('site')` 的一项给 `nested/readme.md`。拼成 `site/nested/readme.md` 才能打开正确的文件。建议在表格里直接给这个例子。 |
| §4.2，`resolve()`、`thing()` | “不在库里”容易同时被理解成路径越界和文件不存在。符号链接的边界也没写。 | `resolve('absent.md')` 对缺失文件仍给对象；探针里的库外符号链接也能被 `resolve` 和 `thing` 接受，而 `things` 和 `files` 略过符号链接。插件用内核枚举来源，自行检查目标的文件系统状态。 |
| §3.6、§7，带标记目录里文件的面板 | 规范示例只打开普通条目。目录整体才算“一样东西”，内部文件能否直接跳到自己的面板，示例没回答。 | 用 `put` 放入含 `index.htm` 的目录，再取 `viewer.item('web/index.htm', { plugin: 'links' })`，实测能拿到这一个文件的节。全库表格的行使用 `{ view: 'item', params: { path: source }, target: 'panel' }`。 |
| §3.2，`onCheck({ since, includeArchived })` | 规范给了参数，没规定针对“当前仍坏”的链接怎样判定时间。来源昨天写成，目标今天被移走，只按来源的修改时间筛就会漏报。 | 采用当前状态语义。每次重新计算，遵守 `includeArchived` 对来源文件的限制。`since` 不截断仍然存在的问题。 |
| §7，测试临时目录 | 规范列了沙箱的库和 home，没有指定沙箱父目录的选项。仅改手工试装的 `PNEUMA_BASE_HOME`，无法说明 SDK 沙箱也在项目里。 | 在启动测试 Node 进程前把 `TMPDIR` 指到 `.local/tmp`，实测 `sb.library` 和 `sb.home` 都落在其下的 `pneuma-base-sandbox-…`。测试结束由 SDK 清理。 |

§4.2 的路径总述至少需要为 `files()` 补一个例外。四个入口的钩子名称、表格行跳转字段和 §8 的安装顺序均按 0.9.0 的规范跑通。

## 我做的取舍

- **哪些文件算来源。** 用内核列出的内容文件，以及带标记目录里计入指纹的成员。扩展名大小写均可，支持 `.md`、`.markdown`、`.mdown`、`.mkd`、`.mkdn`、`.mdwn`、`.html`、`.htm`。按 UTF-8 读取。内核自己的说明和元数据不作来源。目标可以是任意扩展名、没有扩展名，或尚未用 `put` 登记的普通文件。指向内核区的显式相对链接也按存在性检查。
- **归档与权限标志。** 管理页和 `links list` 的“全部”包含归档来源。agent 的 `check` 默认只看活动来源，加 `--include-archived` 才连归档一起看。链接按来源当前所在目录解析。主人命令按 §3.4 声明为 `readOnly: true`、`ownerOnly: false`，已授权 agent 同样可以运行它。插件不修改库内容，也不维护索引。
- **什么算 Markdown 链接。** 按 CommonMark 解析行内链接、图片、引用式链接和嵌入的 HTML。重复使用同一定义会报出每个使用位置。未使用的定义、代码例子、注释和普通文本中的路径不报。没有添加 wiki 链接语法。
- **什么算 HTML 链接。** 按元素和属性提取静态 URL，包括导航、图片、脚本和样式表引用、媒体、表单、`srcset` 候选、SVG 的 `href` 和声明式 `meta refresh` 的显式目标。解析 `noscript` 和模板里的字面引用。第一条有效参与文档的 `base[href]` 决定相对地址的起点；外站、站点绝对或越出库根的基址使相对地址无法归入本库。若基址指定另一份文件，纯片段、纯查询和空地址也可能指向该文件。不执行 JavaScript，也不展开 CSS 或模板语言。
- **如何判断缺失。** 去掉查询串和片段，每段百分号编码解码一次。绝对 URL、站点根路径、协议相对地址、越过库根的路径和明确的目录引用跳过。无扩展名的地址照查，不猜测 `index.html`。已存在的目录不算缺失文件。按本机文件系统判断存在性；畸形 UTF-8 转义、编码的路径分隔符或 NUL 跳过。
- **符号链接与变化中的文件。** 普通来源不沿符号链接读取。目标是库内别名时检查其指向；指向库内缺失文件的悬空别名会报，出库、循环或超过 40 跳的链跳过。绝对符号链接只接受以库真实根路径起头的地址。扫描只在本次调用中复用文件元数据。检查途中移走的来源会跳过，整次扫描没有跨文件的一致快照。
- **怎样定位。** 每次实际出现的引用单独占一行。行、列从 1 起算。Markdown 定位到链接或图片标记，HTML 定位到属性名。同一个 `srcset` 的候选共用属性位置。`href` 是语法解析后的值，所以 HTML 的 `&amp;` 会显示为 `&`；`target` 单列为去除查询串和片段、解码后的库内路径。

## 卡住、走错和绕过的地方

1. 我先按压缩包文件名把 SDK 写成了依赖名 `pneuma-base-sdk`。npm 会按这个名字安装，规范示例导入的却是 `@pneuma-base/sdk`。看过 `plugin new` 生成的清单后修正为后者，两份依赖都引用当前目录的 tgz。这个失误出在我的引导安装。规范 §1 示范全局安装，这次用项目内的 CLI 来隔离家目录。
2. npm 11.20.0 提示 esbuild 的 postinstall 尚未加入 allowScripts。平台二进制可用，后续构建成功，无需修改全局 npm 设置。规范附录 N8 已提到这一情形。
3. 解析交错 HTML 标签时，parse5 可能把一个源码标签恢复成多个 DOM 元素，最初会重复统计。现在按源码属性偏移去重，两个真正独立的引用仍报两次。默认解析模式还会略过 `noscript` 的后备资源，这两种情况都有回归用例。
4. 为核对真实点击，我尝试用隔离配置启动本机 Chrome 及项目内下载的 Chrome Headless Shell。两者都在打开页面前退出，后者明确报告 macOS 拒绝注册 Mach 服务。随后用 jsdom 加载临时库管理服务实际提供的页面和 ES 模块，点击导航和表格行。jsdom 需要补上浏览器的字体状态接口，且没有 Canvas 排版能力。这次验证覆盖点击处理、地址变化和面板内容；没有做像素、布局或真浏览器人工验收。这是验证环境的限制。

## 为弄明白这些事，我实际看过什么

正式依据是 `node_modules/pneuma-base/PLUGINS.md`。下面列出此外用到的材料，路径均相对项目，通用编程工具的规则另列。

| 材料 | 用途 |
| --- | --- |
| `.local/scaffold/package.json`、`tsconfig.json`、`scripts/build.mjs` | 本地 CLI 执行 `plugin new .local/scaffold --name links --packages .` 生成的样板。看了真实包名、版本、类型检查和打包方式。项目改用相对 tgz 路径，产物只有入口和认知段。 |
| `node_modules/@pneuma-base/sdk/dist/types.d.ts` | 查 `BundleFile`、路径工具、`CheckRequest`、`PluginSection`、面板钩子、行、单元格和块的公开声明。引导安装阶段也以未加作用域的安装路径查过同一份声明。递归搜索还命中过 `dist/kit/deploy/reconcile.d.ts`、`target.d.ts` 的类型引用行。列过包内文件名以定位声明。 |
| 当前项目的 `package.json`、`package-lock.json`、`tsconfig.json`、`.local/env.sh`、`src/` 和 `test/` | 核对本地安装路径、实际依赖、测试隔离、四个入口与解析器的字段约定。这些是本次写的文件。 |
| `.local/scan-probe/index.js`、自建试验文件、CLI 帮助与标准输出 | 用自己的探针查询缺失路径、包成员、符号链接。看了 `plugin new --help`、CLI 通用帮助、`plugin list`、`put`、`archive`、`check` 和 `links list` 的真实答复。 |
| SDK testkit 的黑盒结果，管理服务生成的页面和 DOM | 调用 `sandbox`、`conformance`、`viewer.state/view/item`。点击探针只加载和执行服务发来的前端模块，断言页面文本、表格行和地址片段。解析器也用短输入观察过实际输出。没有以 CLI、SDK 或管理界面的实现源码作参考。 |
| 通用的 TypeScript 开发指引 | 读了工具提供的 `typescript-best-practices/SKILL.md`、`poteto-mode/references/codex-tools.md` 和 `principle-type-system-discipline`、`principle-boundary-discipline` 两份规则，用于类型和工具使用。它们没提供 Pneuma 接口信息。 |

没有查找或阅读 Pneuma Base 源码仓库，也没有查看这台机器上别处的同名目录。

## 验收与复查

在 Node 26.13.0、npm 11.20.0 上，最终一次 `npm test` 通过 12 项，失败 0 项。其中一项调用官方 `conformance(dist, …)`，另有真实 CLI、查看器服务、文件系统边界和解析器测试。集成测试向库里补上目标文件后，再次打开管理页和面板、运行两条命令，坏链都已消失。测试输出保存在 `.local/test-result.txt`。

手工验收另建了 `init --bare` 的库，执行 `plugin install dist`、`plugin add links`，用 `put` 放入两个互相引用的文件。最终构建后再次安装，并用 `cmp` 核对 `index.js` 和认知段都与安装副本相同。`plugin list --library .local/library` 显示 `links 0.1.0  契约 1 · 装上来的 · 这个库装了`。agent 的 `check` 和主人的 `links list` 输出一致。

| 来源与位置 | 文档中的链接值 | 缺少的文件 |
| --- | --- | --- |
| `notes/guide.md:4:1` | `../plans/roadmap.md#时间` | `plans/roadmap.md` |
| `notes/guide.md:5:1` | `../assets/flow%20chart.svg` | `assets/flow chart.svg` |
| `pages/start.html:3:4` | `faq.html?lang=zh#问题` | `pages/faq.html` |

管理页一共三行。点击第三行后地址片段变为 `#view=links.broken&panel=item&panel.path=pages%2Fstart.html`，右侧表里仅一行，位置为 `3:4`。两份命令答复在 `.local/demo-check.json`、`.local/demo-list.json`，DOM 点击断言的结果在 `.local/dom-click.json`。临时管理服务已关闭，试验库和安装目录保留。

从当前目录复查这次试装，可执行以下命令。环境文件把 HOME、PNEUMA_BASE_HOME、npm 缓存和临时目录都指到项目的 `.local/`。

```sh
. .local/env.sh
npm test
./node_modules/.bin/pneuma-base --library .local/library --as demo check
./node_modules/.bin/pneuma-base --library .local/library links list
./node_modules/.bin/pneuma-base view .local/library --no-open
```

最后一条打印本次管理服务的本机地址。打开后点击「坏链接」，再点任意一行即可看对应源文件。
