// The kit a plugin is built from, `@pneuma-base/sdk/kit`: an append-only record store, a
// configuration file helper, and the deploy kit, which makes a target adapter a complete plugin. It
// imports nothing of the kernel: what it needs from the library comes through the context's `tools`,
// in storage's words (plugin contract 2).
export { recordStore, STORE_FIELD, type Envelope, type RecordActor, type RecordPage, type RecordStore, type Skipped } from './records.js'
export { configFile, type ConfigFile } from './config-file.js'
export { deployPlugin, type DeployOptions } from './deploy/plugin.js'
export { siteName, plan, statusOf, want, type ContentId, type Held, type SiteName, type Standing, type State, type Step } from './deploy/model.js'
export type { Declared, ThingId } from './deploy/facts.js'
export {
  defineTarget,
  type Configured,
  type Look,
  type PublishMeta,
  type Served,
  type ServingAsk,
  type SiteFile,
  type Status,
  type Target,
  type TargetAdapter,
  type TargetConfig,
  type TargetEnv,
  type TargetPage,
  type TargetView,
} from './deploy/target.js'
export { STATUS } from './deploy/words.js'
export { switchAction } from './deploy/views.js'
