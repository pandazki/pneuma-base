/**
 * What an agent should know about PneumaSpace. It is true only while a PneumaSpace kind is connected,
 * so it stays out of the cognition section every library with the plugin gets.
 */
export const PNEUMA_SPACE_COGNITION =
  '在线的网站是 PneumaSpace 上的一个应用，地址在 `/apps/<应用名>/` 下面，所以网站里的链接要写相对路径；目录里要有 `index.html`。改了内容就放回同一个路径，线上换成新的一版，版本号加一。主人的目标是 Cloudflare 上的 PneumaSpace 时，网站只能是静态文件，最多 256 个、打包后不超过 4 MiB，只有登录了那个 PneumaSpace 的账户看得到。'
