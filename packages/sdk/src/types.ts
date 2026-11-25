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
  /** Names a later plugin claims that an earlier one holds, left out of the later one: a problem in every answer (K8). */
  readonly clashes: readonly PluginProblem[]
}

/** `home` is this machine's `$PNEUMA_BASE_HOME`: local grant files, external plugins, plugin caches. */
export type Context = { library: Library; actor: Actor; session: Session; now: Instant; home: string }

/**
 * The context a plugin's hook receives: the operation's context, the plugin's own directory in the
 * library, its cache directory outside the library (`<home>/cache/<library id>/<plugin>/`), and the
 * kernel's helpers bound to the library. The own directory exists whenever a hook runs. The kernel
 * does not create the cache directory; deleting it must lose nothing.
 */
export type PluginContext = Context & { dir: string; cacheDir: string; tools: PluginTools }

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
 * `note`: one sentence on what this put changed.
 */
export type PutRequest =
  | { kind: 'register'; path: string; origin: Origin<string>; note?: string | null }
  | { kind: 'place'; from: PlaceSource; to: string; origin: Origin<string>; note?: string | null }
  | { kind: 'move'; from: string; to: string }

/**
 * `inside-bundle`: the path lies inside a bundle, which changes only as a whole; `subject` is the
 * bundle. A put refused because no plugin held the replaced content carries, as `notes`, why each
 * plugin with `revise` declined.
 */
export type PutRefusal = 'outside-library' | 'outside-grant' | 'no-such-file' | 'would-overwrite' | 'inside-bundle'

export type PutResult =
  | { outcome: 'accepted'; path: LibraryPath; fingerprint: Fingerprint; copied: boolean; notes: Note[]; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: PutRefusal; subject: string; notes: Note[]; problems: PluginProblem[] }

/** What `onPut` receives after the kernel accepted a put. `note` is trimmed; blank or absent is null. */
export type AcceptedPut =
  | { kind: 'register'; path: LibraryPath; fingerprint: Fingerprint; origin: Origin; note: string | null }
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

export type InspectRequest = { target: string }
/** One thing of the library: a regular file, or a directory with the marker `.pneuma-item`. */
export type ThingKind = 'file' | 'bundle'
/** A bundle's `size` and `files` count the files its fingerprint counts; `modifiedAt` is the latest of theirs. */
export type FileFacts = { path: LibraryPath; kind: ThingKind; files: number; size: number; modifiedAt: Instant; fingerprint: Fingerprint; archived: boolean }
export type InspectResult = { file: FileFacts | null; sections: Section[]; problems: PluginProblem[] }

export type SayRequest = { kind: string; about: string | null; text: string | null; args: Record<string, string[]> }
export type SayResult =
  | { outcome: 'heard'; by: PluginName; note: string; problems: PluginProblem[] }
  | { outcome: 'not-heard'; reason: 'no-plugin-for-kind' | 'refused' | 'plugin-failed'; note: string; problems: PluginProblem[] }

/** What a plugin's `onSay` answers. A heard answer may carry what it could not do; the kernel lists those as problems. */
export type SayAnswer =
  | { outcome: 'heard'; note: string; problems?: string[] }
  | { outcome: 'not-heard'; reason: 'refused'; note: string }

export type CheckRequest = { since: Instant | 'last' | null; includeArchived: boolean }
export type CheckResult = { sections: Section[]; problems: PluginProblem[] }

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
}

export type Verb = keyof AgentFace

export type OwnerArgs = { positional: string[]; flags: Record<string, string[] | true> }

export type OwnerResult =
  | { outcome: 'done'; text: string; data?: unknown; problems: PluginProblem[] }
  | { outcome: 'refused'; reason: string; text: string; problems: PluginProblem[] }

/** What an owner command's `run` answers. The kernel adds `problems`. */
export type OwnerAnswer = { outcome: 'done'; text: string; data?: unknown } | { outcome: 'refused'; reason: string; text: string }

/**
 * A command a plugin adds to the owner face. The kernel refuses a destructive one in an agent session
 * or without confirmation, and an `ownerOnly` one in an agent session, without asking: it changes no
 * data but decides for the owner, such as what goes online or where the library syncs.
 */
export interface OwnerCommand {
  readonly name: string // one or more words, e.g. 'held restore'
  readonly summary: string
  /** How its arguments are written after the name, for help, e.g. '<库内路径> --to <库内路径>'. */
  readonly usage?: string
  readonly destructive: boolean
  readonly ownerOnly: boolean
  /** It changes nothing, in the library or outside it, such as a listing; its event is no news to agents. */
  readonly readOnly?: boolean
  /** It configures plugins, targets or embedders without changing items; its event is news only after an agent's first visit. */
  readonly setup?: boolean
  readonly run: (args: OwnerArgs, ctx: PluginContext) => Promise<OwnerAnswer>
}

// ---- events ----

export type Failure = { outcome: 'failed'; message: string }

/** One per operation of either face, sent to every plugin's `observe` after the operation. */
export type Event =
  | { [V in Verb]: { face: 'agent'; verb: V; request: Parameters<AgentFace[V]>[0]; result: Awaited<ReturnType<AgentFace[V]>> | Failure } }[Verb]
  | { face: 'owner'; command: string; args: OwnerArgs; destructive: boolean; readOnly: boolean; setup: boolean; result: OwnerResult | Failure }

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

  // Hooks are function-typed properties, not methods, so a hook is checked strictly against what the kernel gives it.
  readonly onPut?: (req: AcceptedPut, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly revise?: (req: PlaceOverExisting, ctx: PluginContext) => Promise<ReviseOutcome>
  readonly onFind?: (req: FindRequest, ctx: PluginContext) => Promise<PluginFindAnswer>
  /** What it knows about paths that others found and it did not: each hit is about one of `paths`. */
  readonly onFound?: (paths: readonly LibraryPath[], req: FindRequest, ctx: PluginContext) => Promise<PluginHit[]>
  readonly onInspect?: (req: InspectRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onSay?: (req: SayRequest, ctx: PluginContext) => Promise<SayAnswer>
  readonly onCheck?: (req: CheckRequest, ctx: PluginContext) => Promise<PluginSection[]>
  readonly onArchive?: (req: AcceptedArchive, ctx: PluginContext) => Promise<PluginNoteAnswer | null>
  readonly observe?: (event: Event, ctx: PluginContext) => Promise<void>

  /** The views it adds to the management UI. Each id starts with `<name>.`. */
  readonly views?: readonly ViewDecl[]
  readonly onView?: (req: ViewRequest, ctx: PluginContext) => Promise<ViewAnswer>
  /** What it knows about one library path, as one section of the kernel's item panel: onInspect's counterpart in the UI. */
  readonly onItemView?: (path: LibraryPath, ctx: PluginContext) => Promise<ItemSection | null>
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
 * `at`: the cell is a moment. The page shows it in the viewer's local time, short, with the whole
 * time on hover; `text` is what a reader without a clock shows. `icon`: a lucide icon name shown
 * before the text, such as `folder`, `file` or `package` for a bundle.
 */
export type Cell = { text: string; mono?: boolean; muted?: boolean; tag?: Tag; link?: Link; at?: Instant; icon?: string }

/**
 * What a button does: one verb of the agent face, or one owner command. Strings may hold `{input}`,
 * replaced by that input's value. A `multiple` input's values, one per line, replace a list element
 * that is exactly `{input}`, one element each. An input left empty gives an empty string, which the
 * faces take as not given.
 */
export type Call =
  | { [V in Verb]: { face: 'agent'; verb: V; request: Parameters<AgentFace[V]>[0] } }[Verb]
  | { face: 'owner'; command: string; args: OwnerArgs }
export type ActionInput = { name: string; label: string; placeholder: string | null; value: string | null; options: { value: string; label: string }[] | null; multiple?: boolean }
/** `confirm`: a question the person answers before the call; the answer is the in-person confirmation a destructive command needs. */
export type Action = { label: string; tone: 'default' | 'danger'; confirm: string | null; inputs: ActionInput[]; call: Call }

export type TableRow = { key: string; cells: Record<string, Cell>; link: Link | null; actions: Action[] }
/** An `optional` column steps aside, the last one first, when the table has no room to show every column whole. */
export type TableColumn = { key: string; label: string; optional?: boolean }

/** A section with `collapse` can be folded by the viewer; the value is how it starts. */
export type Block =
  | { kind: 'section'; title: string; note: string | null; count: number | null; blocks: Block[]; actions: Action[]; collapse?: 'open' | 'closed' }
  | { kind: 'table'; columns: TableColumn[]; rows: TableRow[]; empty: string }
  | { kind: 'fields'; fields: { label: string; value: Cell }[] }
  | { kind: 'list'; items: { cell: Cell; note: string | null; actions: Action[] }[] }
  | { kind: 'timeline'; entries: { at: Instant; title: Cell; lines: string[]; tag: Tag | null }[] }
  | { kind: 'text'; text: string; tone: Tone }
  | { kind: 'preview'; path: LibraryPath }
  | { kind: 'actions'; actions: Action[] }
  | { kind: 'empty'; title: string; hint: string | null }

export type ViewFilter = { name: string; label: string; options: { value: string; label: string }[]; default: string }
/** `icon` is a lucide icon name. A view with `nav` false is reached only through links, as a detail. */
export type ViewDecl = { id: string; title: string; icon: string; nav: boolean; filters: ViewFilter[] }
export type ViewRequest = { view: string; params: Record<string, string> }
export type ViewAnswer = { title: string; subtitle: string | null; blocks: Block[] }
export type ViewResult =
  | ({ outcome: 'shown' } & ViewAnswer & { problems: PluginProblem[] })
  | { outcome: 'no-such-view'; problems: PluginProblem[] }
/** Every view of a library: the plugins' first, in configuration order, then the kernel's. */
export type ViewList = { views: ViewDecl[]; problems: PluginProblem[] }
/** A plugin's part of the item panel: its own section title and blocks. */
export type ItemSection = { title: string; blocks: Block[] }
