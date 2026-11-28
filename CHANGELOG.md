# 变了什么

写给用过早先构建的人：升级之后会遇到哪些不同，打开旧资料库时会发生什么。新的版本在前。

## 0.9.0（未发布）

### 改了名的命令、参数和取值

命令行不认旧名字，没有别名：输入旧的命令答「未知命令」，旧的参数答「不支持 --…」。资料库里用旧名字记下的记录和还没处理的请求照样读，按新名字算。

| 旧 | 新 |
| --- | --- |
| `grant issue` | `grant create` |
| `plugin add`、`plugin remove [--anyway]` | `plugin enable`、`plugin disable [--force]` |
| `plugin catch-up` | `plugin backfill` |
| `noise list`、`noise add`、`noise remove` | `ignore list`、`ignore add`、`ignore remove` |
| `put --brought`、`--made`、`--from-outside` | `put --imported`、`--generated`、`--from-external` |
| `find --origin brought`、`made` | `find --origin imported`、`generated` |
| `say doing`、`say decided`、`say from` | `say task`、`say decision`、`say basis` |
| `say from --from-outside` | `say basis --from-external` |
| `ledger held list`、`restore`、`drop` | `ledger copies list`、`restore`、`drop` |
| `ledger leave` | `ledger dismiss` |
| `ledger register --inside` | `ledger register --recursive` |
| `search embedder set`、`clear` | `search embedding set`、`clear` |
| `deploy on`、`deploy off` | `deploy publish`、`deploy unpublish` |
| `space on`、`off`、`sync`、`list`、`target set` | `deploy publish`、`unpublish`、`sync`、`list`、`target set` |
| `deploy target set --kind dir`、`sync target set --kind dir` | `--kind folder` |
| `space target set --kind machine` | `deploy target set --kind self-hosted` |

- MCP 工具的名字跟着命令改，比如 `ignore_list`、`plugin_backfill`、`ledger_copies_list`、`deploy_sync`。
- `--json` 的答复里，来源的种类是 `imported`、`generated`、`unknown`，动态里的动作是 `imported`、`generated`、`task`。
- 旧的「说」的种类（`doing`、`decided`、`from`）不报错，但没有插件记它们，答复是「未记录」。
- 旧资料库根目录的 `PNEUMA-BASE.md` 写着旧的命令名，直到下一次改配置（启用或停用插件，新建或撤销授权）时重写。升级后改一次配置，比如新建再撤销一份授权（`grant create`、`grant revoke`），Agent 读到的就是新名字。

### 改了名的页面

| 页面 ID | 旧标题 | 新 |
| --- | --- | --- |
| `config` | 配置 | `settings`，设置 |
| `archive` | 归档区 | 已归档 |
| `item` | 一样东西 | 条目 |
| `ledger.items` | 库 | 资料库 |
| `ledger.standing` | 状况 | `ledger.status`，状态 |
| `ledger.held` | 留存 | `ledger.copies`，历史副本 |
| `ledger.home` | 自上次以来 | 最近动态 |
| `version.things` | 有版本的东西 | `version.items`，版本管理 |
| `search.status` | 查找 | 搜索 |
| `space.sites`、`space.board` | PneumaSpace、看板 | `deploy.sites`（部署）、`deploy.board`（看板） |

页面地址和 `show` 用新的 ID；旧 ID 答「没有该页面」。插件的名称是溯源、版本管理、同步、部署、搜索，条目面板里那一节叫「溯源」。

### 部署插件接替 PneumaSpace 插件

发布到 PneumaSpace 是内置的部署插件 `deploy` 的事，插件 `space` 没有了；它没有发布过，没有要迁移的数据。部署插件发布到四种目标：Cloudflare 上的 PneumaSpace、自托管的 PneumaSpace、本地文件夹、自定义命令。

- 在设置里启用「部署」，部署页先问发布到哪里：这台机器安装过的 PneumaSpace 点「连接」即可；别的 PneumaSpace 在对话框里填地址、账户和账户密钥，密钥在连接之前核对一次，只存在这台机器上。
- 连接之后点「发布条目」，选资料库里的一个目录；那一行有地址和开关，关闭开关即取消发布。所有者发布不用 Agent 先声明；Agent 仍用 `say deployable` 声明。
- `--prefix` 可以不写，默认取资料库文件夹的名字。
- 新命令 `deploy target list`（已连接的，和这台机器上检测到的）和 `deploy target remove`（断开连接，已发布的不取消发布）。
- 连不上的地址、不是 PneumaSpace 的地址，连接时就拒绝，什么都不存；站点顶层没有 `index.html` 时，发布到 PneumaSpace 之前就拒绝。
- 早先设置的部署目标照样读。

逐项见 [`packages/plugin-deploy/README.md`](packages/plugin-deploy/README.md)。

### 存储之上的新地基

资料库里有什么由记录说，存储只在记录指到的地方被查看，所以一个满是依赖和缓存的文件夹不会让命令变慢。

- **插件契约是第 2 版。** 声明第 1 版的插件在装载时被拒，`plugin install`、`plugin enable` 的答复说原因。第 2 版的工具用存储的词，插件不自己走目录。逐项怎么改见 [`PLUGINS.md` 第 10 节](PLUGINS.md#10-从第-1-版到第-2-版)。
- **条目靠状态令牌认，指纹可以没有。** 登记和移动不读内容，所以 `put` 的答复和 `inspect` 里的指纹常常是空的；`inspect --content` 带上内容，`check --deep` 读每个已登记条目的内容。
- **清单都分页。** 命令行给前 20 条、总数和看下一页的命令，`show` 的每一页也一样；页面一页 50 条。`start` 和 `check` 的输出不超过 8 KB，`--json` 和 MCP 的结构化内容不超过 32 KB。
- **没登记的目录不再被走进去。** 它是上一层的一个条目，首页问所有者三个回答：登记成一个条目，登记里面的文件（`ledger register <目录> --recursive`，有进度，可以停下），或忽略（加进忽略规则）。忽略规则写在资料库的 `.pneuma-base/noise.json`，由 `ignore list`、`ignore add`、`ignore remove` 管；没有这个文件的资料库用默认的名单。
- **存储提供者。** 资料库建在一个存储上，存储的实现是一个可以安装的程序。安装包自带本机文件夹的那一个；`storage list`、`storage install <owner>/<repo>`、`storage remove`、`storage update` 管这台机器上的提供者，`init <地址> --provider <名称>` 选一个。见 [`PROVIDERS.md`](PROVIDERS.md)。

### 打开旧资料库

- 升级后的第一次运行从记录推出缓存区 `.pneuma-base/cache/` 里的行；记录多时，命令在标准错误上报进度。缓存区随时可以删，删了只是下一次慢一点。
- 各插件的记录照样读，包括按场景分目录、直接放在 `facts/` 下的旧布局。部署插件和搜索插件早先写下的记录和配置照样读。
- 搜索插件的 HTTP embedding 服务的密钥用 `secret set search key` 设置，不读环境变量。
- 旧版一个请求一个文件的 `requests/<编号>.jsonl` 不读；请求是记录处 `requests` 的记录。
- 同步插件把旧的同步目标当作新的：第一次同步按没有基线的规则走，只在一边的复制过去，两边不同的算冲突，不丢内容。用旧版同步拉到一半停下、又丢了基线的资料库，第一次同步可能把其中已有的几条记录再带进来一份。
