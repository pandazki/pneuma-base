// What a deploy target is to the deploy kit: everything about publishing that depends on where the
// sites go. The kit does the rest (declarations, the owner's switch, the plan, records, commands,
// views, cognition). README.md in this folder.
import type { IconName } from '../../icons.js'
import type { Block, Cell, FlagParam, Instant, LibraryPath, OwnerValues, ParamValues, PluginContext, PluginName, SecretDecl, Tag } from '../../types.js'
import type { ContentId, Held, SiteName, Standing, State } from './model.js'
import type { Declared } from './facts.js'

/** One file of a site: its path in the site, '/'-separated, and where to read it: a copy outside the library, made for this call. */
export type SiteFile = { readonly path: string; readonly abs: string }

/**
 * What a publish is about. `content` is what the kit decided on, checked against the copy in `dir`;
 * `files` are the copy's files, the ones storage's content rule counts, sorted by the UTF-8 bytes of
 * their paths, as `identify` was given them. Links and devices are no content, so the copy has none.
 */
export type PublishMeta = { readonly content: ContentId; readonly path: LibraryPath; readonly at: Instant; readonly files: readonly SiteFile[] }

/**
 * What a target tells of one site it was asked about: the content it serves there for this library
 * and where, `content` null when it serves nothing there; and `detail`, anything else it knows of the
 * site (its own numbers, who holds the name), which the kit hands to the target's views in the look.
 */
export type Served<D = unknown> = { readonly content: ContentId | null; readonly url: string | null; readonly detail?: D }

/**
 * What `serving` is asked for. `detail` is true when the answer is drawn (the kit's page, the target's
 * own pages, the item panel), so the views get each site's `detail`; false in hooks and commands,
 * which read only content and address. Fetch what only the views show when it is true.
 */
export type ServingAsk = { readonly detail: boolean }

/** A target's configuration as stored: a JSON object. The kit stores it with the adapter's `kind`. */
export type TargetConfig = { readonly [key: string]: unknown }

/**
 * The configuration to store, or why the flags cannot give one: reason `usage` for a malformed call.
 * `note`, a sentence for the owner, takes the place of the kit's reminder of the target's unset
 * secrets in what `target set` answers: a target whose credentials can come from more than one place
 * says which it will use, or what to run when there is none.
 */
export type Configured = { ok: true; config: TargetConfig; note?: string } | { ok: false; reason: string; text: string }

/** The value `secret` gives for the secret `N` of `S`: a string, or null for an optional one the owner has not set. */
type SecretValue<S extends SecretDecl, N extends string> = Extract<S, { name: N }> extends { optional: true } ? string | null : string

/**
 * What an opened target may use: the hook's or command's context, a directory outside the library for
 * its scratch, the plugin's name (its commands begin with it), and `secret(name)`, the value of a
 * secret it declares, set by the owner on this machine. For a required secret that is not set it
 * rejects, naming the command that sets it; an optional one that is not set reads as null.
 */
export type TargetEnv<S extends SecretDecl = SecretDecl> = {
  readonly ctx: PluginContext
  readonly scratch: string
  readonly plugin: PluginName
  readonly secret: <N extends S['name']>(name: N) => Promise<SecretValue<S, N>>
}

/** A page of a target's own in the navigation, after the kit's: its view is `<plugin>.<name>`, drawn by the opened target's `view.pages[name]`. */
export type TargetPage = { readonly name: string; readonly title: string; readonly icon: IconName }

/** A destination of one kind found on this machine: what its row says, and the flags of `target set` that connect it, nothing typed. */
export type Found = { readonly label: string; readonly values: Readonly<Record<string, string>> }

/**
 * Kinds that share a `group` share one row 「别的 <name>」 (just 「<name>」 when none of them found
 * anything) whose dialog chooses among them by `choice`.
 */
export type TargetGroup = { readonly name: string; readonly choice: string }

/** What reads the secret `asked` takes typed hidden, once a call: null when nothing was typed. */
export type Typed = () => Promise<string | null>

/**
 * One kind of target: how the owner configures it, and how a stored configuration opens. `D` is what
 * its `serving` tells of a site beside content and address, which its views get. Write it with
 * `defineTarget`, which checks the views against `D` and the secrets `env.secret` reads.
 */
export interface TargetAdapter<D = unknown, S extends SecretDecl = SecretDecl> {
  /** The value of `--kind` that chooses it, stored with its configuration. */
  readonly kind: string
  /** Values of `--kind` it had before a rename: a configuration stored under one of them opens as this kind. */
  readonly formerly?: readonly string[]
  /** The kind for people, in its dialog and its menu entry: `本地文件夹`. */
  readonly label: string
  /** Its icon on the destination row and on rows of what was found. */
  readonly icon?: IconName
  /** The kinds it shares a row with on the page; without one it is 「<label>…」 in the region's menu. */
  readonly group?: TargetGroup
  /** The flags its dialog asks, in order; its required flags when left out. */
  readonly form?: readonly string[]
  /**
   * Its flags after `<name> target set` and `--kind`. The command's params are made from them, so the
   * command line, help, the page's dialogs and the check before `configure` all come from here. With
   * several kinds, a required flag is required once its kind is chosen.
   */
  readonly params: readonly FlagParam[]
  /** The secrets it reads through `TargetEnv.secret`. The plugin declares them, so `secret set` and the configuration page know them. */
  readonly secrets?: readonly S[]
  /**
   * The secret `target set` takes typed hidden, never as a flag: `name` is one of `secrets`. `configure`
   * reads it with its third argument; when it read a value and answered ok, the kit keeps the value as
   * that secret on this machine. It is in no configuration, record or answer.
   */
  readonly asked?: { readonly name: string; readonly hint: string }
  /** Destinations of this kind on this machine, each connected by `target set --kind <kind>` with its `values`. Reads only what finding them needs. */
  readonly found?: (ctx: PluginContext) => Promise<readonly Found[]>
  /** A paragraph the plugin's cognition section carries while this kind is connected: what it asks of what goes online. */
  readonly cognition?: string
  /** Its own pages, each a navigation entry beside the kit's page. Names are lower-case letters, digits and dashes, and not `sites`. */
  readonly views?: readonly TargetPage[]
  /**
   * The configuration to store from the values of its flags, checked against `params`, or why there is
   * none; a destination that does not answer is a refusal, and nothing is stored. `typed` reads the
   * secret `asked` takes.
   */
  readonly configure: (values: OwnerValues, ctx: PluginContext, typed: Typed) => Promise<Configured>
  /** Parses a stored configuration at the boundary and opens it for one hook or command. Throws when it is not one of its configurations. */
  readonly open: (config: TargetConfig, env: TargetEnv<S>) => Target<D>
}

/**
 * A target adapter whose `configure` gets the values typed by its `params`, as `defineCommand` gives a
 * command's `run`; whose `env.secret` takes only the names in its `secrets`, typed null for an
 * optional one; and whose views get `D`, the type of its `serving`'s `detail`, as written on `open`'s
 * return: `open(config, env): Target<Detail>`.
 */
export function defineTarget<const P extends readonly FlagParam[], const S extends readonly SecretDecl[] = [], D = never>(
  adapter: Omit<TargetAdapter<D, S[number]>, 'params' | 'secrets' | 'configure'> & {
    readonly params: P
    readonly secrets?: S
    readonly configure: (values: ParamValues<{ flags: P }>, ctx: PluginContext, typed: Typed) => Promise<Configured>
  },
): TargetAdapter {
  const { configure, ...rest } = adapter
  // The kit calls `configure` only with values checked against `params`, the required ones given;
  // `env.secret` gives null only for an optional secret; and a target's views get only the details
  // its own `serving` gave. So the adapter is handed on with those types erased.
  return { ...rest, configure: (values: OwnerValues, ctx: PluginContext, typed: Typed) => configure(values as ParamValues<{ flags: P }>, ctx, typed) } as unknown as TargetAdapter
}

/** A configured target, opened for one hook or command. */
export interface Target<D = unknown> {
  /** Which target records belong to: what was published to another key does not count here. */
  readonly key: string
  /** What the destination row says: the host, the folder, or the kind's own words. */
  readonly label: string
  /** `label` is a path of this machine: the row shows its last part, the whole on demand. */
  readonly local?: true
  /** Flags that can be changed once connected, each 「<hint>…」 in the row's menu, running `target set` again with this one asked, `value` filled in. */
  readonly settings?: readonly { readonly flag: string; readonly hint: string; readonly value: string }[]
  /** The site name of a library path. Without it, the kit's `siteName`. */
  readonly siteName?: (path: LibraryPath) => SiteName
  /** The content id of a thing's files. Without it, the kernel fingerprint. */
  readonly identify?: (files: readonly SiteFile[]) => Promise<ContentId>
  /** Publishes the directory under the site name, replacing what the site served; answers its address. */
  readonly publish: (site: SiteName, dir: string, meta: PublishMeta) => Promise<{ url: string | null }>
  /** Takes the site down; taking down a site it does not serve is not an error. */
  readonly remove: (site: SiteName) => Promise<void>
  /**
   * What it knows of `sites` now, by site: the content it serves there for this library and where,
   * and its `detail`; a site it leaves out it neither serves nor knows. With it, the kit compares the
   * library with what the target serves; without it, with its own records. Asked again after the kit
   * published or removed, so a target that remembers answers must forget what changed.
   *
   * When it is asked, against the views: a page (the kit's or one of the target's own) asks once, for
   * the sites of every declared thing, and only then calls the view functions; the item panel asks for
   * its thing's sites, then calls `fields` and `item`. Every view function gets the look the answer
   * made, with that answer's `detail`, so none runs before the answer it draws. Hooks and commands ask
   * with `detail` false and call no view function.
   */
  readonly serving?: (sites: readonly SiteName[], ask: ServingAsk) => Promise<ReadonlyMap<SiteName, Served<D>>>
  readonly view?: TargetView<D>
  /**
   * Called once when the hook, command or view it was opened for ends, also when that failed: a target
   * that signs in to its service signs out here. What it throws is ignored, so the answer stands.
   */
  readonly close?: () => Promise<void>
}

/** What a target adds to the plugin's page, to its own pages and to its section of the item panel. Each function gets looks with their `detail`. */
export interface TargetView<D = unknown> {
  /** Fields after the kit's state, switch, address and site name. */
  readonly fields?: (l: Look<D>) => { label: string; value: Cell }[]
  /** Blocks before the kit's sections on its page. */
  readonly before?: (all: readonly Look<D>[]) => Block[]
  /** Blocks after the kit's sections on its page; a `custom` one needs the plugin's `ui`. */
  readonly page?: (all: readonly Look<D>[]) => Block[]
  /** The blocks of each of the adapter's `views`, by name, from every declared thing as it stands. */
  readonly pages?: Readonly<Record<string, (all: readonly Look<D>[]) => Block[]>>
  /** Blocks at the end of the item panel's section. */
  readonly item?: (l: Look<D>) => Block[]
  /** The row's mark when the target sees something the kit's states do not say, such as a name someone else holds; null for none. */
  readonly mark?: (l: Look<D>) => Tag | null
  /** Seconds after which the pages ask again; null for never. Defaults to 30 when the target has `serving`, else never. */
  readonly refresh?: number | null
}

/** The six states, and `unknown` while a target that reports what it serves cannot be read. */
export type Status = State | 'unknown'

/**
 * A declared thing as it stands: the decision's inputs, what the target holds for it, and the state
 * they make. `site` is the name it has or would have, null while archived; `url` is where the target
 * serves it, preferring that name; `unreachable` says why the target could not tell what it serves.
 * `detail` is what `serving` told of its site: the one it is served under (preferring its name), else
 * the name its path has, or for an archived thing had; null without one, and outside a page or panel.
 */
export type Look<D = unknown> = {
  readonly thing: Declared
  readonly standing: Standing
  readonly held: Held
  readonly status: Status
  readonly site: SiteName | null
  readonly url: string | null
  readonly unreachable: string | null
  readonly detail: D | null
}
