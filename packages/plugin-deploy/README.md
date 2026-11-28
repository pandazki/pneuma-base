# 部署插件 `deploy`

agent 用 `say deployable <库内路径>` 声明一样东西可以部署；主人用 `deploy on` / `deploy off` 开关决定它在不在线；开着的东西，目标上跟着库里当前的内容。

这个插件是 sdk 的部署库加四种目标：`deployPlugin('deploy', [cloudflareTarget, machineTarget, dirTarget, commandTarget])`（`src/index.ts`）。一个决定、状态、状态 × 操作的表、站点名、记录、命令和页面都是部署库的，见 `packages/sdk/src/kit/deploy/README.md`；这里只写四种目标：PneumaSpace 的两种（`src/cloudflare.ts`、`src/machine.ts`，共用应用名 `src/name.ts`、页面上的列和面板 `src/views.ts`、看板 `ui/board.html`），本地目录和命令（`src/targets.ts`）。

## 目标

`deploy target set --kind cloudflare|machine|dir|command …` 选一种，一个库同时只发到一处。每种目标的开关各是一份参数表（`params`），命令行、帮助和页面上的表单都从它来。

- `cloudflare`：Cloudflare 上的 PneumaSpace，用主人的账户登录它的控制接口发布（`src/control.ts`）。`--credentials <凭据文件>` 给 PneumaSpace 安装器写的 JSON（`origin`、`account`、`key`），或者用 `--origin`、`--account` 写出来、密钥另设 `secret set deploy key`。密钥从不存进库：没设密钥时每次发布从凭据文件读。每次运行登录一次、用完退出。
- `machine`：一台机器上的 PneumaSpace（Docker），用它的管理地址 `--admin` 发布（`src/space.ts`）；不在本地模式时设 `secret set deploy token`。站点的地址不是管理地址的主机时用 `--public` 写出来。
- `dir`：`<目录>/<站点名>/…`，加一个 `<目录>/index.json`，列出在线的站点、指纹和库内路径。先复制到 `.tmp-` 开头的名字再改名换上。目录不能在库里，也不能包含库。地址是 `file://` 的。
- `command`：主人配一条发布命令和一条下线命令，`{dir}`、`{name}` 换成内容目录和站点名（下线时 `{dir}` 是一个空目录）。命令按 shell 的引号规则切成参数，不经 shell 运行；工作目录就是 `{dir}`（发布时是内容的复制件，下线时是那个空目录），不在库里；超时缺省 120 秒。可以配地址模板，比如 `https://{name}.pages.dev`。

PneumaSpace 的两种要 `--prefix`：每个应用叫 `<前缀>-<站点名>`，长于 40 个字符时截短并带上路径的摘要。它们向 PneumaSpace 问它在服务什么，所以发布到一半断了、或应用在 PneumaSpace 上被撤下，`deploy sync` 补得回来；内容的标识是包的摘要（Cloudflare）或 bundle 的 sha256（一台机器），内容没变不上传。撤下不清除：发布记录都在，再打开就回来。名字被别的库、别的管理者或别的空间占着时不碰它，页面写出是谁的。`dir` 和 `command` 不报告自己在服务什么，「目标上有什么」来自插件自己的记录，用的是缺省的站点名和存储给的指纹。

## Cloudflare 上的 PneumaSpace 的限制

插件在发布之前就按它们拒绝，说出数字和上限：

- 一个网站最多 256 个文件；打包之后最多 4 MiB（文件按 base64 打进包里，网站本身大约 3 MiB 就到顶）。
- 每个应用一生最多上传 200 次，上传的包合计不超过这个应用分到的存储（默认 10 MiB）。内容回到以前发布过的样子时直接放回那一版，不上传。
- 只给登录了那个 PneumaSpace 的账户看，所以页面上没有预览，只有地址；PneumaSpace 不让一台机器十分钟里登录超过 40 次，所以页面每分钟才重取一次。

## 存放

都在 `.pneuma-base/deploy/` 下，本体：

| 路径 | 内容 |
| --- | --- |
| `config.json` | 目标：`{ "format": 1, "target": { "kind": …, … } }`，`cloudflare` 存 `origin`、`account`、`prefix`、`credentials`（凭据文件的路径）、`tenant`，`machine` 存 `admin`、`prefix`、`public`，`dir` 存 `to`，`command` 存 `publish`、`unpublish`、`url`、`timeout`。不存密钥 |
| `facts/` | 部署库的记录 |

记录按目标的标识区分：`pneuma-space-cf:<控制地址>#<前缀>`、`pneuma-space:<管理地址>#<前缀>`、`dir:<目录>`、`command:<发布命令的参数表>`。

## 命令

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `deploy on <库内路径>` | 只有主人 | 打开开关并发布 |
| `deploy off <库内路径>` | 只有主人 | 关上开关并下线 |
| `deploy target set --kind cloudflare (--credentials <凭据文件> \| --origin <控制地址> --account <账户>) --prefix <前缀>` | 只有主人 | 配 Cloudflare 上的 PneumaSpace |
| `deploy target set --kind machine --admin <管理地址> --prefix <前缀> [--public <公开地址>]` | 只有主人 | 配一台机器上的 PneumaSpace |
| `deploy target set --kind dir --to <目录>` | 只有主人 | 配本地目录目标 |
| `deploy target set --kind command --publish <发布命令>… --unpublish <下线命令>… [--url <地址模板>] [--timeout <超时秒数>]` | 只有主人 | 配命令目标；一条命令可以加引号写成一个值，也可以不加引号写成几个词 |
| `deploy sync` | 主人和 agent | 把全部声明过的东西对一遍 |
| `deploy list` | 主人和 agent | 列出声明过的东西、状态和地址 |

## 测试

`test/` 里的符合性检查（PneumaSpace 的两种各一遍）和 `cloudflare.test.ts` 用内存里的替身（`fake-cloudflare.ts`、`fake-space.ts`），不要真服务；本地目录的符合性检查在 `packages/cli/test/conformance-deploy.test.ts`。要真服务的只在设了环境变量时跑：`SPACE_ADMIN=<管理地址>` 跑一台机器上的生命周期和页面测试（`lifecycle.test.ts`、`viewer.test.ts`），`PNEUMA_SPACE_CF_CREDENTIALS=<凭据文件>` 跑 Cloudflare 上的真实生命周期（`cloudflare-live.test.ts`）。它们建的应用都叫 `pbs-…`，用自己的前缀，结束时撤下并清除。
