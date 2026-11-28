import { fileURLToPath } from 'node:url'
import { PNEUMA_BASE_VERSION } from '@pneuma-base/sdk'
import { deployPlugin } from '@pneuma-base/sdk/kit'
import { cloudflareTarget } from './cloudflare.js'
import { selfHostedTarget } from './self-hosted.js'
import { PLUGIN } from './name.js'
import { commandTarget, folderTarget } from './targets.js'

/** 部署: the deploy kit with four kinds of target, PneumaSpace on Cloudflare or self-hosted, a local folder, the owner's commands. README.md. */
export const deploy = deployPlugin(PLUGIN, [cloudflareTarget, selfHostedTarget, folderTarget, commandTarget], {
  icon: 'cloud-upload',
  version: PNEUMA_BASE_VERSION,
  summary: '将网站发布到部署目标',
  about: '所有者将资料库中的网站目录发布到 PneumaSpace、本地文件夹或自定义命令，部署目标随资料库的当前内容更新，关闭开关即取消发布。Agent 只能声明条目可部署，由所有者决定是否发布。',
  ui: fileURLToPath(new URL('../ui/', import.meta.url)),
})
