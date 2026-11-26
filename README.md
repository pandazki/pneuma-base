# Pneuma Base

给 agent 一个自己的持久化空间：一个自己会说明自己的文件夹，带进来的资料和做出来的东西都放在这里，每样东西都能回到它出现的那个场景。产品定义在 `CONTEXT.md`，架构和边界在 `ARCHITECTURE.md`。

## 两种拿法

**Mac 应用。** 下载 zip，解开，把「Pneuma Base」拖进「应用程序」再打开（没签名，第一次打开要去「系统设置 › 隐私与安全性」点「仍要打开」，见 [`app/README.md`](app/README.md)「发给别人」）。它自带 Node 和命令行，什么都不用另装：选一个文件夹，首页「开始」里点你的 agent 的「接上」，在那个 agent 里说一句「看看我的 Pneuma Base 库里有什么。」就能用。也可以把「开始」里那句话说给任何一个 agent：「读一下 http://127.0.0.1:7638/guide，接上我的 Pneuma Base 库。」它自己读说明、请你允许，你在首页核对配对码、点「允许」。要在自己的终端里也用 `pneuma-base`，在应用的设置里打开「在终端里用 pneuma-base」。zip 从这个仓库打：`app/build.sh --node <nodejs.org 的 node> --dist`。

**命令行的包。** 要 Node 22.18 以上。还没发布到 npm，所以先在这个仓库里打出包文件（这一步要 pnpm），再像装任何命令行工具那样装上：

```sh
pnpm install
pnpm build && pnpm pack:dist && pnpm pack:plugins     # 写到 dist-packages/
npm install --global ./dist-packages/pneuma-base-0.9.0.tgz
pneuma-base --help
```

两种拿法用的是同一个家目录 `~/.pneuma-base`，同一个本机的命令 `~/.pneuma-base/bin/pneuma-base`：接上 agent 时写进去的都按完整路径用它，所以 agent 的 PATH 上什么都不用有。应用每次启动都让它指向应用自带的 Node 和命令行；从包装的，`pneuma-base launcher install` 让它指向你装的这个，`agent connect` 发现它不在时也会写。

## 主人怎么开始

下面是命令行的走法，应用里的按钮做的是同样的事。命令都在你自己的终端里运行。在 agent 的会话里，主人命令会被拒绝。

1. **建库。** 选一个目录建成库，缺省装上记账插件（记来历）：

   ```sh
   pneuma-base init ~/base
   ```

2. **装插件。** 按需要装版本、部署、同步、查找：

   ```sh
   pneuma-base plugin add version --library ~/base
   pneuma-base plugin add deploy --library ~/base
   pneuma-base deploy target set --kind dir --to ~/www --library ~/base
   pneuma-base plugin add sync --library ~/base
   pneuma-base sync target set --kind dir --to ~/Dropbox/base --library ~/base
   pneuma-base plugin add search --library ~/base
   pneuma-base search embedder set --kind hash --library ~/base
   ```

   装上或卸下一个插件，库根目录的 `PNEUMA-BASE.md` 会跟着重写，agent 读到的就是现在装了的。

   要把 agent 做的网站发布到你自己的 PneumaSpace（一台机器上的，或 Cloudflare 上的），装 `space` 插件代替 `deploy`：它不是自带的，先装到这台机器，再在库里启用。一步步的做法在 [`plugins/space/README.md`](plugins/space/README.md)。

   ```sh
   pneuma-base plugin install dist-packages/plugins/space
   pneuma-base plugin add space --library ~/base
   ```

3. **接上你的 agent。** 先看这台机器上有哪些，再一个一个接上：

   ```sh
   pneuma-base agent detect --library ~/base
   pneuma-base agent connect claude-code --library ~/base
   pneuma-base agent connect codex --library ~/base
   pneuma-base agent connect claude-desktop --library ~/base
   ```

   接上一个 agent 是一条命令：发一份以产品命名的授权，再把技能装进那个产品读技能的目录（Claude Code、Codex、Cursor），不读技能的（Claude Desktop）把 MCP 服务登记进它的配置。两种都写本机的命令的完整路径。答复说写了什么、写在哪、在那个产品里接着做什么。`--via mcp` 改用 MCP 服务，`--area <子文件夹>` 和 `--read-only` 收窄授权，`--name` 另起授权名。`pneuma-base agent list --library ~/base` 列出接上的，`pneuma-base agent disconnect <授权名>` 拿掉接上时写的、撤回授权；主人改过的条目原样留着。

   Codex 在沙箱里运行，启动时要把库加进可写目录：`codex --add-dir ~/base`。

   不一个一个接也行：管理界面开着时（应用，或下面的 `pneuma-base view`），对任何 agent 说一句「读一下 http://127.0.0.1:7638/guide，接上我的 Pneuma Base 库。」它读这台机器为它的产品写的说明（`pneuma-base guide claude-code --library ~/base` 印的是同一段），请你允许（配对），你在首页「等你决定」里核对它给你看的配对码、点「允许」，它就以自己的名字接上了：允许跑的就是 `agent connect`。端口缺省 7638，被占时往后找，`pneuma-base guide --url` 印出这台机器上的地址。`pneuma-base pair list --library ~/base` 列出配对，`pair allow <号>`、`pair decline <号>` 在终端里做同样的事。

4. **看和管。** 在浏览器里打开管理界面：

   ```sh
   pneuma-base view ~/base
   ```

   界面打开在首页：等你决定的事（比如 agent 声明了可以部署、还没上线的网站），你上次看过之后 agent 做了什么，哪些东西要留意。另有库、活动、场景、状况，开关部署，同步，取回留存，装卸插件，接上和断开 agent。在界面里做的操作，agent 下次 `check` 时会看到；agent 的 `check` 也会列出等你决定的事，告诉你要跑哪条命令。界面的每一页也是一条只读的命令：`pneuma-base show --library ~/base` 列出各页，`show <页的编号>` 把一页印成字，每个按钮写成做同一件事的命令。

5. **别的只能接 MCP 的应用。** 产品表里没有的应用，先为它发一份授权，再在它的 MCP 配置里加一个 stdio 服务，命令是本机的命令 `~/.pneuma-base/bin/pneuma-base`（写完整路径），参数 `@<授权名> mcp`：

   ```sh
   pneuma-base grant issue <授权名> --agent <给谁> --library ~/base
   ```

   ```json
   {
     "mcpServers": {
       "pneuma-base-<授权名>": {
         "command": "/Users/<你>/.pneuma-base/bin/pneuma-base",
         "args": ["@<授权名>", "mcp"]
       }
     }
   }
   ```

   这个文件还不在时，先跑一次 `pneuma-base launcher install`（或打开一次应用）。它自己带着家目录，你的 `PNEUMA_BASE_HOME` 不是缺省的时，`command` 写那个目录下的 `bin/pneuma-base`，不用另加 `env`。连上之后，每个动词和 agent 能用的命令都是一个工具，库的说明随连接给出，管理界面导航里的页是资源。管理的命令不在里面，仍在你自己的终端或界面里做。

   收 URL 而不是命令的应用，用 MCP over HTTP：管理界面开着时，地址是 `http://127.0.0.1:7638/mcp/<授权名>`（streamable HTTP，可以加 `?session=<名字>` 给这次的场景起名）。`pneuma-base agent connect <产品> --via mcp-http --library ~/base` 替 Claude Code、Codex、Cursor 把它写进配置；表里没有的应用自己经 `/guide` 配对，允许之后答复里就是它的地址。地址里有端口，界面的服务不在跑时连不上，stdio 的条目没有这个限制。

`pneuma-base --help --library ~/base` 列出这个库能用的全部命令。

## 写一个插件

插件在这个仓库外面写，只依赖 `pnpm pack:dist` 打进 `dist-packages/` 的两个包文件。插件规范是 [`PLUGINS.md`](PLUGINS.md)：插件必须做什么、可以依赖什么，从五分钟走通到完整的参考。它也在命令行的包里，插件项目 `npm install` 之后在 `node_modules/pneuma-base/PLUGINS.md`。

```sh
pneuma-base plugin new ~/my-plugin --packages <仓库>/dist-packages   # 生成项目；部署插件加 --kind deploy
cd ~/my-plugin && npm install
npm test                                          # 构建，再跑符合性检查和插件自己的测试
npm run install-local                             # 装到这台机器
pneuma-base plugin add my-plugin --library ~/base
```

## 开发者怎么跑检查

```sh
pnpm build        # 编译各包，构建界面
pnpm typecheck    # 类型检查
pnpm lint         # lint，含包之间的导入方向
pnpm test         # 单元测试和命令行的端到端测试（vitest）
pnpm test:e2e     # 界面的端到端测试（Playwright，用本机的 Chrome）
pnpm test:slow    # 脚手架和 PLUGINS.md 的五分钟：生成插件项目，装依赖、构建、跑它们自己的测试、装进库（要联网装 esbuild、typescript）

三个照这份规范在仓库外做出来的插件在 [`plugins/`](plugins/)：部署到 PneumaSpace 的 `space`，和两个由没有任何上下文的 agent 做的 `links`、`pulse`。它们也是契约的回归测试。
```

测试都用临时目录和临时的 `PNEUMA_BASE_HOME`，不碰 `~/.pneuma-base`；除了 `pnpm test:slow` 从 npm 装生成项目的开发依赖，都不联网。`scripts/agent-relay/` 和 `scripts/agent-site/` 用真的 Claude 和 Codex 走一遍故事，会花主人的模型额度，不在 `pnpm test` 里。

## 许可

[MIT](LICENSE)
