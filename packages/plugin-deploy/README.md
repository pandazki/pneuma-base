# 部署插件 `deploy`

agent 用 `say deployable <库内路径>` 声明一样东西可以部署；主人用 `deploy on` / `deploy off` 开关决定它在不在线；开着的东西，目标上跟着库里当前的内容。

这个插件是 sdk 的部署库加两种目标：`deployPlugin('deploy', [dirTarget, commandTarget])`（`src/index.ts`）。一个决定、状态、状态 × 操作的表、站点名、记录、命令和页面都是部署库的，见 `packages/sdk/src/kit/deploy/README.md`；这里只写两种目标（`src/targets.ts`）。

## 目标

`deploy target set --kind dir|command …` 选一种。两种目标的开关各是一份参数表（`params`），命令行、帮助和页面上的表单都从它来。

- `dir`：`<目录>/<站点名>/…`，加一个 `<目录>/index.json`，列出在线的站点、指纹和库内路径。先复制到 `.tmp-` 开头的名字再改名换上。目录不能在库里，也不能包含库。地址是 `file://` 的。
- `command`：主人配一条发布命令和一条下线命令，`{dir}`、`{name}` 换成内容目录和站点名（下线时 `{dir}` 是一个空目录）。命令按 shell 的引号规则切成参数，不经 shell 运行；工作目录就是 `{dir}`（发布时是内容的复制件，下线时是那个空目录），不在库里；超时缺省 120 秒。可以配地址模板，比如 `https://{name}.pages.dev`。

两种都不报告自己在服务什么，所以「目标上有什么」来自插件自己的记录；用的是缺省的站点名和存储给的指纹。

## 存放

都在 `.pneuma-base/deploy/` 下，本体：

| 路径 | 内容 |
| --- | --- |
| `config.json` | 目标：`{ "kind": "dir", "to": … }` 或 `{ "kind": "command", "publish": […], "unpublish": […], "url": …, "timeout": … }` |
| `facts/` | 部署库的记录 |

记录按目标的标识区分：`dir:<目录>`、`command:<发布命令的参数表>`。

## 命令

| 命令 | 谁能用 | 做什么 |
| --- | --- | --- |
| `deploy on <库内路径>` | 只有主人 | 打开开关并发布 |
| `deploy off <库内路径>` | 只有主人 | 关上开关并下线 |
| `deploy target set --kind dir --to <目录>` | 只有主人 | 配本地目录目标 |
| `deploy target set --kind command --publish <发布命令>… --unpublish <下线命令>… [--url <地址模板>] [--timeout <超时秒数>]` | 只有主人 | 配命令目标；一条命令可以加引号写成一个值，也可以不加引号写成几个词 |
| `deploy sync` | 主人和 agent | 把全部声明过的东西对一遍 |
| `deploy list` | 主人和 agent | 列出声明过的东西、状态和地址 |
