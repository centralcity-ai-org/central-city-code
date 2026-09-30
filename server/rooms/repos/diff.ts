import { safeRepoPath } from './contract.js';

/**
 * Unified diff parsing and exact application for room proposals (docs/ROOM_REPOS.md "Proposals").
 *
 * Pure TypeScript: no git binary and no code execution. The diff text is untrusted, so parsing
 * is strict and bounded:
 * - paths are repository-relative, without traversal, never under `.github/workflows/` and never
 *   inside a `.git` directory;
 * - renames, copies, mode changes, symlinks, submodules and binary patches are refused;
 * - hunks apply **exactly** at their stated line numbers (no fuzz, no offset search), so "applies
 *   cleanly to the base" means the same thing as `git apply` without fuzz on that base.
 */
export const DIFF_LIMITS = {
  bytes: 262_144,
  files: 50,
  hunksPerFile: 500,
} as const;

export class DiffError extends Error {
  constructor(
    public code:
      | 'diff_invalid'
      | 'diff_too_large'
      | 'diff_path_invalid'
      | 'workflow_files_not_allowed'
      | 'diff_unsupported'
      | 'diff_does_not_apply',
    message: string,
    public path?: string,
  ) {
    super(message);
  }
}

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
  /** Followed by "\ No newline at end of file". */
  noNewline: boolean;
}
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
export interface FilePatch {
  path: string;
  kind: 'modify' | 'add' | 'delete';
  /** '100644' or '100755' for added files; null otherwise (the existing mode is kept). */
  mode: '100644' | '100755' | null;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A path from a `---`/`+++`/`diff --git` line, with the `a/`/`b/` prefix removed. */
function cleanPath(raw: string, prefix: 'a/' | 'b/'): string | null {
  let value = raw.replace(/\t.*$/, '');
  if (value === '/dev/null') return null;
  if (value.startsWith('"'))
    throw new DiffError('diff_path_invalid', 'Quoted paths are not supported.');
  if (value.startsWith(prefix)) value = value.slice(2);
  return value;
}

export function checkPath(path: string): void {
  if (!path || !safeRepoPath(path))
    throw new DiffError(
      'diff_path_invalid',
      'Paths must be repository-relative, without . or .. segments.',
      path,
    );
  const segments = path.split('/');
  if (segments.some((part) => part.toLowerCase() === '.git'))
    throw new DiffError('diff_path_invalid', 'Paths inside .git are not allowed.', path);
  if (path.toLowerCase().startsWith('.github/workflows/'))
    throw new DiffError(
      'workflow_files_not_allowed',
      'Changes to .github/workflows/ cannot be proposed through a room.',
      path,
    );
}

/** Parses a unified diff (git-style or plain). Throws `DiffError` on anything unsupported. */
export function parseDiff(text: string): FilePatch[] {
  if (Buffer.byteLength(text) > DIFF_LIMITS.bytes)
    throw new DiffError('diff_too_large', `A diff is at most ${DIFF_LIMITS.bytes} bytes.`);
  if (text.includes('\0'))
    throw new DiffError('diff_unsupported', 'Binary patches are not supported.');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: FilePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith('diff --git ') && !line.startsWith('--- ')) {
      // Preamble (commit message, `index`, etc.) outside a file section is ignored.
      i++;
      continue;
    }
    // Extended git headers before ---/+++.
    let mode: FilePatch['mode'] = null;
    let isNew = false;
    let isDelete = false;
    let gitPaths: [string, string] | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m)
        throw new DiffError(
          'diff_path_invalid',
          'Unsupported diff --git header (paths with spaces?).',
        );
      gitPaths = [m[1]!, m[2]!];
      i++;
      while (
        i < lines.length &&
        !lines[i]!.startsWith('--- ') &&
        !lines[i]!.startsWith('diff --git ')
      ) {
        const header = lines[i]!;
        if (/^(rename|copy) (from|to) /.test(header) || header.startsWith('similarity index'))
          throw new DiffError(
            'diff_unsupported',
            'Renames and copies are not supported; delete and add instead.',
          );
        if (header.startsWith('old mode') || header.startsWith('new mode'))
          throw new DiffError('diff_unsupported', 'Mode changes are not supported.');
        if (header.startsWith('Binary files') || header.startsWith('GIT binary patch'))
          throw new DiffError('diff_unsupported', 'Binary patches are not supported.');
        const created = /^new file mode (\d+)$/.exec(header);
        if (created) {
          if (created[1] !== '100644' && created[1] !== '100755')
            throw new DiffError('diff_unsupported', 'Symlinks and submodules are not supported.');
          isNew = true;
          mode = created[1] as '100644' | '100755';
        }
        const deleted = /^deleted file mode (\d+)$/.exec(header);
        if (deleted) {
          if (deleted[1] !== '100644' && deleted[1] !== '100755')
            throw new DiffError('diff_unsupported', 'Symlinks and submodules are not supported.');
          isDelete = true;
        }
        const index = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d+))?$/.exec(header);
        if (index?.[1] && index[1] !== '100644' && index[1] !== '100755')
          throw new DiffError('diff_unsupported', 'Symlinks and submodules are not supported.');
        i++;
      }
      if (i >= lines.length || lines[i]!.startsWith('diff --git '))
        throw new DiffError(
          'diff_unsupported',
          'A file section without content changes is not supported.',
        );
    }
    const oldLine = lines[i]!;
    const newLine = lines[i + 1];
    if (!oldLine.startsWith('--- ') || !newLine?.startsWith('+++ '))
      throw new DiffError('diff_invalid', 'Expected ---/+++ file headers.');
    const oldPath = cleanPath(oldLine.slice(4), 'a/');
    const newPath = cleanPath(newLine.slice(4), 'b/');
    i += 2;
    if (oldPath === null && newPath === null)
      throw new DiffError('diff_invalid', 'Both paths are /dev/null.');
    if (oldPath !== null && newPath !== null && oldPath !== newPath)
      throw new DiffError('diff_unsupported', 'Renames are not supported; delete and add instead.');
    const path = (newPath ?? oldPath)!;
    checkPath(path);
    if (gitPaths && (gitPaths[0] !== path || gitPaths[1] !== path))
      throw new DiffError(
        'diff_invalid',
        'The diff --git header does not match the file headers.',
        path,
      );
    const kind: FilePatch['kind'] =
      oldPath === null ? 'add' : newPath === null ? 'delete' : 'modify';
    if ((kind === 'add') !== isNew && gitPaths)
      throw new DiffError('diff_invalid', 'A new file needs "new file mode" and /dev/null.', path);
    if ((kind === 'delete') !== isDelete && gitPaths)
      throw new DiffError(
        'diff_invalid',
        'A deleted file needs "deleted file mode" and /dev/null.',
        path,
      );
    const hunks: Hunk[] = [];
    let additions = 0;
    let deletions = 0;
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = HUNK.exec(lines[i]!);
      if (!m) throw new DiffError('diff_invalid', 'Malformed hunk header.', path);
      const hunk: Hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      i++;
      let oldSeen = 0;
      let newSeen = 0;
      while (i < lines.length && (oldSeen < hunk.oldLines || newSeen < hunk.newLines)) {
        const body = lines[i]!;
        const op = body[0];
        if (op !== ' ' && op !== '-' && op !== '+') {
          // An empty line inside a hunk is a context line whose leading space was stripped.
          if (body === '') {
            hunk.lines.push({ op: ' ', text: '', noNewline: false });
            oldSeen++;
            newSeen++;
            i++;
            continue;
          }
          throw new DiffError('diff_invalid', 'A hunk is shorter than its header says.', path);
        }
        hunk.lines.push({ op, text: body.slice(1), noNewline: false });
        if (op !== '+') oldSeen++;
        if (op !== '-') newSeen++;
        if (op === '+') additions++;
        if (op === '-') deletions++;
        i++;
        if (lines[i]?.startsWith('\\ ')) {
          hunk.lines.at(-1)!.noNewline = true;
          i++;
        }
      }
      if (oldSeen !== hunk.oldLines || newSeen !== hunk.newLines)
        throw new DiffError('diff_invalid', 'A hunk does not match its line counts.', path);
      hunks.push(hunk);
      if (hunks.length > DIFF_LIMITS.hunksPerFile)
        throw new DiffError('diff_too_large', 'Too many hunks in one file.', path);
    }
    if (!hunks.length) throw new DiffError('diff_invalid', 'A file section has no hunks.', path);
    if (files.some((file) => file.path === path))
      throw new DiffError('diff_invalid', 'A file appears twice in the diff.', path);
    files.push({
      path,
      kind,
      mode: kind === 'add' ? (mode ?? '100644') : null,
      hunks,
      additions,
      deletions,
    });
    if (files.length > DIFF_LIMITS.files)
      throw new DiffError('diff_too_large', `A diff touches at most ${DIFF_LIMITS.files} files.`);
  }
  if (!files.length) throw new DiffError('diff_invalid', 'No file changes found in the diff.');
  return files;
}

/**
 * Applies one file patch exactly to `original` (null when the file does not exist).
 * Returns the new content, or null for a deleted file. Throws `diff_does_not_apply` when any
 * context or removed line differs from the base at its stated position.
 */
export function applyFilePatch(original: string | null, patch: FilePatch): string | null {
  const fail = (why: string): never => {
    throw new DiffError(
      'diff_does_not_apply',
      `The diff does not apply to the base: ${why}.`,
      patch.path,
    );
  };
  if (patch.kind === 'add' && original !== null) fail('the file already exists');
  if (patch.kind !== 'add' && original === null) fail('the file does not exist');
  const source = original ?? '';
  const endsWithNewline = source === '' || source.endsWith('\n');
  const oldLines =
    source === '' ? [] : (endsWithNewline ? source.slice(0, -1) : source).split('\n');
  const out: string[] = [];
  let cursor = 0; // index into oldLines
  let newEndsWithNewline = endsWithNewline;
  let lastHunkReachesEnd = false;
  for (const hunk of patch.hunks) {
    // For an empty old range, oldStart is the line after which the new lines go.
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > oldLines.length)
      fail(`hunk at line ${hunk.oldStart} is out of order or range`);
    for (let k = cursor; k < start; k++) out.push(oldLines[k]!);
    let at = start;
    let lastNew: DiffLine | undefined;
    let lastOld: DiffLine | undefined;
    for (const line of hunk.lines) {
      if (line.op !== '+') {
        if (at >= oldLines.length || oldLines[at] !== line.text) fail(`line ${at + 1} differs`);
        at++;
        lastOld = line;
      }
      if (line.op !== '-') {
        out.push(line.text);
        lastNew = line;
      }
    }
    if (lastOld?.noNewline && (at !== oldLines.length || endsWithNewline))
      fail('the end-of-file newline differs');
    if (
      !lastOld?.noNewline &&
      lastOld &&
      at === oldLines.length &&
      !endsWithNewline &&
      oldLines.length
    )
      fail('the end-of-file newline differs');
    cursor = at;
    lastHunkReachesEnd = at === oldLines.length;
    if (lastHunkReachesEnd) newEndsWithNewline = !(lastNew?.noNewline ?? false);
  }
  for (let k = cursor; k < oldLines.length; k++) out.push(oldLines[k]!);
  if (patch.kind === 'delete') {
    if (out.length) fail('a deletion must remove every line');
    return null;
  }
  if (!out.length) return '';
  if (!lastHunkReachesEnd && cursor < oldLines.length) newEndsWithNewline = endsWithNewline;
  return out.join('\n') + (newEndsWithNewline ? '\n' : '');
}
