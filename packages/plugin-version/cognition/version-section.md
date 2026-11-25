## 版本：留住每一版

这个库装了**版本**插件。会反复改、以后可能要回头看旧版的成果（一个网站、一份方案），放进库之后声明它有版本：之后每次放进不同的内容就多一版，内容相同不多记；有人在工具之外改了它，`check` 会把改后的内容记成一版并告诉你。版本是你自己能列出、导出、放回的历史。只有声明过有版本的东西，这个插件才留住旧版。

```sh
pneuma-base @{{授权的名字}} say versioned sites/shop "第一版"
pneuma-base @{{授权的名字}} put ./shop --to sites/shop --made --note "换了配色"   # 第 2 版，--note 的这句话同时是这一版的说明
pneuma-base @{{授权的名字}} say version sites/shop "换了配色"   # 也可以事后给当前这一版写说明
pneuma-base @{{授权的名字}} version list sites/shop
pneuma-base @{{授权的名字}} version export sites/shop --version 1 --to ./shop-v1
pneuma-base @{{授权的名字}} version restore sites/shop --version 1   # 放回来算新的一版，现在的内容不会丢
```
