# Pneuma Base

给 agent 一个自己的持久化空间：一个自己会说明自己的文件夹，带进来的资料和做出来的东西都放在这里，每样东西都能回到它出现的那个场景。产品定义在 `CONTEXT.md`，架构和边界在 `ARCHITECTURE.md`。

## 主人怎么开始

要 Node 22.18 以上。还没发布到 npm，所以先在这个仓库里打出包文件（这一步要 pnpm），再像装任何命令行工具那样装上：

```sh
pnpm install
pnpm build && pnpm pack:dist && pnpm pack:plugins     # 写到 dist-packages/
npm install --global ./dist-packages/pneuma-base-0.9.0.tgz
pneuma-base --help
```

下面的命令都在你自己的终端里运行。在 agent 的会话里，主人命令会被拒绝。

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

3. **给 agent 授权，并装上技能。** 授权名同时定下是哪个库、是谁：

   ```sh
   pneuma-base grant issue claude --agent claude-code --library ~/base
   pneuma-base skill install claude --dir ~/.claude/skills
   pneuma-base grant issue codex --agent codex --library ~/base
   pneuma-base skill install codex --dir ~/.agents/skills
   ```

   Codex 在沙箱里运行，启动时要把库加进可写目录：`codex --add-dir ~/base`。

   别的 agent 产品一样：发一份授权，再把技能写进那个产品读技能的目录。几个产品共用一个技能目录时只装一份，agent 拿哪份授权，账上记的就是哪个名字。

4. **看和管。** 在浏览器里打开管理界面：

   ```sh
   pneuma-base view ~/base
   ```

   界面打开在首页：等你决定的事（比如 agent 声明了可以部署、还没上线的网站），你上次看过之后 agent 做了什么，哪些东西要留意。另有库、活动、场景、状况，开关部署，同步，取回留存，装卸插件，发授权。在界面里做的操作，agent 下次 `check` 时会看到；agent 的 `check` 也会列出等你决定的事，告诉你要跑哪条命令。界面的每一页也是一条只读的命令：`pneuma-base show --library ~/base` 列出各页，`show <页的编号>` 把一页印成字，每个按钮写成做同一件事的命令。

5. **给只能接 MCP 的应用。** 桌面的对话应用、编辑器这类跑不了 shell、也装不了技能的 agent 应用，经 MCP 用库。先为它发一份授权，再在它的 MCP 配置里加一个 stdio 服务，命令是 `pneuma-base @<授权名> mcp`：

   ```json
   {
     "mcpServers": {
       "pneuma-base": {
         "command": "pneuma-base",
         "args": ["@<授权名>", "mcp"]
       }
     }
   }
   ```

   应用找不到 `pneuma-base` 时，`command` 写 `which pneuma-base` 印出的完整路径；你的 `PNEUMA_BASE_HOME` 不是缺省的 `~/.pneuma-base` 时，加 `"env": { "PNEUMA_BASE_HOME": "<那个目录>" }`。连上之后，每个动词和 agent 能用的命令都是一个工具，库的说明随连接给出，管理界面导航里的页是资源。管理的命令不在里面，仍在你自己的终端或界面里做。

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

[MIT](LICENSE)，只有一个文件夹例外。

管理界面的 `packages/viewer/web/src/aui/` 里的代码改自 [affectUI Pro](https://www.affectui.com)，按它自己的许可（https://www.affectui.com/license）使用，不在 MIT 之内，不要把它复制到这个项目外面。那里的每个文件第一行都写着这句声明；它们只打进构建出来的管理界面，不在 sdk、插件开发包、`plugin new` 生成的项目和 `plugins/` 里。详见 [`NOTICE`](NOTICE)。
