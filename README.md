# Pneuma Base

Pneuma Base 是一个人和自己的 agent 共用的资料库：一个自己会说明自己的文件夹。导入的资料和生成的条目都放在这里，每个条目都能回到它出现的那次会话。所有者用 Mac 应用的界面，agent 用命令行或 MCP；除了管理归所有者，两边能做的事一样。资料库是普通的文件夹，拷到哪里记录都跟着走；软件不持有资料库的任何状态。

产品定义在 [`CONTEXT.md`](CONTEXT.md)，架构在 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 拿到它

这一版只给 Apple 芯片的 Mac。还没有发布到 GitHub Releases、Homebrew 或 npm，两种拿法都从这个仓库构建，要先装 pnpm 和 Rust 工具链（`pnpm build` 用 `cargo` 构建存储的程序）。

**Mac 应用。** 它自带 Node 和命令行，打开就能用，不用另装什么。构建要一个 nodejs.org 的 Node（Homebrew 的依赖它自己的动态库，`build.sh` 不收）：

```sh
pnpm install
app/build.sh --node <nodejs.org 的 node>     # 写到 app/dist/Pneuma Base.app
open "app/dist/Pneuma Base.app"
app/build.sh --node <…> --dist               # 另打一个 zip，给别的 Mac
```

应用没有用开发者证书签名，也没有经过 Apple 公证。从 zip 拿到它的人，第一次打开时 macOS 会拦下：把它拖进「应用程序」，双击一次，点「完成」，再到「系统设置 › 隐私与安全性」里点「仍要打开」。步骤和原因在 [`app/README.md`](app/README.md)「发给别人」。

**命令行的包。** 要 Node 22.18 以上。在这个仓库里打出包文件，再像安装任何命令行工具那样安装：

```sh
pnpm install
pnpm pack:dist                                                # 先构建，再写到 dist-packages/
npm install --global ./dist-packages/pneuma-base-0.9.0.tgz
pneuma-base --help
```

包里带着 Apple 芯片的本机文件夹存储提供者和契约测试的程序。在别的机器上运行，命令行只说它是给哪个平台构建的。

两种拿法用同一个家目录 `~/.pneuma-base`，和同一个本机的命令 `~/.pneuma-base/bin/pneuma-base`。连接 agent 时写进去的都按完整路径用它，所以 agent 的 PATH 上什么都不用有。应用每次启动都让它指向应用自带的 Node 和命令行；从包安装的，`pneuma-base launcher install` 让它指向你安装的这个。要在自己的终端里用应用带的命令行，在应用的设置里打开「安装命令行工具」。

## 头五分钟

1. **选一个文件夹。** 打开应用，选一个文件夹，它就成了资料库，窗口打开在首页，最上面是「快速开始」的三步。命令行上是：

   ```sh
   pneuma-base init ~/base      # 初始化资料库，缺省启用溯源插件（记每个条目从哪来）
   pneuma-base view ~/base      # 在浏览器里打开同一个界面
   ```

2. **连接一个 agent。** 「快速开始」的第一步列出这台机器上找到的 agent（Claude Code、Codex、Cursor、Claude Desktop），点一个的「连接」。它新建一份以产品命名的授权，把技能安装到那个产品读技能的目录，不读技能的把 MCP 服务登记进它的配置。命令行上是 `pneuma-base agent connect claude-code --library ~/base`。也可以把首页上那句话说给任何一个 agent：「读取 http://127.0.0.1:7638/guide，连接我的 Pneuma Base 资料库。」它读说明、请你允许；你在首页「待处理」里核对它给你看的配对码，点「允许」，它就以自己的名字连接了。Codex 在沙箱里运行，启动时要把资料库加进可写目录：`codex --add-dir ~/base`。

3. **添加一个条目。** 从 Finder 拖一个文件到窗口的任何地方，它添加到资料库的 `inbox/`，记成你导入的。直接在 Finder 里把文件拷进资料库的文件夹也行：应用检测到它，几秒后把它登记成你导入的（自动登记）。命令行上是 `pneuma-base --library ~/base put ~/Downloads/报告.pdf --to inbox/报告.pdf --imported`。

4. **对 agent 说一句。** 在已连接的 agent 里说「查看我的 Pneuma Base 资料库中有哪些内容。」它读资料库根的 `PNEUMA-BASE.md`，跑 `start`，看到你添加的条目，接着用；它生成的条目也放回资料库里，写明依据了什么。之后首页的「最近动态」列出 agent 做了什么，「待处理」列出要你定的事。

## agent 做什么

agent 带着自己的授权调用，`pneuma-base @<授权名称> <命令>`；经 MCP 的 agent 用同名的工具，参数相同。

| 动词 | 做什么 |
| --- | --- |
| `start "<任务描述>"` | 开工：记下在做什么，看资料库里有什么变化和要留意的，找可能相关的 |
| `find <关键词>` | 按名字、说过的话、来源找；启用了搜索插件时也找全文 |
| `inspect <库内路径>` | 一个条目是什么、从哪来、什么来自它；`--content` 带上内容 |
| `put <文件> --to <库内路径> --generated --from <依据…>` | 添加到资料库里，说清来源：`--imported` 导入的，`--generated` 生成的 |
| `say <类型> …` | 说一件事：在做什么、决定、备注；插件听它们各自的种类，比如 `say versioned`、`say deployable` |
| `check` | 自上次以来资料库里变了什么，什么可能过期，所有者决定了什么 |
| `archive <库内路径>` | 不要了就归档：不删，默认找不到，`unarchive` 取消归档 |
| `ask "<原因>" <命令>` | 请所有者做一件管理的事；所有者在首页批准或拒绝 |
| `show [<页面 ID>]` | 把管理界面的一页印成字 |

破坏性的命令和替所有者做决定的命令（启用、停用插件，新建授权，对外发布）在 agent 的会话里被拒绝，agent 用 `ask` 请所有者做。

## 所有者还能做什么

- **启用插件。** 内置五个：溯源（缺省启用）、版本管理、同步、部署、搜索。`pneuma-base plugin enable version --library ~/base`；界面的设置页一样能启用、停用。启用或停用，`PNEUMA-BASE.md` 跟着重写，agent 读到的就是现在启用的。部署能发布到 PneumaSpace（Cloudflare 上的或一台机器上的）、本地文件夹，或所有者自己的命令，见 [`packages/plugin-deploy`](packages/plugin-deploy/README.md)。
- **把资料库放在别的存储上。** 资料库的地址是一个文件夹时，存储是内置的本机文件夹。`pneuma-base storage list` 列出这台机器的存储提供者，`pneuma-base storage install <owner>/<repo>` 从一个 GitHub 仓库的发布安装一个（对过校验和、过了契约测试才安装），见 [`PROVIDERS.md`](PROVIDERS.md)。
- **连接仅支持 MCP 的应用。** `pneuma-base agent connect <产品> --via mcp` 登记标准输入输出的 MCP 服务，`--via mcp-http` 登记界面开着时的地址 `http://127.0.0.1:7638/mcp/<授权名称>`。产品表里没有的应用，先 `pneuma-base grant create <授权名称> --agent <授权对象> --library ~/base`，再在它的 MCP 配置里加一个服务：命令是 `~/.pneuma-base/bin/pneuma-base` 的完整路径，参数 `@<授权名称> mcp`。
- **在终端里看和管。** 界面的每一页也是一条只读的命令：`pneuma-base show --library ~/base` 列出各页。`pneuma-base --help --library ~/base` 列出这个资料库能用的全部命令。

## 别的文档

| 文档 | 给谁 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 想知道它怎样建起来、为什么这样建的人和 agent |
| [`TESTING.md`](TESTING.md) | 改这个仓库的人和 agent：每套测试管什么、什么时候跑、怎样加一个 |
| [`PLUGINS.md`](PLUGINS.md) | 写插件的人：插件规范，从五分钟走通到完整的参考 |
| [`STORAGE.md`](STORAGE.md)、[`PROVIDERS.md`](PROVIDERS.md) | 写存储提供者的人：存储的契约，和提供者怎么登记、安装、运行 |
| [`core/README.md`](core/README.md) | 本机文件夹提供者 `pneuma-base-core` 的线上形式 |
| [`app/README.md`](app/README.md) | Mac 应用：构建、里面有什么、测过什么 |
| [`plugins/README.md`](plugins/README.md) | 三个照插件规范在仓库外写的插件 |
| [`CHANGELOG.md`](CHANGELOG.md) | 用过早先版本的人：这一版变了什么 |

## 开发者怎么跑检查

```sh
pnpm build        # 构建存储的程序（cargo），编译各包，构建界面
pnpm typecheck    # 类型检查
pnpm lint         # lint，含包之间的导入方向和存储的门
pnpm test:changed # 改动需要的测试：改了的包的，加几个穿过各层的（CI 跑这个）
pnpm test         # 单元测试和命令行的端到端测试（vitest），发版时全跑
pnpm test:e2e     # 界面的端到端测试（Playwright，用本机的 Chrome）
pnpm test:slow    # 脚手架和 PLUGINS.md 的五分钟：生成插件项目，装依赖、构建、跑它们自己的测试（要联网）
cargo test --manifest-path core/Cargo.toml   # 存储：契约测试逐句跑一遍
```

每套测试管什么、什么时候跑、怎样加一个测试，在 [`TESTING.md`](TESTING.md)。测试都用临时目录和临时的 `PNEUMA_BASE_HOME`，不碰 `~/.pneuma-base`；除了 `pnpm test:slow` 从 npm 装生成项目的开发依赖，都不联网。`scripts/` 下的 `bench-*.mjs` 量性能（`ARCHITECTURE.md`「性能目标和基准」）。`scripts/agent-relay/` 和 `scripts/agent-site/` 用真的 Claude 和 Codex 走一遍故事，会花模型额度，不在 `pnpm test` 里。

## 许可

[MIT](LICENSE)

管理界面里 Agent 产品的图标来自 [lobe-icons](https://github.com/lobehub/lobe-icons)（MIT），许可全文和来源见 [`packages/viewer/web/src/agents/NOTICE.md`](packages/viewer/web/src/agents/NOTICE.md)。各产品的名称和图标是其所有者的商标。
