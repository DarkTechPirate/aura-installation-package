# Agent Workspace

The AURA agent has a personal sandbox at `~/.aura/workspace/`. It can freely read, write, and organise files within this directory. Access to anything outside the workspace boundary is blocked at the security layer — no path traversal, no elevated permissions, no shell execution.

---

## Directory layout

```
~/.aura/
├── config.yaml
├── agents.yaml
├── skills/
├── memory/
└── workspace/          ← agent's private sandbox (created on first startup)
    ├── notes/
    ├── drafts/
    └── (anything the agent creates)
```

The workspace directory is created automatically when the gateway starts. You never need to create it manually.

---

## Enabling the skill

Add `filesystem` to the `skills` list for any agent in `~/.aura/agents.yaml`:

```yaml
agents:
  - id: personal
    name: "AURA"
    skills:
      - web_search
      - reminders
      - filesystem       # ← add this
    llm_tier: simple
    memory_ns: personal
```

---

## Tools

### `workspace_read`

Read the text content of a file inside the workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Relative path from workspace root (e.g. `"notes/todo.md"`) |

**Returns:** `{ content: string, size: number }`

**Example prompt:** *"Read my todo list from notes/todo.md"*

---

### `workspace_write`

Write (or append) text to a file. Parent directories are created automatically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Relative path to write to |
| `content` | string | yes | Text content |
| `append` | boolean | no | If `true`, append instead of overwrite (default: `false`) |

**Returns:** `{ written: true, path: string }`

**Example prompt:** *"Save a draft of the email to drafts/email.txt"*

---

### `workspace_list`

List files and directories at a path inside the workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | no | Relative path to list (default: `"."` = workspace root) |

**Returns:** `{ entries: Array<{ name: string, type: "file" | "dir", size?: number }> }`

**Example prompt:** *"What files do I have in my workspace?"*

---

### `workspace_delete`

Delete a single file from the workspace. Does not delete directories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Relative path to the file |

**Returns:** `{ deleted: true }`

**Example prompt:** *"Delete the old draft at drafts/old.txt"*

---

### `workspace_mkdir`

Create a directory (and any missing parents) inside the workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Relative path of the directory to create |

**Returns:** `{ created: true, path: string }`

**Example prompt:** *"Create a folder called projects/aura in my workspace"*

---

### `workspace_move`

Move or rename a file or directory within the workspace. Both `from` and `to` must be inside the workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Current relative path |
| `to` | string | yes | New relative path |

**Returns:** `{ moved: true }`

**Example prompt:** *"Rename drafts/v1.txt to drafts/v2.txt"*

---

### `workspace_info`

Get a summary of the workspace: its root path, total number of files, and disk usage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | — | — | — |

**Returns:** `{ workspace_root: string, file_count: number, total_bytes: number }`

**Example prompt:** *"How much is my workspace using?"*

---

## Security model

| Rule | Detail |
|------|--------|
| **Path confinement** | Every path is resolved with `path.resolve()` and checked to start within `~/.aura/workspace/`. Any path that escapes the boundary throws an error. |
| **Path traversal blocked** | Sequences like `../../etc/passwd` resolve outside the workspace and are rejected before any `fs` call. |
| **Null byte blocked** | Paths containing `\0` are rejected immediately. |
| **Max file size** | Read and write operations are capped at **10 MB** per operation. |
| **File permissions** | Files are written with mode `0644`. Directories are created with mode `0755`. No executable bit is ever set. |
| **No shell execution** | The filesystem skill uses only Node.js `fs` module calls — no `exec`, `spawn`, or child processes. |
| **No symlink escapes** | `path.resolve()` follows symlinks, so a symlink pointing outside the workspace will still be caught by the boundary check. |
| **No sudo / elevated access** | The skill runs entirely in the gateway's user process. No privilege escalation is possible. |

---

## Troubleshooting

**`Directory not found: <path>`**
The path you listed doesn't exist yet in the workspace. Use `workspace_mkdir` to create it first.

**`Path traversal blocked`**
The path resolved to a location outside `~/.aura/workspace/`. Use a relative path that stays inside the workspace.

**`File too large`**
The file or content exceeds the 10 MB limit. Split the content into multiple smaller writes.

**Workspace directory missing on startup**
The gateway creates `~/.aura/workspace/` automatically at startup. If it's missing, restarting the gateway will recreate it. You can also create it manually:
```bash
mkdir -p ~/.aura/workspace
```
