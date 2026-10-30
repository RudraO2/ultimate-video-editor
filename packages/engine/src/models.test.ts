import { CompSchema, LayerSchema, MediaAssetSchema, TrackSchema } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { fitBox, folderOf, modelFormatOf, modelsUsed, probeModel, resolveModelUri } from './models'
import { worldLoader } from './worldLoader'

describe('model formats', () => {
  it('knows a model by its extension, in any case', () => {
    expect(modelFormatOf('car.glb')).toBe('glb')
    expect(modelFormatOf('C:\\a b\\Scene.GLTF')).toBe('gltf')
    expect(modelFormatOf('x.Obj')).toBe('obj')
    expect(modelFormatOf('part.stl')).toBe('stl')
    expect(modelFormatOf('scan.ply')).toBe('ply')
  })

  it('refuses everything else', () => {
    expect(modelFormatOf('clip.mp4')).toBeNull()
    expect(modelFormatOf('model.fbx')).toBeNull()
    expect(modelFormatOf('glb')).toBeNull()
    expect(modelFormatOf('dir.glb/readme')).toBeNull()
  })
})

describe('fitting a model', () => {
  it('scales the longest side to 200, centres x and y, and stands it on z = 0', () => {
    const { scale, offset } = fitBox([0, 0, 5], [10, 20, 15])
    expect(scale).toBe(10)
    // The box centre (5, 10) goes to 0; the bottom (z = 5) goes to 0.
    expect(offset).toEqual([-50, -100, -50])
    expect(5 * scale + offset[0]).toBe(0)
    expect(5 * scale + offset[2]).toBe(0)
  })

  it('keeps a model that is already 200 long as it is, and leaves a degenerate box alone', () => {
    expect(fitBox([-100, -50, 0], [100, 50, 80]).scale).toBe(1)
    expect(fitBox([1, 1, 1], [1, 1, 1]).scale).toBe(1)
    expect(fitBox([0, 0, 0], [4, 2, 1], 100).scale).toBe(25)
  })
})

describe('files beside a model', () => {
  it('finds the folder of a path with either separator', () => {
    expect(folderOf('C:\\models\\car\\scene.gltf')).toBe('C:\\models\\car')
    expect(folderOf('/home/me/scene.gltf')).toBe('/home/me')
    expect(folderOf('scene.gltf')).toBe('')
  })

  it('resolves a relative uri beside a Windows model with backslashes', () => {
    expect(resolveModelUri('C:\\m\\car', 'scene.bin')).toBe('C:\\m\\car\\scene.bin')
    expect(resolveModelUri('C:\\m\\car', 'tex/a.png')).toBe('C:\\m\\car\\tex\\a.png')
    expect(resolveModelUri('C:\\m\\car', 'my%20tex/b%23.png')).toBe('C:\\m\\car\\my tex\\b#.png')
    expect(resolveModelUri('C:\\m\\car', '../shared/c.png')).toBe('C:\\m\\shared\\c.png')
    expect(resolveModelUri('C:\\m\\car', './d.png?v=2')).toBe('C:\\m\\car\\d.png')
  })

  it('resolves beside a POSIX model with slashes', () => {
    expect(resolveModelUri('/home/me/car', 'tex/a.png')).toBe('/home/me/car/tex/a.png')
    expect(resolveModelUri('/home/me/car', '../x.bin')).toBe('/home/me/x.bin')
    expect(resolveModelUri('', 'a.bin')).toBe('a.bin')
  })

  it('passes anything that is not a relative file through', () => {
    expect(resolveModelUri('C:\\m', 'data:application/octet-stream;base64,AAAA')).toBeNull()
    expect(resolveModelUri('C:\\m', 'blob:abc')).toBeNull()
    expect(resolveModelUri('C:\\m', 'https://x.test/a.png')).toBeNull()
    expect(resolveModelUri('/m', '/abs/a.png')).toBeNull()
  })
})

const meshLayer = (id: string, assetId: string) =>
  LayerSchema.parse({ id, name: id, kind: 'mesh', startMs: 0, durationMs: 1000, geometry: { type: 'asset', assetId } })
const comp = (id: string, layers: unknown[], extra: Record<string, unknown> = {}) =>
  CompSchema.parse({ id, name: id, width: 640, height: 360, fps: 30, durationMs: 1000, tracks: layers.map((layer, i) => TrackSchema.parse({ id: `${id}${i}`, layers: [layer] })), ...extra })

describe('modelsUsed', () => {
  const media = [
    MediaAssetSchema.parse({ id: 'a', kind: 'model', name: 'a.glb', path: 'C:\\m\\a.glb', model: { format: 'glb' } }),
    MediaAssetSchema.parse({ id: 'b', kind: 'model', name: 'b.stl', path: 'C:\\m\\b.stl' }),
  ]

  it('lists each model of the worlds once, through nested comps, by the asset or the extension', () => {
    const inner = comp('w', [meshLayer('m1', 'a'), meshLayer('m2', 'a'), meshLayer('m3', 'b')], { world: {} })
    const outer = comp('o', [LayerSchema.parse({ id: 'n', name: 'n', kind: 'nested', sourceCompId: 'w', startMs: 0, durationMs: 1000 })])
    const found = modelsUsed(outer, [inner, outer], media)
    expect(found).toEqual([
      { path: 'C:\\m\\a.glb', format: 'glb' },
      { path: 'C:\\m\\b.stl', format: 'stl' },
    ])
  })

  it('finds nothing in a flat comp or for a missing asset', () => {
    expect(modelsUsed(comp('f', [meshLayer('m', 'a')]), [], media)).toEqual([])
    expect(modelsUsed(comp('w', [meshLayer('m', 'zzz')], { world: {} }), [], media)).toEqual([])
  })
})

describe('probeModel', () => {
  it('says what went wrong in words a user can read', async () => {
    const real = worldLoader.ensure
    worldLoader.ensure = () => Promise.reject(new Error('offline'))
    try {
      await expect(probeModel('C:\\m\\a.glb', 'glb')).rejects.toThrow('Could not read the model: offline')
    } finally {
      worldLoader.ensure = real
    }
  })
})
