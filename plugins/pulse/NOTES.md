# pulse 插件：做的过程记录

## 结果

- 插件项目：`pulse/`（`plugin new pulse --packages .` 生成，再改写）。`npm test` 通过：符合性检查 9 项全过（loads、names、cognition、examples、hooks、writes、cache、blocks、remove），另有插件自己的 6 个测试。
- 真装过：`PNEUMA_BASE_HOME=work/.pneuma-home`，库是 `work/trial-lib`。做了这些：`plugin install`、`init`、`plugin add`，claude-code 和 codex 两个 agent 放入、归档、取回、挪动，开 `pneuma-base view` 看页面，`pulse clear` 分别以 agent、没有终端的主人、终端里输入 `no`、输入 `yes` 跑过。
- `work/trial-demo-lib` 是另一个库，**活动记录是我手写的**（`activity/20261001000000000-handmade.jsonl`，110 条，日期往回排，格式照着 trial-lib 里插件真写出来的那几行），只是为了截一张有内容的格子图。命令行没法伪造时间，所以没别的办法。截图在 `work/trial-shots/light.png`、`dark.png`。
- `work/trial-bin/` 是我写的辅助脚本：`owner`（去掉 agent 会话变量、用本地家目录）、`agent`、`shot.mjs`（经 CDP 驱动无头 Chrome 截图）。
- 家目录没碰。命令行装在 `work/cli/`，没有用规范第 1 节的 `npm install --global`。npm 缓存用的是环境里已经设好的 `../npm-cache`，这个目录在 work 外面，不是我选的。有一次误操作，在 `/tmp/x` 建了一个空文件，已经删掉（见下面「卡住的地方」第 6 条）。

## 设计上的决定（有几条是猜的）

1. **什么算「放进库」**：`onPut` 里 `kind` 为 `register` 或 `place` 的都算，**包括往已有路径换新内容**；`move` 不算。这是我猜的：挪动没有新东西进库，换内容可以算放入。
2. **什么算「被归档」**：`onArchive` 里 `kind === 'archive'` 且 `moved === true` 才算。取回（`unarchive`）不算，对已经在归档区的东西再归档（`moved: false`）也不算。也是猜的。
3. **清空不删文件**。这是最大的决定，见下面「规范的问题」第 1 条。`pulse clear` 往 `clears/` 追加一条清空记录，`at` 不晚于最近一次清空的活动都不再算。**原始记录文件还在磁盘上**。如果你要的「清空」是真的从磁盘上抹掉（比如出于隐私），这个实现不满足，需要你决定。
4. **`destructive: true`、`ownerOnly: false`**。规范的表格说丢数据的命令声明 `destructive`，它本身就在 agent 的会话里拒绝，所以没再加 `ownerOnly`。从实现上说，因为第 3 条，数据其实还在；但从主人和界面的角度看，清掉的东西拿不回来（没有撤回命令），所以按会丢数据的命令处理，这也是你要的。
5. **「每天」按哪个时区**：按跑 `pneuma-base view` 那个进程所在机器的本地时区分天，在服务端算好 30 个格子交给页。规范没说（见下面第 7 条）。
6. **按 agent 列**：其实是按行动者列，主人做的放入也列出来，显示成「主人」。规范没说主人的记录里 `actor.name` 是什么（见第 8 条），所以不管 name 是什么，主人一律显示「主人」。**我没有真的以主人身份放入过，再看它写下的 name**。
7. **认知段**：pulse 不需要 agent 做什么，按规范本可以写 `cognition: null`。我还是写了三句，告诉 agent 它的放入和归档会被记下、只有主人能清空、觉得记错了要告诉主人。理由是让 agent 知道自己的动作被记录。这一点可以删。
8. **视图带 `refresh: 600`**：库不变时，过了午夜格子不会自己往前挪，所以让页隔 10 分钟重取一次。规范说 `refresh` 是给读库外东西的视图的，没说别的情况能不能用。
9. 没做条目面板里的一节（`onItemView`），也没做只读的列表命令。你没要，我就没加。

## 卡住的地方

1. **无头 Chrome 截图里，自己画的页显示「插件 pulse 的页没能打开……5 秒内没有说它准备好了」**。原因是 `--virtual-time-budget` 让虚拟时间快进，界面那个 5 秒握手的计时器先到了，不是插件的错。改成经 CDP、按真实时间等 4 秒再截，就正常了。但这暴露了一个问题：`npm test` 的 `blocks` 检查只确认 `/plugin-ui/pulse/heat.html` 答 200，**不检查页真的握手成功、真的画出来**。页里有脚本错误，测试照样过。格子图画得对，是靠截图人眼看出来的，没有自动测试。
2. **在 Claude Code 里跑主人命令**：环境里有 `CLAUDECODE` 和 `CLAUDE_CODE_SESSION_ID`，`plugin install` 被以 `agent-session` 拒绝，正是规范 4.1 说的那样。照 4.1 的 `env -u …` 做就行了，这里规范写得清楚。另外，环境里已经设了 `PNEUMA_BASE_HOME=../home`，在 work 外面，我改成了 `work/.pneuma-home`。
3. **终端确认没法用管道喂**：`echo yes | script -q /dev/null … pulse clear`，结果是「出错：Aborted with Ctrl+D」，退出码 1。这句话是英文，规范要求给人看的话是中文，这是内核的问题，不是插件的。规范只说了「不在终端里以 `not-confirmed` 拒绝」，没说在终端里、但输入马上结束时会怎样。后来改用 `expect` 真的打字：`no` 得到 `not-confirmed`、退出码 2；`yes` 清空、退出码 0。
4. 管理界面的接口 `/api/view` 的参数名，我先猜成 `id`，答复是 `view is missing`，改成 `view` 才对。这不在规范里（规范只给了 testkit 的 `viewer.view`），我直接 curl 才碰到。
5. 我自己的问题：zsh 不按空格拆变量，`$O $PB …` 整个被当成一条命令名，所以改成写 `trial-bin/owner` 这样的小脚本。
6. 我自己的问题：命令开头多写了一个 `cat > /tmp/x`，它等标准输入，挂了 5 分钟，被我停掉。

## 规范没写清楚、写错或互相打架的地方

1. **插件怎样「清空自己的记录」，规范没有答案，还和规则冲突。** 3.7 说「自己目录里已有的文件不得改写、不得删」，例外只有缓存目录和整份替换的配置文件。3.4 又列出「丢数据、不能撤回的」主人命令，要声明 `destructive`。可是一个插件要丢掉自己的数据，按 3.7 根本不许删文件。规范没说 `destructive` 的主人命令能不能破这个例，也没给「墓碑记录」这种做法。加上 `sync` 自带插件会「整份地复制文件，不丢内容」，在一台机器上删掉的文件，很可能又被同步回来。所以我选了追加清空记录。另外，**`writes` 检查只跑 `readOnly` 的命令，从不跑 `destructive` 的**，所以就算我直接删文件，`npm test` 也会全过。这条规则对破坏性命令既没说清，也没查。
2. 第 8 节「装载时核对什么」里有 `keeps`（`every`、`some`），规范正文别处一个字都没提。我是从 sdk 的 `types.d.ts` 注释里才知道它跟 `revise` 有关。
3. **规范里没有挪动（move）的命令行写法。** 3.2 说一次放可以是「登记、放入、挪」，可从来没给挪动的命令。我是从 `pneuma-base --help` 的 `put <文件|目录|-|库内路径> [--to <库内路径>]` 猜出 `put notes/b.md --to notes/b2.md`，看到输出「已挪到」才确认的。`--made`、`--brought` 是什么、为什么必填，规范也只在例子里出现，没有解释。
4. 规范第 1 节说要 `npm install --global`；没说装在本地也行。它还提到两个包文件「在 Pneuma Base 仓库的 `dist-packages/` 里」，`plugin new --help` 也说不写 `--packages` 时会去「构建这个命令行的仓库」里找。对只拿到包文件的人，这两处会把人往源码仓库引。
5. 3.5 说主人的 `actor` 是 `{ kind: 'owner' }`，没有名字；sdk 的 `RecordActor` 却要求 `name: string`。主人写的记录里 `name` 是什么，规范没说。
6. 规范没说视图代码按哪个时区算时间，也没说 `custom` 页里能不能拿到看的人的时区（`Cell` 的 `at` 倒是写明「按看的人的本地时间显示」）。按天统计的插件只能自己猜。
7. `refresh` 只说「读库外的东西的视图必须带」，没说读库里的东西、但内容随时间变的视图（比如「最近 30 天」）该不该带、带了算不算不当。
8. `onPut` 对「往已有路径放入不同内容」会不会调、调的时候 `kind` 是什么，规范的表格只说「接受了一次放」。我从类型里看到 `place` 带 `previous`，再加上真跑时会调，才确认会调。
9. 小地方：规范第 7 节的例子有 `configuration: []`，脚手架生成的 `test/conformance.test.ts` 没有这一项。

## 只能猜、没核实的

- 主人的记录里 `actor.name` 是什么（上面第 5 条），没有试。
- 两台机器同步时，清空记录和别处新写的记录能不能按 `at` 正确合并。按 recordStore 的说明应该没问题，但我没有真的同步过。`counted` 的纯函数测试覆盖了「清空之前的记录后来才同步进来」这种情况。
- 别的插件经 `ctx.tools.put` 放入时，我的 `onPut` 照样会记一笔，记在当时的行动者名下。没有试。
- 自带的 `ledger` 插件已经有一页「动态」（`ledger.activity`），和 pulse 可能有重叠。我只看到了它的视图编号，没有打开看它显示什么。

## 为了弄明白看了哪些不是规范的文件

- **sdk 的类型声明**（在 `pulse/node_modules/@pneuma-base/sdk/` 里）：`package.json`；`dist/index.d.ts`、`dist/kit/records.d.ts`、`dist/frame.d.ts`、`dist/testkit/sandbox.d.ts` 全文；`dist/types.d.ts` 读了第 1–60 行、185–424 行、560–699 行，另外 grep 了 `OwnerResult`、`OwnerCommand`、`ViewRequest`、`ViewAnswer`、`AcceptedPut` 等词。主要为了拿到 `AcceptedPut`、`AcceptedArchive`、`Envelope`、`RecordActor` 的确切形状，和 `viewer.act` 怎么用。
- **两个 tgz 的文件清单**（只看了文件名）。
- **脚手架生成的全部文件**：`package.json`、`README.md`、`scripts/build.mjs`、`tsconfig.json`、`src/index.ts`、`src/cognition.md`、`src/ui/panel.html`、两份测试。
- **命令行的帮助**：`pneuma-base --help`、`plugin new --help`、`--help --library`。
- **插件在 trial-lib 里写出的记录文件**（`.pneuma-base/pulse/activity/*.jsonl`），看格子，为了手写 demo 数据。
- **管理界面服务的接口答复**（`/api/view`、`/api/state`）和截图。
- 没读过：命令行和 sdk 的 `dist/*.js` 实现，Pneuma Base 的源码仓库，这台机器上别的同名目录。工作目录上一级的 `log.txt`、`prompt.txt`、`reply.md`，我只在第一次 `ls ..` 时看到了文件名，没有打开。
