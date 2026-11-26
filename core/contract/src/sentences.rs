//! Every sentence of `STORAGE.md` (contract version 1), in its order, with the id the checks are
//! keyed by. A table cell counts as a sentence; the object-store column is not behaviour and is
//! left out. A sentence no outside check can decide carries the reason instead of checks.

pub struct Sentence {
    pub id: &'static str,
    /// The sentence as `STORAGE.md` writes it; a table row's cells are joined with ` | `.
    pub text: &'static str,
    /// Why no check run against the executable can decide it; `None` when checks decide it.
    pub not_checkable: Option<&'static str>,
}

const fn checked(id: &'static str, text: &'static str) -> Sentence {
    Sentence {
        id,
        text,
        not_checkable: None,
    }
}

const fn outside(id: &'static str, text: &'static str, why: &'static str) -> Sentence {
    Sentence {
        id,
        text,
        not_checkable: Some(why),
    }
}

const KERNEL: &str = "a duty or a choice of the kernel, which this suite does not run";
const COST: &str = "a bound on cost, not on an answer; the benchmark (core/bench) times it";

pub const SENTENCES: &[Sentence] = &[
    // Preamble
    outside(
        "0.1",
        "领域建在它上面；它的每个操作都是领域需要问的一个问题。",
        "says why the operations exist, not what a provider answers",
    ),
    outside(
        "0.2",
        "它归领域所有，不归哪个实现所有。",
        "says who owns the contract, not what a provider answers",
    ),
    outside(
        "0.3",
        "今天的实现只有一个：本机文件夹，`pneuma-base-core`（Rust）。",
        "a fact about this repository, not about a provider's answers",
    ),
    outside(
        "0.4",
        "一个实现叫一个**存储提供者**：任何讲这份契约的可执行程序都是。",
        "a definition; this suite is how a program shows that it speaks the contract",
    ),
    checked(
        "0.5",
        "库的地址有写法，每种写法由装在这台机器上的一个提供者来答。",
    ),
    outside(
        "0.6",
        "这份文件是内核与存储之间唯一的契约。",
        "about what the kernel may rely on, not what a provider answers",
    ),
    checked("0.7", "它带版本（现在是 1）。"),
    checked(
        "0.8",
        "实现以一个命令行程序的形式提供：每个操作是一条读写 JSON 的子命令，同一批操作也可以经一个常驻进程按行收发（`serve`）。",
    ),
    outside(
        "0.9",
        "实现的测试只驱动这个程序，按这份文件逐句核对。",
        "describes this suite itself, which drives only the program",
    ),
    // 1. Words
    checked(
        "1.storage",
        "存储 | 一个库所在的地方。分两半：放东西的地方，放记录的地方",
    ),
    checked(
        "1.place",
        "位置 | 放东西的地方里的一个点，用 `/` 分隔的相对路径写，不以 `/` 开头，不含 `.` 和 `..` 段",
    ),
    checked(
        "1.kind",
        "种类 | `file`、`dir`、`other`（链接、设备等，库不把它们当东西）、`none`（没有）",
    ),
    checked("1.level", "一层 | 一个 `dir` 位置直接含有的那些位置"),
    checked(
        "1.token",
        "状态令牌 | 存储对一个位置当前状态的不透明标记。内核只保存它、交回来比较，不解读",
    ),
    checked(
        "1.facet",
        "面 | 关于一个位置的一组元数据，来自一个了解它的来源。一个位置上可以有多个",
    ),
    checked(
        "1.content",
        "内容 | 一个 `file` 的字节；它的指纹是这些字节的 SHA-256",
    ),
    checked("1.cursor", "游标 | 存储对「到此为止的变化」的不透明标记"),
    checked(
        "1.record-place",
        "记录处 | 放记录的地方里的一个命名空间。名字由内核给，存储不知道它属于谁",
    ),
    checked(
        "1.fact",
        "事实 | 记录处里只追加的一条记录，一段 JSON，带存储给的次序",
    ),
    checked(
        "1.row",
        "行 | 记录处里可覆盖、可查询的一条数据，由记录处的主人从事实得出",
    ),
    checked(
        "1.noise",
        "噪音 | 存储不报告、不进入的位置，按库根上声明的名字和路径判",
    ),
    // 2. Rules
    outside(
        "2.0",
        "任何实现都要守。",
        "introduces the rules below, each checked on its own",
    ),
    checked("2.1", "**不下探。** 列出只列一层。"),
    checked(
        "2.2",
        "**有界。** 每个会列出或计数的操作都有上限；到上限就停，答「至少」。",
    ),
    checked("2.3", "**变化靠游标。** 没有哪个操作靠遍历去发现变化。"),
    checked(
        "2.4",
        "**内容只在被要求时读。** 只有 `content`、`read`、`write`、`copy` 读写字节。",
    ),
    checked(
        "2.5",
        "**写带预期。** 预期不成立时不改任何东西，答 `refused` 和现状。",
    ),
    checked(
        "2.6",
        "**读带令牌。** `read` 和 `content` 的答复带所读那一版的令牌。",
    ),
    checked(
        "2.7",
        "**噪音不报、不进。** 对噪音位置的任何操作答 `noise`。",
    ),
    checked(
        "2.8",
        "**缓存可删。** 实现可以有缓存；删掉后答复不变，只变慢。",
    ),
    checked(
        "2.9.1",
        "**并发与中断。** 多个进程同时操作不损坏任何东西、不死锁；",
    ),
    checked("2.9.2", "一次写要么完成，要么等于没发生。"),
    checked(
        "2.10",
        "**答复是数据。** 每个答复是 JSON，失败也是，带固定的 `reason`；没有给人看的句子。",
    ),
    // 3. A place's description
    checked("3.1", "`glance` 和 `overview` 里的每个条目都是这个形状："),
    checked("3.2", "中性的部分是 `kind`、`token`、`size`、`modified`。"),
    outside("3.3", "内核的逻辑只许依赖这些。", KERNEL),
    checked("3.4", "`dir` 的 `size` 是它这一层的条目数。"),
    checked("3.5", "`facets` 是可有可无的。"),
    checked("3.6", "每个面有自己的名字和字段，在第 7 节列出；"),
    outside(
        "3.7",
        "不认识的面原样传递。",
        "a duty of the kernel, which receives the facets",
    ),
    checked("3.8.1", "取面守同样的规则：不下探、有界、"),
    checked("3.8.2", "不为了看一眼而走网络、不触发占位文件的下载。"),
    checked("3.9", "代价更高的面要按名字单独要。"),
    outside(
        "3.10",
        "**令牌是组合键。** 实现把各来源给的分量拼成令牌。",
        "the token is opaque to its caller: how a provider composes it is not visible from outside",
    ),
    checked("3.11", "比较由实现做，规则固定："),
    checked("3.12", "双方都有的分量里任何一个不同，就是变了。"),
    outside(
        "3.13",
        "一方没有的分量不参与比较。",
        "needs a token with a component taken away or added, which means taking the opaque token apart",
    ),
    outside(
        "3.14",
        "标明「标识内容」的分量相同，则内容相同；`content` 可以直接据此回答，不读字节。",
        "which component identifies content is not visible from outside, and answering without reading bytes is a permission, not a duty",
    ),
    // 4. The content half: the table
    checked("4.glance.input", "位置的列表"),
    checked("4.glance.answer", "每个位置一个描述；没有的是 `kind: none`"),
    outside("4.glance.cost", "位置的个数", COST),
    checked(
        "4.overview.input",
        "位置、`limit`（默认 200）、`after`（续页）",
    ),
    checked(
        "4.overview.answer",
        "`entries`、`more`（`at_least` 和续页用的 `after`）、`total`（实现能便宜地给出时）",
    ),
    outside("4.overview.cost", "`limit`", COST),
    checked("4.probe.input", "位置、`budget`（默认 500）"),
    checked(
        "4.probe.answer",
        "在预算内数到的文件数、目录数、字节数，`exceeded`，顶层发现的标记名",
    ),
    outside("4.probe.cost", "`budget`", COST),
    checked("4.look.input", "「位置、令牌」的列表"),
    checked(
        "4.look.answer",
        "每个位置：`same`、`changed`（带新描述）、`gone`",
    ),
    outside("4.look.cost", "位置的个数", COST),
    checked("4.changed.input", "游标（没有则只取当前游标）"),
    checked(
        "4.changed.answer",
        "`places`（位置，粒度可以是它所在的目录）和新游标；或 `cannot_say`（这段时间的日志不可靠）和新游标",
    ),
    outside("4.changed.cost", "变化的个数", COST),
    checked("4.content.input", "位置；目录另带内容规则和文件数上限"),
    checked("4.content.file", "文件：指纹、令牌、大小。"),
    checked("4.content.dir", "目录：清单的指纹、文件数、令牌；"),
    checked("4.content.too-many", "超过上限答 `too_many` 和至少的个数。"),
    checked("4.content.progress", "过程中发进度"),
    outside("4.content.cost", "内容的大小；有标识内容的分量时为零", COST),
    checked("4.read.input", "位置、可选的范围"),
    checked("4.read.bytes", "字节和令牌；"),
    checked(
        "4.read.elsewhere",
        "内容不在本机时先答 `elsewhere` 和大小，带 `fetch: true` 再要才取",
    ),
    outside("4.read.cost", "所读的大小", COST),
    checked(
        "4.write.input",
        "位置、来源（库外的路径或标准输入）、预期（`empty` 或一个令牌）、来源是目录时的内容规则",
    ),
    checked(
        "4.write.answer",
        "新描述和指纹（同一趟算出）；预期不成立答 `refused` 和现状",
    ),
    outside("4.write.cost", "内容的大小", COST),
    checked("4.move.input", "两个位置、对两头的预期"),
    checked("4.move.answer", "新描述；不成立答 `refused` 和现状"),
    outside(
        "4.move.cost",
        "常数（同一存储内能原子改名时）；否则随大小",
        COST,
    ),
    checked("4.remove.input", "位置、预期的令牌"),
    checked("4.remove.answer", "`removed`；不成立答 `refused`"),
    outside("4.remove.cost", "常数；目录按其大小，", COST),
    checked("4.remove.progress", "发进度"),
    // 4. Notes
    checked(
        "4.s1",
        "`overview` 的条目按名字的字节序排序，目录和文件混排；目录可以按名字后加 `/` 参与比较（对象存储的键序就是这样）。",
    ),
    checked(
        "4.s2",
        "`after` 是上一页答复给出的 `more.after`，调用方原样交回，不解读。",
    ),
    checked(
        "4.s3",
        "噪音条目不出现，但答复里给出被略去的噪音名字的列表（只是名字，不进去）。",
    ),
    checked(
        "4.s4",
        "`probe` 发现的标记是顶层几个众所周知的文件名（`package.json`、`.git`、`pyproject.toml`、`Cargo.toml`、`go.mod` 等），由实现列出；",
    ),
    outside("4.s5", "内核据此判断它像不像一个项目。", KERNEL),
    checked("4.s6", "`changed` 的粒度由存储定。"),
    outside(
        "4.s7",
        "答的是目录时，内核对那个目录做一次 `overview` 或对其中登记过的位置做 `look`，不往下走。",
        KERNEL,
    ),
    checked(
        "4.s8",
        "内容规则：除去噪音名字，以及目录自带的忽略文件（`.gitignore`）排除的。",
    ),
    checked("4.s9", "规则由调用方作为参数给出，存储照做，不自己决定。"),
    outside(
        "4.s10",
        "有名字的全量动作在存储里就是对一组位置依次 `content`；",
        KERNEL,
    ),
    checked("4.s11", "存储不提供「对整个库做什么」的操作。"),
    // 5. The record half: the table
    checked(
        "5.facts.append.input",
        "记录处的名字、一条或多条事实（JSON）",
    ),
    checked("5.facts.append.answer", "每条事实得到的次序标记"),
    outside("5.facts.append.cost", "条数", COST),
    checked("5.facts.since.input", "记录处、游标、`limit`"),
    checked("5.facts.since.answer", "事实（按次序）和新游标"),
    checked("5.facts.since.cost", "新事实的条数，与已有总数无关"),
    checked("5.rows.put.input", "记录处、表名、行（键、可查的字段、值）"),
    checked("5.rows.put.answer", "完成"),
    outside("5.rows.put.cost", "行数", COST),
    checked("5.rows.get.input", "记录处、表名、键的列表"),
    checked("5.rows.get.answer", "行"),
    outside("5.rows.get.cost", "键的个数", COST),
    checked("5.rows.under.input", "记录处、表名、前缀、`limit`、`after`"),
    checked("5.rows.under.answer", "一页行，和 `more`"),
    outside("5.rows.under.cost", "`limit`", COST),
    checked(
        "5.rows.where.input",
        "记录处、表名、字段、值、`limit`、`after`，可只要个数",
    ),
    checked("5.rows.where.answer", "一页行或个数"),
    outside("5.rows.where.cost", "`limit`", COST),
    checked("5.rows.reset.question", "清空这个记录处的行和它的事实游标"),
    checked("5.rows.reset.answer", "完成"),
    outside("5.rows.reset.cost", "常数", COST),
    // 5. Notes
    checked(
        "5.s1",
        "事实是本体：只追加，随库同步，多个写入者同时写不冲突（各写各的文件）。",
    ),
    checked(
        "5.s2",
        "`facts.since` 的代价不能随已有事实的总数增长，所以事实文件按日期分目录存放；旧版式（不分日期）仍然读。",
    ),
    checked("5.s3", "行是缓存：不同步，可以整个删掉。"),
    outside(
        "5.s4",
        "记录处的主人的做法固定是「读游标之后的事实，折进行里，存下新游标」。",
        KERNEL,
    ),
    checked("5.s5", "游标和行在同一次提交里更新。"),
    checked(
        "5.s6",
        "可查的字段在 `rows.put` 时随行给出，每张表最多 4 个，值是字符串。",
    ),
    outside(
        "5.s7",
        "存储不理解它们。",
        "what the storage understands is internal; how the fields behave outside is checked under 5.s6",
    ),
    checked("5.s8", "不提供任意查询。"),
    outside("5.s9", "需要别的问法，就多维护一张表。", KERNEL),
    // 6. Other operations
    checked(
        "6.init.1",
        "`init` | 在一个位置上建立库的记录区和缓存区，写下默认的噪音名单。",
    ),
    checked("6.init.2", "已是库则什么都不改"),
    checked(
        "6.describe.1",
        "`describe` | 这个提供者是什么：名字、版本、契约版本、它答哪种写法的地址、能不能给出可靠的游标、能给哪些面。",
    ),
    outside("6.describe.2", "内核靠它决定用不用这个提供者", KERNEL),
    checked(
        "6.noise",
        "`noise.list`、`noise.add`、`noise.remove` | 读和改库根上声明的噪音名字与路径",
    ),
    checked(
        "6.hold.1",
        "`hold`、`release` | 声明「这个位置正在被写入，记录随后就到」，带存活时间；",
    ),
    checked(
        "6.hold.2",
        "`look` 和 `overview` 把被声明的位置标成 `held`。",
    ),
    outside(
        "6.hold.3",
        "给内核在「东西已放好、事实还没写」之间用",
        KERNEL,
    ),
    checked(
        "6.serve.1",
        "`serve` | 常驻模式：每行一个带 `id` 的请求，答复带同一个 `id`；",
    ),
    checked("6.serve.2", "长操作先发若干条进度再发结果；"),
    checked("6.serve.3", "可按 `id` 取消"),
    // 7. The local folder's facets and token
    checked("7.fs", "`fs` | `inode`、`device`、`created`、`mode` | 总有"),
    checked(
        "7.macos",
        "`macos` | `where_from`（下载来源的地址）、`quarantine`（由哪个程序带进来）、`tags` | macOS 上，位置带有这些属性时",
    ),
    checked(
        "7.placeholder",
        "`placeholder` | `provider`（能认出时）、`size_elsewhere` | 同步服务只在本机留了占位、内容不在本机时",
    ),
    checked(
        "7.token.1",
        "令牌的分量：`size`、`modified`、`changed`、`inode`。",
    ),
    outside(
        "7.token.2",
        "本机实现没有标识内容的分量；",
        "which components a token has is not visible from outside: the token is opaque",
    ),
    checked(
        "7.racy",
        "一个位置在写入后的极短时间内被再次修改时，实现按不可信处理，下一次比较时读内容确认。",
    ),
    // 8. Failures
    checked(
        "8.1",
        "每个失败的答复是 `{ \"outcome\": \"failed\" | \"refused\", \"reason\": \"…\", … }`。",
    ),
    checked("8.2", "`reason` 的取值固定："),
    checked("8.no_such_place", "`no_such_place`"),
    checked("8.not_a_dir", "`not_a_dir`"),
    checked("8.not_a_file", "`not_a_file`"),
    checked("8.noise", "`noise`"),
    checked("8.outside", "`outside`（位置指到了库外）"),
    checked("8.refused", "`refused`（预期不成立，带 `actual`）"),
    checked("8.too_many", "`too_many`（带 `at_least`）"),
    checked("8.elsewhere", "`elsewhere`（内容不在本机，带大小）"),
    checked("8.held", "`held`（位置正被别人写入）"),
    checked("8.cannot_say", "`cannot_say`（只用于 `changed`）"),
    checked(
        "8.unreadable",
        "`unreadable`（存储读不了它，带系统给的原因）",
    ),
    checked("8.bad_request", "`bad_request`"),
    checked("8.cancelled", "`cancelled`"),
    outside(
        "8.busy",
        "`busy`",
        "a provider is busy only under contention inside it (its own locks and waits); no outside action can force that without knowing them",
    ),
    // 9. What the abstraction does not know
    outside(
        "9.1",
        "行动者、授权、场景、来历、依据、归档、条目、插件、动词。",
        "names what the abstraction does not know; there is no answer to check",
    ),
    outside(
        "9.2",
        "它也不知道哪个目录是「展开的」：那由内核从自己的记录推出，再决定去问哪些位置。",
        KERNEL,
    ),
];
