import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, RingGeometry, MeshBasicMaterial, DoubleSide } from "three"
import type { Layer } from "./types.ts"

// A marker on the venue (598 Broadway, the scene origin): a red pin and a ring on
// the ground. Part of the base, so the very first screenshot already has a target.
export function createVenueLayer(): Layer {
  const group = new Group()
  group.name = "venue"
  return {
    id: "venue",
    group,
    async init() {
      const pin = new Mesh(new CylinderGeometry(4, 4, 80, 24), new MeshStandardMaterial({ color: 0xff3b30 }))
      pin.position.y = 40
      const ring = new Mesh(
        new RingGeometry(14, 20, 48),
        new MeshBasicMaterial({ color: 0xff3b30, side: DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.5
      // Both again, fainter and through the buildings in front, like the selected
      // building's x-ray (layers/buildings.ts), and after the see-through subway, so
      // the marker shows from every view.
      for (const mesh of [pin, ring]) {
        const xray = new Mesh(
          mesh.geometry,
          new MeshBasicMaterial({ color: 0xff3b30, side: DoubleSide, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }),
        )
        xray.renderOrder = 2
        mesh.add(xray)
      }
      group.add(pin, ring)
    },
    summary: () => "598 Broadway",
  }
}
