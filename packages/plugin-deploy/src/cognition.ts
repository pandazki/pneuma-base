// What an agent should know about the PneumaSpace kinds. Each is true only while its kind is connected,
// so it is the kind's paragraph (the kit's onDescribe), not part of the section every library gets.
const ON_A_MACHINE = '在线的网站是 PneumaSpace 上的一个应用，地址在 `/apps/<应用名>/` 下面，所以网站里的链接要写相对路径；目录顶上要有 `index.html`。改了内容就放回同一个路径，线上换成新的内容。'

export const MACHINE_COGNITION = ON_A_MACHINE

export const CLOUDFLARE_COGNITION = `${ON_A_MACHINE}主人连的是 Cloudflare 上的 PneumaSpace：网站只能是静态文件，最多 256 个，打包后不超过 4 MiB；只有登录了那个 PneumaSpace 的账户看得到。`
