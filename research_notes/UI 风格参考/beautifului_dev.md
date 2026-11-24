# beautifului.dev 参考笔记

调研日期：2026-11-25。方法：WebFetch 取页面，再用 curl 取原始 HTML 与 CSS（`https://beautifului.dev/_next/static/css/916c3f25c8795666.css`，91 KB）。下文的值直接读自这份 CSS 和页面内嵌的组件源码。

## 1. 它是什么

- 站名 Beautiful UI，标题为 "Beautiful UI — Crafted primitives for AI-native interfaces"（https://beautifului.dev）。
- meta description 原文：「A small library of extremely crafted, copy-paste components for chat agents, thinking states, human-in-the-loop approvals, and everything agents need to talk to humans beautifully.」
- 性质：一个「复制粘贴」的 React 组件展示站，共 21 个面向 AI agent 产品的组件。它不是设计系统，也不是 npm 包。
- 作者与出品：页面写 "Built by Turbo"，链到产品设计工作室 https://turbodesign.co/ ；另有 "Book a call"（cal.com 预约链接）。
- 许可证：MIT，`https://beautifului.dev/license`，版权行为 "Copyright (c) 2026 Shane Levine"。页面标题为 "Yes, you can use it for free."
- 站内另有一页 `/harness`（"Ice Cream Harness"）：用这些组件拼出的整屏示例应用，带 "Fork this" 按钮（https://beautifului.dev/harness）。
- 已核实不存在或未找到：
  - npm 包：页面未提。
  - GitHub 仓库：页面未链接。
  - 安装命令：页面未给。
  - 文档页：除 `/license`、`/harness` 外没有。
  - `/llms.txt`、`/robots.txt`、`/sitemap.xml` 均返回 404。
  - WebSearch 搜 "beautifului.dev" 无结果指向本站（未验证是否有仓库）。
- 技术栈（读自页面源码）：
  - Next.js（`/_next/static/...`，App Router），React，Tailwind v4（CSS 里是 `--spacing:.25rem`、`--color-*`、`--text-*` 这种 v4 主题变量）。
  - 组件示例源码里的 import：`@/components/atoms/Button`、`EntityChip`、`Shimmer`、`StreamText`、`ValuePill`、`@/components/primitives/GlideMenu`。
  - 第三方：`glimm`、`liveline`、`iconoir-react`、`@central-icons-react/round-outlined-radius-2-stroke-2/*`。
  - 页面上每个组件都有 "Copy code" 按钮，复制的是单文件源码。源码里引用了站内私有的 `@/components/...` 原子组件，这些文件没有公开发布，因此单拷一个组件不能直接跑起来（推断）。

结论：不能作为依赖安装。只能当视觉与交互参考，或手工抄源码（MIT 允许）。

## 2. 组件清单（21 个，来自首页）

1. Loading State：像素网格加载器，带 shimmer 与计时
2. Thinking：可展开的推理轨迹（steps / reasoning / search / coding）
3. Streaming Text：流式回答，带内联来源、动作、追问
4. Approval Card：agent 动手前向人提问
5. Tool Chips：代码编辑与工具调用的紧凑 chip
6. Task Rows：任务状态行（running / failed / completed）
7. Chat：带标签页的聊天面板
8. Prompt Bar：输入框，支持 @ 来源、/ 命令、模型选择、听写
9. Recommendation Card：带置信度条的建议
10. Context Cards：检索到的知识片段与来源
11. Diff Table：AI 建议的表格式修改
12. Records Table：CRM 式表格，带标签、排序、关系状态
13. Filter Table：状态 chip 过滤实时数据
14. Sidebar Nav：可折叠的工作区与会话导航
15. Search：命令式搜索，实时过滤并带空状态
16. Flowchart：画布上的触发与条件步骤
17. Insight Cards：分页洞察卡，带实时图表
18. Code Block：带行号的代码与 unified diff
19. Fine-tune Card：设计属性检查器
20. Selection Actions：选中文字后的 agent 动作
21. Agent Screen：查看 agent 屏幕、教它任务、录制

与「文件和记录浏览器」相关的：

| 需要 | 对应组件 | 备注 |
| --- | --- | --- |
| 表格或列表 | Records Table（#12）、Filter Table（#13）、Diff Table（#11） | 最相关，见 3.6 |
| 树或侧栏导航 | Sidebar Nav（#14） | 可折叠；没有树形层级的证据（未验证） |
| 状态 chip | Filter Table（状态 chip 过滤）、Records Table 标签、Task Rows | |
| 时间线 | 无专门组件；Task Rows、Thinking 的步骤轨迹最接近 | |
| 详情面板 | 无；Context Cards、Code Block 可借 | |
| 命令面板和搜索框 | Search（#15，带空状态） | |
| 代码与 diff 查看 | Code Block（#18） | 对「文件历史」有用 |
| 标签页 | Chat（#7）内有标签 | 无独立 Tabs 组件 |
| 对话框、toast | 没有 | 需自行设计，沿用 overlay 阴影 token |
| 右键或浮层菜单 | GlideMenu（源码 import 可见，非 21 个之一） | |

其余（Chat、Thinking、Prompt Bar、Agent Screen 等）与本项目关系不大。

## 3. 视觉语言（读自 CSS，OKLCH）

### 3.1 颜色 token（`:root` 为浅色，`.dark` 为深色）

| token | 浅色 | 深色 | 用途（按用法推断） |
| --- | --- | --- | --- |
| `--page` | oklch(98.5% .001 286.376) | oklch(20.9% .004 264.477) | 页面底 |
| `--canvas` | oklch(96.1% .002 247.84) | oklch(23.1% .004 264.487) | 画布底 |
| `--surface` | oklch(100% 0 0) | oklch(26% .006 271.191) | 卡片、表格底 |
| `--inset` | oklch(97.9% .002 247.839) | oklch(24.3% .004 264.492) | 凹陷区、tfoot |
| `--hover` | oklch(97% .002 247.839) | oklch(28.9% .006 271.22) | 悬停 |
| `--hover-2` | oklch(93.3% .003 247.86) | oklch(31.8% .007 274.747) | 更深悬停 |
| `--ink` | oklch(24.7% .006 258.361) | oklch(96.4% .002 247.839) | 主文字 |
| `--ink-2` | oklch(50.6% .01 264.477) | oklch(73.1% .008 260.731) | 次文字 |
| `--ink-3` | oklch(69.5% .009 264.505) | oklch(54.1% .01 264.484) | 弱文字、图标 |
| `--line` | oklch(94.6% .003 264.542) | oklch(30.8% .006 258.354) | 分隔线 |
| `--line-strong` | oklch(91.2% .005 258.326) | oklch(35.6% .007 264.474) | 强边框 |
| `--line-soft` | oklch(96.6% .002 264.542) | oklch(27.8% .006 258.354) | 弱分隔线 |
| `--field` | oklch(96.1% .001 286.375) | oklch(29.3% .006 271.223) | 输入框底 |
| `--accent` | oklch(62.6% .205 254.947) | oklch(68% .173 253.301) | 强调蓝 |
| `--accent-ink` | oklch(55.6% .187 255.617) | oklch(78.8% .113 248.33) | 强调色文字 |
| `--accent-tint` | oklch(96% .019 252.878) | oklch(68% .173 253.301/.16) | 强调淡底 |
| `--green` / `-tint` | oklch(60.3% .155 150.883) / oklch(95.8% .017 159.118) | oklch(70.5% .154 153.814) / 同色 /.14 | 成功 |
| `--orange` / `-tint` | oklch(68.9% .179 49.902) / oklch(96.4% .021 67.581) | oklch(74.6% .156 55.642) / 同色 /.14 | 警告 |
| `--red` / `-tint` | oklch(62.1% .192 23.042) / oklch(95.6% .017 17.462) | oklch(66.6% .18 21.433) / 同色 /.14 | 错误 |
| `--tooltip-bg` / `-fg` | oklch(27.2% .008 264.435) / oklch(97.6% .002 247.839) | oklch(18.2% .004 264.459) / oklch(96.4% .002 247.839) | 提示 |

要点：
- 灰阶都带极小的色度（0.001 到 0.01，色相 247 到 286），是接近中性的冷灰。
- 只有一个强调色（蓝），语义色三种（绿、橙、红），每种都配一个 tint。
- 深色模式的层级是越「浮」越亮：page 20.9% < canvas 23.1% < surface 26%。
- 标签色用 `--tag-base`（例：oklch(65.2% .131 162.865)、oklch(67.1% .118 219.351)、oklch(75.7% .153 66.401)），浅色下底为 `color-mix(in srgb, var(--tag-base) 18%, var(--surface))`，深色下为 34%。边框浅色 32%，深色 34%。
- 站点 body 背景是 `--stripe-bg` 加 -45deg 的斜纹：`repeating-linear-gradient(-45deg, transparent 0, transparent 7px, var(--stripe) 7px, var(--stripe) 8px)`，浅色 `--stripe` 为 oklch(40.5% 0 0/.075)，深色为 oklch(100% 0 0/.055)。组件放在这层斜纹底上的白色卡片里（站点展示手法，应用屏幕不必用）。
- 暗色开关机制：`.dark` 类，另有 `[data-theme=light]`。首页是否提供切换按钮未验证。

### 3.2 字体

- `--font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif`（Inter，经 next/font 加载）。
- `--font-mono: var(--font-mono-face), ui-monospace, "SF Mono", monospace`（JetBrains Mono）。
- body：`font-size:14px; line-height:1.5; letter-spacing:-.01em; font-feature-settings:"cv11","ss01"`（Inter 的单层 a 与替代字形，来自 CSS 直读）。
- 页面用到的像素字号：text-[10px]、[11px]、[12px]、[13px]、[14px]，另有 [17px]、[19px]、[20px]、[21px]。小到 [7px]、[8px]、[9px] 的多半在图形或像素加载器里。表格内：表头 12.5px/500，单元格 13px/500，行号 11.5px 且 `tabular-nums`，tfoot 14px/500。
- 字重：400、500、600、700 四档，表格以 500 为主。
- Tailwind 主题里 `--text-xs: .75rem`、`--text-sm: .875rem`、`--text-2xl: 1.5rem`。

### 3.3 间距与密度

- `--spacing: .25rem`（4px 基数）。
- 记录表：行高 35px（表头与单元格都是 `height:35px`），单元格横向内边距 8px，表头按钮 12px，列分隔线与行分隔线都有（`border-right` 与 `border-bottom` 为 `--line` 的 78% 混合）；`min-width:990px`、`table-layout:fixed`、表头与 tfoot 都 sticky。
- 标签：高 23px、圆角 8px、内边距 0 7px、字号 13px；`+N` 溢出标签高 23px、圆角 6px、字号 11px、底色 `--inset`。
- 侧栏：展开行宽 208px，折叠行宽 36px。
- 容器宽度 token：`--container-md:28rem`、`3xl:48rem`、`6xl:72rem`。
- 整体是紧凑的 13px 工具型密度，行高偏小，用线而不是留白来分隔。

### 3.4 圆角

- 自定义语义 token：`--radius-chip:6px`、`--radius-control:8px`、`--radius-card:10px`、`--radius-window:14px`。
- Tailwind 默认：`--radius-sm:.25rem`、`--radius-md:.375rem`、`--radius-xl:.75rem`。
- 页面中还有大量 `rounded-[Npx]`，值从 1 到 24。大圆角（16、18、22、24）多见于 chat 与 prompt bar 一类外壳。

### 3.5 边框与阴影

边框是用 `box-shadow` 画的 1px 环，而不是 `border`：

- 浅色：
  - `--shadow-hairline: 0 0 0 1px var(--line)`
  - `--shadow-btn: 0 0 0 1px var(--line-strong), var(--shadow-xs)`
  - `--shadow-card: 0 0 0 1px var(--line), var(--shadow-sm)`
  - `--shadow-raised: 0 0 0 1px var(--line), var(--shadow-md)`
  - `--shadow-overlay: 0 0 0 1px var(--line), var(--shadow-lg)`
  - `--shadow-inset-field: inset 0 1px 2px oklch(0% 0 0/.12)`
- 底层 shadow（极淡、多层叠加）：
  - `--shadow-xs: 0 0 4px 0 #0000000a`
  - `--shadow-sm` 是 6 层，从 `0 18px 47px 0 #00000008` 到 `0 .5px 1.3px 0 #00000003`，每层不透明度 2% 到 3%
  - `--shadow-lg` 最大一层 `0 25px 50px 0 #0000000d`
- 深色：用白色半透明环代替：
  - card：`0 0 0 1px oklch(100% 0 0/.11), 0 1px 2px oklch(0% 0 0/.2), 0 2px 6px oklch(0% 0 0/.2)`
  - overlay：`0 0 0 1px oklch(100% 0 0/.15), 0 8px 28px oklch(0% 0 0/.34)`
  - inset-field：`inset 0 1px 2px oklch(0% 0 0/.4)`
- 另有 `--smooth-ring-color`：浅色 `#0000000d`，深色 `#ffffff2e`，宽 1px，用于图片或头像外圈。

### 3.6 状态与交互（以 Records Table 为例，CSS 原值）

- 行悬停：背景 `--hover`；过渡 `.12s ease-out`。
- 选中行：浅色 `color-mix(in srgb, var(--accent) 7%, var(--surface))`。
- 选中列：表头 `accent 8%` 加 `inset 0 2px 0 var(--accent)` 顶线，单元格 `accent 4%`，悬停 8%，选中 10%。
- 行首：行号（24px 方块，`--ink-3`）悬停或选中时换成复选框。
- 表头：按钮式，悬停变 `--hover`；排序图标默认隐藏，悬停才显示。
- 过载处理：标签用 ResizeObserver 测宽，放不下的折叠为 `+N`。
- 另有 `MiniSwitch`（`role="switch"`，宽 7.5、高 4.5 个 spacing 单位）：开为 `--accent`，关为 `--line-strong`。

### 3.7 图标

- 主要用 `@central-icons-react/round-outlined-radius-2-stroke-2/*`（Central Icons，圆角描边，2px 线宽）；示例里有 IconMagnifyingGlass、IconChevronDownSmall、IconCheckmark1Small、IconCrossSmall、IconSidebarLeftArrow、IconSettingsGear1 等。
- 另有 `iconoir-react`。
- 该 Central Icons 包是否需要付费授权，站点未说明（未验证）。

### 3.8 动效

- 全局默认：`--default-transition-duration:.15s`，`--default-transition-timing-function:cubic-bezier(.4,0,.2,1)`。
- 自定义曲线：
  - `--ease-out-strong: cubic-bezier(.23,1,.32,1)`
  - `--ease-in-out-strong: cubic-bezier(.77,0,.175,1)`
  - `--ease-link: cubic-bezier(.16,1,.3,1)`
- Tailwind 时长类用到 100、150、200、250、300、400、500ms。表格悬停 120ms；侧栏折叠用 `--sidebar-copy-duration`、`--sidebar-easing`（文字淡出并向左位移）。
- @keyframes：`caret-blink`、`eq-bounce`、`fade-in`、`fade-up`、`pixel-on`、`pop-in`、`records-pulse`、`shimmer-text`、`spin`。
- CSS 里有 `prefers-reduced-motion` 处理（出现 3 处，含 `duration:.01ms!important`）。
- 首页每个组件旁有 "MOTION" 说明，列出动效参数（具体文字没有逐条核对）。

## 4. 布局与应用屏幕范式

- 首页：单列，左侧固定的组件目录，每个组件一张带编号（01 到 21）的卡，卡里放可交互演示和 "Copy code"。
- `/harness`（"Ice Cream Harness"）是站点给出的整屏范式：
  - 左侧可折叠侧栏：工作区切换、New chat、Home、Invite users（3/10）、Chats 列表。
  - 右侧主区是对话与输入。
  - 顶部有 "Fork this" 按钮。
  - 页面静态 HTML 能读出的只有这些文字，具体尺寸没有量过（未验证）。
- 表格范式：固定表头、固定表尾（汇总行）、首列固定（`records-sticky-cell`）、列选中、行选中、单元格内标签折叠。
- 导航范式：侧栏 208px 与 36px 两态，折叠时只留图标，滑动高亮块（`sidebar-glide-highlight`）。

## 5. 设计原则

站点没有写出任何明确的设计原则或规则，也没有 "Guidelines" 页。能读到的只有定位语：「Crafted primitives」「extremely crafted」「copy-paste」。下面是从 CSS 与代码读出来的做法，是推断，不是站点声明：

1. 用 token 分层表达深度（page、canvas、surface、inset），再用 1px 环加极淡的多层阴影区分层级，而不是粗边框。
2. 灰阶近乎中性，颜色只用在状态、选中与标签上。
3. 小字号（11 到 13px）加 500 字重，字距略收（-.01em）。
4. 微交互有统一缓动曲线与短时长，并尊重 reduced-motion。

## 6. 没能确定的

- 站点之外的源码仓库、npm 包、安装方式：没有找到。
- 是否有深浅色切换按钮，以及默认主题：CSS 同时有 `:root` 与 `.dark` 两套值，但没有验证页面是否暴露切换。
- 组件的完整源码：只看了页面内嵌的 RSC 片段（Records Table、Sidebar 等的一部分）。`@/components/atoms/*` 的实现没有取到。
- `/harness` 页面的精确尺寸与布局数值：没有量。
- Central Icons 的授权条件。
- 站点更新频率与维护状态：无信息。
- 没有在浏览器里渲染截图核对视觉；以上全部来自 HTML 与 CSS 文本。

## 7. 来源 URL

- https://beautifului.dev （首页 HTML 与内嵌源码）
- https://beautifului.dev/_next/static/css/916c3f25c8795666.css （全部 token 与规则）
- https://beautifului.dev/license
- https://beautifului.dev/harness
- https://turbodesign.co/ （仅作为链接目标，未取）
