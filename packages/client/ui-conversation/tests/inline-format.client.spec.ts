// @vitest-environment jsdom
/**
 * Cmd/Ctrl+B and Cmd/Ctrl+I semantics over a headless composer editor: a
 * ranged selection formats its text, a caret strictly inside a word formats
 * that word and nothing else, and every other caret arms the format for the
 * characters typed from it.
 */
import { describe, expect, it } from 'vitest'
import { createHeadlessEditor } from '@lexical/headless'
import type { ElementNode, LexicalEditor } from 'lexical'
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode,
  IS_BOLD, IS_ITALIC,
} from 'lexical'
import { CodeNode } from '@lexical/code'
import { $toggleInlineFormat } from '../src/client/input/editor/formatting.ts'

function makeEditor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: 'inline-format-spec',
    nodes: [CodeNode],
    onError: (error) => { throw error },
  })
}

/** Seed one paragraph and place a collapsed caret at `caret`. */
function seed(editor: LexicalEditor, text: string, caret: number): void {
  editor.update(() => {
    const paragraph = $createParagraphNode()
    const node = $createTextNode(text)
    paragraph.append(node)
    $getRoot().append(paragraph)
    node.select(caret, caret)
  }, { discrete: true })
}

/** The paragraph's text runs with their format bits. */
function runs(editor: LexicalEditor): { text: string; format: number }[] {
  return editor.getEditorState().read(() => $getRoot().getFirstChild<ElementNode>()!.getChildren().map(child => ({
    text: child.getTextContent(),
    format: $isTextNode(child) ? child.getFormat() : 0,
  })))
}

/** The collapsed caret offset and the armed typing format. */
function caret(editor: LexicalEditor): { offset: number; format: number } {
  return editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) throw new Error('expected a range selection')
    return { offset: selection.anchor.offset, format: selection.format }
  })
}

function toggleBold(editor: LexicalEditor): void {
  editor.update(() => { $toggleInlineFormat('bold') }, { discrete: true })
}

function type(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) throw new Error('expected a range selection')
    selection.insertText(text)
  }, { discrete: true })
}

describe('collapsed caret at the end of a word', () => {
  it('leaves the finished word alone and arms the next typed characters', () => {
    const editor = makeEditor()
    seed(editor, 'sa', 2)
    toggleBold(editor)
    expect(runs(editor)).toEqual([{ text: 'sa', format: 0 }])
    expect(caret(editor)).toEqual({ offset: 2, format: IS_BOLD })
    type(editor, 'x')
    expect(runs(editor)).toEqual([{ text: 'sa', format: 0 }, { text: 'x', format: IS_BOLD }])
    toggleBold(editor)
    type(editor, 'y')
    expect(runs(editor).at(-1)).toEqual({ text: 'y', format: 0 })
  })
})

describe('collapsed caret strictly inside a word', () => {
  it('formats the whole word and keeps the caret in place without arming typing', () => {
    const editor = makeEditor()
    seed(editor, 'hello', 2)
    toggleBold(editor)
    expect(runs(editor)).toEqual([{ text: 'hello', format: IS_BOLD }])
    expect(caret(editor)).toEqual({ offset: 2, format: 0 })
  })

  it('toggles the format off when the word already carries it', () => {
    const editor = makeEditor()
    seed(editor, 'hello', 3)
    toggleBold(editor)
    toggleBold(editor)
    expect(runs(editor)).toEqual([{ text: 'hello', format: 0 }])
  })

  it('uses the italic bit for the italic gesture', () => {
    const editor = makeEditor()
    seed(editor, 'hello', 1)
    editor.update(() => { $toggleInlineFormat('italic') }, { discrete: true })
    expect(runs(editor)).toEqual([{ text: 'hello', format: IS_ITALIC }])
  })
})

describe('collapsed caret outside every word', () => {
  it('does not format the word after the caret', () => {
    const editor = makeEditor()
    seed(editor, 'sa', 0)
    toggleBold(editor)
    expect(runs(editor)).toEqual([{ text: 'sa', format: 0 }])
    type(editor, 'x')
    expect(runs(editor)).toEqual([{ text: 'x', format: IS_BOLD }, { text: 'sa', format: 0 }])
  })

  it('arms the format after a space and on an empty line', () => {
    const afterSpace = makeEditor()
    seed(afterSpace, 'hi ', 3)
    toggleBold(afterSpace)
    expect(runs(afterSpace)).toEqual([{ text: 'hi ', format: 0 }])
    type(afterSpace, 'x')
    expect(runs(afterSpace)[1]).toEqual({ text: 'x', format: IS_BOLD })

    const empty = makeEditor()
    seed(empty, '', 0)
    toggleBold(empty)
    type(empty, 'x')
    expect(runs(empty)).toEqual([{ text: 'x', format: IS_BOLD }])
  })
})

describe('ranged selection', () => {
  it('toggles the format across the selected text', () => {
    const editor = makeEditor()
    editor.update(() => {
      const paragraph = $createParagraphNode()
      const node = $createTextNode('plain words')
      paragraph.append(node)
      $getRoot().append(paragraph)
      node.select(5, 11)
      $toggleInlineFormat('bold')
    }, { discrete: true })
    expect(runs(editor)).toEqual([{ text: 'plain', format: 0 }, { text: ' words', format: IS_BOLD }])
  })
})
