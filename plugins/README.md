# 仓库外做出来的三个插件

这三个插件都不是这个仓库的工作区成员。每一个都是照第三方的做法做的：只依赖两个包文件（`dist-packages/` 里的命令行和 `@pneuma-base/sdk`），照 [`PLUGINS.md`](../PLUGINS.md) 写，不导入这个仓库的源码。放在这里有两个用处：给插件作者当例子，和当契约的回归测试——契约改坏了，它们的测试会红。

| 插件 | 做什么 | 怎么来的 |
| --- | --- | --- |
| [`space`](space/) | 把声明了可部署的东西发布到 PneumaSpace，带一页自己画的看板 | 插件标准就是从它反推出来的：先按旧契约试做，记下 55 条摩擦（`FRICTION.md`），再用开发包重做（`FRICTION-RESOLVED.md`） |
| [`links`](links/) | 检查库里文件之间的坏链接 | 一个没有任何上下文的 Codex 会话，只拿到两个包文件和 `PROMPT.txt` 里那段话；`NOTES.md` 是它记下的规范的缺口 |
| [`pulse`](pulse/) | 记录放入和归档，用自己画的热度图显示 | 同上，一个 Claude 会话 |

## 跑它们的测试

先在仓库根打出包文件，再进某个插件的目录：

```sh
pnpm build && pnpm pack:dist
cd plugins/links
npm install
npm test
```

`scripts/test-example-plugins.sh` 把三个都跑一遍，CI 里也跑它。`space` 的生命周期测试要一个在跑的 PneumaSpace，没有时自己跳过并说明；它的符合性检查用测试工具里的 HTTP 替身，不需要真服务。

`package-lock.json` 不进仓库：包文件每次重打，校验值都会变。
