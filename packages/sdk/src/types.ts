// The plugin contract's shapes, which a plugin and the kernel exchange. ARCHITECTURE.md sections 4 and 5.
import type { IconName } from './icons.js'

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

/** `home` is this machine's `$PNEUMA_BASE_HOME`: local grant files, external plugins, plugin caches. */
export type Context = { library: Library; actor: Actor; session: Session; now: Instant; home: string }

/**
 * The context a plugin's hook receives: the operation's context, the plugin's own directory in the
 * library, its cache directory outside the library (`<home>/cache/<library id>/<plugin>/`), the
 * kernel's helpers bound to the library, and its credentials on this machine. The own directory
 * exists whenever a hook runs. The kernel does not create the cache directory; deleting it must lose nothing.
 */
export type PluginContext = Context & { dir: string; cacheDir: string; tools: PluginTools; secrets: PluginSecrets }

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
 * it. `optional`: the plugin works without it, such as a token only some servers ask for; the page,
 * `secret list` and a deploy target's `target set` then do not ask for it as missing.
 */
export type SecretDecl = { name: string; description: string; optional?: boolean }

/** Where a library path lies: the content anyone may arrange, the archive, or the kernel's own files. */
export type Region = 'content' | 'archive' | 'kernel'
/** What an input names in the library: the path, where it lies, and the bundle it lies strictly inside, if any. */
export type Resolved = { path: LibraryPath; region: Region; bundle: LibraryPath | null }
/** A thing's facts that need no hashing. A file counts as one file; a bundle, as the files its fingerprint counts. */
export type Thing = { kind: ThingKind; size: number; files: number; modifiedAt: Instant }
/** A file a bundle counts: its path relative to the bundle, '/'-separated. */
export type BundleFile = { path: string; size: number; modifiedAt: Instant }
/** A file a bundle counts, with the sha256 of its content. */
export type ManifestEntry = { path: string; fingerprint: Fingerprint; size: number }

/**
 * The kernel's helpers a plugin needs, bound to the operation's library so no call takes the root.
 * They are the running kernel's own code: what a bundle counts, how a fingerprint is taken, how find
 * splits and ranks never drift from a plugin's copy. Paths are library paths unless named absolute.
 */
export interface PluginTools {
  /** What an agent wrote, relative to the library or absolute inside it; null when it names nothing in the library. */
  resolve(input: string): Promise<Resolved | null>
  regionOf(path: LibraryPath): Region
  /** Where a content path lies in the archive. */
  archivedPath(path: LibraryPath): LibraryPath
  /** The content path of an archived one; null for the archive itself. */
  originalPath(path: LibraryPath): LibraryPath | null
  abs(path: LibraryPath): string
  /** The file or bundle at a path; null when neither is there. */
  thing(path: LibraryPath): Promise<Thing | null>
  /** Every thing in the content and the archive: each file outside bundles, and each bundle. */
  things(): Promise<LibraryPath[]>
  /** The files the bundle at a path counts, in fingerprint order; null when no bundle is there. */
  files(path: LibraryPath): Promise<BundleFile[] | null>
  /**
   * Copies the thing at a path into the absolute directory `to`, which must not exist: a bundle's
   * counted files without its marker, a file under its own name. Answers the fingerprint of the copy,
   * to compare with the content decided on; null when nothing is there. Throws when `to` lies in the
   * library outside the plugin's own directory.
   */
  copyOut(path: LibraryPath, to: string): Promise<Fingerprint | null>
  /** The fingerprint of the file or bundle at a path; null when neither is there. */
  fingerprint(path: LibraryPath): Promise<Fingerprint | null>
  /** Each file the bundle at a path counts, with its sha256; null when no bundle is there. */
  manifest(path: LibraryPath): Promise<ManifestEntry[] | null>
  /** A bundle's fingerprint from its manifest, reading no file. */
  fingerprintOfManifest(entries: readonly Pick<ManifestEntry, 'path' | 'fingerprint'>[]): Fingerprint
  /** The fingerprint of a regular file anywhere on this machine, such as a copy the plugin keeps. */
  fingerprintOfFile(absolute: string): Promise<Fingerprint>
  /** The terms of a find's text, as the kernel splits them. */
  searchTerms(text: string | null, match: FindRequest['match']): string[]
  /** The hits to give from candidates, ranked as the kernel ranks its own. */
  rankHits<T>(candidates: readonly { hit: T; haystack: string }[], terms: readonly string[], match: FindRequest['match']): T[]
  /** How many hits each answerer gives at most when a find matches the words of a sentence. */
  readonly sentenceHits: number
  /** A put through the agent face, as the operation's actor and session, so every plugin hears it and it sends its event. */
  put(req: PutRequest): Promise<PutResult>
  /**
   * The paths a put is placing, registering or moving right now, sorted. A put lands its file before
   * any plugin records it, so a file at one of these paths is no stray: its put has not finished.
   */
  putting(): Promise<LibraryPath[]>
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

/** `P` is `string` in a request (as the caller wrote it) and `LibraryPath` once the kernel parsed it. */
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
 */
export type PutRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle' | 'agent-session'

export type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint; copied: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: PutRefusal; subject: string; notes: Note[]; problems: PluginProblem[] }

/** What `onPut` receives after the kernel accepted a put. `note` is trimmed; blank or absent is null. */
export type AcceptedPut =
  | { kind: 'register'; path: LibraryPath; fingerprint: Fingerprint; origin: Origin; note: string | null; observed?: true }
  | {
      kind: 'place'
      path: LibraryPath
      fingerprint: Fingerprint
      origin: Origin
      note: string | null
      source: { kind: 'file'; path: string } | { kind: 'directory'; path: string } | { kind: 'stdin' }
      copied: boolean
      previous: Fingerprint | null // the content it replaced through `revise`, if any
    }
  | { kind: 'move'; from: LibraryPath; path: LibraryPath; fingerprint: Fingerprint }

/** What `revise` receives: a place onto a path that holds different content. */
export type PlaceOverExisting = { path: LibraryPath; current: Fingerprint; incoming: Fingerprint }

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

/** `content`: give the thing's content too, for a caller that cannot read files; `file` is one in a bundle, relative to it. */
export type InspectRequest = { target: string; content?: { file: string | null } }
/** One thing of the library: a regular file, or a directory with the marker `.pneuma-item`. */
export type ThingKind = 'file' | 'bundle'
/** A bundle's `size` and `files` count the files its fingerprint counts; `modifiedAt` is the latest of theirs. */
export type FileFacts = { path: LibraryPath; kind: ThingKind; files: number; size: number; modifiedAt: Instant; fingerprint: Fingerprint; archived: boolean }
/**
 * A thing's content, as inspect gives it when asked. `text`: a file of UTF-8 text within the kernel's
 * limit (256 KB). `other`: any other file, with its size and the media type its name says, null when
 * the name says none. `files`: a bundle's files. `unavailable`: outside the caller's grant, no such
 * file in the bundle or nothing at the target, or a file asked of a thing that is no bundle.
 */
export type Content =
  | { kind: 'text'; path: LibraryPath; size: number; text: string }
  | { kind: 'other'; path: LibraryPath; size: number; type: string | null; why: 'not-utf8' | 'too-large' }
  | { kind: 'files'; path: LibraryPath; files: BundleFile[] }
  | { kind: 'unavailable'; path: LibraryPath | null; reason: 'outside-grant' | 'no-such-file' | 'not-a-bundle' }
/** `content` is there only when the request asked for it; `request`, when the target is a request's id. */
export type InspectResult = { file: FileFacts | null; sections: Section[]; problems: PluginProblem[]; content?: Content; request?: OwnerRequest }

export type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
export type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

/** What a plugin's `onSay` answers. A heard answer may carry what it could not do; the kernel lists those as problems. */
export type SayAnswer =
  | { outcome: 'heard'; note: string; problems?: string[] }
  | { outcome: 'not-heard'; reason: 'refused'; note: string }

export type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean }
/**
 * `asks`: what only the owner can settle now, from every plugin's `onAsks`; an agent tells the owner.
 * `requests`: the caller's own requests (`ask`) the owner decided since it last saw them, and how many
 * still wait.
 */
export type CheckResult = { sections: Section[]; asks: Ask[]; requests: { ended: OwnerRequest[]; pending: number }; problems: PluginProblem[] }

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
export type ArchiveRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken' | 'inside-bundle'
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
  readonly name: string // `<plugin> ` and one or more words, e.g. 'ledger held restore'
  readonly summary: string
  readonly params: OwnerParams
  readonly destructive: boolean
  readonly ownerOnly: boolean
  /** It changes nothing, in the library or outside it, such as a listing; its event is no news to agents. */
  readonly readOnly?: boolean
  /** It configures plugins, targets or embedders without changing items; its event is news only after an agent's first visit. */
  readonly setup?: boolean
  /**
   * An owner-only command that loses no data can be asked for: an agent asks with `ask`, and the
   * owner approves with one act. `false`: it cannot, as one the owner has to do in person.
   */
  readonly askable?: false
  readonly run: (args: CommandArgs, ctx: PluginContext) => Promise<OwnerAnswer>
}

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
  | { face: 'owner'; command: string; args: OwnerArgs; destructive: boolean; readOnly: boolean; setup: boolean; request?: Requested; result: OwnerResult | Failure }

// ---- the extension point ----

export type CognitionSection = { title: string; text: string }
export type StorageDecl = { dir: string; kind: 'body' | 'cache' } // relative to the plugin's own directory

/** An object with only a contract, a name and empty lists is a valid plugin. */
export interface Plugin {
  /** The plugin contract it is written against: the sdk's `CONTRACT`. The kernel refuses a version it does not run. */
  readonly contract: number
  readonly name: PluginName
  /** Its own version, for people. */
  readonly version?: string
  /** What it brings, in one Chinese sentence for people. */
  readonly summary?: string
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
  /** Once, after `plugin add` installed it. A problem it answers, or a throw, is shown in the answer of `plugin add`, which still succeeds. */
  readonly onAdd?: (ctx: PluginContext) => Promise<void | { problems: string[] }>
  /**
   * Before `plugin remove` takes it out. It may refuse with a Chinese sentence saying why and what to
   * do first. `plugin remove <name> --anyway` removes it all the same, and the answer repeats the sentence.
   */
  readonly onRemove?: (ctx: PluginContext) => Promise<void | { refuse: string }>

  /** The views it adds to the management UI. Each id starts with `<name>.`. */
  readonly views?: readonly ViewDecl[]
  readonly onView?: (req: ViewRequest, ctx: PluginContext) => Promise<ViewAnswer>
  /** What it knows about one library path, as one section of the kernel's item panel: onInspect's counterpart in the UI. */
  readonly onItemView?: (path: LibraryPath, ctx: PluginContext) => Promise<ItemSection | null>
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
 */
export type Cell = { text: string; mono?: boolean; muted?: boolean; tag?: Tag; link?: Link; at?: Instant; icon?: IconName; href?: string; copy?: true; actor?: ActorMark }

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
/** `confirm`: a question the person answers before the call; the answer is the in-person confirmation a destructive command needs. */
export type Action = { label: string; tone: 'default' | 'danger'; confirm: string | null; inputs: ActionInput[]; call: Call }

export type TableRow = { key: string; cells: Record<string, Cell>; link: Link | null; actions: Action[] }
/** An `optional` column steps aside, the last one first, when the table has no room to show every column whole. */
export type TableColumn = { key: string; label: string; optional?: boolean }

/**
 * One thing that happened, as a feed tells it: when, who, one sentence, a grey line of `meta`, and
 * `whose` act it was, where that says something: an agent's on its own, the owner's, one the owner
 * approved at an agent's request, or one the app only observed. It carries one quiet `action`, such
 * as the one that undoes it, or `settled`, a grey word saying how it ended, such as that it was taken
 * back; not both. A row with a `link` opens it.
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
}
/** Rows under a heading, such as a day or a scene; `link` opens what the heading names. */
export type FeedGroup = { title: string; count: number | null; link?: Link; rows: FeedRow[] }
/** One figure: a label, a number or a short text, and a grey sentence about it. */
export type Stat = { label: string; value: string; note: string | null }
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
 * A section with `collapse` can be folded by the viewer; the value is how it starts. A section of the
 * item panel carries `plugin`, the plugin whose part it is, stamped by the kernel. `embed`: an
 * outside http or https page in a sandboxed frame. `custom`: a page of the plugin's own, `entry`
 * relative to its `ui` directory, sent `data` and the names of `actions`, which it may ask to run;
 * `text` says in words what the frame shows, for the command line, screen readers and the page
 * that failed to load; `plugin` is stamped by the kernel. `feed`, `asks`: `empty` is the one grey
 * sentence shown when there is nothing. `tree`: choosing a folder sets the view's parameter `param`
 * to its value and shows the view again, as a filter does; `selected` is the value it has now.
 */
export type Block =
  | { kind: 'section'; title: string; note: string | null; count: number | null; blocks: Block[]; actions: Action[]; collapse?: 'open' | 'closed'; plugin?: PluginName }
  | { kind: 'table'; columns: TableColumn[]; rows: TableRow[]; empty: string }
  | { kind: 'fields'; fields: { label: string; value: Cell }[] }
  | { kind: 'list'; items: { cell: Cell; note: string | null; actions: Action[] }[] }
  | { kind: 'timeline'; entries: { at: Instant; title: Cell; lines: string[]; tag: Tag | null; actions?: Action[] }[] }
  | { kind: 'text'; text: string; tone: Tone }
  | { kind: 'preview'; path: LibraryPath }
  | { kind: 'actions'; actions: Action[] }
  | { kind: 'empty'; title: string; hint: string | null }
  | { kind: 'embed'; url: string; title: string; height: number }
  | { kind: 'custom'; entry: string; height: number; text: string; data: unknown; actions: Record<string, Action>; plugin?: PluginName }
  | { kind: 'feed'; groups: FeedGroup[]; empty: string }
  | { kind: 'stats'; stats: Stat[] }
  | { kind: 'tree'; param: string; selected: string; nodes: TreeNode[] }
  | { kind: 'asks'; asks: Ask[]; empty: string }

/** `count`: how many things the view shows with this option, given by its answer. */
export type FilterOption = { value: string; label: string; count?: number }
export type ViewFilter = { name: string; label: string; options: FilterOption[]; default: string }
/**
 * `icon` is one of `ICON_NAMES`. A view with `nav` false is reached only through links, as a detail.
 * `ownerOnly`: a page of management, refused in an agent's session as an owner-only command is.
 * `home`: the view is also a part of the home page: its blocks stand there, after what waits on the
 * owner, in configuration order.
 */
export type ViewDecl = { id: string; title: string; icon: IconName; nav: boolean; filters: ViewFilter[]; ownerOnly?: boolean; home?: boolean }
/** A view as the library lists it, with who gives it. */
export type ListedView = ViewDecl & { by: PluginName | 'kernel' }
export type ViewRequest = { view: string; params: Record<string, string> }
/**
 * `refresh`: seconds after which the page asks again, at least 5: for a view showing state from
 * outside the library, or one whose content changes with the clock. A view runs on the machine of
 * the viewer's server, in its time zone; a cell's `at` is shown in the browser's. `filters`: the
 * options of declared filters as this answer sees them, such as the agents there are, with counts.
 */
export type ViewAnswer = { title: string; subtitle: string | null; blocks: Block[]; refresh?: number; filters?: { name: string; options: FilterOption[] }[] }
export type ViewResult =
  | ({ outcome: 'shown' } & ViewAnswer & { problems: PluginProblem[] })
  | { outcome: 'no-such-view'; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: 'agent-session'; text: string; problems: PluginProblem[] }
/** Every view of a library: the plugins' first, in configuration order, then the kernel's. */
export type ViewList = { views: ListedView[]; problems: PluginProblem[] }
/** A plugin's part of the item panel: its own section title and blocks, and `actions` for the thing, which stand in the panel's bottom row. */
export type ItemSection = { title: string; blocks: Block[]; actions?: Action[] }
