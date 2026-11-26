# 存储提供者

库建在存储抽象上（`STORAGE.md`）。讲这份契约、答得出 `describe` 的任何可执行程序都是一个**存储提供者**。库的地址有写法，每种写法由装在这台机器上的一个提供者来答；内核通往存储的那扇门启动答这个库的那一个。这份文件写提供者在这台机器上怎么登记、怎么装、怎么跑，和一个提供者的仓库要带的清单。

## 地址的写法

| 地址 | 写法 |
| --- | --- |
| `<scheme>://…` | `<scheme>`，小写字母开头，只用小写字母、数字和 `+`、`.`、`-` |
| 别的一切 | `path`：这台机器上的一个文件夹，相对路径从当前目录算，`~` 是家目录 |

提供者在 `describe` 的 `addresses` 里列出它答的写法。`pneuma-base init <地址>` 按地址的写法选提供者：`--provider <名字>` 写了就用它（它要答这种写法）；没写时，这个安装自带的答它就用自带的，否则答它的只有一个就用那一个，有几个就要写 `--provider`。

## 门怎么跑一个提供者

```
<程序> <操作> --root <地址> [<请求 JSON> | -]
<程序> serve --root <地址>
```

和 `core/README.md` 写的本机文件夹的程序一样，只是 `--root` 给的是库的地址：文件夹是它的真实路径，别的写法照写。答复、`serve` 的行协议、失败的 `reason` 都按 `STORAGE.md` 和 `core/README.md`。内核为一个库在一个进程里只起一个 `serve`；常驻的进程（管理界面的服务、Mac 应用）在里面 `subscribe`。

## 这台机器上的登记

```
$PNEUMA_BASE_HOME/storage/
  providers/<名字>/provider.json      一个装上来的提供者：登记处里的一条
  providers/<名字>/<版本>/<文件>       它的可执行文件
  libraries/<键>.json                 一个库用的是哪个提供者：{ "address", "provider" }，键是地址的 sha256 的前 32 位
  tmp/                                装到一半的东西；一个小时以上没动的，下一次装时清掉
```

`provider.json`：

```json
{
  "format": 1,
  "name": "s3-bucket",
  "version": "v0.3.0",
  "contract": 1,
  "addresses": ["s3"],
  "executable": "v0.3.0/pneuma-base-s3-darwin-arm64",
  "sha256": "…",
  "official": false,
  "installed": "2026-11-27T08:00:00.000Z",
  "from": { "repository": "acme/pneuma-base-s3", "tag": "v0.3.0" }
}
```

- `executable` 相对于这个提供者的目录。登记那一条是最后写的，先写临时名再改名；写下它，提供者才算装上。中途断了、校验不过、契约测试不过，`providers/` 里什么都不留。
- 这个安装自带的提供者（本机文件夹，`local-folder`）不写进登记处：它就是内核旁边的那个程序，随安装来，所以应用挪了位置也不会指错。`storage list` 照样列出它，带程序的位置和这台机器算出的校验和。
- 一个库用哪个提供者记在 `libraries/` 下，一个库一个文件，建库时写。没有记录的库（在别的机器上建的、这一版之前建的）用答它的地址写法的那一个，自带的优先。库自己的声明要先有存储才读得到，所以记在机器上，不记在库里。

## 命令

都只给主人；`storage install` 和 `storage update` 也不能被 agent 用 `ask` 请：信任的那一句要主人自己看、自己认。

| 命令 | 做什么 |
| --- | --- |
| `storage list` | 自带的和装上来的提供者：版本、来历、官方与否、答哪种写法、契约版本、程序、校验和；带 `--library` 时标出这个库用的；然后是官方的、没装的，各带装它的命令 |
| `storage install <owner>/<repo>[@<版本>] [--checksum <sha256>]` | 从那个仓库的发布装一个（下一节） |
| `storage remove <名字>` | 拿掉一个装上来的；答复列出这台机器上用它的库，它们要再装上它才打开得了 |
| `storage update <名字> [--checksum <sha256>]` | 第三方的换成仓库最新的发布，官方的换成官方名单里的版本；和装一样先验 |

配置页的「存储」一节是同几条命令的表单：每个装上来的带「换新版本」「卸掉」，官方没装的带「装上」，最后是「安装别的存储…」，填一个仓库。

## 装一个

1. 取清单：`<发布的主机>/<owner>/<repo>/releases/download/<版本>/pneuma-base-provider.json`；没写版本时取 `…/releases/latest/download/pneuma-base-provider.json`，版本就钉在清单写的那一个上。发布的主机是 `https://github.com`，`PNEUMA_BASE_RELEASE_HOST` 可以换成按同样路径给文件的另一个主机（测试用这台机器上的一个）。
2. 看清单：格式对、契约版本是这个 pneuma-base 讲的（现在是 1），有这台机器（`darwin-arm64`）的程序；名字不是自带的，也不是这台机器上来自别的仓库的另一个。
3. 主人认下：第三方的，先说存储提供者是什么，再写明仓库、版本和校验和：「存储提供者是一个以你的身份运行的程序，看得到库里的全部内容。要装的是 acme/pneuma-base-s3 的 v0.3.0，校验和 sha256:…。」终端里输入 `yes` 认下；不在终端里（页面、应用），拒绝的答复带这句话和一个按钮，按钮就是带上 `--checksum <那个校验和>` 再跑一次。`--checksum` 写的是主人看过、认下的那个程序；发布在这中间变了，以 `checksum-changed` 拒绝。官方的不问：它的校验和随安装包带着。
4. 取程序：清单里这台机器的那个文件，边取边算 sha256，对不上清单（官方的，对不上官方名单）就拒绝。
5. 问程序：在一个空的临时文件夹上跑 `describe`，名字、答的写法要和清单一样，契约版本要是 1。
6. 契约测试：`pneuma-base-contract --provider <程序>`，按 `STORAGE.md` 逐句核对，约半分钟。没过的那几句各自再单独跑一次（有几句要计时，机器忙时会慢一点）；再跑还没过就拒绝，答复列出没过的几项。
7. 放好：程序挪到 `providers/<名字>/<版本>/`，再写登记的那一条；同一个提供者的别的版本拿掉。

拒绝的理由：`unreachable`（连不上，或取到一半断了）、`no-release`、`bad-manifest`、`contract-version`、`no-executable`、`built-in`、`name-taken`、`not-confirmed`、`checksum-changed`、`checksum`、`describe`、`contract-unmet`。

## 清单：一个提供者的仓库要带的文件

仓库的根上放 `pneuma-base-provider.json`，每次发布把它作为同名的附件挂上，和各平台的程序放在同一个发布里。装的时候读的是发布里的那一份。

```json
{
  "format": 1,
  "name": "s3-bucket",
  "version": "v0.3.0",
  "contract": 1,
  "addresses": ["s3"],
  "summary": "把库放在一个 S3 桶的前缀下",
  "executables": {
    "darwin-arm64": { "asset": "pneuma-base-s3-darwin-arm64", "sha256": "…64 位小写十六进制…" },
    "linux-x64": { "asset": "pneuma-base-s3-linux-x64", "sha256": "…" }
  }
}
```

| 字段 | 要求 |
| --- | --- |
| `format` | `1` |
| `name` | 提供者的名字：小写字母开头，只用小写字母、数字和连字符，最长 41 个字符；和 `describe` 答的 `name` 一样 |
| `version` | 这次发布的标签，和清单所在的发布一致；`storage install <owner>/<repo>@<版本>` 写的就是它 |
| `contract` | 它讲的 `STORAGE.md` 的版本 |
| `addresses` | 它答的地址写法，至少一个；和 `describe` 答的一样 |
| `summary` | 可选，一句话说它是什么 |
| `executables` | 平台（Node 的 `process.platform` 和 `process.arch` 用 `-` 连起来）到这次发布里的一个附件：`asset` 是附件的文件名（字母、数字和 `.`、`_`、`+`、`-`），`sha256` 是它的字节的 sha256 |

程序是一个可以直接运行的文件。装上之后它以主人的身份运行，`--root` 给它一个库的地址。

## 官方名单

`official-providers.json` 在内核的包里，随安装包更新。一条是名字、一句话、答的写法、仓库、版本、`builtIn`（这个安装自带它）和各平台的 sha256。打包（`scripts/pack-dist.mjs`）给自带的那一条填上版本和本平台程序的 sha256。现在名单里只有本机文件夹，标着自带。`PNEUMA_BASE_OFFICIAL_PROVIDERS` 可以换成另一份名单（测试用）。

## 平台

这一版的产品只有 Apple 芯片的 Mac：安装包和应用带的是 `darwin-arm64` 的本机文件夹提供者和契约测试的程序，内核旁边的 `bin/platform` 写着 `darwin-arm64`。在别的机器上运行，命令行只说一句「这个 pneuma-base 是给 Apple 芯片的 Mac (darwin-arm64) 构建的，这台机器是 …。」就退出。CI 的机器是 Linux：在那里打的包带 Linux 上构建的程序，只给测试用。
