// =============================================================================
// SHIRO Edge Server - Ward zones (Phase 10)
// Divides a ward into the places a clinician cares about:
//   - each bed, with a 0.3 m margin around it (standing at or sitting on it)
//   - the door, 1 m deep into the room and 0.1 m wider than the door each side
//   - the rest of the room
// Used by the position test (was the patient placed in the right zone?) and
// later by the "left the ward" alert. Plain functions: no database, no clock.
// Coordinates: metres from the south-west corner, x towards east, y towards north.
// =============================================================================

const BED_MARGIN_M = 0.3;
const DOOR_DEPTH_M = 1.0;
const DOOR_SIDE_MARGIN_M = 0.1;
const OUTSIDE_MARGIN_M = 0.5;

const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The floor rectangle a bed covers: rotated 90 or 270 degrees, its length runs along x. */
function bedFootprint(bed) {
  const rot = ((parseInt(bed.rotation_deg, 10) || 0) % 360 + 360) % 360;
  const along = rot === 90 || rot === 270;
  const width = finite(bed.width, 0.9);
  const length = finite(bed.length, 2.0);
  return { x: finite(bed.x), y: finite(bed.y), w: along ? length : width, l: along ? width : length };
}

/** The door zone. door.x is the door's start along its wall (x on north/south walls, y on east/west walls). */
function doorRect(door, lengthX, widthY) {
  const offset = finite(door.x);
  const span = finite(door.width, 0.9) + 2 * DOOR_SIDE_MARGIN_M;
  const start = offset - DOOR_SIDE_MARGIN_M;
  switch (String(door.wall || '').toUpperCase()) {
    case 'NORTH': return { x: start, y: widthY - DOOR_DEPTH_M, w: span, l: DOOR_DEPTH_M };
    case 'EAST': return { x: lengthX - DOOR_DEPTH_M, y: start, w: DOOR_DEPTH_M, l: span };
    case 'WEST': return { x: 0, y: start, w: DOOR_DEPTH_M, l: span };
    case 'SOUTH': return { x: start, y: 0, w: span, l: DOOR_DEPTH_M };
    default: return null;
  }
}

function clip(rect, lengthX, widthY) {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(lengthX, rect.x + rect.w);
  const y1 = Math.min(widthY, rect.y + rect.l);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), l: Math.max(0, y1 - y0) };
}

const round2 = (v) => Math.round(v * 100) / 100;
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.l;

/**
 * The zones of a ward from its layout (ward_service.getWardConfig).
 * @returns {{lengthX: number, widthY: number, zones: Array<{id, type, label, rect}>}}
 */
function buildZones(layout) {
  const lengthX = finite(layout && layout.length_x, 0);
  const widthY = finite(layout && layout.width_y, 0);
  const zones = [];

  if (layout && layout.door) {
    const rect = doorRect(layout.door, lengthX, widthY);
    if (rect) zones.push({ id: 'DOOR', type: 'DOOR', label: 'Door', rect: clip(rect, lengthX, widthY) });
  }
  for (const bed of (layout && layout.beds) || []) {
    const f = bedFootprint(bed);
    const rect = clip({ x: f.x - BED_MARGIN_M, y: f.y - BED_MARGIN_M, w: f.w + 2 * BED_MARGIN_M, l: f.l + 2 * BED_MARGIN_M }, lengthX, widthY);
    const label = String(bed.bed_code || bed.bed_id || 'Bed');
    zones.push({ id: `BED:${label}`, type: 'BED', label, rect, centre: { x: f.x + f.w / 2, y: f.y + f.l / 2 } });
  }
  for (const z of zones) z.rect = { x: round2(z.rect.x), y: round2(z.rect.y), w: round2(z.rect.w), l: round2(z.rect.l) };
  return { lengthX, widthY, zones };
}

/**
 * The zone a point is in: the door first, then the nearest bed whose zone holds
 * it, else the rest of the room; more than 0.5 m outside the walls is OUTSIDE.
 * @returns {{id: string, type: 'DOOR'|'BED'|'ROOM'|'OUTSIDE', label: string}}
 */
function zoneAt(zoneMap, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { id: 'UNKNOWN', type: 'UNKNOWN', label: 'Unknown' };
  const { lengthX, widthY, zones } = zoneMap;
  if (x < -OUTSIDE_MARGIN_M || y < -OUTSIDE_MARGIN_M || x > lengthX + OUTSIDE_MARGIN_M || y > widthY + OUTSIDE_MARGIN_M) {
    return { id: 'OUTSIDE', type: 'OUTSIDE', label: 'Outside the ward' };
  }
  const door = zones.find(z => z.type === 'DOOR' && inside(z.rect, x, y));
  if (door) return { id: door.id, type: door.type, label: door.label };

  let best = null;
  let bestDistance = Infinity;
  for (const z of zones) {
    if (z.type !== 'BED' || !inside(z.rect, x, y)) continue;
    const d = Math.hypot(x - z.centre.x, y - z.centre.y);
    if (d < bestDistance) {
      best = z;
      bestDistance = d;
    }
  }
  if (best) return { id: best.id, type: best.type, label: best.label };
  return { id: 'ROOM', type: 'ROOM', label: 'Rest of the room' };
}

module.exports = { buildZones, zoneAt, bedFootprint, BED_MARGIN_M, DOOR_DEPTH_M, OUTSIDE_MARGIN_M };
