import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Raycaster,
} from "three"
import type { Layer } from "./types.ts"

// A marker on the scene origin, the Belfry: a red ring on the ground and a thin red
// beam of light rising from it. Part of the base, so the very first screenshot
// already has a target; the Belfry itself is drawn by the buildings layer (T1).
export function createOriginLayer(): Layer {
  const group = new Group()
  group.name = "origin"
  const ring = new Mesh(new RingGeometry(26, 34, 64), new MeshBasicMaterial({ color: 0xff3b30, side: DoubleSide }))
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.6
  const beam = new Mesh(
    new CylinderGeometry(1.5, 1.5, 160, 16, 1, true),
    new MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }),
  )
  beam.position.y = 80
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
