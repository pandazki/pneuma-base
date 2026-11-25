# Pneuma Base 插件规范

这份规范写给插件的作者：一个插件必须做什么，可以依赖什么。它对应插件契约第 1 版（`@pneuma-base/sdk` 的 `CONTRACT`）和 pneuma-base 0.9.0。读它不需要读 Pneuma Base 的源码，手里有 `pneuma-base plugin new` 生成的项目就够了。

规范在命令行的包里：插件项目 `npm install` 之后，它在 `node_modules/pneuma-base/PLUGINS.md`；`plugin new` 的答复也打印它的路径。第 1 到 3 节从头读一遍，第 4 节起是查用的参考。

规则写成「必须」「不得」「可以」，一条一句，后面说为什么。符合性检查（第 7 节）查得了的规则，后面标出查它的那一项，例如（检查：`writes`）。命令块后面的输出块是它打印的行，按次序，和路径有关的行省掉了。

## 1. 五分钟

要 Node 22.18 以上、npm、能联网，和一个放着两个包文件的目录：`pneuma-base-0.9.0.tgz`（命令行）和 `pneuma-base-sdk-0.9.0.tgz`（开发包）。两个包文件在 Pneuma Base 仓库里用 `pnpm pack:dist` 打出，在仓库的 `dist-packages/` 里。在那个目录里照着运行：

<!-- test:slow -->
```sh
npm install --global ./pneuma-base-0.9.0.tgz           # 装命令行，之后 pneuma-base 就是一条命令
pneuma-base plugin new marks --packages .               # 生成插件项目 marks/
cd marks
npm install                                             # 两个包文件，加上 esbuild、typescript、@types/node
printf '\n标记是留给主人和下一个 agent 的，不是 agent 自己的笔记。\n' >> src/cognition.md
npm test                                                # 构建，再跑符合性检查和插件自己的测试
npm run install-local                                   # 装到这台机器
pneuma-base init ../lib                                 # 建一个库来试
pneuma-base plugin add marks --library ../lib           # 在这个库里启用 marks
grep '不是 agent 自己的笔记' ../lib/PNEUMA-BASE.md        # 改的那一句已经在库的说明里
echo '# 计划' | pneuma-base --library ../lib --as claude-code put - --to notes/plan.md --made
pneuma-base --library ../lib --as claude-code say marks notes/plan.md "第三节的数字还没核对"
pneuma-base view ../lib                                 # 浏览器里打开管理界面，按 Ctrl+C 关
```

<!-- output -->
```text
ℹ pass 4
ℹ fail 0
已装上插件 marks，说明已重新生成。
标记是留给主人和下一个 agent 的，不是 agent 自己的笔记。
已记下（marks）：已给 notes/plan.md 留下标记。
```

第五行是「改一处」：给 agent 读的说明加一句。`npm test` 在临时的库上跑符合性检查，改坏了它用中文说哪条规则没守住。管理界面的导航里有「标记」一页：插件自己画的一块，和一张有刚才那条标记的表。

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

- 插件的 `index.js` 必须缺省导出插件对象，`contract` 必须是这个 pneuma-base 认识的版本（检查：`loads`）。`contract` 写 `CONTRACT`，即它按哪一版契约写的；这个 pneuma-base 只跑第 1 版。内核装载时核对这些和插件对象的形状（清单在第 8 节），不对就不装。
- 插件不得导入另一个插件，也不得依赖另一个插件在不在。内核没有插件之间的槽，也没有插件之间的依赖。
- 插件可以只依赖 `@pneuma-base/sdk`。内核的工具经 `ctx.tools` 给你（4.2），所以算指纹、列东西的办法和正在跑的内核永远一样。
- 内核不认识的字段，插件对象上的不管，块里的原样留着。
- 插件可以写 `version` 和 `summary`（一句中文，说它带来什么），`plugin list` 和配置页显示它们；没有 `summary` 时显示认知段的标题。
- 库的配置里只写插件名。说明、帮助、界面里的插件内容都来自插件对象。

## 3. 插件能做的七件事

插件对象上的每一组字段做一件事：

| 件 | 字段 |
| --- | --- |
| 3.1 往说明里加一段 | `cognition` |
| 3.2 参与六个动词 | `revise`、`onPut`、`onFind`、`onFound`、`onInspect`、`onCheck`、`onArchive` |
| 3.3 听一种「说」 | `statements`、`onSay` |
| 3.4 加主人命令 | `ownerCommands` |
| 3.5 旁听和生命周期 | `observe`、`onPurged`、`onAdd`、`onRemove` |
| 3.6 加页面和条目面板里的一节 | `views`、`onView`、`onItemView`、`ui` |
| 3.7 记自己的东西 | `storage`、`secrets` |

### 3.1 往说明里加一段：认知段

库根目录的 `PNEUMA-BASE.md` 是写给 agent 的说明，内核把它拼成：内核的开头，每个已装插件的认知段（按配置次序），内核的规矩，当前的配置。配置一变就重拼。`cognition` 是 `{ title, text }` 或 `null`：`title` 进说明末尾的配置清单，`text` 是拼进去的 Markdown。脚手架把 `text` 放在 `src/cognition.md`，去掉 HTML 注释后读进来。`marks` 的这一段是：

````md
## 标记：给东西留一句话

这个库装了**标记**插件。看到一样东西有要提醒主人或下一个 agent 的事，给它留一句话：

```sh
pneuma-base @{{授权的名字}} say marks notes/plan.md "第三节的数字还没核对"
```

标记只是一句话，不改那样东西。`pneuma-base @{{授权的名字}} marks list --path notes/plan.md` 列出它的标记；要删掉或处理标记，告诉主人。
````

- 认知段必须以 `## <它带来什么>：<怎么用>` 开头，中间是全角冒号（检查：`cognition`）。agent 扫标题就知道装了什么。
- 标题后的第一句必须是「这个库装了**<title>**插件。」（检查：`cognition`）。卸下插件时，检查靠这一句确认它已经不在说明里。
- 命令示例必须写成 `pneuma-base @{{授权的名字}} …`，只用 `{{授权的名字}}` 这一个占位（检查：`cognition`）。拼说明时它换成 `<你的授权名>`，agent 的技能文件告诉它自己的授权名；一个授权名同时定下是哪个库、是谁。别的 `{{…}}` 原样留下。
- 每条命令示例在新库上做完测试准备之后，必须照原样能跑，退出码是 0（检查：`examples`）。示例是 `sh` 代码块的每一行，和正文里不带别的 `<…>` 占位的 `` `pneuma-base @…` ``。
- 认知段不得重复内核管的规矩，不得写 `--include-archived` 和「在库外写好」（检查：`cognition`）。内核的那几段已经说了，说两遍会说岔。
- 认知段不得许诺插件不做的事，必须说清 agent 不该做、做不了的，比如只有主人能开的开关，出了问题该告诉主人还是重试。agent 照说明做，不知道的界限它会去试。这两条查不了，检查列成提醒。
- 插件可以写 `cognition: null`，那 agent 就不知道它在；只有不给 agent 用的插件才这样做。

五个自带插件都装上时，整份说明不到 160 行。

### 3.2 参与六个动词

agent 手里有六个动词：放（`put`）、找（`find`）、看（`inspect`）、说（`say`）、查（`check`）、归档（`archive` 和 `unarchive`）；`start "<一句话>"` 是说、查、找的组合。请求和结果的形状不随插件变，插件在动词背后的钩子里加上它知道的。`onSay` 只调一个插件，别的钩子按配置次序调每个有它的插件：

| 钩子 | 什么时候被调 | 拿到的 | 可以答 |
| --- | --- | --- | --- |
| `revise` | 放入的目标上已有同类、内容不同的东西，写入之前；一个插件答了照样问下一个 | `{ path, current, incoming }`，路径解析过 | `{ outcome: 'held', note }`：插件把当前内容留在主人取得回的地方；`{ outcome: 'declined', reason }` |
| `onPut` | 内核接受了一次放（登记、放入、挪）之后；被拒绝的放不调 | `AcceptedPut`，路径解析过；`note` 去掉了首尾空白，空的是 `null` | 一条说明 `{ text, data? }`、`{ note, problems }` 或 `null` |
| `onFind` | 每次找（`start` 也找），内核按名字列完之后 | `FindRequest`，`text` 是原样 | `PluginHit[]`，或 `{ hits, problems }` |
| `onFound` | 内核和所有 `onFind` 都答完之后；只问它自己没给命中的路径，一个都没有就不问 | 路径（解析过）和 `FindRequest` | `PluginHit[]`，每条的 `path` 必须是问它的路径之一 |
| `onInspect` | 每次看 | `{ target }`，原样：一个路径，或某个插件认得的编号 | `PluginSection[]` |
| `onSay` | 说的种类在它的 `statements` 里时 | `{ kind, about, text, args }`，`about` 和 `text` 是原样 | `{ outcome: 'heard', note, problems? }`，或 `{ outcome: 'not-heard', reason: 'refused', note }` |
| `onCheck` | 每次查 | `{ since, includeArchived }` | `PluginSection[]` |
| `onArchive` | 归档或取回被接受之后；什么都没动（`moved` 为 `false`）也调 | `{ kind, from, to, moved }`，路径解析过 | 和 `onPut` 一样 |

一次放是 `revise`（要换内容时）、写入、`onPut`、`observe`（3.5）；归档是挪动、`onArchive`、`observe`；找是内核按名字列、`onFind`、`onFound`、`observe`。「解析过」的路径是库内相对路径，以 `/` 分隔。「原样」是调用方写的字，相对库根或是库内的绝对路径，用 `ctx.tools.resolve` 解析。要跟着一样东西挪、归档、取回，用 `onPut` 和 `onArchive`：只有它们拿到挪动的来去。

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
  secrets: [{ name: 'hook', description: '收通知的网址' }],

  async onPut(req, ctx) {
    if (req.kind === 'move') return null
    const url = await ctx.secrets.get('hook')
    if (url === null) return null
    const failed = await fetch(url, { method: 'POST', body: JSON.stringify({ path: req.path, fingerprint: req.fingerprint }) }).then(
      (reply) => (reply.ok ? null : `答复 ${reply.status}`),
      (error: unknown) => String(error),
    )
    if (failed === null) return { text: `已通知 ${req.path} 有新内容。` }
    return { note: null, problems: [`没通知到（${failed}）。放入本身已经成功，不用重做；告诉主人。`] }
  },
})
```

`onFind` 必须照找的请求 `FindRequest` 里的开关答：

| 请求里 | `onFind` | 为什么 |
| --- | --- | --- |
| `includeArchived` 为 `false` | 不得给归档区（`_archive/`）里的命中 | 默认的找不带归档的东西，内核只管自己列的那些 |
| `match` 为 `words` | 最多给 `ctx.tools.sentenceHits` 条，用 `ctx.tools.rankHits` 排 | 找的是一句话里的词，每个答复者只给最好的几条 |
| `filters` 有它不认识的词 | 可以不答 | 过滤是某个插件的用语；带了过滤时内核自己不按名字列 |
| `skipOwnSession` 为 `true` | 不得给它知道是调用者这次会话做的东西 | `start` 打开它，找的是库里本来就有的 |

一条命中的 `group` 是它的标题：`group` 相同的命中合在一起，没有 `path` 的那条说的是标题本身。

### 3.3 听一种「说」

`say <种类> [<关于>] [<内容>]` 把一句话交给认领这个种类的插件：插件在 `statements` 里列出种类，在 `onSay` 里听，`marks` 的 `src/index.ts` 就是这样写的。只给一个参数时它是 `text`，`about` 是 `null`；给两个时是 `about` 和 `text`；`say` 后面的开关进 `args`，每个开关一个值的列表。

- 「说」的种类不得是空的，也不得带空白（检查：`names`）。种类是命令行上的一个词。
- 列了种类，就必须有 `onSay`。内核只把一句话交给有 `onSay` 的插件；没有它，种类被占着却没人听，结果是 `no-plugin-for-kind`。
- 一个种类只归一个插件。`plugin add` 遇到库里已装的插件占着同一个种类，以 `name-taken` 拒绝，库不变：「没有装上插件 <名字>：「说」的种类「<种类>」已归插件 <持有者>。一个名字只归一个插件；要换用 <名字>，先卸下 <持有者>。」主人命令名和视图编号也这样。配置被手改或同步过来已经撞名时，后面那个插件的这一项不接上，记成它的问题，在每个答复里列出。插件可以拿自己的名字作种类，免得撞。

```sh
pneuma-base --library ../lib --as claude-code say marks notes/plan.md "数字核对过了"
pneuma-base --library ../lib --as claude-code say marks notes/gone.md "不在的东西" || echo "退出码 $?"
pneuma-base --library ../lib --as claude-code say nobody "没有插件听这一种"; echo "退出码 $?"
```

<!-- output -->
```text
已记下（marks）：已给 notes/plan.md 留下标记。
没有记下（refused）：库里没有这样东西：notes/gone.md
退出码 2
没有记下（no-plugin-for-kind）：这个库没配能记下这句话的插件
退出码 0
```

插件拒绝的，退出码 2；没有插件听的，不算拒绝，退出码 0。

### 3.4 加主人命令

主人面是 agent 不能做、主人能做的那一面：配置、装卸、发授权、丢数据。插件在 `ownerCommands` 里给它加命令，用 `defineCommand` 写，`run` 收到按参数表定好类型的值：

```ts
import { CONTRACT, defineCommand, definePlugin, pluginName } from '@pneuma-base/sdk'

const hello = defineCommand({
  name: 'greet hello',
  summary: '向一个或几个人问好',
  params: {
    positional: [{ name: 'who', hint: '名字', required: true, many: true }],
    flags: [
      { name: 'tone', hint: '语气', kind: 'value', options: [{ value: 'warm', label: '热情' }, { value: 'plain', label: '平常' }] },
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

它的用法由参数表生成：`greet hello <名字>… [--tone warm|plain] [--loud]`。

- 命令名必须是 `<插件名> ` 加一个或几个词，不得是内核自己的命令 `KERNEL_COMMAND_NAMES`（检查：`names`、`loads`）。两个插件的命令因此不会撞，`--help` 里也看得出是谁的。
- 每条命令都必须声明参数表 `params`，什么都不带的写 `{}`（检查：`loads`）。命令行按它读参数，内核按它核对，`--help` 的用法和界面的表单都从它生成，几处说的不会不一样。字段在 4.3。参数不合参数表时，内核以 `usage` 拒绝，说出哪一样，跟着用法，`run` 不被调。

四个标志说命令是哪一种。前两个是门，内核在同一处拦，插件不用自己看上下文；后两个只改事件上的记号：

| 标志 | 在 agent 的会话里 | 在主人那里 | 哪些命令必须声明 |
| --- | --- | --- | --- |
| `destructive: true` | 以 `agent-session` 拒绝 | 要当面确认：终端里问，输入 `yes` 才做，不在终端里以 `not-confirmed` 拒绝；界面里是动作的 `confirm` 那一问 | 丢数据、不能撤回的 |
| `ownerOnly: true` | 以 `agent-session` 拒绝 | 直接做 | 不丢数据、但替主人做决定的：对外发布、设部署或同步的目标、设密钥 |
| `readOnly: true` | 照做 | 照做 | 什么都不改的，库里库外都不改。它的事件对 agent 不算消息 |
| `setup: true` | 照做 | 照做 | 只改插件、目标这类配置、不动条目的。agent 第一次来之后再改才算消息 |

- `readOnly: true` 的命令必须什么都不改。符合性检查以主人身份跑每条参数都可省的 `readOnly` 命令，它出的问题算在 `hooks` 里，它改了东西算在 `writes` 里。

**谁算 agent。** 调用带着授权、写了 `--as`，或环境里有 agent 产品的会话变量（4.1 列出），门就当它在 agent 的会话里，拒绝的话说出是哪一样。管理界面的服务用启动它的 shell 的环境，所以在 agent 的会话里启动的界面同样被拒。

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
      列出 agent 留下的标记，可以只看一样东西的（marks）
notes/plan.md：第三节的数字还没核对（claude-code）
退出码 1
用法错误：marks list 多了参数：notes/plan.md。
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
| `onAdd` | `plugin add` 装上它、说明重拼之后，一次；已经装了的再 add 不调 | 上下文，`ctx.library` 里已经有它 | 列在 `plugin add` 的答复里，照样装上 |
| `onRemove` | `plugin remove` 卸下它之前 | 上下文 | 列在答复里，不拦 |

agent 面的事件是 `{ face: 'agent', verb, request, result }`，失败时 `result` 是 `{ outcome: 'failed', message }`；主人面的是 `{ face: 'owner', command, args, destructive, readOnly, setup, result }`。主人命令结果里的 `data` 不在契约里，类型是 `unknown`：要知道清空了哪些、装卸了谁，用 `onPurged`、`onAdd`、`onRemove`。不发事件的有：视图和条目面板，开始之前就被拒绝的主人命令（没有这条命令，或要库却没给库），和没带库运行的 `plugin install`、`plugin uninstall`、`plugin list` 与三条 `secret` 命令。`plugin add` 的事件在库重新打开之后发，刚装上的插件听得到；`plugin remove` 的事件发时它已经不在。

`onAdd` 可以答 `{ problems: [...] }`，比如目标连不上：照样装上，答复里列出。`onRemove` 可以答 `{ refuse: <一句中文> }`，说为什么、先要做什么：`plugin remove` 以 `plugin-refused` 拒绝，库不变；主人加 `--anyway`（界面里是「仍然卸下」）照样卸下。主人总能卸下一个插件。

```ts
import { join } from 'node:path'
import { CONTRACT, definePlugin, pluginName, type PluginContext } from '@pneuma-base/sdk'
import { recordStore } from '@pneuma-base/sdk/kit'

type Entry = { command: string; outcome: string }
const parseEntry = (raw: Record<string, unknown>): Entry | string =>
  typeof raw.command === 'string' && typeof raw.outcome === 'string' ? { command: raw.command, outcome: raw.outcome } : '不是一条记录'
const log = (ctx: PluginContext) => recordStore(join(ctx.dir, 'log'), parseEntry)

async function record(ctx: PluginContext, entry: Entry): Promise<void> {
  const store = log(ctx)
  await store.append([store.stamp(ctx, entry)])
}

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('audit'),
  cognition: null,
  storage: [{ dir: 'log', kind: 'body' }],
  statements: [],
  ownerCommands: [],

  /** Every owner command that may change something, done, refused or failed. */
  async observe(event, ctx) {
    if (event.face === 'owner' && !event.readOnly) await record(ctx, { command: event.command, outcome: event.result.outcome })
  },
  async onPurged(paths, ctx) {
    await record(ctx, { command: 'archive purge', outcome: `删了 ${paths.length} 样` })
  },
  async onRemove(ctx) {
    const kept = (await log(ctx).read()).records.length
    return kept === 0 ? undefined : { refuse: `已经记了 ${kept} 条主人操作，卸下之后不再记。记录留在库里。` }
  },
})
```

### 3.6 加页面和条目面板里的一节

管理界面是 `pneuma-base view <库>` 打开的网页。看用视图，改用两个面：一个视图答一页带类型的块，界面只渲染块，不知道块来自哪个插件。插件有两处可以放块：

- 自己的页：在 `views` 里声明，在 `onView` 里答 `{ title, subtitle, blocks, refresh? }`。`id` 必须以 `<插件名>.` 开头（检查：`names`）。`icon` 是 sdk 的 `IconName`（4.4），别的名字画成拼图。`nav: false` 的页只能经链接到达。界面把每个 `filters` 的 `default` 填进 `params`。
- 条目面板里的一节：一样东西在右侧面板打开时，内核按配置次序调每个插件的 `onItemView(路径)`，把答的 `{ title, blocks }` 盖上插件名，排在归档按钮之后、文件的事实之前；答 `null` 就没有这一节。路径上没有东西也调；只在归档区的东西，路径是 `_archive/…`；内核自己的文件不调。

钩子抛错或答得不对时，内核在那里放一块说明出错，把问题列进答复。

```ts
import { fileURLToPath } from 'node:url'
import { CONTRACT, definePlugin, pluginName, type Block, type PluginContext } from '@pneuma-base/sdk'

const NAME = pluginName('sizes')
const PAGE = `${NAME}.largest`

async function largest(ctx: PluginContext, count: number) {
  const paths = (await ctx.tools.things()).filter((path) => ctx.tools.regionOf(path) === 'content')
  const all = await Promise.all(paths.map(async (path) => ({ path, thing: await ctx.tools.thing(path) })))
  return all.flatMap(({ path, thing }) => (thing === null ? [] : [{ path, ...thing }])).sort((a, b) => b.size - a.size).slice(0, count)
}

export default definePlugin({
  contract: CONTRACT,
  name: NAME,
  cognition: null,
  storage: [],
  statements: [],
  ownerCommands: [],
  views: [{ id: PAGE, title: '大文件', icon: 'database', nav: true, filters: [{ name: 'top', label: '列几样', options: [{ value: '10', label: '10 样' }, { value: '50', label: '50 样' }], default: '10' }] }],
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),

  async onView(req, ctx) {
    const rows = await largest(ctx, Number(req.params.top ?? '10'))
    const blocks: Block[] = [
      { kind: 'custom', entry: 'bars.html', height: 96, data: rows.map((r) => ({ path: r.path, size: r.size })), actions: {} },
      {
        kind: 'table',
        columns: [{ key: 'path', label: '东西' }, { key: 'size', label: '大小' }, { key: 'at', label: '改于', optional: true }],
        rows: rows.map((r) => ({
          key: r.path,
          cells: {
            path: { text: r.path, mono: true, icon: r.kind === 'bundle' ? 'package' : 'file' },
            size: { text: `${Math.ceil(r.size / 1024)} KB` },
            at: { text: r.modifiedAt, at: r.modifiedAt },
          },
          link: { view: 'item', params: { path: r.path }, target: 'panel' },
          actions: [{ label: '归档', tone: 'default', confirm: `把 ${r.path} 归档？`, inputs: [], call: { face: 'agent', verb: 'archive', request: { kind: 'archive', path: r.path } } }],
        })),
        empty: '库里还没有东西。',
      },
    ]
    return { title: '大文件', subtitle: `最大的 ${rows.length} 样`, blocks }
  },

  async onItemView(path, ctx) {
    const thing = await ctx.tools.thing(path)
    if (thing === null) return null
    return { title: '大小', blocks: [{ kind: 'fields', fields: [{ label: '字节', value: { text: String(thing.size), mono: true } }, { label: '文件数', value: { text: String(thing.files) } }] }] }
  },
})
```

**第一级：带类型的块**，种类和字段在 sdk 的 `Block` 里（4.4）。样子、深浅色、键盘、窄屏都由界面管。

- 插件给的每一块都必须合 sdk 的类型（检查：`blocks`）。不合的那一块，包括不认识的种类，换成一段说明出错的文字，记成插件的问题，页的其余部分照常。
- 能用第一级的块说的，就用第一级。

**第二级：`custom` 块。** 第一级说不出的，比如一条小图，插件在 `ui` 目录里画自己的页。页载入界面给的 `/plugin-kit/frame.js` 和 `frame.css`，用 `pneuma.onData` 收块的数据，用 `pneuma.run` 做块里声明的动作，用 `pneuma.open` 打开视图或地址，样式跟着界面走。接口、类、变量和例子在 4.5，类型在 `@pneuma-base/sdk/frame`。

- `custom` 块指向的页必须在插件的 `ui` 目录里，取得到（检查：`blocks`）。

**重取。** 界面只在这几种时候重取一个视图：库的摘要（库目录下每个名字、大小、修改时间，含 `.pneuma-base/`）变了，界面每 2 秒看一次；做完一个动作；到了视图答复里 `refresh` 的秒数，最少 5 秒；连不上服务之后又连上。

- 视图和条目面板里的一节不得写任何东西（检查：`writes`）。写了，摘要就变，界面就再取，没完没了。
- 读库外的东西（比如部署目标上的状态）的视图必须带 `refresh`。库外的变化不改摘要。
- `refresh` 必须是数字。不是数字的被去掉，记成问题。

**地址。** 界面把打开的视图和面板记在地址的片段里：`#view=<视图编号>&view.<参数>=<值>&panel=<视图编号>&panel.<参数>=<值>`，刷新、后退、粘贴都打开同样的东西。在 `pneuma-base view` 打印的地址后面加上片段，就直接打开它们，比如 `…/?token=…#view=marks.marks&panel=item&panel.path=notes/plan.md`。令牌每次启动都换。

### 3.7 记自己的东西

插件名下的目录是 `<库>/.pneuma-base/<插件名>/`，钩子里是 `ctx.dir`。钩子运行时它一定在：内核每次打开库时为每个已装、能运行的插件建好它，同步过来的库也一样。

- 插件不得往库里自己名下的 `.pneuma-base/<插件名>/` 以外的地方写（检查：`writes`）。库的内容归主人和 agent，别处归内核和别的插件。
- 主人命令要改库的内容，必须经 `ctx.tools.put`，不得直接写内容区的文件。这样行动者和会话是这次操作的，每个插件都听到，还留下事件。
- 六个动词的钩子不得改内容，经 `tools.put` 也不行（检查：`writes`）。agent 的一次放、找、看只该改它自己说的那样东西。
- 自己目录里已有的文件不得改写、不得删（检查：`writes`）。例外是声明为缓存的目录，和整份替换的配置文件（符合性检查的 `configuration` 选项列出它们）。
- 插件必须在 `storage` 里声明自己目录下的每个目录是本体（`body`）还是缓存（`cache`），`dir` 相对自己的目录，`.` 是它本身。本体跟着库同步；缓存删了能重建。
- 缓存删掉不得丢任何东西（检查：`cache`）：删掉本机的缓存目录和声明为缓存的目录前后，找、看、查答得一样。
- 读到不认识的内容，原样留着。更新的版本在另一台机器上写的记录，旧版本读不懂也不得删。

记录只新增，不改写：一个库有几个写入者（agent 的会话、界面里的主人、几台机器），同步工具还会把别处写的文件整个搬来。两处改同一个文件会丢改动；各写一个名字唯一的新文件，合起来就是并集。sdk 的 `recordStore` 每次 `append` 写一个新文件，一行一个 JSON 对象，读时按编号（时间、写入者、次序）排。配置整份替换，最后一次写的算数：sdk 的 `configFile` 先写临时名再改名。

```ts
import { join } from 'node:path'
import { CONTRACT, defineCommand, definePlugin, pluginName, type PluginContext } from '@pneuma-base/sdk'
import { configFile } from '@pneuma-base/sdk/kit'

type Settings = { format: 1; limitMb: number }

function parseSettings(raw: unknown): Settings {
  const r = raw as Partial<Settings> | null
  if (r?.format !== 1 || typeof r.limitMb !== 'number') throw new Error('settings.json 不是 quota 的配置')
  return { format: 1, limitMb: r.limitMb }
}

const settings = (ctx: PluginContext) => configFile(join(ctx.dir, 'settings.json'), parseSettings)

const limit = defineCommand({
  name: 'quota limit',
  summary: '设一样东西最大多少 MB',
  params: { positional: [{ name: 'mb', hint: '兆字节', required: true, pattern: '[1-9][0-9]*' }] },
  destructive: false,
  ownerOnly: true,
  setup: true,
  async run({ mb }, ctx) {
    await settings(ctx).write({ format: 1, limitMb: Number(mb) })
    return { outcome: 'done', text: `上限设成了 ${mb} MB。` }
  },
})

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('quota'),
  cognition: null,
  storage: [{ dir: '.', kind: 'body' }],
  statements: [],
  ownerCommands: [limit],

  async onCheck(_req, ctx) {
    const limitMb = (await settings(ctx).read())?.limitMb ?? null
    if (limitMb === null) return []
    const over: string[] = []
    for (const path of await ctx.tools.things()) {
      const thing = ctx.tools.regionOf(path) === 'content' ? await ctx.tools.thing(path) : null
      if (thing !== null && thing.size > limitMb * 1024 * 1024) over.push(path)
    }
    return over.length === 0 ? [] : [{ title: `超过 ${limitMb} MB 的东西`, body: over.join('\n'), data: { over } }]
  },
})
```

库外的缓存 `ctx.cacheDir` 是 `$PNEUMA_BASE_HOME/cache/<库的 id>/<插件名>/`，因为索引这类文件经不起同步。内核不建它，也没有谁清理它。

令牌这类凭证不得放进库：库会被同步、会给别的 agent 看。插件在 `secrets` 里声明它读的密钥，各带一句中文说明；插件没有它也能用的，比如只有一部分服务器要的令牌，标 `optional: true`。`ctx.secrets.get(名字)` 读，没设是 `null`。主人在这台机器上设：值从标准输入读，从不取命令行的参数，存在库外的 `$PNEUMA_BASE_HOME/secrets/<插件名>/<密钥名>`，只有用户能读。配置页列出每个密钥设没设（可选的写「没设（可选）」）并能设它，`secret list` 把可选的另列一行：

```sh
printf %s 'sk-例子' | pneuma-base secret set search key
pneuma-base secret list search
pneuma-base secret remove search key
```

`plugin remove` 卸下插件后，它名下的目录原样留着；`plugin uninstall` 从这台机器卸掉它后，它的密钥原样留着。

## 4. 参考：上下文、参数表、块和自己画的页

### 4.1 上下文

每个钩子和主人命令的 `run` 都收到一个 `PluginContext`：

| 字段 | 是什么 |
| --- | --- |
| `library` | 这次操作的库：`root`（绝对的真实路径）、`config`（`id`、插件名的列表、授权）、`plugins`（装了、这台机器载得了的插件，按配置次序）、`unavailable`（装了、载不了的名字）、`clashes`（撞名没接上的） |
| `actor` | 谁在做：`{ kind: 'agent', name, grant }` 或 `{ kind: 'owner' }`。带授权时是授权给的 agent；写了 `--as <名字>` 时是那个名字；环境里有 `CLAUDE_CODE_SESSION_ID` 或 `CLAUDECODE` 时是 `claude-code`，有 `CODEX_THREAD_ID` 时是 `codex`，有 `ANTIGRAVITY_CONVERSATION_ID` 或 `ANTIGRAVITY_AGENT` 时是 `antigravity`；都没有是主人。只有 `PNEUMA_BASE_SESSION` 时行动者是主人，但主人命令的门照样拒绝（3.4）。界面里总是主人。类型里还有 `{ kind: 'plugin', name }`，今天的内核不给 |
| `session` | 这次会话：`id` 依次取 `--session`、环境变量 `PNEUMA_BASE_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`，都没有就为这次调用造一个，`source` 相应是 `flag`、`env`、`minted`；`cwd` 是调用方的工作目录，界面里是服务进程的，主人命令里写的相对路径按它解析；`machine` 是主机名；`transcript` 今天总是 `null` |
| `now` | 这次操作的时刻，ISO 8601 |
| `home` | 本机的 `$PNEUMA_BASE_HOME`，缺省 `~/.pneuma-base` |
| `dir` | 插件在库里名下的目录，钩子运行时一定在（3.7） |
| `cacheDir` | 插件在库外的缓存目录，内核不建（3.7） |
| `secrets` | `get(名字)`：主人在这台机器上给它设的密钥，没设是 `null`（3.7） |
| `tools` | 内核的工具，绑在这次操作的库上，见 4.2 |

主人命令的门（3.4）在下面任何一样成立时当调用在 agent 的会话里：带着授权（`pneuma-base @<授权名> …`）；写了 `--as <名字>`；环境里有这些变量之一，值不空：`PNEUMA_BASE_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`CLAUDECODE`、`ANTIGRAVITY_AGENT`。主人在 agent 产品开的终端里用主人命令，先去掉这些变量：

```sh
PNEUMA_BASE_SESSION=demo pneuma-base plugin add marks --library ../lib || echo "退出码 $?"
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u ANTIGRAVITY_CONVERSATION_ID -u ANTIGRAVITY_AGENT -u PNEUMA_BASE_SESSION pneuma-base plugin add marks --library ../lib
```

<!-- output -->
```text
拒绝（agent-session）：「plugin add」是替主人做的决定，只有主人能做，不能在 agent 的会话里做（环境里有 PNEUMA_BASE_SESSION）。需要的话告诉主人；主人在自己的终端里做，或在自己的终端里运行 pneuma-base view 用界面做。
退出码 2
插件 marks 已经装了。
```

### 4.2 工具

`ctx.tools` 是正在跑的内核自己的代码，所以一个带标记的目录算哪些文件、指纹怎么算、找怎么切词排序，插件和内核永远一样。路径都是库内路径，除非写明绝对：

| 工具 | 做什么 |
| --- | --- |
| `resolve(输入)` | 调用方写的路径（相对库根，或库内的绝对路径）解析成 `{ path, region, bundle }`；不在库里是 `null`。`region` 是 `content`（内容）、`archive`（`_archive/`）、`kernel`（`.pneuma-base/` 和 `PNEUMA-BASE.md`）；`bundle` 是它所在的带标记的目录 |
| `regionOf(路径)` | 这个路径在哪一区 |
| `archivedPath(路径)`、`originalPath(路径)` | 内容路径在归档区的位置；归档区路径原来的位置，`_archive` 本身是 `null` |
| `abs(路径)` | 绝对路径 |
| `thing(路径)` | 那里的文件或带标记的目录：`{ kind, size, files, modifiedAt }`；都不是时 `null` |
| `things()` | 内容区和归档区的每样东西：带标记的目录之外的每个文件，和每个带标记的目录 |
| `files(路径)` | 带标记的目录算进指纹的文件，按指纹的次序；不是带标记的目录时 `null` |
| `copyOut(路径, 绝对目录)` | 把那样东西复制到一个还不存在的目录：带标记的目录复制算进来的文件、不带标记，文件按原名放进去；答复制件的指纹，那里没东西时 `null`。目录在库里、又不在插件自己名下时抛错 |
| `fingerprint(路径)` | 文件或带标记的目录的指纹（sha256）；都不是时 `null` |
| `manifest(路径)`、`fingerprintOfManifest(清单)` | 带标记的目录每个文件的 sha256；从清单算指纹，不读文件 |
| `fingerprintOfFile(绝对路径)` | 本机任何一个普通文件的指纹，比如插件自己留的副本 |
| `searchTerms(文字, match)`、`rankHits(候选, 词, match)`、`sentenceHits` | 内核找的时候怎么切词、怎么排，`words` 匹配时每个答复者最多几条 |
| `put(请求)` | 经 agent 面放入，行动者和会话是这次操作的：每个插件都听到，它发自己的事件。所有插件的 `onPut` 都会再被调，包括调它的插件自己；内核不防重入（第 9 节） |

带标记的目录是库里的「一样东西」：目录里有一个 `.pneuma-item` 文件。它只能整体地变，算指纹时不算标记文件和任何一层的 `.git`、`node_modules`、`.DS_Store`。

下面这条主人命令把一样东西复制到库外，复制完核对指纹，用到 `resolve`、`copyOut` 和 `fingerprint`：

```ts
import { resolve } from 'node:path'
import { CONTRACT, defineCommand, definePlugin, pluginName } from '@pneuma-base/sdk'

const out = defineCommand({
  name: 'copy out',
  summary: '把库里的一样东西复制到库外的一个新目录',
  params: {
    positional: [{ name: 'path', hint: '库内路径', required: true }],
    flags: [{ name: 'to', hint: '新目录', kind: 'value', required: true }],
  },
  destructive: false,
  ownerOnly: false,
  async run({ path, to }, ctx) {
    const at = await ctx.tools.resolve(path)
    if (at === null || at.region !== 'content') return { outcome: 'refused', reason: 'not-in-content', text: `${path} 不在库的内容里。` }
    const thing = at.bundle ?? at.path
    const dest = resolve(ctx.session.cwd, to)
    const copied = await ctx.tools.copyOut(thing, dest)
    if (copied === null) return { outcome: 'refused', reason: 'no-such-thing', text: `库里没有 ${thing}。` }
    if (copied !== (await ctx.tools.fingerprint(thing))) return { outcome: 'refused', reason: 'changed-meanwhile', text: `${thing} 在复制时被改了，${dest} 里的不是现在的内容。` }
    return { outcome: 'done', text: `已把 ${thing} 复制到 ${dest}。`, data: { path: thing, to: dest, fingerprint: copied } }
  },
})

export default definePlugin({ contract: CONTRACT, name: pluginName('copy'), cognition: null, storage: [], statements: [], ownerCommands: [out] })
```

### 4.3 参数表

主人命令的 `params` 是 `{ positional?, flags? }`：

| 字段 | 位置参数 `positional` | 开关 `flags` |
| --- | --- | --- |
| `name` | 值在 `values` 里的名字 | `--<name>`，合 `^[a-z][a-z0-9-]*$`，不得是 `library`、`as`、`session`、`json`、`help` |
| `hint` | 几个中文字，说要写什么：用法里是 `<hint>`，表单里是这一项的名字 | 同左 |
| `kind` | 没有 | `value` 收一个值，`list` 收到下一个开关为止的一个或几个，`boolean` 不收值 |
| `required` | 必填的不得在可省的后面 | `boolean` 不得必填 |
| `many` | 收下其余的值；只有最后一个可以 | 没有 |
| `pattern` | 每个值都要整个匹配的正则（`u` 标志） | 同左；`boolean` 没有 |
| `options` | 没有 | 只给 `value`：不空的 `{ value, label }` 列表，只收这几个值 |

一个名字在一条命令里只出现一次。`run` 收到的值：必填的是文字，可省的可能是 `null`，`list` 和 `many` 是列表，`boolean` 是 `true` 或 `false`。值去掉两头空白，空的算没给，所以表单里留空的一项等于没写。少了、多了、不认识、格式不对、不在可选的值里，内核都以 `usage` 拒绝。

内核自己的命令 `KERNEL_COMMAND_NAMES` 是 `grant issue`、`grant revoke`、`plugin add`、`plugin remove`、`skill install`、`archive purge`、`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`。

### 4.4 块

| 种类 | 必需的字段 | 可选的字段 | 用处 |
| --- | --- | --- | --- |
| `section` | `title`、`note`（文字或 `null`）、`count`（数字或 `null`）、`blocks`、`actions` | `collapse`：`open` 或 `closed`，可以折起来，值是开始时的样子 | 分节；里面的块逐个核对 |
| `table` | `columns`（每列 `{ key, label }`）、`rows`（每行 `{ key, cells, link, actions }`，`cells` 按列的 `key` 给 `Cell`，`link` 可以是 `null`）、`empty` | 列的 `optional`：放不下时这一列先让开，后面的先让 | 记录表；没有行时只显示 `empty` |
| `fields` | `fields`（每项 `{ label, value }`，`value` 是 `Cell`） | | 字段组 |
| `list` | `items`（每项 `{ cell, note, actions }`，`note` 可以是 `null`） | | 列表；窄处要路径完整时用它，不用表格 |
| `timeline` | `entries`（每条 `{ at, title, lines, tag }`，`title` 是 `Cell`，`tag` 可以是 `null`） | 条目的 `actions` | 时间线 |
| `text` | `text`、`tone` | | 一段字 |
| `preview` | `path`（库内路径） | | 一个文件的预览 |
| `actions` | `actions` | | 一排按钮 |
| `empty` | `title`、`hint`（文字或 `null`） | | 空的状态 |
| `embed` | `url`（http 或 https）、`title`、`height` | | 库外的一个页面，放在沙箱框架里，带「在新标签页打开」 |
| `custom` | `entry`、`height`、`actions` | `data` | 插件自己画的页，见 4.5 |

| 类型 | 字段 |
| --- | --- |
| `Cell` | `text`；可选 `mono`、`muted`、`tag`、`link`、`at`（这一格是一个时刻，界面按看的人的本地时间显示）、`icon`（`IconName`）、`href`（http 或 https 的地址，新标签页打开，放不下时从中间截短）、`copy: true`（复制 `href`，没有就复制 `text`） |
| `Tag` | `{ text, tone }`，`tone` 是 `neutral`、`good`、`warn`、`bad`、`info` |
| `Link` | `{ view, params, target }`：打开一个视图，`target` 是 `main`（主区）或 `panel`（右侧面板）。条目面板是视图 `item`，参数 `path` |
| `Action` | `{ label, tone, confirm, inputs, call }`：`tone` 是 `default` 或 `danger`。`confirm` 是点了之后先问的一句话，人点了确认就是破坏性命令要的当面确认。`confirm` 为 `null` 的动作不问：没有输入时点了就做，算没有当面确认，所以破坏性的命令以 `not-confirmed` 拒绝；有输入时先出表单 |
| `ActionInput` | `{ name, label, placeholder, value, options }`；可选 `multiple`（一行一个值）、`pattern` 和 `hint`（不匹配时表单不提交，`hint` 变红）、`secret: true`（输入时不显示） |
| `Call` | `{ face: 'agent', verb, request }`，`request` 是那个动词的请求；或 `{ face: 'owner', command, args: { positional, flags }, stdin? }`。字符串里的 `{输入名}` 换成那个输入的值；正好是 `{输入名}` 的列表元素，`multiple` 的输入一行换成一个元素。带参数的主人命令的表单用 sdk 的 `formOf(命令, { fixed, values, choices })` 生成：每个参数一个输入，`fixed` 里的不问，直接写进 `Call` |
| `IconName` | `activity`、`archive`、`bookmark`、`box`、`clock`、`cloud`、`cloud-upload`、`code`、`corner-left-up`、`database`、`download`、`eye`、`file`、`file-text`、`flask-conical`、`folder`、`gauge`、`git-branch`、`globe`、`history`、`image`、`key`、`layers`、`layout-grid`、`link`、`list`、`package`、`refresh-cw`、`rocket`、`scroll-text`、`search`、`server`、`settings`、`shield`、`tag`、`terminal`、`triangle-alert`、`upload`、`users`（lucide 的图标名，sdk 的 `ICON_NAMES`）。界面把别的名字画成拼图 |

内核核对每一块：种类不认识、缺了必需的字段、类型不对、`embed` 的地址不是 http 或 https、`custom` 的 `entry` 爬出 `ui` 目录或插件没有 `ui`、输入的 `pattern` 不是正则，都算不合。

### 4.5 自己画的页

`custom` 块的 `entry` 是插件 `ui` 目录里的相对路径；`ui` 是插件对象上的绝对路径，插件自己设，比如 `fileURLToPath(new URL('./ui/', import.meta.url))`，内核不替它设。界面把页放进 `<iframe sandbox="allow-scripts">`，地址是 `/plugin-ui/<插件名>/<entry>`，不带令牌，载入时不发 Referer，所以页调不了界面的接口。框架开始时 `height` 高，之后跟着页报的高度，最高 4000。

页载入界面的服务给的 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css`。`@pneuma-base/sdk/frame` 是它们的类型和清单：页的脚本写 `/// <reference types="@pneuma-base/sdk/frame" />`，编辑器就认得 `pneuma`。

| 页得到的 | 是什么 |
| --- | --- |
| `pneuma.onData(回调)` | 回调收到 `(data, { scheme, actions })`：块的 `data`；配色 `light` 或 `dark`；块的动作，按名字，每个只有 `label`、`tone`、`inputs`，没有 `call`。现在调一次，之后每次重取视图、换配色再调。`onData<T>` 给 `data` 定类型 |
| `pneuma.run(名字, 值)` | 要界面做块里叫这个名字的动作，`值` 按输入名填它的表单（只取动作声明了的输入） |
| `pneuma.open(链接)` | 打开一个 `Link`，或在新标签页打开一个 http 或 https 地址的字符串 |
| 高度 | `frame.js` 在内容高度变了时报给界面，页不用设自己的高度 |
| `frame.css` 的类（`FRAME_CLASSES`） | `card`（浮起的面）、`btn`、`btn-primary`、`btn-danger`、`field`（文字输入）、`field-area`（多行输入）、`tag`（小标签），配 `tone-good`、`tone-warn`、`tone-bad`、`tone-info`；`segmented`（一排按钮，选中的带 `aria-checked="true"`）、`select`（包住一个 `<select>`）、`link`、`mono`（等宽）、`muted` 和 `faint`（淡一些的字） |
| `frame.css` 的变量（`FRAME_TOKENS`） | `--page`、`--canvas`、`--surface`、`--inset`、`--hover`、`--hover-2`、`--ink`、`--ink-2`、`--ink-3`、`--line`、`--line-strong`、`--line-soft`、`--field`、`--accent`、`--accent-ink`、`--accent-tint`、`--green`、`--green-tint`、`--orange`、`--orange-tint`、`--red`、`--red-tint`、`--tooltip-bg`、`--tooltip-fg`、`--scrim`、`--tag-fill`、`--tag-ring`、`--shadow-xs`、`--shadow-sm`、`--shadow-lg`、`--shadow-hairline`、`--shadow-btn`、`--shadow-card`、`--shadow-overlay`、`--shadow-inset-field`、`--radius-chip`、`--radius-control`、`--radius-card`、`--radius-window`、`--font-sans`、`--font-mono`。`frame.js` 把它们设在页的根上，取界面当前的浅色或深色，所以页不用写自己的颜色 |

`frame.js` 和界面之间只有四种消息，都带 `pneuma: 1`：界面到页的 `data`，页到界面的 `run`、`open`、`height`。别的消息、别的来源的消息，界面都不理。页要做的动作走和按钮完全一样的路：同一个对话框问 `confirm`，同样经两个面分派，同样有结果提示和重取。页拿不到 `Call`，所以跑不了块没声明的动作，「破坏性的要当面确认」「每次操作留痕」仍然只在两个面的入口守。

页 5 秒内没和界面握手，比如文件不在、载入失败、没载 `frame.js`，那一块换成一段说明，写出插件名和 `entry`，页的其余部分照常。沙箱为的是隔离样式和崩溃，不是防插件：插件的 `index.js` 本来就在本机以主人的身份跑。3.6 里 `sizes` 的 `ui/bars.html` 可以是：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="/plugin-kit/frame.css" />
    <script src="/plugin-kit/frame.js"></script>
    <style>
      .bar { height: 6px; margin: 6px 0; border-radius: 3px; background: var(--accent); cursor: pointer; }
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
| `recordStore(目录, parse)` | 只新增文件的记录库（3.7）。`stamp(ctx, 内容)` 盖上 `id`、`at`、`actor`、`session`，还不写；`append(记录)` 把几条写成一个新文件；`read()` 答 `{ records, skipped }`，`skipped` 是读不懂的行，原样留在文件里。`parse` 收到一行的对象，答内容，或一句为什么不是 |
| `configFile(绝对路径, parse)` | 整份替换的配置文件（3.7）。`read()` 没有文件时 `null`，不是 JSON 或 `parse` 抛错时抛错；`write(值)` 先写临时名再改名 |
| `deployPlugin(名字, 目标, 选项)` | 给一个插件名和一种或几种目标，交回一个完整的部署插件 |
| `defineTarget(目标)` | 写一种目标，见下面 |
| `STATUS`、`switchAction(插件名, look)` | 部署库的页上每种状态的标签，和一样东西的开关动作，目标自己画的块用它们说一样的状态、给一样的开关 |
| `siteName`、`want`、`plan`、`statusOf` | 部署库的决定，纯函数：缺省的站点名，目标上该有什么，要做的几步，状态 |

### 部署库

部署库替你做和目标无关的一切：agent 用 `say deployable <库内路径> [一句话]` 声明一样东西可以部署，声明不让它上线；主人用开关决定它在不在线；开着的东西，目标上跟着库里当前的内容，放入、挪、归档、取回之后都对一遍。记录、主人命令、页面、条目面板里的一节、认知段都是它的。一个部署插件只写它的目标。

它给的主人命令，`<名字>` 是插件名：

| 命令 | 标志 | 做什么 |
| --- | --- | --- |
| `<名字> on <库内路径>`、`<名字> off <库内路径>` | `ownerOnly` | 打开或关上开关，并发布或下线 |
| `<名字> target set [--kind <kind>] <目标的开关>` | `ownerOnly`、`setup` | 配目标；只有一种目标时可以不写 `--kind`。答复提醒还没设的必需密钥，可选的只说要用时怎么设 |
| `<名字> sync` | 谁都能用 | 把全部声明过的东西对一遍 |
| `<名字> list` | `readOnly` | 列出声明过的东西、状态和地址 |

它的页是 `<名字>.sites`：目标一节，可部署的东西一张表，表里每行一个开关。它在自己目录下写 `config.json`（目标，整份替换）和 `facts/`（记录），都是本体；跑符合性检查时把 `config.json` 列进 `configuration`。

一个库只装得上一个部署插件。所有部署插件都认领 `say deployable`，第二个在 `plugin add` 时以 `name-taken` 拒绝（3.3）。这是设计：一句「可以部署」只该有一个插件听，否则同一样东西会被两个插件各自发布。要发到几种地方，写一个部署插件带几种目标，主人用 `--kind` 选。

`deployPlugin` 的选项：

| 选项 | 是什么 | 缺省 |
| --- | --- | --- |
| `title` | 给人看的名字：说明、页面、条目面板里的一节 | 部署 |
| `heading` | 认知段的标题，`<它带来什么>：<怎么用>` | 上线：主人开关 |
| `cognition` | 加在它写的认知段后面的一段，说这个目标 agent 该知道的 | 没有 |
| `icon` | 页面的 `IconName` | `globe` |
| `version`、`summary` | 同插件对象的 | 没有 |
| `ui` | 插件的 `ui` 目录，目标加 `custom` 块时要 | 没有 |

### 写一种新的目标

一种目标是一个 `TargetAdapter`，用 `defineTarget` 写。`defineTarget` 让 `configure` 收到按开关定好类型的值，让 `env.secret` 只收声明了的名字，让视图的函数按 `open` 写明的返回类型 `Target<细节>` 拿到细节的类型：

| `TargetAdapter` 的字段 | 是什么 |
| --- | --- |
| `kind` | `target set --kind` 的值，随配置存下 |
| `label` | 发布到哪种地方，给人看：「一个本地目录」 |
| `params` | `target set` 在 `--kind` 之后的开关，一份 `FlagParam[]`。命令的参数表、帮助、页面上的表单和核对都从这里来；有几种目标时，选定的那种必填的开关才必填 |
| `secrets` | 它读的密钥，可以标 `optional: true`。部署库把它们声明成插件的密钥，`secret set` 和配置页就认得 |
| `views` | 可选，目标自己的页，每项 `{ name, title, icon }`。每页是导航里的一项，排在部署库的页之后，视图编号 `<插件名>.<name>`；`name` 用小写字母、数字、连字符，不得是 `sites` |
| `configure(值, ctx)` | 把核过的值变成要存的配置（一个 JSON 对象），或答 `{ ok: false, reason, text }` |
| `open(配置, env)` | 在边界上解析存下的配置，交回这一次钩子或命令用的 `Target`；读不懂就抛错 |

`env` 是 `{ ctx, scratch, plugin, secret }`：`ctx` 是这次的上下文，`scratch` 是库外给它用的临时目录，`plugin` 是插件名（它的命令以此开头），`secret(名字)` 读主人在这台机器上设的密钥。必需的密钥没设时 `secret` 以一句说明用哪条命令设的错误拒绝，开关的答复里是 `publish-failed` 带这句话；可选的没设时读出 `null`，类型是 `string | null`。要密钥的目标从不在开关里要它。

| `Target` 的字段 | 是什么 |
| --- | --- |
| `key` | 记录按它区分目标：换了 `key`，旧目标上的站点不再算 |
| `label` | 什么、在哪，一行给人看 |
| `publish(站点名, 目录, meta)` | 把目录发布成这个站点，换掉它原来的内容，答 `{ url }`。目录是部署库复制到缓存目录下的临时副本；`meta` 有内容编号 `content`、库内路径、时刻，和按路径的 UTF-8 字节排好的 `files` |
| `remove(站点名)` | 下线；下线一个它没在服务的站点不算错 |
| `siteName(路径)` | 可选，换掉缺省的站点名：库内路径小写，别的字符换成 `-`，路径不干净时加 sha256 的前 6 位，最长 58 个字符 |
| `identify(文件)` | 可选，内容的编号；没有就用内核的指纹 |
| `serving(站点名, ask)` | 可选，问的这些站点它现在真在服务什么：按站点答 `{ content, url, detail? }`，没在服务的 `content` 为 `null`，答复里没有的站点它既不服务也不知道。`detail` 是目标自己类型的其余信息，交给它的视图。有 `serving`，部署库按目标报的对账，`<名字> sync` 修得好断在一半的发布和在目标那边被删掉的站点；它抛错时状态是「不知道」，什么都不做。没有它，按插件自己的记录对账 |
| `view` | 可选，往部署库的页、目标自己的页和条目面板里加东西，见下表 |

`serving` 什么时候被问：

- 一页（部署库的页或目标自己的页）先为全部声明过的东西的站点问一次，`ask.detail` 为 `true`，再调视图的函数。条目面板先为它那样东西的站点问，再调 `fields` 和 `item`。所以视图的函数从不在它要画的答复之前运行。
- 钩子和命令问时 `ask.detail` 为 `false`，不调视图的函数。只有视图用的数据，比如请求数的曲线，在 `ask.detail` 为 `true` 时才取。
- 部署库发布或下线之后会再问，所以记着答复的目标要忘掉变了的站点。

| `view` 的字段 | 是什么 |
| --- | --- |
| `columns`、`cells(look)` | 表格里在路径、状态、地址之后的列，和每行按列的 `key` 填的格 |
| `fields(look)` | 条目面板里在状态、开关、地址、站点名之后的字段 |
| `before(全部)`、`page(全部)` | 部署库的页上，在它的几节之前、之后的块；`custom` 块要插件的 `ui` |
| `pages` | 按名字给目标的 `views` 里每页的块：`pages[name](全部)`。配的目标不画某一页时，那一页说明这一点 |
| `item(look)` | 条目面板里这一节最后的块 |
| `refresh` | 页面过多少秒重取，`null` 是不重取。目标有 `serving` 时缺省 30，没有时不重取 |

视图的函数拿到的每个 look 是一样声明过的东西现在的样子：

| look 的字段 | 是什么 |
| --- | --- |
| `thing` | 声明：`id`、`path`、`on`（开关）、`declaredAt`、`declaredBy`、`note` |
| `standing`、`held` | 库里的情况，和目标上为它服务着的站点与内容 |
| `status` | `online`、`pending`、`offline`、`retiring`、`archived`、`missing`，读不到目标时 `unknown`；`STATUS[status]` 是页上的标签：在线、待发布、离线、待下线、已归档、不在、不知道 |
| `site`、`url` | 它有或会有的站点名，归档时是 `null`；目标在哪里服务它 |
| `unreachable` | 读不到目标时的原因 |
| `detail` | `serving` 对它的站点说的 `detail`：先取它正在其下服务的站点，再取它的路径有的、归档的东西曾有的站点名。所以归档了的、待下线的东西也有。在页和面板之外是 `null` |

`switchAction(插件名, look)` 是表格里的那个开关：`{ label: '打开' 或 '关上', tone: 'default', confirm: null, inputs: [], call: { face: 'owner', command: '<插件名> on' 或 '<插件名> off', args: { positional: [路径], flags: {} } } }`；归档了又关着的东西没有开关，答 `null`。

PneumaSpace 插件（`space`）就是一个部署插件：它的目标用 PneumaSpace 的管理接口发布，`identify` 用上传的包的 sha256 作内容编号，`serving` 问 PneumaSpace 真在服务什么，令牌是可选的密钥，表格和面板里加了版本这些格，另有一页「看板」。下面是它的代码，省掉了两处：它打的是字节只由文件决定的 tar 包，这里把文件依次连起来；站点的地址它从 PneumaSpace 的入口算，这里从管理地址算。

```ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Block, Cell, LibraryPath } from '@pneuma-base/sdk'
import { STATUS, defineTarget, deployPlugin, siteName, switchAction, type ContentId, type Look, type Served, type SiteFile, type SiteName, type Target } from '@pneuma-base/sdk/kit'

/** A row of PneumaSpace's `GET /api/apps`, and what `GET /api/apps/<name>` adds. */
type AppRow = { name: string; address: string; requests: number | null }
type AppDetail = { app: { status: string; owner: string; current: number | null }; releases: { number: number; bundle: string }[] }
/** What `serving` tells of a site beside content and address; the views draw it. */
type Seen = { row: AppRow; owner: string; release: number | null; spark: number[] | null }

/** `<prefix>-<the kit's site name>`, cut to PneumaSpace's 40 characters with six of the path's sha256 when too long. */
function appName(prefix: string, path: LibraryPath): SiteName {
  const whole = `${prefix}-${siteName(path)}`
  if (whole.length <= 40) return whole as SiteName
  return `${whole.slice(0, 33).replace(/-+$/, '')}-${createHash('sha256').update(path).digest('hex').slice(0, 6)}` as SiteName
}

/** The site as PneumaSpace takes it, and its id, known before any upload. */
async function bundleOf(files: readonly SiteFile[]): Promise<{ body: Buffer; id: ContentId }> {
  const body = Buffer.concat(await Promise.all(files.map((f) => readFile(f.abs))))
  return { body, id: createHash('sha256').update(body).digest('hex') as ContentId }
}

const releaseCell = (s: Seen | null): Cell => (s?.release == null ? { text: '—', muted: true } : { text: `第 ${s.release} 版` })

/** The board, drawn by ui/board.html: each thing not archived, with the kit's state tag and switch. */
function board(all: readonly Look<Seen>[], plugin: string): Block {
  const shown = all.filter((l) => l.status !== 'archived')
  const actions = Object.fromEntries(
    shown.flatMap((l) => {
      const action = switchAction(plugin, l)
      return action === null ? [] : [[l.thing.id, action] as const]
    }),
  )
  const data = shown.map((l) => ({ key: l.thing.id, path: l.thing.path, url: l.url, state: STATUS[l.status], spark: l.detail?.spark ?? null }))
  return { kind: 'custom', entry: 'board.html', height: 330, data, actions }
}

const spaceTarget = defineTarget({
  kind: 'space',
  label: 'PneumaSpace',
  params: [
    { name: 'admin', hint: '管理地址', kind: 'value', required: true, pattern: 'https?://\\S+' },
    { name: 'prefix', hint: '应用名前缀', kind: 'value', required: true, pattern: '[a-z](?:[a-z0-9-]{0,14}[a-z0-9])?' },
  ],
  secrets: [{ name: 'token', description: 'PneumaSpace 不在本地模式时的访问令牌，作为 Bearer 发出', optional: true }],
  views: [{ name: 'board', title: '看板', icon: 'layout-grid' }],

  async configure({ admin, prefix }) {
    return { ok: true, config: { admin: admin.replace(/\/+$/, ''), prefix } }
  },

  open(config, env): Target<Seen> {
    const { admin, prefix } = config
    if (typeof admin !== 'string' || typeof prefix !== 'string') throw new Error('PneumaSpace 的配置要写 admin、prefix')
    const owner = `service:pneuma-base.${env.ctx.library.config.id}`
    /** One call of the admin API; null for 404. The token is optional: null while the owner has not set it. */
    async function call(method: string, path: string, body?: string | Uint8Array): Promise<unknown> {
      const token = await env.secret('token')
      const reply = await fetch(`${admin}${path}`, { method, body, headers: token === null ? {} : { authorization: `Bearer ${token}` } })
      if (reply.status === 404) return null
      if (!reply.ok) throw new Error(`PneumaSpace 拒绝了 ${method} ${path}：${reply.status}`)
      return reply.json()
    }
    const rows = async () => new Map(((await call('GET', '/api/apps')) as AppRow[]).map((r) => [r.name, r]))
    const app = async (site: SiteName) => (await call('GET', `/api/apps/${site}`)) as AppDetail | null
    /** The app, unless another library or a person holds its name. */
    const ours = async (site: SiteName) => {
      const held = await app(site)
      if (held !== null && held.app.owner !== owner) throw new Error(`应用名 ${site} 在 PneumaSpace 上属于 ${held.app.owner}，不是这个库，所以不动它`)
      return held
    }

    return {
      key: `pneuma-space:${admin}#${prefix}`,
      label: `PneumaSpace ${admin}，前缀 ${prefix}`,
      siteName: (path) => appName(prefix, path),
      identify: async (files) => (await bundleOf(files)).id,

      async publish(site, _dir, meta) {
        const { body, id } = await bundleOf(meta.files)
        if (id !== meta.content) throw new Error(`复制出来的内容和决定发布的不同：${id} 不是 ${meta.content}`)
        await ours(site)
        await call('POST', '/api/bundles', body)
        await call('PUT', `/api/apps/${site}/release`, JSON.stringify({ bundle: id, owner }))
        const row = (await rows()).get(site)
        return { url: row === undefined ? null : new URL(row.address, admin).href }
      },

      /** Removes, never purges: the releases stay, and publishing again brings the app back. */
      async remove(site) {
        const held = await ours(site)
        if (held?.app.status === 'registered') await call('POST', `/api/apps/${site}/remove`)
      },

      /** What PneumaSpace serves for each site; the request series, which only the board draws, only for an answer that is drawn. */
      async serving(sites, ask) {
        const all = await rows()
        const told = new Map<SiteName, Served<Seen>>()
        for (const site of sites) {
          const row = all.get(site)
          const held = row === undefined ? null : await app(site)
          if (row === undefined || held === null) continue
          const live = held.app.owner === owner && held.app.status === 'registered' ? held.releases.find((r) => r.number === held.app.current) : undefined
          const usage = live && ask.detail ? ((await call('GET', `/api/usage?app=${site}`)) as { buckets: { requests: number }[] } | null) : null
          const detail: Seen = { row, owner: held.app.owner, release: live?.number ?? null, spark: usage?.buckets.map((b) => b.requests) ?? null }
          told.set(site, { content: live ? (live.bundle as ContentId) : null, url: live ? new URL(row.address, admin).href : null, detail })
        }
        return told
      },

      view: {
        columns: [{ key: 'release', label: '版本' }, { key: 'requests', label: '24 小时请求', optional: true }],
        cells: (l) => ({ release: releaseCell(l.detail), requests: { text: String(l.detail?.row.requests ?? '—') } }),
        fields: (l) => [{ label: 'PneumaSpace 里', value: l.detail === null ? { text: '没有这个应用', muted: true } : { text: `属于 ${l.detail.owner}`, mono: true } }],
        pages: { board: (all) => [board(all, env.plugin)] },
      },
    }
  },
})

export default deployPlugin('space', spaceTarget, {
  title: 'PneumaSpace',
  heading: '上线到 PneumaSpace：主人开关',
  cognition: '在线的网站是 PneumaSpace 上的一个应用，地址在 `/apps/<应用名>/` 下面，所以网站里的链接要写相对路径；目录里要有 `index.html`。',
  icon: 'cloud-upload',
  summary: '声明了可以部署的东西由主人开关上线，作为 PneumaSpace 上的应用。',
  ui: fileURLToPath(new URL('./ui/', import.meta.url)),
})
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
| 插件只往自己名下写，已有的文件不改写不删，视图什么都不写 | 第 3.7 和 3.6 节 | （检查：`writes`） |
| 缓存删掉什么都不丢 | 缓存不同步，换一台机器就没有 | （检查：`cache`） |
| 卸下插件之后库照常能用：配置和说明里没有它，动词照常答复，界面没有它的视图，内容一样不少 | 主人总能卸下一个插件 | （检查：`remove`） |
| agent 面上做的事，主人必须撤得回 | 底线是 agent 造不成破坏性的改动。比如部署插件对目标只下线、不清除，再发布就回来 | 查不了 |
| 对外的动作和替主人做的决定只给主人：这样的命令声明 `ownerOnly` | 对外发布、设目标这类事主人决定；内核的门在 agent 的会话里拒绝 | 查不了 |
| 给 agent 的失败要说清是谁的问题、要不要重做、该告诉谁 | agent 照字面做：「放入本身已经成功，不用重做；告诉主人」 | 查不了 |
| 给人和 agent 看的文字用中文，不设定主人的性别 | 说明、答复、界面都是中文；主人可以是任何人 | 查不了 |
| 拒绝理由用英文短词，小写、连字符 | 程序和测试比对理由，人读 `text` | 查不了 |
| 记录只新增文件，不改写已有的；配置整份替换 | 几个写入者和同步不丢东西 | （检查：`writes`） |
| 密钥不进库 | 库会被同步、给别的 agent 看 | 查不了 |

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
| 选项 | `plugins`（插件目录）、`builtins`（再加的自带插件）、`env`、`timeout`（每次调用的毫秒数，缺省 60000）、`cli`；`bare`：从 `init --bare` 开始，只有给的插件。这样的库里没有插件带 `revise`，往有不同内容的路径放入以 `would-overwrite` 拒绝；没有插件听的种类，说不被听到；找只按名字列，看和查没有节 |
| `home`、`library`、`work`、`env`、`cli` | 家目录、库、调用的工作目录（要放进库的文件放这里）、调用的环境、命令行 |
| `run(参数)`、`owner(参数)`、`agent(名字, 会话, 参数)` | 调命令行：不带库；以主人身份带 `--library`；带 `--as` 和 `--session`。交回 `{ code, stdout, stderr, json }`，`json` 是带 `--json` 时解析的标准输出 |
| `viewer()` | 起界面的服务，给出 `view(编号, 参数)`、`item(路径, { plugin? })`（给 `plugin` 时只有那个插件的一节和它的问题，它没给节时没有块）、`state()`、`act(动作, 值)`（像人填好表单、确认那样做一个动作）、`get(路径)`、`stop()` |
| `serve(handler)` | 在本机起一个库外 HTTP 服务的替身，比如部署目标，答它的地址 `http://127.0.0.1:<端口>`。每个请求作为 `Request` 交给 `handler`，它答的 `Response` 发回去；`handler` 抛错时答 500 |
| `cleanup()` | 停掉它起的界面服务和替身，删掉临时目录 |

调用的环境从空的建起，只带 `PATH`、`TMPDIR`、`LANG` 这几样，所以没有任何 agent 产品的会话变量：`owner` 就是主人。每次调用的标准输入是关着的，有时限。

`conformance` 的选项：`setup({ sandbox, cwd, bin })` 是新库上要先做的，比如放进认知段示例要用的东西、主人设一个目标；`cwd` 是示例运行的目录，`bin` 在示例的 `PATH` 最前面，可以放库外命令的替身。`configuration` 是自己目录下整份替换的配置文件，相对自己的目录。还有 `env`、`timeout`、`cli`，同 `sandbox`。

| 检查 | 规则（报告里原样是这一句） | 怎样查 |
| --- | --- | --- |
| `loads` | 插件目录的 index.js 缺省导出一个插件，contract 是这个 pneuma-base 认识的版本，过得了装载时的核对 | `plugin install` 插件目录，`plugin list` 里有它、没失败、契约对得上，`init --bare` 的新库上 `plugin add` 做成 |
| `names` | 主人命令以「<插件名> 」开头，视图编号以「<插件名>.」开头，插件名不是命令行或内核自己用的词，命令名不是内核的命令 | 读插件对象，另查「说」的种类不空、不带空白 |
| `cognition` | 认知段以「## <它带来什么>：<怎么用>」开头，第一句是「这个库装了**<标题>**插件。」，命令示例写成 pneuma-base @{{授权的名字}} …，只用 {{授权的名字}} 这一个占位，不重复内核管的规矩 | 读认知段；许诺、不该做的事这些查不了的，列成提醒 |
| `examples` | 认知段里的每条命令示例，在一个新库上做完准备步骤之后，照原样在 agent 的会话里能跑，退出码是 0 | 另一个新库：装上插件，发授权 `conformance` 给 `conformance-agent`，跑 `setup`，再在 `cwd` 里用 `/bin/sh` 一条一条跑示例，`{{授权的名字}}` 换成 `conformance`，环境里有 `PNEUMA_BASE_SESSION`。每条示例各开一个 shell，按次序跑 |
| `hooks` | 每个钩子在空库上、在每个动词之后都不抛错，答复里没有这个插件的问题 | 空库（`init --bare`）上：`plugin add`、找、查、看一个不在的路径、每种「说」不带和带路径、`plugin remove` 再 add。`setup` 之后一遍脚本：放一个文件、放一个目录、找、看、每种「说」、查、同一路径放不同的内容、挪、归档、取回、归档一个目录、清空归档区、每条参数都可省的 `readOnly` 主人命令。agent 是 `conformance-agent`，用 `--as`，不带授权；主人命令以主人身份跑 |
| `writes` | 插件只往库里自己名下的 .pneuma-base/<插件名>/ 写；那里已有的文件不改写、不删（声明为配置的文件和缓存目录除外）；视图和条目面板里的一节什么都不写 | 空库上和脚本里的每一步前后比库的快照：每个路径，文件的哈希、inode、修改时间，内核的临时目录除外；脚本跑完之后开每个视图和条目面板，前后再比，这时什么都不能变 |
| `cache` | 缓存删掉什么都不丢：删掉它在本机的缓存目录和声明为缓存的目录前后，找、看、查的答复一样 | 找、看、查各问两遍，删掉缓存再问一遍。两遍就答得不一样的，没法比，列成提醒 |
| `blocks` | 视图和条目面板里的一节答复的都是合法的块，钩子不抛错；custom 块指向的页面在插件的 ui 目录里，取得到 | 空库上和脚本跑完之后，开每个视图（筛选取缺省值）和条目面板（空库上是一个不在的路径；脚本之后是挪过的那个文件，和随归档区清掉的那个目录在内容区、归档区的两个路径），看答复里它的问题，再取每个 `custom` 块的 `/plugin-ui/<插件名>/<entry>` |
| `remove` | 卸下插件之后库照常能用：配置和说明里没有它，动词照常答复、没有问题，界面没有它的视图，内容一样不少 | `plugin remove`，被拒绝时加 `--anyway`；看配置、说明、内容的哈希，找、查、看、放的答复，界面的视图清单和问题 |

`loads` 不通过时，后面要装上才能查的几项都记成「没有查：插件没装上」。

脚手架的 `test/conformance.test.ts` 就是这样用它的：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the plugin follows the standard', async () => {
  const report = await conformance(dist, {
    async setup({ sandbox }) {
      const put = await sandbox.agent('setup', 'setup', ['put', '-', '--to', 'notes/plan.md', '--made'], { input: '# 计划\n' })
      assert.equal(put.code, 0, put.stderr)
    },
    configuration: [],
  })
  assert.ok(report.ok, report.text)
})
```

目标是网络服务的插件，在 `setup` 里用 `serve` 起一个替身，把目标设到它的地址，不连真的服务就能跑符合性检查。第 5 节的 `space` 可以这样查：钩子和视图只问到 `GET /api/apps`，答一个空表就够；真的插件的替身答它会调的每个接口，并先打开一个站点，所以视图是带着在线的应用查的。

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformance } from '@pneuma-base/sdk/testkit'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

test('the plugin follows the standard, with PneumaSpace stood in for', async () => {
  const report = await conformance(dist, {
    async setup({ sandbox }) {
      const admin = await sandbox.serve(async (request) =>
        new URL(request.url).pathname === '/api/apps' ? Response.json([]) : Response.json({ error: 'not found' }, { status: 404 }),
      )
      const set = await sandbox.owner(['space', 'target', 'set', '--admin', admin, '--prefix', 'conf'])
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
  const put = await sb.agent('claude-code', 'session-1', ['put', '-', '--to', 'notes/plan.md', '--made'], { input: '# 计划\n' })
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

装和启用分开：`plugin install`、`plugin uninstall` 说这台机器上有没有，`plugin add`、`plugin remove` 说一个库用不用。

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `plugin install <目录>` | 只有主人；不用指明库 | 按装载器的办法载入那个目录、过下面的核对，名字取插件自己写的；再复制到 `$PNEUMA_BASE_HOME/plugins/<名字>/`，先写临时名再换上。同名的换掉，答复说换了哪一版。自带插件的名字以 `built-in-name` 拒绝，过不了核对以 `plugin-failed-to-load` 拒绝，已装的那份不动 |
| `plugin uninstall <名字>` | 只有主人；不用指明库 | 从这台机器卸掉。带 `--library` 而那个库还装着它时以 `still-installed` 拒绝；这台机器上别的装着它的库会报它载不了 |
| `plugin list` | 谁都能用；不用指明库 | 自带的和装上来的，各带版本、契约、一句说明，载不了的带原因；带 `--library` 时标出那个库装了哪些 |
| `plugin add <名字>` | 只有主人 | 在库里启用，从自带的和这台机器装上来的里找。名字被已装的插件占着时以 `name-taken` 拒绝（3.3） |
| `plugin remove <名字> [--anyway]` | 只有主人 | 在库里停用，它名下的目录原样留着；插件的 `onRemove` 拒绝时要 `--anyway` |

```sh
pneuma-base plugin install dist
pneuma-base plugin list --library ../lib
pneuma-base plugin remove marks --library ../lib
pneuma-base plugin uninstall marks
```

改了就重新载入：装载器按插件目录里每个文件的名字、大小、修改时间算一个戳，目录里任何文件变了，下一次载入就用新的。命令行每次调用都载入一次，界面的服务每次请求都载入一次，所以 `npm run install-local` 之后，开着的管理界面在下一次请求就用新代码，不用重启。

这台机器载不了一个装了的插件时（导入时抛错、缺 `index.js`、过不了核对），它不进插件表，装了它的库在每个答复的问题里列出它和原因，`plugin list` 标出没能加载和原因。

### 装载时核对什么

装到这台机器和每次装载时，内核核对一切不必调钩子就能核对的：

| 项 | 要求 |
| --- | --- |
| `index.js` | 在目录里，载入不抛错，缺省导出一个对象 |
| `contract` | 写了，是这个 pneuma-base 跑的版本：现在只有 `1` |
| `name` | 合 `PLUGIN_NAME`：小写字母开头，只用小写字母、数字、连字符，最长 41 个字符；装到本机之后和目录名相同；不是 `RESERVED_PLUGIN_NAMES` 里的词：`tmp`、`start`、`find`、`inspect`、`put`、`say`、`check`、`archive`、`unarchive`、`init`、`view`、`help`、`grant`、`plugin`、`skill`、`secret`（命令行的词、内核命令的头一个词、内核的临时目录名） |
| `version`、`summary` | 没有，或是文字 |
| `keeps` | 没有，或是 `every`、`some` |
| `cognition` | `null`，或 `{ title, text }`，两样都是文字 |
| `storage` | 列表，每项 `{ dir, kind }`，`kind` 是 `body` 或 `cache` |
| `statements` | 列表，每项是不空的文字，不重复 |
| `ownerCommands` | 列表，每项有文字的 `summary`、真假的 `destructive` 和 `ownerOnly`、函数 `run`，`readOnly` 和 `setup` 没有或是真假，名字以 `<插件名> ` 开头、不是内核的命令、不重复，参数表合 4.3 |
| `views` | 没有，或列表，每项 `{ id, title, icon, nav, filters }`，`title` 和 `icon` 是文字，`nav` 是真假，`filters` 是列表，`id` 以 `<插件名>.` 开头、不重复 |
| `secrets` | 没有，或列表，每项 `{ name, description }`，可以带 `optional`（真假），`name` 合 `SECRET_NAME`，不重复 |
| 钩子 | 给了的都是函数 |

留到调用时的：钩子答什么、抛不抛错，插件往哪里写，`ui` 目录在不在。

`plugin new` 生成的项目按绝对路径依赖两个包文件，所以项目挪到别处照样装得上；`plugin new --help` 打印它自己的用法。

现在不做的：发布到 npm、插件市场、远程安装、从包文件（`.tgz`）直接装、签名。两个包文件不发布，脚手架按路径引用它们。

## 9. 还没规定的

下面这些，今天的代码没有答案。在它们定下来之前，插件不要依赖任何一种答法。

- 钩子和视图的时限。内核不给钩子、主人命令和视图设时限，界面等视图答复也没有时限。测试工具每次调用的 60 秒是测试的，不是规范的。
- 视图被调的频率上限。只规定了什么时候重取（3.6），`refresh` 最少 5 秒；没有规定一个视图最多多久被调一次。
- 认知段的长度上限。
- 契约的演进：契约 1 之内哪些改动算破坏，契约号什么时候升，升了之后内核还认不认旧号。
- 插件声明自己要哪一版 pneuma-base 或 Node。插件对象上没有这样的字段；生成的项目的 `package.json` 里的 `engines` 没有谁读。
- 条目面板里慢的一节按需加载。今天每一节都在打开面板时一起取。
- 动作说自己慢、显示进度，拒绝带一个短标题。今天的动作说不出这些。
- 主人命令的答复带一个指向视图的链接。今天只有 `offer` 一个动作；视图的地址见 3.6。
- 钩子里调 `tools.put` 的重入。内核不拦，也不防插件自己的 `onPut` 被再调一次。
- 几个进程同时跑同一个插件的钩子时的锁。内核不提供锁；`recordStore` 的写不会互相覆盖，`configFile` 最后一次写的算数。
- 谁清理 `ctx.cacheDir`。`plugin remove` 和 `plugin uninstall` 都不动它。

## 附：试做时的摩擦各自的去处

这份规范之前，有人在仓库外按当时的契约写了一个把网站部署到 PneumaSpace 的插件，记下 55 处「得去读源码才知道」「只能照抄」「做不到」（C、K、B、P、D、V）。后来又有人只拿两个包文件和脚手架重做了它，记下 13 条新的（N），为 `custom` 页的接口看过一次源码，现在 4.5 写全了。下表是每一条现在的去处，按今天的代码。

| 编号 | 摩擦 | 现在 |
| --- | --- | --- |
| C1 | 没有类型包，契约要手抄 | 解决：`@pneuma-base/sdk` 包文件，声明文件自成一体；钩子是函数类型的属性，严格检查 |
| C2 | 不能声明按哪一版契约写的 | 部分解决：`contract` 必填，装载时核对，不认识的版本说明原因（第 2、8 节）。声明要哪一版 pneuma-base 或 Node 还没有（第 9 节） |
| C3 | 上下文没有库的工具，只能抄内核 | 解决：`ctx.tools`（4.2） |
| C4 | 主人命令的参数是生的，个数由命令行定 | 解决：参数表 `params`，命令行、核对、帮助、表单都从它来（3.4、4.3） |
| C5 | 「说」的种类先到先得，没有提示 | 解决：`plugin add` 和 `init` 以 `name-taken` 拒绝；已有的撞名记成问题（3.3） |
| C6 | 只能靠抛错说「做了，但外面那步没成」 | 解决：`onPut`、`onArchive`、`onSay` 的答复可以带 `problems`（3.2） |
| C7 | 认 `archive purge` 要比命令名 | 解决：`onPurged`（3.5） |
| C8 | 插件听不到自己被卸下 | 解决：`onAdd`、`onRemove`，后者可以拒绝，主人可以 `--anyway`（3.5） |
| C9 | 凭证没地方放 | 解决：每台机器的密钥，`ctx.secrets`，`secret set`，可以标可选（3.7） |
| C10 | 小缺口：`PluginName` 造不出来、`ctx.dir` 在不在、面板的节不能按需加载 | 部分解决：`pluginName()` 在 sdk 里，`ctx.dir` 一定在（3.7）；按需加载没有（第 9 节） |
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
| D11 | 钩子运行时 `ctx.dir` 在不在 | 回答：3.7，一定在 |
| V1 | 只往自己名下写 | 规则：3.7（检查：`writes`） |
| V2 | 记录只新增 | 规则：3.7（检查：`writes`） |
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
| N7 | 可选的密钥被说成必需的 | 解决：`optional: true`，`target set` 的提醒、配置页、`secret list` 和 `env.secret` 跟着它（3.7、第 5 节） |
| N8 | 生成的项目以为自己不会挪地方 | 部分解决：按绝对路径依赖包文件，`plugin new --help` 说自己的用法，README 指向这份规范（第 8 节）。npm 11 仍警告 esbuild 的安装脚本没被允许，构建照样成功；依赖的路径写着打包文件所在的目录 |
| N9 | `bare` 的沙箱拒绝往有内容的路径放入 | 解决：`bare` 的说明写明它缺什么（第 7 节） |
| N10 | `viewer.item(路径)` 答整个面板 | 解决：`item(路径, { plugin })` 只答那个插件的一节；面板的每一节盖着插件名（第 7 节、3.6） |
| N11 | 每个站点的数据按站点名，归档时 `look.site` 是 `null` | 解决：look 的 `detail` 按它服务的、它的路径有或曾有的站点找，归档了的、待下线的也有（第 5 节） |
| N12 | 一个库只装一个部署插件 | 按设计：一句「可以部署」只该有一个插件听；要发到几种地方，一个部署插件带几种目标（第 5 节） |
| N13 | 视图的图标只能从一份没人给的清单里挑 | 解决：sdk 的 `ICON_NAMES` 和类型 `IconName`，别的名字画成拼图（4.4） |
