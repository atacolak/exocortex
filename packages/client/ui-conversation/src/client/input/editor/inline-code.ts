/**
 * Backtick markdown the composer recognizes while typing: a matched inline
 * pair folds into a code pill that reveals its raw delimiters only while the
 * caret sits inside it, and a line-leading triple backtick opens a fenced
 * code block immediately (ChatGPT-style), fences hidden behind the styled
 * block. Serialization stays in projection.ts: a folded pill carries IS_CODE
 * (markdown backticks), a revealed one carries the literal characters.
 */
import type {
  LexicalEditor, LexicalNode, NodeKey, ParagraphNode, SerializedTextNode, Spread, TextNode,
} from 'lexical'
import {
  $getRoot, $getSelection, $isElementNode, $isParagraphNode, $isRangeSelection,
  $isRootOrShadowRoot, $createLineBreakNode, $createTextNode,
  IS_CODE, TextNode as LexicalTextNode,
} from 'lexical'
import { $createCodeNode } from '@lexical/code'

/** Theme class the inline pill carries while folded. */
export const INLINE_CODE_THEME_CLASS = 'dsh-composer-inline-code'

/** Theme class the fenced block carries. */
export const CODE_BLOCK_THEME_CLASS = 'dsh-composer-code-block'

type SerializedInlineCodeNode = Spread<{ revealed: boolean }, SerializedTextNode>

/**
 * One inline code span created from a matched backtick pair. Folded it holds
 * only the content and carries IS_CODE; revealed it holds the literal
 * backticks and carries no format, so the DOM shows exactly what typing edits.
 */
export class InlineCodeNode extends LexicalTextNode {
  /** @internal */
  __revealed: boolean

  constructor(text: string, revealed = false, key?: NodeKey) {
    super(text, key)
    this.__revealed = revealed
  }

  static override getType(): string {
    return 'dsh-inline-code'
  }

  static override clone(node: InlineCodeNode): InlineCodeNode {
    return new InlineCodeNode(node.__text, node.__revealed, node.__key)
  }

  static override importJSON(json: SerializedInlineCodeNode): InlineCodeNode {
    const node = $createInlineCodeNode(json.text, json.revealed === true)
    node.setFormat(json.format)
    node.setDetail(json.detail)
    node.setMode(json.mode)
    node.setStyle(json.style)
    return node
  }

  override exportJSON(): SerializedInlineCodeNode {
    return {
      ...super.exportJSON(),
      type: 'dsh-inline-code',
      version: 1,
      revealed: this.__revealed,
    }
  }

  isRevealed(): boolean {
    return this.getLatest().__revealed
  }

  setRevealed(revealed: boolean): this {
    const writable = this.getWritable()
    writable.__revealed = revealed
    return writable as this
  }
}

/**
 * Create a folded inline code pill.
 * @param text - the span's content, without delimiters.
 * @param revealed - whether the node currently shows literal backticks.
 */
export function $createInlineCodeNode(text: string, revealed = false): InlineCodeNode {
  const node = new InlineCodeNode(text, revealed)
  node.setFormat(revealed ? 0 : IS_CODE)
  return node
}

/** Whether a node is the composer's backtick-authored inline pill. */
export function $isInlineCodeNode(node: LexicalNode | null | undefined): node is InlineCodeNode {
  return node instanceof InlineCodeNode
}

/** The skeleton pieces of a detected fold inside one text node. */
interface Fold {
  readonly open: number
  readonly close: number
  readonly content: string
}

/**
 * Find a just-typed inline pair ending at the caret of one text node.
 * @param node - the text node the typing landed in.
 * @param offset - the collapsed caret offset.
 * @returns the delimiter range, or null when the text is not a fresh pair.
 */
function typedPair(node: TextNode, offset: number): Fold | null {
  const text = node.getTextContent()
  if (offset < 2 || text[offset - 1] !== '`') return null
  const open = text.lastIndexOf('`', offset - 2)
  if (open < 0) return null
  const content = text.slice(open + 1, offset - 1)
  if (content === '' || content.includes('`')) return null
  if (open > 0 && text[open - 1] === '`') return null
  return { open, close: offset, content }
}

/**
 * Fold a typed inline pair into a pill, carrying the caret to its end.
 * @param node - the owning text node.
 * @param fold - the detected delimiter range.
 */
function foldPair(node: TextNode, fold: Fold): void {
  const text = node.getTextContent()
  const head = text.slice(0, fold.open)
  const tail = text.slice(fold.close)
  const code = $createInlineCodeNode(fold.content)
  node.insertAfter(code)
  if (tail !== '') {
    const rest = $createTextNode(tail)
    rest.setFormat(node.getFormat() & ~IS_CODE)
    code.insertAfter(rest)
  }
  if (head === '') node.remove()
  else node.setTextContent(head)
  code.selectEnd()
}

/** Whether a collapsed caret sits anywhere before a pill's closing edge. */
function caretTouches(node: InlineCodeNode): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
  return selection.anchor.getNode() === node
    && selection.anchor.offset < node.getTextContentSize()
}

/** Swap one pill between its folded and revealed text/format pair. */
function setRevealed(node: InlineCodeNode, revealed: boolean): void {
  const text = node.getTextContent()
  if (revealed) {
    node.setTextContent(`\`${text}\``)
    node.setFormat(0)
  } else if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
    node.setTextContent(text.slice(1, -1))
    node.setFormat(IS_CODE)
  } else {
    node.setFormat(0)
  }
  node.setRevealed(revealed)
}

/**
 * Decide the reveal state every pill should carry for the current selection.
 * A non-collapsed selection stays folded; a collapsed caret reveals only the
 * pill it sits strictly inside.
 * @returns key → desired reveal state for pills that must change.
 */
function revealChanges(): Array<{ node: InlineCodeNode; revealed: boolean }> {
  const changes: Array<{ node: InlineCodeNode; revealed: boolean }> = []
  const walk = (nodes: readonly LexicalNode[]): void => {
    for (const node of nodes) {
      if ($isInlineCodeNode(node)) {
        const revealed = caretTouches(node)
        if (revealed !== node.isRevealed()) changes.push({ node, revealed })
      } else if ($isElementNode(node)) {
        walk(node.getChildren())
      }
    }
  }
  walk($getRoot().getChildren())
  return changes
}

/** The language word and remainder a freshly typed fence carries. */
function fenceBody(text: string, caret: number): { language: string | undefined; content: string } | null {
  if (!text.startsWith('```')) return null
  const after = text.slice(3, caret)
  if (after === '') return { language: undefined, content: text.slice(caret) }
  const match = /^([A-Za-z0-9_+#.-]*)[ \n]$/u.exec(after)
  if (match === null) return null
  return { language: match[1] === '' ? undefined : match[1], content: text.slice(caret) }
}

/** Replace the opening paragraph with a fenced code block and land the caret inside. */
function openFence(paragraph: ParagraphNode, fence: { language: string | undefined; content: string }): void {
  const code = $createCodeNode(fence.language)
  fence.content.split('\n').forEach((line, index) => {
    if (index > 0) code.append($createLineBreakNode())
    if (line !== '') code.append($createTextNode(line))
  })
  paragraph.replace(code)
  code.selectStart()
}

/**
 * Install the composer's typed markdown gestures on one editor.
 * @param editor - the composer editor.
 * @returns the combined unregister disposer.
 */
export function registerComposerMarkdown(editor: LexicalEditor): () => void {
  const unregisterTyping = editor.registerNodeTransform(LexicalTextNode, (node) => {
    if (node.getMode() !== 'normal') return
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
    if (selection.anchor.getNode() !== node) return
    const offset = selection.anchor.offset
    if (offset === 0) return

    const paragraph = node.getParent()
    if (!$isParagraphNode(paragraph)) return

    if (node.getPreviousSibling() === null && $isRootOrShadowRoot(paragraph.getParent()) && paragraph.getChildrenSize() === 1) {
      const fence = fenceBody(node.getTextContent(), offset)
      if (fence !== null) {
        openFence(paragraph, fence)
        return
      }
    }

    const pair = typedPair(node, offset)
    if (pair !== null) foldPair(node, pair)
  })

  const unregisterPills = editor.registerNodeTransform(InlineCodeNode, (node) => {
    if (node.isRevealed()) return
    if (caretTouches(node)) {
      setRevealed(node, true)
    }
  })

  let applying = false
  const unregisterSelection = editor.registerUpdateListener(({ editorState }) => {
    if (applying) return
    const changes = editorState.read(() => revealChanges())
    if (changes.length === 0) return
    applying = true
    editor.update(() => {
      for (const change of changes) {
        const node = change.node.getLatest()
        if ($isInlineCodeNode(node) && node.isAttached()) setRevealed(node, change.revealed)
      }
    }, { onUpdate: () => { applying = false } })
  })

  return () => {
    unregisterTyping()
    unregisterPills()
    unregisterSelection()
  }
}
