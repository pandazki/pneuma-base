// The kernel's public shapes. ARCHITECTURE.md sections 4 and 5. Plugins see only these.

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
  transcript: string | null
}

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
}

export type Context = { library: Library; actor: Actor; session: Session; now: Instant }

/** The context a plugin's hook receives: the operation's context plus the plugin's own directory. */
export type PluginContext = Context & { dir: string }

export type Note = { plugin: PluginName; text: string; data?: unknown }
export type Section = { plugin: PluginName; title: string; body: string; data?: unknown }
export type PluginProblem = { plugin: PluginName; message: string }

/** Hooks answer without naming themselves; the kernel stamps the plugin's name. */
export type PluginNote = Omit<Note, 'plugin'>
export type PluginSection = Omit<Section, 'plugin'>
export type PluginHit = Omit<Hit, 'by'>

// ---- put ----

/** `P` is `string` in a request (as the caller wrote it) and `LibraryPath` once the kernel parsed it. */
export type Origin<P = LibraryPath> =
  | { kind: 'brought'; source: string | null; by: string | null }
  | { kind: 'made'; from: P[]; outside: string[] }

export type PlaceSource = { kind: 'file'; path: string } | { kind: 'stdin'; content: Uint8Array }

/** Paths are as the caller wrote them: library-relative or absolute. The kernel parses them. */
export type PutRequest =
  | { kind: 'register'; path: string; origin: Origin<string> }
  | { kind: 'place'; from: PlaceSource; to: string; origin: Origin<string> }
  | { kind: 'move'; from: string; to: string }

export type PutRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite'

export type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint; copied: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: PutRefusal; subject: string; problems: PluginProblem[] }

/** What `onPut` receives after the kernel accepted a put. */
export type AcceptedPut =
  | { kind: 'register'; path: LibraryPath; fingerprint: Fingerprint; origin: Origin }
  | {
      kind: 'place'
      path: LibraryPath
      fingerprint: Fingerprint
      origin: Origin
      source: { kind: 'file'; path: string } | { kind: 'stdin' }
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

export type InspectRequest = { target: string }
export type FileFacts = { path: LibraryPath; size: number; modifiedAt: Instant; fingerprint: Fingerprint; archived: boolean }
export type InspectResult = { file: FileFacts | null; sections: Section[]; problems: PluginProblem[] }

export type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
export type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

/** What a plugin's `onSay` answers. The kernel adds `problems`. */
export type SayAnswer =
  | { outcome: 'heard'; note: string }
  | { outcome: 'not-heard'; reason: 'refused'; note: string }

export type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean }
export type CheckResult = { sections: Section[]; problems: PluginProblem[] }

// ---- archive ----

export type ArchiveRequest = { kind: 'archive' | 'unarchive'; path: string }
export type ArchiveRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'original-path-taken'
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
}

export type Verb = keyof AgentFace

export type OwnerArgs = { positional: string[]; flags: Record<string, string[] | true> }

export type OwnerResult =
  | { outcome: 'done'; text: string; data?: unknown; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: string; text: string; problems: PluginProblem[] }

/** What an owner command's `run` answers. The kernel adds `problems`. */
export type OwnerAnswer = { outcome: 'done'; text: string; data?: unknown } | { outcome: 'refused'; reason: string; text: string }

/** A command a plugin adds to the owner face. The kernel refuses a destructive one in an agent session or without confirmation. */
export interface OwnerCommand {
  readonly name: string // one or more words, e.g. 'held restore'
  readonly summary: string
  readonly destructive: boolean
  run(args: OwnerArgs, ctx: PluginContext): Promise<OwnerAnswer>
}

// ---- events ----

export type Failure = { outcome: 'failed'; message: string }

/** One per operation of either face, sent to every plugin's `observe` after the operation. */
export type Event =
  | { [V in Verb]: { face: 'agent'; verb: V; request: Parameters<AgentFace[V]>[0]; result: Awaited<ReturnType<AgentFace[V]>> | Failure } }[Verb]
  | { face: 'owner'; command: string; args: OwnerArgs; destructive: boolean; result: OwnerResult | Failure }

// ---- the extension point ----

export type CognitionSection = { title: string; text: string }
export type StorageDecl = { dir: string; kind: 'body' | 'cache' } // relative to the plugin's own directory

/** An object with only a name and empty lists is a valid plugin. */
export interface Plugin {
  readonly name: PluginName
  readonly cognition: CognitionSection | null
  readonly storage: readonly StorageDecl[]
  readonly statements: readonly string[]
  readonly ownerCommands: readonly OwnerCommand[]

  onPut?(req: AcceptedPut, ctx: PluginContext): Promise<PluginNote | null>
  revise?(req: PlaceOverExisting, ctx: PluginContext): Promise<ReviseOutcome>
  onFind?(req: FindRequest, ctx: PluginContext): Promise<PluginHit[]>
  onInspect?(req: InspectRequest, ctx: PluginContext): Promise<PluginSection[]>
  onSay?(req: SayRequest, ctx: PluginContext): Promise<SayAnswer>
  onCheck?(req: CheckRequest, ctx: PluginContext): Promise<PluginSection[]>
  onArchive?(req: AcceptedArchive, ctx: PluginContext): Promise<PluginNote | null>
  observe?(event: Event, ctx: PluginContext): Promise<void>
}

export type PluginTable = ReadonlyMap<string, Plugin>
