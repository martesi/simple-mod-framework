import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as TE from 'fp-ts/TaskEither'
import {
  errorStack,
  formatScriptError,
  requireTask,
  runBestEffort,
  scriptError,
} from '../scripts/lib/effects'
import { findFile, writeFileAtomically } from '../scripts/lib/files'

describe('script effects', () => {
  test('formats typed errors while preserving the original cause', () => {
    const cause = new Error('disk full')
    const error = scriptError('write file', 'disk full', { path: '/tmp/out', cause })
    expect(formatScriptError(error)).toBe('write file (/tmp/out): disk full')
    expect(errorStack(error)).toContain('disk full')
  })

  test('runs every best-effort task and remains successful', async () => {
    const ran: string[] = []
    const warnings: string[] = []
    await requireTask(
      runBestEffort(
        [
          {
            label: 'one',
            warning: 'fix one',
            operation: TE.rightIO(() => {
              ran.push('one')
            }),
          },
          {
            label: 'two',
            warning: 'fix two',
            operation: TE.left(scriptError('download', 'offline')),
          },
        ],
        (message) => warnings.push(message)
      )
    )
    expect(ran).toEqual(['one'])
    expect(warnings[0]).toContain('two')
  })

  test('finds files recursively without case sensitivity and writes atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smf-test-'))
    try {
      const nested = join(root, 'Nested')
      await mkdir(nested)
      await Bun.write(join(nested, 'HASH_LIST.TXT'), 'old')
      const found = await requireTask(findFile(root, 'hash_list.txt'))
      expect(found).toBe(join(nested, 'HASH_LIST.TXT'))
      const destination = join(root, 'output', 'value.txt')
      await requireTask(writeFileAtomically(destination, 'new'))
      expect(await readFile(destination, 'utf8')).toBe('new')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
