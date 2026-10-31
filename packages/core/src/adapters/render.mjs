/**
 * Rendering ICU back out to a platform's own string syntax.
 *
 * Shared by every native adapter, because the walk is the same each time and
 * three copies would be three sets of divergent bugs. What differs between
 * platforms is only what to write for an argument, a plural, and a literal, so
 * those are the hooks.
 *
 * Two rules hold across all of them.
 *
 * Argument positions come from the SOURCE message, never the translation.
 * German reorders a sentence and Japanese moves the verb to the end, so the
 * translation's own argument order is a different order. A positional format
 * numbered from the translation would compile and then print the device name
 * where the count belongs.
 *
 * A construct with no hook throws. The capability matrix is supposed to have
 * rejected it at check time, so reaching here means the matrix is wrong, and a
 * loud failure during export is far better than a string that silently loses
 * half its branches.
 */

import { TYPE } from '@formatjs/icu-messageformat-parser'

export class RenderError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RenderError'
  }
}

/**
 * One-based argument positions, taken from the source message's order.
 *
 * @param {ReturnType<import('../icu.mjs').analyze>} sourceAnalysis
 * @returns {Map<string, number>}
 */
export function argPositions(sourceAnalysis) {
  const positions = new Map()
  sourceAnalysis.argOrder.forEach((name, index) => positions.set(name, index + 1))
  return positions
}

/**
 * Walk a message, writing it in the target's syntax.
 *
 * @param {unknown[]} ast
 * @param {{
 *   literal: (text: string) => string,
 *   arg: (name: string, kind: string, node: object) => string,
 *   pound?: () => string,
 *   plural?: (node: object, render: (nodes: unknown[]) => string) => string,
 *   select?: (node: object, render: (nodes: unknown[]) => string) => string,
 *   tag?: (node: object, render: (nodes: unknown[]) => string) => string,
 * }} hooks
 */
export function renderMessage(ast, hooks) {
  const render = (nodes) => {
    let out = ''
    for (const node of nodes) {
      switch (node.type) {
        case TYPE.literal:
          out += hooks.literal(node.value)
          break
        case TYPE.pound:
          if (!hooks.pound) throw new RenderError('# has no representation in this format')
          out += hooks.pound()
          break
        case TYPE.argument:
          out += hooks.arg(node.value, 'string', node)
          break
        case TYPE.number:
          out += hooks.arg(node.value, 'number', node)
          break
        case TYPE.date:
          out += hooks.arg(node.value, 'date', node)
          break
        case TYPE.time:
          out += hooks.arg(node.value, 'time', node)
          break
        case TYPE.plural:
          if (!hooks.plural) throw new RenderError(`a plural on {${node.value}} has no representation in this format`)
          out += hooks.plural(node, render)
          break
        case TYPE.select:
          if (!hooks.select) throw new RenderError(`a select on {${node.value}} has no representation in this format`)
          out += hooks.select(node, render)
          break
        case TYPE.tag:
          if (!hooks.tag) throw new RenderError(`the tag <${node.value}> has no representation in this format`)
          out += hooks.tag(node, render)
          break
        default:
          throw new RenderError(`unhandled ICU node type ${String(node.type)}`)
      }
    }
    return out
  }

  return render(ast)
}

/**
 * The plural hook for a format that flattens: one whole string per category,
 * with the chosen branch spliced in.
 *
 * `category` is the CLDR category being rendered. A message whose plural lacks
 * that branch falls back to `other`, which every valid ICU plural has; the
 * missing branch is already an error from `check`, and failing the export too
 * would just hide it behind a second message.
 */
export function chooseBranch(node, category, render) {
  const option = node.options?.[category] ?? node.options?.other
  if (!option) throw new RenderError(`plural on {${node.value}} has neither "${category}" nor "other"`)
  return render(option.value ?? [])
}
