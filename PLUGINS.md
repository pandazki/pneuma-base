# Pneuma Base 插件规范

这份规范写给插件的作者：一个插件必须做什么，可以依赖什么。它对应插件契约第 1 版（`@pneuma-base/sdk` 的 `CONTRACT`）和 pneuma-base 0.9.0。读它不需要读 Pneuma Base 的源码，手里有 `pneuma-base plugin new` 生成的项目就够了。

这份规范在命令行的包里：插件项目 `npm install` 之后，它在 `node_modules/pneuma-base/PLUGINS.md`；`pneuma-base plugin new` 的答复也打印它的路径。

规则写成「必须」「不得」「可以」，一条一句，后面一句说为什么。符合性检查（第 7 节）查得了的规则，后面标出查它的那一项，例如（检查：`writes`）。命令块后面的输出块是它打印的行，按次序，和路径有关的行省掉了。

## 1. 五分钟

要 Node 22.18 以上、npm、能联网，再要一个放着两个包文件的目录：`pneuma-base-0.9.0.tgz`（命令行）和 `pneuma-base-sdk-0.9.0.tgz`（插件用的开发包）。两个包文件在 Pneuma Base 仓库里用 `pnpm pack:dist` 打出，在仓库的 `dist-packages/` 里。

在放包文件的那个目录里，照着运行：

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

第五行就是「改一处」：给 agent 读的那段说明加了一句。`npm test` 先构建，再在临时的库上跑符合性检查，改坏了它会用中文说哪条规则没守住。管理界面的导航里有「标记」这一页：上面是插件自己画的一块，下面是一张表，有刚才 agent 留的那条标记。

本文后面的命令都在 `marks/` 里运行，接着这五分钟的状态：`../lib` 是装了 `marks` 的库，里面有 `notes/plan.md`。

## 2. 一个插件是什么

一个插件是一个目录：`index.js` 是 ES 模块，缺省导出一个插件对象；旁边可以有它导入的别的文件、`node_modules/`、`ui/`（它自己画的页）。脚手架的 `npm run build` 把 `src/` 打成一个 `dist/index.js`，旁边放 `cognition.md` 和 `ui/`，`dist/` 就是这个目录。

一个只有契约版本、名字和几个空列表的对象就是合法的插件：

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

`definePlugin` 原样交回它的参数，只为让钩子在写的地方就按契约检查类型。钩子都是函数类型的属性，参数按契约严格检查。

- 插件的 `index.js` 必须缺省导出插件对象，`contract` 必须是这个 pneuma-base 认识的版本（检查：`loads`）。内核在装载时核对这两样，不对就不装。
- 插件不得导入另一个插件，也不得依赖另一个插件在不在。一个插件是完整的一个：内核没有「插件给插件留的槽」，也没有插件之间的依赖。
- 插件可以只依赖 `@pneuma-base/sdk`，运行时不必导入 pneuma-base 的任何代码。内核的工具经上下文的 `tools` 给你（第 4 节），所以算指纹、列东西的办法和正在跑的内核永远一样。
- 库的配置里只写插件的名字。内核不认识任何一个插件，说明、帮助、管理界面里的插件内容都来自插件对象本身。

### 装载时核对什么

装到这台机器（`plugin install`）和每次装载时，内核核对一切不必调钩子就能核对的：

| 项 | 要求 |
| --- | --- |
| `index.js` | 在目录里，载入不抛错，缺省导出一个对象 |
| `contract` | 写了，是这个 pneuma-base 跑的版本：现在只有 `1` |
| `name` | 合 `PLUGIN_NAME`：小写字母开头，只用小写字母、数字、连字符，最长 41 个字符；装到本机之后和目录名相同；不是 `RESERVED_PLUGIN_NAMES` 里的词 |
| `version`、`summary` | 没有，或是文字 |
| `keeps` | 没有，或是 `every`、`some` |
| `cognition` | `null`，或 `{ title, text }`，两样都是文字 |
| `storage` | 列表，每项 `{ dir, kind }`，`kind` 是 `body` 或 `cache` |
| `statements` | 列表，每项是不空的文字，不重复 |
| `ownerCommands` | 列表，每项的形状和参数表见 3.4，名字不重复 |
| `views` | 没有，或列表，每项 `{ id, title, icon, nav, filters }`，`id` 以 `<插件名>.` 开头，不重复 |
| `secrets` | 没有，或列表，每项 `{ name, description }`，`name` 合 `SECRET_NAME`，不重复 |
| 钩子 | 给了的都是函数 |

留到调用时的：钩子答什么、抛不抛错，插件往哪里写，`ui` 目录在不在。内核不认识的字段不管，原样留着。

`RESERVED_PLUGIN_NAMES` 是 `tmp`、`start`、`find`、`inspect`、`put`、`say`、`check`、`archive`、`unarchive`、`init`、`view`、`help`、`grant`、`plugin`、`skill`、`secret`：命令行自己的词、内核命令的头一个词，和内核的临时目录名。

### 契约的版本

- 插件在 `contract` 里写 sdk 的 `CONTRACT`，即它按哪一版契约写的。这个 pneuma-base 只跑第 1 版。
- 内核遇到它不跑的版本，装载失败：`plugin install` 以 `plugin-failed-to-load` 拒绝并说明原因，装了它的库在每个答复的问题里列出它，`plugin list` 标出没能加载和原因。
- 内核不认识的字段，在插件对象上不管，在一块里原样留着，界面也不理会。不认识的块种类不一样：内核把那一块换成一段说明出错的文字，并记成插件的问题（3.6）。
- 插件可以写 `version`（它自己的版本）和 `summary`（一句中文，说它带来什么），`plugin list` 和配置页显示它们。没写 `summary` 时显示认知段的标题。

## 3. 插件能做的七件事

### 3.1 往说明里加一段：认知段

库根目录的 `PNEUMA-BASE.md` 是写给 agent 的说明，由内核拼成：内核的开头，每个已装插件的认知段（按配置次序），内核的规矩，当前的配置。配置一变就重拼。agent 的技能文件只是指向这份说明的一个短文件，插件的认知段不在技能里。

`cognition` 是 `{ title, text }` 或 `null`。`title` 出现在说明末尾的配置清单里，没写 `summary` 时 `plugin list` 和配置页也用它；`text` 是拼进说明的那一段 Markdown。脚手架把 `text` 放在 `src/cognition.md`，去掉 HTML 注释后读进来。`marks` 的这一段是：

````md
## 标记：给东西留一句话

这个库装了**标记**插件。看到一样东西有要提醒主人或下一个 agent 的事，给它留一句话：

```sh
pneuma-base @{{授权的名字}} say marks notes/plan.md "第三节的数字还没核对"
```

标记只是一句话，不改那样东西。`pneuma-base @{{授权的名字}} marks list --path notes/plan.md` 列出它的标记；要删掉或处理标记，告诉主人。
````

- 认知段必须以 `## <它带来什么>：<怎么用>` 开头，中间是全角冒号（检查：`cognition`）。说明里每段都这样开头，agent 扫标题就知道装了什么。
- 标题之后的第一句必须是「这个库装了**<title>**插件。」（检查：`cognition`）。卸下插件时，检查靠这一句确认说明里已经没有它。
- 命令示例必须写成 `pneuma-base @{{授权的名字}} …`（检查：`cognition`）。agent 用自己的授权名调用，一个名字同时定下是哪个库、是谁。
- 认知段只能用 `{{授权的名字}}` 这一个占位（检查：`cognition`）。拼说明时它换成 `<你的授权名>`，agent 的技能文件告诉它自己的授权名是什么；别的 `{{…}}` 原样留在说明里。
- 认知段里的每条命令示例，在一个新库上做完测试准备的步骤之后，必须照原样能跑，退出码是 0（检查：`examples`）。示例是 `sh` 代码块里的每一行，和正文里不带别的 `<…>` 占位的 `` `pneuma-base @…` ``。
- 认知段不得重复内核管的规矩，不得写 `--include-archived` 和「在库外写好」（检查：`cognition`）。归档、找和查默认不带归档、新内容在库外写好再放进来，这些内核的那几段已经说了，说两遍会说岔。
- 认知段不得许诺插件不做的事。agent 照说明做；说明许诺的能力不超出已装插件真做的。检查查不了这一条，它列在报告的提醒里。
- 认知段必须说清 agent 不该做、做不了的，比如只有主人能开的开关，和出了问题该告诉主人还是重试。agent 不知道的界限，它会去试。检查同样只能提醒。
- 插件可以把 `cognition` 写成 `null`。那 agent 就不知道它在，只有不给 agent 用的插件才这样。

认知段的长度没有规定（第 9 节）。五个自带插件都装上时，整份说明不到 160 行。

### 3.2 参与六个动词

agent 手里有六个动词：放（`put`）、找（`find`）、看（`inspect`）、说（`say`）、查（`check`）、归档（`archive` 和 `unarchive`）。动词的请求和结果的形状不随插件变；插件在动词背后的钩子里加上它知道的。命令行另有一个 `start "<一句话>"`，是说、查、找三个动词的组合。

| 钩子 | 什么时候被调 | 拿到的 | 可以答 |
| --- | --- | --- | --- |
| `revise` | 放入的目标上已有同类、内容不同的东西，写入之前；按配置次序问每个有它的插件，一个答了照样问下一个 | `{ path, current, incoming }`，路径解析过 | `{ outcome: 'held', note }`：插件把当前内容留在主人取得回的地方；`{ outcome: 'declined', reason }` |
| `onPut` | 内核接受了一次放（登记、放入、挪）之后，按配置次序；被拒绝的放不调 | `AcceptedPut`，路径都解析过；`note` 去掉了首尾空白，空的是 `null` | 一条说明 `{ text, data? }`、`{ note, problems }` 或 `null` |
| `onFind` | 每次找（`start` 也找），内核按名字列完之后，按配置次序 | `FindRequest`，`text` 是调用方写的原样 | `PluginHit[]`，或 `{ hits, problems }` |
| `onFound` | 内核和所有 `onFind` 都答完之后，按配置次序；只问它自己没给命中的那些路径，一个都没有就不问 | 路径（解析过）和 `FindRequest` | `PluginHit[]`，每条的 `path` 必须是问它的路径之一 |
| `onInspect` | 每次看，按配置次序 | `{ target }`，调用方写的原样：一个路径，或某个插件认得的编号 | `PluginSection[]` |
| `onSay` | 说的种类在它的 `statements` 里时；只调这一个插件 | `{ kind, about, text, args }`，`about` 和 `text` 是原样 | `{ outcome: 'heard', note, problems? }`，或 `{ outcome: 'not-heard', reason: 'refused', note }` |
| `onCheck` | 每次查，按配置次序 | `{ since, includeArchived }` | `PluginSection[]` |
| `onArchive` | 归档或取回被接受之后，按配置次序；什么都没动（`moved` 为 `false`）也调 | `{ kind, from, to, moved }`，路径解析过 | 和 `onPut` 一样 |

一次动词里的次序：放是 `revise`（要换内容时）、写入、`onPut`，最后 `observe`；归档是挪动、`onArchive`、`observe`；找是内核按名字列、`onFind`、`onFound`、`observe`。`observe` 见 3.5。

「解析过」的路径是库内相对路径，以 `/` 分隔。「原样」是调用方写的字，相对库根或是库内的绝对路径，用 `ctx.tools.resolve(原样)` 解析（第 4 节）。只有 `onPut` 和 `onArchive` 拿到解析过的路径和挪动的来去；要跟着一样东西挪、归档、取回，用这两个钩子，不用 `observe`。

答复里不写插件名，内核盖上。`problems` 是插件自己那份做成了、库外的一步没做成：

- 钩子答 `{ note, problems }` 时，说明照给，问题列成这个插件的，动词的结果照旧。
- 钩子抛错时，它的说明没了，错误的消息列成这个插件的问题，动词照样答复，别的插件照样被调。
- `onSay` 抛错时，说的结果是 `not-heard`、理由 `plugin-failed`。`revise` 抛错算没留住。

所以能答问题就不要抛错：说明和问题可以一起给，抛错只剩问题。下面这个插件每次有新内容就通知主人设的一个网址，通知不到时放入照样成功：

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

找的几条：

- `includeArchived` 为 `false` 时，`onFind` 不得给归档区（`_archive/`）里的命中。默认的找不带归档的东西，内核只管自己列的那些。
- `match` 是 `words` 时，`onFind` 最多给 `ctx.tools.sentenceHits` 条，用 `ctx.tools.rankHits` 排。这时找的是一句话里的词，每个答复者只给最好的几条。
- `filters` 里有插件不认识的词时，插件可以不答。过滤是某个插件的用语，带了过滤时内核自己不按名字列。
- `skipOwnSession` 为 `true` 时，插件不得给它知道是调用者这次会话做的东西。`start` 打开它，找的是库里本来就有的。
- 一条命中的 `group` 是它的标题：`group` 相同的命中合在这个标题下，没有 `path` 的那条说的是标题本身。

### 3.3 听一种「说」

`say <种类> [<关于>] [<内容>]` 把一句话交给听得懂这个种类的插件。插件在 `statements` 里列出它的种类，在 `onSay` 里听。命令行这样分参数：只给一个时它是 `text`，`about` 是 `null`；给两个时是 `about` 和 `text`；`say` 后面的开关进 `args`，每个开关一个值的列表。

```ts
import { join } from 'node:path'
import { CONTRACT, definePlugin, pluginName } from '@pneuma-base/sdk'
import { recordStore } from '@pneuma-base/sdk/kit'

type Todo = { text: string }
const parseTodo = (raw: Record<string, unknown>): Todo | string => (typeof raw.text === 'string' ? { text: raw.text } : '不是一条待办')

export default definePlugin({
  contract: CONTRACT,
  name: pluginName('todo'),
  cognition: null,
  storage: [{ dir: 'items', kind: 'body' }],
  statements: ['todo'],
  ownerCommands: [],

  async onSay(req, ctx) {
    const text = [req.about, req.text].filter((part) => part !== null).join(' ')
    if (text === '') return { outcome: 'not-heard', reason: 'refused', note: '要写一句话：say todo "<要做的事>"' }
    const store = recordStore(join(ctx.dir, 'items'), parseTodo)
    await store.append([store.stamp(ctx, { text })])
    return { outcome: 'heard', note: `记下了：${text}` }
  },
})
```

- 「说」的种类不得是空的，也不得带空白（检查：`names`）。种类是命令行上的一个词。
- 列了种类，就必须有 `onSay`。内核只把一句话交给有 `onSay` 的插件；没有它，种类被占着却没人听，结果是 `no-plugin-for-kind`。
- 一个种类只归一个插件。`plugin add` 遇到已装的插件占着同一个种类，以 `name-taken` 拒绝，说出归谁；配置被手改或同步过来已经撞名时，后面那个插件的这个种类不接上，记成它的问题，在每个答复里列出。插件可以拿自己的名字作种类，脚手架就这样，免得和别的插件撞。

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

第二行被插件拒绝，退出码 2。第三行没有插件听，不算拒绝，退出码 0。

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

**名字。**

- 命令名必须是 `<插件名> ` 加一个或几个词，不得是内核自己的命令（检查：`names`、`loads`）。命令名的头一个词就是插件名，所以两个插件的命令不会撞，`--help` 里也看得出是谁的。
- 内核自己的命令是 `KERNEL_COMMAND_NAMES`：`grant issue`、`grant revoke`、`plugin add`、`plugin remove`、`skill install`、`archive purge`、`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`。

**参数表 `params`。** 每条命令都必须声明，什么都不带的写 `{}`（检查：`loads`）。命令行按它读参数，内核按它核对，`--help` 的用法和界面的表单都从它生成，几处说的不会不一样。

| 字段 | 位置参数 `positional` | 开关 `flags` |
| --- | --- | --- |
| `name` | 值在 `values` 里的名字 | `--<name>`，合 `^[a-z][a-z0-9-]*$`，不得是 `library`、`as`、`session`、`json`、`help` |
| `hint` | 几个中文字，说要写什么：用法里是 `<hint>`，表单里是这一项的名字 | 同左 |
| `kind` | 没有 | `value` 收一个值，`list` 收到下一个开关为止的一个或几个，`boolean` 不收值 |
| `required` | 必填的不得在可省的后面 | `boolean` 不得必填 |
| `many` | 收下其余的值；只有最后一个可以 | 没有 |
| `pattern` | 每个值都要整个匹配的正则（`u` 标志） | 同左；`boolean` 没有 |
| `options` | 没有 | 只给 `value`：不空的 `{ value, label }` 列表，只收这几个值 |

一个名字在一条命令的位置参数和开关里只出现一次。`run` 收到的值：必填的是文字，可省的可能是 `null`，`list` 和 `many` 是列表，`boolean` 是 `true` 或 `false`。值去掉两头空白，空的算没给，所以表单里留空的一项等于没写。少了、多了、不认识、格式不对、不在可选的值里，内核都以 `usage` 拒绝，说出哪一样，后面跟着用法，`run` 不被调。

**门。** 内核在同一处拦，插件不用自己看上下文：

| 标志 | 在 agent 的会话里 | 在主人那里 |
| --- | --- | --- |
| `destructive: true` | 以 `agent-session` 拒绝 | 要人当面确认：终端里问，输入 `yes` 才做，不在终端里就以 `not-confirmed` 拒绝；界面里是动作的 `confirm` 那一问 |
| `ownerOnly: true` | 以 `agent-session` 拒绝 | 直接做 |
| 两个都是 `false` | 照做 | 照做 |

另有两个可选的标志，只改事件上的记号：`readOnly: true` 说这条命令什么都不改，在库里和库外都不改，比如列一张清单，它的事件对 agent 不算消息；`setup: true` 说它只改插件、目标这类配置而不动条目，agent 第一次来之后再改才算消息。

- 丢数据、不能撤回的命令必须声明 `destructive: true`。内核只在这一个标志上拦，agent 的会话里拒绝，主人要当面确认。
- 不丢数据、但替主人做决定的命令必须声明 `ownerOnly: true`，比如对外发布、设部署或同步的目标、设密钥。
- `readOnly: true` 的命令必须什么都不改。符合性检查以主人身份跑每条参数都可省的 `readOnly` 命令，它出的问题算在 `hooks` 里，它改了自己目录里已有的文件或库的别处算在 `writes` 里。

**谁算 agent。** 下面任何一样成立，主人命令的门就当它在 agent 的会话里，拒绝的话说出是哪一样：

- 调用带着授权：`pneuma-base @<授权名> …`。
- 环境里有这些变量之一，值不空：`PNEUMA_BASE_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`CLAUDECODE`、`ANTIGRAVITY_AGENT`。
- 调用写了 `--as <名字>`。

管理界面的服务用的是启动它的那个 shell 的环境：在 agent 的会话里启动的界面，同样被拒。主人在 agent 产品开的终端里要用主人命令，把这些变量去掉：

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

**答复。** `run` 答 `{ outcome: 'done', text, data? }` 或 `{ outcome: 'refused', reason, text, offer? }`。命令行打印 `text`，带 `--json` 时打印整个结果；`data` 给 `--json` 和测试读。`offer` 是被拒绝之后人可以改做的一个动作，界面把它放在拒绝的提示里，点了照按钮走，先问它的 `confirm`。

- `text` 必须是给人看的中文，不设定主人的性别。主人和 agent 都读它。
- `reason` 必须是英文短词，小写，用连字符，比如 `no-target`。它给程序和测试比对，`text` 给人读。
- `run` 不得用抛错来拒绝。抛错时命令以「出错」结束，退出码 1，标准输出什么都没有，事件里的结果是 `failed`；拒绝时退出码 2，人读得到理由。
- `reason` 不得用 `usage`，除非真是用法错误。命令行把 `usage` 的拒绝当用法错误打印，退出码 1。

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

第一行是 `--help` 里这条命令的用法，由参数表生成。第三行多了一个参数：内核按参数表拒绝，命令行在标准错误打印用法，退出码 1。

**退出码。** 动词和主人命令共用：

| 退出码 | 什么时候 |
| --- | --- |
| 0 | 答复了：没有拒绝，答复里没有任何问题 |
| 1 | 用法错误，含主人命令以 `usage` 拒绝；或出错，比如主人命令的 `run` 抛错。标准输出什么都没有，带 `--json` 也没有，说明在标准错误 |
| 2 | 拒绝：结果是 `refused`，或说的结果是 `not-heard` 且理由是 `refused`。有拒绝时不看问题 |
| 3 | 没有拒绝，但答复里有问题：哪个插件的都算，也算这台机器载不了的插件 |

插件这样选退出码：拒绝就答 `refused`，得 2；做成了但有一步没成就答 `problems`，得 3；钩子抛错也得 3，主人命令的 `run` 抛错得 1。

### 3.5 旁听和生命周期

| 钩子 | 什么时候被调 | 拿到的 | 抛错时 |
| --- | --- | --- | --- |
| `observe` | 两个面的每次操作结束时，接受、拒绝、失败都调，按配置次序 | 一个事件 | 列成那次操作的答复里这个插件的问题 |
| `onPurged` | `archive purge` 删了东西之后；什么都没删就不调 | 被删的库内路径，都是 `_archive/…` | 列在 `archive purge` 的答复里 |
| `onAdd` | `plugin add` 装上它、说明重拼之后，一次；已经装了的再 add 不调 | 上下文，`ctx.library` 里已经有它 | 列在 `plugin add` 的答复里，照样装上 |
| `onRemove` | `plugin remove` 卸下它之前 | 上下文 | 列在答复里，不拦 |

事件有两种。agent 面的是 `{ face: 'agent', verb, request, result }`：`request` 是调用方写的原样，`result` 是动词的结果，失败时是 `{ outcome: 'failed', message }`。主人面的是 `{ face: 'owner', command, args, destructive, readOnly, setup, result }`。主人命令结果里的 `data` 不在契约里，类型是 `unknown`：要知道清空了哪些、装卸了谁，用 `onPurged`、`onAdd`、`onRemove`，不读别人的 `data`。视图和条目面板不是操作，不发事件。

`plugin add` 的事件在库重新打开之后发，所以刚装上的插件听得到自己的 add；`plugin remove` 的事件发的时候它已经不在，听不到。没有这条命令、要库却没给库的主人命令，在开始之前就被拒绝，不发事件。不用指明库的六条内核命令（`plugin install`、`plugin uninstall`、`plugin list`、`secret set`、`secret list`、`secret remove`）没带库运行时也不发事件。

`onAdd` 可以答 `{ problems: [...] }`，比如目标连不上，装照样装上，答复里列出。`onRemove` 可以答 `{ refuse: <一句中文> }`，说为什么、先要做什么：`plugin remove` 就以 `plugin-refused` 拒绝，库不变；主人用 `plugin remove <名字> --anyway`（界面里是提示上的「仍然卸下」）照样卸下，答复复述那句话。主人总能卸下一个插件。

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

管理界面是 `pneuma-base view <库>` 打开的网页。看用视图，改用两个面：一个视图是一页带类型的块，界面只渲染块，不知道块来自哪个插件。插件有两处可以放块：

- 自己的页：在 `views` 里声明，在 `onView` 里答。`id` 必须以 `<插件名>.` 开头（检查：`names`）；`icon` 是一个 lucide 图标名；`nav` 为 `false` 的页不进导航，只能经链接到达；`filters` 是页上的选择，界面打开时把每个的 `default` 填进 `params`。
- 条目面板里的一节：任何一样东西在右侧面板打开时，内核按配置次序调每个插件的 `onItemView(路径)`，把答的 `{ title, blocks }` 拼在归档按钮之后、文件的事实之前；答 `null` 就没有这一节。路径上没有东西时照样调；东西只在归档区时，路径是 `_archive/…`；内核自己的文件不调。

`onView` 答 `{ title, subtitle, blocks, refresh? }`。它或 `onItemView` 抛错、答的不是一页或一节时，内核在那里放一块说明出错，并把问题列进答复。

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
  views: [{ id: PAGE, title: '大文件', icon: 'hard-drive', nav: true, filters: [{ name: 'top', label: '列几样', options: [{ value: '10', label: '10 样' }, { value: '50', label: '50 样' }], default: '10' }] }],
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

**第一级：带类型的块。** 样子统一，跟着浅色深色走，键盘能用。字段的类型都在 sdk 的 `Block` 里：

| 种类 | 必需的字段 | 可选的字段 | 用处 |
| --- | --- | --- | --- |
| `section` | `title`、`note`（文字或 `null`）、`count`（数字或 `null`）、`blocks`、`actions` | `collapse`：`open` 或 `closed`，这一节可以折起来，值是开始时的样子 | 分节；里面的块逐个核对 |
| `table` | `columns`（每列 `{ key, label }`）、`rows`（每行 `{ key, cells, link, actions }`，`cells` 按列的 `key` 给 `Cell`，`link` 可以是 `null`）、`empty` | 列的 `optional`：放不下时这一列先让开，后面的先让 | 记录表；没有行时只显示 `empty` |
| `fields` | `fields`（每项 `{ label, value }`，`value` 是 `Cell`） | | 字段组 |
| `list` | `items`（每项 `{ cell, note, actions }`，`note` 可以是 `null`） | | 列表；窄处要路径完整时用它，不用表格 |
| `timeline` | `entries`（每条 `{ at, title, lines, tag }`，`title` 是 `Cell`，`tag` 可以是 `null`） | 条目的 `actions` | 时间线 |
| `text` | `text`、`tone` | | 一段字 |
| `preview` | `path`（库内路径） | | 一个文件的预览 |
| `actions` | `actions` | | 一排按钮 |
| `empty` | `title`、`hint`（文字或 `null`） | | 空的状态 |
| `embed` | `url`（http 或 https）、`title`、`height` | | 库外的一个页面，放在沙箱框架里，带「在新标签页打开」 |
| `custom` | `entry`、`height`、`actions` | `data` | 插件自己画的页，见第二级 |

| 类型 | 字段 |
| --- | --- |
| `Cell` | `text`；可选 `mono`、`muted`、`tag`、`link`、`at`（这一格是一个时刻，界面按看的人的本地时间显示）、`icon`（lucide 图标名）、`href`（http 或 https 的地址，新标签页打开，放不下时从中间截短）、`copy: true`（复制 `href`，没有就复制 `text`） |
| `Tag` | `{ text, tone }`，`tone` 是 `neutral`、`good`、`warn`、`bad`、`info` |
| `Link` | `{ view, params, target }`：打开一个视图，`target` 是 `main`（主区）或 `panel`（右侧面板）。条目面板是视图 `item`，参数 `path` |
| `Action` | `{ label, tone, confirm, inputs, call }`：`tone` 是 `default` 或 `danger`；`confirm` 是点了之后先问的一句话，或 `null`；人点了确认，就是破坏性命令要的当面确认 |
| `ActionInput` | `{ name, label, placeholder, value, options }`；可选 `multiple`（一行一个值）、`pattern` 和 `hint`（不匹配时表单不提交，`hint` 变红）、`secret: true`（输入时不显示） |
| `Call` | `{ face: 'agent', verb, request }`，`request` 是那个动词的请求；或 `{ face: 'owner', command, args: { positional, flags }, stdin? }`。字符串里的 `{输入名}` 换成那个输入的值；正好是 `{输入名}` 的列表元素，`multiple` 的输入一行换成一个元素 |

带参数的主人命令的表单用 sdk 的 `formOf(命令, { fixed, values, choices })` 生成：每个参数一个输入，`fixed` 里的不问，直接写进 `Call`。没有输入、没有 `confirm` 的动作，点了就做。

- 插件给的每一块都必须合 sdk 的类型（检查：`blocks`）。内核逐块核对：种类不认识、缺了必需的字段、类型不对、`embed` 的地址不是 http 或 https、`custom` 的 `entry` 爬出 `ui` 目录或插件没有 `ui`、输入的 `pattern` 不是正则，这一块换成一段说明出错的文字，记成插件的问题，页的其余部分照常。
- 能用第一级的块说的，就用第一级。样子、深浅色、键盘、窄屏都由界面管。

**第二级：`custom` 块，插件自己画的页。** 第一级说不出的，比如一条小图、一格里两个标签，插件画自己的页：

- `entry` 是插件 `ui` 目录里的相对路径。`ui` 是插件对象上的绝对路径，插件自己设，比如 `fileURLToPath(new URL('./ui/', import.meta.url))`；内核不替它设。
- 界面把页放进 `<iframe sandbox="allow-scripts">`，地址是 `/plugin-ui/<插件名>/<entry>`，开始时 `height` 高，之后跟着页报的高度，最高 4000。地址不带令牌，载入时不发 Referer，所以页调不了界面的接口。
- 页载入 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css`，这两个文件由界面的服务给出。`frame.css` 用和界面相同的变量（`--surface`、`--ink`、`--accent` 等）铺好底，带字体和这些类：`card`、`btn`、`btn-primary`、`btn-danger`、`tag`、`tone-good`、`tone-warn`、`tone-bad`、`tone-info`、`field`、`field-area`、`select`、`segmented`、`link`、`muted`、`faint`、`mono`。页跟着浅色深色走，不用写自己的颜色。
- `frame.js` 给出 `pneuma.onData(回调)`：回调收到 `(data, { scheme, actions })`，现在一次，以后每次重取视图、换配色再一次；`pneuma.run(名字, 值)`：要界面做块里叫这个名字的动作；`pneuma.open(链接)`：打开一个 `Link`，或在新标签页打开一个 http 或 https 地址的字符串。它还自己报告高度。

页和界面之间只有这几种消息，别的消息、别的来源的消息都不理：

| 方向 | 消息 | 什么时候 |
| --- | --- | --- |
| 界面到页 | `{ pneuma: 1, type: 'data', data, scheme, tokens, actions }` | 页发来第一条消息之后，每次重取视图、换配色。`actions` 只有每个动作的 `label`、`tone`、`inputs`，没有 `call` |
| 页到界面 | `{ pneuma: 1, type: 'run', name, values }` | 要做块里叫 `name` 的动作 |
| 页到界面 | `{ pneuma: 1, type: 'open', link }` 或 `{ pneuma: 1, type: 'open', href }` | 打开一个视图，或一个库外的地址 |
| 页到界面 | `{ pneuma: 1, type: 'height', height }` | 内容高度变了 |

页要做的动作走和按钮完全一样的路：同一个对话框问这个动作的 `confirm`，表单里先填好页给的值（只取动作声明了的输入），同样经两个面分派，同样有结果提示和重取。页拿不到 `Call`，所以跑不了块没声明的动作。这样「破坏性的要当面确认」「每次操作留痕」仍然只在两个面的入口守：页只是另一种按钮。

页 5 秒内没发第一条消息，比如文件不在、载入失败、没载 `frame.js`，那一块换成一段说明，写出插件名和 `entry`，页的其余部分照常。沙箱为的是隔离样式和崩溃，不是防插件：插件的 `index.js` 本来就在本机以主人的身份跑。上面 `sizes` 的 `ui/bars.html` 可以是：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="/plugin-kit/frame.css" />
    <script src="/plugin-kit/frame.js"></script>
    <style>
      .bar { height: 6px; margin: 6px 0; border-radius: 3px; background: var(--accent); }
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
          return bar
        }))
      })
    </script>
  </body>
</html>
```

- `custom` 块指向的页必须在插件的 `ui` 目录里，取得到（检查：`blocks`）。

**重取。** 界面重取一个视图只在这几种时候：库的摘要变了（界面每 2 秒问一次服务，摘要是库目录下每个名字、大小、修改时间，含 `.pneuma-base/`）；做完一个动作；视图的答复带 `refresh: <秒>` 时每隔这么久，少于 5 秒按 5 秒；连不上服务之后又连上时。

- 视图和条目面板里的一节不得写任何东西（检查：`writes`）。视图不是操作：写了库里的东西，摘要就变，界面每 2 秒重取一次，没完没了。
- 视图可以读库外的东西，比如部署目标上的状态。这样的视图必须在答复里带 `refresh`：库外的变化不会改库的摘要，没有 `refresh` 界面就不知道要重取。
- 视图答复里的 `refresh` 必须是数字。不是数字的被去掉，记成问题。

### 3.7 记自己的东西

插件名下的目录是 `<库>/.pneuma-base/<插件名>/`，钩子里是 `ctx.dir`。钩子运行时它一定在：内核每次打开库时为每个已装、能运行的插件建好它，同步过来的库也一样。

- 插件不得往库里自己名下的 `.pneuma-base/<插件名>/` 以外的地方写（检查：`writes`）。库的内容归主人和 agent，内核的文件归内核，别的插件的目录归别的插件。
- 主人命令要改库的内容，必须经 `ctx.tools.put`，不得直接写内容区的文件。经它放入，行动者和会话是这次操作的，每个插件都听到，还留下事件。
- 六个动词的钩子不得改内容，经 `tools.put` 也不行（检查：`writes`）。agent 的一次放、找、看只该改它自己说的那样东西。
- 自己目录里已有的文件不得改写、不得删（检查：`writes`）。例外是声明为缓存的目录，和整份替换的配置文件；符合性检查的 `configuration` 选项列出后者。
- 插件必须在 `storage` 里声明自己目录下的每个目录是本体（`body`）还是缓存（`cache`），`dir` 相对自己的目录，`.` 是它本身。本体跟着库走、被同步；缓存删了能重建。
- 缓存删掉不得丢任何东西（检查：`cache`）：删掉本机的缓存目录和声明为缓存的目录前后，找、看、查答得一样。
- 读到不认识的内容，原样留着。另一台机器上更新的版本写的记录，旧版本读不懂也不得删。

**记录只新增，不改写。** 一个库同时有几个写入者：几个 agent 的会话、主人在界面里、几台机器。同步工具还会把另一台机器写的文件整个搬过来。两处改同一个文件，一处的改动会丢；每次写一个新的、名字唯一的文件，几处写的合在一起就是并集，什么都不丢。sdk 的 `recordStore` 就这样写：每次 `append` 一个新文件，一行一个 JSON 对象，先写临时名再用不覆盖的方式换上名字。读的时候按编号排序，编号按时间、写入者、写入者内的次序排。

**配置整份替换。** 配置不是记录：最后一次写的算数。sdk 的 `configFile` 先写临时名再改名换上，没有人读到写了一半的文件。

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

**库外的缓存。** `ctx.cacheDir` 是 `$PNEUMA_BASE_HOME/cache/<库的 id>/<插件名>/`，在库外，因为同步工具会同步整个库，而索引这类文件经不起同步。内核不建它，插件第一次用时自己建（`mkdir(ctx.cacheDir, { recursive: true })`）；也没有谁清理它。

**密钥。** 令牌这类凭证不得放进库：库会被同步、会给别的 agent 看。插件在 `secrets` 里声明它读的密钥，各带一句中文说明，用 `ctx.secrets.get(名字)` 读，没设是 `null`。主人在这台机器上设，值从标准输入读，在终端里不回显地问，从不取命令行参数；值放在 `$PNEUMA_BASE_HOME/secrets/<插件名>/<密钥名>`，只有用户能读。管理界面的配置页列出每个声明了的密钥设没设，带设它的表单。插件只读得到自己的密钥。以自带的 `search` 插件为例：

```sh
printf %s 'sk-例子' | pneuma-base secret set search key
pneuma-base secret list search
pneuma-base secret remove search key
```

`plugin remove` 卸下插件后，它名下的目录原样留着；`plugin uninstall` 从这台机器卸掉它后，它的密钥原样留着。

## 4. 上下文给你的

每个钩子和主人命令的 `run` 都收到一个 `PluginContext`：

| 字段 | 是什么 |
| --- | --- |
| `library` | 这次操作的库：`root`（绝对的真实路径）、`config`（`id`、插件名的列表、授权）、`plugins`（装了、这台机器载得了的插件，按配置次序）、`unavailable`（装了、载不了的名字）、`clashes`（撞名没接上的） |
| `actor` | 谁在做：`{ kind: 'agent', name, grant }` 或 `{ kind: 'owner' }`。带授权时是授权给的 agent；写了 `--as <名字>` 时是那个名字；环境里有 `CLAUDE_CODE_SESSION_ID` 或 `CLAUDECODE` 时是 `claude-code`，有 `CODEX_THREAD_ID` 时是 `codex`，有 `ANTIGRAVITY_CONVERSATION_ID` 或 `ANTIGRAVITY_AGENT` 时是 `antigravity`；都没有是主人。只有 `PNEUMA_BASE_SESSION` 时行动者是主人，但主人命令的门照样拒绝（3.4）。界面里总是主人。类型里还有 `{ kind: 'plugin', name }`，今天的内核不给 |
| `session` | 这次会话：`id` 依次取 `--session`、环境变量 `PNEUMA_BASE_SESSION`、`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`，都没有就为这次调用造一个，`source` 相应是 `flag`、`env`、`minted`；`cwd` 是调用方的工作目录，界面里是服务进程的；`machine` 是主机名；`transcript` 今天总是 `null` |
| `now` | 这次操作的时刻，ISO 8601 |
| `home` | 本机的 `$PNEUMA_BASE_HOME`，缺省 `~/.pneuma-base` |
| `dir` | 插件在库里名下的目录，钩子运行时一定在（3.7） |
| `cacheDir` | 插件在库外的缓存目录，内核不建（3.7） |
| `secrets` | `get(名字)`：主人在这台机器上给它设的密钥（3.7） |
| `tools` | 内核的工具，绑在这次操作的库上，见下表 |

主人命令里写的相对路径，按 `ctx.session.cwd` 解析。

`ctx.tools` 的工具都是正在跑的内核自己的代码，所以一个带标记的目录算哪些文件、指纹怎么算、找怎么切词排序，插件和内核永远一样。路径都是库内路径，除非写明绝对：

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
| `put(请求)` | 经 agent 面放入，行动者和会话是这次操作的：每个插件都听到，它发自己的事件 |

带标记的目录是库里的「一样东西」：目录里有一个 `.pneuma-item` 文件。它只能整体地变，算指纹时不算标记文件和任何一层的 `.git`、`node_modules`、`.DS_Store`。

`tools.put` 走完整的放，所有插件的 `onPut` 都会再被调，包括调它的插件自己；内核不防重入（第 9 节）。

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

## 5. 开发包里的库

`@pneuma-base/sdk/kit` 是插件打进自己包里的库，不是插件：插件导入它不算插件导入插件。它不导入内核，对库的读写都经上下文的 `tools`。

| 导出 | 做什么 |
| --- | --- |
| `recordStore(目录, parse)` | 只新增文件的记录库（3.7）。`stamp(ctx, 内容)` 盖上 `id`、`at`、`actor`、`session`，还不写；`append(记录)` 把几条写成一个新文件；`read()` 答 `{ records, skipped }`，`skipped` 是读不懂的行，原样留在文件里。`parse` 收到一行的对象，答内容，或一句为什么不是 |
| `configFile(绝对路径, parse)` | 整份替换的配置文件（3.7）。`read()` 没有文件时 `null`，不是 JSON 或 `parse` 抛错时抛错；`write(值)` 先写临时名再改名 |
| `deployPlugin(名字, 目标, 选项)` | 给一个插件名和一种或几种目标，交回一个完整的部署插件 |
| `defineTarget(目标)` | 写一种目标，`configure` 收到按开关定好类型的值 |
| `siteName`、`want`、`plan`、`statusOf` | 部署库的决定，纯函数：缺省的站点名，目标上该有什么，要做的几步，状态 |

### 部署库

部署库替你做所有和目标无关的：agent 用 `say deployable <库内路径> [一句话]` 声明一样东西可以部署，声明不让它上线；主人用开关决定它在不在线；开着的东西，目标上跟着库里当前的内容，放入、挪、归档、取回之后都对一遍。记录、主人命令、页面、条目面板里的一节、认知段都是它的。一个部署插件只写它的目标。

它给的主人命令，`<名字>` 是插件名：

| 命令 | 门 | 做什么 |
| --- | --- | --- |
| `<名字> on <库内路径>`、`<名字> off <库内路径>` | `ownerOnly` | 打开或关上开关，并发布或下线 |
| `<名字> target set [--kind <kind>] <目标的开关>` | `ownerOnly`、`setup` | 配目标；只有一种目标时可以不写 `--kind` |
| `<名字> sync` | 谁都能用 | 把全部声明过的东西对一遍 |
| `<名字> list` | `readOnly` | 列出声明过的东西、状态和地址 |

它的页是 `<名字>.sites`。它在自己目录下写 `config.json`（目标，整份替换）和 `facts/`（记录），都是本体；跑符合性检查时把 `config.json` 列进 `configuration`。所有部署插件都认领 `say deployable`，所以一个库里同时只装得上一个部署插件。

`deployPlugin` 的选项：`title`（给人看的名字，缺省「部署」）、`heading`（认知段的标题，缺省「上线：主人开关」）、`cognition`（加在它写的认知段后面的一段，说这个目标 agent 该知道的）、`icon`、`version`、`summary`、`ui`（目标加 `custom` 块时用）。

### 写一种新的目标

`TargetAdapter` 是一种目标，用 `defineTarget` 写：

| 字段 | 是什么 |
| --- | --- |
| `kind` | `target set --kind` 的值，随配置存下 |
| `label` | 发布到哪种地方，给人看：「一个本地目录」 |
| `params` | `target set` 在 `--kind` 之后的开关，一份 `FlagParam[]`。命令的参数表、帮助、页面上的表单和核对都从这里来 |
| `secrets` | 它读的密钥。部署库把它们声明成插件的密钥，`secret set` 和配置页就认得 |
| `configure(值, ctx)` | 把核过的值变成要存的配置（一个 JSON 对象），或答 `{ ok: false, reason, text }` |
| `open(配置, env)` | 在边界上解析存下的配置，交回这一次钩子或命令用的 `Target`；读不懂就抛错。`env` 是 `{ ctx, scratch, secret }`：`secret(名字)` 读主人设的密钥，没设时以一句说明怎么设的错误拒绝 |

`Target` 是配好、打开了的一个目标：

| 字段 | 是什么 |
| --- | --- |
| `key` | 记录按它区分目标：换了 `key`，旧目标上的站点不再算 |
| `label` | 什么、在哪，一行给人看 |
| `publish(站点名, 目录, meta)` | 把目录发布成这个站点，换掉它原来的内容，答 `{ url }`。目录是部署库复制到缓存目录下的临时副本；`meta` 有内容编号、库内路径、时刻，和按路径的 UTF-8 字节排好的 `files` |
| `remove(站点名)` | 下线；下线一个它没在服务的站点不算错 |
| `siteName(路径)` | 可选，换掉缺省的站点名：库内路径小写，别的字符换成 `-`，路径不干净时加 sha256 的前 6 位，最长 58 个字符 |
| `identify(文件)` | 可选，内容的编号；没有就用内核的指纹 |
| `serving(站点名)` | 可选，这些站点里它现在真的在服务哪些、各是什么内容和地址。有它，部署库按目标报的对账，`<名字> sync` 修得好断在一半的发布和在目标那边被删掉的站点；它抛错时状态是「不知道」，什么都不做。没有它，按插件自己的记录对账 |
| `view` | 可选，往页面和条目面板里加列、字段和块，可以是 `custom` 块 |

一个往 HTTP 服务发布的目标：

```ts
import { readFile } from 'node:fs/promises'
import { defineTarget, deployPlugin, type Target } from '@pneuma-base/sdk/kit'

const httpTarget = defineTarget({
  kind: 'http',
  label: '一个收文件的 HTTP 服务',
  params: [{ name: 'url', hint: '服务地址', kind: 'value', required: true, pattern: 'https?://\\S+' }],
  secrets: [{ name: 'token', description: '服务的访问令牌，作为 Bearer 发出' }],

  async configure({ url }) {
    return { ok: true, config: { url: url.replace(/\/+$/, '') } }
  },

  open(config, env): Target {
    if (typeof config.url !== 'string') throw new Error('HTTP 目标的配置要写 url')
    const base = config.url
    const send = async (method: string, path: string, body?: Uint8Array) =>
      fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${await env.secret('token')}` }, ...(body === undefined ? {} : { body }) })
    return {
      key: `http:${base}`,
      label: `HTTP 服务 ${base}`,
      async publish(site, _dir, meta) {
        for (const file of meta.files) {
          const reply = await send('PUT', `/sites/${site}/${file.path}`, await readFile(file.abs))
          if (!reply.ok) throw new Error(`上传 ${file.path} 答复 ${reply.status}`)
        }
        return { url: `${base}/sites/${site}/` }
      },
      async remove(site) {
        const reply = await send('DELETE', `/sites/${site}`)
        if (!reply.ok && reply.status !== 404) throw new Error(`下线 ${site} 答复 ${reply.status}`)
      },
    }
  },
})

export default deployPlugin('webhost', httpTarget, { title: '网站托管', summary: '声明了可以部署的东西由主人开关上线，发布到一个 HTTP 服务。' })
```

`plugin new <目录> --kind deploy` 生成的项目就是部署库加一种发布到本地目录的目标，在 `src/target.ts` 里，换成真的目标就改那里：

```sh
pneuma-base plugin new ../site --kind deploy --packages ..
ls ../site/src
```

PneumaSpace 插件（`space`）就是这样写的：它的目标用 PneumaSpace 的管理接口发布，`identify` 用上传的包的 sha256 作内容编号，`serving` 问 PneumaSpace 真在服务什么，令牌声明成密钥 `token`，页面上用 `view` 加了几列和一个 `custom` 块。

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

`@pneuma-base/sdk/testkit` 跑真的命令行：插件项目依赖的 `pneuma-base` 包，或环境变量 `PNEUMA_BASE_CLI` 指的 `bin.js`。它有四样：

| 导出 | 做什么 |
| --- | --- |
| `sandbox(选项)` | 临时的家目录（`$PNEUMA_BASE_HOME`）和库，装上给的插件目录。选项：`plugins`（插件目录）、`builtins`（再加的自带插件）、`bare`（从 `init --bare` 开始）、`env`、`timeout`（每次调用的毫秒数，缺省 60000）、`cli`。它给出 `home`、`library`、`work`（调用的工作目录，要放进库的文件放这里）、`env`、`cli`；`run(参数)`、`owner(参数)`（主人，带 `--library`）、`agent(名字, 会话, 参数)`（带 `--as` 和 `--session`）交回 `{ code, stdout, stderr, json }`，`json` 是带 `--json` 时解析的标准输出；`viewer()` 起界面的服务；`cleanup()` 收尾 |
| `conformance(插件目录, 选项)` | 把这一节下面的检查都跑一遍，答 `{ plugin, ok, checks, reminders, text }`，从不因为查出问题而抛错。`text` 是给人读的报告：哪项不通过、哪里不对、规则是什么，最后是查不了、要自己看的提醒 |
| `findCli(cli?)` | 测试用哪个命令行：给的，`PNEUMA_BASE_CLI`，或插件项目依赖的 `pneuma-base` 包 |
| `examplesOf(认知段)` | 认知段里会被 `examples` 跑的那些命令 |

调用的环境从空的建起，只带 `PATH`、`TMPDIR`、`LANG` 这几样，所以没有任何 agent 产品的会话变量：`owner` 就是主人。每次调用的标准输入是关着的，有时限。`viewer()` 给出 `view(编号, 参数)`、`item(路径)`、`state()`、`act(动作, 值)`（像人填好表单、确认那样做一个动作）、`get(路径)` 和 `stop()`。

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
  const page = await (await sb.viewer()).view('marks.marks')
  assert.equal(page.outcome, 'shown')
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
| `plugin install <目录>` | 只有主人；不用指明库 | 按装载器的办法载入那个目录、过同样的核对，名字取插件自己写的；再复制到 `$PNEUMA_BASE_HOME/plugins/<名字>/`，先写临时名再换上。同名的换掉，答复说换了哪一版。自带插件的名字以 `built-in-name` 拒绝，过不了核对以 `plugin-failed-to-load` 拒绝，已装的那份不动 |
| `plugin uninstall <名字>` | 只有主人；不用指明库 | 从这台机器卸掉。带 `--library` 而那个库还装着它时以 `still-installed` 拒绝；这台机器上别的装着它的库会报它载不了 |
| `plugin list` | 谁都能用；不用指明库 | 自带的和装上来的，各带版本、契约、一句说明，载不了的带原因；带 `--library` 时标出那个库装了哪些 |
| `plugin add <名字>` | 只有主人 | 在库里启用，从自带的和这台机器装上来的里找。名字被已装的插件占着时以 `name-taken` 拒绝 |
| `plugin remove <名字> [--anyway]` | 只有主人 | 在库里停用，它名下的目录原样留着；插件的 `onRemove` 拒绝时要 `--anyway` |

```sh
pneuma-base plugin install dist
pneuma-base plugin list --library ../lib
pneuma-base plugin remove marks --library ../lib
pneuma-base plugin uninstall marks
```

改了就重新载入：装载器按插件目录里每个文件的名字、大小、修改时间算一个戳，目录里任何文件变了，下一次载入就用新的。命令行每次调用都载入一次，界面的服务每次请求都载入一次，所以 `npm run install-local` 之后，开着的管理界面在下一次请求就用新代码，不用重启。

这台机器载不了一个装了的插件时（导入时抛错、缺 `index.js`、过不了核对），它不进插件表，装了它的库在每个答复的问题里列出它和原因。

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
- 主人命令的答复带一个指向视图的链接。今天只有 `offer` 一个动作。
- 钩子里调 `tools.put` 的重入。内核不拦，也不防插件自己的 `onPut` 被再调一次。
- 几个进程同时跑同一个插件的钩子时的锁。内核不提供锁；`recordStore` 的写不会互相覆盖，`configFile` 最后一次写的算数。
- 谁清理 `ctx.cacheDir`。`plugin remove` 和 `plugin uninstall` 都不动它。

## 附：试做时的 55 条摩擦各自的去处

这份规范之前，有人在仓库外按当时的契约写了一个把网站部署到 PneumaSpace 的插件，记下 55 处「得去读源码才知道」「只能照抄」「做不到」。下表是每一条现在的去处，按今天的代码。

| 编号 | 摩擦 | 现在 |
| --- | --- | --- |
| C1 | 没有类型包，契约要手抄 | 解决：`@pneuma-base/sdk` 包文件，声明文件自成一体；钩子是函数类型的属性，严格检查 |
| C2 | 不能声明按哪一版契约写的 | 部分解决：`contract` 必填，装载时核对，不认识的版本说明原因（第 2 节）。声明要哪一版 pneuma-base 或 Node 还没有（第 9 节） |
| C3 | 上下文没有库的工具，只能抄内核 | 解决：`ctx.tools`（第 4 节） |
| C4 | 主人命令的参数是生的，个数由命令行定 | 解决：参数表 `params`，命令行、核对、帮助、表单都从它来（3.4） |
| C5 | 「说」的种类先到先得，没有提示 | 解决：`plugin add` 和 `init` 以 `name-taken` 拒绝；已有的撞名记成问题（3.3） |
| C6 | 只能靠抛错说「做了，但外面那步没成」 | 解决：`onPut`、`onArchive`、`onSay` 的答复可以带 `problems`（3.2） |
| C7 | 认 `archive purge` 要比命令名 | 解决：`onPurged`（3.5） |
| C8 | 插件听不到自己被卸下 | 解决：`onAdd`、`onRemove`，后者可以拒绝，主人可以 `--anyway`（3.5） |
| C9 | 凭证没地方放 | 解决：每台机器的密钥，`ctx.secrets`，`secret set`（3.7） |
| C10 | 小缺口：`PluginName` 造不出来、`ctx.dir` 在不在、面板的节不能按需加载 | 部分解决：`pluginName()` 在 sdk 里，`ctx.dir` 一定在（3.7）；按需加载没有（第 9 节） |
| K1 | 决定、计划、状态只能照抄 | 解决：开发包导出 `want`、`plan`、`statusOf`、`siteName`，内容编号可由目标的 `identify` 给（第 5 节） |
| K2 | 只新增的记录库只能照抄 | 解决：`recordStore`（3.7、第 5 节） |
| K3 | 声明的生命周期只能照抄 | 解决：`deployPlugin` 管声明，跟着挪、归档、取回、清空（第 5 节） |
| K4 | 对账的循环只能照抄 | 解决：`deployPlugin` 的对账；目标有 `serving` 时按目标真在服务的对账（第 5 节） |
| K5 | 给 agent 和主人的话只能照抄 | 解决：话在 `deployPlugin` 里，命令名换成插件名 |
| K6 | 四条主人命令只能照抄 | 解决：`deployPlugin` 生成开关、`sync`、`list`、`target set`，`target set` 的开关来自目标的 `params`（第 5 节） |
| K7 | 页面和条目面板的一节只能照抄 | 解决：`deployPlugin` 的页和一节，目标用 `view` 加列、字段和块（第 5 节） |
| K8 | 目标配置的读写只能照抄 | 解决：`configFile`（3.7） |
| B1 | 没有脚手架 | 解决：`plugin new`（第 1 节） |
| B2 | 工具链要联网 | 部分解决：运行时的依赖由构建打进 `index.js`；`npm install` 仍要从网上装 esbuild、typescript、@types/node |
| B3 | 插件目录里能放什么没有规定 | 解决：目录的布局、`plugin install` 核对再复制（第 8 节）。从 `.tgz` 装没有做 |
| B4 | 装就是复制文件，看不到版本，不重载 | 解决：`plugin list` 和装的答复显示版本，文件变了下一次载入就用新的（第 8 节） |
| B5 | 不构建就跑 TypeScript 测试要自己摸索 | 解决：脚手架带着这套设置 |
| B6 | 没有对着真库测试的工具 | 解决：`@pneuma-base/sdk/testkit`（第 7 节） |
| B7 | 没有装好的命令行可以测 | 解决：`pneuma-base` 包文件，测试工具找它（第 7 节）。不发布到 npm |
| P1 | 地址不能是链接 | 解决：`Cell` 的 `href`（3.6） |
| P2 | 窄的时候网址被截掉后半 | 解决：放不下时从中间截短，`copy` 复制（3.6） |
| P3 | 没有线上的预览 | 解决：`embed` 块（3.6） |
| P4 | 时间线的条目不能带动作 | 解决：条目的 `actions`（3.6） |
| P5 | 一格里没有小图 | 不加进块；用 `custom` 块自己画（3.6） |
| P6 | 一格只有一个标签 | 不加进块；用 `custom` 块自己画（3.6） |
| P7 | 没有指向视图的链接 | 部分解决：打开的视图和面板记在地址的片段里（`#view=…`）；主人命令的答复带视图链接没有（第 9 节） |
| P8 | 联网的页每 2 秒被问一次 | 解决：只在库变了、做完动作、`refresh` 到了时重取（3.6） |
| P9 | 表单的输入不能校验 | 解决：输入的 `pattern`、`hint`，`formOf` 从参数表生成（3.6） |
| P10 | 慢的动作说不清进度和结果 | 没有解决（第 9 节） |
| D1 | 认知段能用哪些占位，各变成什么 | 回答：3.1 |
| D2 | 主人命令的事件里哪些数据可以依赖 | 回答：3.5，`data` 不在契约里，用专门的钩子 |
| D3 | 哪个钩子拿到解析过的路径，次序如何 | 回答：3.2 |
| D4 | 退出码 | 回答：3.4 |
| D5 | 两个插件认领同一个种类时怎样 | 回答：3.3 |
| D6 | 谁算 agent | 回答：3.4 |
| D7 | 视图的答复怎样核对 | 回答：3.6 |
| D8 | 视图能不能读库外、时限、频率 | 回答：3.6；时限和频率上限没有规定（第 9 节） |
| D9 | 插件目录的布局和重载 | 回答：第 8 节 |
| D10 | 装载时核对什么 | 回答：第 2 节 |
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
