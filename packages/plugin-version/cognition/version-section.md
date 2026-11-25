## 有版本的东西

这个库装了**版本**插件。会反复改、以后可能要回头看旧版的成果（一个网站、一份方案），放进库之后声明它有版本。声明之后，每次 `put` 放进不同的内容就多一版，每一版的内容都留着；内容相同不多记。有人在工具之外改了它，`check` 会把改后的内容记成一版并告诉你。

```sh
pneuma-base @{{授权的名字}} say versioned sites/shop "第一版"
# 改好的新内容在库外写好，放回原路径，就是第 2 版
pneuma-base @{{授权的名字}} put ./shop --to sites/shop --made
pneuma-base @{{授权的名字}} say version sites/shop "换了配色"
pneuma-base @{{授权的名字}} inspect sites/shop
# 把第 1 版取到库外看，或者把它放回来（放回来算新的一版，现在的内容不会丢）
pneuma-base @{{授权的名字}} version export sites/shop --version 1 --to ./shop-v1
pneuma-base @{{授权的名字}} version restore sites/shop --version 1
```

`say version <库内路径> "<一句话>"` 给当前这一版写说明；`version list <库内路径>` 列出全部的版本。只有声明过有版本的东西，这个插件才替你留住旧的一版。
