# Grants, agent discovery, and capability-driven plugins: established designs (as of 2026-11-25)

Scope: how agents get scoped access to a store and find it; how plugins deploy and sync content out of a local store. The aim is to model Pneuma Base's "grant", "area", "capability" and "plugin" correctly.

How the evidence was gathered: official docs and specs were fetched on 2026-11-25. Some facts come from direct observation on one Mac. They are labeled "observed locally" and name the exact version. Facts taken only from a search-engine summary, not from a fetched page, are labeled "(search summary)". Anything recalled but not fetched this session is in the Gaps sections and marked unverified.

---

## 1. Scoped authorization models: what is the shape of a grant, and which ones work offline with no server?

### Takeaway
Token-based capability systems share one grant shape: **issuer, audience/holder, subject/resource, action/command, conditions (caveats or policy), not-before/expiry, and a unique id or nonce**. Holders can attenuate a grant by appending to a chain and can never widen it. Revocation always needs a list of revoked ids that the verifier checks. Public-key tokens (UCAN, Biscuit) can be verified offline by anyone who has the root public key. HMAC tokens (macaroons) and signed URLs can only be verified by whoever holds the secret, so they need the issuing service to be in the path. A signed URL is the simplest grant: one object, one method, one expiry. You revoke it by revoking the signer's credentials, and its issuance is not logged unless the issuer logs it.

### Cited Findings
**UCAN (v1.0.0)**
- The payload fields are `iss`, `aud`, `sub`, `cmd`, `args`, `nonce`, `meta`, `nbf`, `exp`. `iss` and `aud` are sender and receiver, and "Every UCAN MUST be signed with the private key associated with the DID in the `iss` field" — [UCAN spec](https://github.com/ucan-wg/spec)
- `cmd` is a lowercase slash path such as `/crud/read`. "Shorter commands prove longer ones, so `/` covers all" (paraphrased by the fetch tool). Capabilities are subject + command + policy. Policy is a small expression language (`==`, `match`, `or`, …) that the Delegation sub-spec defines — [UCAN spec](https://github.com/ucan-wg/spec)
- "Each direct delegation MUST either directly restate or attenuate (diminish) its capabilities." The proof chain doubles as a provenance log — [UCAN spec](https://github.com/ucan-wg/spec)
- `exp` is recommended, and `null` means it never expires. The spec suggests a ±60 s allowance for clock drift. `nonce` prevents replay and makes each token's CID unique — [UCAN spec](https://github.com/ucan-wg/spec)
- Revocation is done by an issuer in the proof chain, is irreversible, and caches must mark the revoked CID and its derivatives invalid. Revocation is "a last resort" because "UCANs do not offer confinement" — [UCAN spec](https://github.com/ucan-wg/spec)
- Offline: signatures and chains can be checked locally, but a CID that cannot be dereferenced at validation time fails validation, and the executor must still check resource ownership when it executes — [UCAN spec](https://github.com/ucan-wg/spec)
- Principals are DIDs (`did:key` required). Ed25519 is recommended. Tokens are canonically DAG-CBOR with Varsig signatures and are identified by CIDv1 — [UCAN spec](https://github.com/ucan-wg/spec)

**Biscuit**
- "can be verified by any system that knows the root public key." Ed25519 is the default — [Biscuit spec](https://doc.biscuitsec.org/reference/specifications)
- A token is a chain of blocks: an authority block, then restriction blocks. Holders append blocks offline and cannot remove existing ones without breaking the signature — [Biscuit spec](https://doc.biscuitsec.org/reference/specifications)
- Rights and conditions are Datalog facts, rules and checks. The **authorizer** (the verifying side) adds request context (operation, resource, time) plus its own allow/deny policies, and those policies decide — [Biscuit spec](https://doc.biscuitsec.org/reference/specifications)
- Expiry is not a built-in field. It is a check, e.g. `check if time($0), $0 < 2019-02-05T23:00:00Z;` — [Biscuit spec](https://doc.biscuitsec.org/reference/specifications)
- Each block yields a `revocation_id` (derived from its signature) that verifiers check against a revocation list. A **sealed** token cannot be attenuated further. **Third-party blocks** let another party sign a block without seeing the token — [Biscuit spec](https://doc.biscuitsec.org/reference/specifications)

**Macaroons**
- Bearer credentials built from "nested, chained MACs (e.g., HMACs)". Embedded **caveats** "attenuate and contextually confine when, where, by who, and for what purpose a target service should authorize requests". They support decentralized delegation and are proposed as a way to strengthen OAuth2 — [Birgisson et al., NDSS 2014 (Google Research)](https://research.google/pubs/pub41892/) (search summary of the abstract)

**OAuth scopes + resource indicators (as profiled by MCP)**
- The client MUST send the RFC 8707 `resource` parameter in authorization and token requests, set to the server's canonical URI. Servers MUST validate that a token was issued for them as the audience, and "MUST NOT accept or transit any other tokens" — [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- Scopes are announced per resource in `WWW-Authenticate: Bearer ... scope="files:read"`. When a scope is missing the server returns 403 `insufficient_scope`, and the client does **step-up** by re-authorizing with the union of old and new scopes. "Servers MUST account for scope hierarchies, where a broader scope implies narrower ones" — [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

**Signed URLs (S3 presigned)**
- A presigned URL names a bucket, an object key, an HTTP method and an expiry. It carries the signer's credentials, and "presigned URLs are bearer tokens that grant access to those who possess them" — [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- Maximum lifetime is 7 days (SigV4, IAM user). A URL signed with temporary credentials dies when those credentials expire, and "a presigned URL expires when the credential you used to create it is revoked, deleted, or deactivated." It can be used many times until it expires — [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- "Creating a presigned URL happens locally, so Amazon S3 doesn't generate an issuance event." AWS tells the issuer to record the user, signing session, bucket, key, operation and expiry before returning the URL. Access logs "identify the signer, not who later uses the URL" — [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)

**Runtime-enforced path grants (for comparison)**
- Deno is deny-by-default. `--allow-read=./data` scopes reads to a path, and `--deny-*` overrides `--allow-*`. But for `--allow-run`, "A subprocess runs as a separate program with its own permissions, not the restricted set you granted", so treat `--allow-run`/`--allow-ffi` "as equivalent to `--allow-all`" — [Deno security](https://docs.deno.com/runtime/fundamentals/security/)

### Inferences
- A Pneuma Base grant maps closely onto the UCAN/Biscuit shape: issuer = library owner key; audience = an agent identity such as "claude-code@this-mac" or a key; subject = the library; resource = an area path; command = `read` / `write` / `append-record` / `deploy`; plus `nbf`/`exp`, a nonce/id and free metadata. Attenuation (owner → agent → subagent) comes free with chained tokens.
- On the local machine no verifier sits between the agent and the files, so a token cannot *enforce* anything there. It can still serve as a **signed, checkable statement of intent** that the after-the-fact checker compares writes against. Through the software, the software is the verifier. With macaroons the software holds the only secret, which fits "real restriction only through software". With Biscuit/UCAN anyone can verify, which fits "a plain folder that any agent can check".
- The AWS note that issuance is invisible unless logged applies directly: the library should write each grant issuance into its own management log.

### Gaps
- Classic object-capability literature (e.g. Miller et al. "Capability Myths Demolished", Capsicum, WASI preopened directories) was not fetched this session. Unverified recall: ocap treats "holding an unforgeable reference" as the authority itself, and WASI gives a module only pre-opened directory handles.
- The UCAN Delegation, Invocation and Revocation sub-specs (policy grammar, revocation record format) were not fetched.
- I did not verify which Biscuit and UCAN libraries are maintained as of Nov 2026.

---

## 2. How current coding agents scope file access, what is real versus advisory, and how a CLI run by the agent can identify the session

### Takeaway
Every major agent has two layers. (1) **Tool-level permission rules**. They are advisory with respect to subprocesses, and Claude Code says so in plain words. (2) An **OS sandbox** (Seatbelt on macOS, bubblewrap/Landlock-style on Linux) that confines shell writes, and reads in some configurations. Claude Code's sandbox is off by default. Gemini CLI's appears to be off unless enabled, but its page states no explicit default. Codex runs `workspace-write` as its normal mode. OpenCode has no OS sandbox at all. Granting a folder outside the project is a first-class option everywhere: `--add-dir`/`additionalDirectories` (Claude), workspace roots (Codex), `--include-directories` (Gemini), `external_directory` (OpenCode). Session identity varies by tool. Claude Code exposes `CLAUDE_CODE_SESSION_ID` to shell commands (observed) and documents `session_id` and `transcript_path` for hooks. Codex writes date-partitioned rollout JSONL files and its binary contains `CODEX_THREAD_ID`, but no documentation says that variable is set. Gemini stores chats per project hash and documents no env var.

### Cited Findings
**Claude Code (v2.1.331)**
- Six modes: `default` (Manual), `acceptEdits`, `plan`, `auto` (a classifier reviews actions), `dontAsk` (auto-denies anything that would prompt), `bypassPermissions`. Admins can disable bypass and auto through managed settings — [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- Reads inside the working directory and additional directories need no approval. Extra directories come from `--add-dir`, `/add-dir`, or `additionalDirectories` in settings — [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- "Additional directories grant file access, not configuration." Directories added with `--add-dir` load `.claude/skills/` (with live reload), commands, and agents. `permissions.additionalDirectories` from settings "grant file access only". CLAUDE.md in added dirs loads only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` — [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- Advisory boundary, stated in the docs: Read/Edit deny rules cover built-in file tools and Bash commands that Claude Code can parse (`cat`, `head`, `sed`, redirections). "They don't apply to a command that reads files without naming them, such as `grep -r pattern .` … They also don't apply to arbitrary subprocesses that read or write files indirectly, like a Python or Node script." Claude "makes a best-effort attempt" to apply Read denies to Grep/Glob — [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- `permissions.blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories` make the *file tools* refuse paths outside the working directories in every mode. The write key "doesn't limit shell commands, MCP tools, or the programs hooks run" — [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- The sandbox is off by default and covers "shell commands only" (Bash, PowerShell, Monitor and their children). It uses Seatbelt on macOS and bubblewrap on Linux/WSL2, built on `@anthropic-ai/sandbox-runtime`. Native Windows is unsandboxed — [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- Sandbox defaults: writes are allowed to the working dir, a temp dir and added dirs. Reads cover "Most of the machine, including credential files such as `~/.ssh`". Configure with `filesystem.allowWrite/denyWrite/denyRead/allowRead`. Protected paths inside writable dirs (e.g. `.claude` settings, `.git/hooks`, shell rc files) stay write-denied — [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- Escape hatches: Claude may retry with `dangerouslyDisableSandbox` (blocked with `allowUnsandboxedCommands: false`), and `excludedCommands` run "with your full access". The sandbox does **not** govern Read/Edit/Write tools: "A `denyRead` entry doesn't stop the Read tool" — [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- Session identity for hooks: every hook receives JSON with `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` (plus `agent_id` for subagents). The example transcript path is `~/.claude/projects/.../transcript.jsonl`. The transcript "may lag" the in-memory conversation. `CLAUDE_PROJECT_DIR` is set for hooks and stdio MCP servers — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- Observed locally (v2.1.331): Bash commands run by the agent see `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID=<uuid>`. The transcript is at `~/.claude/projects/<cwd with "/" → "-">/<session-id>.jsonl`. The hooks page does not document `CLAUDE_CODE_SESSION_ID` ("The excerpt does not mention … a session-ID environment variable for Bash commands") — [Claude Code hooks](https://code.claude.com/docs/en/hooks); observed locally.

**OpenAI Codex CLI (docs moved to learn.chatgpt.com; v0.167.0)**
- Modes: `read-only`, `workspace-write` ("the default low-friction mode for local work"), `danger-full-access`. Approval policies `on-request` and `never`. "Codex and ChatGPT Work no longer support `untrusted` as a selectable approval policy." "The sandbox applies to spawned commands, not just to built-in file operations." It uses Seatbelt on macOS, bubblewrap on Linux/WSL2, and a native sandbox on Windows — [Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- Permission profiles: `[permissions.<name>]` with `default_permissions` (built-ins `:read-only`, `:workspace`, `:danger-full-access`). Path access is `read`/`write`/`deny`, and deny > write > read. Extra roots go in `[permissions.<name>.workspace_roots]`. Deny-read globs are allowed (e.g. `"**/*.env" = "deny"`). Network domain rules apply only when the network proxy is on — [Codex permissions](https://learn.chatgpt.com/docs/permissions)
- "Extending `:workspace` keeps the workspace root's `.git`, `.agents`, `.codex`, and `.aws` read-only unless you explicitly override" — [Codex permissions](https://learn.chatgpt.com/docs/permissions)
- The documented env vars are only ones Codex *reads* (`CODEX_HOME` default `~/.codex`, `CODEX_API_KEY`, …). No session-id variable is documented — [Codex env vars](https://learn.chatgpt.com/docs/config-file/environment-variables)
- Observed locally: rollouts are stored at `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. The first line has `"type":"session_meta"` with both `id` (matches the filename uuid) and a different `session_id`. The 0.167.0 binary contains the strings `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_TOOL_CALL_ID`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`. I did not verify that they are injected into command environments. Third-party write-ups agree on the rollout layout and add thread metadata in `~/.codex/state_5.sqlite` — [Codex session lifecycle (third-party)](https://codex.danielvaughan.com/2026/04/11/codex-cli-session-lifecycle-resume-fork-rollouts) (search summary); a GitHub discussion says custom session IDs or names are not supported — [openai/codex #3827](https://github.com/openai/codex/discussions/3827) (search summary)

**Gemini CLI**
- Seatbelt profiles: permissive-open (the default profile, "confines writes to the project directory"), permissive-proxied, restrictive-open/-proxied, strict-open/-proxied (strict also restricts reads). The CLI also supports Docker/Podman, gVisor, LXC and a Windows native sandbox. You enable it with `--sandbox`, `GEMINI_SANDBOX`, or `tools.sandbox` in settings. Gemini CLI "was replaced by Antigravity CLI" for unpaid tier and Google One users on 2026-06-18 — [Gemini CLI sandbox](https://geminicli.com/docs/cli/sandbox)
- Sessions: "Sessions are stored in `~/.gemini/tmp/<project_hash>/chats/`", identified by UUID, and project-specific. Default retention is 30 days. No env var exposes the session id — [Gemini CLI session management](https://geminicli.com/docs/cli/session-management)
- Trusted folders are off by default, decisions are kept in `~/.gemini/trustedFolders.json`, and `--include-directories` / `includeDirectories` add folders — [Gemini CLI trusted folders](https://geminicli.com/docs/cli/trusted-folders/) (search summary)

**OpenCode**
- Rules are a list of `{action, resource, effect}` with effect allow/ask/deny. "The last matching rule wins." Actions include `read`, `edit`, `shell`, `external_directory`, `skill`, and MCP tools. Paths outside the project go through `external_directory` first, which "defaults to allow". The base policy is `*`/`*` allow, with `.env` reads set to ask — [OpenCode permissions](https://opencode.ai/docs/permissions/)
- There is no OS sandbox: "`shell` runs with the host user's filesystem, process, and network authority." The shell directory inference is "best effort" — [OpenCode permissions](https://opencode.ai/docs/permissions/)

**Cursor**
- CLI permissions live in `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json` with tokens `Shell(…)`, `Read(glob)`, `Write(glob)`, `WebFetch(…)`, `Mcp(server:tool)`. "Deny rules take precedence over allow rules" — [Cursor CLI permissions](https://cursor.com/docs/cli/reference/permissions)
- Agent terminal commands on macOS run in a Seatbelt sandbox by default, and allowlisted commands skip it. The 2026 forum has reports of the sandbox breaking commands — [Cursor run modes](https://cursor.com/docs/agent/security/run-modes.md), [Cursor agent sandboxing blog](https://cursor.com/blog/agent-sandboxing) (search summary only, not fetched)

### Inferences
- What a user can really restrict to a folder: **shell writes**, under Claude Code's sandbox (opt-in), Codex workspace-write (default) or Gemini/Cursor Seatbelt. **Reads** are confined only in strict configurations (Claude `denyRead`, Codex deny globs, Gemini strict profiles). Tool-level rules alone are advisory in all of these agents. This matches CONTEXT.md §2.10: local grants are conventions plus detection.
- To give an agent the library, the generated grant can write the tool-native setting: Claude `additionalDirectories` (or `--add-dir`, which also loads skills); a Codex profile with a workspace root; Gemini `includeDirectories`; an OpenCode `external_directory` allow rule. To *restrict* an agent to one area, it would also write deny rules for the other areas plus sandbox settings. No agent shares a format with another.
- For provenance, a `pneuma-base` CLI run by the agent can read `CLAUDE_CODE_SESSION_ID` (Claude, observed but undocumented), maybe `CODEX_THREAD_ID` (unverified), and nothing for Gemini or OpenCode. A robust design accepts an explicit `--session` flag or env var, sniffs known variables as a fallback, and otherwise records "session unknown". The transcript path can be derived for Claude (and reached via hooks); for Codex it means scanning rollouts.

### Gaps
- Whether Codex actually sets `CODEX_THREAD_ID`/`CODEX_SESSION_ID` in command environments (would need a `codex exec` run).
- OpenCode session storage path and any session env var. Cursor CLI session storage. Not researched.
- Codex `--add-dir` flag status in v0.167. The fetched pages do not mention it.

---

## 3. Model Context Protocol: roots, resources, authorization, and exposing a subset of a store (current spec state)

### Takeaway
The current MCP revision is **2026-07-28**, and it changed the picture. MCP is now **stateless**: no `initialize` handshake and no `Mcp-Session-Id`. **Roots is deprecated**, and the guidance is to pass directories through tool parameters, resource URIs or server configuration. Resources remain (list/read/templates, now with cache TTLs). Authorization is optional and applies only to HTTP transports. stdio servers "SHOULD NOT" use it and take credentials from the environment. So an MCP server that exposes "one area of the library" does it by **its own configuration** (stdio) or **by token scope + audience** (HTTP). It cannot rely on client-declared roots.

### Cited Findings
- The spec is versioned 2026-07-28 (schema `schema/2026-07-28/schema.ts`). Server features: Resources, Prompts, Tools. Client features: Elicitation only. Extensions are opt-in (Tasks, "Skills over MCP", MCP Apps) and negotiated through capabilities — [MCP spec latest](https://modelcontextprotocol.io/specification/latest)
- "Remove protocol-level sessions and the `Mcp-Session-Id` header … Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments" (SEP-2567) — [MCP changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in `_meta`." A new `server/discover` RPC is mandatory (SEP-2575) — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- "Deprecate the Roots, Sampling, and Logging features (SEP-2577) … Suggested migrations: pass directories or files via tool parameters, resource URIs, or server configuration instead of Roots." `notifications/roots/list_changed` was removed. Server-initiated `roots/list` was replaced by the Multi Round-Trip Request pattern (`InputRequiredResult`) — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- `resources/subscribe` was replaced by `subscriptions/listen`. List and read results (`resources/list`, `resources/read`, `resources/templates/list`) must carry `ttlMs` and `cacheScope` — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Authorization is OPTIONAL. HTTP transports SHOULD conform. "Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment." The MCP server is an OAuth 2.1 resource server and MUST implement Protected Resource Metadata (RFC 9728). Client ID Metadata Documents are preferred, and Dynamic Client Registration is deprecated — [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Token audience binding (RFC 8707 `resource` param), scope challenges in `WWW-Authenticate`, step-up on 403 `insufficient_scope`, and the token-passthrough ban are as in §1 — [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- "MCP itself cannot enforce these security principles at the protocol level." Hosts must get user consent before exposing data or invoking tools. Tool annotations are untrusted unless they come from a trusted server — [MCP spec latest](https://modelcontextprotocol.io/specification/latest)

### Inferences
- The correct MCP mapping for "a grant to one area": a stdio server started as `pneuma-base mcp --library X --area Y --grant <token>` (configuration scope), or an HTTP server whose tokens carry `resource=<library URL>` and scopes like `area:research:read`. Do not build on Roots.
- MCP's own move to "server-minted handles passed as ordinary tool arguments" for cross-call state supports passing the session/scene id explicitly as a parameter rather than relying on transport identity.

### Gaps
- The Resources page itself (URI schemes, `resources/read` content shape in 2026-07-28) was not fetched. Only the changelog's statements are used.
- How Claude Code and Codex register MCP servers at user scope (so a library server is available in every directory) was not re-verified.
- The "Skills over MCP" extension status and format were not read.

---

## 4. Agent discovery of a store: Agent Skills, AGENTS.md, CLAUDE.md, marketplaces, and how a store in another directory becomes known

### Takeaway
There are now open standards for both instruction files (**AGENTS.md**, stewarded by the Linux Foundation's Agentic AI Foundation) and skills (**Agent Skills / SKILL.md**, agentskills.io). Each agent still looks in **different directories**. Claude Code reads `~/.claude/skills` and `.claude/skills`. Codex reads `~/.agents/skills` and `.agents/skills`. Claude reads `CLAUDE.md`, and reads `AGENTS.md` only when no CLAUDE.md exists. Codex reads `~/.codex/AGENTS.md` and project AGENTS.md. A store in an unrelated directory becomes known only through **user-level** hooks: a user-level skill, a user-level instruction file (Claude's `@/abs/path` import works there without a prompt), a SessionStart hook that injects context, or a user-scope MCP server. All discovery is name+description first (progressive disclosure), and descriptions are truncated: 1,536 chars in Claude, and the whole list capped at 2% of context or 8,000 chars in Codex.

### Cited Findings
**Agent Skills standard**
- A skill is a directory with `SKILL.md` (YAML frontmatter + Markdown). Required: `name` (≤64, lowercase/digits/hyphens, **must match the parent directory name**) and `description` (≤1024, "what the skill does and when to use it"). Optional: `license`, `compatibility` (≤500), `metadata` (string map), `allowed-tools` (experimental) — [Agent Skills spec](https://agentskills.io/specification)
- Progressive disclosure: about 100 tokens of metadata for all skills at startup, the full body (<5000 tokens recommended) on activation, and `scripts/`, `references/`, `assets/` on demand. Keep references one level deep. A `skills-ref validate` tool exists — [Agent Skills spec](https://agentskills.io/specification)

**Claude Code**
- Skill locations: enterprise (managed dir), personal `~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/` in the start dir "and in every parent directory up to the repository root", nested subdir skills (loaded lazily), `--add-dir` dirs, plugins (`/plugin:skill`), and claude.ai account skills synced to `~/.claude/skills/synced/`. Precedence is enterprise > personal > project. Live reload is supported — [Claude Code skills](https://code.claude.com/docs/en/skills)
- It follows the Agent Skills standard but adds fields (`when_to_use`, `disable-model-invocation`, `user-invocable`, `context: fork`, `paths`, `hooks`…). Outside Claude Code only the standard fields work, and extra fields in a claude.ai upload "fails with a hard error". "the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing." The page does not mention `.agents/skills` — [Claude Code skills](https://code.claude.com/docs/en/skills)
- Instruction files: `~/.claude/CLAUDE.md` applies to all projects, alongside project `./CLAUDE.md` or `./.claude/CLAUDE.md`. `@path` imports allow relative and absolute paths, recursing up to four hops. External imports from *project* files need a one-time approval dialog. User-scope files "load their imports without the dialog" — [Claude Code memory](https://code.claude.com/docs/en/memory)
- Claude Code (v2.1.277+) reads `AGENTS.md` by default only when there is no `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` in the cwd or above it. `~/.claude/CLAUDE.md` does not count for that check. The `claude-md-and-agents-md` setting loads both — [Claude Code memory](https://code.claude.com/docs/en/memory)
- A SessionStart hook can return `additionalContext`, which is inserted at conversation start (matchers `startup`, `resume`, `clear`, `compact`, `fork`) and capped at 10,000 chars per string — [Claude Code hooks](https://code.claude.com/docs/en/hooks)

**Codex**
- Skills: "Codex scans `.agents/skills` in every directory from your current working directory up to the repository root". It also reads user `$HOME/.agents/skills`, admin `/etc/codex/skills` and bundled system skills. "Symlinked skill folders are supported." Duplicates are not merged. `SKILL.md` must have `name` and `description`. Optional `agents/openai.yaml` sets UI metadata, `policy.allow_implicit_invocation` and tool dependencies (e.g. MCP servers). The initial list is capped at 2% of context (8,000 chars if unknown) — [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- AGENTS.md: global `~/.codex/AGENTS.md` (or `AGENTS.override.md`), then project files from the git root down to the cwd, at most one per directory, concatenated so that closer files win. The combined limit is `project_doc_max_bytes` = 32 KiB, and Codex "stops adding files once the combined size reaches the limit". `project_doc_fallback_filenames` adds names — [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

**AGENTS.md standard**
- "A simple, open format for guiding coding agents … stewarded by the Agentic AI Foundation under the Linux Foundation." There is no required structure. "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything." The site lists Codex, Jules, Cursor, Gemini CLI, opencode, Copilot coding agent, Zed, Windsurf and others as supporters (self-reported) — [agents.md](https://agents.md/)

### Inferences
- "One-click skill + grant" for Pneuma Base means writing **one canonical SKILL.md inside the library**, using only standard fields so every agent can read it, and **installing a pointer per agent**: a symlink or copy at `~/.claude/skills/<lib>/` and `~/.agents/skills/<lib>/`. Codex documents symlink support. Claude Code's symlink behavior for skills was not verified. The skill `name` must equal the folder name.
- CONTEXT.md principle 2 ("the generated skill can just point to the root description") is supported by the format: SKILL.md body says "read `<library>/README` first". The description must lead with the trigger, because of the 1,536-char and 2%-of-context limits.
- A user-level instruction line (`@/path/to/library/README.md` in `~/.claude/CLAUDE.md`; a line in `~/.codex/AGENTS.md`) is the alternative path that is always loaded. It costs context in every session, while a skill costs ~100 tokens until activated.

### Gaps
- Claude Code and Codex plugin marketplace formats (`marketplace.json`, Codex plugins) were not fetched this session.
- Whether Gemini CLI, Cursor and OpenCode read `.agents/skills` or another skills directory was not checked.
- Claude Code's treatment of symlinked skill directories was not checked.

---

## 5. Audit instead of enforcement: systems built on convention plus after-the-fact detection, and how they present violations

### Takeaway
Mature "detect, don't prevent" systems share four traits. They keep a **baseline** that the audited party cannot quietly rewrite (an AIDE database, a transparency log, CODEOWNERS on the base branch). They **compare on demand**. They **show violations as a list in the normal UI** (CODEOWNERS errors are highlighted in the file view and exposed through the API). When the system itself is unsure, they **lock further automatic action** rather than guess (rclone bisync's `.lst-err` lockout, covered in §8). Coding agents label their own tool rules "best-effort", which puts them in this category.

### Cited Findings
- AIDE "creates a database from the regular expression rules that it finds from the config file(s). Once this database is initialized it can be used to verify the integrity of the files." It records digests (sha256, sha512…), file type, permissions, inode, owner/group, size, link count, and mtime/ctime/atime. Config and database are plain text — [AIDE](https://aide.github.io/)
- CODEOWNERS: "last matching pattern takes the most precedence." Owners are *requested* for review, and merges are blocked only if branch protection enables "Require review from Code Owners". The file from the PR's base branch is used. "If any line … contains invalid syntax, that line will be skipped." Errors are highlighted when viewing the file and are available through the API — [GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- Rekor (Sigstore) is "an immutable, tamper-resistant ledger." Auditors check that "the log remains append-only and entries are never mutated or removed". Monitors let verifiers watch for entries under their own identities, and Omniwitness audits the log — [Sigstore Rekor overview](https://docs.sigstore.dev/logging/overview/)
- Presigned-URL audit: logs identify the signer, not the bearer. Issuance is local and unlogged unless the issuer records it. Server access logs are "best-effort … a missing record doesn't prove that a request didn't occur" — [AWS S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- Claude Code calls its own Read-deny coverage of Grep/Glob "best-effort" and says rules don't reach subprocesses. It recommends the OS sandbox for real enforcement — [Claude Code permissions](https://code.claude.com/docs/en/permissions)

### Inferences
- The Pneuma Base "provenance unknown" and "possibly stale" checks are an AIDE-style integrity scan: hash plus size/mtime per item, compared against what the records say. The output is a list of added / removed / changed-without-record items. AIDE's own advice to keep the baseline out of reach of the audited party is unverified (see Gaps). For a local library the records are writable by the agent, so append-only per-scene files (CONTEXT.md §4.7) and optional hash chaining (Rekor-style) are what make silent rewriting *detectable*. They do not make it impossible.
- CODEOWNERS shows that "owner per path" plus "advisory unless a gate is switched on" is accepted practice. It maps to "area = folder" plus "grant = advisory locally, enforced through software".

### Gaps
- AIDE's `--init/--check/--update` workflow, its report format (added/removed/changed sections) and its guidance on keeping the database read-only or off-host were not on the fetched page. Unverified recall: AIDE reports summarize added, removed and changed entries, and the docs advise storing the database on read-only media.
- Git hooks were not fetched. Unverified recall: client-side hooks are not transferred by clone, and `git commit --no-verify` skips pre-commit and commit-msg hooks. This is the canonical "convention that can be bypassed".
- Tripwire, and Certificate Transparency (RFC 6962/9162) Merkle inclusion and consistency proofs, were not fetched.

---

## 6. Plugin models that move local content elsewhere: minimal store–plugin contract; where desired and actual state live

### Takeaway
The durable pattern, used by both git remote helpers and git-annex special remotes, is: **an executable found by naming convention on PATH (`git-remote-<x>`, `git-annex-remote-<x>`), a line-based stdin/stdout protocol, a capabilities handshake first, a small required verb set, and `UNSUPPORTED` for optional verbs**. The store keeps the plugin's small state (config, per-item state, location tracking) **inside the repository itself**, so it travels with the folder. Infrastructure tools split state three ways: **desired state** (Terraform config; Kubernetes `spec`), **last-known actual state** (Terraform state file; Kubernetes status reported back), and the live remote. A Read/refresh step detects drift.

### Cited Findings
**git remote helpers**
- Git invokes `git remote-<transport>` for `<transport>://` URLs, for `<transport>::<address>`, or for a configured `remote.<name>.vcs`. "Git sends the remote helper a list of commands on standard input, one per line. The first command is always the _capabilities_ command." Capabilities can be marked `*` mandatory: "Any unknown mandatory capability is a fatal error" — [gitremote-helpers](https://git-scm.com/docs/gitremote-helpers)
- Capabilities include `fetch`, `push`, `import`, `export`, `connect`, `option`, `refspec`. `refspec` confines the helper to a private ref namespace (e.g. `refs/svn/origin/...`). `GIT_DIR` is set "to determine where to store additional data". Push replies are `ok <dst>` / `error <dst> <why>` — [gitremote-helpers](https://git-scm.com/docs/gitremote-helpers)

**git-annex external special remotes**
- The program is `git-annex-remote-$name`, "git-annex finds the appropriate program in PATH". It "may be left running for a long period of time". "The protocol is line based". stdout is protocol only, and progress goes to stderr — [git-annex external special remote protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/)
- Required: `VERSION`, `INITREMOTE` (may run repeatedly, so "any one-time setup tasks should be done idempotently"), `PREPARE`, `TRANSFER STORE|RETRIEVE Key File`, `CHECKPRESENT Key` (SUCCESS / FAILURE / **UNKNOWN**; a key should not appear present "until all the data has been sent"), `REMOVE Key` — [git-annex protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/)
- Optional verbs get `UNSUPPORTED-REQUEST`: `GETCOST`, `GETAVAILABILITY` (should be cheap), `WHEREIS` (users "expect `git annex whereis` to run fast, without eg, network access"), `GETINFO`, `LISTCONFIGS`, `EXPORTSUPPORTED` (tree export) and `EXTENSIONS` — [git-annex protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/)
- State: `SETCONFIG` stores settings "in the git-annex branch". `SETSTATE`/`GETSTATE` store per-key state there ("best to avoid storing much state"). URL presence is recorded there too. Credentials stay out of the branch unless encrypted. `ERROR msg` ends the session — [git-annex protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/)

**Terraform**
- "Terraform assumes that every resource: operates as a pure key/value store, with values getting returned exactly as they were written" and "needs only one API call to update or return its state." Resources implement Create / Read (refresh prior state against the real object) / Update / Delete / ImportState, plus a Schema covering "configuration, plan, and state" — [Terraform plugin framework: resources](https://developer.hashicorp.com/terraform/plugin/framework/resources)
- State exists to map config to real objects: "Terraform expects that each remote object is bound to only one resource instance." It keeps dependency metadata so removed resources can still be deleted in order, and it caches attributes. With `-refresh=false`, "the cached state is treated as the record of truth." Remote state with locking keeps teams consistent — [Terraform state purpose](https://developer.hashicorp.com/terraform/language/state/purpose)

**Kubernetes controllers**
- "Each controller tries to move the current cluster state closer to the desired state." Objects "have a spec field that represents the desired state." Controllers for external systems "find their desired state from the API server, then communicate directly with an external system", then "report the current state back to your cluster's API server." Labels let controllers tell their objects apart: "The Job controller does not delete the Pods that your Deployment created" — [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)

**Static-site deploy (Cloudflare)**
- Workers static assets replace Pages: use `wrangler deploy` with a Wrangler config whose `name` is mandatory and `assets.directory` points to the files. Workers have "a distinctly broader set of features" than Pages. Pages projects are removed with `npx wrangler pages project delete` — [Cloudflare: migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)

### Inferences
- The minimal Pneuma Base store↔plugin contract, borrowed from git-annex: `pneuma-base-plugin-<name>` on PATH; a line or JSON-lines protocol; `CAPABILITIES` first; required `PREPARE`, `PUSH item`, `STATUS item` (present / absent / **unknown**), `REMOVE item`; optional `LIST`, `COST`, `INFO` answered with `UNSUPPORTED`. The plugin's small state (remote id, last deployed hash, URL) lives **in the library folder** under a plugin namespace, the way git-annex uses its branch and git helpers use `refs/<ns>/`.
- For "100 sites, deploy 40": desired state = a per-item declaration in the library ("deployable" capability plus an on/off switch). Last-known actual state = a per-plugin record in the library (deployed URL, content hash, time). Truth = the remote, which `STATUS`/refresh checks. Like Terraform's one-object-one-instance rule, each remote deployment should map to exactly one library item, so "turn off" can delete safely.
- `WHEREIS`/`STATUS` should answer from the local record without network (git-annex's "run fast" expectation). A separate `--refresh` asks the remote.

### Gaps
- rclone backend interface, Obsidian Sync/Publish and community publish plugins, and Vercel/Netlify CLI deploy models were not fetched. Unverified recall: `netlify deploy --dir`, `vercel deploy --prebuilt`.
- The Terraform gRPC plugin protocol (versions 5/6) was not fetched.
- git-annex export/import (tree export) appendix details were not read.

---

## 7. Capability declaration: plugins acting on whatever declares a capability, regardless of concrete type, and what keeps declarations honest

### Takeaway
Three honesty mechanisms recur. (a) **The declarer is the implementer**: an LSP server or a git remote helper declares what it can do, and the declaration lives next to the code that does it. (b) **The consumer checks at evaluation time and refuses**: Nix refuses packages whose `meta.broken`/`meta.platforms`/`meta.license` disqualify them. Git aborts on an unknown mandatory capability. (c) **Pure labels carry no enforcement**: Kubernetes labels "do not directly imply semantics to the core system", and overlapping selectors are simply declared invalid for some types. Unknown capabilities are ignored and missing ones mean "absent" (LSP). That rule lets declarations evolve.

### Cited Findings
- LSP: "A development tool and the language server announce their supported features using capabilities … exchanged … during the initialize request." "Clients should ignore server capabilities they don't understand." "A missing property should be interpreted as an absence of the capability" — [LSP 3.17 spec](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- MCP extensions are "always opt-in and require explicit support from both client and server, negotiated through capabilities" — [MCP spec latest](https://modelcontextprotocol.io/specification/latest)
- Git remote helpers: a `*` prefix marks a capability mandatory, and an unknown mandatory capability is fatal — [gitremote-helpers](https://git-scm.com/docs/gitremote-helpers). git-annex: optional verbs answered with `UNSUPPORTED-REQUEST` — [git-annex protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/)
- Kubernetes labels: key/value pairs that "do not directly imply semantics to the core system". "labels do not provide uniqueness". Selectors are equality- or set-based (`in`, `notin`, `exists`) and ANDed, with no OR. "Non-identifying information should be recorded using annotations." For ReplicaSets, "the label selectors of two instances must not overlap within a namespace" — [Kubernetes labels and selectors](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)
- Nix: "By default, Nix will prevent installation" if `meta.broken` is true, if `meta.platforms` excludes the system, or if the license is unfree. Each can be overridden (`allowBroken`, `allowUnsupportedSystem`, `allowUnfree`). "All this is checked during evaluation already" — [Nixpkgs manual](https://nixos.org/manual/nixpkgs/stable/#chap-meta)
- UTIs: types form a conformance hierarchy with multiple inheritance. `public.image`/`public.text` conform to both `public.data` (physical) and `public.content` (functional). Custom file-format UTIs must root at `public.data` or `com.apple.package`. `UTTypeConformsTo` / `isSubtype(of:)` test conformance — [Apple UTI concepts (archived)](https://developer.apple.com/library/mac/documentation/FileManagement/Conceptual/understanding_utis/understand_utis_conc/understand_utis_conc.html), [Declaring UTIs (archived)](https://developer.apple.com/library/content/documentation/FileManagement/Conceptual/understanding_utis/understand_utis_declare/understand_utis_declare.html) (search summary)

### Inferences
- "Plugins only see capabilities" (CONTEXT.md §3) has strong precedent: K8s controllers pick objects by label, and LSP clients use only features the server declared. A deploy plugin should select items by `capabilities: [deployable]` plus its own required fields (e.g. a build output directory), never by item type.
- Honesty for a "deployable" declaration: make the declaration *checkable*. Like Nix, the library or plugin validates at plan time that required fields exist (output dir present, entry file present) and refuses with a listed reason. Like UTI conformance, allow `deployable` to imply `versioned` if that is wanted, through one explicit implication table rather than per-type code.
- The LSP and git rules give a forward-compatibility policy for the library format: unknown capability keys are ignored, a missing key means absent, and a `required`/`*` marker means "a reader that doesn't understand this must refuse to act".

### Gaps
- npm `package.json` `scripts` was not fetched. Unverified recall: lifecycle names (`prepare`, `postinstall`) run automatically, and `npm run <name>` runs any declared script. There the declaration is the executable command.
- MIME type registration (IANA) and the current Apple `UTType` reference were not fetched.

---

## 8. Two-way sync as a plugin for a folder with append-only records: what the folder format must guarantee

### Takeaway
None of the common sync tools (rclone bisync, Syncthing, Dropbox) merges file contents. A file changed on two sides becomes **two files**, with the loser renamed to a conflict copy (or deleted, if configured). "Append-only" inside one file is therefore **not enough**: two devices appending to the same file still conflict. Sync stays safe when **each file has exactly one writer** (e.g. one file per scene per device/agent), files become immutable when closed, writes go through temp-and-rename, and caches and indexes are excluded. Bisync adds guards worth copying: an access-check sentinel file, a max-delete percentage abort, lock files, and a lockout after critical errors.

### Cited Findings
- rclone bisync keeps listings of both sides from the last run (in `~/.cache/rclone/bisync`) and compares against them. The first run requires `--resync`. An empty path blocks a normal run. `--check-access` aborts unless `RCLONE_TEST` sentinel files exist on both sides — [rclone bisync](https://rclone.org/bisync/)
- `--max-delete` (default 50%): exceeding it makes bisync "abort with a warning message, without making any changes." Conflicts default to keeping both, and `--conflict-loser num` auto-numbers. Lock files prevent overlapping runs. Critical errors rename listings to `.lst-err` and lock out later runs until `--resync`. Change detection defaults to modtime+size, and files changed during a run can be lost — [rclone bisync](https://rclone.org/bisync/)
- Syncthing: a conflict happens when a file "has been modified on two devices simultaneously and the content actually differs". The older-mtime file is renamed `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>` (device id breaks ties), and conflict copies then sync everywhere. "Syncthing never writes directly to a destination file." It uses temp files `.syncthing.<name>.tmp`, which are ignored by sync. No merging: "we don't know which of the conflicting files is the 'best'" — [Syncthing: understanding synchronization](https://docs.syncthing.net/users/syncing.html)
- Dropbox creates a "conflicted copy" when two users edit at once or one edits offline. "The last version saved will always appear as the conflicted copy." Users must "compare both versions and merge them manually" — [Dropbox conflicted copies](https://help.dropbox.com/organize/conflicted-copy)
- S3 versioning keeps "every version of every object". A delete inserts a delete marker, and simultaneous writes are all stored. Once enabled, a bucket "can never return to an unversioned state" (only suspended). Each version is a full object, not a diff — [S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)

### Inferences
- Format guarantees for safe sync, derived from the above: (1) one writer per file: name scene/record files with a unique id (e.g. session id + device) so no two machines write the same path; (2) closed record files are never modified again, and corrections are new files; (3) atomic writes (temp + rename, temp names on an ignore list); (4) derived indexes and caches live in an excluded path and can be rebuilt (CONTEXT.md §4.3 already says so); (5) the library's scanner recognizes `.sync-conflict-`, "conflicted copy" and bisync `..path1/..path2` style names and surfaces them as items needing a human or agent decision, not as new content; (6) a sentinel file (like `RCLONE_TEST`) at the library root lets a sync plugin refuse to run against an empty or wrong folder.
- Item content (not records) can still conflict, for example two agents editing the same artifact. That is where an optional "versioned" capability, or an S3 versioned backend, earns its place.

### Gaps
- Dropbox's exact conflicted-copy filename format is not given on the fetched page.
- Syncthing's ignore-pattern mechanics (`.stignore`) and rclone filter files were not fetched.
- I did not check whether bisync's conflict-loser naming (`..path1`/`..path2` vs numbered suffixes) changed in 2026 releases.

---

## Ideas worth borrowing and traps to avoid

Each item restates a finding above and names its source.

**Borrow**
1. **Grant shape = issuer, audience, subject/resource, command, conditions, nbf/exp, nonce.** Attenuation only, by chaining — [UCAN spec](https://github.com/ucan-wg/spec), [Biscuit](https://doc.biscuitsec.org/reference/specifications).
2. **Expiry and other limits as checks, not special fields**, evaluated with request context by an authorizer — [Biscuit](https://doc.biscuitsec.org/reference/specifications).
3. **Log every grant issuance yourself.** Issuing a signed credential is local and leaves no trace otherwise — [AWS presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).
4. **Bind remote tokens to one audience (`resource`) and announce required scopes in the challenge, with step-up** — [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
5. **Scope an MCP server by its own configuration or token scope and pass ids as tool arguments.** Roots are deprecated and sessions were removed — [MCP changelog 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
6. **Ship one standard-only SKILL.md and install it per agent:** `~/.claude/skills/` for Claude, `~/.agents/skills/` for Codex (symlinks supported); the folder name must equal `name` — [Agent Skills spec](https://agentskills.io/specification), [Claude Code skills](https://code.claude.com/docs/en/skills), [Codex skills](https://learn.chatgpt.com/docs/build-skills).
7. **Use the tool-native "extra directory" setting to grant the library folder:** `additionalDirectories`/`--add-dir`, Codex workspace roots, `includeDirectories`, `external_directory` — [Claude Code permissions](https://code.claude.com/docs/en/permissions), [Codex permissions](https://learn.chatgpt.com/docs/permissions), [Gemini trusted folders](https://geminicli.com/docs/cli/trusted-folders/), [OpenCode permissions](https://opencode.ai/docs/permissions/).
8. **Plugin = `<prefix>-<name>` executable on PATH, a line protocol, capabilities first, a small required verb set, `UNSUPPORTED` for the rest, a tri-state presence check, idempotent init** — [git-annex protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/), [gitremote-helpers](https://git-scm.com/docs/gitremote-helpers).
9. **Keep plugin state inside the store, under a plugin namespace**, so it travels with the folder — [git-annex protocol](https://git-annex.branchable.com/design/external_special_remote_protocol/), [gitremote-helpers](https://git-scm.com/docs/gitremote-helpers).
10. **Separate desired state, last-known actual state and the live remote; bind each remote object to exactly one item** — [Terraform state purpose](https://developer.hashicorp.com/terraform/language/state/purpose), [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/).
11. **Select by declared capability, ignore unknown capabilities, treat missing as absent, and mark must-understand capabilities** — [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [Kubernetes labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/), [gitremote-helpers](https://git-scm.com/docs/gitremote-helpers).
12. **Check declarations at evaluation time and refuse with a reason** — [Nixpkgs manual](https://nixos.org/manual/nixpkgs/stable/#chap-meta).
13. **Sync guards:** sentinel file check, max-delete abort, lock file, lockout after critical error, conflicts kept as both — [rclone bisync](https://rclone.org/bisync/).
14. **Never write in place; write to an ignored temp name and rename** — [Syncthing](https://docs.syncthing.net/users/syncing.html).
15. **Show violations in the normal view and the API, and skip invalid lines rather than fail** — [GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

**Avoid**
1. **Treating tool-level rules as enforcement.** Claude Code's Read/Edit denies don't reach subprocesses, and OpenCode's shell runs with full user authority — [Claude Code permissions](https://code.claude.com/docs/en/permissions), [OpenCode permissions](https://opencode.ai/docs/permissions/).
2. **Assuming a sandbox covers file tools or reads.** Claude's sandbox covers shell only and allows most reads by default, and it is off by default. Gemini's is enabled by flag, env var or setting, and its page states no default — [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing), [Gemini CLI sandbox](https://geminicli.com/docs/cli/sandbox).
3. **Granting `run` or exec and believing the path scope still holds.** Subprocesses escape runtime path grants — [Deno security](https://docs.deno.com/runtime/fundamentals/security/).
4. **Relying on MCP Roots or MCP sessions for scoping** (deprecated and removed in 2026-07-28) — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
5. **Relying on an undocumented session env var.** `CLAUDE_CODE_SESSION_ID` was observed but is not documented, `CODEX_THREAD_ID` is only a binary string, and Gemini has none. Accept an explicit session parameter — [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex env vars](https://learn.chatgpt.com/docs/config-file/environment-variables), [Gemini session management](https://geminicli.com/docs/cli/session-management).
6. **Assuming agents share a skills directory or instruction file.** Claude reads `.claude/skills` and CLAUDE.md (AGENTS.md only without a CLAUDE.md). Codex reads `.agents/skills` and AGENTS.md with a 32 KiB cap — [Claude Code memory](https://code.claude.com/docs/en/memory), [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
7. **Long skill descriptions.** Claude truncates them at 1,536 chars, and Codex caps the whole list at 2% of context — [Claude Code skills](https://code.claude.com/docs/en/skills), [Codex skills](https://learn.chatgpt.com/docs/build-skills).
8. **Bearer grants with no revocation path.** Presigned URLs die only with their signer's credentials, and UCAN/Biscuit revocation needs a revocation list the verifier checks — [AWS presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), [UCAN spec](https://github.com/ucan-wg/spec), [Biscuit](https://doc.biscuitsec.org/reference/specifications).
9. **Multiple writers appending to one file under sync.** Sync tools don't merge, so the result is conflict copies — [Syncthing](https://docs.syncthing.net/users/syncing.html), [Dropbox](https://help.dropbox.com/organize/conflicted-copy), [rclone bisync](https://rclone.org/bisync/).
10. **Change detection by modtime+size alone** can miss content changes — [rclone bisync](https://rclone.org/bisync/).
11. **Overlapping selectors.** Two controllers claiming the same objects is declared invalid for ReplicaSets, so plugin selection should not let two deploy targets claim one item silently — [Kubernetes labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/).
