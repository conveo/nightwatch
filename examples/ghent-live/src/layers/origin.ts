import { CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, type Raycaster } from "three"
import type { Layer } from "./types.ts"

// A marker on the scene origin, the Belfry: a red ring on the ground and a thin red
// beam of light rising from it. Part of the base, so the very first screenshot
// already has a target; the Belfry itself is drawn by the buildings layer (T1).

// The beam marks the Belfry from the air. Seen from the street it would stand in the
// sky like a fourth tower beside the real ones, so it fades out as the camera comes
// down: fully drawn from BEAM_FULL_M up, gone below BEAM_GONE_M (camera height, m).
export const BEAM_FULL_M = 120
export const BEAM_GONE_M = 50
const BEAM_OPACITY = 0.65

export function beamOpacity(cameraHeight: number): number {
  const t = (cameraHeight - BEAM_GONE_M) / (BEAM_FULL_M - BEAM_GONE_M)
  return BEAM_OPACITY * Math.max(0, Math.min(1, t))
}

export function createOriginLayer(): Layer {
  const group = new Group()
  group.name = "origin"
  const ring = new Mesh(new RingGeometry(26, 34, 64), new MeshBasicMaterial({ color: 0xff3b30, side: DoubleSide }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.6
  // Plain (not additive) blending, so the beam reads red against a bright day sky as
  // well as at night.
  const beamMaterial = new MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: BEAM_OPACITY, depthWrite: false })
  const beam = new Mesh(new CylinderGeometry(1.5, 1.5, 160, 16, 1, true), beamMaterial)
  beam.position.y = 80
  // Always "drawn", so the camera height reaches the beam even when it fades to nothing.
  beam.frustumCulled = false
  beam.onBeforeRender = (_renderer, _scene, camera) => {
    beamMaterial.opacity = beamOpacity(camera.position.y)
  }
  return {
    id: "origin",
    group,
    async init() {
      group.add(ring, beam)
    },
    pick(ray: Raycaster) {
      return ray.intersectObject(ring, false).length > 0 ? "place:belfort" : null
    },
  }
}
