| `src/index.ts` | 插件本体：开发包中的部署库加一种目标。声明、所有者开关、记录、命令、页面和认知段均由部署库提供 |
| `src/target.ts` | 目标：发布到本地目录。改为真实目标时修改此文件，凭证用 `secrets` 声明 |
| `src/cognition.md` | 追加在部署库生成的认知段之后，说明 Agent 需要了解的目标信息；注释在使用时删除 |
| `src/ui/panel.html` | 自绘块，位于插件页面末尾（`src/target.ts` 中块的 `text` 以文字描述其绘制的内容，`pneuma-base show` 输出的即为这段文字）：载入界面提供的 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css`，使用 `pneuma.onData`、`run`、`open`；这三个函数及可用的类、变量的类型和说明见 `@pneuma-base/sdk/frame` |
