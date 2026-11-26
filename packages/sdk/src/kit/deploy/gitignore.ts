// What a bundle's `.gitignore` files leave out of its content, read as storage reads them (the
// `ignore` crate's gitignore rules): the nearest ignore file that has a say about a path decides, the
// last of its lines that matches wins, and a directory it leaves out is not entered. Where this and
// storage disagree, a publish finds it: the files copied out do not make the fingerprint storage gives.

/** One line of an ignore file. */
type Rule = { re: RegExp; keep: boolean; dirOnly: boolean }

/** The rules of one ignore file, and the directory it is in, relative to the bundle ('' for its top). */
export type IgnoreLevel = { base: string; rules: readonly Rule[] }

/** A character matched as itself. */
const lit = (c: string) => (/[\^$\\.*+?()[\]{}|/]/u.test(c) ? `\\${c}` : c)

/** A glob of a gitignore line as a regular expression over a whole relative path; null for one storage would not take. */
function globRegex(glob: string): RegExp | null {
  let re = ''
  let alternates = false
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*' && (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/')) {
      if (i + 2 === glob.length) re += '.*'
      else {
        re += '(?:.*/)?'
        i++
      }
      i++
    } else if (c === '*') {
      re += '[^/]*'
      if (glob[i + 1] === '*') i++
    } else if (c === '?') re += '[^/]'
    else if (c === '\\') {
      const next = glob[++i]
      if (next === undefined) return null
      re += lit(next)
    } else if (c === '[') {
      const close = glob.indexOf(']', i + (glob[i + 1] === '!' || glob[i + 1] === '^' ? 3 : 2))
      if (close === -1) return null
      const inner = glob.slice(i + 1, close).replace(/^[!^]/u, '^').replaceAll('\\', '\\\\')
      re += `[${inner}]`
      i = close
    } else if (c === '{' && !alternates) {
      alternates = true
      re += '(?:'
    } else if (c === ',' && alternates) re += '|'
    else if (c === '}' && alternates) {
      alternates = false
      re += ')'
    } else re += lit(c)
  }
  if (alternates) return null
  try {
    return new RegExp(`^${re}$`, 'u')
  } catch {
    return null
  }
}

/** One line as a rule, or null for a blank line, a comment, or a glob storage would not take. */
function ruleOf(raw: string): Rule | null {
  if (raw.startsWith('#')) return null
  let line = raw.endsWith('\\ ') ? raw : raw.trimEnd()
  if (line === '') return null
  let keep = false
  let anchored = false
  if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1)
    anchored = line.startsWith('/')
  } else {
    if (line.startsWith('!')) {
      keep = true
      line = line.slice(1)
    }
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
  }
  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
    if (line.endsWith('\\')) line = line.slice(0, -1)
  }
  let glob = line
  if (!anchored && !line.includes('/') && !line.startsWith('**/')) glob = `**/${glob}`
  if (glob.endsWith('/**')) glob = `${glob}/*`
  const re = globRegex(glob)
  return re === null ? null : { re, keep, dirOnly }
}

/** The rules of an ignore file's text. */
export function ignoreRules(text: string): Rule[] {
  return text.split(/\r?\n/u).flatMap((line) => ruleOf(line) ?? [])
}

/** Whether the ignore files in effect leave out `path` (relative to the bundle), nearest file first. */
export function ignored(levels: readonly IgnoreLevel[], path: string, isDir: boolean): boolean {
  for (let l = levels.length - 1; l >= 0; l--) {
    const { base, rules } = levels[l] as IgnoreLevel
    const relative = base === '' ? path : path.slice(base.length + 1)
    for (let r = rules.length - 1; r >= 0; r--) {
      const rule = rules[r] as Rule
      if ((!rule.dirOnly || isDir) && rule.re.test(relative)) return !rule.keep
    }
  }
  return false
}
