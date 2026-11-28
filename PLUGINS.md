# Pneuma Base 插件规范

这份规范写给插件的作者：一个插件必须做什么，可以依赖什么。它对应插件契约第 2 版（`@pneuma-base/sdk` 的 `CONTRACT`）和 pneuma-base 0.9.0。读它不需要读 Pneuma Base 的源码，手里有 `pneuma-base plugin new` 生成的项目就够了。

规范在命令行的包里：插件项目 `npm install` 之后，它在 `node_modules/pneuma-base/PLUGINS.md`；`plugin new` 的答复也打印它的路径。第 1 到 3 节从头读一遍，第 4 节起是查用的参考。

规则写成「必须」「不得」「可以」，一条一句，后面说为什么。符合性检查（第 7 节）查得了的规则，后面标出查它的那一项，例如（检查：`writes`）。命令块后面的输出块是它打印的行，按次序，和路径有关的行省掉了。

## 1. 五分钟

要 Node 22.18 以上、npm、能联网，和一个放着两个包文件的目录：`pneuma-base-0.9.0.tgz`（命令行）和 `pneuma-base-sdk-0.9.0.tgz`（开发包）。有这两个文件就够了。在那个目录里照着运行：

<!-- test:slow -->
```sh
npm install ./pneuma-base-0.9.0.tgz                     # 把命令行装进这个目录的 node_modules/
export PATH="$PWD/node_modules/.bin:$PATH"              # 之后 pneuma-base 就是一条命令
pneuma-base plugin new marks --packages .               # 生成插件项目 marks/
cd marks
npm install                                             # 两个包文件，加上 esbuild、typescript、@types/node
printf '\n标记供所有者和后续 Agent 查看，不是 Agent 自己的笔记。\n' >> src/cognition.md
npm test                                                # 构建，再跑符合性检查和插件自己的测试
npm run install-local                                   # 装到这台机器
pneuma-base init ../lib                                 # 建一个库来试
pneuma-base plugin enable marks --library ../lib           # 在这个库里启用 marks
grep '不是 Agent 自己的笔记' ../lib/PNEUMA-BASE.md        # 改的那一句已经在库的说明里
echo '# 计划' | pneuma-base --library ../lib --as claude-code put - --to notes/plan.md --generated
pneuma-base --library ../lib --as claude-code say marks notes/plan.md "第三节的数字还没核对"
pneuma-base view ../lib                                 # 浏览器里打开管理界面，按 Ctrl+C 关
```

<!-- output -->
```text
ℹ pass 4
ℹ fail 0
已启用插件 marks，资料库说明已重新生成。
标记供所有者和后续 Agent 查看，不是 Agent 自己的笔记。
已记录（marks）：已为 notes/plan.md 添加标记。
```

第六行是「改一处」：给 agent 读的说明加一句。`npm test` 在临时的库上跑符合性检查，改坏了它用中文说哪条规则没守住。管理界面的导航里有「标记」一页：插件自己画的一块，和一张有刚才那条标记的表。

不改 `PATH` 也行：在装了命令行的目录里写 `npx -- pneuma-base …` 或 `node_modules/.bin/pneuma-base …`。插件项目依赖命令行，所以在 `marks/` 里 `npx -- pneuma-base` 用的是项目自己那一份。`--` 让 `--library` 这样的开关交给 `pneuma-base`，不被 npm 读走。要一份全机器都能用的，装到全局：`npm install --global ./pneuma-base-0.9.0.tgz`。

后面的命令都在 `marks/` 里运行：`../lib` 是装了 `marks` 的库，有 `notes/plan.md` 和它的一条标记。

## 2. 一个插件是什么

一个插件是一个目录：`index.js` 是 ES 模块，缺省导出插件对象；旁边可以有它导入的文件、`node_modules/` 和 `ui/`（它自己画的页）。脚手架的 `npm run build` 把 `src/` 打成这样一个目录 `dist/`。只有契约版本、名字和几个空列表的对象就是合法的插件：

```ts
import { CONTRACT, definePlugin, pluginName } from '@pneuma-base/sdk'

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('hello'),
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
})
```

`definePlugin` 原样交回参数，只为在写的地方按契约检查类型。

- 插件的 `index.js` 必须缺省导出插件对象，`contract` 必须写 `CONTRACT`，即 2（检查：`loads`）。这个 pneuma-base 只跑第 2 版契约。内核装载时核对这些和插件对象的形状（清单在第 8 节），不对就不装：写 `1` 的插件在 `plugin install` 和 `plugin enable` 时被拒绝，理由指向第 10 节「从第 1 版到第 2 版」，那里列出按第 1 版写的插件要改的地方。
- 插件不得导入另一个插件，也不得依赖另一个插件在不在。内核没有插件之间的槽，也没有插件之间的依赖。
- 插件可以只依赖 `@pneuma-base/sdk`。内核的工具经 `ctx.tools` 给你（4.2），所以一个带标记的目录（里面有标记文件 `.pneuma-item`、整个登记成一样东西的目录）算哪些文件、找怎么切词排序，和正在跑的内核永远一样。
- 插件只经 `ctx.tools.storage` 读写库（4.2）：看一样东西、读它的内容、写自己的记录，都是存储的一个操作。存储只在插件指到的地方看，从不替它走一遍库。
- 插件不得走一遍库：它跟着自己的记录，只在记录指到的地方问存储，一次取一页，不进没登记的目录，即自己没登记成一样东西、里面也没有登记过的东西的目录（检查：`bounded`）。库的文件夹里可以有任意多的东西，插件的代价要跟着它记着的那部分走（4.2 的「一页一页」）。
- 插件从它听到的放知道库里登记了什么：`onPut`（登记、放入、`register-files`、挪）、`onArchive`、`onPurged`。插件装进一个已经有东西的库时，装上之前登记过的东西它从登记补上：记着登记的插件（溯源插件）答 `registered`，工具 `registered` 一页一页地给出（4.2）；`plugin enable` 装上它之后，内核把这些一页一页交给它的 `catchUp`，`plugin backfill <插件名称>` 再补一次或接着补（3.5）。
- 内核不认识的字段，插件对象上的不管，块里的原样留着。
- 插件可以写 `version`、`title`、`summary` 和 `about`，`plugin list` 和设置页显示它们。`title` 是人会说的名字（溯源插件是「溯源」），`name` 仍是命令行里的标识，设置页把它放在提示里；`summary` 是一行短话，说它做什么，二十个字左右以内，设置页把它写在名字下面；`about` 是完整的说明，设置页放在名字旁的 ⓘ 里。没有 `title` 时显示 `name`，没有 `summary` 时显示认知段的标题。装到这台机器上来的插件，设置页轻轻地写出它的 `version`；自带的插件就是应用的版本，不写。
- 库的配置里只写插件名。说明、帮助、界面里的插件内容都来自插件对象。

## 3. 插件能做的七件事

插件对象上的每一组字段做一件事：

| 件 | 字段 |
| --- | --- |
| 3.1 往说明里加一段 | `cognition`、`onDescribe` |
| 3.2 参与六个动词 | `revise`、`onPut`、`onFind`、`onFound`、`onInspect`、`onCheck`、`onArchive` |
| 3.3 听一种「说」 | `statements`、`onSay` |
| 3.4 加主人命令 | `ownerCommands` |
| 3.5 旁听和生命周期 | `observe`、`onPurged`、`onAdd`、`onRemove`、`openDirs`、`catchUp`、`registered` |
| 3.6 加页面和条目面板里的一节，给首页添东西，问主人 | `views`、`onView`、`onItemView`、`ui`、`onAsks` |
| 3.7 记自己的东西 | `storage`、`secrets` |

### 3.1 往说明里加一段：认知段

库根目录的 `PNEUMA-BASE.md` 是写给 agent 的说明，内核把它拼成：内核的开头，每个已装插件的认知段（按配置次序），内核的规矩，当前的配置。配置一变就重拼。`cognition` 是 `{ title, text }` 或 `null`：`title` 进说明末尾的配置清单，`text` 是拼进去的 Markdown。脚手架把 `text` 放在 `src/cognition.md`，去掉 HTML 注释后读进来。`marks` 的这一段是：

````md
## 标记：为条目添加说明

此资料库已启用**标记**插件。条目有需要提醒所有者或后续 Agent 的事项时，为它添加一条标记：

```sh
pneuma-base @{{授权的名字}} say marks notes/plan.md "第三节的数字尚未核对"
```

标记只是一条说明，不修改条目本身。`pneuma-base @{{授权的名字}} marks list --path notes/plan.md` 列出该条目的标记；删除或处理标记需告知所有者。
````

- 认知段必须以 `## <功能>：<用法>` 开头，中间是全角冒号（检查：`cognition`）。agent 扫标题就知道装了什么。
- 标题后的第一句必须是「此资料库已启用**<title>**插件。」（检查：`cognition`）。卸下插件时，检查靠这一句确认它已经不在说明里。
- 命令示例必须写成 `pneuma-base @{{授权的名字}} …`，只用 `{{授权的名字}}` 这一个占位（检查：`cognition`）。拼说明时它换成 `<授权名称>`，agent 的技能文件告诉它自己的授权名；一个授权名同时定下是哪个库、是谁。别的 `{{…}}` 原样留下。
- 每条命令示例在新库上做完测试准备之后，必须照原样能跑，退出码是 0（检查：`examples`）。示例是 `sh` 代码块的每一行，和正文里不带别的 `<…>` 占位的 `` `pneuma-base @…` ``。
- 认知段不得重复内核管的规矩，不得写 `--include-archived` 和「在外部写好」（检查：`cognition`）。内核的那几段已经说了，说两遍会说岔。
- 认知段不得许诺插件不做的事，必须说清 agent 不该做、做不了的，比如只有主人能开的开关，出了问题该告诉主人还是重试。agent 照说明做，不知道的界限它会去试。这两条查不了，检查列成提醒。
- 插件可以写 `cognition: null`，那 agent 就不知道它在；只有不给 agent 用的插件才这样做。

**从自己的记录加一段。** 认知段是固定的字；要说出此刻的情形，比如设的部署目标对发布的东西有什么要求，写 `onDescribe(ctx)`：它从自己的记录读，答一段 Markdown 或 `null`。内核拼说明时把这一段接在它的认知段后面，空一行。内核每次写说明都问它：配置变了（建库、装卸插件、发撤授权），和这个插件的 `setup: true` 的主人命令答了 `done` 之后；拼出的字和库里的一样时不写。

- `onDescribe` 只能和不是 `null` 的 `cognition` 一起（检查：`loads`）。这一段接在认知段后面，没有认知段就没有地方放。
- 这一段和认知段守同样的规矩：只用 `{{授权的名字}}` 这一个占位，不许诺插件不做的事。
- 它只读，什么都不改。抛错、或答的不是文字也不是 `null` 时，这一段不加，算这个插件的问题，列在写说明的那次操作的答复里。

五个自带插件都装上时，整份说明不到 160 行。

### 3.2 参与六个动词

agent 手里有七个动词：放、找、看、说、查、归档、请。前六个背后有钩子；请（`ask`）没有，它把一条只给主人的命令交给主人决定（3.4）。试插件、写测试和认知段的示例都要用它们在命令行上的写法：

| 动词 | 写法 | 做什么 |
| --- | --- | --- |
| 放：放入 | `put <外部文件或目录> --to <库内路径> <来源> [--note "<说明>"]`；`put - --to …` 从标准输入读 | 把库外的东西复制进库。钩子拿到的 `kind` 是 `place` |
| 放：登记 | `put <库内路径> <来源> [--note "<说明>"] [--observed]` | 记下库里已有的文件或目录的来历，不读内容。没有标记的目录加上标记，整个成为一样东西，`kind` 是 `register`；展开的目录（里面或更深处有登记过的东西的目录：库根总是，别的由插件的 `openDirs` 说出，3.5）不加标记，它这一层的散文件各登记成文件，钩子一页（至多 200 个）收到一次 `register-files`。`--observed` 只给主人，和 `--imported --by owner` 一起写：来历是主人这边自动看到的（应用登记主人复制进库的文件），不是谁说的，钩子拿到的 `observed` 为 `true` |
| 放：挪 | `put <库内路径> --to <库内路径>` | 在库里挪位置，不写来历。`kind` 是 `move` |
| 找 | `find [<关键词>…] [--include-archived] [--scene <场景编号>] [--origin imported\|generated]` | 插件从自己的记录或索引里找；内核不按名字找（那要走一遍库），只给找到的路径标上「目录」「已归档」。没有会找的插件就什么都找不到 |
| 看 | `inspect <库内路径\|条目编号\|场景编号> [--content [<内部路径>] [--fetch]]` | 一样东西此刻的样子（令牌、大小、带标记的目录的第一层），和每个插件知道的；路径是一个不是东西的目录（展开的给它这一层，没登记的给带预算地数出的文件数和它顶上的项目标记，比如 `package.json`）或噪音（库的 `.pneuma-base/noise.json` 声明的名字和路径，比如任何一层的 `.git`、`node_modules`；存储从不报告、不进去）时，说它是哪一种。`--content` 再由内核给它的内容：不超过 256 KB 的 UTF-8 文字给全文，别的给大小和种类，带标记的目录给它的第一层，写了内部路径给那一层或那个文件；文件在本机只有同步服务的占位时，给内容在哪、多大（`elsewhere`），带 `--fetch` 先取回来再给；授权限在区域时，区域外的不给内容 |
| 说 | `say <类型> [<对象>] [<内容>] [--<开关> <值>…]` | 把一句话交给认领这个种类的插件（3.3） |
| 查 | `check [--since <时间>\|last] [--include-archived] [--deep [<目录>]]` | 每个插件说它知道的：发生了什么，现在要处理什么；再列出只有主人能定的事（3.6 的 `onAsks`），每个回答写成主人在自己终端里跑的命令。平常的查不读内容；`--deep` 是深查，读登记过的每样东西（写了目录就只读那下面的）的内容 |
| 归档、取回 | `archive <库内路径>`、`unarchive <库内路径>` | 挪进 `_archive/`，或挪回原处 |
| 请 | `ask "<原因>" <所有者命令…>`、`ask --withdraw <请求编号>` | 请主人做一条只给主人、不破坏的命令；主人批准就以主人的身份照原样跑，结果在 agent 下次 `check` 里。没有钩子 |
| 开始 | `start "<任务描述>"` | 说、查、找的组合：`say task "<任务描述>"`，`check --since last`，再按这句话里的词找，不带调用者这次会话做的 |
| 看一页 | `show [<页面 ID> [--<参数> <值>…]]` | 不是动词，是管理界面的一页，只读：不写编号列出这个库的页；写了打印那一页，每个按钮写成做同一件事的命令（3.6） |

`<来源>` 是 `--imported [--source <原始来源>] [--by owner]`（从外面带进来的），或 `--generated [--from <库内路径>…] [--from-external "<说明>"…]`（基于别的东西做出来的）。放入和登记必须写其中一个，只能写一个，不写以用法错误拒绝：库靠它让每样东西都回得到它是怎么来的。`put` 的第一个参数是相对路径时，调用者的工作目录里有这个文件或目录、又不在库里，就是放入，不然是库内路径。动词前面写库和身份：带授权写 `pneuma-base @<授权名称> <命令> …`，不带写 `pneuma-base --library <资料库目录> --as <Agent 名称> [--session <会话>] <命令> …`。加 `--json` 打印结果对象，测试读它。

请求和结果的形状不随插件变，插件在动词背后的钩子里加上它知道的。`onSay` 只调一个插件，别的钩子按配置次序调每个有它的插件：

| 钩子 | 什么时候被调 | 拿到的 | 可以答 |
| --- | --- | --- | --- |
| `revise` | 放入的目标上已有同类、内容不同的东西，写入之前；一个插件答了照样问下一个 | `PlaceOverExisting`：`{ path, token, current, incoming }`，路径解析过；`token` 是那里现在的状态，内核的写就预期它；`current` 是现在内容的指纹，读过才有，否则 `null`；`incoming` 是新内容的指纹，目录还没复制进来时 `null` | `{ outcome: 'held', note }`：插件把当前内容留在主人取得回的地方；`{ outcome: 'declined', reason }` |
| `onPut` | 内核接受了一次放（登记、放入、挪）之后，放的位置还被占着；被拒绝的放不调 | `AcceptedPut`，路径解析过（见下）；`note` 去掉了首尾空白，空的是 `null`；登记的 `observed` 为 `true` 时，来历是看到的，之后有人说的来历可以换掉它 | 一条说明 `{ text, data? }`、`{ note, problems }` 或 `null` |
| `onFind` | 每次找（`start` 也找） | `FindRequest`，`text` 是原样 | `PluginHit[]`，或 `{ hits, problems }` |
| `onFound` | 所有 `onFind` 都答完之后；只问它自己没给命中的路径，一个都没有就不问 | 路径（解析过）和 `FindRequest` | `PluginHit[]`，每条的 `path` 必须是问它的路径之一 |
| `onInspect` | 每次看 | `{ target, content? }`，`target` 原样：一个路径，或某个插件认得的编号；内容由内核给，插件不用管 `content` | `PluginSection[]` |
| `onSay` | 说的种类在它的 `statements` 里时 | `{ kind, about, text, args }`，`about` 和 `text` 是原样 | `{ outcome: 'heard', note, problems? }`，或 `{ outcome: 'not-heard', reason: 'refused', note }` |
| `onCheck` | 每次查 | `{ since, includeArchived, deep? }`；`deep` 是 `{ dir }`，深查的范围，`null` 是整个库 | `PluginSection[]` |
| `onArchive` | 归档或取回被接受之后；什么都没动（`moved` 为 `false`）也调 | `{ kind, from, to, moved }`，路径解析过 | 和 `onPut` 一样 |

一次放是占住位置、`revise`（要换内容时）、写入、`onPut`、放开位置、`observe`（3.5）；归档是占住来去两处、挪动、`onArchive`、放开、`observe`；找是 `onFind`、`onFound`、内核的标记、`observe`。「解析过」的路径是库内相对路径，以 `/` 分隔。「原样」是调用方写的字，相对库根或是库内的绝对路径，用 `ctx.tools.resolve` 解析。要跟着一样东西挪、归档、取回，用 `onPut` 和 `onArchive`：只有它们拿到挪动的来去。

**`onPut` 拿到的。** 一样东西靠存储的令牌认：令牌没变就是没变。指纹（内容的 sha256）只在内容经过内核时才有，所以 `AcceptedPut` 是这四种之一：

```ts
import type { Fingerprint, Instant, LibraryPath, Origin } from '@pneuma-base/sdk'

// 和 sdk 导出的 ThingNow、AcceptedPut 同形
type ThingNow = { token: string; kind: 'file' | 'bundle'; size: number | null; files: number | null; modifiedAt: Instant }
type Said = { origin: Origin; note: string | null; observed?: true }
type Source = { kind: 'file'; path: string } | { kind: 'directory'; path: string } | { kind: 'stdin' }

export type AcceptedPut =
  | ({ kind: 'register'; path: LibraryPath; fingerprint: Fingerprint | null; now: ThingNow } & Said) // 不读内容，fingerprint 是 null
  | { kind: 'place'; path: LibraryPath; fingerprint: Fingerprint; now: ThingNow; origin: Origin; note: string | null; source: Source; copied: boolean; previous: { token: string; fingerprint: Fingerprint | null } | null }
  | { kind: 'move'; from: LibraryPath; path: LibraryPath; fingerprint: Fingerprint | null; now: ThingNow } // 不读内容，fingerprint 是 null
  | ({ kind: 'register-files'; path: LibraryPath; files: { path: LibraryPath; now: ThingNow }[] } & Said)
```

- `now` 是存储此刻说的它：令牌、修改时刻、文件的字节数。带标记的目录的 `size` 和 `files` 只在它被复制进来时有，别的时候是 `null`：数它们要走整棵树。
- 放入（`place`）的 `fingerprint` 是复制的同一趟算的。登记和挪不读内容，`fingerprint` 是 `null`，插件凭 `now.token` 认它；要内容的指纹，自己用 `ctx.tools.storage.content` 读。
- `register-files` 是登记一个展开的目录：`path` 是那个目录，`files` 是它这一层的一页散文件，各带存储说的样子。插件登记它不认识的，认识的照原样留着。一页至多 200 个，多的分几次调。

**往已有的内容上放。** 放入的目标上已有内容不同的同类东西时，内核先按配置次序问每个有 `revise` 的插件。至少一个答 `held`，内核带着 `revise` 拿到的那个令牌换上新内容，再调 `onPut`：`kind` 是 `place`，`fingerprint` 是新内容的指纹，`previous` 是换下来的那份的令牌和指纹（读过才有），`copied` 为 `true`。目标在这中间又变了，写不成，这次放以 `busy` 拒绝。没有插件答 `held`，这次放以 `would-overwrite` 拒绝，不调 `onPut`。文件的大小一样时内核才读两边的指纹比；放入的内容和目标上的一样时，内核什么都不写，照样调 `onPut`，`copied` 为 `false`，`previous` 为 `null`。目录对带标记的目录一律当作内容不同。再登记一样已经登记过的东西，也照样调，`kind` 是 `register`。

放从写之前到所有插件的 `revise` 和 `onPut` 做完，一直占着它要改的位置（挪是来去两个）：这时别人的 `storage.look` 在 `held` 里列出它们，`storage.overview` 把它们标成 `held: true`，别的写以 `held` 拒绝。所以插件看库时，被占着的位置不是没人登记的，是放还没做完。放被杀时，占着的位置在两分钟后放开，放的是目录时十分钟。插件要报「没人登记的」「被改过的」这类东西，先看过位置，再读自己的记录：在这中间开始又做完的放，记录里已经有了。

**`keeps`。** 有 `revise` 的插件可以在插件对象上写 `keeps`：`every` 说它留住每一份换下来的内容；`some`（缺省）说它只留一部分，比如只留 agent 声明过有版本的。说明里讲「改一样已有的东西」的那一句按装了的插件选：没有插件有 `revise`，说 `put` 拒绝往已有的内容上放；有一个插件写 `every`，说换下来的内容由插件留着；其余的情形，说只有插件留住了旧内容才换上新的，不然拒绝。所以只有 `revise` 每次都答 `held` 的插件才写 `every`。

**`onArchive` 拿到的。** `kind` 是 `archive` 或 `unarchive`，`from` 和 `to` 是挪动的来去：

- 归档：`from` 是内容区的路径，`to` 是 `_archive/<路径>`。那里已有内容相同的东西时挪到它上面；内容不同时，`to` 的名字里加上指纹的前 8 位，比如 `_archive/notes/a.1a2b3c4d.md`。所以记归档到了哪里要用 `to`，不要从 `from` 自己算。
- 取回：`from` 是 `_archive/<路径>`，`to` 是原来的路径。
- 什么都没挪时 `moved` 为 `false`。归档一样只在归档区里的东西：`from` 是原来的路径，`to` 是 `_archive/<路径>`。取回一样已经在原处的东西：`from` 和 `to` 都是原来的路径。

**`onCheck` 拿到的。** `since` 是调用者写的时刻（`--since <时间>`），或 `'last'`（`--since last`，`start` 也这样问），或 `null`（没写 `--since`，agent 平常这样问）。`'last'` 和 `null` 都指调用者上次来过之后；内核不记这个时刻，要用的插件自己记。溯源插件把每次查记成一条「看过了」，「上次」就是上次查的时候，首页的「全部标为已读」也是一次查。说「发生了什么」的节按 `since` 截，只列那之后的事。说「现在怎样」的节不看 `since`：一个状况现在成立就报，比如还坏着的链接、超过上限的东西，不管它从什么时候开始。`includeArchived` 为 `false` 时，两种节都不带归档区里的东西；为 `true` 时都带。平常的查只拿存储的令牌比自己记过的位置，不读内容（`storage.look`，变了什么用 `storage.changed`）。带 `deep` 时是深查：主人或 agent 明说要读内容，插件读 `deep.dir` 下（`null` 是整个库）它记过的每样东西的内容，比出真正改了的；没有要比内容的插件照平常答。

**查的答复。** `CheckResult` 是 `{ sections, asks, requests, problems }`：`sections` 是各插件 `onCheck` 的节，`asks` 是各插件 `onAsks` 此刻的问题（3.6），每件由内核盖上插件名（`by`），`requests` 是调用者自己提的请求（内核的，3.4）：主人新决定了的前 20 个（`ended`；更多的有 `more` 个，下次查再说）和还在等的个数（`pending`）。命令行把它们印在「需所有者处理」下面，一件一行，下面是每个回答的主人命令（`pneuma-base <命令> --library <库>`），推荐的那个标「（推荐）」，最后一句告诉 agent：这些只有主人能定，告诉主人。

**节要有界。** 一节里的清单只列前 20 条（sdk 的 `TEXT_ROWS`），再写一共几条和看全部的命令（通常是自己的一页，`show <页面 ID>`）；`data` 里同样只带这 20 条、总数和那条命令。agent 的整份答复有上限：字 8 KB，JSON 32 KB。面按字印的次序放各节和各个问题，放不下的那一节、那个问题和它后面的，字里和 JSON 里都不带，答复的 `cut` 说少了什么、在哪看。所以一节越短，越不会被挤掉。

答复里不写插件名，内核盖上。`problems` 说插件那份做成了、库外的一步没成：说明照给，问题列成这个插件的，动词照旧答复。钩子抛错时只剩问题，别的插件照样被调；`onSay` 抛错时结果是 `not-heard`、理由 `plugin-failed`，`revise` 抛错算没留住。所以能答问题就不要抛错。下面的插件有新内容就通知主人设的网址，通知不到时放入照样成功：

```ts
import { CONTRACT, definePlugin, pluginName } from '@pneuma-base/sdk'

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('notify'),
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  secrets: [{ name: 'hook', description: '接收通知的 URL' }],

  async onPut(req, ctx) {
    // Only a place brings new content, and only it carries a fingerprint: a register or a move reads none.
    if (req.kind !== 'place') return null
    const url = await ctx.secrets.get('hook')
    if (url === null) return null
    const failed = await fetch(url, { method: 'POST', body: JSON.stringify({ path: req.path, fingerprint: req.fingerprint }) }).then(
      (reply) => (reply.ok ? null : `HTTP ${reply.status}`),
      (error: unknown) => String(error),
    )
    if (failed === null) return { text: `已发送 ${req.path} 的更新通知。` }
    return { note: null, problems: [`通知发送失败（${failed}）。添加已成功，无需重试；请告知所有者。`] }
  },
})
```

`onFind` 必须照找的请求 `FindRequest` 里的开关答：

| 请求里 | `onFind` | 为什么 |
| --- | --- | --- |
| `includeArchived` 为 `false` | 不得给归档区（`_archive/`）里的命中 | 默认的找不带归档的东西，命中全是插件给的，内核不替插件筛 |
| `match` 为 `words` | 最多给 `ctx.tools.sentenceHits` 条，用 `ctx.tools.rankHits` 排 | 找的是一句话里的词，每个答复者只给最好的几条 |
| `filters` 有它不认识的词 | 可以不答 | 过滤是某个插件的用语 |
| `skipOwnSession` 为 `true` | 不得给它知道是调用者这次会话做的东西 | `start` 打开它，找的是库里本来就有的 |

一条命中的 `group` 是它的标题：`group` 相同的命中合在一起，没有 `path` 的那条说的是标题本身。

### 3.3 听一种「说」

`say <类型> [<对象>] [<内容>]` 把一句话交给认领这个种类的插件：插件在 `statements` 里列出种类，在 `onSay` 里听，`marks` 的 `src/index.ts` 就是这样写的。只给一个参数时它是 `text`，`about` 是 `null`；给两个时是 `about` 和 `text`；`say` 后面的开关进 `args`，每个开关一个值的列表。

- 「说」的种类不得是空的，也不得带空白（检查：`names`）。种类是命令行上的一个词。
- 列了种类，就必须有 `onSay`。内核只把一句话交给有 `onSay` 的插件；没有它，种类被占着却没人听，结果是 `no-plugin-for-kind`。
- 一个种类只归一个插件。`plugin enable` 遇到库里已装的插件占着同一个种类，以 `name-taken` 拒绝，库不变：「未启用插件 <名字>：记录类型「<种类>」已属于插件 <持有者>。一个名称只能属于一个插件；如需改用 <名字>，请先停用 <持有者>。」主人命令名和视图编号也这样。配置被手改或同步过来已经撞名时，后面那个插件的这一项不接上，记成它的问题，在每个答复里列出。插件可以拿自己的名字作种类，免得撞。

```sh
pneuma-base --library ../lib --as claude-code say marks notes/plan.md "数字核对过了"
pneuma-base --library ../lib --as claude-code say marks notes/gone.md "不在的东西" || echo "退出码 $?"
pneuma-base --library ../lib --as claude-code say nobody "没有插件听这一种"; echo "退出码 $?"
```

<!-- output -->
```text
已记录（marks）：已为 notes/plan.md 添加标记。
未记录（refused）：资料库中不存在该条目：notes/gone.md
退出码 2
未记录（no-plugin-for-kind）：此资料库没有可记录此内容的插件
退出码 0
```

插件拒绝的，退出码 2；没有插件听的，不算拒绝，退出码 0。

### 3.4 加主人命令

主人面是 agent 不能做、主人能做的那一面：配置、装卸、发授权、丢数据。插件在 `ownerCommands` 里给它加命令，用 `defineCommand` 写，`run` 收到按参数表定好类型的值：

```ts
import { CONTRACT, defineCommand, definePlugin, pluginName } from '@pneuma-base/sdk'

const hello = defineCommand({
  name: 'greet hello',
  summary: '向一人或多人问好',
  params: {
    positional: [{ name: 'who', hint: '姓名', required: true, many: true }],
    flags: [
      { name: 'tone', hint: '语气', kind: 'value', options: [{ value: 'warm', label: '热情' }, { value: 'plain', label: '普通' }] },
      { name: 'loud', hint: '大声', kind: 'boolean' },
    ],
  },
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  // who: readonly string[]; tone: string | null; loud: boolean
  async run({ who, tone, loud }) {
    const opening = tone === 'warm' ? '很高兴见到你' : '你好'
    return { outcome: 'done', text: who.map((name) => `${opening}，${name}${loud ? '！' : '。'}`).join('\n'), data: { who } }
  },
})

export default definePlugin({ contract: CONTRACT, name: pluginName('greet'), cognition: null, storage: [], statements: [], ownerCommands: [hello] })
```

它的用法由参数表生成：`greet hello <姓名>… [--tone warm|plain] [--loud]`。

- 命令名必须是 `<插件名> ` 加一个或几个词，不得是内核自己的命令 `KERNEL_COMMAND_NAMES`（检查：`names`、`loads`）。两个插件的命令因此不会撞，`--help` 里也看得出是谁的。
- 每条命令都必须声明参数表 `params`，什么都不带的写 `{}`（检查：`loads`）。命令行按它读参数，内核按它核对，`--help` 的用法和界面的表单都从它生成，几处说的不会不一样。字段在 4.3。参数不合参数表时，内核以 `usage` 拒绝，说出哪一样，跟着用法，`run` 不被调。
- 既不是 `destructive` 也不是 `ownerOnly` 的命令 agent 也能用，所以它自动成为 MCP 服务（`pneuma-base @<授权名称> mcp`）的一个工具，插件什么都不用多写：工具名是命令名的词用 `_` 连起来（`greet hello` 是 `greet_hello`），工具的说明是 `summary`，输入由参数表生成：每个位置参数和开关是同名的属性，`value` 是文字，`list` 和 `many` 是文字的列表，`boolean` 是真假，`hint` 是属性的说明，`pattern`、`options` 和必填照搬，`readOnly` 成了工具的只读标记。答复和命令行的一样：`text` 是工具答的文字，整个结果是结构化的内容，拒绝标成出错。破坏性的和只给主人的命令不列出，按名字调也被同一道门拒绝；只给主人的，agent 用 `ask` 工具请主人做（下面的「被 agent 请」）。所以 `summary` 和 `hint` 是写给看不到源码、也看不到 `--help` 的 agent 的：`summary` 一句话说命令做什么，`hint` 说这个值要写什么。
- 一条命令要做一趟有名字的全量动作（比如登记一个目录里的全部文件）时，经 `ctx.pass` 报进度：先 `report({ done: 0, total, text })` 说要做多少，每做完一步再报一次，每步之间看 `stopped()`，为真就做完手上这一步停下，留下做过的，答的文字说做了多少。命令行把每次报告印在标准错误上，Ctrl-C 让 `stopped()` 为真；界面在通知里画进度条和「停止」。`total` 不知道时给 `null`，只知道至少多少时加 `atLeast: true`。没有谁看着时 `ctx.pass` 不在，照做就是。插件经 `ctx.tools.storage` 读写目录时，存储的进度自动接在最后一次报告后面。

五个标志说命令是哪一种。前两个是门，内核在同一处拦，插件不用自己看上下文；`askable` 只对只给主人的命令有用；后两个只改事件上的记号：

| 标志 | 在 agent 的会话里 | 在主人那里 | 哪些命令必须声明 |
| --- | --- | --- | --- |
| `destructive: true` | 以 `agent-session` 拒绝 | 要当面确认：终端里问，输入 `yes` 才做；别的回答、输入结束（Ctrl+D）、不在终端里，都以 `not-confirmed` 拒绝；界面里是动作的 `confirm` 那一问 | 丢数据、不能撤回的。它可以删、改写插件自己目录里的文件（3.7） |
| `ownerOnly: true` | 以 `agent-session` 拒绝；调用者是 agent 时，话的最后一行是请主人做它的 `ask` | 直接做 | 不丢数据、但替主人做决定的：对外发布、设部署或同步的目标、设密钥 |
| `askable: false` | 被拒时不给 `ask` 那一行；`ask` 请它以 `not-askable` 拒绝 | 直接做 | 只给主人、又要主人亲手给东西的：值从标准输入读的（像内核的 `secret set`），或要主人在场才能定的 |
| `readOnly: true` | 照做 | 照做 | 只看的：库里库外都不改，也不往外拿数据（导出不是只读的）。列东西、说状态的命令都是。看不是动作，溯源插件不为它记事实 |
| `setup: true` | 照做 | 照做 | 只改插件、目标这类配置、不动条目的。agent 第一次来之后再改才算消息 |

**被 agent 请。** 只给主人、不破坏的命令，插件不用多写什么，agent 就能请主人做：它在会话里被拒时，拒绝的话最后一行是 `pneuma-base @<授权名称> ask "<原因>" <命令和参数>`；agent 照着提，内核当场按这条命令的参数表核对参数，主人在首页或 `request list` 里批准，命令就以主人此刻的身份照原样跑，`run` 拿到的和主人自己跑时一样，事件多带一个 `request`（3.5）。破坏性的命令不能请，要主人当面确认。不想被请的写 `askable: false`；它只能写 `false`，写别的装载时拒绝（检查：`loads`）。

- `readOnly: true` 的命令必须什么都不改。符合性检查以主人身份跑每条参数都可省的 `readOnly` 命令，它出的问题算在 `hooks` 里，它改了东西算在 `writes` 里。
- 改了东西的命令写 `act`，活动页的那一行就说它做了什么：`{ kind, object?, name? }`。`kind` 是动作的种类，画成图标（`FEED_ACTS` 里的一个：`on`、`off`、`installed`、`set`、`synced`、`exported`、`removed`、`restored` 这些）；`object` 是参数表里一个位置参数或开关的名字，它的值是这一行的名字（`deploy publish <path>` 写 `object: 'path'`）；几个参数里给一个的，`object` 写它们的名字的列表，这一行取第一个给了的（空的算没给）；都没给，或没有这样的参数时，用 `name`，一个固定的名字（`sync now` 写 `name: '同步'`）。名字里有 `://` 的，活动页整个画出来，去掉前面的 `https://` 这类，不拆成文件夹和名字。不写 `act` 的，那一行的图标是命令，名字是命令名。命令的答复从不上那一行，照给的写法写出的命令在提示和 `show` 里。装载时核对它的形状（检查：`loads`）。
- `destructive: true` 的命令可以删、改写插件自己目录里的文件，库里别处的什么都不得动（检查：`writes`）。主人总能丢掉数据。符合性检查以主人身份跑每条参数都可省的破坏性命令，像人在界面里点了确认那样给它当面确认；要参数的，列成提醒。

**谁算 agent。** 调用带着授权、写了 `--as`，或环境里有 `PNEUMA_BASE_SESSION` 或 agent 产品的会话变量（4.1 列出），门就当它在 agent 的会话里，拒绝的话说出是哪一样。管理界面的服务用启动它的 shell 的环境，所以在 agent 的会话里启动的界面同样被拒。

**主人另给的值。** 命令要一个不能写在命令行上的值，比如账户密钥，在参数表里写 `secret: { name, hint }`（4.3），`run` 从 `secret()` 读它；`defineCommand` 把它作 `run` 的第三个参数。在终端里不回显地问「<hint>（输入时不显示）：」，不在终端里读标准输入，从界面来时是表单里那一项隐藏输入的值，经 MCP 总是 `null`。一次调用最多读一次，再调答同一个值；去掉末尾一个换行，空的算没给，是 `null`；命令没声明 `secret` 时也是 `null`，什么都不读。它不在 `values` 和参数里，不进事件和活动页；`run` 不得把它写进答复。要留着它，用 `ctx.secrets.set` 存在这台机器上（3.7）：

```ts
import { CONTRACT, defineCommand, definePlugin, pluginName } from '@pneuma-base/sdk'

const login = defineCommand({
  name: 'vault login',
  summary: '连上保险库，账户密钥存在这台机器上',
  params: { flags: [{ name: 'origin', hint: '地址', kind: 'value', required: true }], secret: { name: 'key', hint: '账户密钥' } },
  destructive: false,
  ownerOnly: true,
  askable: false,
  setup: true,
  async run({ origin }, ctx, secret) {
    const key = await secret()
    if (key === null) return { outcome: 'refused', reason: 'no-key', text: '没有读到账户密钥，什么都没改。' }
    await ctx.secrets.set('key', key)
    return { outcome: 'done', text: `已连上 ${origin}。` }
  },
})

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('vault'),
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [login],
  secrets: [{ name: 'key', description: '保险库的账户密钥' }],
})
```

`formOf(login)` 生成的表单最后一项是隐藏输入的「账户密钥」，经 `Call` 的 `stdin` 交给命令（4.4）。

**答复。** `run` 答 `{ outcome: 'done', text, data? }` 或 `{ outcome: 'refused', reason, text, offer? }`。命令行打印 `text`，带 `--json` 时打印整个结果；`data` 给 `--json` 和测试读。`offer` 是被拒绝之后人可以改做的一个动作，界面把它放在拒绝的提示里。

- `text` 必须是中文，不设定主人的性别。主人和 agent 都读它。
- `reason` 必须是英文短词，小写，用连字符，比如 `no-target`。程序比对它，人读 `text`。
- `run` 不得用抛错来拒绝。抛错时命令以「出错」结束，标准输出什么都没有，事件里的结果是 `failed`；拒绝时人读得到理由。
- `reason` 不得用 `usage`，除非真是用法错误。命令行把它当用法错误打印。

```sh
pneuma-base --help --library ../lib | grep -A1 'marks list'
pneuma-base --library ../lib marks list --path notes/plan.md
pneuma-base --library ../lib marks list notes/plan.md || echo "退出码 $?"
```

<!-- output -->
```text
  marks list [--path <库内路径>]
      列出 Agent 留下的标记，可只列出某个条目的标记（marks）
notes/plan.md：第三节的数字还没核对（claude-code）
退出码 1
用法错误：marks list 有多余的参数：notes/plan.md。
用法：marks list [--path <库内路径>]
```

**退出码。** 动词和主人命令共用：

| 退出码 | 什么时候 | 插件怎样得到它 |
| --- | --- | --- |
| 0 | 答复了，没有拒绝，答复里没有问题 | |
| 1 | 用法错误（含以 `usage` 拒绝），或出错。标准输出什么都没有，带 `--json` 也没有，说明在标准错误。不带参数的 `pneuma-base` 打印用法，也是 1 | 主人命令的 `run` 抛错 |
| 2 | 拒绝：结果是 `refused`，或说的结果是 `not-heard` 且理由是 `refused`。有拒绝时不看问题 | 答 `refused` |
| 3 | 没有拒绝，但答复里有问题：哪个插件的都算，也算这台机器载不了的插件 | 答 `problems`，或钩子抛错 |

### 3.5 旁听和生命周期

| 钩子 | 什么时候被调 | 拿到的 | 抛错时 |
| --- | --- | --- | --- |
| `observe` | 两个面的每次操作结束时，接受、拒绝、失败都调，按配置次序 | 一个事件 | 列成那次操作的答复里这个插件的问题 |
| `onPurged` | `archive purge` 删了东西之后；什么都没删就不调 | 被删的库内路径，都是 `_archive/…` | 列在 `archive purge` 的答复里 |
| `onAdd` | `plugin enable` 装上它、说明重拼之后，一次；已经装了的再 add 不调 | 上下文，`ctx.library` 里已经有它 | 列在 `plugin enable` 的答复里，照样装上 |
| `onRemove` | `plugin disable` 卸下它之前 | 上下文 | 列在答复里，不拦 |
| `openDirs` | 登记一个没有标记的目录时，看一个不是东西的目录时（`inspect`、文件页、条目面板），和界面看库变没变时 | 上下文；答它的记录让哪些目录展开：某一层下面有它登记过的东西的目录，库内路径的列表 | 列成问题，当它什么都没答 |
| `catchUp` | `plugin enable` 装上它之后，和 `plugin backfill` 时；库里有登记过的东西才调 | 登记的一页（`{ place, kind, token, fingerprinted }` 的列表，至多 500 样，同 `tools.registered`）和上下文。同一页可能再给一次：学两次和学一次要一样 | 停在这一页，列在答复里；下次从这一页接着补 |
| `registered` | 别的插件问 `tools.registered` 时，和内核补上时 | `{ after, limit }` 和上下文；答登记的一页 `{ things, more, total }`，见 4.2 的 `registered` | 抛给问的那一方 |

库根和插件 `openDirs` 答的目录是展开的目录。登记一个展开的目录不加标记，登记它这一层的散文件（`register-files`，3.2）；界面每 2 秒只看这些目录有没有变（3.6）。记着登记过的东西的插件该答它：不答，登记一个装着登记过的东西的目录会给它加上标记，把里面的东西并成一样。

agent 面的事件是 `{ face: 'agent', verb, request, result }`，失败时 `result` 是 `{ outcome: 'failed', message }`；主人面的是 `{ face: 'owner', command, args, destructive, readOnly, setup, act?, request?, result }`：命令声明了 `act` 时，`act` 是它的种类和这次针对的东西（`{ kind, object }`，没有对象是 `null`）；主人批准 agent 的请求时跑的那条命令带 `request: { id, by: { name, grant } }`，说是谁请的，被拒也照样发；批准这件事本身另是一条 `request approve` 的事件。agent 提请求和撤回是动词 `ask` 的事件，`result` 是 `AskResult`。主人命令结果里的 `data` 不在契约里，类型是 `unknown`：要知道清空了哪些、装卸了谁，用 `onPurged`、`onAdd`、`onRemove`。不发事件的有：视图和条目面板，开始之前就被拒绝的主人命令（没有这条命令，或要库却没给库），和不用指明库、也没带库运行的内核命令：`plugin install`、`plugin uninstall`、`plugin list`、三条 `secret`、四条 `storage`、`agent detect`、`agent disconnect`、`agent list`、`launcher install`。`plugin enable` 的事件在库重新打开之后发，刚装上的插件听得到；`plugin disable` 的事件发时它已经不在。

**补上。** 从放里学登记了什么的插件（搜索、同步、链接检查这样的）装进一个已经在用的库时，要补上装上之前登记过的东西，之后它对这些东西的答复和装着它时放进来的一样（检查：`catchup`）。内核替它做：`plugin enable` 装上它、调过 `onAdd` 之后，一页一页地取登记（`tools.registered`），交给它的 `catchUp`，直到最后一页。这是它的一次有名字的全量动作（`ctx.pass`，3.4），由内核报进度：先说一共多少样，每页报一次进度，人停下就停在那一页之后。补到哪里记在内核的记录处 `kernel` 里，`plugin backfill <插件名称>`（主人和 agent 都能用）从停下的那一页接着补，补完了的从头再补一遍。没补完时，内核在这个插件的找的命中、查的节、主人命令的答复和它的页上加一行：「启用前已登记的 2000 个条目已补录 500 个；继续补录：pneuma-base plugin backfill <插件名称>」。答 `registered` 的是配置里第一个有它的插件；没有这样的插件时登记是空的，`catchUp` 不调。插件只记着一部分东西（版本管理插件只记声明过的）就不用 `catchUp`：声明一样早就在库里的东西照常能做。

`onAdd` 可以答 `{ problems: [...] }`，比如目标连不上：照样装上，答复里列出。`onRemove` 可以答 `{ refuse: <一句中文> }`，说为什么、先要做什么：`plugin disable` 以 `plugin-refused` 拒绝，库不变；主人加 `--force`（界面里是「仍然停用」）照样卸下。主人总能卸下一个插件。

```ts
import { CONTRACT, definePlugin, pluginName, type PluginContext } from '@pneuma-base/sdk'
import { recordStore } from '@pneuma-base/sdk/kit'

type Entry = { command: string; outcome: string }
const parseEntry = (raw: Record<string, unknown>): Entry | string =>
  typeof raw.command === 'string' && typeof raw.outcome === 'string' ? { command: raw.command, outcome: raw.outcome } : '不是有效的记录'
const log = (ctx: PluginContext) => recordStore(ctx, 'log', parseEntry)

async function record(ctx: PluginContext, entry: Entry): Promise<void> {
  const store = log(ctx)
  await store.append([store.stamp(ctx, entry)])
}

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('audit'),
  cognition: null,
  storage: [{ dir: 'facts', kind: 'body' }],
  statements: [],
  ownerCommands: [],

  /** Every owner command that may change something, done, refused or failed. */
  async observe(event, ctx) {
    if (event.face === 'owner' && !event.readOnly) await record(ctx, { command: event.command, outcome: event.result.outcome })
  },
  async onPurged(paths, ctx) {
    await record(ctx, { command: 'archive purge', outcome: `已删除 ${paths.length} 个条目` })
  },
  async onRemove(ctx) {
    const kept = (await log(ctx).read()).records.length
    return kept === 0 ? undefined : { refuse: `已记录 ${kept} 条所有者操作；停用后不再记录，已有记录保留在资料库中。` }
  },
})
```

### 3.6 加页面和条目面板里的一节，给首页添东西，问主人

管理界面是 `pneuma-base view <库>` 打开的网页。看用视图，改用两个面：一个视图答一页带类型的块，界面只渲染块，不知道块来自哪个插件。命令行是全部本事的准绳，界面是它的一面：每一页也是一条只读的命令，`pneuma-base show <页面 ID> [--<参数> <值>…]` 把它印成字，`--json` 给出界面拿到的同一个答复；agent 带着授权或 `--as` 也能看，和 `inspect` 一样什么都不改、不发事件。插件有两处可以放块：

- 自己的页：在 `views` 里声明，在 `onView` 里答 `{ title, subtitle, blocks, refresh?, open?, trail? }`。`trail` 是从根起的一串 `Crumb`，页是一层层的文件夹时给：界面画成路径栏，代替标题和副标题，`show` 印上一层。`open` 是一个开在面板里的链接（`target: 'panel'`），比如列表的第一行：界面打开这一页、面板关着、窗口放得下页和面板时，在面板里打开它，每到这一页一次；`show` 不印它。不是开在面板里的链接被去掉，记成问题。`id` 必须以 `<插件名>.` 开头（检查：`names`）。`icon` 是 sdk 的 `IconName`（4.4），别的名字画成拼图。`nav: false` 的页只能经链接到达。`with: '<另一页的编号>'` 的页不单占导航的一项，和那一页共用一项：那几页的页头有一排图标在它们之间切换，命令面板的「前往」照样列出它，`show` 的页列表标出它和谁一个入口；写的编号不在时它自己占一项。导航短，人才找得到东西：一个插件的几页，除了主页都该 `with` 到主页或内核的某一页（比如设置一类的 `with: 'settings'`）。没给的筛选取它的 `default`，界面和 `show` 一样。管理用的页声明 `ownerOnly: true`：在 agent 的会话里以 `agent-session` 拒绝，话和只给主人的命令被拒时一样；别的页两边一样。
- 条目面板里的一节：一样东西在右侧面板打开时，内核按配置次序调每个插件的 `onItemView(路径, ctx, 面板)`，`面板` 是 `{ params, size }`：面板的参数和一页几行，节里的长列表按它分页（`Paging`，`target: 'panel'`，各用一个 `name`）；把答的 `{ title, blocks, actions? }` 盖上插件名，排在内核的头一行之后、文件的内容和事实之前；`actions` 是对这样东西的动作，不放在节里，并进面板的头，排在归档和挪之后：标了 `as: 'icon'` 的画成图标，别的进头上的「···」，标了 `as: 'primary'` 的是面板唯一的主按钮（4.4 的 `Action`）。答 `null` 就没有这一节。路径上没有东西也调；只在归档区的东西，路径是 `_archive/…`；内核自己的文件不调。带标记的目录里的每个文件也有自己的面板：目录的面板列出里面的文件，点一个就打开它的面板。这时 `onItemView` 拿到那个文件的库内路径，比如 `site/index.html`，不是目录的；面板里没有归档按钮，因为目录只能整个归档。

- 首页：视图声明 `home: true`，它的块就放在首页上，在「待处理」之后，按配置次序，用每个筛选的默认值。它可以同时 `nav: false`，只在首页出现。首页是界面打开时的那一页，所以只放主人一来就该看到的：发生了什么、哪里要留意，用 `feed`、`list`、`stats` 这些块。首页视图答复里的 `steps` 块例外：它不在原处画，它的步骤接在内核的「连接 Agent」「添加第一个条目」后面，并进首页最上面的「快速开始」；有一步没做，「快速开始」就在，都做完了就没了。一步做没做完由插件每次按库的状态算，不要记标记。溯源插件这样给出「向 Agent 发出第一条指令」。
- 问主人：`onAsks(ctx)` 答此刻只有主人能定的事，`PluginAsk[]`，每件 `{ key, text, about, actions, suggested?, command? }`：`key` 在这个插件里不重复，`text` 是一句问话，`about` 是关于的库内路径或 `null`，`actions` 是几个回答（只给主人的命令也行），`suggested` 是推荐的那个回答在 `actions` 里的位置，`command` 是这件事说到的一条命令行，照原样印在问话下面。它们出现在首页最上面的「待处理」里（署插件的认知段标题），也在 agent 的 `check` 里。agent 请主人做的事（`ask`）和你的一个回答调的是同一条主人命令、同样的参数时，请求代替你这一件：请求在等时只出现请求，带着它的为什么；主人拒绝之后，这一件也不再出现；批准就跑了那条命令，你之后还问的是新的事。所以回答要写全参数（不留输入），请求才认得出它。`onAsks` 只读，首页每次显示、`check` 每次答都会问：插件按自己的记录答，主人回答之后记录变了，就不再问这一件。界面里回答之后，那一件在原处折成一行回执。不合的一件（不是一件、回答调不到、推荐的不在回答里）去掉，列进问题。

钩子抛错或答得不对时，内核在那里放一块说明出错，把问题列进答复。

```ts
import { fileURLToPath } from 'node:url'
import { CONTRACT, definePlugin, instant, isFailure, pluginName, type Block, type LibraryPath, type PluginContext } from '@pneuma-base/sdk'

const NAME = pluginName('sizes')
const PAGE = `${NAME}.largest`

/** The largest files of the first page of the library's root level: storage lists one level, a page at a time, and walks nothing. */
async function largest(ctx: PluginContext, count: number) {
  const page = await ctx.tools.storage.overview('', { limit: 200 })
  if (isFailure(page)) return []
  return page.entries
    .filter((e) => e.kind === 'file' && ctx.tools.regionOf(e.place as LibraryPath) === 'content')
    .map((e) => ({ path: e.place, size: e.size ?? 0, modifiedAt: instant(e.modified ?? 0) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, count)
}

export default definePlugin({
  contract: CONTRACT,
  name: NAME,
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  views: [{ id: PAGE, title: '大文件', icon: 'database', nav: true, filters: [{ name: 'top', label: '数量', options: [{ value: '10', label: '10 个' }, { value: '50', label: '50 个' }], default: '10' }] }],
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),

  async onView(req, ctx) {
    const rows = await largest(ctx, Number(req.params.top ?? '10'))
    const blocks: Block[] = [
      {
        kind: 'custom',
        entry: 'bars.html',
        height: 96,
        text: rows.map((r) => `${r.path}：${r.size} 字节`).join('\n'),
        data: rows.map((r) => ({ path: r.path, size: r.size })),
        actions: {},
      },
      {
        kind: 'table',
        columns: [{ key: 'path', label: '文件' }, { key: 'size', label: '大小' }, { key: 'at', label: '修改时间', optional: true }],
        rows: rows.map((r) => ({
          key: r.path,
          cells: {
            path: { text: r.path, mono: true, icon: 'file' },
            size: { text: `${Math.ceil(r.size / 1024)} KB` },
            at: { text: r.modifiedAt, at: r.modifiedAt },
          },
          link: { view: 'item', params: { path: r.path }, target: 'panel' },
          actions: [{ label: '归档', tone: 'default', confirm: `归档 ${r.path}？`, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path: r.path } } }],
        })),
        empty: '资料库根目录中暂无文件',
      },
    ]
    return { title: '大文件', subtitle: `资料库根目录中最大的 ${rows.length} 个文件`, blocks }
  },

  async onItemView(path, ctx) {
    const [at] = await ctx.tools.what([path])
    if (at?.kind !== 'file' || at.entry === null) return null
    return { title: '大小', blocks: [{ kind: 'fields', fields: [{ label: '字节', value: { text: String(at.entry.size ?? 0), mono: true } }] }] }
  },
})
```

**第一级：带类型的块**，种类和字段在 sdk 的 `Block` 里（4.4）。样子、深浅色、键盘、窄屏都由界面管。

- 插件给的每一块都必须合 sdk 的类型（检查：`blocks`）。不合的那一块，包括不认识的种类，换成一段说明出错的文字，记成插件的问题，页的其余部分照常。
- 块上的每个动作都必须调一个动词，或这个库里在的一条主人命令，参数合它的参数表；「说」要有插件听这个种类；`call` 里写的 `{输入名}` 都要是这个动作的输入（检查：`blocks`）。不合的同样换成说明出错的文字。按钮和命令是同一个调用，所以 `show` 把每个动作印成做同一件事的命令行：`$ deploy unpublish sites/shop  # 取消发布（仅所有者）`，问话跟在「；需确认：」后面，没填的输入照用法写成 `<提示>`。
- 能用第一级的块说的，就用第一级。

**第二级：`custom` 块。** 第一级说不出的，比如一条小图，插件在 `ui` 目录里画自己的页。页载入界面给的 `/plugin-kit/frame.js` 和 `frame.css`，用 `pneuma.onData` 收块的数据，用 `pneuma.run` 做块里声明的动作，用 `pneuma.open` 打开视图或地址，样式跟着界面走。接口、类、变量和例子在 4.5，类型在 `@pneuma-base/sdk/frame`。

- `custom` 块必须带 `text`：用字说出这一块画的，和给框架的 `data` 出自同一份数据（检查：`blocks`）。`show` 印它，读屏软件读它，页打不开时界面显示它。agent 看不到画，只看得到这段字。
- `custom` 块指向的页必须在插件的 `ui` 目录里，取得到（检查：`blocks`）。
- 页必须载入 `/plugin-kit/frame.js`，脚本里必须调用 `pneuma.onData`（检查：`blocks`）。没有它们，界面等不到页握手，5 秒后把这一块换成一段说明。检查不在浏览器里跑页：它读页的文本，和页在 `ui` 目录里直接载入的脚本，只看这两样在不在。脚本出错、画得不对，它看不出，要在浏览器里自己看。

**重取。** 界面只在这几种时候重取一个视图：库的摘要变了，界面每 2 秒看一次；摘要由每个插件的事实到哪、展开的目录的令牌、内核从存储学到的展开的目录那一层里的改动算出，从不走一遍库；做完一个动作；到了视图答复里 `refresh` 的秒数，最少 5 秒；连不上服务之后又连上。

- 视图和条目面板里的一节不得写任何东西，从事实推出行除外（检查：`writes`）。写了，摘要就变，界面就再取，没完没了；行在存储的缓存区，不进摘要（3.7）。
- 读库外的东西（比如部署目标上的状态）的视图必须带 `refresh`。库外的变化不改摘要。
- 内容随时钟变的视图可以带 `refresh`。比如「最近 30 天」的格子：库没变，过了午夜也该往前挪一格。
- `refresh` 必须是数字。不是数字的被去掉，记成问题。

**时间。** 视图、条目面板和钩子都在管理界面的服务所在的机器上运行：`ctx.now` 和 Node 的本地时区都是那台机器的。看界面的人的时区是浏览器的，带 `at` 的格按它显示。按天统计的插件选一种做法：把时刻交给自己画的页（`custom` 块的 `data`），在页里按浏览器的时区分天；或者在视图里分天，并在页上写明天是按这台机器的时区分的。

**地址。** 界面把打开的视图和面板记在地址的片段里：`#view=<视图编号>&view.<参数>=<值>&panel=<视图编号>&panel.<参数>=<值>`，刷新、后退、粘贴都打开同样的东西。在 `pneuma-base view` 打印的地址后面加上片段，就直接打开它们，比如 `…/?token=…#view=marks.marks&panel=item&panel.path=notes/plan.md`。令牌每次启动都换。

### 3.7 记自己的东西

插件的记录处在库里的 `.pneuma-base/<插件名>/`，记录处的名字就是插件名。插件只经 `ctx.tools.storage` 用它（4.2）：`records` 是它的事实，只追加，在 `facts/` 下，和从事实推出的行，行在存储的缓存区，可以丢掉；`own` 是事实以外的地方，放留存、配置这类内容。内核不建记录处：还没写过时，`own` 读起来是一个空目录，`records` 没有事实；第一次写就建立它。

- 插件不得往库里自己名下的 `.pneuma-base/<插件名>/` 以外的地方写（检查：`writes`）。库的内容归主人和 agent，别处归内核和别的插件。
- 主人命令要改库的内容，必须经 `ctx.tools.put`，不得直接写内容区的文件。这样行动者和会话是这次操作的，每个插件都听到，还留下事件。
- 六个动词的钩子不得改内容，经 `tools.put` 也不行（检查：`writes`）。agent 的一次放、找、看只该改它自己说的那样东西。
- 自己目录里已有的文件不得改写、不得删（检查：`writes`）。例外有三样：声明为缓存的目录；整份替换的配置文件（符合性检查的 `configuration` 选项列出它们）；破坏性的主人命令。主人总能丢掉数据，所以 `destructive: true` 的命令可以删、改写自己目录里的任何文件。
- 插件必须在 `storage` 里声明自己目录下的每个目录是本体（`body`）还是缓存（`cache`），`dir` 相对自己的目录，`.` 是它本身。本体跟着库同步；缓存删了能重建。
- 缓存删掉不得丢任何东西（检查：`cache`）：删掉本机的缓存目录、声明为缓存的目录和它记录处的行前后，找、看、查答得一样。行要能从事实重新推出。
- 读到不认识的内容，原样留着。更新的版本在另一台机器上写的记录，旧版本读不懂也不得删。

agent 的动作引起的记录，和插件平常运行写的记录，只新增，不改写：一个库有几个写入者（agent 的会话、界面里的主人、几台机器），同步工具还会把别处写的文件整个搬来。两处改同一个文件会丢改动；各写一批新的事实，合起来就是并集。存储的 `records.append` 把一批事实写成一个名字唯一的新文件，从不改写写过的事实；sdk 的 `recordStore` 在这上面给每条盖上编号（时间、写入者、次序）和谁、哪次会话，读时一页一页地按存储给的次序读。配置整份替换，最后一次写的算数：sdk 的 `configFile` 经 `own.write` 整份写，带着读到时的令牌，中间别人写过就重新看一眼那里的令牌再写。

只有破坏性的主人命令删、改写记录。装了 `sync` 插件时，删掉的记录这样传到别的副本：

1. 一条破坏性的主人命令答 `done` 之后，`sync` 记下这台机器上一次同步时有、现在库里不在了的文件，各带当时内容的指纹。插件自己目录里的文件也在内，缓存目录除外。
2. 下一次同步在目标上删掉这些文件。别的副本同步时，也删掉自己那一份，不会带回来。
3. 只删内容和上一次同步时一样的。上一次同步之后才写的、在别处改过的，照常同步。

这台机器还没同步过时，`sync` 什么都不记。答 `refused` 或抛错的命令，`sync` 也不记，删掉的文件在下一次同步时从目标回来。所以删了文件的命令要答 `done`。

下面的插件记下主人设的上限（配置，整份替换）和它听到放进来的文件（记录，只新增），查的时候只看这些文件现在多大：

```ts
import { CONTRACT, defineCommand, definePlugin, isDescribed, pluginName, type PluginContext } from '@pneuma-base/sdk'
import { configFile, recordStore } from '@pneuma-base/sdk/kit'

type Settings = { format: 1; limitMb: number }

function parseSettings(raw: unknown): Settings {
  const r = raw as Partial<Settings> | null
  if (r?.format !== 1 || typeof r.limitMb !== 'number') throw new Error('settings.json 不是有效的 quota 配置')
  return { format: 1, limitMb: r.limitMb }
}

const settings = (ctx: PluginContext) => configFile(ctx, 'settings.json', parseSettings)
/** The files it heard put: the places its check looks at. */
const heard = (ctx: PluginContext) => recordStore(ctx, 'heard', (raw) => (typeof raw.path === 'string' ? { path: raw.path } : '不是有效的记录'))

const limit = defineCommand({
  name: 'quota limit',
  summary: '设置单个条目的大小上限',
  params: { positional: [{ name: 'mb', hint: '上限，单位 MB', required: true, pattern: '[1-9][0-9]*' }] },
  destructive: false,
  ownerOnly: true,
  setup: true,
  async run({ mb }, ctx) {
    await settings(ctx).write({ format: 1, limitMb: Number(mb) })
    return { outcome: 'done', text: `上限已设为 ${mb} MB。` }
  },
})

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('quota'),
  cognition: null,
  storage: [{ dir: '.', kind: 'body' }],
  statements: [],
  ownerCommands: [limit],

  async onPut(req, ctx) {
    const paths = req.kind === 'register-files' ? req.files.map((f) => f.path) : req.now.kind === 'file' ? [req.path] : []
    const store = heard(ctx)
    await store.append(paths.map((path) => store.stamp(ctx, { path })))
    return null
  },

  async onCheck(_req, ctx) {
    const limitMb = (await settings(ctx).read())?.limitMb ?? null
    if (limitMb === null) return []
    // Only the places its records point to, a thousand at a time: no directory is listed.
    const paths = [...new Set((await heard(ctx).read()).records.map((r) => r.path))]
    const over: string[] = []
    for (let i = 0; i < paths.length; i += 1000) {
      for (const at of await ctx.tools.storage.glance(paths.slice(i, i + 1000))) {
        if (isDescribed(at) && at.kind === 'file' && (at.size ?? 0) > limitMb * 1024 * 1024) over.push(at.place)
      }
    }
    return over.length === 0 ? [] : [{ title: `超过 ${limitMb} MB 的文件`, body: over.join('\n'), data: { over } }]
  },
})
```

挪走、归档了的文件，原来的位置上什么都没有，`glance` 答 `none`，它就不报。`quota` 每次查都从头读全部记录，记录少时这样就够了。

**事实和行。** 记录处里有两样。事实是本体：`records.append` 写一批，从不改写，随库同步。行是从事实推出的、按它问的数据：在存储的缓存区，不同步，缓存删掉时连同存下的游标一起没了。推行的做法只有一种：从存下的游标读之后的事实（`records.since`，一次一页），折进行里，用 `records.put(表, { cursor, expect })` 把这些行和新的游标在一次提交里存下；`expect` 是读之前存下的游标，别的进程先存了新的，就什么都不写，重读再推。游标对不上那里的事实（`since` 答 `null`）时，`reset()` 丢掉全部的行，从头推；缓存删掉之后存下的游标是 `null`，也是从头推。问行按键（`get`）、按键的前缀（`under`）或按字段（`where`、`count`），一次一页。记录少的插件用开发包的 `recordStore`（上面的 `quota`）；记录会多的，像下面这样推出行，问什么查什么：

```ts
import { CONTRACT, defineCommand, definePlugin, pluginName, type RecordPlace, type Row } from '@pneuma-base/sdk'

type Put = { path: string; agent: string; at: string }
const TABLE = 'by-path'

/** The rows brought up to the facts: the facts after the saved cursor, a page at a time, saved as rows with the cursor they reach. */
async function caughtUp(records: RecordPlace): Promise<void> {
  for (;;) {
    const { cursor } = await records.get(TABLE, [])
    const page = await records.since(cursor, 1000)
    if (page === null) {
      // The facts no longer fit the cursor: derive every row again.
      await records.reset()
      continue
    }
    if (page.cursor === cursor) return
    const rows: Row[] = page.facts.map(({ fact }) => {
      const put = fact as Put
      return { key: put.path, fields: { agent: put.agent }, value: put }
    })
    const saved = await records.put({ [TABLE]: rows }, { cursor: page.cursor, expect: cursor })
    if (saved.written && !page.more) return
  }
}

const byAgent = defineCommand({
  name: 'who by',
  summary: '列出某个 Agent 最近添加的条目，每次一页',
  params: { positional: [{ name: 'agent', hint: 'Agent 名称', required: true }], flags: [{ name: 'after', hint: '从此路径之后开始', kind: 'value' }] },
  destructive: false,
  ownerOnly: false,
  readOnly: true,
  async run({ agent, after }, ctx) {
    const { records } = ctx.tools.storage
    await caughtUp(records)
    const page = await records.where<Put>(TABLE, 'agent', agent, { limit: 100, ...(after === null ? {} : { after }) })
    const lines = page.rows.map((r) => `${r.key}（${r.value.at}）`)
    if (page.more !== null) lines.push(`下一页：who by ${agent} --after ${page.more.after}`)
    return { outcome: 'done', text: lines.join('\n') || `${agent} 暂无添加的条目。` }
  },
})

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('who'),
  cognition: null,
  storage: [{ dir: 'facts', kind: 'body' }],
  statements: [],
  ownerCommands: [byAgent],

  async onPut(req, ctx) {
    if ((req.kind !== 'place' && req.kind !== 'register') || ctx.actor.kind !== 'agent') return null
    await ctx.tools.storage.records.append([{ path: req.path, agent: ctx.actor.name, at: ctx.now }])
    return null
  },
})
```

行在缓存区，推行时写它们不算改了库，只读的命令和视图也可以推。缓存删掉之后，下一次 `who by` 从头推出同样的行，答得和删掉之前一样。

库外的缓存 `ctx.cacheDir` 是 `$PNEUMA_BASE_HOME/cache/<库的 id>/<插件名>/`，因为索引这类文件经不起同步。内核不建它，也没有谁清理它。

令牌这类凭证不得放进库：库会被同步、会给别的 agent 看。插件在 `secrets` 里声明它读的密钥，各带一句中文说明，可以带 `title`，是页面上显示的名称（如「API 密钥」），没有时显示 `name`；插件没有它也能用的，比如只有一部分服务器要的令牌，标 `optional: true`。`ctx.secrets.get(名字)` 读，没设是 `null`。主人在这台机器上设：值从标准输入读，从不取命令行的参数，存在库外的 `$PNEUMA_BASE_HOME/secrets/<插件名>/<密钥名>`，只有用户能读。设置页列出每个密钥设没设（可选的写「未设置（可选）」）并能设它，`secret list` 把可选的另列一行：

```sh
printf %s 'sk-例子' | pneuma-base secret set search key
pneuma-base secret list search
pneuma-base secret remove search key
```

主人命令拿到的凭证（3.4 的 `secret()`）要留着时，`ctx.secrets.set(名字, 值)` 把它存在这台机器上，和 `secret set` 存的一样。只能存 `secrets` 里声明的名字，值不空、不长过 64 KB，只在主人命令里存；不是这样时它抛错。钩子和视图不存密钥。

`plugin disable` 停用插件后，它名下的目录原样留着；`plugin uninstall` 从这台机器卸掉它后，它的密钥原样留着。

## 4. 参考：上下文、参数表、块和自己画的页

### 4.1 上下文

每个钩子和主人命令的 `run` 都收到一个 `PluginContext`：

| 字段 | 是什么 |
| --- | --- |
| `library` | 这次操作的库：`root`（绝对的真实路径）、`config`（`id`、插件名的列表、授权）、`plugins`（装了、这台机器载得了的插件，按配置次序）、`unavailable`（装了、载不了的名字）、`clashes`（撞名没接上的） |
| `actor` | 谁在做：`{ kind: 'agent', name, grant }`，或 `{ kind: 'owner' }`，主人没有名字（`recordStore` 盖的记录里写 `name: 'owner'`，见第 5 节）。带授权时是授权给的 agent；写了 `--as <名字>` 时是那个名字；环境里有 `CLAUDE_CODE_SESSION_ID` 或 `CLAUDECODE` 时是 `claude-code`，有 `CODEX_THREAD_ID` 时是 `codex`，有 `ANTIGRAVITY_CONVERSATION_ID` 或 `ANTIGRAVITY_AGENT` 时是 `antigravity`；都没有是主人。只有 `PNEUMA_BASE_SESSION` 时行动者是主人，但主人命令的门照样拒绝（3.4）。界面里总是主人。类型里还有 `{ kind: 'plugin', name }`，今天的内核不给 |
| `session` | 这次会话：`id` 依次取 `--session`、环境变量 `PNEUMA_BASE_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`，都没有就为这次调用造一个，`source` 相应是 `flag`、`env`、`minted`；`cwd` 是调用方的工作目录，界面里是服务进程的，主人命令里写的相对路径按它解析；`machine` 是主机名；`transcript` 是这次会话的对话在这台机器上的哪个文件：`{ path, resume }`，`path` 把家目录写成 `~`，`resume` 是接着这段对话的命令，产品没有时为 `null`。只在会话号来自 `CLAUDE_CODE_SESSION_ID` 或 `CODEX_THREAD_ID`、文件也在时才有，别的时候是 `null`（规则见 `ARCHITECTURE.md`「接上一个 agent」）。它是指针：插件别读它指的文件 |
| `now` | 这次操作的时刻，ISO 8601 |
| `home` | 本机的 `$PNEUMA_BASE_HOME`，缺省 `~/.pneuma-base` |
| `pass` | 可选：这次操作是一趟有名字的全量动作、有人看着时才有。`report({ done, total, atLeast?, text })` 报进度，`total` 不知道时是 `null`；`stopped()` 为真时做完手上这一步就停（3.4）。插件经 `tools.storage` 读写目录时，存储的进度也接在它最后一次报告后面 |
| `cacheDir` | 插件在库外的缓存目录，内核不建（3.7） |
| `secrets` | `get(名字)`：主人在这台机器上给它设的密钥，没设是 `null`；`set(名字, 值)`：主人命令把拿到的凭证存在这台机器上（3.7） |
| `tools` | 内核的工具，绑在这次操作的库上，见 4.2。插件的记录处经 `tools.storage` 读写，上下文里没有它的路径 |

主人命令的门（3.4）在下面任何一样成立时当调用在 agent 的会话里：带着授权（`pneuma-base @<授权名称> …`）；写了 `--as <名字>`；环境里有这些变量之一，值不空：`PNEUMA_BASE_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`CLAUDECODE`、`ANTIGRAVITY_AGENT`。主人在 agent 产品开的终端里用主人命令，先去掉这些变量：

```sh
PNEUMA_BASE_SESSION=demo pneuma-base plugin enable marks --library ../lib || echo "退出码 $?"
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u ANTIGRAVITY_CONVERSATION_ID -u ANTIGRAVITY_AGENT -u PNEUMA_BASE_SESSION pneuma-base plugin enable marks --library ../lib
```

<!-- output -->
```text
拒绝（agent-session）：「plugin enable」仅所有者可执行，不能在 Agent 会话中执行（环境中有 PNEUMA_BASE_SESSION）。请所有者在自己的终端中执行，或运行 pneuma-base view 在管理界面中操作。
退出码 2
插件 marks 已启用。
```

### 4.2 工具

`ctx.tools` 是正在跑的内核自己的代码，所以一个带标记的目录算哪些文件、找怎么切词排序，插件和内核永远一样。工具收的和答的路径都是库内路径：相对库根，以 `/` 分隔。名字后面带「异步」的答一个 `Promise`。

| 工具 | 答什么 | 说明 |
| --- | --- | --- |
| `resolve(输入)`，异步 | `{ path, region, bundle }` 或 `null` | 把调用方写的路径（相对库根，或库内的绝对路径）解析成库内路径。不问那里有没有东西：`resolve('notes/absent.md')` 照样答 `{ path: 'notes/absent.md', region: 'content', bundle: null }`。只有指向库根本身或库外时答 `null`：空的、`.`、爬出库根的 `../x.md`、库外的绝对路径。`region` 是 `content`（内容）、`archive`（`_archive/`）或 `kernel`（`.pneuma-base/` 和 `PNEUMA-BASE.md`）；`bundle` 是它所在的带标记的目录，不在任何一个里是 `null` |
| `regionOf(路径)` | `'content'`、`'archive'` 或 `'kernel'` | 这个路径在哪一区 |
| `archivedPath(路径)` | 库内路径 | 内容路径在归档区的位置：`a.md` 是 `_archive/a.md` |
| `originalPath(路径)` | 库内路径或 `null` | 归档区路径原来的位置；`_archive` 本身是 `null` |
| `what(路径列表)`，异步 | `{ path, kind, entry }` 的列表，一个路径一项 | 每个路径上作为东西是什么，看一眼这些路径和它们的标记就答：`kind` 是 `file`、`bundle`（带标记的目录）、`folder`（没有标记的目录）、`other`（链接、设备）或 `none`；`entry` 是存储对它的描述（见下表的 `glance`），什么都没有时 `null`。带标记的目录里面的文件照样是 `file` |
| `markBundle(目录, { hold })`，异步 | `{ entry, fingerprint, bytes }` 或失败 | 往这个目录里写内核的标记，让它成为一样东西：标记的内容归内核，插件不抄它。那里已有标记时以 `refused` 拒绝。`hold` 是调用方占住这个目录的那个 |
| `searchTerms(文字, match)` | 词的列表 | 内核找的时候怎么切词 |
| `rankHits(候选, 词, match)` | 候选里的 `hit` 的列表 | 内核怎么排，`words` 匹配时最多 `sentenceHits` 条 |
| `sentenceHits` | 数 | `words` 匹配时每个答复者最多给几条 |
| `registered({ after, limit })`，异步 | `{ things, more, total, keeper }` | 库里登记过的东西的一页：每样 `{ place, kind, token, fingerprinted }`，`kind` 是 `file` 或 `bundle`，`token` 是记着登记的插件最后看到的状态令牌（没看过是 `null`），`fingerprinted` 说它知不知道内容的指纹。按位置的字节序，一页缺省 500 样、至多 1000，`more` 是 `{ after }`，没有下一页时 `null`；`total` 是一共几样，说不出时 `null`。答的是配置里第一个有 `registered` 钩子的插件（`keeper`）；没有时是空的一页，`keeper` 是 `null`。补上用它（3.5） |
| `put(请求)`，异步 | 放的结果：`{ outcome: 'accepted', path, fingerprint, copied, notes, problems }` 或 `{ outcome: 'refused', reason, subject, notes, problems }` | 经 agent 面放入，行动者和会话是这次操作的：每个插件都听到，它发自己的事件。`fingerprint` 只有放入才有，登记和挪是 `null`。所有插件的 `onPut` 都会再被调，包括调它的插件自己；内核不防重入（第 9 节） |
| `storage` | 见下表 | 存储，插件读写库的唯一的门 |

`ctx.tools.storage` 是存储。它的工具用存储的词说话：

| 词 | 在插件这里是什么 |
| --- | --- |
| 位置 | 一个以 `/` 分隔的相对路径，`''` 是库根。库内路径都是位置；在 `own`、`recordPlace(名字).own` 和 `carry(名字)` 上，位置相对那个记录处 |
| 一层 | 一个目录直接含有的那些位置。存储列出的只是一层（`overview`），从不往下走 |
| 看一眼、一览、探查 | 不读内容地问一个位置的三种办法：看一眼（`glance`）只取存储已经知道的；一览（`overview`）列一个目录的一层，一页缺省 200 项；探查（`probe`）在一个目录里带预算地数，说它至少多大 |
| 状态令牌 | 存储对一个位置此刻状态的标记，`token`。不透明：插件只存下、交回去；比较由存储在 `look`、`lookRows` 和写的预期里做。目录的令牌只说它自己这一层；深看时另有深令牌，说它里面每个文件 |
| 面 | 一个来源对一个位置给的一组元数据，在描述的 `facets` 里，按来源的名字分：本机文件夹总有 `fs`，macOS 上可以有 `macos`，同步服务只在本机留了占位时有 `placeholder`。插件可以拿认得的面给人看；决定什么只看 `kind`、`token`、`size`、`modified` |
| 内容 | 文件的字节，和它的指纹：字节的 sha256。只有 `content`、`read`、`write` 读写内容 |
| 游标 | 「到这里为止」的不透明标记：事实读到了哪（`records.since` 的 `cursor`），内容变到了哪（`changed` 的 `mark`）。存下，下次原样交回 |
| 记录处 | 放记录的地方里的一个名字。每个插件一个，名字是插件名：`records` 和 `own` 都是它的 |
| 事实 | 记录处里只追加的一条记录，一段 JSON，带存储给的次序。本体，随库同步 |
| 行 | 记录处里从事实推出的一条数据：键、至多 4 个能按它问的字段、值。在缓存区，可以丢掉 |

| `storage` 的 | 答什么 | 说明 |
| --- | --- | --- |
| `glance(位置列表)`，异步 | 描述的列表，一个位置一项 | 这些位置现在是什么。描述是 `{ place, kind, token, size, modified, facets?, held? }`：`kind` 是 `file`、`dir`、`other`、`none`；`token` 是状态令牌；文件的 `size` 是字节数，目录的是它这一层有几项，不一览就说不出时是 `null`；`facets` 是它的面；`held` 是正被一次写占着。看不了的那一个答 `{ place, outcome: 'failed', reason }`，`isDescribed` 分得出 |
| `overview(目录, { limit, after })`，异步 | `{ entries, more, total, noise }` 或失败 | 目录的一层的一页，按名字的字节序排，至多 `limit` 项（缺省 200，最多 1000），从 `after` 之后起。噪音不列，名字在 `noise` 里。`more` 是 `{ at_least, after }`，没有下一页时 `null` |
| `look(列表, { deep })`，异步 | `{ same, changed, gone, failed, held }` | 给一组 `{ place, token }`，答哪些已经不是预期的样子：`changed` 带新的描述，`gone` 是没了的，`held` 是正被写的；其余的都没变，只给个数 `same`。`token` 写 `'empty'` 是记得那里什么都没有，有了东西才算变。平常的查用它，不读内容。带 `deep: true` 时，是目录的位置深看：存储照内容规则走遍这个目录，取每个算进的文件的状态，不读内容，算出一个代表整个目录的深令牌；变了的目录在 `changed` 的那一项另带 `deep`。预期要是上次深看给的深令牌，别的令牌都算变了。算进的文件超过 5000 个答在 `failed` 里，`too_many` 带 `at_least`。深看是给做事的时候用的：同步、留一版、部署之前，确认一样带标记的目录里哪个文件都没变，没变就不读内容；查不深看 |
| `lookRows(表, 字段, { limit, after, deep })`，异步 | `{ same, changed, gone, failed, held, compared, more }` | 同 `look`（`deep` 也一样），预期从插件自己的记录处的一张表里取：每行的键是位置，`字段` 是一个令牌或 `'empty'`；没有这个字段的行没有预期，那里有什么都答。存储在它里面比，只把不同的答回来；一页至多 `limit` 行（缺省 10000，最多 100000），`more` 是 `{ after }`，没有下一页时 `null`。存储说不出变了什么时，插件用它比记过的每个位置 |
| `content(位置, { limit, manifest })`，异步 | `{ kind: 'file', fingerprint, token, size }`、`{ kind: 'dir', fingerprint, token, files, bytes, manifest? }` 或失败 | 内容的指纹（64 位十六进制的 sha256），因为问了才读，`token` 是读的那一版的。目录按内容规则算（见下）；超过 `limit` 个文件（缺省 5000）答 `too_many`。带 `manifest`（`true` 或 `{ limit, after }`）时，目录另答它算出的清单的一页：`{ entries: [{ path, fingerprint, size }], more }`，按内容规则算进的每个文件，路径相对这个目录、按字节序，一页缺省 1000 个、最多 10000 个，`more` 是 `{ after }`，没有下一页时 `null`。所以插件不用自己再实现一遍内容规则。每一页都按那时的内容算，带那时整份内容的指纹：几页的指纹不同，就是中间变了 |
| `read(文件, { offset, length, to })`，异步 | `{ token, size, offset, length, data }` 或失败 | 文件的字节，或其中一段。带 `to`（库外的绝对路径）时字节写到那个文件，`data` 是 `null` |
| `write(位置, 来源, 预期, { hold, limit })`，异步 | `{ entry, fingerprint, files?, bytes }` 或失败 | 预期成立时把内容整个放到那里，要么全成，要么什么都没变；不成立时以 `refused` 拒绝，`actual` 是那里实际的。来源是库外的 `{ path }`、字节 `{ data }`，或库里的 `{ place }`（带 `own: true` 时是自己记录处的）。预期是 `'empty'`（那里什么都没有）或一个令牌（那里还是那一版）。答复是放下的东西的描述和同一趟算的指纹 |
| `move(从, 到, { from, to }, { hold })`，异步 | `{ entry }` 或失败 | 挪：`from` 是来处的令牌，`to` 是去处的预期 |
| `remove(位置, 令牌, { hold })`，异步 | `{ removed: true }` 或失败 | 删掉还是这一版的东西 |
| `probe(目录, 预算)`，异步 | `{ files, dirs, bytes, exceeded, markers }` 或失败 | 目录至少多大：数到 `预算` 项（缺省 500）为止，`exceeded` 说数没数完；`markers` 是它顶上有的那些常见文件，比如 `.git`、`package.json` |
| `noise()`，异步 | `{ names, paths }` | 库根上声明的噪音：哪里都算的名字，和库内的路径 |
| `hold(位置列表, 毫秒)`，异步 | `{ hold, until }` 或失败 | 说这些位置正在被写、记录随后就来，管 `毫秒`（缺省 30000）。期间别人的 `look` 把它们列进 `held`，`overview` 和 `glance` 标 `held`，别的写以 `held` 拒绝；带着这个 `hold` 的写照常 |
| `release(hold)`，异步 | 无 | 放开 |
| `changed(mark)`，异步 | `{ places, mark, within }` | 从插件存下的上一个 `mark` 起内容里变了什么。`places` 是变了的位置（一个位置可以代表它的目录），可以在任意深处；`within` 是它们所在的带标记的目录：目录自己的令牌和它第一层的令牌看不出更深处的变化，所以这样东西本身算变了；`null` 是存储说不出，这时插件要把记过的每个位置都比一遍（`lookRows`）；`mark` 是 `null` 时（还没有过）`places` 也是 `null`，一次变了的超过 10000 个位置时也是。有常驻的进程（界面的服务）在听这个库时答得出，代价跟着变了的东西走；没有时说不出。存下新的 `mark`，下次接着问；它不花什么，只对这个库有用 |
| `own` | 上面 `glance` 到 `remove` 这九个 | 插件记录处里事实以外的地方：留存的副本、配置这类内容，位置相对 `.pneuma-base/<插件名>/`。还没写过时根是一个空目录；第一次写就建立它。这里没有噪音，`hold` 管不到，`changed` 从不报告；放事实的 `facts` 不在其中，答 `outside` |
| `records` | 见下 | 插件的记录处：只追加的事实，和从事实推出的行 |
| `recordPlaces()`，异步 | 名字的列表 | 内核在这个库里认得的记录处：内核自己的 `requests`，和这个库装着的每个插件的 |
| `recordPlace(名字)` | `{ own, facts }` | 读另一个记录处：`facts` 只有 `since`（同下），`own` 是它事实以外的地方，只有不改东西的那几个：`glance`、`overview`、`look`、`lookRows`、`content`、`read`。名字可以不在 `recordPlaces()` 里，比如别的机器上装着的插件写的。插件只写自己的记录处（检查：`writes`） |
| `carry(名字)` | `{ copy, remove, facts }` | 一个记录处要同步的部分，按字节复制进来，只给工作就是把整个库带到别处的插件用，比如同步。`copy(位置, 库外的路径, 预期)` 把库外的文件或目录复制到它自己的地方的那个位置上，`remove(位置, 预期)` 拿掉；`facts(名字, 库外的路径)` 把在别处写下的一个事实文件整个放进它的事实里，名字写成 `<YYYY-MM-DD>/<名字>.jsonl`，答 `{ carried }`：那里已经有这个名字时什么都不改，答 `false`，所以带两次和带一次一样。它不能追加事实、写行，也不能改已有的事实文件 |

`records` 的：

- `append(事实列表)`：把几条事实写成一次，答每条的次序号。写过的事实从不改写。
- `since(游标, limit)`：游标之后的事实（`null` 是从头），按存储的次序，至多 `limit` 条（缺省 1000，最多 10000），答 `{ facts: [{ order, fact }], cursor, more }`；`more` 说下一页已经在了，拿 `cursor` 接着读。从头读时存储还可带 `files`：事实文件的个数（一个文件放一条或几条）。`limit` 是 0 时只答事实现在到哪。游标对不上那里的事实时（比如事实被删了）答 `null`：从 `null` 重来。直接放在 `facts/` 下的、和 `facts/` 下一层名字不是日期的子目录里的 jsonl 文件，`since` 照样读，和别的事实一起给。
- `put(表, { cursor, expect })`：在一次提交里写几张表的行，带 `cursor` 时一起存下这些行推到了哪个游标。带 `expect` 时只在存下的游标还是它时写，否则什么都不写，答存下的那个。
- `get(表, 键列表)`：这些键的行，和存下的游标，`{ rows, cursor }`。
- `under(表, 前缀, { limit, after })`、`where(表, 字段, 值, { limit, after })`：键以这个前缀开头的行、这个字段是这个值的行，一页 `{ rows, more }`，按键的字节序，至多 `limit` 行（缺省 100，最多 10000），`more` 是 `{ after }`，没有下一页时 `null`。`count(表, 字段, 值)` 只答个数。
- 行是 `{ key, fields?, value }`，`fields` 至多 4 个、都是文字，是能按它问的；`put` 里 `value` 为 `null` 是删掉这一行。没有任意的查询：要别的问法，就多推一张表。
- `reset()`：丢掉全部的行和存下的游标。

行在存储的缓存区，可以丢掉（3.7 的 `cache` 检查就丢掉它们）：插件要能从事实重新推出来，做法在 3.7 的「事实和行」。

**一页一页。** 插件拿到的每一个列表都是一页，下一页要再问：

| 列表 | 一页至多 | 下一页 |
| --- | --- | --- |
| `overview` 的一层 | 1000 项（缺省 200） | 把 `more.after` 交回 `after` |
| `content` 的清单 | 10000 个文件（缺省 1000） | 把 `manifest.more.after` 交回 `manifest` 的 `after` |
| `lookRows` 比的行 | 100000 行（缺省 10000） | 把 `more.after` 交回 `after` |
| `records.since` 的事实 | 10000 条（缺省 1000） | 存下 `cursor`，再问 `since(cursor)`；`more` 说下一页已经在了 |
| `records.under`、`records.where` 的行 | 10000 行（缺省 100） | 把 `more.after` 交回 `after` |

没有哪个工具走一遍库，插件也不走。它跟着自己的记录（行，记录少时是事实），只在它们指到的位置问存储：`glance` 或 `look` 几个位置，`lookRows` 比自己的一张表，`content` 带 `manifest` 一页一页地取一样带标记的目录的文件，`read` 带长度取字节。一览只用在展开的目录上，一次一页；没登记的目录不一览、不往里走，至多在它自己那里带预算地探查。符合性检查的 `bounded` 守这一条，它的规则是：「插件只在自己的记录指到的地方问存储，一次只取一页：一个钩子或命令里，一览和探查库的内容合起来不超过 1000 条；没人登记过的目录只在它自己那里带预算地探查，不一览、不取内容、不读，它下面的地方什么都不问」（检查：`bounded`）。

**一样东西，插件能指望什么。**

- 状态令牌总有：`onPut` 的 `now.token`，`glance`、`overview` 的描述，`content`、`read` 的答复都带。插件存下它、交回去，不解读，也不自己比两个令牌：比较由存储在 `look`、`lookRows` 和写的预期里做。令牌没变，东西就没变。
- 指纹只在插件要了内容时才有：它问了 `content`，或它听到的是放入（`place`：内容经过内核，复制的同一趟算的）。登记和挪不读内容，`fingerprint` 是 `null`；`revise` 的 `current` 读过才有。
- 带标记的目录的令牌只说它自己这一层：这一层多了、少了、改了名的项，令牌就变；里面的文件改了内容，令牌不变。要知道里面改没改，深看（`look` 带 `deep`，存下深令牌，下次拿它比），比 `content` 的指纹，或在深查（`onCheck` 拿到 `deep`，3.2）时读它；`changed` 的 `within` 说常驻的进程听到了它里面的变化。
- 要知道变了什么，先问 `changed(mark)`：答出的位置（一个位置可以代表它的目录）是从上一个 `mark` 起变了的。`places` 是 `null` 时存储说不出，用 `lookRows` 拿自己一张存着令牌的表比，存储只答不同的。

失败的答复是 `{ outcome: 'failed' | 'refused', reason, detail?, actual?, at_least?, size?, side? }`，`isFailure(答复)` 分得出。`reason` 是固定的几个：`no_such_place`、`not_a_dir`、`not_a_file`、`noise`、`outside`（位置指到了库外，或指进了放事实的地方）、`refused`（预期不成立，带 `actual`）、`too_many`（带 `at_least`）、`elsewhere`（内容不在本机，带 `size`）、`held`、`cannot_say`（只出现在存储内部的变化查询里；插件的 `changed` 说不出时答 `places` 为 `null`，不是失败）、`unreadable`、`bad_request`、`cancelled`、`busy`。`write` 的来源出了错时，失败带 `side: 'from'`。

插件写内容区不用 `write`、`move`、`remove`：那样不经过内核，没有插件听到。改内容经 `put`（3.7）；这三个用在 `own` 上。

带标记的目录只能整体地变。它的内容按存储的内容规则算：不算标记文件、库的噪音（缺省的名单有 26 个名字，比如任何一层的 `.git`、`node_modules`、`.DS_Store`）和它里面的 `.gitignore` 排除的。超过 5000 个文件的目录不收成一样东西，放入以 `too-many` 拒绝。

库里的符号链接不是东西，存储从不跟着它走：`glance` 和 `overview` 把它描述成 `other`，`what` 答 `other`；路径上有一段是链接的位置答 `outside`。放、挪、归档、看也不认它：登记一个链接以 `no-such-file` 拒绝，往链接上放入、挪到链接上以 `would-overwrite` 拒绝，往链接的目录里放入以 `outside-library` 拒绝。同步也不带它。内容规则不算它：`content` 的清单里没有它，部署库发布的复制件里也没有（第 5 节）。

下面这条主人命令把一样东西复制到库外，用到 `resolve`、`what`、`content` 和 `read`：先看清那里是什么，再取存储算出的文件清单（单个文件就是它自己，带标记的目录一页一页地取），每个文件用 `read` 的 `to` 写出去，再拿复制件的 sha256 对清单里的指纹，复制的时候东西变了就说出来。复制出来的就是内容规则算进的那些文件，不带标记文件、噪音和 `.gitignore` 排除的：

```ts
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CONTRACT, defineCommand, definePlugin, isFailure, pluginName, type Fingerprint, type LibraryPath, type PluginStorage } from '@pneuma-base/sdk'

/** One file to copy: where it is in the library, where it goes under the new directory, and its fingerprint. */
type Listed = { place: string; path: string; fingerprint: Fingerprint }

/**
 * A thing's files as the content rule counts them: a file is its own one; a bundle's are its manifest,
 * a page at a time, every page of the same content. Null when it cannot be read or changed between pages.
 */
async function filesOf(storage: PluginStorage, thing: string, kind: 'file' | 'bundle'): Promise<Listed[] | 'too_many' | null> {
  if (kind === 'file') {
    const file = await storage.content(thing)
    return isFailure(file) || file.kind !== 'file' ? null : [{ place: thing, path: thing.slice(thing.lastIndexOf('/') + 1), fingerprint: file.fingerprint }]
  }
  const out: Listed[] = []
  let whole: Fingerprint | null = null
  for (let after: string | undefined; ; ) {
    const page = await storage.content(thing, { manifest: { limit: 10000, after } })
    if (isFailure(page)) return page.reason === 'too_many' ? 'too_many' : null
    if (page.kind !== 'dir' || page.manifest === undefined || (whole !== null && page.fingerprint !== whole)) return null
    whole = page.fingerprint
    out.push(...page.manifest.entries.map((e) => ({ place: `${thing}/${e.path}`, path: e.path, fingerprint: e.fingerprint })))
    if (page.manifest.more === null) return out
    after = page.manifest.more.after
  }
}

const out = defineCommand({
  name: 'copy out',
  summary: '将条目复制到外部的新目录',
  params: {
    positional: [{ name: 'path', hint: '库内路径', required: true }],
    flags: [{ name: 'to', hint: '新目录', kind: 'value', required: true }],
  },
  destructive: false,
  ownerOnly: false,
  async run({ path, to }, ctx) {
    const at = await ctx.tools.resolve(path)
    if (at === null || at.region !== 'content') return { outcome: 'refused', reason: 'not-in-content', text: `${path} 不属于资料库内容。` }
    const thing: LibraryPath = at.bundle ?? at.path
    const kind = (await ctx.tools.what([thing]))[0]?.kind
    if (kind !== 'file' && kind !== 'bundle') return { outcome: 'refused', reason: 'no-such-thing', text: `资料库中不存在该条目：${thing}。` }
    const files = await filesOf(ctx.tools.storage, thing, kind)
    if (files === 'too_many') return { outcome: 'refused', reason: 'too-many', text: `${thing} 的文件数超过单个条目的上限（5000 个）。` }
    if (files === null) return { outcome: 'refused', reason: 'changed-meanwhile', text: `${thing} 在读取时被修改。` }
    const dest = resolve(ctx.session.cwd, to)
    for (const file of files) {
      const target = join(dest, file.path)
      await mkdir(dirname(target), { recursive: true })
      const read = await ctx.tools.storage.read(file.place, { to: target })
      const copied = isFailure(read) ? null : createHash('sha256').update(await readFile(target)).digest('hex')
      if (copied !== file.fingerprint) return { outcome: 'refused', reason: 'changed-meanwhile', text: `${thing} 在复制时被修改，${dest} 中的内容不完整。` }
    }
    return { outcome: 'done', text: `已将 ${thing} 的 ${files.length} 个文件复制到 ${dest}。`, data: { path: thing, to: dest, files: files.length } }
  },
})

export default definePlugin({ contract: CONTRACT, name: pluginName('copy'), cognition: null, storage: [], statements: [], ownerCommands: [out] })
```

### 4.3 参数表

主人命令的 `params` 是 `{ positional?, flags? }`：

| 字段 | 位置参数 `positional` | 开关 `flags` |
| --- | --- | --- |
| `name` | 值在 `values` 里的名字 | `--<name>`，合 `^[a-z][a-z0-9-]*$`，不得是 `library`、`as`、`session`、`json`、`help` |
| `hint` | 几个中文字，说要写什么：用法里是 `<hint>`，表单里是这一项的名字，MCP 工具里是这个属性的说明 | 同左 |
| `kind` | 没有 | `value` 收一个值，`list` 收到下一个开关为止的一个或几个，`boolean` 不收值 |
| `required` | 必填的不得在可省的后面 | `boolean` 不得必填 |
| `many` | 收下其余的值；只有最后一个可以 | 没有 |
| `pattern` | 每个值都要整个匹配的正则（`u` 标志） | 同左；`boolean` 没有 |
| `options` | 没有 | 只给 `value`：不空的 `{ value, label }` 列表，只收这几个值 |

参数表还可以有 `secret: { name, hint }`：命令另读的一个值（3.4）。它不是参数，不进 `values`，用法里不写。`name` 是表单里那一项的名字，合开关名的规则，不和位置参数、开关同名；`hint` 是问话，也是表单里这一项的名字。

一个名字在一条命令里只出现一次。`run` 收到的值：必填的是文字，可省的可能是 `null`，`list` 和 `many` 是列表，`boolean` 是 `true` 或 `false`。值去掉两头空白，空的算没给，所以表单里留空的一项等于没写。少了、多了、不认识、格式不对、不在可选的值里，内核都以 `usage` 拒绝。

内核自己的命令 `KERNEL_COMMAND_NAMES` 是 `grant create`、`grant revoke`、`plugin enable`、`plugin disable`、`plugin backfill`、`skill install`、`archive purge`、`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`、`agent detect`、`agent connect`、`agent disconnect`、`agent list`、`launcher install`、`request list`、`request approve`、`request decline`、`ignore list`、`ignore add`、`ignore remove`、`storage list`、`storage install`、`storage remove`、`storage update`、`pair list`、`pair allow`、`pair decline`。

### 4.4 块

| 种类 | 必需的字段 | 可选的字段 | 用处 |
| --- | --- | --- | --- |
| `section` | `title`、`note`（文字或 `null`）、`count`（数字或 `null`）、`blocks`、`actions` | `collapse`：`open` 或 `closed`，可以折起来，值是开始时的样子；`about`：这一节是做什么的，给第一次来的人，界面放在标题旁的 ⓘ 里，悬停或聚焦时显示，`show` 印在标题下的括号里；`normal: true`：这一节此刻没有要人看的（没有要决定的、没有要留意的），界面整节不画，`show` 照印 | 分节；里面的块逐个核对。`note` 留给这一节此刻的内容（比如「上次查看后的新内容」），说明这一节是什么的话放 `about`。节的 `actions` 画在标题那一行：图标、「···」、一个安静的按钮（见 `Action`）；`as: 'inline'` 的动作画成节里第一行的输入框 |
| `table` | `columns`（每列 `{ key, label }`）、`rows`（每行 `{ key, cells, link, actions }`，`cells` 按列的 `key` 给 `Cell`，`link` 可以是 `null`）、`empty` | 列的 `optional`：放不下时这一列先让开，后面的先让；行的 `group`：同组的行排在一起，组名是它们上面的一行小标题，格里只写组名之后的部分（比如按文件夹分组，格里只写名字），有组时表头只给读屏；`page`：见下面的 `Paging`；行的 `place`（`RowPlace`）：这一行代表库里的一个地方，界面把它当文件，能选中、预览、打开、拖出、右键，页头能在列表和图标之间切换；`sorted`：`{ by, desc }`，带 `place` 的表现在怎么排，`by` 是 `SortKey`，界面让和它同名的列头和页头的小菜单能换排法，换的是视图的参数 `sort`（`SortKey`，前面加 `-` 倒过来），视图要按它排；`each`：`{ actions, rename }`，对表里任何一样东西（`place` 是 `file` 或 `bundle` 的）都能做的动作，说一次，`{path}` 是它的库内路径，`{in}` 是它所在的文件夹带斜杠（根上是空的）；`rename` 是一个动作或 `null`，它唯一的输入 `name` 在原处写在名字上 | 记录表；没有行时只显示 `empty`。一列的格全是 `normal` 时整列让开。有 `link` 的行，动作在悬停或聚焦时才出现。`show` 在表下印一次 `each` 的动作 |
| `fields` | `fields`（每项 `{ label, value }`，`value` 是 `Cell`） | `line: true`：几个字段说成一行，不带标签，标签进悬停，`show` 照印标签；适合谁、何时、在哪次会话这类一看就懂的值 | 字段组；`normal` 的字段不画 |
| `list` | `items`（每项 `{ cell, note, actions }`，`note` 可以是 `null`） | `page`；项的 `about`：这一项是什么，说完整，界面放在格旁的 ⓘ 里，`show` 印在说明后面；项的 `aside`：这一行的第二格（`Cell`），画在行尾、动作和开关之前，一行，放不下时从中间截短，带 `copy` 时拷贝的按钮在悬停或聚焦时出现，比如一样东西的地址；`show` 印在格后面；项的 `toggle`：`{ on, action }`，这一项是一个开或关的设置，界面在行尾画一个开关，拨它就做 `action`（先问它的 `confirm`），所以 `action` 是把它拨到另一边的那个，`show` 印「已启用」或「已停用」和这个动作的命令 | 列表；窄处要路径完整时用它，不用表格。设置写成带 `toggle` 的项：格是名字（可带 `icon`），`note` 是一行短话 |
| `timeline` | `entries`（每条 `{ at, title, lines, tag }`，`title` 是 `Cell`，`tag` 可以是 `null`） | 条目的 `actions`、`actor`（谁做的，`ActorMark` 或名字：界面在线上画它的记号，名字进悬停，`show` 印名字）；`page` | 时间线 |
| `text` | `text`、`tone` | | 一段字 |
| `preview` | `path`（库内路径） | | 一个文件的预览 |
| `actions` | `actions` | `head: true`：这一排是对整页说的，画在页头（条目面板里画在面板的头），按键在页上就做 | 一排动作 |
| `empty` | `title`、`hint`（文字或 `null`） | | 空的状态 |
| `embed` | `url`（http 或 https）、`title`、`height` | | 库外的一个页面，放在沙箱框架里，带「在新标签页中打开」 |
| `custom` | `entry`、`height`、`text`、`actions` | `data` | 插件自己画的页，见 4.5；`text` 是这一块用字说的同样的事 |
| `feed` | `groups`（每组 `{ title, count, rows }`，`count` 可以是 `null`）、`empty` | 组的 `link`：打开组名说的东西；组的 `reopen`：组是一个场景时，再打开它的对话（同 `Cell` 的）；`page` | 发生过的事，按日或按场景分组；没有行时只显示 `empty`，一句灰字。每行 `{ key, at, actor, text, meta, link }`：`actor` 是 `ActorMark` 或一个名字，`meta` 是灰的一行 `Cell`，`link` 可以是 `null`；可选 `whose`（`agent`、`owner`、`approved`、`observed`：自己做的、主人做的、主人批准的、看到的；界面不画 `agent`，它几乎是每一行，只画别的三种，`show` 每行都印）、`action`（一个安静的按钮，比如撤销）或 `settled`（一个灰词，说它后来怎样了），`action` 和 `settled` 不同时有。再可选 `act`、`path`、`note`，把同一行拆开说：`act` 是哪种动作（`FeedAct`：`generated` 做的人放进来、`imported` 从外面带进来、`changed` 换了内容、`moved` 挪了、`archived` 归档、`restored` 从归档区取回、`note` 备注、`decision` 决定、`task` 一次会话说它在做什么、`basis` 补上依据、`removed` 随归档区清掉、`command` 执行了一条命令、`request` 请主人做），`path` 是它说的那样东西的库内路径，`note` 是做的人随它写的话（放入的备注、一条备注或决定的原话、在做什么）。有 `act` 时界面把动作画成图标，东西只写名字（路径的最后一段），文件夹灰着写在旁边，和上一行同一个文件夹时不再写；`note` 是这一行的第二行，代替 `meta`；没有 `path` 时 `note` 就是这一行。`text` 仍是整句话：在这一行的提示里，`show` 和导出照印 |
| `stats` | `stats`（每个 `{ label, value, note }`，`value` 是字，`note` 可以是 `null`） | | 几个数，每个一张小卡 |
| `tree` | `param`、`selected`、`nodes`（每个 `{ value, label, count, children }`，`count` 可以是 `null`） | | 一棵树，比如文件夹。选一个节点，就是把这一页的参数 `param` 设成它的 `value` 再取一次；排在一页最前面时画在左边一栏。`show` 把每个节点印成打开它的命令 |
| `asks` | `asks`（每件 `{ key, by, text, about, actions }`，`by` 是名字或 `ActorMark`，`about` 可以是 `null`）、`empty` | 每件的 `suggested`：推荐的回答在 `actions` 里的位置；`command`：这件事说到的命令行，印在问话下面 | 等主人定的事；回答后在原处折成一行回执。首页用它放 `onAsks` 的问题，插件自己的页也能用 |
| `steps` | `steps`（每步 `{ key, title, done, summary, blocks }`，`summary` 可以是 `null`） | | 几步要做的事。没做的一步展开，显示它的块；做完的折成一行，标题下面是 `summary`（做成了什么），点开再看。第一个没做的是当前的一步。步里的块逐个核对。放在首页上的会并进「快速开始」（3.6） |
| `drop` | `to`（库里的文件夹）、`command` | | 把文件放进 `to`，记成主人带进来的。在 Mac 应用里是一块拖放和「选择…」的区域，经命令行放入；浏览器里显示 `command`，可复制 |
| `chart` | `form`（`bars` 并排的柱、`stacked` 叠起来的柱、`line` 线）、`text`（说这张图在说什么的一句话）、`unit`（数的单位，比如「个」「次」，可以是空字）、`x`（横轴的标签）、`series`（1 到 4 个，每个 `{ label, values }`，`values` 和 `x` 一样多，都是数） | | 几个数随时间怎么变。`text` 是图的标题，数要在这句话里说出来，图只画形状。每个系列按次序取一个固定的颜色，浅色深色各一套，所以同一页的几张图颜色一致；系列名直接标在线的末端，放不下时画成图例；悬停或键盘移到一处，给出那一处每个系列的数。叠起来的柱不能有负数。`show` 印那句话和一张数表：一行一个横轴标签，一列一个系列，表头带单位 |

| 类型 | 字段 |
| --- | --- |
| `Cell` | `text`；可选 `normal: true`（这是常态的值，比如「一致」「读写」「离线」：页面不画它，一列全是常态就整列让开，`show` 照印）、`mono`、`muted`、`tag`、`link`、`actor`（`ActorMark`，谁做的：文字前画它的记号，`text` 空时显示名字）、`at`（这一格是一个时刻，界面按看的人的本地时间显示，近的写「N 分钟前」「今天 15:34」）、`icon`（`IconName`）、`href`（http 或 https 的地址，新标签页打开，放不下时从中间截短）、`copy: true`（复制 `href`，没有就复制 `text`）、`reopen`（`Reopen`：这一格说的是一个场景，它的对话在这台机器上，Mac 应用在旁边给「打开那次对话」，浏览器不画；用内核的 `reopenOf` 得到）、`local: true`（`text` 是视图所在那台机器上的绝对路径，比如库放在哪：界面只写最后一段，整个路径在提示里，带拷贝，Mac 应用里另带「在访达中显示」；`show` 印整个路径） |
| `Tag` | `{ text, tone }`，`tone` 是 `neutral`、`good`、`warn`、`bad`、`info`；可选 `tip`：为什么有这个标记，比如连不上哪里，界面是它的提示和读屏的说明，`show` 印在标签的字后面的（）里。正常的状态给 `normal: true`，不要给它标签；标签留给偏离正常的 |
| `ActorMark` | `{ kind: 'agent' \| 'owner', name, grant? }`：agent 画成名字里取的两个字母，底色由名字定，同一个名字总是同一个颜色；主人画成一个灰圆。字母：头两个词的首字母（claude-code 是 CC），一个词的取头两个字母（codex 是 Co），汉字一个就是记号；屏上两个名字的字母一样时，各取首字母加第一个和对方同位不同的字母（codex 和 copilot 是 Cd 和 Cp）。所以不靠颜色也分得开。`grant` 是它凭的授权名 |
| `FilterOption` | `{ value, label, count? }`：筛选的一个选项，`count` 是选它时有几条。视图答复可以带 `filters: { name, options }[]`，给它声明了的筛选这一次的选项和数目（比如出现过的 agent），界面和 `show` 用它代替声明里的选项；只有一个选项的筛选界面不画 |
| `Link` | `{ view, params, target }`：打开一个视图，`target` 是 `main`（主区）或 `panel`（右侧面板）。条目面板是视图 `item`，参数 `path` |
| `Crumb` | `{ label, link }`：路径栏的一层，名字和打开它的 `Link` |
| `RowPlace` | `{ path, kind, token, elsewhere? }`：表格的一行代表的地方。`kind` 是 `file`（文件）、`bundle`（带标记的目录）、`open`（有登记过的东西的文件夹）、`closed`（没登记的文件夹）；`token` 是存储的状态令牌，界面只拿它作缩略图这类东西的键；`elsewhere: true`：这台机器上只有占位，界面不读它的内容 |
| `SortKey` | `name`、`modified`、`kind`、`size`：带 `place` 的表能按什么排 |
| `Reopen` | `{ url, run, reveal }`：Mac 应用怎么再打开一个场景的对话，按次序用第一种做得成的：`url` 是这台机器上的程序收的链接，`run` 是 `{ command, cwd }`，在默认的终端里、在 `cwd` 里跑，`reveal` 是对话文件，在访达中显示。路径都是绝对的 |
| `Paging` | `{ first, shown, total, atLeast?, prev, next }`：这些行是一个长列表的一页，从第 `first` 行起，共 `shown` 行；整个列表 `total` 行，`atLeast` 时是至少这么多；`prev`、`next` 是前一页和后一页的 `Link`，到头是 `null`。页的位置在视图的参数里（`after` 和 `back`），所以在地址里。sdk 的 `pagingOf` 从参数生成它，`pageAt` 读出这一页从哪个游标往后，`rowsOf(请求)` 是一页几行：界面 50，`show` 20；一页里几个列表各用一个 `name` 前缀。界面在列表下画「51–100，共 523 项」和前后两个按钮，`show` 印这一句和翻页的命令 |
| `Action` | `{ label, tone, confirm, inputs, call }`：`tone` 是 `default` 或 `danger`。`confirm` 是点了之后先问的一句话，人点了确认就是破坏性命令要的当面确认。`confirm` 为 `null` 的动作不问：没有输入时点了就做，算没有当面确认，所以破坏性的命令以 `not-confirmed` 拒绝；有输入时先出表单。可选 `icon`（`IconName`）、`key`（一个键：提示和菜单里写出它，所在的区域有焦点时按它就做）、`as`：`primary`（区域里唯一的主按钮，实心）、`icon`（只画图标，`label` 和键进提示；要有 `icon`）、`menu`（进区域的「···」）、`inline`（只有一个文字输入的动作，画成就地写的输入框，回车就做）。不写 `as` 时，区域里第一个画成安静的文字按钮，其余进「···」。`danger` 的总在「···」的最后，隔一条线，照样先问 `confirm`。一个区域（页头、一节、一行）最多一个文字按钮：常用的给图标和键，少用的进菜单。`show` 每个动作照样印成命令 |
| `ActionInput` | `{ name, label, placeholder, value, options }`；`label` 是空字时表单不画它的标签，用在自己说得清的一项上（几个有名字的种类里选一个），筛选框的提示字用 `placeholder`；可选 `multiple`（一行一个值）、`pattern` 和 `hint`（不匹配时表单不提交，`hint` 变红）、`secret: true`（输入时不显示）、`when`（`{ input, is }` 的列表：说到的每个输入的值都在它的 `is` 里时，这一项才显示；不显示的一项送空值，就是没给；说到的输入一个不是这个动作的，算不合）。`options` 不超过 5 个时并排，选一个；多过 5 个时是一个筛选框，下面列出名字里含所写的字（不分大小写）的前 20 个，选中一个，回车提交，一个都不含时不能提交 |
| `Call` | `{ face: 'agent', verb, request }`，`request` 是那个动词的请求；或 `{ face: 'owner', command, args: { positional, flags }, stdin? }`。字符串里的 `{输入名}` 换成那个输入的值；正好是 `{输入名}` 的列表元素，`multiple` 的输入一行换成一个元素。带参数的主人命令的表单用 sdk 的 `formOf(命令, { fixed, values, choices })` 生成：每个参数一个输入，`fixed` 里的不问，直接写进 `Call` |
| `IconName` | `activity`、`archive`、`archive-restore`、`arrow-down-to-line`、`bookmark`、`box`、`chart-column`、`check`、`circle-alert`、`clock`、`cloud`、`cloud-off`、`cloud-upload`、`code`、`copy`、`corner-left-up`、`database`、`download`、`ellipsis`、`external-link`、`eye`、`file`、`file-text`、`flask-conical`、`folder`、`folder-dot`、`folder-input`、`folder-plus`、`gauge`、`git-branch`、`globe`、`hard-drive`、`history`、`house`、`image`、`info`、`key`、`layers`、`layout-grid`、`link`、`link-2`、`list`、`list-plus`、`lock`、`message-square-plus`、`package`、`pencil`、`plug`、`plus`、`power`、`refresh-cw`、`rocket`、`scale`、`scan-search`、`scroll-text`、`search`、`server`、`settings`、`shield`、`sparkles`、`tag`、`terminal`、`trash-2`、`triangle-alert`、`unplug`、`upload`、`users`（lucide 的图标名，sdk 的 `ICON_NAMES`）。界面把别的名字画成拼图 |

内核核对每一块：种类不认识、缺了必需的字段、类型不对、`feed` 的一行同时有 `action` 和 `settled`、`asks` 的 `suggested` 不在回答里、`ActorMark` 的 `kind` 不是 `agent` 或 `owner`、`embed` 的地址不是 http 或 https、`custom` 的 `entry` 爬出 `ui` 目录或插件没有 `ui`、`chart` 的系列不是 1 到 4 个、某个系列的数和 `x` 不一样多、叠起来的柱有负数、输入的 `pattern` 不是正则、动作调的不是一个动词或这个库里在的主人命令、参数不合那条命令的参数表、「说」的种类没有插件听、`call` 写了动作没有的输入（`each` 的动作另有 `{path}` 和 `{in}`）、输入的 `when` 说到动作没有的输入、`trail` 的链接不是一个链接，都算不合。

### 4.5 自己画的页

`custom` 块的 `entry` 是插件 `ui` 目录里的相对路径；`ui` 是插件对象上的绝对路径，插件自己设，比如 `fileURLToPath(new URL('./ui/', import.meta.url))`，内核不替它设。界面把页放进 `<iframe sandbox="allow-scripts">`，地址是 `/plugin-ui/<插件名>/<entry>`，不带令牌，载入时不发 Referer，所以页调不了界面的接口。框架开始时 `height` 高，之后跟着页报的高度，最高 4000。

页载入界面的服务给的 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css`。`@pneuma-base/sdk/frame` 是它们的类型和清单：页的脚本写 `/// <reference types="@pneuma-base/sdk/frame" />`，编辑器就认得 `pneuma`。

| 页得到的 | 是什么 |
| --- | --- |
| `pneuma.onData(回调)` | 回调收到 `(data, { scheme, actions })`：块的 `data`；配色 `light` 或 `dark`；块的动作，按名字，每个只有 `label`、`tone`、`inputs`，没有 `call`。现在调一次，之后每次重取视图、换配色再调。`onData<T>` 给 `data` 定类型。关于看页的人，页从界面只知道配色；时区和语言取浏览器自己的，比如 `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| `pneuma.run(名字, 值)` | 要界面做块里叫这个名字的动作，`值` 按输入名填它的表单（只取动作声明了的输入） |
| `pneuma.open(链接)` | 打开一个 `Link`，或在新标签页打开一个 http 或 https 地址的字符串 |
| 高度 | `frame.js` 在内容高度变了时报给界面，页不用设自己的高度 |
| `frame.css` 的类（`FRAME_CLASSES`） | `card`（浮起的面）；`btn`（次要按钮），配 `btn-primary`（近黑，一处只有一个的主要动作）、`btn-quiet`（悬停才有底）、`btn-danger`（红色的浅底）、`btn-sm`（24 高，默认 28）；`icon-btn`（只有图标的按钮，名字写在它的 aria-label 里）；`field`（文字输入）、`field-area`（多行输入）、`select`（包住一个 `<select>`）；`segmented`（一排按钮，选中的带 `aria-checked="true"`，个数放在 `<span class="count">`）；`check`（勾选框）、`switch`（带 `role="switch"` 的勾选框）；`tag`（小标签），配 `tone-good`、`tone-warn`、`tone-bad`、`tone-info`；`kbd`（按键）、`link`、`mono`（等宽）、`muted` 和 `faint`（淡一些的字）。悬停、按下、键盘焦点、不可用都画好了 |
| `frame.css` 的变量（`FRAME_TOKENS`） | `--ink-strong`、`--ink`、`--ink-2`、`--ink-3`、`--ink-4`、`--page`、`--panel`、`--surface`、`--overlay`、`--tray`、`--wash`、`--chip`、`--select`、`--row-hover`、`--line`、`--line-strong`、`--shadow-card`、`--shadow-card-hover`、`--shadow-popover`、`--shadow-dialog`、`--ring-field`、`--ring-field-hover`、`--ring-field-focus`、`--ring-field-error`、`--primary`、`--primary-hover`、`--on-primary`、`--focus`、`--scrim`、`--good`、`--good-soft`、`--warn`、`--warn-soft`、`--bad`、`--bad-soft`、`--bad-soft-hover`、`--info`、`--info-soft`、`--chart`、`--tip-bg`、`--tip-ink`、`--radius-tag`、`--radius-control`、`--radius-field`、`--radius-item`、`--radius-card`、`--radius-panel`、`--radius-dialog`、`--ease`、`--ease-glide`、`--ease-pop`、`--font-sans`、`--font-mono`。字从最重到最淡五级；面从后往前是页底、面板、卡片、浮层，tray 是面里一层灰；悬停、选中、表格行悬停各有一层淡底；primary 是近黑的主要动作，focus 是键盘焦点的蓝，蓝色只用在它和 info；四种状态各有字色和浅底；chart 给图表的线和热度图的色阶。`frame.js` 把它们设在页的根上，取界面当前的浅色或深色，所以页不用写自己的颜色 |

`frame.js` 和界面之间只有四种消息，都带 `pneuma: 1`：界面到页的 `data`，页到界面的 `run`、`open`、`height`。别的消息、别的来源的消息，界面都不理。页要做的动作走和按钮完全一样的路：同一个对话框问 `confirm`，同样经两个面分派，同样有结果提示和重取。页拿不到 `Call`，所以跑不了块没声明的动作，「破坏性的要当面确认」「每次操作留痕」仍然只在两个面的入口守。

页 5 秒内没和界面握手，比如文件不在、载入失败、没载 `frame.js`，那一块换成一段说明，写出插件名和 `entry`，下面是块的 `text`，页的其余部分照常。框架的 `aria-label` 也是 `text`。沙箱为的是隔离样式和崩溃，不是防插件：插件的 `index.js` 本来就在本机以主人的身份跑。3.6 里 `sizes` 的 `ui/bars.html` 可以是：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="/plugin-kit/frame.css" />
    <script src="/plugin-kit/frame.js"></script>
    <style>
      .bar { height: 6px; margin: 6px 0; border-radius: 3px; background: var(--chart); cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card" style="padding: 10px 14px" id="bars"></div>
    <script>
      const box = document.getElementById('bars')
      pneuma.onData((rows) => {
        const max = Math.max(1, ...rows.map((r) => r.size))
        box.replaceChildren(...rows.map((r) => {
          const bar = document.createElement('div')
          bar.className = 'bar'
          bar.style.width = `${(100 * r.size) / max}%`
          bar.title = r.path
          bar.onclick = () => pneuma.open({ view: 'item', params: { path: r.path }, target: 'panel' })
          return bar
        }))
      })
    </script>
  </body>
</html>
```

## 5. 开发包里的库

`@pneuma-base/sdk/kit` 是插件打进自己包里的库，不是插件：插件导入它不算插件导入插件。它不导入内核，对库的读写都经上下文的 `tools`。

| 导出 | 做什么 |
| --- | --- |
| `recordStore(ctx, 名字, parse)` | 只追加的记录库（3.7），记在插件记录处的事实里，每条带 `store: 名字`，一个插件可以有几个。`stamp(ctx, 内容)` 盖上 `id`、`at`、`actor`、`session`，还不写。`actor` 是 `{ kind, name }`：agent 的 `name` 是它的名字，比如 `claude-code`；主人的 `kind` 和 `name` 都是 `owner`。`append(记录)` 把几条写成一次。`since(游标, limit)` 答游标之后的一页 `{ records, skipped, cursor, more }`（`limit` 缺省 1000），游标对不上时 `null`，从 `null` 重来；存下 `cursor`，下次接着读。`read()` 一页一页地读全部，答 `{ records, skipped }`。`skipped` 是读不懂的，每条 `{ at, reason }`，原样留着。`parse` 收到一条的对象，答内容，或一句为什么不是。`.pneuma-base/<插件名>/<名字>/` 下的 jsonl 文件也照样读，在从头读的第一页里 |
| `configFile(ctx, 名字, parse)` | 整份替换的配置文件（3.7），在插件记录处的 `own` 里，`名字` 相对 `.pneuma-base/<插件名>/`。`read()` 没有文件时 `null`，不是 JSON 或 `parse` 抛错时抛错；`write(值)` 经 `own.write` 整份写，带着上次读到的令牌，中间别人写过就重新看一眼那里的令牌再写，最后一次写的算数；连着三次撞上别处的写就抛错。`remove()` 删掉它，没有时什么都不做 |
| `deployPlugin(名字, 目标, 选项)` | 给一个插件名和一种或几种目标，交回一个完整的部署插件 |
| `defineTarget(目标)` | 写一种目标，见下面 |
| `STATUS`、`switchAction(插件名, look)` | 部署库的页上每种状态的标签，和一样东西的开关动作，目标自己画的块用它们说一样的状态、给一样的开关 |
| `Found`、`TargetGroup`、`Typed` | 目标的 `found` 答的一项，`group`，`configure` 第三个参数的类型 |
| `siteName`、`want`、`plan`、`statusOf` | 部署库的决定，纯函数：缺省的站点名，目标上该有什么，要做的几步，状态 |

### 部署库

部署库替你做和目标无关的一切：主人在它的页上连接一个部署目标，把一样东西发布、取消发布；agent 用 `say deployable <库内路径> [说明]` 声明一样东西可部署，声明不发布它；开着的东西，目标上跟着库里当前的内容，添加、移动、归档、取消归档之后都对一遍。记录、主人命令、页面、条目面板里的一节、认知段都是它的。一个部署插件只写它的目标。

它给的主人命令，`<名字>` 是插件名：

| 命令 | 标志 | 做什么 |
| --- | --- | --- |
| `<名字> publish <库内路径>`、`<名字> unpublish <库内路径>` | `ownerOnly` | 打开或关上开关，并发布或取消发布；主人发布没声明的东西时先记声明 |
| `<名字> target set [--kind <kind>] <目标的开关>` | `ownerOnly`、`setup` | 连接目标；只有一种目标时可以不写 `--kind`。目标答不上来时什么都不存 |
| `<名字> target list` | `readOnly` | 连着的目标，和这台机器上找到的 |
| `<名字> target remove` | `ownerOnly`、`setup` | 断开连接；已发布的不取消发布 |
| `<名字> sync` | 谁都能用 | 把全部声明过的东西对一遍 |
| `<名字> list` | `readOnly` | 列出声明过的东西、状态和地址 |

它的页是 `<名字>.sites`。没连目标时只有「部署目标」：这台机器上找到的目标一行一个「连接」，每组目标一行「其他 <组名>」和「连接…」，别的几种在菜单里。连着时页头是「发布条目」（有东西等着时另有「重试」），下面是目标那一行（菜单里「更换部署目标…」、设置、「断开连接」），再下面每样东西一行：名字、文件夹、标记、地址、开关。条目面板里是标记和地址、目标的字段和块，开关在面板的菜单里；没声明的目录东西在菜单里有「发布…」。全文在部署库的 `README.md`。

它问主人（`onAsks`）：声明了可以部署、主人从没动过开关、还在库里（不在归档区）的东西，每样一件「<谁> 声明 <路径> 可部署，未发布。是否发布？」，回答是「发布」（推荐，`<名字> publish`）和「不发布」（`<名字> unpublish`）。哪个回答都记一条开关，开关本来关着也记，之后不再问这一样。所以它们出现在首页的「待处理」和 agent 的 `check` 里，agent 告诉主人，主人点一下或在终端里跑一条命令。它在自己的记录处写 `config.json`（目标，用 `configFile` 整份替换）和记录库 `facts`（用 `recordStore`），都是本体；跑符合性检查时把 `config.json` 列进 `configuration`。

一个库只装得上一个部署插件。所有部署插件都认领 `say deployable`，第二个在 `plugin enable` 时以 `name-taken` 拒绝（3.3）。这是设计：一句「可以部署」只该有一个插件听，否则同一样东西会被两个插件各自发布。要发到几种地方，写一个部署插件带几种目标，主人用 `--kind` 选。

`deployPlugin` 的选项：

| 选项 | 是什么 | 缺省 |
| --- | --- | --- |
| `title` | 给人看的名字：说明、页面、条目面板里的一节，也是插件对象的 `title`，设置页写它 | 部署 |
| `heading` | 认知段的标题，`<功能>：<用法>` | 发布：由所有者决定 |
| `cognition` | 加在它写的认知段后面的一段，说这个目标 agent 该知道的 | 没有 |
| `icon` | 页面的 `IconName` | `globe` |
| `version`、`summary`、`about` | 同插件对象的 | 没有 |
| `ui` | 插件的 `ui` 目录，目标加 `custom` 块时要 | 没有 |

### 写一种新的目标

一种目标是一个 `TargetAdapter`，用 `defineTarget` 写。`defineTarget` 让 `configure` 收到按开关定好类型的值，让 `env.secret` 只收声明了的名字，让视图的函数按 `open` 写明的返回类型 `Target<细节>` 拿到细节的类型：

| `TargetAdapter` 的字段 | 是什么 |
| --- | --- |
| `kind` | `target set --kind` 的值，随配置存下 |
| `formerly` | 可选，改名之前的 `kind`：存下的配置写着其中一个时，按这种目标打开，配置文件不改写 |
| `label` | 这种目标给人看的名字，用在对话框和菜单里：「本地文件夹」 |
| `icon` | 可选，目标那一行和找到的那几行的图标 |
| `group` | 可选，`{ name, choice }`：同组的几种合成一行「其他 <name>」，对话框里按 `choice` 选；不在组里的是菜单里的「<label>…」 |
| `params` | `target set` 在 `--kind` 之后的开关，一份 `FlagParam[]`。命令的参数表、帮助、页面上的对话框和核对都从这里来；有几种目标时，选定的那种必填的开关才必填 |
| `form` | 可选，对话框问的开关和次序；没写就是必填的那些 |
| `secrets` | 它读的密钥，可以标 `optional: true`。部署库把它们声明成插件的密钥，`secret set` 和设置页就认得 |
| `asked` | 可选，`{ name, hint }`：`target set` 不显示地读一次的密钥（3.4 的 `params.secret`），对话框里放在最后。`configure` 读到了又答应了，部署库把它存成这台机器上的那个密钥（`ctx.secrets.set`）；它不进配置、记录和答复 |
| `found(ctx)` | 可选，这台机器上找得到的这种目标，每个 `{ label, values }`，`values` 是连接它的开关。只读找它们要读的 |
| `cognition` | 可选，连着这种目标时认知段后面多的一段（`onDescribe`） |
| `views` | 可选，目标自己的页，每项 `{ name, title, icon }`。每页是导航里的一项，排在部署库的页之后，视图编号 `<插件名>.<name>`；`name` 用小写字母、数字、连字符，不得是 `sites` |
| `configure(值, ctx, typed)` | 把核过的值变成要存的配置（一个 JSON 对象），或答 `{ ok: false, reason, text }`。连接前在这里问目标一次，答不上来就拒绝，什么都不存。`typed()` 读 `asked` 的密钥，没输入是 `null`。可以带 `note`：一句给主人的话，代替部署库对没设的必需密钥的提醒 |
| `open(配置, env)` | 在边界上解析存下的配置，交回这一次钩子或命令用的 `Target`；读不懂就抛错 |

`env` 是 `{ ctx, scratch, plugin, secret }`：`ctx` 是这次的上下文，`scratch` 是库外给它用的临时目录，`plugin` 是插件名（它的命令以此开头），`secret(名字)` 读主人在这台机器上设的密钥。必需的密钥没设时 `secret` 以一句说明用哪条命令设的错误拒绝，开关的答复里是 `publish-failed` 带这句话；可选的没设时读出 `null`，类型是 `string | null`。要密钥的目标从不在开关里要它。

| `Target` 的字段 | 是什么 |
| --- | --- |
| `key` | 记录按它区分目标：换了 `key`，旧目标上的站点不再算 |
| `label` | 目标那一行写什么：主机名、文件夹，或这种目标自己的话 |
| `local` | 可选，`label` 是这台机器上的路径，那一行显示最后一段 |
| `settings` | 可选，连接之后还能改的开关，每个 `{ flag, hint, value }` 是那一行菜单里的「<hint>…」，用存下的开关再跑一次 `target set` |
| `publish(站点名, 目录, meta)` | 把目录发布成这个站点，换掉它原来的内容，答 `{ url }`。目录是部署库复制到缓存目录下的临时副本：文件是存储的清单（`content` 带 `manifest`，4.2）按内容规则算进的那些，不带标记文件、噪音、`.gitignore` 排除的和符号链接；每个文件用 `storage.read` 写过去，再对清单里的指纹。`meta` 有内容编号 `content`、库内路径、时刻，和按路径的 UTF-8 字节排好的 `files`（每项 `{ path, abs }`，`abs` 是复制件里的文件），就是复制件里的全部文件 |
| `remove(站点名)` | 取消发布；取消发布一个它没在服务的站点不算错 |
| `siteName(路径)` | 可选，换掉缺省的站点名：库内路径小写，别的字符换成 `-`，路径不干净或太长时加 sha256 的前 6 位，最长 58 个字符 |
| `identify(文件)` | 可选，内容的编号；没有就用存储给的指纹。给它的文件是库外的一份复制件，所以每次要编号都把内容整个读一遍、复制一遍 |
| `serving(站点名, ask)` | 可选，问的这些站点它现在真在服务什么：按站点答 `{ content, url, detail? }`，没在服务的 `content` 为 `null`，答复里没有的站点它既不服务也不知道。`detail` 是目标自己类型的其余信息，交给它的视图。有 `serving`，部署库按目标报的对账，`<名字> sync` 修得好断在一半的发布和在目标那边被删掉的站点；它抛错时状态是「状态未知」，什么都不做。没有它，按插件自己的记录对账 |
| `view` | 可选，往部署库的页、目标自己的页和条目面板里加东西，见下表 |
| `close()` | 可选，这个 `Target` 为之打开的钩子、命令或视图结束时调一次，失败了也调。登录服务的目标在这里退出登录；它抛的错不影响答复 |

部署库在两种情形下不调 `publish`，目标上的旧版照旧，状态停在待发布，开关和 `<名字> sync` 以 `publish-failed` 答出原因：带标记的目录超过单个条目的上限 5000 个文件，原因是「X 至少有 N 个文件，超过单个条目的上限 5000 个，未发布」；复制的时候有文件变了（复制件的 sha256 和清单的指纹不同），原因是「X 正在修改，未发布」。

`serving` 什么时候被问：

- 一页（部署库的页或目标自己的页）先为全部声明过的东西的站点问一次，`ask.detail` 为 `true`，再调视图的函数。条目面板先为它那样东西的站点问，再调 `fields` 和 `item`。所以视图的函数从不在它要画的答复之前运行。
- 钩子和命令问时 `ask.detail` 为 `false`，不调视图的函数。只有视图用的数据，比如请求数的曲线，在 `ask.detail` 为 `true` 时才取。
- 部署库发布或取消发布之后会再问，所以记着答复的目标要忘掉变了的站点。

| `view` 的字段 | 是什么 |
| --- | --- |
| `mark(look)` | 一行的标记（`Tag`，带 `tip`），部署库的状态说不出的，比如名字被别人占着；`null` 是没有 |
| `fields(look)` | 条目面板里地址下面的字段；正常的值（`normal: true`）不画 |
| `before(全部)`、`page(全部)` | 部署库的页上，在它的几节之前、之后的块；`custom` 块要插件的 `ui` |
| `pages` | 按名字给目标的 `views` 里每页的块：`pages[name](全部)`。配的目标不画某一页时，那一页说明这一点 |
| `item(look)` | 条目面板里这一节最后的块 |
| `refresh` | 页面过多少秒重取，`null` 是不重取。目标有 `serving` 时缺省 30，没有时不重取 |

视图的函数拿到的每个 look 是一样声明过的东西现在的样子：

| look 的字段 | 是什么 |
| --- | --- |
| `thing` | 声明：`id`、`path`、`on`（开关）、`decided`（主人动过开关没有）、`declaredAt`、`declaredBy`、`note` |
| `standing`、`held` | 库里的情况，和目标上为它服务着的站点与内容 |
| `status` | `published`、`pending`、`unpublished`、`pending-unpublish`、`archived`、`missing`，读不到目标时 `unknown`；`STATUS[status]` 是页上的标签：已发布、待发布、未发布、待取消发布、已归档、条目缺失、状态未知 |
| `site`、`url` | 它有或会有的站点名，归档时是 `null`；目标在哪里服务它 |
| `unreachable` | 读不到目标时的原因 |
| `detail` | `serving` 对它的站点说的 `detail`：先取它正在其下服务的站点，再取它的路径有的、归档的东西曾有的站点名。所以归档了的、待取消发布的东西也有。在页和面板之外是 `null` |

`switchAction(插件名, look)` 是一行的那个开关：`{ label: '发布' 或 '取消发布', tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: '<插件名> publish' 或 '<插件名> unpublish', args: { positional: [路径], flags: {} } }, as: 'icon', icon: 'power' }`；归档了又关着的东西没有开关，答 `null`。

自带的部署插件 `deploy` 带四种目标，是一个完整的例子：Cloudflare 和自托管两种 PneumaSpace 一组（`group`），前一种的 `found` 读这台机器装过的、`asked` 读账户密钥、`configure` 登录一次核对、`close` 退出登录，两种都有 `serving`、`identify`、应用名称前缀的 `settings`、`mark`（名称已被占用）和 `cognition`；本地文件夹（`folder`，改名前是 `dir`，经 `formerly` 照样打开）和自定义命令不报告。第三方要写的只有下面这些：

```ts
import { defineTarget, deployPlugin, type Target } from '@pneuma-base/sdk/kit'

const exampleTarget = defineTarget({
  kind: 'example',
  label: '示例服务',
  icon: 'cloud',
  params: [
    { name: 'api', hint: '地址', kind: 'value', required: true, pattern: 'https?://\\S+' },
    { name: 'project', hint: '项目', kind: 'value', required: true },
  ],
  secrets: [{ name: 'token', description: '示例服务的令牌' }],
  asked: { name: 'token', hint: '令牌' },
  async configure({ api, project }, ctx, typed) {
    const token = (await typed()) ?? (await ctx.secrets.get('token'))
    if (token === null) return { ok: false, reason: 'no-key', text: '没有令牌。' }
    const reply = await fetch(`${api}/projects/${project}`, { headers: { authorization: `Bearer ${token}` } })
    if (!reply.ok) return { ok: false, reason: 'unreachable', text: `示例服务拒绝了项目 ${project}：${reply.status}。` }
    return { ok: true, config: { api, project } }
  },
  open(config, env): Target {
    const [api, project] = [String(config.api), String(config.project)]
    const call = async (method: string, path: string) => {
      const reply = await fetch(`${api}/projects/${project}${path}`, { method, headers: { authorization: `Bearer ${await env.secret('token')}` } })
      if (!reply.ok) throw new Error(`示例服务拒绝了 ${method} ${path}：${reply.status}`)
      return reply
    }
    return {
      key: `example:${api}/${project}`,
      label: project,
      async publish(site) {
        // 把 meta.files 打成服务收的样子再传；这里省掉打包。
        await call('PUT', `/sites/${site}`)
        return { url: `${api}/sites/${project}/${site}/` }
      },
      async remove(site) {
        await call('DELETE', `/sites/${site}`)
      },
    }
  },
})

export default deployPlugin('example', exampleTarget, { title: '部署', icon: 'cloud-upload', summary: '把网站发到示例服务' })
```

`plugin new <目录> --kind deploy` 生成的项目是部署库加一种发布到本地目录的目标，在 `src/target.ts` 里，换成真的目标就改那里：

```sh
pneuma-base plugin new ../site --kind deploy --packages ..
ls ../site/src
```

## 6. 行为约定

| 规则 | 为什么 | 检查 |
| --- | --- | --- |
| 钩子在空库上、在每个动词之后都不得出问题 | 钩子抛错由内核接住，列成插件的问题，动词照样答复；但每个答复都带着问题，agent 每次都得读 | （检查：`hooks`） |
| 插件只往自己名下写，已有的文件不改写不删，视图什么都不写；破坏性的主人命令可以删、改写自己名下的文件 | 第 3.7、3.6 和 3.4 节 | （检查：`writes`） |
| 缓存删掉什么都不丢 | 缓存不同步，换一台机器就没有 | （检查：`cache`） |
| 插件不走库：跟着自己的记录问存储，一次一页，不进没登记的目录 | 库的文件夹里可以有任意多的噪音；代价要跟着插件记着的东西走，不跟着文件夹走 | （检查：`bounded`） |
| 卸下插件之后库照常能用：配置和说明里没有它，动词照常答复，界面没有它的视图，内容一样不少 | 主人总能卸下一个插件 | （检查：`remove`） |
| agent 面上做的事，主人必须撤得回 | 底线是 agent 造不成破坏性的改动。比如部署插件对目标只取消发布、不清除，再发布就回来 | 查不了 |
| 对外的动作和替主人做的决定只给主人：这样的命令声明 `ownerOnly` | 对外发布、设目标这类事主人决定；内核的门在 agent 的会话里拒绝 | 查不了 |
| 给 agent 的失败要说清是谁的问题、要不要重做、该告诉谁 | agent 照字面做：「添加已成功，无需重试；请告知所有者」 | 查不了 |
| 给人和 agent 看的文字用中文，不设定主人的性别 | 说明、答复、界面都是中文；主人可以是任何人 | 查不了 |
| 拒绝理由用英文短词，小写、连字符 | 程序和测试比对理由，人读 `text` | 查不了 |
| 记录只追加事实，不改写已有的；配置整份替换；只有破坏性的主人命令删记录 | 几个写入者和同步不丢东西；主人总能丢掉数据 | （检查：`writes`） |
| 密钥不进库 | 库会被同步、给别的 agent 看 | 查不了 |

### 文字

插件写给人和 Agent 读的字（标签、按钮、状态、命令的说明和提示、拒绝、说明的段落）用软件界面的书面语，和内置的部分用同一套词。

- 用软件界面的通用词：连接、移动、添加、删除、设置、搜索、导入、导出、归档、同步、部署、授权。不用口语动词。
- 操作是动词加宾语，两到四个字：添加备注、补充依据、取消归档。对话框的标题重复操作，确认按钮重复动词。
- 状态用形容词或完成式：已连接、未登记、已归档、外部修改、待处理。空列表写「暂无X」，缺失写「X 不存在」，失败写「无法X」。
- 行业里不翻译的词不翻译：Agent、MCP、CLI、embedding、token、URL、ID。中文和英文、数字之间空一格。
- 一个概念一个词，各个面一致：页面、命令行的答复、`show`、MCP 工具的说明、资料库说明（PNEUMA-BASE.md）。
- 句子陈述事实：主语加事实，不对读者说话，不叙述系统做了什么，不用语气词。标签、按钮、状态不带句号，完整的句子带。
- 图标说得清的操作用图标按钮（`as: 'icon'` 加 `icon`），`label` 是它的提示和无障碍名称。
- 页面上显示名称，不显示内部标识：插件的 `cognition.title`、密钥的 `title`；标识只出现在要人输入的地方。

| 不写 | 写 |
| --- | --- |
| 接上 | 连接 |
| 挪到 | 移动 |
| 放进库里 | 添加到资料库 |
| 没设 | 未设置 |
| 删掉 | 删除 |
| 读不了这个目录 | 无法读取目录 |
| 还没有记录 | 暂无记录 |
| 这个目录是空的。 | 目录为空 |
| 在库外被改过 | 外部修改 |
| 试一下能不能用 | 测试连接 |
| 谁做的 | 执行者 |
| 用起来了吗 | 使用情况 |

## 7. 测试

`@pneuma-base/sdk/testkit` 跑真的命令行：插件项目依赖的 `pneuma-base` 包，或环境变量 `PNEUMA_BASE_CLI` 指的 `bin.js`。

| 导出 | 做什么 |
| --- | --- |
| `sandbox(选项)` | 临时的家目录（`$PNEUMA_BASE_HOME`）和库，装上给的插件目录。见下表 |
| `conformance(插件目录, 选项)` | 把这一节下面的检查都跑一遍，答 `{ plugin, ok, checks, reminders, text }`，从不因为查出问题而抛错。`text` 是给人读的报告：哪项不通过、哪里不对、规则是什么，最后是查不了、要自己看的提醒 |
| `findCli(cli?)` | 测试用哪个命令行：给的，`PNEUMA_BASE_CLI`，或插件项目依赖的 `pneuma-base` 包 |
| `examplesOf(认知段)` | 认知段里会被 `examples` 跑的那些命令 |
| `CHECKS`、`RULES` | 检查的名字，按下表的次序；每项的规则，即下表第二列的那一句 |

| `sandbox` 的 | 是什么 |
| --- | --- |
| 选项 | `plugins`（插件目录）、`builtins`（再加的自带插件）、`env`、`timeout`（每次调用的毫秒数，缺省 60000）、`cli`；`bare`：从 `init --bare` 开始，只有给的插件。这样的库里没有插件带 `revise`，往有不同内容的路径放入以 `would-overwrite` 拒绝；没有插件听的种类，说不被听到；找什么都找不到（内核不按名字找），看和查没有节 |
| `home`、`library`、`work`、`env`、`cli` | 家目录、库、调用的工作目录（要放进库的文件放这里）、调用的环境、命令行 |
| `toolLog` | 内核记下插件问存储的那个文件。环境变量 `PNEUMA_BASE_TOOL_LOG` 指着它，每次调用和界面的服务都设：插件每一览、探查、取内容、读一次，比一次位置或表、读一页事实或行，写一行 JSON，`plugin`、`area`（`content`、`own`，或它指名的记录处）、`tool`、`place`，和 `entries`（答了几项）或 `reason`（为什么没答），深看的另有 `deep: true`。`bounded` 读它 |
| `run(参数)`、`owner(参数)`、`agent(名字, 会话, 参数)` | 调命令行：不带库；以主人身份带 `--library`；带 `--as` 和 `--session`。最后可以多给一个 `{ cwd, env, input }`：工作目录、加进环境的变量、标准输入。交回 `{ code, stdout, stderr, json }`，`json` 是带 `--json` 时解析的标准输出 |
| `viewer()` | 起界面的服务，给出 `view(编号, 参数)`、`item(路径, { plugin? })`（给 `plugin` 时只有那个插件的一节和它的问题，它没给节时没有块）、`state()`、`act(动作, 值)`（像人填好表单、确认那样做一个动作）、`get(路径)`、`stop()`。契约是这些方法，不是服务的 HTTP 路由：`/api/` 下的路由会变，测试别直接调它们 |
| `serve(handler)` | 在本机起一个库外 HTTP 服务的替身，比如部署目标，答它的地址 `http://127.0.0.1:<端口>`。每个请求作为 `Request` 交给 `handler`，它答的 `Response` 发回去；`handler` 抛错时答 500 |
| `cleanup()` | 停掉它起的界面服务和替身，删掉临时目录 |

调用的环境从空的建起：从测试的环境只带 `PATH`、`TMPDIR`、`TEMP`、`TMP`、`SYSTEMROOT`、`LANG`、`LC_ALL`，再设上沙箱的 `HOME`、`PNEUMA_BASE_HOME` 和 `PNEUMA_BASE_TOOL_LOG`，所以没有任何 agent 产品的会话变量：`owner` 就是主人。没给 `input` 时，调用的标准输入是关着的。每次调用都有时限。

每个沙箱是一个新的临时目录，名字以 `pneuma-base-sandbox-` 开头，`cleanup()` 删掉它；`conformance` 建的沙箱也一样，查完就删。它建在环境变量 `PNEUMA_BASE_TEST_TMP` 指的目录里，没设时在系统的临时目录里（Node 的 `os.tmpdir()`，在 macOS 和 Linux 上取 `TMPDIR`）。要把沙箱留在项目里，先建好目录，再在跑测试的命令前设它：`PNEUMA_BASE_TEST_TMP="$PWD/.tmp" npm test`。

`conformance` 的选项：`setup({ sandbox, cwd, bin })` 是新库上要先做的，比如放进认知段示例要用的东西、主人设一个目标；`cwd` 是示例运行的目录，`bin` 在示例的 `PATH` 最前面，可以放库外命令的替身。`configuration` 是自己目录下整份替换的配置文件，相对自己的目录。还有 `env`、`timeout`、`cli`，同 `sandbox`。

| 检查 | 规则（报告里原样是这一句） | 怎样查 |
| --- | --- | --- |
| `loads` | 插件目录的 index.js 默认导出一个插件，符合当前 pneuma-base 的插件契约（contract 为 sdk 的 CONTRACT，当前为 2），并通过加载时的校验 | `plugin install` 插件目录，`plugin list` 里有它、没失败、契约是 `CONTRACT` 并和它自己写的对得上，`init --bare` 的新库上 `plugin enable` 做成 |
| `names` | 所有者命令以「<插件名称> 」开头，视图 ID 以「<插件名称>.」开头，插件名称不是命令行或内核的保留词，命令名称不是内核命令 | 读插件对象，另查「说」的种类不空、不带空白 |
| `cognition` | 认知段以「## <功能>：<用法>」开头，第一句为「此资料库已启用**<标题>**插件。」，命令示例写成 pneuma-base @{{授权的名字}} …，仅使用 {{授权的名字}} 这一个占位符，不重复内核负责的规则 | 读认知段；许诺、不该做的事这些查不了的，列成提醒 |
| `examples` | 认知段中的每条命令示例，在新资料库上完成准备步骤后，按原样在 Agent 会话中运行，退出码为 0 | 另一个新库：装上插件，发授权 `conformance` 给 `conformance-agent`，跑 `setup`，再在 `cwd` 里用 `/bin/sh` 一条一条跑示例，`{{授权的名字}}` 换成 `conformance`，环境里有 `PNEUMA_BASE_SESSION`。每条示例各开一个 shell，按次序跑 |
| `hooks` | 每个钩子在空资料库上和每个基本命令之后均不抛出错误，答复中没有该插件报告的问题；登记资料库中已有的文件（插件收到的内容哈希为 null，凭 now.token 识别）和登记目录第一层的未登记文件（插件收到一次 register-files）时同样如此 | 空库（`init --bare`）上：`plugin enable`、找、查、看一个不在的路径、每种「说」不带和带路径、`plugin disable` 再 add。`setup` 之后装上检查自己的插件 `conformance-opener`，它只有 `openDirs`，答 `conformance/open`；再一遍脚本：放一个文件、放一个目录、登记一个直接写进库里的文件、在 `conformance/open` 里直接写两个散文件再登记这个目录、找、看、每种「说」、查、同一路径放不同的内容、挪、归档、取回、归档一个目录、清空归档区、每条参数都可省的 `readOnly` 主人命令。agent 是 `conformance-agent`，用 `--as`，不带授权；主人命令以主人身份跑 |
| `writes` | 插件只写入资料库中自己的目录 .pneuma-base/<插件名称>/；不改写、不删除其中已有的文件（声明为配置的文件、缓存目录和破坏性所有者命令除外）；生成视图和条目面板中的分节时不写入任何内容 | 空库上和脚本里的每一步前后比库的快照：每个路径，文件的哈希、inode、修改时间，存储自己用的 `.pneuma-base/` 下的 `tmp`、`cache`、`holds`、`trash` 除外。脚本最后以主人身份跑每条参数都可省的破坏性主人命令，像人在界面里点了确认那样，它只许改自己的目录。脚本跑完之后开每个视图和条目面板，前后再比，这时什么都不能变 |
| `bounded` | 插件只向存储查询自身记录指向的位置，每次只取一页：一个钩子或命令中，对资料库内容的一览和探查合计不超过 1000 条；未登记的目录只在目录本身做有预算的探查，不做一览、不获取内容、不读取，其下的位置一概不查询 | 内核把插件每次一览、探查、取内容、读和它们答了几项记进工具日志（`sandbox.toolLog`）。脚本跑之前在库根放两个没登记的目录：`conformance-heap`（1200 个文件）和 `conformance-locked`（谁都读不了，查完还原权限）。空库上和脚本里的每一步、每个视图和条目面板，看这一步新记的行：插件对库的内容的一览和探查合起来超过 1000 项，或在这两个目录和它们下面的地方一览、取内容、读，或探查它们下面的地方，都不通过；探查这两个目录本身可以 |
| `cache` | 删除缓存不丢失任何信息：删除插件在本机的缓存目录、声明为缓存的目录和其记录区的行，前后 find、inspect、check 的答复相同 | 找、看、查各问两遍，删掉缓存（连同存储缓存区里它的行）再问一遍。两遍就答得不一样的，没法比，列成提醒 |
| `catchup` | 在已有登记条目的资料库中启用后，经补录即可识别这些条目：对启用前添加的条目，find、inspect、check 和条目面板中插件的答复，与启用后添加的条目相同 | 两个新库（不是 `bare` 的，溯源插件记着登记），各放进同一个文本文件和同一个目录：一个先装上插件再放，一个放了再装上（`plugin enable` 补上）。比两边找、看、查和条目面板里它的答复，时刻和十六进制的号不算。插件自己答 `registered` 的不查，列成提醒；同一边问两遍就答得不一样的，没法比，列成提醒 |
| `blocks` | 视图和条目面板中的分节返回的均为合法的块，钩子不抛出错误；每个操作调用一个基本命令或此资料库中存在的所有者命令，参数符合其参数表；custom 块带 text，以文字描述其绘制的内容；custom 块指向的页面位于插件的 ui 目录中，可以获取，载入 /plugin-kit/frame.js，并在脚本中调用 pneuma.onData | 空库上和脚本跑完之后，开每个视图（筛选取缺省值）和条目面板（空库上是一个不在的路径；脚本之后是挪过的那个文件，和随归档区清掉的那个目录在内容区、归档区的两个路径），看答复里它的问题，再取每个 `custom` 块的 `/plugin-ui/<插件名>/<entry>`，读它的文本和它在 `ui` 目录里直接载入的脚本。页不在浏览器里跑 |
| `remove` | 停用插件后资料库正常可用：配置和说明中不再有该插件，基本命令正常答复且无问题，界面不再列出其视图，内容无缺失 | `plugin disable`，被拒绝时加 `--force`；看配置、说明、内容的哈希，找、查、看、放的答复，界面的视图清单和问题 |

`loads` 不通过时，后面要装上才能查的几项都记成「未检查：插件加载失败」。

`plugin new` 生成的 `test/conformance.test.ts` 就是这样用它的，一字不差：

```ts
// The standard's behavioural rules, checked on the built plugin (npm test builds it first). When a
// check fails, report.text says what is wrong and what the rule is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the plugin follows the standard', async () => {
  const report = await conformance(dist, {
    // What the examples in src/cognition.md stand on: they mark notes/plan.md, so it is in the library.
    async setup({ sandbox }) {
      const put = await sandbox.agent('setup', 'setup', ['put', '-', '--to', 'notes/plan.md', '--generated'], { input: '# 计划\n' })
      assert.equal(put.code, 0, put.stderr)
    },
    // Files in its own directory it replaces whole, as configuration: none, marks are only ever added.
    configuration: [],
  })
  assert.ok(report.ok, report.text)
})
```

`blocks` 不在浏览器里跑 `custom` 页（3.6）。不用浏览器跑页的脚本，要一份 DOM 的实现，比如 jsdom；测试工具没有带它，因为它大，又只是近似浏览器。插件要在自己的测试里跑页，自己装它。

目标是网络服务的插件，在 `setup` 里用 `serve` 起一个替身，把目标设到它的地址，不连真的服务就能跑符合性检查。第 5 节的示例目标可以这样查：连上时它问一次项目，替身对什么都答 200 就够；真的插件的替身答它会调的每个接口，并先打开一个站点，所以视图是带着在线的应用查的。

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the plugin follows the standard, with the service stood in for', async () => {
  const report = await conformance(dist, {
    async setup({ sandbox }) {
      const api = await sandbox.serve(async () => Response.json({}))
      // The token is typed hidden: here it comes on standard input.
      const set = await sandbox.owner(['example', 'target', 'set', '--api', api, '--project', 'conf'], { input: 'a-token\n' })
      assert.equal(set.code, 0, set.stderr)
    },
    configuration: ['config.json'],
  })
  assert.ok(report.ok, report.text)
})
```

对着真的库写自己的测试，用 `sandbox`。它跑的是构建好的 `dist/`，所以 `npm test` 先构建；纯函数可以直接从 `src/` 导入：

```ts
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sandbox, type Sandbox } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
let sb: Sandbox

before(async () => {
  sb = await sandbox({ plugins: [dist] })
})
after(() => sb.cleanup())

test('an agent leaves a mark, and the owner lists it', async () => {
  const put = await sb.agent('claude-code', 'session-1', ['put', '-', '--to', 'notes/plan.md', '--generated'], { input: '# 计划\n' })
  assert.equal(put.code, 0, put.stderr)
  const said = await sb.agent('claude-code', 'session-1', ['say', 'marks', 'notes/plan.md', '要核对', '--json'])
  assert.equal(said.json.outcome, 'heard')
  const listed = await sb.owner(['marks', 'list', '--json'])
  assert.equal(listed.json.data.marks.length, 1)
  const viewer = await sb.viewer()
  assert.equal((await viewer.view('marks.marks')).outcome, 'shown')
  const section = await viewer.item('notes/plan.md', { plugin: 'marks' })
  assert.equal(section.outcome, 'shown')
})
```

## 8. 打包、安装、分发

`npm run build` 写出的 `dist/` 就是要装的插件目录：

```text
dist/
  index.js        ES 模块，缺省导出插件，依赖都打在里面
  cognition.md    index.js 按自己的位置读它
  ui/             自己画的页，可选
```

目录里可以有 `index.js` 导入的别的文件和 `node_modules/`。没有 `package.json` 时，`plugin install` 写一个 `{ "type": "module" }`，让 `.js` 怎么载入不取决于 `$PNEUMA_BASE_HOME` 上面有什么。

装和启用分开：`plugin install`、`plugin uninstall` 说这台机器上有没有，`plugin enable`、`plugin disable` 说一个库用不用。

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `plugin install <目录>` | 只有主人；不用指明库 | 按装载器的办法载入那个目录、过下面的核对，名字取插件自己写的；再复制到 `$PNEUMA_BASE_HOME/plugins/<名字>/`，先写临时名再换上。同名的换掉，答复说换了哪一版。自带插件的名字以 `built-in-name` 拒绝，过不了核对以 `plugin-failed-to-load` 拒绝，已装的那份不动 |
| `plugin uninstall <名字>` | 只有主人；不用指明库 | 从这台机器卸掉。带 `--library` 而那个库还装着它时以 `still-enabled` 拒绝；这台机器上别的装着它的库会报它载不了 |
| `plugin list` | 谁都能用；不用指明库 | 自带的和装上来的，各带版本、契约、一句说明，载不了的带原因；带 `--library` 时标出那个库装了哪些 |
| `plugin enable <名字>` | 只有主人 | 在库里启用，从自带的和这台机器装上来的里找。名字被已装的插件占着时以 `name-taken` 拒绝（3.3） |
| `plugin disable <名字> [--force]` | 只有主人 | 在库里停用，它名下的目录原样留着；插件的 `onRemove` 拒绝时要 `--force` |

```sh
pneuma-base plugin install dist
pneuma-base plugin list --library ../lib
pneuma-base plugin disable marks --library ../lib
pneuma-base plugin uninstall marks
```

改了就重新载入：装载器按插件目录里每个文件的名字、大小、修改时间算一个戳，目录里任何文件变了，下一次载入就用新的。命令行每次调用都载入一次，界面的服务每次请求都载入一次，所以 `npm run install-local` 之后，开着的管理界面在下一次请求就用新代码，不用重启。

这台机器载不了一个装了的插件时（导入时抛错、缺 `index.js`、过不了核对），它不进插件表，装了它的库在每个答复的问题里列出它和原因，`plugin list` 标出没能加载和原因。

### 装载时核对什么

装到这台机器和每次装载时，内核核对一切不必调钩子就能核对的：

| 项 | 要求 |
| --- | --- |
| `index.js` | 在目录里，载入不抛错，缺省导出一个对象 |
| `contract` | 写了，是 `CONTRACT`，即 `2`。写 `1` 的，原因指向第 10 节「从第 1 版到第 2 版」 |
| `name` | 合 `PLUGIN_NAME`：小写字母开头，只用小写字母、数字、连字符，最长 41 个字符；装到本机之后和目录名相同；不是 `RESERVED_PLUGIN_NAMES` 里的词：`tmp`、`requests`、`kernel`、`trash`、`holds`、`ask`、`request`、`start`、`show`、`find`、`inspect`、`put`、`say`、`check`、`archive`、`unarchive`、`init`、`view`、`help`、`grant`、`plugin`、`skill`、`secret`、`agent`、`launcher`、`noise`、`storage`、`cache`、`pair`、`guide`、`mcp`（命令行的词、内核命令的头一个词、和插件记录处并排的内核的记录处与存储自己的几处） |
| `version`、`title`、`summary`、`about` | 没有，或是文字 |
| `keeps` | 没有，或是 `every`、`some` |
| `cognition` | `null`，或 `{ title, text }`，两样都是文字 |
| `storage` | 列表，每项 `{ dir, kind }`，`kind` 是 `body` 或 `cache` |
| `statements` | 列表，每项是不空的文字，不重复 |
| `ownerCommands` | 列表，每项有文字的 `summary`、真假的 `destructive` 和 `ownerOnly`、函数 `run`，`readOnly` 和 `setup` 没有或是真假，`askable` 没有或是 `false`，名字以 `<插件名> ` 开头、不是内核的命令、不重复，参数表合 4.3，`act` 合 3.4 |
| `views` | 没有，或列表，每项 `{ id, title, icon, nav, filters }`，可以带 `ownerOnly` 和 `home`（真假），`title` 和 `icon` 是文字，`nav` 是真假，`filters` 是列表，`id` 以 `<插件名>.` 开头、不重复 |
| `secrets` | 没有，或列表，每项 `{ name, description }`，可以带 `title`（文字）和 `optional`（真假），`name` 合 `SECRET_NAME`，不重复 |
| 钩子 | 给了的都是函数；`onDescribe` 只和不是 `null` 的 `cognition` 一起 |

留到调用时的：钩子答什么、抛不抛错，插件往哪里写，`ui` 目录在不在。

`plugin new` 写了 `--packages` 时，生成的项目按绝对路径依赖那两个包文件，所以项目挪到别处照样装得上；没写时按名字依赖 `^0.9.0` 的两个包，它们没有发布，`npm install` 装不上，答复说换一个空目录、加上 `--packages <两个包文件所在的目录>` 再生成。`plugin new --help` 打印它自己的用法。

现在不做的：发布到 npm、插件市场、远程安装、从包文件（`.tgz`）直接装、签名。两个包文件不发布，脚手架按路径引用它们。

## 9. 还没规定的

下面这些，今天的代码没有答案。在它们定下来之前，插件不要依赖任何一种答法。

- 钩子和视图的时限。内核不给钩子、主人命令和视图设时限，界面等视图答复也没有时限。测试工具每次调用的 60 秒是测试的，不是规范的。
- 视图被调的频率上限。只规定了什么时候重取（3.6），`refresh` 最少 5 秒；没有规定一个视图最多多久被调一次。
- 认知段的长度上限。
- 契约的演进：一版契约之内哪些改动算破坏，契约号什么时候升。
- 插件声明自己要哪一版 pneuma-base 或 Node。插件对象上没有这样的字段；生成的项目的 `package.json` 里的 `engines` 没有谁读。
- 条目面板里慢的一节按需加载。今天每一节都在打开面板时一起取。
- 动作说自己慢、显示进度，拒绝带一个短标题。今天的动作说不出这些。
- 主人命令的答复带一个指向视图的链接。今天只有 `offer` 一个动作；视图的地址见 3.6。
- 钩子里调 `tools.put` 的重入。内核不拦，也不防插件自己的 `onPut` 被再调一次。
- 几个进程同时跑同一个插件的钩子时的锁。内核不提供锁；`records.append` 的写不会互相覆盖，`configFile` 最后一次写的算数，行的 `put` 带 `expect` 时只有一个写得成。
- 谁清理 `ctx.cacheDir`。`plugin disable` 和 `plugin uninstall` 都不动它。

## 10. 从第 1 版到第 2 版

这个 pneuma-base 只跑第 2 版插件契约。写 `contract: 1` 的插件，`plugin install` 和 `plugin enable` 拒绝装它。按第 1 版写的插件改成第 2 版，要改下面这些，改完把 `contract` 写成 `CONTRACT`（2）。

**旧工具。** `ctx.tools` 上第 1 版的工具都没有了，内核也不再导出 `abs`：

| 第 1 版 | 第 2 版 |
| --- | --- |
| `abs(路径)` | 没有。库里的东西只经 `tools.storage` 读写：字节用 `read`，复制到库外用 `read` 带 `to` |
| `thing(路径)` | `tools.what` 或 `storage.glance` |
| `things()` | 没有。插件从它听到的放（`onPut`、`onArchive`、`onPurged`）记下登记了什么，跟着自己的记录看（第 2 节）。装上之前就在库里的东西，它从登记补上（`catchUp`，`tools.registered`，3.5）；登记从记着它的插件来，一页一页，不走库 |
| `files(路径)`、`manifest(路径)`、`fingerprint(路径)` | `storage.content(路径, { manifest: { limit, after } })`：内容的指纹，带标记的目录另给文件的清单，一页一页地，每个文件带指纹和大小。超过 5000 个文件的目录答 `too_many` |
| `copyOut(路径, 到)` | 复制到库外：每个文件一次 `storage.read(位置, { to })`（4.2 的 `copy out`）。复制进自己的记录处：一次 `own.write(位置, { place: 路径 }, 'empty')`，指纹在同一趟算出 |
| `fingerprintOfFile(绝对路径)` | 库外的文件，插件自己算 sha256；库里的用 `content` |
| `fingerprintOfManifest(清单)` | 用不着：`content` 直接答整份内容的指纹 |
| `putting()` | `look` 答的 `held`，`overview` 和 `glance` 的描述上的 `held` |

**上下文。** `ctx.dir` 没有了。记录处经 `tools.storage.own`（事实以外的地方）和 `tools.storage.records`（事实和行）读写；内核不建它，第一次写才建立（3.7）。插件用 `node:fs` 直接读写 `ctx.dir` 或库的文件夹的地方，都换成存储的工具。

**`onPut` 和 `revise` 拿到的。**

- `fingerprint` 只有放入（`place`）才有。登记和挪不读内容，`fingerprint` 是 `null`，插件凭 `now.token` 认它；要指纹，自己问 `content`。
- 登记一个展开的目录时，它这一层的散文件一页（至多 200 个）来一次 `register-files`，不再拆成每个文件一次 `register`。记着登记的插件答 `openDirs`（3.5），哪些目录展开由它说。
- `previous` 是 `{ token, fingerprint }`，`fingerprint` 读过才有，否则 `null`。
- `revise` 的 `current` 读过才有，否则 `null`。

**令牌。** 一样东西靠状态令牌认，令牌不透明，只交给存储比（4.2）。带标记的目录的令牌只说它自己这一层：里面的文件改了内容，令牌不变。要发现里面的改动，深看（`look` 带 `deep`，4.2），比 `content` 的指纹，或在深查（`onCheck` 拿到 `deep`，3.2）时读内容。

**记录。** 事实经 `records.append` 写，经 `records.since` 一页一页地读，游标存下来，下次接着读；要按什么问，从事实推出行（3.7）。第 1 版的插件在自己目录里写的文件照样读得到：直接在 `facts/` 下的、和 `facts/` 下一层名字不是日期的子目录里的 jsonl，`since` 和别的事实一起给；别处的文件经 `own` 读。`recordStore` 从头读的第一页也带着开发包早先写在 `.pneuma-base/<插件名>/<名字>/` 下的记录（第 5 节）。

**部署库。** `PublishMeta.others` 没有了。`publish` 拿到的文件就是存储的清单算进的那些，复制件里没有符号链接和设备。超过 5000 个文件的带标记的目录不发布，复制时文件变了也不发布，状态都停在待发布（第 5 节）。

**符合性检查。** `loads` 要 `contract` 是 `CONTRACT`。多了一项 `bounded`，排在 `writes` 之后：插件跟着自己的记录问存储，一次一页，不碰没登记的目录（4.2、第 7 节）。脚本跑之前在库根放 `conformance-heap` 和 `conformance-locked` 两个目录。沙箱总设 `PNEUMA_BASE_TOOL_LOG`，文件是 `sandbox.toolLog`。又多了一项 `catchup`，排在 `cache` 之后：从放里学登记了什么的插件写 `catchUp`，装进已经在用的库时补上之前登记的（3.5）。

## 附：试做时的摩擦各自的去处

这份规范之前，有人在仓库外按当时的契约写了一个把网站部署到 PneumaSpace 的插件，记下 55 处「得去读源码才知道」「只能照抄」「做不到」（C、K、B、P、D、V）。后来又有人只拿两个包文件和脚手架重做了它，记下 13 条新的（N），为 `custom` 页的接口看过一次源码，现在 4.5 写全了。下表是每一条现在的去处，按今天的代码。

| 编号 | 摩擦 | 现在 |
| --- | --- | --- |
| C1 | 没有类型包，契约要手抄 | 解决：`@pneuma-base/sdk` 包文件，声明文件自成一体；钩子是函数类型的属性，严格检查 |
| C2 | 不能声明按哪一版契约写的 | 部分解决：`contract` 必填，装载时核对，不认识的版本说明原因，写 `1` 的指向要改的地方（第 2、8、10 节）。声明要哪一版 pneuma-base 或 Node 还没有（第 9 节） |
| C3 | 上下文没有库的工具，只能抄内核 | 解决：`ctx.tools`（4.2） |
| C4 | 主人命令的参数是生的，个数由命令行定 | 解决：参数表 `params`，命令行、核对、帮助、表单都从它来（3.4、4.3） |
| C5 | 「说」的种类先到先得，没有提示 | 解决：`plugin enable` 和 `init` 以 `name-taken` 拒绝；已有的撞名记成问题（3.3） |
| C6 | 只能靠抛错说「做了，但外面那步没成」 | 解决：`onPut`、`onArchive`、`onSay` 的答复可以带 `problems`（3.2） |
| C7 | 认 `archive purge` 要比命令名 | 解决：`onPurged`（3.5） |
| C8 | 插件听不到自己被卸下 | 解决：`onAdd`、`onRemove`，后者可以拒绝，主人可以 `--force`（3.5） |
| C9 | 凭证没地方放 | 解决：每台机器的密钥，`ctx.secrets`，`secret set`，可以标可选（3.7） |
| C10 | 小缺口：`PluginName` 造不出来、`ctx.dir` 在不在、面板的节不能按需加载 | 部分解决：`pluginName()` 在 sdk 里；上下文里没有记录处的路径，插件经 `tools.storage.own` 和 `records` 读写，没写过时读起来是空的，第一次写就建立它（3.7）；按需加载没有（第 9 节） |
| K1 | 决定、计划、状态只能照抄 | 解决：开发包导出 `want`、`plan`、`statusOf`、`siteName`，内容编号可由目标的 `identify` 给（第 5 节） |
| K2 | 只新增的记录库只能照抄 | 解决：`recordStore`（3.7、第 5 节） |
| K3 | 声明的生命周期只能照抄 | 解决：`deployPlugin` 管声明，跟着挪、归档、取回、清空（第 5 节） |
| K4 | 对账的循环只能照抄 | 解决：`deployPlugin` 的对账；目标有 `serving` 时按目标真在服务的对账（第 5 节） |
| K5 | 给 agent 和主人的话只能照抄 | 解决：话在 `deployPlugin` 里，命令名换成插件名；页上的状态标签导出为 `STATUS` |
| K6 | 四条主人命令只能照抄 | 解决：`deployPlugin` 生成开关、`sync`、`list`、`target set`，`target set` 的开关来自目标的 `params`（第 5 节） |
| K7 | 页面和条目面板的一节只能照抄 | 解决：`deployPlugin` 的页和一节，目标用 `view` 加列、字段、块和自己的页（第 5 节） |
| K8 | 目标配置的读写只能照抄 | 解决：`configFile`（3.7） |
| B1 | 没有脚手架 | 解决：`plugin new`（第 1 节），生成的项目挪到别处照样装得上（第 8 节） |
| B2 | 工具链要联网 | 部分解决：运行时的依赖由构建打进 `index.js`；`npm install` 仍要从网上装 esbuild、typescript、@types/node |
| B3 | 插件目录里能放什么没有规定 | 解决：目录的布局、`plugin install` 核对再复制（第 8 节）。从 `.tgz` 装没有做 |
| B4 | 装就是复制文件，看不到版本，不重载 | 解决：`plugin list` 和装的答复显示版本，文件变了下一次载入就用新的（第 8 节） |
| B5 | 不构建就跑 TypeScript 测试要自己摸索 | 解决：脚手架带着这套设置 |
| B6 | 没有对着真库测试的工具 | 解决：`@pneuma-base/sdk/testkit`，带库外服务的替身（第 7 节） |
| B7 | 没有装好的命令行可以测 | 解决：`pneuma-base` 包文件，测试工具找它（第 7 节）。不发布到 npm |
| P1 | 地址不能是链接 | 解决：`Cell` 的 `href`（4.4） |
| P2 | 窄的时候网址被截掉后半 | 解决：放不下时从中间截短，`copy` 复制（4.4） |
| P3 | 没有线上的预览 | 解决：`embed` 块（4.4） |
| P4 | 时间线的条目不能带动作 | 解决：条目的 `actions`（4.4） |
| P5 | 一格里没有小图 | 不加进块；用 `custom` 块自己画（3.6） |
| P6 | 一格只有一个标签 | 不加进块；用 `custom` 块自己画（3.6） |
| P7 | 没有指向视图的链接 | 部分解决：地址的片段打开一个视图和面板（3.6）；主人命令的答复带视图链接没有（第 9 节） |
| P8 | 联网的页每 2 秒被问一次 | 解决：只在库变了、做完动作、`refresh` 到了时重取（3.6）；部署库的页缺省 30 秒（第 5 节） |
| P9 | 表单的输入不能校验 | 解决：输入的 `pattern`、`hint`，`formOf` 从参数表生成（4.4） |
| P10 | 慢的动作说不清进度和结果 | 没有解决（第 9 节） |
| D1 | 认知段能用哪些占位，各变成什么 | 回答：3.1 |
| D2 | 主人命令的事件里哪些数据可以依赖 | 回答：3.5，`data` 不在契约里，用专门的钩子 |
| D3 | 哪个钩子拿到解析过的路径，次序如何 | 回答：3.2 |
| D4 | 退出码 | 回答：3.4 |
| D5 | 两个插件认领同一个种类时怎样 | 回答：3.3 |
| D6 | 谁算 agent | 回答：3.4 |
| D7 | 视图的答复怎样核对 | 回答：3.6、4.4 |
| D8 | 视图能不能读库外、时限、频率 | 回答：3.6；时限和频率上限没有规定（第 9 节） |
| D9 | 插件目录的布局和重载 | 回答：第 8 节 |
| D10 | 装载时核对什么 | 回答：第 8 节 |
| D11 | 钩子运行时 `ctx.dir` 在不在 | 回答：3.7，上下文里没有它：记录处经 `tools.storage.own` 和 `records` 读写，没写过时读起来是空的，第一次写就建立它 |
| V1 | 只往自己名下写 | 规则：3.7（检查：`writes`） |
| V2 | 记录只新增 | 规则：3.7，存储的事实只追加（检查：`writes`） |
| V3 | 视图什么都不写 | 规则：3.6（检查：`writes`） |
| V4 | 认知段怎么写 | 规则：3.1（检查：`cognition`、`examples`） |
| V5 | 文字用中文，理由用英文短词 | 规则：3.4、第 6 节；没有检查 |
| V6 | 对外的动作只给主人 | 规则：3.4、第 6 节；内核的门拦 `ownerOnly`，声明与否没有检查 |
| V7 | 给 agent 的失败说清是谁的问题 | 规则：第 6 节；没有检查 |
| V8 | agent 面上做的事主人撤得回 | 规则：第 6 节；没有检查 |
| V9 | 命令名以插件名开头 | 规则：3.4，装载时核对（检查：`names`、`loads`） |
| N1 | 目标的视图只看得到状态，`serving` 知道的到不了视图 | 解决：`serving` 按站点答 `detail`，类型经 `Target<细节>` 到视图；何时被问写明了，`ask.detail` 区分要不要画（第 5 节） |
| N2 | 目标自己的页只能跟在部署库的几节后面 | 解决：目标的 `views` 和 `view.pages` 是导航里自己的页；`view.before` 放在部署库的几节之前（第 5 节） |
| N3 | 符合性检查要连得上的目标 | 解决：`sandbox.serve` 起库外服务的替身（第 7 节） |
| N4 | 部署库的页不能声明 `refresh` | 解决：目标有 `serving` 时缺省 30 秒，`view.refresh` 可以改（第 5 节） |
| N5 | `custom` 页的接口不在包里 | 解决：`@pneuma-base/sdk/frame` 给 `window.pneuma` 的类型和类、变量的清单（4.5） |
| N6 | 部署库的状态标签和开关动作没有导出 | 解决：`STATUS`、`switchAction`（第 5 节） |
| N7 | 可选的密钥被说成必需的 | 解决：`optional: true`，`target set` 的提醒、设置页、`secret list` 和 `env.secret` 跟着它（3.7、第 5 节） |
| N8 | 生成的项目以为自己不会挪地方 | 部分解决：按绝对路径依赖包文件，`plugin new --help` 说自己的用法，README 指向这份规范（第 8 节）。npm 11 仍警告 esbuild 的安装脚本没被允许，构建照样成功；依赖的路径写着打包文件所在的目录 |
| N9 | `bare` 的沙箱拒绝往有内容的路径放入 | 解决：`bare` 的说明写明它缺什么（第 7 节） |
| N10 | `viewer.item(路径)` 答整个面板 | 解决：`item(路径, { plugin })` 只答那个插件的一节；面板的每一节盖着插件名（第 7 节、3.6） |
| N11 | 每个站点的数据按站点名，归档时 `look.site` 是 `null` | 解决：look 的 `detail` 按它服务的、它的路径有或曾有的站点找，归档了的、待取消发布的也有（第 5 节） |
| N12 | 一个库只装一个部署插件 | 按设计：一句「可以部署」只该有一个插件听；要发到几种地方，一个部署插件带几种目标（第 5 节） |
| N13 | 视图的图标只能从一份没人给的清单里挑 | 解决：sdk 的 `ICON_NAMES` 和类型 `IconName`，别的名字画成拼图（4.4） |

### 外人试做

这一版之前，两个没有上下文的 agent 各拿两个包文件和一两句话的要求，只读这份规范，各做了一个插件，没看过这个仓库：

| 插件 | 谁做的 | 要它做什么 |
| --- | --- | --- |
| `links` | Codex | 查坏链接：库里 Markdown 和 HTML 文件里指向库内另一个文件的相对链接，目标不在就算坏的。agent 查的时候看得到；管理界面有一页列出全部，点一行打开那个文件的面板；文件的面板里有它自己的坏链接；主人有一条命令列出它们 |
| `pulse` | Claude | 记活动热度：每次有东西放进库或被归档，记下谁、什么时候、哪样东西。管理界面有一页，用插件自己画的格子显示最近 30 天每天的活动量，跟着深浅色走，下面按 agent 列出次数；主人有一条清空记录的命令，要当面确认 |

两个插件都通过了自己的测试和符合性检查，也都装进库里试过。两份记录合起来提了 18 处：15 处是规范没说、说得含糊或自相矛盾的；2 处是缺陷，符合性检查只看 `custom` 页取不取得到，终端里输入结束时确认答了一句英文的错；1 处是试做的脚本把 `PNEUMA_BASE_HOME` 放在了 agent 的工作目录外面。18 处都改了，改在它们的来处：规范、符合性检查、命令行、内核和试做的脚本。两个插件的测试对着改过的两个包文件照样通过。
