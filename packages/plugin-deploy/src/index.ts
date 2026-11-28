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
  summary: '让可以部署的东西上线、下线',
  about: '声明了可以部署的东西由主人开关上线，线上跟着库里现在的内容，部署到 PneumaSpace、本地目录或主人自己的命令。',
  ui: fileURLToPath(new URL('../ui/', import.meta.url)),
})
