import type { OmpRpcClient } from './client.ts'

/**
 * The OMP process is the single source of truth for the model and thinking
 * level its session runs. This module is the only place the bridge reaches
 * that authority, and it is split along the two directions it flows:
 *
 * - {@link readAuthority} is the attach and resume surface. It issues read
 *   commands and nothing else, so attaching to an existing socket or resuming
 *   a transcript cannot assert a harness default onto the process.
 * - {@link mintModel} and {@link applyOperatorSelection} are the two explicit
 *   write paths: a brand-new blank session launched with an operator pick, and
 *   an operator change made in the harness. Both confirm what they wrote
 *   through {@link readActiveModel} before the caller projects it.
 */

/** One model the attached OMP process says its gateway serves. */
export interface OmpCatalogModel {
  readonly id: string
  readonly name?: string
  /** Provider route OMP resolves the model through, when it discloses one. */
  readonly provider?: string
}

/** The harness-side route and model an attachment should serve. */
export interface OmpModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Thinking levels OMP accepts for a model selection, in increasing depth. */
export const OMP_THINKING_LEVELS: Record<string, true> = {
  off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
}

/**
 * OMP selectors the harness expresses as "no explicit effort": `auto` lets OMP
 * choose per model, `inherit` defers to the enclosing selector.
 */
const OMP_DELEGATED_LEVELS: Record<string, true> = { auto: true, inherit: true }

/**
 * The model authority an OMP process reports for itself: the route, model, and
 * effective thinking level its own session runs.
 */
export interface OmpActiveModel {
  readonly provider: string
  readonly model: string
  /** Effective thinking level; absent when the process delegates its choice. */
  readonly thinkingLevel?: string
}

/** What one attachment read from, or minted onto, its process. */
export interface OmpModelAuthority {
  readonly active: OmpActiveModel | undefined
  readonly models: readonly OmpCatalogModel[]
}

/** What one catalog pass did to the attached process. */
export type CatalogSyncOutcome =
  | ({ readonly status: 'adopted' } & OmpModelAuthority)
  | ({ readonly status: 'applied'; readonly model: OmpCatalogModel } & OmpModelAuthority)
  | ({ readonly status: 'not-offered' } & OmpModelAuthority)

/** Why one model selection never reached the process, or reached it unverified. */
export type OmpModelSelectionFailure = 'not-offered' | 'rejected' | 'unverified'

/** A selection the attached process refused or did not adopt. */
export class OmpModelSelectionError extends Error {
  /**
   * @param code - which gate refused the selection.
   * @param message - operator-facing failure text naming the rejected request.
   * @param options - original process failure, when one caused this.
   */
  constructor(readonly code: OmpModelSelectionFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OmpModelSelectionError'
  }
}

/** The client surface catalog authority needs. */
export type OmpCatalogClient = Pick<OmpRpcClient, 'request'>

/**
 * Choose the advertised model that serves one harness selection.
 *
 * Exact ids match first. A gateway that prefixes its ids with the route
 * (`go/glm-5`, `cpa/claude-opus`) is matched on the last path segment, which is
 * the id the harness selects by.
 * @param models - the catalog the process advertised, in its own order.
 * @param selection - the harness route and model.
 * @returns the matching entry, or undefined when the gateway does not serve it.
 */
export function matchCatalogModel(
  models: readonly OmpCatalogModel[],
  selection: OmpModelSelection,
): OmpCatalogModel | undefined {
  return models.find(model => model.id === selection.model)
    ?? models.find(model => model.id.endsWith(`/${selection.model}`))
}

function readCatalog(data: unknown): OmpCatalogModel[] {
  const rows = (data as { models?: unknown } | null)?.models
  if (!Array.isArray(rows)) return []
  const models: OmpCatalogModel[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as { id?: unknown; name?: unknown; provider?: unknown }
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    models.push({
      id: entry.id,
      ...typeof entry.name === 'string' ? { name: entry.name } : {},
      ...typeof entry.provider === 'string' ? { provider: entry.provider } : {},
    })
  }
  return models
}

/**
 * Read the model authority out of one `get_state` payload.
 * @param state - the process's session state.
 * @returns the route, model, and effective thinking level it runs, or undefined.
 */
export function readActiveModel(state: unknown): OmpActiveModel | undefined {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined
  const record = state as Record<string, unknown>
  const model = record['model']
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return undefined
  const entry = model as { provider?: unknown; id?: unknown }
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) return undefined
  if (typeof entry.id !== 'string' || entry.id.length === 0) return undefined
  const level = record['thinkingLevel']
  return {
    provider: entry.provider,
    model: entry.id,
    ...typeof level === 'string' && OMP_DELEGATED_LEVELS[level] !== true ? { thinkingLevel: level } : {},
  }
}

/**
 * Read the model authority and catalog an attached process runs.
 *
 * This is the only surface an attach or resume may use, and it issues read
 * commands exclusively: an existing socket or transcript keeps the model it
 * already runs no matter what the harness would default to.
 * @param client - the attached process.
 * @param state - an already-read `get_state` payload; omitted reads it.
 * @returns the authority the process reports and the models it advertises.
 */
export async function readAuthority(client: OmpCatalogClient, state?: unknown): Promise<OmpModelAuthority> {
  const models = readCatalog(await client.request({ type: 'get_available_models' }))
  const active = readActiveModel(state === undefined ? await client.request({ type: 'get_state' }) : state)
  return { active, models }
}

/**
 * Apply an operator selection to a process that starts a brand-new transcript.
 *
 * The caller must have established that the session is blank and that the
 * process resumes nothing; this function does not re-check that.
 * @param client - the freshly launched process.
 * @param selection - the operator's route, model, and effort.
 * @returns the outcome plus the authority the process reports afterwards.
 */
export async function mintModel(
  client: OmpCatalogClient,
  selection: OmpModelSelection,
): Promise<Extract<CatalogSyncOutcome, { status: 'applied' | 'not-offered' }>> {
  const { active, models } = await readAuthority(client)
  const model = matchCatalogModel(models, selection)
  if (model === undefined) return { status: 'not-offered', active, models }
  await client.request({
    type: 'set_model',
    provider: model.provider ?? selection.provider,
    modelId: model.id,
  })
  const effort = selection.reasoningEffort
  if (effort !== undefined && OMP_THINKING_LEVELS[effort] === true) {
    await client.request({ type: 'set_thinking_level', level: effort }).catch(() => {})
  }
  return { status: 'applied', active: readActiveModel(await client.request({ type: 'get_state' })) ?? active, model, models }
}

/**
 * Apply one operator selection to a live attachment and confirm it was adopted.
 *
 * Both the model and the thinking level are sent, because either may have
 * changed and OMP carries the previous level across a model switch. The
 * confirmation read is what the caller projects: the badge never reports a
 * selection the process did not adopt.
 * @param client - the attached process.
 * @param selection - operator route, model, and effort; an absent effort defers
 * the level to OMP's own selector.
 * @returns the authority the process reports after the writes.
 * @throws {OmpModelSelectionError} when the gateway does not serve the model,
 * either command fails, or the process reports another model afterwards.
 */
export async function applyOperatorSelection(
  client: OmpCatalogClient,
  selection: OmpModelSelection,
): Promise<OmpActiveModel> {
  const models = readCatalog(await client.request({ type: 'get_available_models' }))
  const model = matchCatalogModel(models, selection)
  if (model === undefined) {
    throw new OmpModelSelectionError(
      'not-offered',
      `the OMP gateway does not serve ${selection.provider}/${selection.model}`,
    )
  }
  const provider = model.provider ?? selection.provider
  try {
    await client.request({ type: 'set_model', provider, modelId: model.id })
  } catch (error: unknown) {
    throw new OmpModelSelectionError(
      'rejected',
      `OMP rejected the model ${provider}/${model.id}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const level = selection.reasoningEffort !== undefined && OMP_THINKING_LEVELS[selection.reasoningEffort] === true
    ? selection.reasoningEffort
    : 'inherit'
  try {
    await client.request({ type: 'set_thinking_level', level })
  } catch (error: unknown) {
    throw new OmpModelSelectionError(
      'rejected',
      `OMP rejected thinking level "${level}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const active = readActiveModel(await client.request({ type: 'get_state' }))
  if (active === undefined || active.provider !== provider || active.model !== model.id) {
    throw new OmpModelSelectionError(
      'unverified',
      `OMP did not adopt ${provider}/${model.id}: it reports ${active === undefined ? 'no model' : `${active.provider}/${active.model}`}`,
    )
  }
  return active
}
