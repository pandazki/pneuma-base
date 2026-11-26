# pulse：库的活动热度

Pneuma Base 插件。每次有东西被放进库（登记、放入、换新内容）或被归档，记一笔：谁、什么时候、哪样东西。挪动、取回、已经在归档区的再归档不算。

- 管理界面的「活动热度」一页（`pulse.heat`）：最近 30 天每天的次数画成格子（`src/ui/heat.html`，颜色只用界面给的变量，跟着深浅色走），下面按 agent 列出次数，最后是「清空记录」按钮。
- 主人命令 `pulse clear`：清空全部记录。它是 `destructive`：agent 的会话里被拒绝；终端里要输入 `yes`；界面里先问一句。
- 认知段告诉 agent 它的放入和归档会被记下，只有主人能清空。

## 存储

记录在库的记录处（`ctx.tools.storage.records`），用 sdk 的 `recordStore`，只追加：两个记录库，每条带着库名（`store`）。

| 记录库 | 一条是 |
| --- | --- |
| `activity` | `{ what: 'put' \| 'archive', path }`，加上 `id`、`at`、`actor`、`session` |
| `clears` | `{ cleared: true }`，加上同样的信封 |

存储把它们写在 `<库>/.pneuma-base/pulse/facts/` 下。以前的版本写在 `activity/`、`clears/` 两个目录里的记录，`recordStore` 读的时候一起读进来，照算。

清空不删记录（规范 3.7 不许改写、删除自己目录里已有的文件）：它写一条清空记录，`at` 不晚于最近一次清空的活动都不再算。同步过来的旧记录也一样不算。登记一个目录这一层的散文件时，每个文件算一次。

按天分组用的是跑视图的进程（`pneuma-base view`）所在机器的本地时区。

## 命令

```sh
npm install
npm test                 # 构建，跑符合性检查和 test/plugin.test.ts
npm run install-local    # 装到 $PNEUMA_BASE_HOME/plugins/pulse/（只有主人能做）
pneuma-base plugin add pulse --library <库的目录>
```

规范在 `node_modules/pneuma-base/PLUGINS.md`。
