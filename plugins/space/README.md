# space：把库里的网站发布到 PneumaSpace

agent 在库里做了一个网站，声明它可以部署；你打开开关，它就作为 PneumaSpace 上的一个应用上线。之后库里的内容变了，线上跟着换成新的一版；你关上开关，或者它被归档，它就从线上撤下。撤下不是删除：发布记录都还在，再打开就回来。

agent 只能声明，不能让东西上线；上不上线只由你决定。

## 两种 PneumaSpace

| 种类 | 是什么 | `--kind` |
| --- | --- | --- |
| 一台机器上的 PneumaSpace | 跑在你自己的电脑或服务器上（Docker），用它的管理地址发布 | `machine` |
| Cloudflare 上的 PneumaSpace | 装在你自己的 Cloudflare 账户里，用你的账户登录它的控制台接口发布 | `cloudflare` |

一个库同时只发到一处。换种类就是重新 `space target set`。

## Cloudflare 上的 PneumaSpace：按次序做

先要有：装好了命令行 `pneuma-base`，一个库（下面写作 `~/base`），和 PneumaSpace 安装器给你的凭据文件。安装器把它写在 `~/.pneuma-space/hosts/<你的域名>/` 下面，是一个写着 `origin`、`account`、`key` 的 JSON 文件。下面的例子里域名是 `space.example.com`，凭据文件是 `<凭据文件>`，换成你自己的。

1. 把插件装到这台机器，再在库里启用它。插件的目录是仓库里 `pnpm pack:plugins` 打出来的 `dist-packages/plugins/space`：

   ```sh
   pneuma-base plugin install dist-packages/plugins/space
   pneuma-base plugin add space --library ~/base
   ```

2. 告诉它发到哪里。`--prefix` 是应用名的前缀，这个库发布的每个应用都叫 `<前缀>-<路径>`：

   ```sh
   pneuma-base space target set --kind cloudflare --credentials <凭据文件> --prefix pb --library ~/base
   ```

   答复会说账户密钥从哪里来。密钥从不存进库里：没设别的时，每次发布从凭据文件读它。不想让插件读那个文件，就把控制地址和账户写出来，密钥另设在这台机器上（值从标准输入读，不显示）：

   ```sh
   pneuma-base space target set --kind cloudflare --origin https://space.example.com --account <账户> --prefix pb --library ~/base
   pneuma-base secret set space key
   ```

3. agent 做好网站、放进库里，再声明它可以部署（这一步是 agent 做的）：

   ```sh
   pneuma-base @<授权的名字> say deployable sites/shop
   ```

4. 你打开开关。答复里有网站的地址，`https://space.example.com/apps/pb-sites-shop/`：

   ```sh
   pneuma-base space on sites/shop --library ~/base
   ```

5. 看现在的样子，或者在管理界面里看：

   ```sh
   pneuma-base space list --library ~/base
   pneuma-base view ~/base
   ```

6. 不想让它在线了，关上开关：

   ```sh
   pneuma-base space off sites/shop --library ~/base
   ```

`pneuma-base space sync --library ~/base` 把所有声明过的东西对一遍，跑几遍结果都一样。发布到一半断了（比如网络断了），状态会是「待发布」，过后运行它就补上。

## 页面上的状态

管理界面里有两页：「PneumaSpace」是一张表，每样声明过的东西一行，带开关；「看板」是开着的站点各一张卡。

| 状态 | 意思 |
| --- | --- |
| 在线 | 开关开着，线上就是库里现在的内容 |
| 待发布 | 开关开着，但线上不是现在的内容：刚改过还没发上去，或者上次发布失败了。运行 `space sync` 再试 |
| 离线 | 开关关着，线上没有它 |
| 待下线 | 它不该在线，线上却还有：上次撤下失败了。运行 `space sync` 再试 |
| 已归档 | 它在库的归档区里，不在线；取回之后按开关来 |
| 不在 | 开关开着，但库里这个路径上已经没有东西 |
| 不知道 | 读不到 PneumaSpace（连不上、账户或密钥不对），所以什么都没做；页面上写着原因 |

条目面板里还有：版本（线上是第几版）、请求（PneumaSpace 记下的访问次数）、最近访问、它在 PneumaSpace 里的状态、上传额度用了多少，和发布记录。一个名字已经被别人的应用占着时，页面写出是谁的，插件不碰它。

Cloudflare 上的站点只给登录了那个 PneumaSpace 的账户看，所以管理界面里没有它的预览，只有地址：在新标签页打开它，浏览器先要登录 `https://space.example.com`。

## 限制

Cloudflare 上的 PneumaSpace 有这些限制，插件在发布之前就按它们拒绝，说出数字和上限：

- 一个网站最多 256 个文件。
- 打包之后最多 4 MiB。文件按 base64 打进包里，比原来大三分之一，所以网站本身大约 3 MiB 就到顶了。
- 每个应用一生最多上传 200 次，上传的包合计也不能超过这个应用分到的存储（默认 10 MiB）。内容没变不上传；内容回到以前发布过的样子，直接放回那一版，也不上传。额度用完了，只有在 PneumaSpace 上清除这个应用才能重来，它的发布记录会一起清掉。
- 一个空间能有的应用数有上限（默认 5 个，管理员能调高）。撤下的应用也占着位置。
- 只给登录了的账户看，不是公开网站。
- 插件每次运行登录一次、用完退出。PneumaSpace 不让一台机器十分钟里登录超过 40 次，所以页面每分钟才重取一次。

一个库只装得上一个部署插件：几个部署插件都认「可以部署」这句话，装第二个会被拒绝。

## 一台机器上的 PneumaSpace

```sh
pneuma-base space target set --kind machine --admin http://127.0.0.1:8081 --prefix pb --library ~/base
pneuma-base secret set space token   # 只有那台 PneumaSpace 不在本地模式时才要
```

站点在 PneumaSpace 的入口端口上，地址不是管理地址的主机时用 `--public <地址>` 写出来。这一种的看板上有每个站点的小预览和过去 24 小时每小时的请求。

## 开发

```sh
npm install
npm test                     # 构建，再跑符合性检查（两种各一遍，用内存里的替身）、Cloudflare 的替身测试，和一台机器上的生命周期、页面测试（要验收栈，没有时跳过）
PNEUMA_SPACE_CF_CREDENTIALS=<凭据文件> node --test test/cloudflare-live.test.ts   # 对真的 Cloudflare 上的 PneumaSpace 走一遍生命周期
sh scripts/proof.sh          # 一台机器上的演示
npm run shots -- <目录>       # 看板和条目面板的截图
```

测试建的应用都叫 `pbs-…`，用自己的前缀，结束时撤下并清除，失败了也一样。真实的生命周期测试每跑一次用掉两次上传，并等清除完成（约三分钟）再退出。`FRICTION.md` 记着第一版的摩擦，`FRICTION-RESOLVED.md` 记着重做之后剩下的。
