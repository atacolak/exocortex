// @vitest-environment jsdom
/**
 * Typed backtick markdown in the composer: a matched inline pair folds into
 * a pill that reveals its delimiters while the caret is inside it, and a
 * line-leading triple backtick opens a fenced block whose boundary arrows
 * let the caret leave.
 */
import { describe, expect, it, vi } from 'vitest'
import { createHeadlessEditor } from '@lexical/headless'
import type { LexicalEditor } from 'lexical'
import {
  $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection,
  $isElementNode, $isRangeSelection, $isTextNode, IS_CODE,
} from 'lexical'
import { CodeNode, $createCodeNode, $isCodeNode } from '@lexical/code'
import {
  $isInlineCodeNode, InlineCodeNode, registerComposerMarkdown,
} from '../src/client/input/editor/inline-code.ts'
import { $moveCaretOutOfCodeBlock } from '../src/client/input/editor/formatting.ts'

function makeEditor(): LexicalEditor {
  const editor = createHeadlessEditor({
    namespace: 'backtick-markdown-spec',
    nodes: [CodeNode, InlineCodeNode],
    onError: (error) => { throw error },
  })
  registerComposerMarkdown(editor)
  return editor
}

function seed(editor: LexicalEditor, text: string, caret: number): void {
  editor.update(() => {
    const paragraph = $createParagraphNode()
    const node = $createTextNode(text)
    paragraph.append(node)
    $getRoot().append(paragraph)
    node.select(caret, caret)
  }, { discrete: true })
}

function type(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) throw new Error('expected a range selection')
    selection.insertText(text)
  }, { discrete: true })
}

function deltas(editor: LexicalEditor): { text: string; format: number; pill: boolean }[] {
  return editor.getEditorState().read(() => $getRoot().getFirstChild()!.getChildren().map(child => ({
    text: child.getTextContent(),
    format: $isTextNode(child) ? child.getFormat() : 0,
    pill: $isInlineCodeNode(child),
  })))
}

describe('inline backtick pair', () => {
  it('folds a typed pair into a code pill without the delimiters', () => {
    const editor = makeEditor()
    seed(editor, '', 0)
    type(editor, 'a `x`')
    expect(deltas(editor)).toEqual([
      { text: 'a ', format: 0, pill: false },
      { text: 'x', format: IS_CODE, pill: true },
    ])
  })

  it('stays literal for an unpaired or multi-backtick run', () => {
    const editor = makeEditor()
    seed(editor, '', 0)
    type(editor, 'a `x')
    expect(deltas(editor)).toEqual([{ text: 'a `x', format: 0, pill: false }])
  })

  it('reveals delimiters while the caret is strictly inside the pill and folds them back on exit', async () => {
    const editor = makeEditor()
    seed(editor, '', 0)
    type(editor, '`x`')
    editor.update(() => {
      const pill = $getRoot().getFirstChild()!.getFirstChild()
      if (!$isInlineCodeNode(pill)) throw new Error('expected a pill')
      pill.select(0, 0)
    }, { discrete: true })
    await vi.waitFor(() => {
      const state = editor.getEditorState().read(() => {
        const pill = $getRoot().getFirstChild()!.getFirstChild()
        return {
          revealed: $isInlineCodeNode(pill) && pill.isRevealed(),
          text: pill?.getTextContent(),
        }
      })
      expect(state).toEqual({ revealed: true, text: '`x`' })
    })
    editor.update(() => {
      const paragraph = $getRoot().getFirstChild()!
      const pill = paragraph.getLastChild()
      if (!$isInlineCodeNode(pill)) throw new Error('expected a pill')
      pill.selectEnd()
    }, { discrete: true })
    await vi.waitFor(() => {
      const state = editor.getEditorState().read(() => {
        const pill = $getRoot().getFirstChild()!.getFirstChild()
        return {
          revealed: $isInlineCodeNode(pill) && pill.isRevealed(),
          text: pill?.getTextContent(),
        }
      })
      expect(state).toEqual({ revealed: false, text: 'x' })
    })
  })
})

describe('fenced code opener', () => {
  it('replaces the opening paragraph with a code block on the third backtick', () => {
    const editor = makeEditor()
    seed(editor, '', 0)
    type(editor, '```')
    const root = editor.getEditorState().read(() => $getRoot().getChildren())
    expect(root).toHaveLength(1)
    expect(root[0] !== undefined && $isCodeNode(root[0])).toBe(true)
  })

  it('carries a language word completed by the opening space', () => {
    const editor = makeEditor()
    seed(editor, '```ts', 5)
    type(editor, ' ')
    const language = editor.getEditorState().read(() => {
      const block = $getRoot().getFirstChild()
      return $isCodeNode(block) ? block.getLanguage() : null
    })
    expect(language).toBe('ts')
  })

  it('keeps a trailing empty paragraph reachable with ArrowDown and inserts one when absent', () => {
    const editor = makeEditor()
    seed(editor, '', 0)
    type(editor, '```')
    editor.update(() => {
      const code = $getRoot().getFirstChild()
      if (!$isCodeNode(code)) throw new Error('expected a code block')
      const text = $createTextNode('one')
      code.append(text)
      text.select(3, 3)
      expect($moveCaretOutOfCodeBlock('down')).toBe(true)
    }, { discrete: true })
    const blocks = editor.getEditorState().read(() => $getRoot().getChildren())
    expect(blocks).toHaveLength(2)
    expect(blocks[1] !== undefined && $isElementNode(blocks[1])).toBe(true)
  })

  it('does not leave the block from an interior line', () => {
    const editor = makeEditor()
    editor.update(() => {
      const code = $createCodeNode()
      $getRoot().append(code)
      const first = $createTextNode('one')
      const second = $createTextNode('two')
      code.append(first, $createLineBreakNode(), second)
      first.select(3, 3)
      expect($moveCaretOutOfCodeBlock('down')).toBe(false)
      expect($moveCaretOutOfCodeBlock('up')).toBe(true)
    }, { discrete: true })
  })
})
