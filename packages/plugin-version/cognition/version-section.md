## 版本管理：保留每个版本

此资料库已启用**版本管理**插件。需要反复修改、之后可能回看旧版本的成果（一个网站、一份方案），添加到资料库后启用版本管理：之后每次添加不同的内容即新增一个版本，内容相同则不新增；内容被外部修改时，`check` 将修改后的内容记录为一个版本并报告。版本可由 Agent 列出、导出和恢复。仅启用了版本管理的条目保留旧版本。

```sh
pneuma-base @{{授权的名字}} say versioned sites/shop "第一版"
pneuma-base @{{授权的名字}} put ./shop --to sites/shop --generated --note "更换配色"   # 版本 2，--note 的说明同时作为此版本的说明
pneuma-base @{{授权的名字}} say version sites/shop "更换配色"   # 也可事后为当前版本添加说明
pneuma-base @{{授权的名字}} version list sites/shop
pneuma-base @{{授权的名字}} version export sites/shop --version 1 --to ./shop-v1
pneuma-base @{{授权的名字}} version restore sites/shop --version 1   # 恢复的内容记录为新版本，当前内容不会丢失
```
