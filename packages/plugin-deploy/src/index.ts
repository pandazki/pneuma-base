import { deployPlugin } from '@pneuma-base/sdk/kit'
import { commandTarget, dirTarget } from './targets.js'

/** 部署: the deploy kit with a local directory and the owner's commands as targets. README.md. */
export const deploy = deployPlugin('deploy', [dirTarget, commandTarget])
