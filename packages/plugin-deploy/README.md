# 部署插件 `deploy`

把库里的网站发布到部署目标。主人在应用的设置页打开「部署」，在它的页上连接一个部署目标，再把自己的一样目录东西发布；agent 用 `say deployable <库内路径>` 声明一样东西可部署，是否发布由主人决定。开着的东西，部署目标上跟着库里现在的内容。

## 在页上

**没连。** 「部署目标」一节。这台机器装过的 PneumaSpace 各一行，按「连接」就连接，不用填什么。「其他 PneumaSpace」的「连接…」：选 Cloudflare（地址、账户、账户密钥）或自托管（地址）。本地文件夹和自定义命令在这一节的菜单里。

**连着。** 页头「发布条目」：从库里登记过的目录东西里选一样，它就发布。下面一行是连着的部署目标，菜单里有「更换部署目标…」「应用名称前缀…」（PneumaSpace）和「断开连接」。再下面每样东西一行：名字（点开是面板）、所在的文件夹、地址、开关。关上开关就取消发布。

**不对劲时。** 一行带一个标记，悬停说为什么：待发布（开着，部署目标上不是库里现在的内容）、待取消发布、条目缺失（库里那个路径上没东西了）、状态未知（连不上部署目标）、名称已被占用（PneumaSpace 上同名的应用不归这个库）。有东西待发布或待取消发布时页头有「重试」。

**面板。** 一样东西的面板里：标记和原因、地址，PneumaSpace 的访问次数和最近访问、发布历史；开关在面板的菜单里。没发布过的目录东西，面板的菜单里有「发布…」。

## 四种部署目标

| 类型 | `--kind` | 连接要什么 | 地址 |
| --- | --- | --- | --- |
| Cloudflare（PneumaSpace） | `cloudflare` | 这台机器装过的（`--host`），或凭据文件（`--credentials`），或地址、账户和账户密钥 | `<地址>/apps/<应用名>/` |
| 自托管（PneumaSpace） | `self-hosted` | 管理地址（`--admin`）；不在本地模式时另设 `secret set deploy token` | PneumaSpace 给的 |
| 本地文件夹 | `folder` | 目录（`--to`），不在库里，也不包含库 | `file://` |
| 自定义命令 | `command` | 发布命令和取消发布命令，`{dir}`、`{name}` 换成内容的复制件和站点名 | 地址模板里的 `{name}` 换成站点名 |

- **这台机器装过的 PneumaSpace**：`~/.pneuma-space/hosts/<主机>/owner.json`。连接时只记主机名，每次发布都从那个文件重新读账户密钥。
- **账户密钥**：页上的对话框里填，或在终端里不显示地输入。连接之前登录一次核对，不对就什么都不存；对了才存成这台机器上的密钥（`deploy` 的 `key`），不进库、不进记录、不进答复。
- **应用名称**：`<前缀>-<站点名>`，长于 40 个字符时截短并带上路径的摘要。前缀缺省取库文件夹的名字，连接之后可以在菜单里改（「应用名称前缀…」）；改了，开着的东西成待发布，「重试」以新名字发布、取消发布旧名字。
- PneumaSpace 的两种问它在服务什么，所以发布断在一半、或应用在 PneumaSpace 上被撤下，「重试」补得回来；内容没变不上传。取消发布不清除：发布历史都在，再打开就回来。名字被别的库、别的管理者或别的账户占着时不碰它。
- 本地文件夹：先复制到 `.tmp-` 开头的名字再换上，另写一个 `index.json` 列出已发布的站点。自定义命令：按引号规则切词，不经 shell 运行，工作目录是内容的复制件（取消发布时是一个空目录），超时缺省 120 秒。这两种不报告自己在服务什么，「目标上有什么」来自插件自己的记录。

## 发布之前就拒绝的

- 两种 PneumaSpace：站点顶上没有 `index.html`。
- Cloudflare：一个网站最多 256 个文件，打包之后最多 4 MiB（文件按 base64 打进包里，网站本身大约 3 MiB 就到顶）；每个应用一生最多上传 200 次，包合计不超过分到的存储（缺省 10 MiB）。内容回到以前发布过的样子时放回那一版，不上传。
- Cloudflare 上的网站只有登录了那个 PneumaSpace 的账户看得到，所以面板里没有预览；它不让一台机器十分钟里登录超过 40 次，所以页面每分钟才重取一次。

## 命令

页上的每个按钮都是一条命令，`pneuma-base show deploy.sites` 印出它们。

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `deploy publish <库内路径>` | 只有主人 | 发布；没声明过的先记声明 |
| `deploy unpublish <库内路径>` | 只有主人 | 取消发布 |
| `deploy target set --kind cloudflare --host <主机>` | 只有主人 | 连接这台机器装过的 PneumaSpace |
| `deploy target set --kind cloudflare (--credentials <凭据文件> \| --origin <地址> --account <账户>) [--prefix <应用名称前缀>]` | 只有主人 | 连接其他 Cloudflare 上的 PneumaSpace；没有凭据文件时读账户密钥 |
| `deploy target set --kind self-hosted --admin <地址> [--prefix <应用名称前缀>] [--public <站点公开地址>]` | 只有主人 | 连接自托管的 PneumaSpace |
| `deploy target set --kind folder --to <目录>` | 只有主人 | 连接本地文件夹 |
| `deploy target set --kind command --publish <发布命令>… --unpublish <取消发布命令>… [--url <地址模板>] [--timeout <超时秒数>]` | 只有主人 | 连接自定义命令 |
| `deploy target list` | 主人和 agent | 连着的，和这台机器上找到的 |
| `deploy target remove` | 只有主人 | 断开连接；已发布的不取消发布，开关都留着 |
| `deploy sync` | 主人和 agent | 把全部声明过的东西对一遍 |
| `deploy list` | 主人和 agent | 声明过的东西、状态和地址 |

## 存放

都在 `.pneuma-base/deploy/` 下：`config.json` 是连着的部署目标和主人给的开关（`{ "format": 1, "target": { "kind": …, … }, "given": { … } }`，`cloudflare` 存 `host` 或 `credentials`、`origin`、`account`、`prefix`、`tenant`，`self-hosted` 存 `admin`、`prefix`、`public`，`folder` 存 `to`，`command` 存它的命令，从不存密钥）；`facts/` 是部署库的记录。记录按部署目标区分：`pneuma-space-cf:<地址>`、`pneuma-space:<管理地址>`、`dir:<目录>`、`command:<发布命令的参数表>`。改名之前存下的 `kind`（`machine`、`dir`）照样读作 `self-hosted`、`folder`，文件不改写；`dir:` 的键也没有改，所以以前的记录照样算数。

插件是 sdk 的部署库加四种目标：`deployPlugin('deploy', [cloudflareTarget, selfHostedTarget, folderTarget, commandTarget])`（`src/index.ts`）。决定、状态、状态 × 操作的表、站点名、记录、命令和页面是部署库的，见 `packages/sdk/src/kit/deploy/README.md`。

## 测试

`test/` 里的测试用替身（`fake-cloudflare.ts`、`fake-space.ts`）和临时家目录，不连真的服务；本地文件夹的符合性检查在 `packages/cli/test/conformance-deploy.test.ts`，页上的整条路在 `packages/viewer/e2e/deploy.spec.ts`。要真服务的只在设了环境变量时跑：`SPACE_ADMIN=<管理地址>` 跑自托管的生命周期和页面测试（`lifecycle.test.ts`、`viewer.test.ts`），`PNEUMA_SPACE_CF_CREDENTIALS=<凭据文件>` 跑 Cloudflare 上的真实生命周期（`cloudflare-live.test.ts`）。它们建的应用都叫 `pbs-…`，结束时撤下并清除。
