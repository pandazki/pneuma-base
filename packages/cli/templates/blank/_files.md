| `src/index.ts` | 插件本体：一种 say 类型（Agent 为条目添加标记）、一条带参数表的所有者命令（列出标记）、一个由带类型的块组成的视图，以及一个自绘块 |
| `src/cognition.md` | 拼入资料库说明（`PNEUMA-BASE.md`）的认知段，供 Agent 读取；注释说明每部分的作用，使用时删除 |
| `src/ui/panel.html` | 自绘块（`src/index.ts` 中块的 `text` 以文字描述其绘制的内容，`pneuma-base show` 输出的即为这段文字）：载入界面提供的 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css`，跟随界面的浅色和深色外观，按钮运行块中声明的操作，链接打开条目面板；`pneuma` 及可用的类、变量的类型和说明见 `@pneuma-base/sdk/frame` |
