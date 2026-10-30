import { cameraFov, projectWorldPoint } from '@uve/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ORBIT_VIEW, frameBounds, ORBIT_FOV_Y, orbitBy, orbitCamera, orbitEye, panBy, zoomBy } from './orbit'

describe('orbit view', () => {
  it('puts the eye at the distance, the front view on −Y', () => {
    const eye = orbitEye({ target: [10, 20, 30], distance: 500, yaw: 0, pitch: 0 })
    expect(eye[0]).toBeCloseTo(10)
    expect(eye[1]).toBeCloseTo(-480)
    expect(eye[2]).toBeCloseTo(30)
    expect(orbitEye({ target: [0, 0, 0], distance: 100, yaw: 0, pitch: 90 })[2]).toBeCloseTo(100)
  })

  it('projects the target to the centre with a 30° vertical field', () => {
    const view = { ...DEFAULT_ORBIT_VIEW, target: [40, -60, 25] as [number, number, number] }
    const camera = orbitCamera(view, 1920, 1080)
    const [x, y] = projectWorldPoint(camera, 1920, 1080, view.target) as [number, number]
    expect(x).toBeCloseTo(960)
    expect(y).toBeCloseTo(540)
    expect(cameraFov(camera.spec, 1920, 1080).fovY).toBeCloseTo(ORBIT_FOV_Y)
    expect(cameraFov(orbitCamera(view, 600, 900).spec, 600, 900).fovY).toBeCloseTo(ORBIT_FOV_Y)
  })

  it('shows +Z up and +X right from the front', () => {
    const view = { target: [0, 0, 0] as [number, number, number], distance: 1000, yaw: 0, pitch: 0 }
    const camera = orbitCamera(view, 800, 600)
    const right = projectWorldPoint(camera, 800, 600, [100, 0, 0]) as [number, number]
    const up = projectWorldPoint(camera, 800, 600, [0, 0, 100]) as [number, number]
    expect(right[0]).toBeGreaterThan(400)
    expect(up[1]).toBeLessThan(300)
  })

  it('pans so the world follows the pointer', () => {
    const view = { ...DEFAULT_ORBIT_VIEW }
    const camera = orbitCamera(view, 800, 600)
    const before = projectWorldPoint(camera, 800, 600, [0, 0, 0]) as [number, number]
    const moved = panBy(view, 30, -20, 600)
    const after = projectWorldPoint(orbitCamera(moved, 800, 600), 800, 600, [0, 0, 0]) as [number, number]
    expect(after[0] - before[0]).toBeCloseTo(30, 3)
    expect(after[1] - before[1]).toBeCloseTo(-20, 3)
  })

  it('orbits, clamps the pitch and the distance', () => {
    const turned = orbitBy(DEFAULT_ORBIT_VIEW, 100, 1000)
    expect(turned.yaw).toBeCloseTo(0)
    expect(turned.pitch).toBe(90)
    expect(zoomBy(DEFAULT_ORBIT_VIEW, 1e-9).distance).toBe(1)
  })

  it('frames bounds inside the view', () => {
    const view = frameBounds(DEFAULT_ORBIT_VIEW, { min: [-200, -100, 0], max: [200, 100, 300] }, 16 / 9)
    expect(view.target).toEqual([0, 0, 150])
    const camera = orbitCamera(view, 1600, 900)
    for (const corner of [[-200, -100, 0], [200, 100, 300], [200, -100, 0], [-200, 100, 300]] as const) {
      const [x, y] = projectWorldPoint(camera, 1600, 900, [...corner]) as [number, number]
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(1600)
      expect(y).toBeGreaterThan(0)
      expect(y).toBeLessThan(900)
    }
  })
})
