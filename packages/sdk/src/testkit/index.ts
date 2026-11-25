// The test kit, `@pneuma-base/sdk/testkit`: a temporary home and library with the plugin installed,
// owner and agent calls through the real command line, the viewer's server, and the standard's
// behavioural rules as checks. It runs the `pneuma-base` package the plugin project depends on, or
// the command line `$PNEUMA_BASE_CLI` names.
export { sandbox, type Sandbox, type SandboxOptions, type Viewer } from './sandbox.js'
export { findCli, type CallOptions, type Result } from './run.js'
export { conformance, examplesOf, CHECKS, RULES, type CheckName, type CheckResult, type ConformanceOptions, type Report, type SetupContext, type Subject } from './conformance.js'
