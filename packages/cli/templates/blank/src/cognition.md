<!--
  The plugin's section of the library's description (PNEUMA-BASE.md), which an agent's skill points
  it to. An agent reads it, not a person, so it says what the agent can do and what it should leave alone.
  src/index.ts takes these comments out before the text is used; conformance checks the form.
-->
<!-- The heading: what the plugin brings, a full-width colon, then how it is used. -->
## 标记：为条目添加说明

<!-- The first sentence names the plugin by the cognition title in src/index.ts, exactly in this form. -->
此资料库已启用**标记**插件。条目有需要提醒所有者或后续 Agent 的事项时，为它添加一条标记：

<!--
  Every command example is written for the grant placeholder below and runs as written: conformance
  runs each one on a fresh library after the setup steps in test/conformance.test.ts.
-->
```sh
pneuma-base @{{授权的名字}} say {{name}} notes/plan.md "第三节的数字尚未核对"
```

<!--
  Say what the agent cannot do and who decides, and nothing the kernel already says (archiving,
  finding without the archive, writing outside the library first). Promise nothing the code does not do.
-->
标记只是一条说明，不修改条目本身。`pneuma-base @{{授权的名字}} {{name}} list --path notes/plan.md` 列出该条目的标记；删除或处理标记需告知所有者。
