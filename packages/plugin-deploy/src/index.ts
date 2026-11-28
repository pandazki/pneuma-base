import { fileURLToPath } from 'node:url'
import { PNEUMA_BASE_VERSION } from '@pneuma-base/sdk'
import { deployPlugin } from '@pneuma-base/sdk/kit'
import { cloudflareTarget } from './cloudflare.js'
import { machineTarget } from './machine.js'
import { PLUGIN } from './name.js'
import { commandTarget, dirTarget } from './targets.js'

/** 部署: the deploy kit with four kinds of target, PneumaSpace on Cloudflare or on a machine, a local directory, the owner's commands. README.md. */
export const deploy = deployPlugin(PLUGIN, [cloudflareTarget, machineTarget, dirTarget, commandTarget], {
  icon: 'cloud-upload',
  version: PNEUMA_BASE_VERSION,
  summary: '把网站放到线上',
  about: '主人把库里的网站目录放到 PneumaSpace、本地文件夹或自己的命令上，线上跟着库里现在的内容，一个开关下线。agent 只能声明一样东西可以部署，上不上线由主人决定。',
  ui: fileURLToPath(new URL('../ui/', import.meta.url)),
})
