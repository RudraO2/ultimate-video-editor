import { describe, expect, it } from 'vitest'
import { gltfReferences } from './model'

describe('gltfReferences', () => {
  it('lists the buffers and images beside the file, decoded, once each', () => {
    const json = {
      buffers: [{ uri: 'scene.bin', byteLength: 1 }, { uri: 'data:application/octet-stream;base64,AAAA' }, { byteLength: 4 }],
      images: [{ uri: 'textures/base%20color.png' }, { uri: './textures/base color.png' }, { uri: 'a/../b.jpg' }],
    }
    expect(gltfReferences(json)).toEqual(['scene.bin', 'textures/base color.png', 'b.jpg'])
  })

  it('leaves out absolute paths, urls, drive letters and paths that climb out of the folder', () => {
    const json = {
      buffers: [{ uri: '/etc/passwd' }, { uri: '\\windows\\x.bin' }, { uri: 'C:/x.bin' }, { uri: 'C:\\x.bin' }, { uri: 'https://example.com/a.bin' }, { uri: 'file:///a.bin' }],
      images: [{ uri: '../secret.png' }, { uri: 'a/../../secret.png' }, { uri: '%2e%2e/secret.png' }, { uri: 'ok/../ok.png' }],
    }
    expect(gltfReferences(json)).toEqual(['ok.png'])
  })

  it('ignores anything that is not a glTF shape', () => {
    expect(gltfReferences(null)).toEqual([])
    expect(gltfReferences('x')).toEqual([])
    expect(gltfReferences({ buffers: 3, images: [null, 7, { uri: 5 }, { uri: '%zz' }] })).toEqual([])
  })
})
