// What an agent should know about the PneumaSpace kinds. Each is true only while its kind is connected,
// so it is the kind's paragraph (the kit's onDescribe), not part of the section every library gets.
const SELF_HOSTED = '已发布的网站是 PneumaSpace 上的一个应用，地址位于 `/apps/<应用名称>/` 下，因此网站中的链接须使用相对路径；目录根部须有 `index.html`。修改内容后添加到同一路径，部署目标上即更新为新内容。'

export const SELF_HOSTED_COGNITION = SELF_HOSTED

export const CLOUDFLARE_COGNITION = `${SELF_HOSTED}所有者连接的是 Cloudflare 上的 PneumaSpace：网站只能是静态文件，最多 256 个，打包后不超过 4 MiB；仅登录该 PneumaSpace 的账户可以访问。`
