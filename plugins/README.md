# 照第三方的做法写的两个插件

这两个插件不是这个仓库的工作区成员。它们只依赖两个包文件（`dist-packages/` 里的命令行和 `@pneuma-base/sdk`），照 [`PLUGINS.md`](../PLUGINS.md) 写，不导入这个仓库的源码。它们是插件作者的例子，也是契约的回归测试：契约改坏了，它们的测试会失败。

| 插件 | 做什么 | 怎么来的 |
| --- | --- | --- |
| [`links`](links/) | 检查资料库里文件之间的坏链接 | 一个没有任何上下文的 Codex 会话，只拿到两个包文件和 `PROMPT.txt` 里那段话；`NOTES.md` 是它记下的规范的缺口 |
| [`pulse`](pulse/) | 记录添加和归档，用自己画的热度图显示 | 同上，一个 Claude 会话 |

## 跑它们的测试

先在仓库根打出包文件，再进某个插件的目录：

```sh
pnpm build && pnpm pack:dist
cd plugins/links
npm install
npm test
```

`scripts/test-example-plugins.sh` 把两个都跑一遍，发版的 Full 工作流（`.github/workflows/full.yml`）跑它。

`package-lock.json` 不进仓库：包文件每次重打，校验值都会变。

## 只安装不改

只想用一个插件、不改它的人，不用进插件目录装依赖。在仓库根打出包文件，再把每个插件构建好：

```sh
pnpm build && pnpm pack:dist && pnpm pack:plugins
```

`pack:plugins` 把每个插件写到 `dist-packages/plugins/<名字>/`，这就是 `plugin install` 要的目录：

```sh
pneuma-base plugin install dist-packages/plugins/links
pneuma-base plugin enable links --library ~/base
```
