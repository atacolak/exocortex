/** Inline-format and fenced-code commands over the composer's plain-text runs. */
import type { ElementNode, LexicalNode, TextNode } from 'lexical'
import {
  $createLineBreakNode, $createParagraphNode, $createTextNode, $formatText, $getRoot,
  $getSelection, $isElementNode, $isLineBreakNode, $isRangeSelection, $isTextNode,
  IS_BOLD, IS_CODE, IS_ITALIC,
} from 'lexical'
import { $createCodeNode, $isCodeNode } from '@lexical/code'
import type { CodeNode } from '@lexical/code'

/** The inline formats the composer exposes as keyboard toggles. */
export type InlineFormat = 'bold' | 'italic' | 'code'

const FORMAT_BITS: Readonly<Record<InlineFormat, number>> = {
  bold: IS_BOLD,
  italic: IS_ITALIC,
  code: IS_CODE,
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u

/** Whether the selection anchor sits inside a fenced code block. */
export function $isSelectionInCodeBlock(): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return false
  return $isCodeNode(selection.anchor.getNode().getTopLevelElement())
}

/**
 * Toggle one inline format. A ranged selection formats its text; a collapsed
 * caret strictly inside a word (a word character on each side) formats that
 * whole word in place; every other caret — end of a word, start of one,
 * after whitespace, or an empty line — leaves the draft untouched and arms
 * the format for the characters typed from here.
 * @param type - the format the gesture names.
 */
export function $toggleInlineFormat(type: InlineFormat): void {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || $isSelectionInCodeBlock()) return
  if (!selection.isCollapsed()) {
    $formatText(selection, type)
    return
  }
  const bit = FORMAT_BITS[type]
  const anchor = selection.anchor
  const node = anchor.getNode()
  const word = $isTextNode(node) ? wordSurrounding(node, anchor.offset) : null
  if (word === null) {
    selection.setFormat(selection.format ^ bit)
    return
  }
  const parts = word.node.splitText(word.start, word.end)
  const formatted = parts.length === 3
    ? parts[1]
    : parts.length === 2
      ? (word.start === 0 ? parts[0] : parts[1])
      : parts[0]
  if (formatted === undefined) return
  const format = formatted.getFormat()
  formatted.setFormat((format & bit) === 0 ? format | bit : format ^ bit)
  formatted.select(anchor.offset - word.start, anchor.offset - word.start)
}

/**
 * The word a caret sits strictly inside: the node plus the half-open range
 * of word characters on BOTH sides of the caret. Only that shape means the
 * gesture targets the word; a caret touching a word boundary formats what is
 * typed next instead.
 */
function wordSurrounding(node: TextNode, offset: number): { node: TextNode; start: number; end: number } | null {
  const text = node.getTextContent()
  if (offset <= 0 || offset >= text.length) return null
  if (!WORD_CHARACTER.test(text[offset - 1] ?? '') || !WORD_CHARACTER.test(text[offset] ?? '')) return null
  let start = offset
  let end = offset
  while (start > 0 && WORD_CHARACTER.test(text[start - 1] ?? '')) start -= 1
  while (end < text.length && WORD_CHARACTER.test(text[end] ?? '')) end += 1
  return { node, start, end }
}

/**
 * Toggle a fenced code block: the selected blocks become one code node, or a
 * code node containing the caret becomes paragraphs again.
 */
export function $toggleCodeBlock(): void {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return
  const anchorBlock = selection.anchor.getNode().getTopLevelElement()
  if ($isCodeNode(anchorBlock)) {
    exitCodeBlock(anchorBlock)
    return
  }
  const blocks = selectedBlocks(selection.anchor.getNode(), selection.focus.getNode())
  if (blocks.length === 0) return
  const code = $createCodeNode()
  appendCodeContent(code, blocks.map(block => block.getTextContent()).join('\n'))
  blocks[0]?.replace(code)
  for (const extra of blocks.slice(1)) extra.remove()
  code.selectEnd()
}

/**
 * Escape a fenced block at its first or last line: the caret lands at the
 * matching edge of the neighbouring block, or a fresh empty paragraph is
 * inserted when the block is the document's first or last block.
 * @param direction - the arrow gesture: up = first line, down = last line.
 * @returns whether the caret moved (false leaves it inside the block).
 */
export function $moveCaretOutOfCodeBlock(direction: 'up' | 'down'): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
  const anchor = selection.anchor
  const anchorNode = anchor.getNode()
  if ($isCodeNode(anchorNode)) {
    const children = anchorNode.getChildren()
    if (anchor.offset !== (direction === 'up' ? 0 : children.length)) return false
    return moveOut(anchorNode, direction)
  }
  const node = anchorNode
  const code = node.getTopLevelElement()
  if (!$isCodeNode(code)) return false
  const index = node.getIndexWithinParent()
  if (index < 0) return false
  const siblings = code.getChildren()
  const line = direction === 'up'
    ? siblings.slice(0, index)
    : siblings.slice(index + 1)
  if (line.some(child => $isLineBreakNode(child))) return false
  return moveOut(code, direction)
}

/** Move the caret to the neighbouring block at the fenced boundary. */
function moveOut(code: CodeNode, direction: 'up' | 'down'): boolean {
  const sibling = direction === 'up' ? code.getPreviousSibling() : code.getNextSibling()
  if (sibling !== null && !$isElementNode(sibling)) return false
  if (sibling !== null) {
    if (direction === 'up') sibling.selectEnd()
    else sibling.selectStart()
    return true
  }
  const paragraph = $createParagraphNode()
  if (direction === 'up') {
    code.insertBefore(paragraph)
    paragraph.selectStart()
  } else {
    code.insertAfter(paragraph)
    paragraph.selectStart()
  }
  return true
}

/** The top-level blocks spanned by a selection, in document order. */
function selectedBlocks(anchor: LexicalNode, focus: LexicalNode): ElementNode[] {
  const root = $getRoot()
  const first = anchor.getTopLevelElement()
  const last = focus.getTopLevelElement()
  if (first === null || last === null) return []
  const children = root.getChildren()
  const anchorIndex = children.indexOf(first)
  const focusIndex = children.indexOf(last)
  if (anchorIndex < 0 || focusIndex < 0) return []
  const from = Math.min(anchorIndex, focusIndex)
  const to = Math.max(anchorIndex, focusIndex)
  return children.slice(from, to + 1).filter((child): child is ElementNode => $isElementNode(child))
}

/** Fill a fresh code node with the newline-separated content of the blocks it replaces. */
function appendCodeContent(code: CodeNode, content: string): void {
  if (content === '') return
  content.split('\n').forEach((line, index) => {
    if (index > 0) code.append($createLineBreakNode())
    if (line !== '') code.append($createTextNode(line))
  })
}

/** Replace a code node with one paragraph per line and land the caret at the end. */
function exitCodeBlock(code: CodeNode): void {
  const paragraphs = code.getTextContent().split('\n').map((line) => {
    const paragraph = $createParagraphNode()
    if (line !== '') paragraph.append($createTextNode(line))
    return paragraph
  })
  let previous: LexicalNode = code
  for (const paragraph of paragraphs) {
    previous.insertAfter(paragraph)
    previous = paragraph
  }
  code.remove()
  previous.selectEnd()
}
