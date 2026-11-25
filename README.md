# Pneuma Base

给 agent 一个自己的持久化空间：一个自己会说明自己的文件夹，带进来的资料和做出来的东西都放在这里，每样东西都能回到它出现的那个场景。产品定义在 `CONTEXT.md`，架构和边界在 `ARCHITECTURE.md`。

## 主人怎么开始

要 Node 26 以上和 pnpm。还没发布到 npm，先在这个仓库里构建，再让 `pneuma-base` 指向构建出的命令：

```sh
pnpm install
pnpm build
alias pneuma-base="node $PWD/packages/cli/dist/bin.js"
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

3. **给 agent 授权，并装上技能。** 授权名同时定下是哪个库、是谁：

   ```sh
   pneuma-base grant issue claude --agent claude-code --library ~/base
   pneuma-base skill install claude --agent claude --dir ~/.claude/skills
   pneuma-base grant issue codex --agent codex --library ~/base
   pneuma-base skill install codex --agent codex --dir ~/.agents/skills
   ```

   Codex 在沙箱里运行，启动时要把库加进可写目录：`codex --add-dir ~/base`。

4. **看和管。** 在浏览器里打开管理界面：

   ```sh
   pneuma-base view ~/base
   ```

   界面里能看条目、场景、状况和动态，开关部署，同步，取回留存，装卸插件，发授权。在界面里做的操作，agent 下次 `check` 时会看到。

`pneuma-base --help --library ~/base` 列出这个库能用的全部命令。

## 开发者怎么跑检查

```sh
pnpm build        # 编译各包，构建界面
pnpm typecheck    # 类型检查
pnpm lint         # lint，含包之间的导入方向
pnpm test         # 单元测试和命令行的端到端测试（vitest）
pnpm test:e2e     # 界面的端到端测试（Playwright，用本机的 Chrome）
```

测试都用临时目录和临时的 `PNEUMA_BASE_HOME`，不碰 `~/.pneuma-base`，不联网。`scripts/agent-relay/` 和 `scripts/agent-site/` 用真的 Claude 和 Codex 走一遍故事，会花主人的模型额度，不在 `pnpm test` 里。
