import { expect, test } from 'bun:test'
import { LocalisationPatchError, parseLocalisationPatch } from '../src/main/localisationPatch'

test('localisation.patch.json converts deterministically to overrides', () => {
  expect(
    parseLocalisationPatch({
      resourceId: '0123456789ABCDEF',
      lines: { '0000000000000001': { english: 'Later', french: 'Plus tard' } },
    })
  ).toEqual({
    '0123456789ABCDEF': {
      english: { '0000000000000001': 'Later' },
      french: { '0000000000000001': 'Plus tard' },
    },
  })
})

test('localisation patches reject invalid IDs, languages, and values', () => {
  expect(() => parseLocalisationPatch({ resourceId: 'bad', lines: {} })).toThrow(
    LocalisationPatchError
  )
  expect(() =>
    parseLocalisationPatch({ resourceId: '0123456789ABCDEF', lines: { '1': { klingon: 'x' } } })
  ).toThrow(LocalisationPatchError)
  expect(() =>
    parseLocalisationPatch({ resourceId: '0123456789ABCDEF', lines: { '1': { english: 2 } } })
  ).toThrow(LocalisationPatchError)
})
