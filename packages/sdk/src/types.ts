// The plugin contract's shapes, which a plugin and the kernel exchange. ARCHITECTURE.md「动词」 and 「插件机制」.
import type { IconName } from './icons.js'
import type { Description, PluginStorage, StorageFailure, Written } from './storage.js'

// Semantic primitives. Parsed once at the kernel's boundary.
export type LibraryPath = string & { readonly __brand: 'LibraryPath' } // library-relative, '/'-separated
export type Fingerprint = string & { readonly __brand: 'Fingerprint' } // sha256 of the content, hex
export type PluginName = string & { readonly __brand: 'PluginName' }
export type Instant = string & { readonly __brand: 'Instant' } // ISO 8601
export type GrantId = string & { readonly __brand: 'GrantId' }

export type Actor =
  | { kind: 'agent'; name: string; grant: GrantId | null }
  | { kind: 'owner' }
  | { kind: 'plugin'; name: PluginName }

export type Session = {
  id: string
  source: 'flag' | 'env' | 'minted'
  cwd: string
  machine: string
  /** Null unless the id came from an agent product whose layout the kernel knows and the file is there. */
  transcript: Transcript | null
}

/**
 * Where the session's conversation is on `Session.machine`: a pointer, never a copy. `path` writes the
 * home folder as `~`; `resume` is the command that continues the conversation there, null for a
 * product that has none.
 */
export type Transcript = { path: string; resume: string | null }

export type Grant = {
  id: GrantId
  name: string
  agent: string
  area: LibraryPath | null // a subfolder; null is the whole library
  readOnly: boolean
}

export type LibraryConfig = {
  format: 1
  id: string
  plugins: PluginName[]
  grants: Grant[]
}

export type Library = {
  readonly root: string // absolute real path
  readonly config: LibraryConfig
  readonly plugins: readonly Plugin[] // installed and present in the plugin table, in config order
  readonly unavailable: readonly PluginName[] // installed but absent from the plugin table
  /** Names a later plugin claims that an earlier one holds, left out of the later one: a problem in every answer (K8). */
  readonly clashes: readonly PluginProblem[]
}

/**
 * `home` is this machine's `$PNEUMA_BASE_HOME`: local grant files, external plugins, plugin caches.
 * `pass`: where a named whole pass the operation runs reports how far it is and hears that it should
 * stop, given by the face that started it; absent, nobody watches and nothing stops it.
 */
export type Context = { library: Library; actor: Actor; session: Session; now: Instant; home: string; pass?: Pass }

/** How far a named whole pass is: `done` of `total` (at least `total` with `atLeast`; null while unknown), and one sentence that says so. */
export type PassProgress = { done: number; total: number | null; atLeast?: boolean; text: string }

/**
 * The channel of a named whole pass (deep check, registering everything in a directory): the command
 * line prints each report on standard error and stops on Ctrl-C; the page shows the reports with a way
 * to stop. The first report says how much the pass will do. `stopped` turns true once the person asks
 * it to stop; the pass then ends after the step under way, keeping what it did.
 */
export type Pass = { report(progress: PassProgress): void; stopped(): boolean }

/**
 * The context a plugin's hook receives: the operation's context, its cache directory outside the
 * library (`<home>/cache/<library id>/<plugin>/`, which the kernel does not create and whose deletion
 * must lose nothing), the kernel's helpers bound to the library (its record place is reached through
 * `tools.storage`), and its credentials on this machine.
 */
export type PluginContext = Context & { cacheDir: string; tools: PluginTools; secrets: PluginSecrets }

/**
 * The credentials the owner set for this plugin on this machine with `secret set`: kept under
 * `$PNEUMA_BASE_HOME`, outside every library, so never synced. A plugin reads only its own.
 */
export interface PluginSecrets {
  /** The value of the secret `name`, one the plugin declares; null when the owner has not set it here. */
  get(name: string): Promise<string | null>
}

/**
 * A credential a plugin reads, so the configuration page can show whether it is set and offer to set
 * it. `title`: the name the page shows for it, such as 「API 密钥」; without one the page shows `name`,
 * which is what `secret set` takes. `optional`: the plugin works without it, such as a token only some
 * servers ask for; the page, `secret list` and a deploy target's `target set` then do not ask for it as missing.
 */
export type SecretDecl = { name: string; title?: string; description: string; optional?: boolean }

/** Where a library path lies: the content anyone may arrange, the archive, or the kernel's own files. */
export type Region = 'content' | 'archive' | 'kernel'
/** What an input names in the library: the path, where it lies, and the bundle it lies strictly inside, if any. */
export type Resolved = { path: LibraryPath; region: Region; bundle: LibraryPath | null }
/** A file a bundle counts, with the sha256 of its content. */
export type ManifestEntry = { path: string; fingerprint: Fingerprint; size: number }

/**
 * What a place holds as a thing, from one glance: a file, a bundle (a directory with the marker), a
 * folder (a directory without it), something else (a link, a device), or nothing; with what storage
 * says the place is, null when nothing is there.
 */
export type ThingAt = { path: LibraryPath; kind: ThingKind | 'folder' | 'other' | 'none'; entry: Description | null }

/**
 * A registered thing as the plugin that keeps the register has it: where it is (in the content or
 * the archive), a file or a directory thing, the state token on record (null while unknown), and
 * whether its content's fingerprint is known.
 */
export type RegisteredThing = { place: LibraryPath; kind: ThingKind; token: string | null; fingerprinted: boolean }

/** A page of the register, by the bytes of the places, after the `after` asked; `total`: how many things are registered, when the keeper can say. */
export type RegisteredPage = { things: RegisteredThing[]; more: { after: string } | null; total: number | null }

/**
 * The kernel's helpers a plugin needs, bound to the operation's library so no call takes the root.
 * They are the running kernel's own code: what a bundle counts, how find splits and ranks never drift
 * from a plugin's copy. Paths are library paths unless named absolute. Storage is looked at only where
 * a plugin's records point: no tool walks the library.
 */
export interface PluginTools {
  /** What an agent wrote, relative to the library or absolute inside it; null when it names nothing in the library. */
  resolve(input: string): Promise<Resolved | null>
  regionOf(path: LibraryPath): Region
  /** Where a content path lies in the archive. */
  archivedPath(path: LibraryPath): LibraryPath
  /** The content path of an archived one; null for the archive itself. */
  originalPath(path: LibraryPath): LibraryPath | null
  /** What each path holds as a thing, from one glance at the paths and their markers. */
  what(paths: readonly LibraryPath[]): Promise<ThingAt[]>
  /**
   * Writes the marker into the directory at `dir`, making it one thing: the kernel's marker, so no plugin
   * keeps a copy of its text. Expects no marker there; refused, with what is there, when one is. `hold`:
   * the hold the caller took on `dir`.
   */
  markBundle(dir: LibraryPath, opts?: { hold?: string }): Promise<Written | StorageFailure>
  /** The terms of a find's text, as the kernel splits them. */
  searchTerms(text: string | null, match: FindRequest['match']): string[]
  /** The hits to give from candidates, ranked as the kernel ranks its own. */
  rankHits<T>(candidates: readonly { hit: T; haystack: string }[], terms: readonly string[], match: FindRequest['match']): T[]
  /** How many hits each answerer gives at most when a find matches the words of a sentence. */
  readonly sentenceHits: number
  /** A put through the agent face, as the operation's actor and session, so every plugin hears it and it sends its event. */
  put(req: PutRequest): Promise<PutResult>
  /**
   * What is registered in the library, a page at a time by the bytes of the places (500 a page, at
   * most 1000), as the plugin that keeps the register answers: the first installed one with
   * `registered`. With no such plugin the page is empty and `keeper` is null.
   */
  registered(opts?: { after?: string; limit?: number }): Promise<RegisteredPage & { keeper: PluginName | null }>
  /** Storage, where the plugin's records point: looking at places, content when asked, writes with expectations, its own record place. */
  readonly storage: PluginStorage
}

export type Note = { plugin: PluginName; text: string; data?: unknown }
export type Section = { plugin: PluginName; title: string; body: string; data?: unknown }
export type PluginProblem = { plugin: PluginName; message: string }

/** Hooks answer without naming themselves; the kernel stamps the plugin's name. */
export type PluginNote = Omit<Note, 'plugin'>
export type PluginSection = Omit<Section, 'plugin'>
export type PluginHit = Omit<Hit, 'by'>
/** What `onFind` answers: its hits, or its hits and what it could not do, such as an embedder that did not answer (K8). */
export type PluginFindAnswer = PluginHit[] | { hits: PluginHit[]; problems: string[] }
/**
 * What `onPut` and `onArchive` answer: a note, or a note and what it could not do, such as an outside
 * step that failed after the verb itself succeeded. The kernel lists each problem as this plugin's (K8).
 */
export type PluginNoteAnswer = PluginNote | { note: PluginNote | null; problems: string[] }

// ---- put ----

/**
 * `P` is `string` in a request (as the caller wrote it) and `LibraryPath` once the kernel parsed it.
 * The kinds are the records' words: `brought` is what the faces call imported (`put --imported`),
 * `made` generated (`put --generated`).
 */
export type Origin<P = LibraryPath> =
  | { kind: 'brought'; source: string | null; by: string | null }
  | { kind: 'made'; from: P[]; outside: string[] }

/** `directory`: a directory outside the library, placed as one thing (a bundle). */
export type PlaceSource = { kind: 'file'; path: string } | { kind: 'directory'; path: string } | { kind: 'stdin'; content: Uint8Array }

/**
 * Paths are as the caller wrote them: library-relative or absolute. The kernel parses them.
 * `note`: one sentence on what this put changed. `observed`: the origin was seen, not said, as when
 * the app registers a file the owner copied in; only the owner may put so, and a later origin
 * somebody says replaces it.
 */
export type PutRequest =
  | { kind: 'register'; path: string; origin: Origin<string>; note?: string | null; observed?: true }
  | { kind: 'place'; from: PlaceSource; to: string; origin: Origin<string>; note?: string | null }
  | { kind: 'move'; from: string; to: string }

/**
 * `inside-bundle`: the path lies inside a bundle, which changes only as a whole; `subject` is the
 * bundle. A put refused because no plugin held the replaced content carries, as `notes`, why each
 * plugin with `revise` declined. `agent-session`: an agent put with `observed`, which is the owner's.
 * `ignored`: the library's ignore rules name the path. `busy`: another write holds the place, or it changed
 * while this one went; nothing changed. `too-many`: a directory with more files than one thing takes
 * (5000); `subject` says how many at least.
 */
export type PutRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle' | 'agent-session' | 'ignored' | 'busy' | 'too-many'

export type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint | null; copied: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: PutRefusal; subject: string; notes: Note[]; problems: PluginProblem[] }

/**
 * What storage says a thing is now: its state token, which is its identity until its content is read,
 * and its moment. `size` and `files` are a bundle's bytes and files when its content passed through
 * the kernel (copied in), else null; a file's `size` is its bytes and `files` 1.
 */
export type ThingNow = { token: string; kind: ThingKind; size: number | null; files: number | null; modifiedAt: Instant }

/**
 * What `onPut` receives after the kernel accepted a put. `note` is trimmed; blank or absent is null.
 * `fingerprint` is the content's when it passed through the kernel (a place copies it in and
 * fingerprints it in the same pass); a register or a move reads no content and gives null, and the
 * thing is known by `now.token` until something asks for its content.
 */
export type AcceptedPut =
  | { kind: 'register'; path: LibraryPath; fingerprint: Fingerprint | null; now: ThingNow; origin: Origin; note: string | null; observed?: true }
  | {
      kind: 'place'
      path: LibraryPath
      fingerprint: Fingerprint
      now: ThingNow
      origin: Origin
      note: string | null
      source: { kind: 'file'; path: string } | { kind: 'directory'; path: string } | { kind: 'stdin' }
      copied: boolean
      /** The content it replaced through `revise`: its token, and its fingerprint when one was read. */
      previous: { token: string; fingerprint: Fingerprint | null } | null
    }
  | { kind: 'move'; from: LibraryPath; path: LibraryPath; fingerprint: Fingerprint | null; now: ThingNow }
  /**
   * A register of a directory that holds registered things (an open directory): the loose files of its
   * one level, a page of them at a time, each with what storage said of it; none of their content read.
   * A plugin registers the ones it does not know and leaves the ones it knows as they are.
   */
  | { kind: 'register-files'; path: LibraryPath; files: { path: LibraryPath; now: ThingNow }[]; origin: Origin; note: string | null; observed?: true }

/**
 * What `revise` receives: a place onto a path whose content is to be replaced. `token` is the state of
 * what is there now, which the kernel's write expects; `current` its fingerprint when one is known;
 * `incoming` the new content's, null for a directory not copied in yet.
 */
export type PlaceOverExisting = { path: LibraryPath; token: string; current: Fingerprint | null; incoming: Fingerprint | null }

/**
 * `held`: the plugin keeps the current content where the owner can get it back. The kernel then
 * writes the new content. `declined`: the kernel refuses the put and leaves the target as it is.
 */
export type ReviseOutcome = { outcome: 'held'; note: string | null } | { outcome: 'declined'; reason: string }

// ---- find, inspect, say, check ----

/**
 * `match`: `terms` matches any of the text's terms as written; `words` takes the words of a
 * sentence, ranks by how many distinct words matched, and each answerer gives its best few.
 * `filters` are words of a plugin's vocabulary; the kernel lists no file by name when any is given.
 * `skipOwnSession` leaves out what the caller's own session did, for start, which looks for what
 * the library already had; the kernel's listing by name cannot tell and ignores it.
 */
export type FindRequest = { text: string | null; match: 'terms' | 'words'; filters: Record<string, string>; includeArchived: boolean; skipOwnSession: boolean }
/**
 * `group` is a heading the answerer puts the hit under: hits with the same group are shown together
 * under it, at the place of the first. A grouped hit without a path describes the group itself.
 */
export type Hit = { path: LibraryPath | null; title: string; by: PluginName | 'kernel'; group: string | null; detail: string | null }
export type FindResult = { hits: Hit[]; problems: PluginProblem[] }

/**
 * `content`: give the thing's content too, for a caller that cannot read files; `file` is one in a
 * bundle, relative to it; `fetch`: a file whose content is elsewhere (a placeholder) is fetched first.
 */
export type InspectRequest = { target: string; content?: { file: string | null; fetch?: boolean } }
/** One thing of the library: a regular file, or a directory with the marker `.pneuma-item`. */
export type ThingKind = 'file' | 'bundle'
/**
 * A thing as storage says it is now, read without its content: a file's size, a bundle's first level
 * (`entries`, at most 200, and at least how many more), the token. `fingerprint` only when the request
 * asked for content.
 */
export type FileFacts = {
  path: LibraryPath
  kind: ThingKind
  size: number | null
  modifiedAt: Instant
  token: string
  fingerprint: Fingerprint | null
  archived: boolean
  level?: Level
}
/** One level of a directory: its first entries by name, and at least how many follow. */
export type Level = { entries: { name: string; kind: 'file' | 'dir' | 'other'; size: number | null }[]; more: number }
/**
 * A directory that is no thing, as inspect sees it: `open` when something registered lies in it (its
 * first level), `closed` otherwise (a probe within a budget: at least how many files, which project
 * markers at its top). `ignored`: a place the library's ignore rules name, and by which name or path.
 */
export type PlaceFacts =
  | { kind: 'open'; path: LibraryPath; level: Level }
  | { kind: 'closed'; path: LibraryPath; files: number; exceeded: boolean; markers: string[] }
  | { kind: 'ignored'; path: LibraryPath; by: { name: string } | { path: string } }
/**
 * A thing's content, as inspect gives it when asked. `text`: a file of UTF-8 text within the kernel's
 * limit (256 KB). `other`: any other file, with its size and the media type its name says, null when
 * the name says none. `level`: one level of a bundle, or of a directory in it. `elsewhere`: only a
 * placeholder is on this machine; the content is with `provider` (the placeholder facet's, null when
 * not known), `size` bytes there, and is given when asked with `fetch`. `unavailable`: outside the
 * caller's grant, no such file in the bundle or nothing at the target, or a file asked of a thing that
 * is no bundle.
 */
export type Content =
  | { kind: 'text'; path: LibraryPath; size: number; text: string }
  | { kind: 'other'; path: LibraryPath; size: number; type: string | null; why: 'not-utf8' | 'too-large' }
  | { kind: 'level'; path: LibraryPath; level: Level }
  | { kind: 'elsewhere'; path: LibraryPath; size: number | null; provider: string | null }
  | { kind: 'unavailable'; path: LibraryPath | null; reason: 'outside-grant' | 'no-such-file' | 'not-a-bundle' }
/**
 * `file`: the thing the target names. `place`: a directory that is no thing, or an ignored place, when that is
 * what the target names. `content` is there only when the request asked for it; `request`, when the
 * target is a request's id.
 */
export type InspectResult = { file: FileFacts | null; place?: PlaceFacts; sections: Section[]; problems: PluginProblem[]; content?: Content; request?: OwnerRequest }

export type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
export type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

/** What a plugin's `onSay` answers. A heard answer may carry what it could not do; the kernel lists those as problems. */
export type SayAnswer =
  | { outcome: 'heard'; note: string; problems?: string[] }
  | { outcome: 'not-heard'; reason: 'refused'; note: string }

/**
 * `deep`: the named whole pass, which reads the content of every registered thing (under `dir`, all of
 * them when null) and says how much first; without it check compares state tokens and reads no content.
 * The plugin that does the pass gives what it found as its first section.
 */
export type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean; deep?: { dir: LibraryPath | null } }
/**
 * `asks`: what only the owner can settle now, from every plugin's `onAsks`; an agent tells the owner.
 * `requests`: the caller's own requests (`ask`) the owner decided since it last saw them, the first
 * `TEXT_ROWS` of them, `more` decided ones the next check tells, and how many still wait.
 */
export type CheckResult = { sections: Section[]; asks: Ask[]; requests: { ended: OwnerRequest[]; pending: number; more?: number }; problems: PluginProblem[] }

// ---- ask ----

export type RequestId = string & { readonly __brand: 'RequestId' }

/**
 * `ask`: an agent asks the owner to run one of the owner's commands, saying why; `command` and `args`
 * are what the owner face's dispatch takes. `withdraw`: the agent that asked takes back one still pending.
 */
export type AskRequest = { kind: 'ask'; why: string; command: string; args: OwnerArgs } | { kind: 'withdraw'; id: string }

/** What the command answered when the owner approved: done, refused, or failed with a throw. */
export type RequestOutcome = { outcome: 'done'; text: string } | { outcome: 'refused'; reason: string; text: string } | Failure

export type RequestStatus =
  | { kind: 'pending' }
  | { kind: 'withdrawn'; at: Instant }
  | { kind: 'declined'; at: Instant; reason: string | null }
  | { kind: 'approved'; at: Instant; outcome: RequestOutcome }

/**
 * A request as the kernel reads it from its file: the agent that asked (its grant's id, null without
 * one), when and why, the command and its arguments, `line` the command as the owner would type it,
 * where it stands, and whether the asker has seen how it ended.
 */
export type OwnerRequest = {
  id: RequestId
  by: { name: string; grant: GrantId | null }
  at: Instant
  why: string
  command: string
  args: OwnerArgs
  line: string
  status: RequestStatus
  seen: boolean
}

/**
 * Why an ask is refused. `red-line`: a destructive command, which needs the owner in person.
 * `not-askable`: one that needs the owner's own input, or a request command. `run-it-yourself`: one
 * an agent may run. `too-many`: the agent already has the most requests pending.
 */
export type AskRefusal =
  | 'not-an-agent'
  | 'unknown-command'
  | 'usage'
  | 'red-line'
  | 'not-askable'
  | 'run-it-yourself'
  | 'too-many'
  | 'no-such-request'
  | 'not-yours'
  | 'not-pending'

/** `again`: the same request from the same agent was already pending; it is the one answered. */
export type AskResult =
  | { outcome: 'asked'; request: OwnerRequest; again: boolean; problems: PluginProblem[] }
  | { outcome: 'withdrawn'; request: OwnerRequest; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: AskRefusal; text: string; problems: PluginProblem[] }

// ---- archive ----

export type ArchiveRequest = { kind: 'archive' | 'unarchive'; path: string }
/** `ignored`: the library's ignore rules name the path. `busy`: another write holds it, or it changed while this one went; nothing moved. */
export type ArchiveRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken' | 'inside-bundle' | 'ignored' | 'busy'
export type ArchiveResult =
  | { outcome: 'accepted'; from: LibraryPath; to: LibraryPath; moved: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: ArchiveRefusal; subject: string; problems: PluginProblem[] }

/** What `onArchive` receives. `moved` is false when the request was already satisfied. */
export type AcceptedArchive = { kind: 'archive' | 'unarchive'; from: LibraryPath; to: LibraryPath; moved: boolean }

// ---- the two faces ----

export interface AgentFace {
  put(req: PutRequest, ctx: Context): Promise<PutResult>
  find(req: FindRequest, ctx: Context): Promise<FindResult>
  inspect(req: InspectRequest, ctx: Context): Promise<InspectResult>
  say(req: SayRequest, ctx: Context): Promise<SayResult>
  check(req: CheckRequest, ctx: Context): Promise<CheckResult>
  archive(req: ArchiveRequest, ctx: Context): Promise<ArchiveResult>
  /** The kernel's own: no plugin hook stands behind it, so it answers the same in a library with no plugin. */
  ask(req: AskRequest, ctx: Context): Promise<AskResult>
}

export type Verb = keyof AgentFace

export type OwnerArgs = { positional: string[]; flags: Record<string, string[] | true> }

export type OwnerResult =
  | { outcome: 'done'; text: string; data?: unknown; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: string; text: string; offer?: Action; problems: PluginProblem[] }

/**
 * What an owner command's `run` answers. The kernel adds `problems`. A refusal may `offer` one
 * action the person can take instead, such as removing a plugin that refused anyway: the page shows
 * it beside the refusal, and it runs as any button does, asking its `confirm` first.
 */
export type OwnerAnswer = { outcome: 'done'; text: string; data?: unknown } | { outcome: 'refused'; reason: string; text: string; offer?: Action }

/** A value a `value` flag takes, and what it means, for people. */
export type ParamOption = { value: string; label: string }

/**
 * One argument by position. `hint`: a few Chinese words for what to write, shown as `<hint>` in the
 * usage line and as the form's label. `many`: it takes the rest, one or more when `required`, else
 * none or more; only the last may. `pattern`: a regular expression each value matches whole (`u` flag).
 */
export type PositionalParam = { readonly name: string; readonly hint: string; readonly required?: boolean; readonly many?: boolean; readonly pattern?: string }

/**
 * One flag, `--<name>`. `value` takes exactly one value, `list` one or more up to the next flag,
 * `boolean` none, and is never required. A `value` flag with `options` takes only those values.
 */
export type FlagParam = {
  readonly name: string
  readonly hint: string
  readonly kind: 'value' | 'list' | 'boolean'
  readonly required?: boolean
  readonly pattern?: string
  readonly options?: readonly ParamOption[]
}

/** How a command's arguments are written. The command line parses by it, the kernel checks by it, and help and forms are made from it. */
export type OwnerParams = { readonly positional?: readonly PositionalParam[]; readonly flags?: readonly FlagParam[] }

/** The checked values of a call, by argument name. */
export type OwnerValues = { readonly [name: string]: string | readonly string[] | boolean | null }

type Each<L> = L extends readonly (infer E)[] ? E : never
type NameOf<T> = T extends { name: infer N extends string } ? N : never
type PositionalValue<A> = A extends { many: true } ? readonly string[] : A extends { required: true } ? string : string | null
type FlagValue<F> = F extends { kind: 'boolean' } ? boolean : F extends { kind: 'list' } ? readonly string[] : F extends { required: true } ? string : string | null
/** The values of `P` by name: a required value is a string, an optional one may be null, a list or `many` is a list, a boolean is true or false. */
export type ParamValues<P extends OwnerParams> = { readonly [A in Each<P['positional']> as NameOf<A>]: PositionalValue<A> } & {
  readonly [F in Each<P['flags']> as NameOf<F>]: FlagValue<F>
}

/** What an owner command's `run` gets: the arguments as written, and their values by name as checked against `params`. */
export type CommandArgs = OwnerArgs & { readonly values: OwnerValues }

/**
 * A command a plugin adds to the owner face. The kernel refuses a destructive one in an agent session
 * or without confirmation, and an `ownerOnly` one in an agent session, without asking: it changes no
 * data but decides for the owner, such as what goes online or where the library syncs.
 *
 * `params` declares its arguments; a command that takes none declares `{}`. The command line reads a
 * call by them, the kernel refuses one that does not fit them before `run`, help shows the usage made
 * from them, and a page's form is made from them with `formOf`. Write the command with
 * `defineCommand` to get the values typed.
 */
export interface OwnerCommand {
  readonly name: string // `<plugin> ` and one or more words, e.g. 'ledger copies restore'
  readonly summary: string
  readonly params: OwnerParams
  readonly destructive: boolean
  readonly ownerOnly: boolean
  /** It changes nothing, in the library or outside it, and takes nothing out, such as a listing: looking is no act, and the audit keeps no fact of it. */
  readonly readOnly?: boolean
  /** What it does, for its row in the audit; without it the row is the command itself. */
  readonly act?: OwnerAct
  /** It configures plugins, targets or embedders without changing items; its event is news only after an agent's first visit. */
  readonly setup?: boolean
  /**
   * An owner-only command that loses no data can be asked for: an agent asks with `ask`, and the
   * owner approves with one act. `false`: it cannot, as one the owner has to do in person.
   */
  readonly askable?: false
  readonly run: (args: CommandArgs, ctx: PluginContext) => Promise<OwnerAnswer>
}

/**
 * What an owner command does, as its row in the audit says it: the kind of act, drawn as an icon, and
 * what it was done to: the argument named `object` (a positional or a flag of its `params`), else
 * `name`, a fixed name such as 归档.
 */
export type OwnerAct = { readonly kind: FeedAct; readonly object?: string; readonly name?: string }

// ---- events ----

export type Failure = { outcome: 'failed'; message: string }

/** An owner command run because the owner approved an agent's request: which request, and who asked. */
export type Requested = { id: RequestId; by: OwnerRequest['by'] }

/**
 * One per operation of either face, sent to every plugin's `observe` after the operation. An owner
 * operation that runs an approved request carries `request`.
 */
export type Event =
  | { [V in Verb]: { face: 'agent'; verb: V; request: Parameters<AgentFace[V]>[0]; result: Awaited<ReturnType<AgentFace[V]>> | Failure } }[Verb]
  | { face: 'owner'; command: string; args: OwnerArgs; destructive: boolean; readOnly: boolean; setup: boolean; act?: OwnerActDone; request?: Requested; result: OwnerResult | Failure }

/** An owner command's `act` as it ran: the kind, and what it was done to as the call gave it, or null. */
export type OwnerActDone = { kind: FeedAct; object: string | null }

// ---- the extension point ----

export type CognitionSection = { title: string; text: string }
export type StorageDecl = { dir: string; kind: 'body' | 'cache' } // relative to the plugin's own directory

/** An object with only a contract, a name and empty lists is a valid plugin. */
export interface Plugin {
  /** The plugin contract it is written against: the sdk's `CONTRACT` (2), the only one the kernel runs. */
  readonly contract: number
  readonly name: PluginName
  /** Its own version, for people. */
  readonly version?: string
  /** The name a person would say, such as 记账 for `ledger`; its `name` stays the identifier. */
  readonly title?: string
  /** What it does, in a short Chinese line for people: about twenty characters at most. */
  readonly summary?: string
  /** What it brings, said whole, shown on demand beside its title. */
  readonly about?: string
  readonly cognition: CognitionSection | null
  /**
   * With `revise`: whether it holds every replaced content (`every`) or only some (`some`, the
   * default), such as only what an agent declared. The description's same-name rule follows (K6).
   */
  readonly keeps?: 'every' | 'some'
  readonly storage: readonly StorageDecl[]
  readonly statements: readonly string[]
  readonly ownerCommands: readonly OwnerCommand[]
  /** The credentials it reads with `ctx.secrets.get`, each with one Chinese line on what it is for. */
  readonly secrets?: readonly SecretDecl[]

  // Hooks are function-typed properties, not methods, so a hook is checked strictly against what the kernel gives it.
  readonly onPut?: (req: AcceptedPut, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly revise?: (req: PlaceOverExisting, ctx: PluginContext) => Promise<ReviseOutcome>
  readonly onFind?: (req: FindRequest, ctx: PluginContext) => Promise<PluginFindAnswer>
  /** What it knows about paths that others found and it did not: each hit is about one of `paths`. */
  readonly onFound?: (paths: readonly LibraryPath[], req: FindRequest, ctx: PluginContext) => Promise<PluginHit[]>
  readonly onInspect?: (req: InspectRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onSay?: (req: SayRequest, ctx: PluginContext) => Promise<SayAnswer>
  readonly onCheck?: (req: CheckRequest, ctx: PluginContext) => Promise<PluginSection[]>
  /**
   * What only the owner can settle now, such as a thing declared deployable that is not online yet.
   * Read-only: the home page asks on every look, and `check` gives the same to agents.
   */
  readonly onAsks?: (ctx: PluginContext) => Promise<PluginAsk[]>
  readonly onArchive?: (req: AcceptedArchive, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly observe?: (event: Event, ctx: PluginContext) => Promise<void>
  /** After `archive purge` deleted things, with their library paths as they were in the archive. */
  readonly onPurged?: (paths: readonly LibraryPath[], ctx: PluginContext) => Promise<void>
  /** Once, after `plugin enable` installed it. A problem it answers, or a throw, is shown in the answer of `plugin enable`, which still succeeds. */
  readonly onAdd?: (ctx: PluginContext) => Promise<void | { problems: string[] }>
  /**
   * Before `plugin disable` takes it out. It may refuse with a Chinese sentence saying why and what to
   * do first. `plugin disable <name> --force` removes it all the same, and the answer repeats the sentence.
   */
  readonly onRemove?: (ctx: PluginContext) => Promise<void | { refuse: string }>
  /**
   * One page of what was registered before it was added, as `tools.registered` gives it: what it would
   * have learned from the puts it did not hear. The kernel's catching up calls it page after page, on
   * `plugin enable` of a library that has registered things and on `plugin backfill`; a page may come
   * again after an interruption, so learning one twice must change nothing.
   */
  readonly catchUp?: (things: readonly RegisteredThing[], ctx: PluginContext) => Promise<void>

  /**
   * The directories its records make open: each holds, at some depth, something registered. The kernel
   * adds the root; the management UI's change poll looks at these and at no other directory.
   */
  readonly openDirs?: (ctx: PluginContext) => Promise<LibraryPath[]>
  /**
   * It keeps the register: a page of what is registered, by the bytes of the places after `after`, at
   * most `limit` things. The kernel asks the first installed plugin that has it whenever a plugin calls
   * `tools.registered`.
   */
  readonly registered?: (req: { after: string | null; limit: number }, ctx: PluginContext) => Promise<RegisteredPage>

  /** The views it adds to the management UI. Each id starts with `<name>.`. */
  readonly views?: readonly ViewDecl[]
  readonly onView?: (req: ViewRequest, ctx: PluginContext) => Promise<ViewAnswer>
  /**
   * What it knows about one library path, as one section of the kernel's item panel: onInspect's
   * counterpart in the UI. `panel`: the panel's parameters, where its long lists' pages stand
   * (`pagingOf` with a `name` of its own and target `panel`), and how many rows a page holds.
   */
  readonly onItemView?: (path: LibraryPath, ctx: PluginContext, panel?: { params: Record<string, string>; size: number }) => Promise<ItemSection | null>
  /** The absolute path of the directory its `custom` blocks' pages are in, such as `ui/` beside its `index.js`. */
  readonly ui?: string
}

export type PluginTable = ReadonlyMap<string, Plugin>

// ---- the viewer face: read-only, sends no event ----
// A view is a page the management UI shows: typed blocks, rendered without knowing which plugin
// gave them. Changes from the UI go through the two faces above, never through a view.

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info'
export type Tag = { text: string; tone: Tone }
/** Where a click goes: another view, opened in the main area or the side panel. */
export type Link = { view: string; params: Record<string, string>; target: 'main' | 'panel' }
/**
 * Who did something, where a block says who: an agent, with the name of the grant it used, or the
 * owner. The page draws an agent as its mark, its initial on a colour that comes from its name.
 */
export type ActorMark = { kind: 'agent' | 'owner'; name: string; grant?: string }
/**
 * `at`: the cell is a moment. The page shows it in the viewer's local time, short, with the whole
 * time on hover; `text` is what a reader without a clock shows. `icon`: one of `ICON_NAMES`, shown
 * before the text, such as `folder`, `file` or `package` for a bundle. `href`: an outside address the
 * cell opens in a new tab; only http and https are links. `copy`: a button that copies `href`, else
 * `text`. `actor`: the cell says who; the page draws the mark before `text`, which is the name.
 * `normal`: the value is the usual state, such as a thing being as recorded. The page leaves it out
 * (a table column whose every cell is normal steps aside, a field with a normal value is not shown),
 * so only a departure from it catches the eye; the text form still prints it. `reopen`: the cell names
 * a scene whose conversation is on this machine; in the Mac app the page offers to open it again
 * beside the cell. `local`: `text` is an absolute path on the machine the views run on, such as where
 * the library is kept; the page shows its last part, the whole in its tooltip, a way to copy it, and
 * in the Mac app a way to show it in Finder. The text form prints the whole path.
 */
export type Cell = { text: string; mono?: boolean; muted?: boolean; tag?: Tag; link?: Link; at?: Instant; icon?: IconName; href?: string; copy?: true; actor?: ActorMark; normal?: true; reopen?: Reopen; local?: true }

/**
 * How the Mac app opens a scene's conversation again on this machine, the first way it can: `url`,
 * when an application of this machine handles it; `run`, a command run in the default terminal in
 * `cwd`; `reveal`, the conversation's file shown in Finder. Paths are absolute. Given only while the
 * file is on this machine, as the product's rule in the kernel's products table says.
 */
export type Reopen = { url: string | null; run: { command: string; cwd: string } | null; reveal: string }

/**
 * The place of the library a table row stands for, so the page can treat the row as a file: select
 * it, preview, open and drag it, draw it as a tile. `kind`: a file, a directory thing, a folder with
 * something registered in it (`open`), a folder with nothing registered in it (`closed`). `token`:
 * storage's state token, which the page keeps only as the key of what it made of the file, such as
 * a thumbnail. `elsewhere`: only a placeholder is on this machine.
 */
export type RowPlace = { path: LibraryPath; kind: 'file' | 'bundle' | 'open' | 'closed'; token: string | null; elsewhere?: true }

/** What a table that lists places can be sorted by. */
export type SortKey = 'name' | 'modified' | 'kind' | 'size'

/** One folder of a path bar: its name and the link that shows it. */
export type Crumb = { label: string; link: Link }

/**
 * What a button does: one verb of the agent face, or one owner command. Strings may hold `{input}`,
 * replaced by that input's value. A `multiple` input's values, one per line, replace a list element
 * that is exactly `{input}`, one element each. An input left empty gives an empty string, which the
 * faces take as not given. An owner call's `stdin` is what the command reads as its standard input,
 * such as the value `secret set` keeps; it is never part of the event.
 */
export type Call =
  | { [V in Verb]: { face: 'agent'; verb: V; request: Parameters<AgentFace[V]>[0] } }[Verb]
  | { face: 'owner'; command: string; args: OwnerArgs; stdin?: string }
/**
 * `pattern`: a regular expression a filled value must match whole, each line of a `multiple` one;
 * `hint` says what fits. `secret`: the value is typed hidden, as a password is.
 */
export type ActionInput = {
  name: string
  label: string
  placeholder: string | null
  value: string | null
  options: { value: string; label: string }[] | null
  multiple?: boolean
  pattern?: string
  hint?: string
  secret?: true
}
/**
 * `confirm`: a question the person answers before the call; the answer is the in-person confirmation a
 * destructive command needs.
 *
 * How the page draws it, in the region it stands in (a page's or a section's head, a row): `as`
 * `primary`, the region's one main action, a filled button; `icon`, a button that is only its `icon`,
 * the label its tooltip; `menu`, an entry of the region's 「···」 menu; `inline`, for an action of one
 * text input, the input written in place (in a timeline, the line where one more entry is written),
 * run with Enter. Left out, the first such action of a region is a quiet text button and the rest go
 * to the menu; a `danger` one always goes to the menu. `icon`: one of `ICON_NAMES`, before the label
 * or alone. `key`: one letter that runs it while its region holds the focus, named in its tooltip and
 * menu entry. The text form prints every action as its command, wherever the page draws it.
 */
export type Action = { label: string; tone: 'default' | 'danger'; confirm: string | null; inputs: ActionInput[]; call: Call; as?: 'primary' | 'icon' | 'menu' | 'inline'; icon?: IconName; key?: string }

/**
 * `group`: rows with the same group stand together under it as a heading, in the order of the first
 * row of each, so a long prefix they share, such as their folder, is said once; the cells then hold
 * only what comes after it. A row with a link shows its actions while the pointer or the focus is on it.
 * `place`: the place of the library the row stands for.
 */
export type TableRow = { key: string; cells: Record<string, Cell>; link: Link | null; actions: Action[]; group?: string; place?: RowPlace }
/**
 * Where one page of a long list stands: `first`, the place of its first row counted from 1, and
 * `shown`, how many rows it shows; `total`, how many rows the whole list has, or with `atLeast` how
 * many at least; the pages before and after it, null at either end. The sdk's `pagingOf` makes it
 * from the view's parameters.
 */
export type Paging = { first: number; shown: number; total: number; atLeast?: true; prev: Link | null; next: Link | null }
/** An `optional` column steps aside, the last one first, when the table has no room to show every column whole. */
export type TableColumn = { key: string; label: string; optional?: boolean }

/**
 * The kind of act a feed row tells, which a page shows as an icon instead of a word: a thing put in by
 * the one who made it, a thing brought in from outside, new content, a move, archived, taken back from
 * the archive, a note or a decision written about something, what a session says it is doing, sources
 * added to a thing, a thing gone with the archive it was in, a command run, a request to the owner.
 */
/** The kinds of act a feed row draws as an icon: an agent's on the content, and what an owner command did (`OwnerAct`). */
export const FEED_ACTS = [
  'generated',
  'imported',
  'changed',
  'moved',
  'archived',
  'restored',
  'note',
  'decision',
  'task',
  'basis',
  'removed',
  'command',
  'request',
  'created',
  'on',
  'off',
  'connected',
  'disconnected',
  'granted',
  'revoked',
  'installed',
  'uninstalled',
  'set',
  'synced',
  'exported',
  'declined',
  'hidden',
  'shown',
] as const
export type FeedAct = (typeof FEED_ACTS)[number]
/**
 * One thing that happened, as a feed tells it: when, who, one sentence, a grey line of `meta`, and
 * `whose` act it was, where that says something: an agent's on its own, the owner's, one the owner
 * approved at an agent's request, or one the app only observed. It carries one quiet `action`, such
 * as the one that undoes it, or `settled`, a grey word saying how it ended, such as that it was taken
 * back; not both. A row with a `link` opens it.
 *
 * `act`, `path` and `note` say the same row in parts, so a page can say less: the kind of act, the
 * library path of the thing it is about (for an owner command, what it was done to, as given), and
 * the words the actor wrote with it (a put's note, the text
 * of a note or a decision, what a session says it is doing). With `act`, the page draws the act as an
 * icon and the thing as its name, its folder grey beside it, and the note, when there is one, as the
 * row's second line in place of `meta`; with no `path` the note is the row's line. `text` stays the
 * whole sentence: in the row's tooltip, in the text form and wherever the parts are not drawn.
 */
export type FeedRow = {
  key: string
  at: Instant
  actor: ActorMark | string
  text: string
  meta: Cell[]
  whose?: 'agent' | 'owner' | 'approved' | 'observed'
  action?: Action
  settled?: string
  link: Link | null
  act?: FeedAct
  path?: LibraryPath
  note?: string
}
/**
 * Rows under a heading, such as a day or a scene; `link` opens what the heading names; `reopen`, the
 * scene's conversation, as a cell's. `groups`: headings of their own under this one, in place of its
 * rows, which are then empty, such as a day's scenes; one level deep.
 */
export type FeedGroup = { title: string; count: number | null; link?: Link; rows: FeedRow[]; reopen?: Reopen; groups?: FeedGroup[] }
/**
 * One row of a list: its cell, a grey `note` under it, and its actions. `about`: what the row is, said
 * whole, shown on demand beside the cell, as a section's. `toggle`: the row is a setting that is on or
 * off, drawn as a switch at its end; turning it runs `action`, which turns it the other way (asking its
 * `confirm` first), so `action` is the one for the state it is not in. The text form prints the state
 * and the action's command.
 */
export type ListItem = { cell: Cell; note: string | null; actions: Action[]; about?: string; toggle?: { on: boolean; action: Action } }
/** One figure: a label, a number or a short text, and a grey sentence about it. */
export type Stat = { label: string; value: string; note: string | null }
/** The most series a chart draws: each takes the next colour of one small palette, the same in every chart. */
export const CHART_SERIES_MAX = 4
/** One series of a chart: its name, and one value for each of the chart's `x` labels. */
export type ChartSeries = { label: string; values: number[] }
/** A folder of a tree: the value its selection gives the view's parameter, and how many things it holds. */
export type TreeNode = { value: string; label: string; count: number | null; children: TreeNode[] }
/**
 * Something only the owner can settle: who raises it, a plugin's name or an actor; one sentence, a
 * question or a statement; `command`, a command line it is about, shown under the sentence exactly as
 * it would run; the library path it is `about`, which opens its panel; the answers, each an action,
 * and which of them is the `suggested` one, by its place in `actions`.
 */
export type Ask = { key: string; by: string | ActorMark; text: string; command?: string; about: LibraryPath | null; actions: Action[]; suggested?: number }
/** What `onAsks` answers: an ask without naming its plugin, which the kernel stamps as `by`. */
export type PluginAsk = Omit<Ask, 'by'>
/**
 * One step of getting started with the library. One not `done` shows its `blocks`, what to do right
 * there; a done one folds into its title and `summary`, one line, and opens again when clicked.
 */
export type Step = { key: string; title: string; done: boolean; summary: string | null; blocks: Block[] }

/**
 * A section with `collapse` can be folded by the viewer; the value is how it starts. `about`: what the
 * section is for, for someone new to it, shown on demand beside its title; `note` is what it says now.
 * `normal`: nothing in it needs the person now, such as no question waiting; the page leaves the
 * section out and the text form prints it. A section of the item panel carries `plugin`, the plugin
 * whose part it is, stamped by the kernel. `fields` with `line`: values that explain themselves, such
 * as who, when and in which scene, said as one line without their labels, which stay in the text form
 * and in each value's tooltip. `actions` with `head`: what can be done with what the whole page
 * shows, drawn in its head beside the title. `embed`: an outside http or https page in a sandboxed frame. `custom`: a page of the plugin's own, `entry`
 * relative to its `ui` directory, sent `data` and the names of `actions`, which it may ask to run;
 * `text` says in words what the frame shows, for the command line, screen readers and the page
 * that failed to load; `plugin` is stamped by the kernel. `feed`, `asks`: `empty` is the one grey
 * sentence shown when there is nothing. `tree`: choosing a folder sets the view's parameter `param`
 * to its value and shows the view again, as a filter does; `selected` is the value it has now.
 * `steps`: the steps of getting started, each with its own blocks, checked as a section's are.
 * `drop`: where the owner brings files in. In the Mac app it is an area files and folders are dropped
 * on, or chosen from, and they are put into the library folder `to` as brought by the owner;
 * elsewhere the page cannot hand over a file, and it shows `command`, which does the same in a terminal.
 * `chart`: a few numbers over time, as `form` bars side by side, bars stacked, or lines, with one
 * axis in `unit` (such as 样 or 次); `text` is the one sentence that says what it shows, the chart's
 * caption on the page; `show` prints the sentence and a table of the numbers. At most
 * `CHART_SERIES_MAX` series, each with a value for every `x` label; stacked values are not negative.
 * `timeline`: an entry's `actor`, who did it, is drawn as its mark on the line, the text form prints the name.
 * `page` on a table, a list, a timeline or a feed: its rows are one page of a longer list, the page
 * drawn under them with the total and the way to the pages before and after.
 * A table whose rows carry places: `sorted`, how it is sorted now; it sorts again by the view's
 * parameter `sort` (a `SortKey`, with a leading `-` for the reverse), and its columns named like a
 * `SortKey` sort by it. `each`: what can be done with any of its things (places of kind `file` or
 * `bundle`), said once for all of them:
 * `actions`, in which `{path}` is the place and `{in}` its folder with a slash (empty at the root);
 * `rename`, an action whose one input `name` is written in place over the row's name.
 */
export type Block =
  | { kind: 'section'; title: string; note: string | null; count: number | null; blocks: Block[]; actions: Action[]; collapse?: 'open' | 'closed'; plugin?: PluginName; about?: string; normal?: true }
  | { kind: 'table'; columns: TableColumn[]; rows: TableRow[]; empty: string; page?: Paging; sorted?: { by: SortKey; desc: boolean }; each?: { actions: Action[]; rename: Action | null } }
  | { kind: 'fields'; fields: { label: string; value: Cell }[]; line?: true }
  | { kind: 'list'; items: ListItem[]; page?: Paging }
  | { kind: 'timeline'; entries: { at: Instant; title: Cell; lines: string[]; tag: Tag | null; actions?: Action[]; actor?: ActorMark | string }[]; page?: Paging }
  | { kind: 'text'; text: string; tone: Tone }
  | { kind: 'preview'; path: LibraryPath }
  | { kind: 'actions'; actions: Action[]; head?: true }
  | { kind: 'empty'; title: string; hint: string | null }
  | { kind: 'embed'; url: string; title: string; height: number }
  | { kind: 'custom'; entry: string; height: number; text: string; data: unknown; actions: Record<string, Action>; plugin?: PluginName }
  | { kind: 'feed'; groups: FeedGroup[]; empty: string; page?: Paging }
  | { kind: 'stats'; stats: Stat[] }
  | { kind: 'tree'; param: string; selected: string; nodes: TreeNode[] }
  | { kind: 'asks'; asks: Ask[]; empty: string }
  | { kind: 'steps'; steps: Step[] }
  | { kind: 'drop'; to: string; command: string }
  | { kind: 'chart'; form: 'bars' | 'stacked' | 'line'; text: string; unit: string; x: string[]; series: ChartSeries[] }

/** `count`: how many things the view shows with this option, given by its answer. */
export type FilterOption = { value: string; label: string; count?: number }
/**
 * A filter of the page's head. The page shows its options as tabs, an option counted 0 left out
 * unless chosen, and `label` only to screen readers and the text form; `as` `menu` makes it one
 * button that opens the options, for a choice among many, such as which agent.
 */
export type ViewFilter = { name: string; label: string; options: FilterOption[]; default: string; as?: 'tabs' | 'menu' }
/**
 * `icon` is one of `ICON_NAMES`. A view with `nav` false is reached only through links, as a detail.
 * `ownerOnly`: a page of management, refused in an agent's session as an owner-only command is.
 * `home`: the view is also a part of the home page: its blocks stand there, after what waits on the
 * owner, in configuration order. `with`: the id of the view whose entry in the navigation this one
 * shares, such as the statistics of the activity: it leaves the navigation, and the head of each view
 * of the entry switches between them; while that view is not there, it has an entry of its own.
 */
export type ViewDecl = { id: string; title: string; icon: IconName; nav: boolean; filters: ViewFilter[]; ownerOnly?: boolean; home?: boolean; with?: string }
/** A view as the library lists it, with who gives it. */
export type ListedView = ViewDecl & { by: PluginName | 'kernel' }
/** `size`: how many rows a page of a long list holds, as the face asks: `PAGE_ROWS` on the page, `TEXT_ROWS` in the text form; absent, `PAGE_ROWS`. */
export type ViewRequest = { view: string; params: Record<string, string>; size?: number }
/**
 * `refresh`: seconds after which the page asks again, at least 5: for a view showing state from
 * outside the library, or one whose content changes with the clock. A view runs on the machine of
 * the viewer's server, in its time zone; a cell's `at` is shown in the browser's. `filters`: the
 * options of declared filters as this answer sees them, such as the agents there are, with counts.
 * `open`: what the page shows in the detail panel when it opens with the panel closed and the window
 * has room for both, such as a list's first row; a panel link. The text form leaves it out.
 * `trail`: the folders from the library's root to the one the page shows, the last being it; the page
 * draws them as a path bar in place of the title and the subtitle.
 */
export type ViewAnswer = { title: string; subtitle: string | null; blocks: Block[]; refresh?: number; filters?: { name: string; options: FilterOption[] }[]; open?: Link; trail?: Crumb[] }
export type ViewResult =
  /** `icon`: the kernel's item panel gives the icon of the kind of thing it shows, instead of the view's. */
  | ({ outcome: 'shown' } & ViewAnswer & { problems: PluginProblem[]; icon?: IconName })
  | { outcome: 'no-such-view'; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'agent-session'; text: string; problems: PluginProblem[] }
/** Every view of a library: the plugins' first, in configuration order, then the kernel's. */
export type ViewList = { views: ListedView[]; problems: PluginProblem[] }
/** A plugin's part of the item panel: its own section title and blocks, and `actions` for the thing, which stand in the panel's bottom row. */
export type ItemSection = { title: string; blocks: Block[]; actions?: Action[] }
