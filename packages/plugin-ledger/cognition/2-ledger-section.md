## 来历：每样东西从哪来

这个库装了**记账与对账**插件。它记下每样东西是哪次会话、哪个 agent、在哪个目录、为了解决什么放进来的，依据了什么。一次工作分三步。

**1. 开工：说一句你在做什么。**

```sh
pneuma-base @{{授权的名字}} start "给电子书小店选支付服务"
```

库会记下这句话，并回给你两样：自你上次会话以来别人动过什么；库里可能和这件事有关的已有东西。有相关的就接着用，不要重做。和眼下的事无关的变化不用转告主人。换了话题，再 `start` 一次。

**2. 找和看。**

```sh
pneuma-base @{{授权的名字}} find 支付
pneuma-base @{{授权的名字}} inspect payments/comparison.md
```

`find` 也按字面匹配备注、说过的话和文本文件的内容，中文英文各搜一次。`inspect` 告诉你一样东西是谁、哪天、在哪个目录、为了什么做的，依据了什么，后来什么依据了它，主人定了什么。

**3. 放，并写明依据。**

```sh
# 带进来的：你把内容给它，它不会自己去抓。放进来的时间会自动记下。
curl -s https://stripe.com/pricing | pneuma-base @{{授权的名字}} put - \
  --to payments/sources/stripe-pricing.html --brought --source https://stripe.com/pricing

# 做出来的：写明结论真正依据的那些，不是所有看过的。库里的用 --from，库外的用 --from-outside 写一句。
pneuma-base @{{授权的名字}} put ./comparison.md --to payments/comparison.md --made \
  --from payments/sources/stripe-pricing.html payments/sources/paddle-pricing.html \
  --from-outside "主人在对话里说：客户主要在欧洲"
```

主人给你的文件，用 `--brought --by owner`。主人拍板了，记一句：

```sh
pneuma-base @{{授权的名字}} say decided "主人决定用 Paddle，因为它替他处理欧洲的税"
```

一样东西被新内容换掉时，旧内容进**留存**。留存是给主人的保险，只有主人取得回，你不用管它。

`check` 还会列出：依据的资料后来变了、可能过期的东西；依据的资料不在了的；没人登记过的文件；被直接改过的文件。这些不用你自动处理，和眼下的事有关就告诉主人。补记用这些：

| 用法 | 意思 |
| --- | --- |
| `say note "<一句话>"` 或 `say note <库内路径> "<备注>"` | 给这次会话或一样东西留一句备注 |
| `say from <库内路径> --from <库内路径…>` | 事后补上：这样东西依据了那些 |
| `put <库内路径> --brought …` 或 `--made …` | 给一个没人登记过的文件补上来历 |
| `say revised <库内路径>`（主人说是自己改的，加 `--by owner`） | 补救：这个文件已经被直接改过了，认下这次改动 |
