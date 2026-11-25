// What a deploy target is to the deploy kit: everything about publishing that depends on where the
// sites go. The kit does the rest (declarations, the owner's switch, the plan, records, commands,
// views, cognition). README.md in this folder.
import type { ActionInput, Block, Cell, Instant, LibraryPath, PluginContext, TableColumn } from '../../types.js'
import type { ContentId, Held, SiteName, Standing, State } from './model.js'
import type { Declared } from './facts.js'

/** One file of a site: its path in the site, '/'-separated, and where to read it. */
export type SiteFile = { readonly path: string; readonly abs: string }

/**
 * What a publish is about. `content` is what the kit decided on, checked against the copy in `dir`;
 * `files` are the copy's files, sorted by the UTF-8 bytes of their paths, as `identify` was given them.
 */
export type PublishMeta = { readonly content: ContentId; readonly path: LibraryPath; readonly at: Instant; readonly files: readonly SiteFile[] }

/** A site a target serves now: the content it serves and where. */
export type Served = { readonly content: ContentId; readonly url: string | null }

/** The flags of `<name> target set`, read: a flag given empty, as a form's empty field, counts as not given. */
export type TargetFlags = { value(flag: string): string | null; values(flag: string): string[] }

/** A target's configuration as stored: a JSON object. The kit stores it with the adapter's `kind`. */
export type TargetConfig = { readonly [key: string]: unknown }

/** The configuration to store, or why the flags cannot give one: reason `usage` for a malformed call. */
export type Configured = { ok: true; config: TargetConfig } | { ok: false; reason: string; text: string }

/** What an opened target may use: the hook's or command's context, and a directory outside the library for its scratch. */
export type TargetEnv = { readonly ctx: PluginContext; readonly scratch: string }

/** One kind of target: how the owner configures it, and how a stored configuration opens. */
export interface TargetAdapter {
  /** The value of `--kind` that chooses it, stored with its configuration. */
  readonly kind: string
  /** What it publishes to, for people, as in `配部署目标：<label>`: `一个本地目录`. */
  readonly label: string
  /** Its flags after `<name> target set` (and `--kind`), for help; optional ones in brackets: `--to <目录>`. */
  readonly usage: string
  readonly flags: readonly string[]
  /** The page's button that sets it: one input per flag, named as the flag. */
  readonly form: { readonly label: string; readonly inputs: readonly ActionInput[] }
  /** The secrets it needs, by name, for the owner to set. Declared only: nothing reads them yet. */
  readonly secrets?: readonly { readonly name: string; readonly label: string }[]
  readonly configure: (flags: TargetFlags, ctx: PluginContext) => Promise<Configured>
  /** Parses a stored configuration at the boundary and opens it for one hook or command. Throws when it is not one of its configurations. */
  readonly open: (config: TargetConfig, env: TargetEnv) => Target
}

/** A configured target, opened for one hook or command. */
export interface Target {
  /** Which target records belong to: what was published to another key does not count here. */
  readonly key: string
  /** What and where, one line for people: `本地目录 /srv/www`. */
  readonly label: string
  /** The site name of a library path. Without it, the kit's `siteName`. */
  readonly siteName?: (path: LibraryPath) => SiteName
  /** The content id of a thing's files. Without it, the kernel fingerprint. */
  readonly identify?: (files: readonly SiteFile[]) => Promise<ContentId>
  /** Publishes the directory under the site name, replacing what the site served; answers its address. */
  readonly publish: (site: SiteName, dir: string, meta: PublishMeta) => Promise<{ url: string | null }>
  /** Takes the site down; taking down a site it does not serve is not an error. */
  readonly remove: (site: SiteName) => Promise<void>
  /**
   * Which of `sites` it serves now for this library, with their content and address. With it, the kit
   * compares the library with what the target serves; without it, with its own records. Asked again
   * after the kit published or removed, so a target that remembers answers must forget what changed.
   */
  readonly serving?: (sites: readonly SiteName[]) => Promise<ReadonlyMap<SiteName, Served>>
  readonly view?: TargetView
}

/** What a target adds to the plugin's page and to its section of the item panel. */
export interface TargetView {
  /** Columns after the kit's path, state and address; `cells` fills them by key. */
  readonly columns?: readonly TableColumn[]
  readonly cells?: (l: Look) => Readonly<Record<string, Cell>>
  /** Fields after the kit's state, switch, address and site name. */
  readonly fields?: (l: Look) => { label: string; value: Cell }[]
  /** Blocks after the kit's sections on the page; a `custom` one needs the plugin's `ui`. */
  readonly page?: (all: readonly Look[]) => Block[]
  /** Blocks at the end of the item panel's section. */
  readonly item?: (l: Look) => Block[]
}

/** The six states, and `unknown` while a target that reports what it serves cannot be read. */
export type Status = State | 'unknown'

/**
 * A declared thing as it stands: the decision's inputs, what the target holds for it, and the state
 * they make. `site` is the name it has or would have, null while archived; `url` is where the target
 * serves it, preferring that name; `unreachable` says why the target could not tell what it serves.
 */
export type Look = {
  readonly thing: Declared
  readonly standing: Standing
  readonly held: Held
  readonly status: Status
  readonly site: SiteName | null
  readonly url: string | null
  readonly unreachable: string | null
}
