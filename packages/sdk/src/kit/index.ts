// The kit a plugin is built from, `@pneuma-base/sdk/kit`: an append-only record store, a
// configuration file helper, and the deploy kit, which makes a target adapter a complete plugin. It
// imports nothing of the kernel: what it needs from the library comes through the context's `tools`.
export { recordStore, type Envelope, type RecordActor, type RecordStore, type Skipped } from './records.js'
export { configFile, type ConfigFile } from './config-file.js'
export { deployPlugin, type DeployOptions } from './deploy/plugin.js'
export { siteName, plan, statusOf, want, type ContentId, type Held, type SiteName, type Standing, type State, type Step } from './deploy/model.js'
export type { Declared, ThingId } from './deploy/facts.js'
export type { Configured, Look, PublishMeta, Served, SiteFile, Status, Target, TargetAdapter, TargetConfig, TargetEnv, TargetFlags, TargetView } from './deploy/target.js'
