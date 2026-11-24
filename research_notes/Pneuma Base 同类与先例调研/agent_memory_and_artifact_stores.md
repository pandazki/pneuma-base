# Agent memory stores, artifact stores, and session provenance (state as of 2026-11-25)

Scope: products and open-source projects that give AI agents persistent memory, a workspace or file system, or an artifact store. The goal is to test this impression: "existing tools either store memory fragments or store output artifacts; few put what the agent read and what it made into one store and link them by provenance to the session they came from."

Short verdict (details under question 3): **mostly confirmed, with named partial exceptions.** Each piece exists somewhere. Raw inputs linked to derived facts exist in Graphiti/Zep. Uploaded and generated files in one list exist in ChatGPT Library. Output-to-session links exist in Entire, git-ai and Claude Managed Agents memory versions. A raw/derived/log folder exists as a convention in Karpathy's LLM-wiki pattern. I found no product or project that does all of these at once: (a) keep inputs and outputs as first-class items in one store, (b) link each output to the session and to the inputs it came from, (c) stay readable without the software, and (d) work across different agent products.

Source-quality note: many fetches went to official docs (code.claude.com, platform.claude.com, learn.chatgpt.com, help.openai.com, docs.entire.com, getzep.com, letta.com, Turso spec). Items that come from third-party guides, auto-generated wikis (DeepWiki) or search snippets are marked as such.

---

## 1. Which products store agent memory? What is the stored unit, where does it live, and is it readable without the software?

### Takeaway
Memory products mostly store distilled fragments: notes, facts, or graph entities that the agent or a background model extracts from conversations. They do not store the raw materials or the outputs. The file-based ones are Claude Code auto memory, the Claude memory tool, Letta MemFS, Codex memories, Basic Memory, the MCP memory server and OpenClaw. You can read their files without the software, but nothing in them records which session a note came from. The exceptions with real source links are database or graph systems (Graphiti/Zep, Cognee, Claude Managed Agents memory stores), and you can read those only through their APIs.

### Cited Findings

**Claude Code auto memory (Anthropic, local CLI)**
- Two systems: CLAUDE.md files that the user writes, and auto memory that Claude writes. Auto memory is "Per repository, shared across worktrees". At session start Claude loads "up to the first 200 lines or 25KB of `MEMORY.md`". — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Location: "Each project gets its own memory directory at `~/.claude/projects/<project>/memory/`. The `<project>` path is derived from the git repository". The directory holds "a `MEMORY.md` index and one topic file per memory". MEMORY.md is described as "Index, one line per memory, loaded at session start". — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Unit: one Markdown file per memory, with a frontmatter `type` field that is one of `user`, `feedback`, `project` or `reference`. "Claude skips anything it can derive from the codebase". — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- "Auto memory is machine-local … Files are not shared across machines or cloud environments." Memory files are excluded from the transcript retention sweep (`cleanupPeriodDays`), so the memory outlives the transcripts it came from. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- The location can be changed with `autoMemoryDirectory` in settings.json (an absolute path or `~/`). — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- The docs list no session-ID or source field in memory files. The documented fields are only the `type` frontmatter and the index line. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)

**Claude memory tool (Anthropic API, `memory_20250818`)**
- "The memory tool operates client-side: Claude requests file operations, and your application runs them." The `/memories` path "is a prefix that your handler maps onto real storage, such as a per-user directory or keys in a database." The commands are view, create, str_replace, insert, delete and rename. The status is stable on all Claude 4+ models. — [Claude API docs: memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- The API auto-injects this text: "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE." The docs recommend that developers "Periodically delete memory files that haven't been accessed in a long time." The tool defines no provenance or session metadata. — [Claude API docs: memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

**Claude Managed Agents memory stores (Anthropic-hosted, beta `agent-memory-2026-07-22`)**
- "A memory store is a workspace-scoped collection of text documents … When you attach a store to a session, it is mounted as a directory inside the session's sandbox". The mount is at `/mnt/memory/<slug>/`. "Each memory in a store is addressed by a path". — [Claude docs: Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)
- Provenance to session: "Every change to a memory creates an immutable memory version". Writes "produce memory versions attributed to the session". Versions are kept 30 days, and the recent versions of a live memory are always kept. — [Claude docs: Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)
- Limits: 100 kB per memory, 10,000 memories per store, 8 stores per session. Access is `read_only` or `read_write`. Reads and writes show up in the session event stream as ordinary `agent.tool_use` / `agent.tool_result` events. — [Claude docs: Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)

**OpenAI Codex memories (local, off by default)**
- "Codex stores memories under your Codex home directory. By default, that's `~/.codex`." The directory is `memories/` or `memories_v2/`. "Treat these files as generated state". Memories come from "eligible prior chats" in a background pass. Config keys include `memories.generate_memories`, `memories.use_memories`, `memories.disable_on_external_context` and `memories.consolidation_model`. — [OpenAI docs: Memories](https://learn.chatgpt.com/docs/customization/memories?surface=app)
- The official page does not say whether a memory links back to its source thread. It advises: "Keep required team guidance in `AGENTS.md`" and "Treat memories as a helpful recall layer". — [OpenAI docs: Memories](https://learn.chatgpt.com/docs/customization/memories?surface=app)
- (Third-party) The file layout is `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries/` (one file per rollout, named by date and slug, e.g. `2026-04-15-refactor-auth.md`) and `skills/`. Consolidation drops memories unused longer than `max_unused_days`. The memories are Codex-only, with "no cross-tool portability". — [Daniel Vaughan, Codex memory deep dive, 2026-04-18](https://codex.danielvaughan.com/2026/04/18/codex-built-in-memory-system-deep-dive/)
- (Secondary) Chronicle, launched around April 20, 2026, is an opt-in research preview that builds Codex memories from screen captures on macOS (Pro). Captures are deleted after 6 hours. — [Neowin](https://www.neowin.net/amp/openai-introduces-chronicle-for-codex-a-recall-like-memory-feature-for-developers-on-macos/)

**Letta: MemFS / Context Repositories**
- Blog post of 2026-02-12: "Letta Code stores a copy of the agent's context in the local filesystem". "every change to memory is automatically versioned with informative commit messages". Files have YAML frontmatter with a description. "The `system/` directory designates which files are always fully loaded into the system prompt". The filetree itself is always in the prompt. A defragmentation subagent targets "a clean hierarchy of 15–25 focused files". `/init` can learn from existing Claude Code and Codex histories. — [Letta blog: Context Repositories](https://www.letta.com/blog/context-repositories)
- The only provenance is git commit messages. The post gives no session or message IDs per memory file. — [Letta blog: Context Repositories](https://www.letta.com/blog/context-repositories)
- Local-mode agents commit to a local git repo and need no Letta remote. Letta API agents push commits to Letta Cloud. Shared memory repos are hosted in Letta Cloud. — [Letta docs: MemFS](https://docs.letta.com/letta-code/memfs)
- The older Letta Filesystem (folders of uploaded documents with `open_file`, `grep_file` and `search_file` tools) is deprecated and replaced by MemFS. — [Letta docs: Filesystem (deprecated)](https://docs.letta.com/v1-sdk/concepts/filesystem/index.md)

**mem0 / OpenMemory**
- Unit: extracted facts in a vector store, tagged with `user_id`, `agent_id`, `run_id`, `actor_id` and timestamps. A SQLite history records ADD, UPDATE and DELETE events per memory ID, and a messages table keeps the conversation context used for extraction. — [DeepWiki (auto-generated from code): mem0 history](https://deepwiki.com/mem0ai/mem0/5.4-history-and-audit-trails); mem0 paper, Apr 2025: [arXiv 2504.19413](https://www.arxiv.org/pdf/2504.19413)
- A third-party review finds that mem0 keeps operation history per memory ID but has "weak trace-to-extracted-fact provenance". — [Commonplace review of mem0](https://zby.github.io/commonplace/agent-memory-systems/reviews/mem0/)
- OpenMemory runs locally as Docker containers (API, Qdrant, Postgres). It works across MCP clients (Cursor, Claude Desktop, Windsurf, Cline) and keeps per-client pause and revoke controls and "audit logs for every read or write". — [mem0 blog: OpenMemory MCP](https://mem0.ai/blog/how-to-make-your-clients-more-context-aware-with-openmemory-mcp)

**Zep / Graphiti (temporal knowledge graph)**
- "Episodes are the raw sources: a chat message, a document chunk, a JSON record." "Zep keeps them byte-for-byte as ingested, and they remain retrievable." "An edge carries an `episodes` list holding every episode that contributed to its fact." (Post dated 2026-07-14.) — [Zep blog: provenance](https://www.getzep.com/blog/how-zep-tracks-provenance-in-agent-memory/)
- Bi-temporal model: one timeline for when a fact was true and one for when it was ingested. Superseded facts are invalidated, not deleted. — [Zep paper, Jan 2025, arXiv 2501.13956](https://arxiv.org/pdf/2501.13956.pdf); [Graphiti repo](https://github.com/getzep/graphiti)

**Cognee**
- (Third-party review) Every DataPoint records `source_pipeline`, `source_task`, `source_node_set` and `source_user`. The reviewer calls this "the strongest provenance model" among the systems they reviewed. — [Commonplace: Cognee](https://zby.github.io/commonplace/notes/related-systems/cognee)
- Cognee can import LangMem JSON exports and re-derive a graph from them. — [Cognee docs: migrate memory systems](https://docs.cognee.ai/examples/migrate-memory-systems)

**LangMem / LangGraph store**
- (Auto-generated wiki) LangMem storage is built on LangGraph's `BaseStore` abstraction. I found no provenance or source fields. — [DeepWiki: LangMem storage](https://deepwiki.com/langchain-ai/langmem/7-storage)

**Official MCP memory server (`@modelcontextprotocol/server-memory`)**
- It stores a knowledge graph of entities, relations and observations as a JSONL file. The path is set by `MEMORY_FILE_PATH` and defaults to `memory.jsonl`. — [MCP servers: memory README](https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/README.md)

**Basic Memory (Basic Machines)**
- It stores knowledge "in simple Markdown files on your computer". A local SQLite database handles indexing and search. Sync runs both ways, so humans can edit the files directly. It works with Claude Desktop, Cursor, Codex CLI and VS Code through MCP, the same folder opens in Obsidian, and a paid cloud option exists. — [Basic Memory README](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md)

**OpenClaw (open-source personal agent)**
- The workspace defaults to `~/.openclaw/workspace`. `SOUL.md` holds identity, `USER.md` holds user preferences, `MEMORY.md` holds durable facts and decisions, and `memory/YYYY-MM-DD.md` holds daily logs. The agent reads today's and yesterday's daily notes at start. — [OpenClaw docs: agent workspace](https://docs.openclaw.ai/concepts/agent-workspace); [OpenClaw AGENTS.default](https://docs.openclaw.ai/reference/AGENTS.default)

**Hook-based memory plugins for coding agents**
- claude-mem: a second agent turns tool activity (reads, edits, commands) into "short observations" and writes a summary at session end. Data lives in SQLite at `~/.claude-mem/claude-mem.db`, with Chroma for semantic search. It works with Claude Code, Codex, Cursor, OpenCode "and 11 more agents". Observations have citable IDs, and there is a web viewer. — [claude-mem repo](https://github.com/thedotmack/claude-mem)
- agent-memory (RashadAnsari): one SQLite file in the home directory, shared by Claude Code, Cursor and Codex. — [agent-memory repo](https://github.com/RashadAnsari/agent-memory)

**Products that dropped or demoted auto memory**
- Cursor removed its Memories feature on purpose starting in 2.1.x. Staff told users to export memories to `.mdc` Rules. — [Cursor forum: Are my memories gone?](https://forum.cursor.com/t/are-my-memories-gone/144057)
- Devin Desktop keeps auto-generated "Memories" next to user-written "Rules". Its docs recommend putting durable knowledge in a Rule or in AGENTS.md instead. — [Devin docs: memories](https://docs.devin.ai/desktop/cascade/memories.md)
- ChatGPT Projects "have built in memory, which means that it remembers all the chats and files you have created or uploaded in a project". — [OpenAI help: Projects in ChatGPT](https://intercom.help/openai/en/articles/10169521-projects-in-chatgpt)

### Inferences
- The file-based memory stores (Claude Code, Codex, Letta MemFS, Basic Memory, OpenClaw, MCP memory JSONL) can be read without the software. None of them records, per memory, which session produced it or which material it came from. Letta's git commit messages are the nearest thing, and they are free text.
- The systems with real source links (Graphiti episode lists, Managed Agents memory versions attributed to sessions, Cognee source fields, mem0 history) keep those links inside a database or hosted API. A plain-folder reader cannot follow them.
- The trend in 2026 runs toward "memory as a folder of Markdown files": Claude Code, Codex, Letta MemFS, Managed Agents (mounted as a directory), OpenClaw, Basic Memory. The Claude memory tool and Managed Agents expose memory to the model through file operations, even when a database stores it.

### Gaps
- I did not fetch the official ChatGPT consumer memory docs ("reference chat history"). I found no source on whether ChatGPT shows which chat a saved memory came from.
- I could not confirm whether Basic Memory notes carry a session or source field. The README describes entities, observations and relations only.
- The current storage and provenance schema of Cognee comes from a third-party code review, not from Cognee docs.

---

## 2. Which products store agent outputs or artifacts? Can an output be traced back to the conversation that made it, and to its inputs?

### Takeaway
Artifact stores are hosted lists of outputs. They know an artifact's owner and versions, but they rarely expose a link back to the conversation, and none records which inputs an output came from. Coding-focused provenance tools (Entire, git-ai, Agent Trace, SpecStory) are the exception. They do link outputs (code commits or lines) to the agent session and transcript, but only inside a git repository and only for code.

### Cited Findings

**Claude artifacts (claude.ai and Claude Code)**
- A Claude Code artifact is "a live, interactive web page that Claude Code publishes from your session to a private URL on claude.ai". "Unless you name a location, Claude writes the page to an HTML or Markdown file in a temporary directory outside your project, then publishes it." — [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts)
- Rediscovery: `/artifacts` lists owned and shared artifacts, with "The current session's artifacts come first, under This session". "Claude Code reads the list from your claude.ai account". The gallery is at claude.ai/code/artifacts. — [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts)
- Cross-session continuity is manual: "To update an artifact from a different session, give Claude its URL … Without either, a new session creates a new artifact instead of updating one." — [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts)
- Artifact content "is stored on Anthropic-operated infrastructure". The Compliance API lists artifacts and their versions, and Enterprise can set retention periods. The docs describe no link from an artifact back to its source session or source files. — [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts)
- In claude.ai chat, artifacts reach the sidebar Artifacts section only after "Publish", so you can find them "outside the original conversation". — [Claude help: publishing and sharing artifacts](https://support.claude.com/en/articles/9547008-publishing-and-sharing-artifacts) (search-snippet level)

**ChatGPT Library (and "Space")**
- "ChatGPT automatically saves uploaded and created files". You can filter by "Uploaded or Generated" and by file type, reuse files with "Add from library", and "Deleting a chat containing files does not delete a separate file that remains saved in Library." Storage runs from 500 MB (Free) to 100 GB (Pro). "If your account has access to Space, Space takes the place of Library." — [OpenAI help: Library for ChatGPT](https://help.openai.com/en/articles/20001052-library-for-chatgpt)
- The help article does not document a "go to source chat" link. It notes only that files from a locked chat open "only in the originating locked chat". — [OpenAI help: Library for ChatGPT](https://help.openai.com/en/articles/20001052-library-for-chatgpt)

**Manus**
- With Manus 2.0, Manus "automatically restores your most important files—artifacts, uploaded attachments, and project files like Slides/WebDev—to the new Sandbox". Intermediate code and temporary files are not restored. — [Manus blog: Manus 2.0 sandbox](https://www.manus.im/blog/manus-sandbox)
- A Project "keeps instructions, files, sources, skills, recommended connectors, and related tasks together". Users should "not rely on every earlier conversation being available". — [Manus: Projects](https://manus.im/features/projects)
- (Open-source clone, not the hosted product) AI Manus has a sidebar Library that "aggregates attachments and artifacts from all user sessions". — [AI Manus docs index](https://docsearch.algolia.com/mcp/docs/repo/simpleyyt/ai-manus) (weak source)

**Anthropic Files API**
- "Files that you uploaded cannot be downloaded." Only files created by code execution or skills can be downloaded. The generated file's ID "shows up in the code execution result block of the Messages response that created it." — [Claude docs: Files API](https://platform.claude.com/docs/en/build-with-claude/files)

**OpenAI Code Interpreter containers and Files**
- Generated files come back as `container_file_citation` annotations that carry the container ID, file ID and filename. — [OpenAI docs: Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter)
- Developers report that a file was created in `/mnt/data` but no citation came back. — [OpenAI community thread](https://community.openai.com/t/responses-api-code-interpreter-with-gpt-4-1-sometimes-creates-mnt-data-docx-but-returns-no-container-file-citation/1397663). Containers expire after about 20 minutes idle (forum reports, not official). — [OpenAI community thread](https://community.openai.com/t/reliably-retrieving-code-interpreter-files-from-the-container/1288268)

**Agent file systems and sandboxes**
- Turso AgentFS (BETA): "Everything stored in one portable SQLite database". "Every file operation is recorded and queryable." — [Turso docs: AgentFS](https://docs.turso.tech/agentfs/introduction). Spec v0.4 defines an insert-only `tool_calls` table (id, name, parameters, result, error, timings) and inode/dentry/data tables for files. The base schema has no `session_id` (listed only as a possible extension). File rows have no link to the tool call that wrote them. Reads only update `atime`. — [AgentFS SPEC.md](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md)
- The AgentFS overlay mode uses the host directory as a read-only base and the SQLite file as the writable layer. — [Turso blog: AgentFS overlay](https://turso.tech/blog/agentfs-overlay)
- E2B offers snapshots and pause/resume that keep the filesystem and memory. Volumes, which outlive sandboxes, are in private beta. — [E2B docs: snapshots](https://e2b.dev/docs/sandbox/snapshots); [E2B docs: volumes](https://e2b.dev/docs/volumes)
- Daytona sandboxes are persistent by default, and the docs say to "Use volumes to persist results". — [Daytona docs: persistence](https://www.daytona.io/docs/en/persistence)

**Coding provenance tools (output to session)**
- Entire CLI: a checkpoint stores "the linked Git commit, the agent session(s) behind the change, prompts and transcript, tool activity, changed files, token usage … AI attribution for changed lines". It lives "in your repository, in its own Git ref or on the checkpoints branch", and "Entire does not add extra commits to your working branch". The checkpoint ID goes into the commit as an `Entire-Checkpoint` trailer. Files that were only read are not listed (changed files only). — [Entire docs: checkpoints](https://docs.entire.com/cli/checkpoints). It supports Claude Code, Gemini CLI, Cursor and Copilot CLI (from a docs search index), and transcripts in a public repo are publicly visible. — [entireio/cli](https://github.com/entireio/cli)
- git-ai: per-edit checkpoints in `.git/ai/` become an "Authorship Log" attached as a git note under `refs/notes/ai`. It links each AI-written line to the agent, model and prompts, with pointers to a local, cloud or self-hosted transcript store. It supports Claude Code, Codex, Cursor, Copilot and OpenCode. — [git-ai: how it works](https://usegitai.com/docs/how-git-ai-works); [git-ai README](https://raw.githubusercontent.com/git-ai-project/git-ai/main/README.md)
- Agent Trace (from Cursor, draft): a vendor-neutral JSON "trace record" that connects code ranges to conversations and contributors (human, AI, mixed, unknown). Storage is left to implementers. — [cursor/agent-trace](https://github.com/cursor/agent-trace); [InfoQ, Feb 2026](https://www.infoq.com/news/2026/02/agent-trace-cursor). Thoughtworks Radar (April 2026) rated it "Assess" and noted adoption by Cline, OpenCode and Git AI. — [Thoughtworks Radar: Agent Trace](https://www.thoughtworks.com/radar/platforms/agent-trace)
- SpecStory: writes each agent session as Markdown to `./.specstory/history` in the project. A machine-wide index at `~/.specstory/sessions.db` is only a cache, and "native agent files are the source of truth". — [SpecStory CLI reference](https://docs.specstory.com/integrations/terminal-coding-agents/usage); [SpecStory Lore](https://docs.specstory.com/lore)

**Source-grounded output tools (not agent-facing)**
- NotebookLM: "The 'Studio' panel is where outputs based on your sources are generated". Saved notes keep citations, and clicking one jumps to the quote in the source. — [Google support: NotebookLM](https://support.google.com/notebooklm/answer/16206563)
- Simon Willison's `llm` CLI logs prompts and responses to SQLite `logs.db`, with conversation IDs, fragments (by hash) and attachments. — [llm docs: logging](https://llm.datasette.io/en/stable/logging.html) (attachment table details only via a third-party mirror; a schema change landed in 0.32rc1, July 2026: [Simon Willison](https://simonwillison.net/2026/Jul/30/llm-rc1/))

### Inferences
- In hosted artifact stores (Claude artifacts, ChatGPT Library, Manus, the Files API, OpenAI containers), the service knows which session an artifact came from. Claude Code groups "This session", and the Files API returns the file ID in the response that made it. But I found no documented, user-visible link from an artifact to its conversation, and none to the inputs it was built from.
- Output-to-session provenance exists in practice only for code in git: Entire, git-ai, Agent Trace and SpecStory. Inputs appear there only inside the transcript text, not as stored items.
- AgentFS has both halves (files and a tool-call log) in one file but defines no link between them. It shows that "one store" alone does not give provenance.

### Gaps
- I did not verify whether the claude.ai artifact gallery or ChatGPT Library shows a "source conversation" link in the UI. The docs do not mention one.
- I did not fetch Devin's session or artifact docs, the Cursor background-agent artifacts docs, or v0 project history. Their traceability is unverified.
- I did not examine how ChatGPT Canvas stores versions.

---

## 3. Does any of them hold both inputs and outputs in one store, with provenance links between them and to the session?

### Takeaway
No product or project I found does all of it. Seven come partway, each missing at least one part: Graphiti/Zep, Karpathy's LLM-wiki pattern, ChatGPT Library, Manus Projects, Entire, Claude Managed Agents memory stores and NotebookLM. The unverified impression holds once it is narrowed. Tools store memory fragments, store outputs, or link code to sessions. None puts read materials and made things side by side as items, links each made thing to the session and its inputs, and stays a plain, agent-neutral folder.

### Cited Findings
- **Graphiti / Zep: inputs plus derived facts, linked, but no outputs and no plain folder.** Raw episodes are kept "byte-for-byte as ingested", and every edge carries "an `episodes` list holding every episode that contributed to its fact". What the agent produces (documents, code, pages) is not part of the model. Limit: "Deleting an episode does not regenerate the summaries of nodes that other episodes still support." — [Zep blog: provenance](https://www.getzep.com/blog/how-zep-tracks-provenance-in-agent-memory/)
- **Karpathy LLM wiki (gist, 2026-04-04): inputs plus outputs in one folder, a log, a schema file, but provenance only by citation.** Raw sources "are immutable — the LLM reads from them but never modifies them". The wiki is LLM-owned ("The LLM owns this layer entirely"). A schema file (CLAUDE.md or AGENTS.md) defines the rules. `index.md` is a catalog. `log.md` is "an append-only record of what happened and when", with entries like `## [2026-04-02] ingest | Article Title`. "good answers can be filed back into the wiki as new pages". Lint checks for "stale claims that newer sources have superseded". The gist describes no per-page mechanism that links a wiki page to its raw sources, and no session record beyond log lines. — [Karpathy gist: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- **ChatGPT Library: uploaded and generated files in one list, but no documented links.** It offers an "Uploaded or Generated" filter, and files outlive chat deletion. It documents no link from a file to its chat, and none from a generated file to the uploads it used. — [OpenAI help: Library](https://help.openai.com/en/articles/20001052-library-for-chatgpt)
- **Manus Projects / 2.0 sandbox: attachments, artifacts and project files kept together, but no documented links.** — [Manus 2.0 blog](https://www.manus.im/blog/manus-sandbox); [Manus Projects](https://manus.im/features/projects)
- **Entire: output (commit) linked to session (transcript, prompts, tool activity, changed files), stored in the repo's git data.** It is scoped to git and code, and reads are not stored as items. — [Entire docs: checkpoints](https://docs.entire.com/cli/checkpoints)
- **Claude Managed Agents memory stores: each write is versioned and "attributed to the session".** Reads appear in the event stream, but stores hold memory text only, and they are hosted. — [Claude docs: Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)
- **NotebookLM: sources and Studio outputs in one notebook, with citations from outputs to sources.** It is not an agent store and has no session concept. — [Google support: NotebookLM](https://support.google.com/notebooklm/answer/16206563)
- **claude-mem: hooks capture every tool call, including reads, and turn it into observations plus a session summary in SQLite.** Inputs and outputs are stored only as observations, not as the files themselves. — [claude-mem repo](https://github.com/thedotmack/claude-mem)
- **Turso AgentFS: files and a tool-call audit log in one SQLite file, but no link between file rows and tool calls, and no session field in the base spec.** — [AgentFS SPEC.md](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md)

### Inferences
- The impression is **confirmed as narrowed**. "Few" is accurate, and for the full combination it is effectively "none found". These are the separate capabilities and where each already exists:

  | Capability | Who has it |
  | --- | --- |
  | Raw inputs kept, derived items linked to them | Graphiti/Zep, Cognee (third-party claim), NotebookLM (citations) |
  | Inputs and outputs listed side by side | ChatGPT Library, Manus, AI Manus Library (clone), LLM-wiki folder convention |
  | Output linked to the session that made it | Entire, git-ai, Agent Trace, SpecStory (transcript per session), Managed Agents memory versions |
  | Append-only log of what happened | LLM-wiki `log.md`, AgentFS `tool_calls`, OpenClaw daily memory files, Managed Agents versions |
  | Plain folder, readable without the software | Claude Code auto memory, Letta MemFS (git), Basic Memory, OpenClaw, SpecStory, LLM wiki |
  | Works across agent products | Basic Memory and OpenMemory (MCP), claude-mem and agent-memory (hooks), git-ai, Entire, AGENTS.md / Agent Skills (instructions only) |

- No row's members cover every other row. Session provenance in particular appears only in hosted APIs (Managed Agents) or in git-bound coding tools (Entire, git-ai). None of them treats "materials the agent read" as stored items.
- The one convention closest to the target shape is the LLM-wiki pattern: raw, derived and log in a self-described folder that any agent can use. But it has no machine-readable provenance and no session cards. It relies on the LLM to cite and to log.

### Gaps
- I did not check Devin, Factory, Replit Agent, v0 or Cursor background agents for a combined input and output store. My sources did not cover them in depth.
- I did not check academic or "personal data store" projects (e.g. Solid pods, PROV-based tools) that might pair W3C PROV with agent workspaces. That was outside the search budget.

---

## 4. Which are a plain folder that works across different agents with no server? How do AGENTS.md, Agent Skills, the LLM-wiki pattern and Obsidian vaults handle this?

### Takeaway
Cross-agent, serverless folder conventions exist only for instructions and capabilities (AGENTS.md, Agent Skills), plus community patterns such as the LLM wiki and Obsidian vaults that hold content. Basic Memory is the most complete serverless Markdown memory, but it needs a local MCP process for agent access. None of these conventions defines how to record provenance or sessions.

### Cited Findings
- **AGENTS.md:** a founding project of the Agentic AI Foundation, announced 2025-12-09 under the Linux Foundation alongside MCP and goose. The foundation says it was "adopted by more than 60,000 open source projects and agent frameworks including Amp, Codex, Cursor, Devin, Factory, Gemini CLI, GitHub Copilot, Jules and VS Code" (self-reported). — [Linux Foundation press release](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- Claude Code reads `AGENTS.md` directly (v2.1.277+) when there is no CLAUDE.md in the working directory or above it. It discovers every `AGENTS.md` "in your working directory and the directories above it" at session start, and subdirectory ones when it reads files there. — [Claude Code docs: memory, AGENTS.md section](https://code.claude.com/docs/en/memory)
- **Agent Skills:** an open standard that began at Anthropic (around December 18, 2025, per secondary sources) and was later donated to AAIF with the agentskills.io domain. Anthropic reports 1 million skills published and nearly 280 million installs. — [Anthropic: donating Agent Skills to AAIF](https://www.anthropic.com/news/donating-agent-skills-to-the-agentic-ai-foundation); [Simon Willison, 2025-12-19](https://simonwillison.net/2025/Dec/19/agent-skills)
- Codex supports the standard. A skill is a folder whose `SKILL.md` must include a name and description. Codex starts with each skill's name, description and path, and loads the full text only when it uses the skill. Skills are read from `~/.codex/skills/` (personal) and `.codex/skills/` (project). — [OpenAI Codex docs: skills](https://developers.openai.com/codex/skills)
- **LLM wiki:** raw, wiki and a schema file (CLAUDE.md or AGENTS.md) in one folder. It names Claude Code, OpenAI Codex and OpenCode/Pi as agents. "Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase." Tools mentioned are Obsidian Web Clipper and `qmd` (local hybrid BM25/vector search over Markdown). — [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- **Obsidian-vault-as-memory setups (tutorial level, unverified):** open the agent inside the vault folder, put a root-level context file that the agent reads each session, keep a memory directory, and add slash commands such as `/log` (capture) and `/context` (recall). Templates include vinipx/brain and obsidian-second-brain (described as an LLM-wiki evolution). — [MindStudio guide](https://www.mindstudio.ai/blog/build-ai-second-brain-claude-code-obsidian); [vinipx/brain](https://github.com/vinipx/brain); [obsidian-second-brain SKILL.md](https://raw.githubusercontent.com/eugeniughelbur/obsidian-second-brain/main/SKILL.md)
- **Basic Memory:** local Markdown plus a SQLite index, with MCP for Claude Desktop, Cursor, Codex CLI and VS Code. The same folder works in Obsidian. — [Basic Memory README](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md)
- **OpenClaw workspace:** a plain Markdown folder (SOUL.md, USER.md, MEMORY.md, `memory/` daily notes) that serves as the agent's own home. It belongs to one agent runtime, OpenClaw (and NVIDIA's NemoClaw wrapper). — [OpenClaw docs](https://docs.openclaw.ai/concepts/agent-workspace)
- **SpecStory:** `.specstory/history/*.md` per project, written for several agents, with the index only as a cache. — [SpecStory docs](https://docs.specstory.com/integrations/terminal-coding-agents/usage)
- **Letta MemFS:** a local git repo of Markdown with frontmatter, usable without a Letta remote in local mode. Its conventions (`system/`) are Letta-specific. — [Letta docs: MemFS](https://docs.letta.com/letta-code/memfs)

### Inferences
- The serverless, cross-agent layer that exists today is "instructions and skills in Markdown, found by walking up from the working directory". Content stores ride on it by convention: the LLM wiki and Obsidian vaults put a schema file at the root.
- No convention covers item types, provenance, session records or "possibly stale" flags. The LLM wiki's `log.md` and lint step are the closest community practice.
- Claude Code auto memory and Codex memories are plain folders, but they are product-private: they live under each product's home directory and are not meant for another agent.

### Gaps
- I did not verify whether Codex reads a global `~/.codex/AGENTS.md` that could point to an outside store. I believe it does from earlier knowledge, but this is unverified here.
- I did not verify the agentskills.io specification text directly. Facts come from the Codex docs and Anthropic's announcement.

---

## 5. How does a second agent, in another directory or another product, discover that the store exists?

### Takeaway
Discovery is almost always one of four mechanisms: (1) a path tied to the working directory or git repo, (2) a per-product home directory, (3) per-client configuration (MCP server entries, hooks, skill directories), or (4) a hosted account list. None of them lets a different agent product in a different directory find a store with zero setup. A user-level instruction or skill file that names the store, or MCP configured in each client, is the usual bridge.

### Cited Findings
- Claude Code auto memory is keyed to the git repo: "all worktrees and subdirectories within the same repo share one auto memory directory". A different repo gets a different memory. `autoMemoryDirectory` or `CLAUDE_CODE_PROJECT_DIR_NAME` can point several projects at one directory. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Codex memories live under `CODEX_HOME` and are injected when `memories.use_memories` is on. They are Codex-only. — [OpenAI docs: Memories](https://learn.chatgpt.com/docs/customization/memories?surface=app); [Vaughan deep dive](https://codex.danielvaughan.com/2026/04/18/codex-built-in-memory-system-deep-dive/)
- Claude memory tool: the API adds "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE". Continuity happens only "when it sends the same `tools` entry and your handler serves the same store". — [Claude API docs: memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Managed Agents: stores are attached at session creation, and "a note describing each mount is automatically added to the system prompt, telling the agent where to look". — [Claude docs: Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)
- Letta: the memory filetree is always in the system prompt, and `system/` files are always loaded. — [Letta blog](https://www.letta.com/blog/context-repositories)
- claude-mem: hooks inject "a compact index of project-relevant observations" at session start. "Memory injection begins in the second session in a project." Some clients (Copilot CLI, Goose, Roo Code, Warp, Zed) can search but are not recorded. — [claude-mem repo](https://github.com/thedotmack/claude-mem)
- MCP-based stores (Basic Memory, OpenMemory, MCP memory server): each client has to be configured with the server (e.g. `uvx basic-memory mcp`). — [Basic Memory README](https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md); [OpenMemory blog](https://mem0.ai/blog/how-to-make-your-clients-more-context-aware-with-openmemory-mcp)
- Agent Skills: name and description are preloaded from user and project skill directories. — [Codex docs: skills](https://developers.openai.com/codex/skills)
- OpenClaw: the workspace path comes from config (`agents.defaults.workspace`). AGENTS.md tells the agent to read SOUL.md, USER.md and today's and yesterday's memory files. — [OpenClaw docs](https://docs.openclaw.ai/concepts/agent-workspace)
- Entire: past sessions are found in-repo through list, inspect, search and resume commands, or on entire.com, with `entire blame` for line authorship. — [Entire docs: checkpoints](https://docs.entire.com/cli/checkpoints)
- SpecStory: per-project `.specstory/history`, plus a machine-wide `~/.specstory/sessions.db` index. — [SpecStory docs](https://docs.specstory.com/integrations/terminal-coding-agents/usage)
- Claude Code artifacts: `/artifacts` reads the list from the claude.ai account, so a new session can list old artifacts. But it updates one only if given the URL or if the user attaches it. — [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts)
- ChatGPT Library: the "Add from library" composer action. — [OpenAI help: Library](https://help.openai.com/en/articles/20001052-library-for-chatgpt)
- LLM wiki and Obsidian vaults: the agent must be started in the folder, or pointed to it, to read the root schema file. — [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

### Inferences
- For a store that lives outside the project directory, nothing in the ecosystem announces itself to an arbitrary agent. The working options are: user-level instruction files, user-level skills, MCP configured in each client, or hooks installed in each client. claude-mem and agent-memory show that hook installation across 3 to 15 agents is practical but has to be done per product.
- A store that wants cross-agent discovery without a server would most likely use the instruction and skill layer (AGENTS.md or CLAUDE.md, plus a SKILL.md that points to the folder), because that is the one layer most agents already read.

### Gaps
- I did not test any discovery path end to end with a second product. All statements come from docs.

---

## 6. What failure modes do users report?

### Takeaway
The reported problems are: stale or contradictory memories that the agent acts on with confidence; memories with no visible source; auto-memory features that vendors removed or that need periodic "dreaming" or cleanup; markdown memory that drifts across tools and must be synced by hand; agents that forget to update logs after context compaction; and outputs or chats that still exist but cannot be found. Provenance gaps are named mostly by builders and reviewers (Zep, mem0 reviews, Agent Trace), less often by end users.

### Cited Findings
- **Markdown memory drifts across tools.** One commenter said markdown "becomes a coordination mechanism you have to keep in sync manually", and raised deciding "which docs are authoritative" and "which tickets are still valid". Another reported the model "may forget to update the log" once the context passes about half full. A third said skills "may or may not forget after context compaction". Another reported about 15k tokens spent on CLAUDE.md plus rules. Others asked for benchmarks showing the tools help. — [HN: Show HN: Stop Claude Code from forgetting everything (Ensue)](https://news.ycombinator.com/item?id=46426624)
- **Stale or contradictory memory.** One practitioner write-up reports that, after a correction, an agent "sometimes updated the memory block, sometimes wrote a second entry that contradicted the first, and once helpfully 'consolidated' both into a summary that kept the wrong one". It also says a stale memory produces "a confident wrong action" where no memory would produce a question. — quoted via search snippet; attributed to [HackerNoon: the most dangerous memory in an AI agent is the one that used to be true](https://hackernoon.com/the-most-dangerous-memory-in-an-ai-agent-is-the-one-that-used-to-be-true) (attribution not confirmed by fetch; a related account is at [dev.to kenimo49](https://dev.to/kenimo49/i-gave-my-agent-persistent-memory-it-remembered-the-wrong-3-things-for-a-week-50c9))
- **Claude Code auto memory buildup.** "outdated or conflicting information" accumulates, and Anthropic was reported to be testing an "auto dream" pass that merges overlapping entries and removes outdated ones. — [Tessl: Anthropic tests auto dream](https://tessl.io/blog/anthropic-tests-auto-dream-to-clean-up-claudes-memory/)
- **Vendors stepping back from auto memory.** Cursor removed Memories in 2.1.x and told users to export them to Rules. One user found the agent still used 32 memories after the UI disappeared, with no way to manage them. — [Cursor forum](https://forum.cursor.com/t/are-my-memories-gone/144057). Devin and Codex both tell users to put durable guidance in Rules or AGENTS.md instead of auto memory. — [Devin docs](https://docs.devin.ai/desktop/cascade/memories.md); [OpenAI docs: Memories](https://learn.chatgpt.com/docs/customization/memories?surface=app)
- **No source for a memory.** Codex memories have no documented back-link to the source thread, and the files are "generated state". — [OpenAI docs: Memories](https://learn.chatgpt.com/docs/customization/memories?surface=app). A reviewer describes mem0's trace-to-fact provenance as weak. — [Commonplace review of mem0](https://zby.github.io/commonplace/agent-memory-systems/reviews/mem0/)
- **Provenance gaps even where links exist.** Graphiti does not regenerate summaries after a source episode is deleted, and erasure workflows must be built separately. — [Zep blog](https://www.getzep.com/blog/how-zep-tracks-provenance-in-agent-memory/). Agent Trace exists because "git blame" cannot tell human, AI or mixed changes apart, and the spec leaves merges and rebases unresolved. — [InfoQ](https://www.infoq.com/news/2026/02/agent-trace-cursor)
- **Memory poisoning.** A prompt injection can write malicious content into a read-write store, and "Later sessions then read that content as trusted memory." — [Claude docs: Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory)
- **Lost or unfindable outputs.** Code Interpreter files can be created without a citation, and containers expire (forum reports). — [OpenAI community](https://community.openai.com/t/responses-api-code-interpreter-with-gpt-4-1-sometimes-creates-mnt-data-docx-but-returns-no-container-file-citation/1397663); [OpenAI community](https://community.openai.com/t/reliably-retrieving-code-interpreter-files-from-the-container/1288268). Claude Code creates a new artifact in a new session unless given the old URL. — [Claude Code docs: artifacts](https://code.claude.com/docs/en/artifacts). Manus does not restore intermediate files to a new sandbox. — [Manus 2.0 blog](https://www.manus.im/blog/manus-sandbox)
- **Old sessions are hard to find.** Users report that searching old ChatGPT conversations "becomes impossible at scale". — [OpenAI community thread](https://community.openai.com/t/why-searching-old-chatgpt-conversations-becomes-impossible-at-scale/1385213). A vendor blog says native history search on major chat apps matches titles, not message text, and that most "lost" chats still exist but cannot be found. — [LLMnesia blog](https://www.llmnesia.com/blog/why-cant-i-find-my-old-ai-conversations) (vendor source)
- **Transcripts outlive or underlive memory.** Claude Code deletes old transcripts after `cleanupPeriodDays` but keeps memory files. A memory can therefore outlive the session it came from, and no back-reference remains. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- **Privacy concerns with session provenance in git.** Entire transcripts in a public repo are visible to anyone. — [entireio/cli](https://github.com/entireio/cli). On HN, users asked that memory be local ("It just has to be local"). — [HN Ensue thread](https://news.ycombinator.com/item?id=46426624)

### Inferences
- The most common user complaints (staleness, contradiction, drift across tools, unfindable outputs) all trace back to a missing link between an item and where and when it came from. That supports the premise of a store whose core job is to record origin and flag "possibly stale" deterministically.
- Several vendors have moved durable knowledge from model-written memory to human-reviewed files (Cursor Rules, Devin Rules, Codex's AGENTS.md advice). This suggests users trust plain, inspectable files more than opaque auto memory.

### Gaps
- I found few primary HN threads about lost artifacts specifically. Most "lost output" evidence comes from vendor forums and docs, not user surveys.
- I could not fetch the original STALE benchmark paper mentioned in secondary write-ups, so I do not cite it.
