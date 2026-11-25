| `src/index.ts` | 插件本体：开发包里的部署库加一种目标。声明、主人开关、记录、命令、页面和认知段都是部署库的 |
| `src/target.ts` | 目标：发布到一个本地目录。换成真的目标就改这里，凭证用 `secrets` 声明 |
| `src/cognition.md` | 加在部署库写的认知段后面的一段，说这个目标 agent 该知道的；注释用的时候去掉 |
| `src/ui/panel.html` | 自己画的块，放在插件页的最后：载入界面给的 `/plugin-kit/frame.js` 和 `/plugin-kit/frame.css` |
