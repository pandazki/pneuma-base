<!--
  The plugin's section of the library's description (PNEUMA-BASE.md), which an agent's skill points
  it to. An agent reads it, not a person, so it says what the agent can do and what it should leave alone.
  src/index.ts takes these comments out before the text is used; conformance checks the form.
-->
<!-- The heading: what the plugin brings, a full-width colon, then how it is used. -->
## 标记：给东西留一句话

<!-- The first sentence names the plugin by the cognition title in src/index.ts, exactly in this form. -->
这个库装了**标记**插件。看到一样东西有要提醒主人或下一个 agent 的事，给它留一句话：

<!--
  Every command example is written for the grant placeholder below and runs as written: conformance
  runs each one on a fresh library after the setup steps in test/conformance.test.ts.
-->
```sh
pneuma-base @{{授权的名字}} say {{name}} notes/plan.md "第三节的数字还没核对"
```

<!--
  Say what the agent cannot do and who decides, and nothing the kernel already says (archiving,
  finding without the archive, writing outside the library first). Promise nothing the code does not do.
-->
标记只是一句话，不改那样东西。`pneuma-base @{{授权的名字}} {{name}} list --path notes/plan.md` 列出它的标记；要删掉或处理标记，告诉主人。
