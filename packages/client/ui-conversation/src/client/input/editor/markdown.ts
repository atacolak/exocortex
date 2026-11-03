/** Inline Markdown translation shared by the composer projection and restore path. */
import { IS_BOLD, IS_CODE, IS_ITALIC } from 'lexical'

/** One inline run recovered from Markdown, in Lexical format-bit terms. */
export interface MarkdownRun {
  readonly text: string
  readonly format: number
}

/**
 * Serialize one formatted text leaf as Markdown. Surrounding whitespace stays
 * outside the delimiters because emphasis may not open or close on a space.
 * @param text - the leaf's exact text.
 * @param format - the leaf's Lexical format bits.
 * @returns clipboard text carrying the same inline style.
 */
export function inlineMarkdown(text: string, format: number): string {
  if (text === '') return text
  const emphasisFormat = format & (IS_BOLD | IS_ITALIC)
  if (emphasisFormat === 0 && (format & IS_CODE) === 0) return text
  const leading = /^\s*/u.exec(text)?.[0] ?? ''
  const trailing = /\s*$/u.exec(text.slice(leading.length))?.[0] ?? ''
  const core = text.slice(leading.length, text.length - trailing.length)
  if (core === '') return text
  let rendered = (format & IS_CODE) !== 0
    ? wrap(codeSpan(core), emphasisFormat)
    : emphasis(core, emphasisFormat)
  rendered = `${leading}${rendered}${trailing}`
  return rendered
}

/** Wrap text in emphasis delimiters, escaping emphasis markers first. */
function emphasis(text: string, format: number): string {
  return wrap(escapeEmphasis(text), format)
}

/** Add emphasis delimiters around an already-safe body. */
function wrap(text: string, format: number): string {
  const bold = (format & IS_BOLD) !== 0
  const italic = (format & IS_ITALIC) !== 0
  if (bold && italic) return `***${text}***`
  if (bold) return `**${text}**`
  if (italic) return `*${text}*`
  return text
}

/** Escape the characters that would otherwise open Markdown emphasis or code spans. */
function escapeEmphasis(text: string): string {
  return text.replace(/[\\*`]/gu, match => `\\${match}`)
}

/** Wrap text in a code span whose fence is longer than any backtick run it contains. */
function codeSpan(text: string): string {
  let fenceLength = 1
  for (const match of text.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
  const fence = '`'.repeat(fenceLength)
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ')) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * Parse the inline Markdown subset this composer emits. Unmatched markers and
 * backslash escapes stay literal.
 * @param text - one line of clipboard text.
 * @returns styled runs in source order.
 */
export function parseInlineMarkdown(text: string): MarkdownRun[] {
  const runs: MarkdownRun[] = []
  let plain = ''
  let index = 0
  const flush = (): void => {
    if (plain === '') return
    runs.push({ text: plain, format: 0 })
    plain = ''
  }
  const push = (value: string, format: number): void => {
    flush()
    runs.push({ text: value, format })
  }
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '\\' && index + 1 < text.length && '\\*`'.includes(text[index + 1] ?? '')) {
      plain += text[index + 1] ?? ''
      index += 2
      continue
    }
    if (char === '`') {
      const span = closingCodeSpan(text, index)
      if (span !== null) {
        push(span.content, IS_CODE)
        index = span.end
        continue
      }
    }
    if (char === '*') {
      const span = closingEmphasis(text, index)
      if (span !== null) {
        for (const run of parseInlineMarkdown(span.content)) push(run.text, run.format | span.format)
        index = span.end
        continue
      }
    }
    plain += char
    index += 1
  }
  flush()
  return runs
}

/** Match a `***`, `**`, or `*` emphasis span opened at `start`. */
function closingEmphasis(text: string, start: number): { content: string; format: number; end: number } | null {
  for (const width of [3, 2, 1] as const) {
    const marker = '*'.repeat(width)
    if (!text.startsWith(marker, start)) continue
    const close = text.indexOf(marker, start + width)
    if (close <= start + width) continue
    const format = width === 3 ? IS_BOLD | IS_ITALIC : width === 2 ? IS_BOLD : IS_ITALIC
    return { content: text.slice(start + width, close), format, end: close + width }
  }
  return null
}

/** Match one backtick run and its same-length closing run. */
function closingCodeSpan(text: string, start: number): { content: string; end: number } | null {
  let width = 0
  while (text[start + width] === '`') width += 1
  const marker = '`'.repeat(width)
  const close = text.indexOf(marker, start + width)
  if (close < 0) return null
  let content = text.slice(start + width, close)
  if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1)
  return { content, end: close + width }
}
