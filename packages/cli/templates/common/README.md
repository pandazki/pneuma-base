# {{name}}：一个 Pneuma Base 插件

由 `pneuma-base plugin new` 生成，不改一行就能构建、通过自己的测试、装进本机。把示例换成你的插件要做的事，测试跟着改。

## 每个文件是什么

| 文件 | 是什么 |
| --- | --- |
| `package.json` | 依赖两个包：`pneuma-base`（命令行，测试和安装时用）和 `@pneuma-base/sdk`（契约的类型、开发包、测试工具）；脚本 `build`、`test`、`install-local` |
| `tsconfig.json` | 只做类型检查。测试直接导入 `src/` 的源码：Node 22.18 起载入时去掉类型，所以相对导入写 `.ts`，只用能去掉的语法 |
| `scripts/build.mjs` | 用 esbuild 把插件打成一个 `dist/index.js`，依赖都打进去，旁边放 `cognition.md` 和 `ui/`。`dist/` 就是装到本机的插件目录 |
{{kindFiles}}
| `test/conformance.test.ts` | 符合性检查：标准里行为上的规矩，跑在构建好的 `dist/` 上；不通过时用中文说哪里不对、规矩是什么 |
| `test/plugin.test.ts` | 插件自己的测试：临时的家目录和库、真的命令行、界面的服务 |

## 五步

```sh
npx -- pneuma-base plugin new {{name}} --packages <两个包文件所在的目录>   # 1. 生成（已经做了）
npm install
npm run build                                                         # 2. 构建：类型检查，再打包到 dist/
npm test                                                              # 3. 测试：先构建，再跑 test/ 下的测试
npm run install-local                                                 # 4. 装到这台机器：构建，再 pneuma-base plugin install dist
npx -- pneuma-base plugin add {{name}} --library <库的目录>              # 5. 在一个库里启用
```

- 装到这台机器和在库里启用都只给主人：在 agent 的会话里会被拒绝。
- 插件装在 `$PNEUMA_BASE_HOME/plugins/{{name}}/`（缺省 `~/.pneuma-base`）。改了代码再 `npm run install-local`，开着的管理界面下一次请求就用新的。
- `npx` 后面的 `--` 让 `--library` 这样的开关交给 `pneuma-base`，不被 npm 自己读走。

## 标准在哪

插件要守的规矩写在 Pneuma Base 的插件规范里（Pneuma Base 仓库的 `ARCHITECTURE.md` 第 5 节「扩展点」）。能跑的规矩在 `test/conformance.test.ts` 里跑成检查，每条的规矩写在它不通过时的报告里；查不了的列在报告最后，要自己看。
