# 测试

每个测试说一件用户、agent、插件作者或存储提供者的作者看得见的事，只说一次，在说得最便宜的那一层。

## 各套测试管什么

| 套 | 命令 | 在哪 | 管什么 |
| --- | --- | --- | --- |
| 单元 | `pnpm test` | `packages/*/test/*.test.ts`（vitest） | 每个包的行为。内核的全化表和门、插件的规则表在进程内调；命令行、HTTP、MCP 各面只说它们自己才有的：退出码、印出的字、请求和回答。跑命令行的测试用建好的 `dist/` |
| 慢 | `pnpm test:slow` | `packages/*/test/*.slow.test.ts` | 要从 registry 装依赖、建整个项目的：脚手架的两种项目、`PLUGINS.md` 里从 registry 装的块、`plugins/` 下外面写的插件得到 MCP 工具、真的装存储提供者（每次跑整套契约测试） |
| 浏览器 | `pnpm test:e2e` | `packages/viewer/e2e/*.spec.ts`（Playwright，本机的 Chrome；本机用一半的核，CI 上两个） | 只有浏览器看得见的：键盘、标签页、对话框、重载和地址、配色、刷新、菜单栏面板、拖放区、每种块怎么画、插件自己画的页，和整个故事在界面上走一遍。等时间的地方用页面的假时钟 |
| 存储的契约 | `cargo test`（`core/`） | `core/contract` | `STORAGE.md` 一句一个检查，对自带的存储跑；`storage install` 对每个装上来的跑。它审第三方的提供者，结构不改 |
| 应用 | `app/verify.sh` | `app/` | 建好的 Mac 应用，沿新主人走的路，不要人 |

`scripts/bench-*.mjs` 量性能，只报告，不拦（`ARCHITECTURE.md` 第 13 节）。

## 什么时候跑什么

- **改动时**：`pnpm test:changed`，CI 的 Check 也跑它。`scripts/affected-tests.mjs` 按改了的文件选：改了的包的测试；改动在命令行之下（`core/`、内核、sdk、插件的源码）时，加几个穿过各层的测试（`ACROSS`）；改了界面的服务时，加命令行里经过它的几个测试（`THROUGH_SERVER`）；改了 sdk 的部署库时加部署插件的测试；改了工作区的依赖或测试配置时全跑。改了人看见的东西时加浏览器测试；改了插件作者拿到的东西时加慢测试。`node scripts/affected-tests.mjs` 不加 `--run` 只印出选了什么。
- **`core/` 改了**：Core 工作流跑 `cargo fmt --check`、clippy 和 `cargo test`，含契约测试。
- **发版**（打 `v*` 标签）或手动：Full 工作流跑全部，在三个 Node 版本上。

## 加一个测试

1. 先想两件事：把它说的行为弄坏，它红不红；只改内部、行为不变，它绿不绿。两样都要。新测试先看它红。
2. 一个行为只说一次。内核和插件在进程内调，比起一个命令行进程快得多，同样清楚就放在那里；命令行、HTTP、MCP、浏览器只说自己才有的。已经有人说过的，不在另一层再说一遍。现在各归谁：
   - 放、归档、挪的每一格：`packages/kernel/test/put-table.test.ts`、`archive-table.test.ts`、`bundle.test.ts`、`positions.test.ts`。
   - 门（破坏性的、只给主人的命令）：`packages/kernel/test/owner.test.ts`；命令行上每类一个（`plugin-mechanism.test.ts`），终端的 Ctrl+D（`held-and-owner.test.ts`），HTTP 上的确认（`packages/viewer/test/server.test.ts`），浏览器里的对话框（`destructive.spec.ts`）。
   - 说明的拼装：`description.test.ts`、`description-commands.test.ts`；各插件不再各测自己那段的来去。
   - find 在插件之间的合并和排序：`packages/kernel/test/find.test.ts`；查找插件只测它自己读内容、索引和向量。
   - 部署的状态 × 操作表：`packages/sdk/test/kit-model.test.ts`；同步的规则表：`packages/plugin-sync/test/rules.test.ts`。经插件和命令行的只走每种操作或每种步骤一次。
   - 页的块：内核和各插件的视图测试；块怎样印成字：`show.test.ts`；怎样画、怎样操作：浏览器。
3. 一句中文只在一个测试里逐字核对。别处核对结果：退出码、`reason`、`outcome`、`--json` 里的字段。
4. 换个值不是新情况。同一个行为的几种输入写成一个测试里的一张表；真的不同的情况（另一种格式、另一种状态）才各占一格。
5. 夹具一个文件建一次，测试按顺序读它。不用 `sleep` 和放宽的超时掩盖慢；一个文件单独跑超过半分钟，就是该拆或该减了。
6. 不测内部的助手和中间的形状，不测类型和常量本身；写给用户的上限（文档里的数）是行为。

## 不减的

- 存储契约测试一句一个检查的结构。
- 只有存储的门碰库（`packages/kernel/test/storage-door.test.ts`）和包之间的导入方向（`dependency-direction.test.ts`）。
- 页、按钮和命令两头对得上（`packages/cli/test/pages.test.ts`、`buttons.test.ts`）。
- 命令行和 MCP 对得上（`mcp.test.ts` 和 `mcp-cases.ts` 的每一例）。
- 两种知道变化的路说的一样（`listener.test.ts`）。
- 保护数据的拒绝：门（破坏性的和只给主人的命令在 agent 的会话里、经授权、没有当面确认时被拒）、写的预期、破坏性命令，每种至少一个测试。
- `ARCHITECTURE.md` 第 12 节每条不变式列着的测试。
