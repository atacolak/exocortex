import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OMP_NATIVE_COMMANDS,
  discoverOmpSkillsFromDisk,
  ompCompactCommand,
  ompNativeCommandCatalog,
  ompNativeCommandLine,
  ompSkillCommands,
  resolveOmpSkills,
  type OmpSkillListing,
} from '../src/native-commands.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function scratch(): Promise<{ cwd: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'omp-native-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  await mkdir(cwd, { recursive: true })
  await mkdir(home, { recursive: true })
  return { cwd, home }
}

async function skill(root: string, relative: string, frontmatter: string, body = 'body'): Promise<void> {
  const dir = join(root, relative)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
}

function names(skills: readonly OmpSkillListing[]): string[] {
  return skills.map(skill => skill.name)
}

describe('OMP skill discovery from SKILL.md frontmatter', () => {
  it('reads project, agent, and base skill directories in precedence order', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/alpha', 'name: alpha\ndescription: Project skill')
    await skill(cwd, '.agents/skills/beta', 'name: beta\ndescription: Agents skill')
    await skill(home, '.omp/agent/skills/gamma', 'name: gamma\ndescription: Agent skill')
    await skill(home, 'worlds/base/skills/delta', 'name: delta\ndescription: Base skill')

    const discovered = await discoverOmpSkillsFromDisk({ cwd, home })
    expect(names(discovered)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    expect(discovered.every(skill => skill.source !== undefined)).toBe(true)
    expect(discovered[0]?.description).toBe('Project skill')
  })

  it('keeps the first occurrence when two locations declare the same skill', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/shared', 'name: shared\ndescription: Wins')
    await skill(home, 'worlds/base/skills/shared', 'name: shared\ndescription: Loses')

    const discovered = await discoverOmpSkillsFromDisk({ cwd, home })
    expect(discovered.map(skill => skill.description)).toEqual(['Wins'])
  })

  it('skips hidden skills and falls back to the directory name', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/visible', 'description: Visible but unnamed')
    await skill(cwd, '.omp/skills/secret', 'name: secret\ndescription: Hidden skill\nhide: true')

    const discovered = await discoverOmpSkillsFromDisk({ cwd, home })
    expect(names(discovered)).toEqual(['visible'])
  })

  it('tolerates absent directories and malformed frontmatter without throwing', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/broken', 'name: [not yaml')

    const discovered = await discoverOmpSkillsFromDisk({ cwd, home })
    expect(discovered).toEqual([])
  })

  it('parses quoted values and ignores the SKILL.md body', async () => {
    const { cwd, home } = await scratch()
    await skill(
      cwd,
      '.omp/skills/quoted',
      'name: "quoted"\ndescription: \'Quoted: value\'',
      'hide: true\nname: body-must-not-win',
    )

    const discovered = await discoverOmpSkillsFromDisk({ cwd, home })
    expect(discovered).toHaveLength(1)
    expect(discovered[0]).toMatchObject({ name: 'quoted', description: 'Quoted: value' })
    expect(discovered[0]?.hide).toBeUndefined()
  })

  it('discovers skills published through a symlinked skill directory', async () => {
    const { cwd, home } = await scratch()
    const shared = join(home, 'worlds/base/skills')
    await skill(shared, 'cordis-plugin-development', 'name: cordis-plugin-development\ndescription: Use for Cordis plugins')
    await skill(shared, 'agent-experience', 'name: agent-experience\ndescription: Use for tool definitions')
    const linked = join(home, '.omp/agent/skills')
    await mkdir(linked, { recursive: true })
    await symlink(join(shared, 'cordis-plugin-development'), join(linked, 'cordis-plugin-development'), 'dir')
    await symlink(join(shared, 'agent-experience'), join(linked, 'agent-experience'), 'dir')
    await writeFile(join(linked, 'README.md'), 'not a skill directory\n', 'utf8')
    await symlink(join(shared, 'missing'), join(linked, 'broken'), 'dir')

    const discovered = await discoverOmpSkillsFromDisk({ cwd, home })
    expect(names(discovered).toSorted()).toEqual(['agent-experience', 'cordis-plugin-development'])
    expect(discovered.map(skill => skill.source)).toEqual(['.omp/agent/skills', '.omp/agent/skills'])
  })

  it('lowercases skill names so an uppercase SKILL.md never breaks a command name', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/mixed', 'name: MixedCase\ndescription: Mixed case skill')

    const skills = await resolveOmpSkills({ cwd, home })
    expect(ompSkillCommands(skills)).toEqual([{
      name: 'skill:mixedcase',
      description: 'Mixed case skill',
      hint: 'arguments',
      source: 'skill',
    }])
  })
})

describe('OMP skill resolution merges disk discovery with the live listing', () => {
  it('never rejects and keeps disk skills when the live listing fails', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/alpha', 'name: alpha\ndescription: Project skill')

    const skills = await resolveOmpSkills({
      cwd,
      home,
      list: () => Promise.reject(new Error('omp skill list timed out')),
    })
    expect(names(skills)).toEqual(['alpha'])
  })

  it('prefers live rows and appends disk-only skills', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/alpha', 'name: alpha\ndescription: Disk alpha')
    await skill(cwd, '.omp/skills/beta', 'name: beta\ndescription: Disk beta')

    const skills = await resolveOmpSkills({
      cwd,
      home,
      list: () => Promise.resolve([{ name: 'alpha', description: 'Live alpha', source: 'omp' }]),
    })
    expect(skills.map(skill => skill.description)).toEqual(['Live alpha', 'Disk beta'])
  })

  it('lets a hidden live row suppress the same disk skill', async () => {
    const { cwd, home } = await scratch()
    await skill(cwd, '.omp/skills/alpha', 'name: alpha\ndescription: Disk alpha')

    const skills = await resolveOmpSkills({
      cwd,
      home,
      list: () => Promise.resolve([{ name: 'alpha', hide: true }]),
    })
    expect(skills).toEqual([])
    expect(ompSkillCommands(skills)).toEqual([])
  })

  it('populates skill:* commands without a subprocess', async () => {
    const { cwd, home } = await scratch()
    for (let index = 0; index < 15; index += 1) {
      await skill(cwd, `.omp/skills/skill-${String(index)}`, `name: skill-${String(index)}\ndescription: Skill ${String(index)}`)
    }

    const skills = await resolveOmpSkills({ cwd, home, list: () => Promise.reject(new Error('cold start')) })
    const catalog = ompNativeCommandCatalog(skills)
    const skillCommands = catalog.filter(command => command.name.startsWith('skill:'))
    expect(skillCommands).toHaveLength(15)
    expect(catalog).toHaveLength(OMP_NATIVE_COMMANDS.length + 15)
    expect(skillCommands[0]).toMatchObject({ name: 'skill:skill-0', hint: 'arguments', source: 'skill' })
  })
})

describe('/compact argument translation', () => {
  it('sends a bare compact frame for no arguments', () => {
    expect(ompCompactCommand('   ')).toEqual({ type: 'compact' })
  })

  it('sends snapcompact as a mode without focus instructions', () => {
    const frame = ompCompactCommand('snapcompact')
    expect(frame).toEqual({ type: 'compact', mode: 'snapcompact' })
    expect(frame.customInstructions).toBeUndefined()
    expect(Object.hasOwn(frame, 'customInstructions')).toBe(false)
  })

  it('rejects focus instructions that snapcompact cannot honor', () => {
    expect(() => ompCompactCommand('snapcompact focus on tests'))
      .toThrow('/compact snapcompact does not take focus instructions.')
  })

  it('sends soft and remote modes with their focus instructions', () => {
    expect(ompCompactCommand('soft')).toEqual({ type: 'compact', mode: 'soft' })
    expect(ompCompactCommand('remote  tighten the summary ')).toEqual({
      type: 'compact',
      mode: 'remote',
      customInstructions: 'tighten the summary',
    })
  })

  it('treats any other argument as focus instructions', () => {
    expect(ompCompactCommand('  keep the API notes  ')).toEqual({
      type: 'compact',
      customInstructions: 'keep the API notes',
    })
    expect(ompCompactCommand('soften')).toEqual({ type: 'compact', customInstructions: 'soften' })
  })
})

describe('OMP native command rendering', () => {
  it('renders the slash line OMP resolves', () => {
    expect(ompNativeCommandLine('compact', ' soft ')).toBe('/compact soft')
    expect(ompNativeCommandLine('compact', '')).toBe('/compact')
  })
})
