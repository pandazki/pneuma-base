# {{name}}：Pneuma Base 插件

由 `pneuma-base plugin new` 生成，无需修改即可构建、通过自带的测试并安装到本机。将示例替换为插件的实际功能，并相应修改测试。

## 文件

| 文件 | 用途 |
| --- | --- |
| `package.json` | 依赖两个包：`pneuma-base`（命令行，测试和安装时使用）和 `@pneuma-base/sdk`（契约的类型、开发包、测试工具）；脚本 `build`、`test`、`install-local` |
| `tsconfig.json` | 仅用于类型检查。测试直接导入 `src/` 的源码：Node 22.18 起在载入时去除类型，因此相对导入写 `.ts`，且只使用可去除的语法 |
| `scripts/build.mjs` | 用 esbuild 将插件打包为单个 `dist/index.js`，依赖全部打包在内，并在旁边放置 `cognition.md` 和 `ui/`。`dist/` 即安装到本机的插件目录 |
{{kindFiles}}
| `test/conformance.test.ts` | 符合性检查：在构建好的 `dist/` 上运行标准中的行为规则；不通过时以中文说明问题和对应的规则 |
| `test/plugin.test.ts` | 插件自身的测试：临时的家目录和资料库、真实的命令行、界面的服务 |

## 五个步骤

```sh
npx -- pneuma-base plugin new {{name}} --packages <包文件目录>   # 1. 生成（已完成）
npm install
npm run build                                                   # 2. 构建：类型检查，再打包到 dist/
npm test                                                        # 3. 测试：先构建，再运行 test/ 下的测试
npm run install-local                                           # 4. 安装到本机：构建，再执行 pneuma-base plugin install dist
npx -- pneuma-base plugin enable {{name}} --library <资料库目录>     # 5. 在资料库中启用
```

- 安装到本机和在资料库中启用均仅限所有者：在 Agent 会话中执行会被拒绝。
- 插件安装在 `$PNEUMA_BASE_HOME/plugins/{{name}}/`（默认为 `~/.pneuma-base`）。修改代码后再次运行 `npm run install-local`，已打开的管理界面在下一次请求时使用新版本。
- `npx` 后的 `--` 使 `--library` 等选项传给 `pneuma-base`，而不被 npm 读取。

## 在测试中替换外部服务

插件连接网络服务（例如部署目标）时，测试不连接真实服务：`sandbox.serve(handler)` 在本机启动一个替身服务并返回其地址；每个请求以 `Request` 交给 `handler`，`handler` 返回的 `Response` 发回给请求方；沙箱清理时替身服务一并停止。符合性检查的 `setup` 收到的 `sandbox` 同样可用：

```ts
async setup({ sandbox }) {
  const url = await sandbox.serve(async (request) => Response.json({ ok: true }))
  await sandbox.owner(['{{name}}', 'target', 'set', '--url', url])
}
```

## 标准

插件规范是命令行包中的 `PLUGINS.md`：`npm install` 后位于 `node_modules/pneuma-base/PLUGINS.md`。它规定插件必须做什么、可以依赖什么，每项功能都附有可运行的示例。可自动检查的规则在 `test/conformance.test.ts` 中作为检查运行，不通过时报告问题和对应的规则；无法自动检查的规则列在报告末尾，需人工检查。
