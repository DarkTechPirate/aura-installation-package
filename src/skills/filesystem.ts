import fs from 'fs';
import path from 'path';
import os from 'os';

// Self-contained — no imports from gateway source tree so this file works
// both in src/skills/ (dev) and ~/.aura/skills/ (deployed).
const WORKSPACE_DIR = path.join(os.homedir(), '.aura', 'workspace');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function resolveWorkspacePath(inputPath: string, workspaceRoot: string): string {
  if (inputPath.includes('\0')) throw new Error('Invalid path: null bytes are not allowed');
  const resolved  = path.resolve(workspaceRoot, inputPath);
  const normalRoot = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (!resolved.startsWith(normalRoot) && resolved !== workspaceRoot) {
    throw new Error(`Path traversal blocked: "${inputPath}" resolves outside the workspace`);
  }
  return resolved;
}

/**
 * Recursively counts files and sums their sizes under a directory.
 */
function walkDir(dir: string): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkDir(full);
      fileCount += sub.fileCount;
      totalBytes += sub.totalBytes;
    } else if (entry.isFile()) {
      fileCount++;
      totalBytes += fs.statSync(full).size;
    }
  }
  return { fileCount, totalBytes };
}

// ── Tool implementations ───────────────────────────────────────────────────────

export async function workspace_read(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const filePath = resolveWorkspacePath(String(args['path'] ?? ''), WORKSPACE_DIR);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${stat.size} bytes exceeds the ${MAX_FILE_SIZE}-byte limit`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return { content, size: stat.size };
}

export async function workspace_write(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const filePath = resolveWorkspacePath(String(args['path'] ?? ''), WORKSPACE_DIR);
  const content  = String(args['content'] ?? '');
  const append   = args['append'] === true;

  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_FILE_SIZE) {
    throw new Error(`Content too large: ${byteLength} bytes exceeds the ${MAX_FILE_SIZE}-byte limit`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });

  if (append) {
    fs.appendFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  } else {
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  }

  return { written: true, path: path.relative(WORKSPACE_DIR, filePath) };
}

export async function workspace_list(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const inputPath = String(args['path'] ?? '.');
  const dirPath   = resolveWorkspacePath(inputPath, WORKSPACE_DIR);

  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: "${inputPath}". workspace_list only accesses paths inside ~/.aura/workspace/. To list installed skills use the self_config skill or call list_skills. To list workspace root use path "."`);
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map(entry => {
    const result: { name: string; type: 'file' | 'dir'; size?: number } = {
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
    };
    if (entry.isFile()) {
      result.size = fs.statSync(path.join(dirPath, entry.name)).size;
    }
    return result;
  });

  return { entries };
}

export async function workspace_delete(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const filePath = resolveWorkspacePath(String(args['path'] ?? ''), WORKSPACE_DIR);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw new Error('workspace_delete only deletes files. Use workspace_list to inspect directories.');
  }
  fs.unlinkSync(filePath);
  return { deleted: true };
}

export async function workspace_mkdir(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const dirPath = resolveWorkspacePath(String(args['path'] ?? ''), WORKSPACE_DIR);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  return { created: true, path: path.relative(WORKSPACE_DIR, dirPath) };
}

export async function workspace_move(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const fromPath = resolveWorkspacePath(String(args['from'] ?? ''), WORKSPACE_DIR);
  const toPath   = resolveWorkspacePath(String(args['to']   ?? ''), WORKSPACE_DIR);
  fs.mkdirSync(path.dirname(toPath), { recursive: true, mode: 0o755 });
  fs.renameSync(fromPath, toPath);
  return { moved: true };
}

export async function workspace_info(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    return { workspace_root: WORKSPACE_DIR, file_count: 0, total_bytes: 0 };
  }
  const { fileCount, totalBytes } = walkDir(WORKSPACE_DIR);
  return {
    workspace_root: WORKSPACE_DIR,
    file_count:     fileCount,
    total_bytes:    totalBytes,
  };
}
