## 溯源：条目的来源、依据与经手者

此资料库已启用**溯源**插件。它记录每个条目由哪次会话、哪个 Agent、在哪个目录、为什么任务添加，以及依据了哪些条目。一次工作分三步。

**1. 开始：说明当前任务。**

```sh
pneuma-base @{{授权的名字}} start "给电子书小店选支付服务"
```

资料库记录这条任务描述，并返回两部分：上次会话以来其他执行者的操作；资料库中可能与此任务相关的已有条目。有相关条目时直接使用，不重复制作。与当前任务无关的变化无需转告所有者。任务改变时，再执行一次 `start`。

**2. 搜索和查看。**

```sh
pneuma-base @{{授权的名字}} find 支付
pneuma-base @{{授权的名字}} inspect payments/comparison.md
```

`find` 也按字面匹配路径、备注、任务描述和原始来源，中文、英文各搜索一次。`inspect` 返回一个条目的执行者、时间、工作目录、任务、依据的条目、引用它的条目，以及所有者的决策。

**3. 添加，并写明依据。**

```sh
# 导入：内容由调用方提供，资料库不会自行抓取。添加时间自动记录。
curl -s https://stripe.com/pricing | pneuma-base @{{授权的名字}} put - \
  --to payments/sources/stripe-pricing.html --imported --source https://stripe.com/pricing

# 生成：只写结论真正依据的条目，不写所有读过的。资料库中的条目用 --from，外部依据用 --from-external 写一句说明。
pneuma-base @{{授权的名字}} put ./comparison.md --to payments/comparison.md --generated \
  --from payments/sources/stripe-pricing.html payments/sources/paddle-pricing.html \
  --from-external "所有者在对话中说明：客户主要在欧洲"
```

添加时可加 `--note "<说明>"`，写明这次添加修改了什么。

所有者提供的文件，用 `--imported --by owner`。所有者做出决定时，添加一条决策：

```sh
pneuma-base @{{授权的名字}} say decision "所有者决定使用 Paddle，因为它代为处理欧洲的税务"
```

条目内容被替换时，旧内容存入**历史副本**。历史副本仅所有者可恢复，Agent 无需处理。

`check` 还会列出：依据的条目已修改、可能已过期的条目；来源缺失的条目；未登记的文件；外部修改的文件。这些无需自动处理，与当前任务相关时告知所有者。补录用以下命令：

| 用法 | 作用 |
| --- | --- |
| `say note "<说明>"` 或 `say note <库内路径> "<备注>"` | 为本次会话或一个条目添加备注 |
| `say basis <库内路径> --from <库内路径…>` | 补充依据：该条目依据了哪些条目 |
| `put <库内路径> --imported …` 或 `--generated …` | 为未登记的文件补充来源；标有「自动登记」的来源有误时，也用此命令更正 |
| `say revised <库内路径>`（所有者说明是自己修改的，加 `--by owner`） | 确认修改：文件已被直接修改，确认这次修改；标有「自动登记」的修改是 Agent 做的，也用此命令确认 |
