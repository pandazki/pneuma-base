# Pneuma Base

Pneuma Base 是一个人和自己的 Agent 共用的资料库。资料库是一个普通的文件夹：导入的资料和 Agent 生成的条目都放在里面，每个条目记着它来自哪次会话、依据了哪些条目。你在 Mac 应用里管理它，Agent 用命令行或 MCP 读写它。

## 拿到应用

还没有发布版本：应用从这个仓库构建（见下文「从源码构建」），只支持 Apple 芯片的 Mac。应用自带 Node 和命令行，不用另装什么。

应用没有用开发者证书签名，也没有经过 Apple 公证。从 zip 拿到它的人第一次打开时 macOS 会拦下，打开的步骤见 [`app/README.md` 的「发给别人」](app/README.md#发给别人)。

## 头五分钟

1. **选一个文件夹。** 打开应用，选一个文件夹，它就成为资料库。主窗口打开在首页，最上面是「快速开始」的三步。
2. **连接 Agent。** 「快速开始」的第一步列出这台机器上找到的 Agent（Claude Code、Codex、Cursor、Claude Desktop），点一个的「连接」。应用为它新建一份授权，把技能安装到它读技能的目录；不读技能的 Agent，把 MCP 服务登记进它的配置。别的 Agent 可以自己连接：把首页上的那句话发给它（「读取 http://127.0.0.1:7638/guide，连接我的 Pneuma Base 资料库。」，端口以首页上写的为准），它请求接入，你在首页「待处理」里核对配对码，点「允许」。Codex 在沙箱里运行，启动时要把资料库加进可写目录：`codex --add-dir <资料库目录>`。
3. **添加资料。** 把文件从访达拖到窗口上，它添加到资料库的 `inbox/`，记为你导入的。直接在访达里把文件拷进资料库的文件夹也可以：应用几秒后把它登记为你导入的。
4. **看 Agent 做了什么。** 在已连接的 Agent 里说「查看我的 Pneuma Base 资料库中有哪些内容。」Agent 读资料库根目录的 `PNEUMA-BASE.md`，看到你添加的条目，接着做事；它生成的条目也放进资料库，写明依据了哪些条目。首页的「最近动态」列出 Agent 做了什么，点一行打开那个条目，「溯源」一节写着它的来源和依据。「待处理」列出要你决定的事。
5. **发布一个网站。** 在「设置」里启用「部署」。部署页先问发布到哪里：这台机器安装过的 PneumaSpace 点「连接」即可，别的 PneumaSpace 填地址和账户，也可以选本地文件夹。连接之后点「发布条目」，选资料库里的一个网站目录，它就发布了；那一行有地址和开关，关闭开关即取消发布。Agent 只能声明一个目录可部署，是否发布由你决定。四种部署目标和部署页的细节见 [`packages/plugin-deploy`](packages/plugin-deploy/README.md)。

## 命令行

应用里的每件事都有对应的命令。你在自己的终端里用 `--library <资料库目录>`；要用应用自带的命令行，在应用的设置里打开「安装命令行工具」。

```sh
pneuma-base init ~/base                                    # 把一个文件夹初始化为资料库
pneuma-base agent connect claude-code --library ~/base     # 连接 Claude Code
pneuma-base put ~/Downloads/报告.pdf --to inbox/报告.pdf --imported --library ~/base
pneuma-base show home --library ~/base                     # 首页，印成文字
pneuma-base view ~/base                                    # 在浏览器里打开同一个管理界面
pneuma-base --help --library ~/base                        # 这个资料库能用的全部命令
```

Agent 带着自己的授权调用，比如 `pneuma-base @claude-code start "<任务描述>"`；经 MCP 连接的 Agent 用同名的工具。Agent 用几个动词：`start` 开工，`find` 找，`inspect` 看一个条目，`put` 添加并说明来源，`say` 记一件事，`check` 看变化，`archive` 归档。替所有者做决定的命令（启用插件、新建授权、发布）在 Agent 的会话里被拒绝，Agent 用 `ask` 请你批准。动词和命令怎样设计，见 [`ARCHITECTURE.md` 第 5 节](ARCHITECTURE.md#5-内核)。

## 从源码构建

要 Node 22.18 以上、pnpm 和 Rust 工具链（`pnpm build` 用 `cargo` 构建存储的程序），在 Apple 芯片的 Mac 上构建。

```sh
pnpm install
pnpm build                                   # 存储的程序、各个包和管理界面
app/build.sh --node <nodejs.org 的 node>     # Mac 应用：app/dist/Pneuma Base.app；加 --dist 另打一个 zip
pnpm pack:dist                               # 命令行的包文件：dist-packages/
npm install --global ./dist-packages/pneuma-base-0.9.0.tgz
pneuma-base launcher install                 # 让已连接的 Agent 运行的本机命令指向这份命令行
```

`app/build.sh` 只收 nodejs.org 的 Node，原因见 [`app/README.md`](app/README.md)。改代码之后跑 `pnpm typecheck`、`pnpm lint` 和 `pnpm test:changed`；每套测试管什么、什么时候跑，见 [`TESTING.md`](TESTING.md)。

## 文档

| 文档 | 写给谁 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 要改代码的人：它怎样建起来，为什么这样建 |
| [`CONTEXT.md`](CONTEXT.md) | 所有者定下的事 |
| [`PLUGINS.md`](PLUGINS.md) | 写插件的人：插件规范 |
| [`STORAGE.md`](STORAGE.md)、[`PROVIDERS.md`](PROVIDERS.md) | 写存储提供者的人：存储的契约，提供者怎样打包和安装 |
| [`core/README.md`](core/README.md) | 改本机文件夹提供者 `pneuma-base-core` 的人 |
| [`app/README.md`](app/README.md) | 改 Mac 应用的人 |
| [`packages/plugin-deploy/README.md`](packages/plugin-deploy/README.md) | 用部署插件的人 |
| [`plugins/README.md`](plugins/README.md) | 想看示例插件的人 |
| [`TESTING.md`](TESTING.md) | 改这个仓库的人：各套测试 |
| [`CHANGELOG.md`](CHANGELOG.md) | 用过早先构建的人：变了什么 |
| [`docs/history/`](docs/history/README.md) | 实现之前写下的早期材料 |

## 许可

[MIT](LICENSE)

管理界面里 Agent 产品的图标来自 [lobe-icons](https://github.com/lobehub/lobe-icons)（MIT），许可全文和来源见 [`packages/viewer/web/src/agents/NOTICE.md`](packages/viewer/web/src/agents/NOTICE.md)。各产品的名称和图标是其所有者的商标。
