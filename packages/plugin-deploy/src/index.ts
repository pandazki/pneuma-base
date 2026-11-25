import { PNEUMA_BASE_VERSION } from '@pneuma-base/sdk'
import { deployPlugin } from '@pneuma-base/sdk/kit'
import { commandTarget, dirTarget } from './targets.js'

/** 部署: the deploy kit with a local directory and the owner's commands as targets. README.md. */
export const deploy = deployPlugin('deploy', [dirTarget, commandTarget], {
  version: PNEUMA_BASE_VERSION,
  summary: '声明了可以部署的东西由主人开关上线，线上跟着库里现在的内容，部署到本地目录或主人自己的命令。',
})
