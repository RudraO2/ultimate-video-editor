import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AnimationClip, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, VectorKeyframeTrack } from 'three'
import { configureModels } from '../models'
import { clearModelCache, loadModel, ModelInstance, modelFiles, parseModel, preloadModels, probeModel } from './models'

// FileLoader reports progress with a DOM event that node lacks.
if (typeof ProgressEvent === 'undefined') Object.assign(globalThis, { ProgressEvent: class extends Event {} })

beforeAll(() => configureModels({ urlOf: (path) => path, dracoPath: './draco/' }))
afterEach(() => {
  vi.restoreAllMocks()
  clearModelCache()
})

/** A tiny .gltf: one triangle (0,0,0) (1,0,0) (0,1,0) in a node "tri", and a clip "slide" that moves the node by 2 along x in 1 s. */
function triangleGltf(): ArrayBuffer {
  const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 0])
  const base64 = btoa(String.fromCharCode(...new Uint8Array(floats.buffer)))
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'tri', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 68, uri: 'data:application/octet-stream;base64,' + base64 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    animations: [{ name: 'slide', samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
  }
  return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer
}

const ascii = [
  'solid part',
  'facet normal 0 0 1',
  'outer loop',
  'vertex 0 0 5',
  'vertex 10 0 5',
  'vertex 0 20 5',
  'endloop',
  'endfacet',
  'facet normal 0 -1 0',
  'outer loop',
  'vertex 0 0 5',
  'vertex 0 0 15',
  'vertex 10 0 5',
  'endloop',
  'endfacet',
  'endsolid part',
  '',
].join('\n')

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('reading model files', () => {
  it('reads a glTF: its clip and its size at 1 m = 100 px, turned to Z up', async () => {
    const template = await parseModel('gltf', triangleGltf(), 'C:\\m\\tri.gltf')
    expect(template.clips.map((c) => [c.name, c.duration])).toEqual([['slide', 1]])
    // x 0..1 m stays x; the triangle's y (up) becomes z; it is flat in y.
    expect(template.size[0]).toBeCloseTo(100, 4)
    expect(template.size[1]).toBeCloseTo(0, 4)
    expect(template.size[2]).toBeCloseTo(100, 4)
  })

  it('fits an STL: longest side 200, centred in x and y, standing on z = 0', async () => {
    const template = await parseModel('stl', bytesOf(ascii), 'C:\\m\\part.stl')
    expect(template.size.map((v) => Math.round(v))).toEqual([100, 200, 100])
    template.root.updateWorldMatrix(true, true)
    const mesh = template.root.getObjectByProperty('isMesh', true) as Mesh
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    expect(box.min.x).toBeCloseTo(-50, 4)
    expect(box.max.x).toBeCloseTo(50, 4)
    expect(box.min.y).toBeCloseTo(-100, 4)
    expect(box.min.z).toBeCloseTo(0, 4)
    expect(box.max.z).toBeCloseTo(100, 4)
  })

  it('probes a file through the shared cache, and reports one that fails once', async () => {
    const read = vi.spyOn(modelFiles, 'read').mockResolvedValue(triangleGltf())
    const info = await probeModel('C:\\m\\tri.gltf', 'gltf')
    expect(info).toEqual({ format: 'gltf', clips: [{ name: 'slide', durationMs: 1000 }], size: [100, 0, 100] })
    await loadModel({ path: 'C:\\m\\tri.gltf', format: 'gltf' })
    expect(read).toHaveBeenCalledTimes(1)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    read.mockRejectedValue(new Error('gone'))
    const missing = { path: 'C:\\m\\missing.glb', format: 'glb' as const }
    await preloadModels([missing])
    await preloadModels([missing])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

/** A template made in code: a box under a named node that a clip moves along x (0 to 10 in 1 s). */
function template() {
  const root = new Group()
  const node = new Object3D()
  node.name = 'node'
  const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ opacity: 0.5, transparent: true }))
  node.add(box)
  root.add(node)
  const clip = new AnimationClip('move', 1, [new VectorKeyframeTrack('node.position', [0, 1], [0, 0, 0, 10, 0, 0])])
  return { root, clips: [clip], size: [1, 1, 1] as [number, number, number] }
}

describe('model poses', () => {
  const x = (instance: ModelInstance) => (instance.group.getObjectByName('node') as Object3D).position.x

  it('is the same pose for the same time, whatever was shown before', () => {
    const instance = new ModelInstance(template(), null)
    const at = (seconds: number) => {
      instance.pose({ clip: 'move', seconds })
      return x(instance)
    }
    const first = [at(0.25), at(0.75), at(0.5)]
    const second = [at(0.5), at(0.25), at(0.75)]
    expect(first).toEqual([2.5, 7.5, 5])
    expect(second).toEqual([5, 2.5, 7.5])
    expect(at(1)).toBeCloseTo(10, 9)
    expect(at(0.25)).toBe(2.5)
    // Two instances never share a pose.
    const other = new ModelInstance(template(), null)
    other.pose({ clip: 'move', seconds: 0.5 })
    expect(x(other)).toBe(5)
    expect(at(0.25)).toBe(2.5)
  })

  it('goes back to the rest pose when there is no clip, or the clip is not in the file', () => {
    const instance = new ModelInstance(template(), null)
    instance.pose({ clip: 'move', seconds: 0.9 })
    expect(x(instance)).toBeCloseTo(9, 9)
    instance.pose(null)
    expect(x(instance)).toBe(0)
    instance.pose({ clip: 'move', seconds: 0.5 })
    instance.pose({ clip: 'nope', seconds: 0.5 })
    expect(x(instance)).toBe(0)
  })

  it('fades the file materials of an instance and leaves the template alone', () => {
    const t = template()
    const instance = new ModelInstance(t, null)
    const own = (instance.meshes[0] as Mesh).material as MeshStandardMaterial
    const original = (t.root.getObjectByProperty('isMesh', true) as Mesh).material as MeshStandardMaterial
    instance.fade(0.5)
    expect(own.opacity).toBeCloseTo(0.25, 9)
    instance.fade(1)
    expect(own.opacity).toBeCloseTo(0.5, 9)
    expect(original.opacity).toBe(0.5)
    expect(own).not.toBe(original)
  })

  it('swaps in the layer material for every mesh', () => {
    const custom = new MeshStandardMaterial()
    const instance = new ModelInstance(template(), custom)
    expect(instance.isCustom).toBe(true)
    expect((instance.meshes[0] as Mesh).material).toBe(custom)
  })
})
