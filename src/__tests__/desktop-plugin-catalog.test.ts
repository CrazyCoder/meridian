import { describe, expect, test } from 'bun:test'
import { catalogPlugin, registerPlugin } from '../../apps/desktop/src/pluginCatalog'
describe('desktop plugin installation', () => {
  test('accepts only the curated npm packages', () => {
    expect(catalogPlugin('hermes-scrub').package).toBe('@rynfar/meridian-plugin-hermes-scrub')
    for (const invalid of ['../escape', '@other/plugin', 'pi-scrub@latest', null]) expect(() => catalogPlugin(invalid)).toThrow()
  })
  test('updates in place while preserving unrelated entries and plugin settings', () => {
    const original = JSON.stringify({ extra: true, plugins: [{path:'/custom.js',enabled:true}, {path:'/old.js',enabled:false,config:{mode:'strict'}}, {path:'/last.js',enabled:true}] })
    expect(JSON.parse(registerPlugin(original, '/new.js', ['/old.js']))).toEqual({extra:true,plugins:[{path:'/custom.js',enabled:true},{path:'/new.js',enabled:true,config:{mode:'strict'}},{path:'/last.js',enabled:true}]})
  })
  test('retries are idempotent and malformed configuration is never discarded', () => {
    const first = registerPlugin('', '/new.js', [])
    expect(registerPlugin(first, '/new.js', [])).toBe(first)
    for (const input of ['{', '{}', '{"plugins":[{}]}']) expect(() => registerPlugin(input, '/new.js', [])).toThrow()
  })
})
