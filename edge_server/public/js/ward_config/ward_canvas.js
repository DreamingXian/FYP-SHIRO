// =============================================================================
// Ward Floor Plan 2D Vector Canvas Renderer (Real-Time Digital Twin)
// =============================================================================

/**
 * Core 2D architectural CAD renderer for any canvas element.
 * @param {HTMLCanvasElement} mapCanvas - Target canvas element
 * @param {Object} currentWard - Ward layout configuration object
 * @param {Object} options - Optional rendering flags
 */
function renderWardToCanvas(mapCanvas, currentWard, options = {}) {
  if (!mapCanvas) return;
  const mapCtx = mapCanvas.getContext('2d');
  if (!mapCtx) return;

  const width = mapCanvas.width || mapCanvas.clientWidth || 400;
  const height = mapCanvas.height || mapCanvas.clientHeight || 300;

  const ward = currentWard || {
    ward_id: 'WARD-001',
    room_title: 'Acute Care Ward 001',
    length_x: 6.40,
    width_y: 4.80,
    height_z: 2.60,
    door: { wall: 'SOUTH', x: 2.80, y: 0.00, width: 0.90 },
    layout_type: 'RECTANGLE',
    obstacles: [],
    beds: [],
    anchors: []
  };

  const roomX = ward.length_x || 6.40;
  const roomY = ward.width_y || 4.80;

  const padding = options.padding || 38;
  const availableW = Math.max(10, width - padding * 2);
  const availableH = Math.max(10, height - padding * 2);

  const scale = Math.min(availableW / roomX, availableH / roomY);
  const originX = padding + (availableW - (roomX * scale)) / 2;
  const originY = padding + (availableH - (roomY * scale)) / 2;

  // Background clear
  mapCtx.fillStyle = options.bgColor || '#0B1120';
  mapCtx.fillRect(0, 0, width, height);

  // 1. Draw Architectural Grid Lines
  mapCtx.strokeStyle = (options.bgColor === '#FFFFFF' || options.bgColor === '#fff') 
    ? 'rgba(0, 0, 0, 0.05)' 
    : 'rgba(255, 255, 255, 0.06)';
  mapCtx.lineWidth = 1;
  for (let x = 0; x <= roomX; x += 1.0) {
    mapCtx.beginPath();
    mapCtx.moveTo(originX + x * scale, originY);
    mapCtx.lineTo(originX + x * scale, originY + roomY * scale);
    mapCtx.stroke();
  }
  for (let y = 0; y <= roomY; y += 1.0) {
    mapCtx.beginPath();
    mapCtx.moveTo(originX, originY + y * scale);
    mapCtx.lineTo(originX + roomX * scale, originY + y * scale);
    mapCtx.stroke();
  }

  // Room Interior Floor Fill
  mapCtx.fillStyle = '#FFFFFF';
  mapCtx.fillRect(originX, originY, roomX * scale, roomY * scale);

  // Fine interior millimeter grid
  mapCtx.strokeStyle = '#F1F5F9';
  for (let x = 0; x <= roomX; x += 1.0) {
    mapCtx.beginPath();
    mapCtx.moveTo(originX + x * scale, originY);
    mapCtx.lineTo(originX + x * scale, originY + roomY * scale);
    mapCtx.stroke();
  }
  for (let y = 0; y <= roomY; y += 1.0) {
    mapCtx.beginPath();
    mapCtx.moveTo(originX, originY + y * scale);
    mapCtx.lineTo(originX + roomX * scale, originY + y * scale);
    mapCtx.stroke();
  }

  // 2. Obstacles / Cutouts
  if (Array.isArray(ward.obstacles)) {
    ward.obstacles.forEach(obs => {
      const ox = originX + obs.x * scale;
      const oy = originY + (roomY - (obs.y + obs.length)) * scale;
      const ow = obs.width * scale;
      const oh = obs.length * scale;
      const obsType = (obs.type || 'TOILET').toUpperCase();
      const obsHeight = obs.height !== undefined ? parseFloat(obs.height) : (obsType === 'TABLE' ? 0.75 : 2.00);

      if (obsType === 'CUPBOARD') {
        // Warm Wood / Cabinet styling
        mapCtx.fillStyle = '#FFFBEB';
        mapCtx.fillRect(ox, oy, ow, oh);
        mapCtx.strokeStyle = '#B45309';
        mapCtx.lineWidth = 2;
        mapCtx.strokeRect(ox, oy, ow, oh);

        // Center cabinet door divide line & handle knobs
        mapCtx.strokeStyle = '#D97706';
        mapCtx.lineWidth = 1.2;
        mapCtx.beginPath();
        if (ow >= oh) {
          // Vertical split down the middle
          const midX = ox + ow / 2;
          mapCtx.moveTo(midX, oy);
          mapCtx.lineTo(midX, oy + oh);
          mapCtx.stroke();
          // Door handles
          mapCtx.fillStyle = '#78350F';
          mapCtx.beginPath();
          mapCtx.arc(midX - 3, oy + oh / 2, 2, 0, Math.PI * 2);
          mapCtx.arc(midX + 3, oy + oh / 2, 2, 0, Math.PI * 2);
          mapCtx.fill();
        } else {
          // Horizontal split
          const midY = oy + oh / 2;
          mapCtx.moveTo(ox, midY);
          mapCtx.lineTo(ox + ow, midY);
          mapCtx.stroke();
          // Door handles
          mapCtx.fillStyle = '#78350F';
          mapCtx.beginPath();
          mapCtx.arc(ox + ow / 2, midY - 3, 2, 0, Math.PI * 2);
          mapCtx.arc(ox + ow / 2, midY + 3, 2, 0, Math.PI * 2);
          mapCtx.fill();
        }

        mapCtx.fillStyle = '#92400E';
        mapCtx.font = '700 9px sans-serif';
        mapCtx.fillText(`🚪 ${obs.label || 'Cupboard'} (${obsHeight.toFixed(1)}m)`, ox + 4, oy + 12);

      } else if (obsType === 'TABLE') {
        // Table / Desk styling
        mapCtx.fillStyle = '#F8FAFC';
        mapCtx.fillRect(ox, oy, ow, oh);
        mapCtx.strokeStyle = '#475569';
        mapCtx.lineWidth = 1.5;
        mapCtx.strokeRect(ox, oy, ow, oh);

        // 4 corner leg marks
        mapCtx.fillStyle = '#94A3B8';
        const legS = Math.min(6, Math.max(3, ow * 0.12));
        mapCtx.fillRect(ox + 2, oy + 2, legS, legS);
        mapCtx.fillRect(ox + ow - legS - 2, oy + 2, legS, legS);
        mapCtx.fillRect(ox + 2, oy + oh - legS - 2, legS, legS);
        mapCtx.fillRect(ox + ow - legS - 2, oy + oh - legS - 2, legS, legS);

        mapCtx.fillStyle = '#334155';
        mapCtx.font = '700 9px sans-serif';
        mapCtx.fillText(`🪑 ${obs.label || 'Table'} (${obsHeight.toFixed(1)}m)`, ox + 6, oy + oh / 2 + 3);

      } else {
        // TOILET, PARTITION, PILLAR, STORAGE (Hatched architectural partition)
        mapCtx.fillStyle = obsType === 'PILLAR' ? '#E2E8F0' : '#F8FAFC';
        mapCtx.fillRect(ox, oy, ow, oh);

        // Hatching
        mapCtx.save();
        mapCtx.beginPath();
        mapCtx.rect(ox, oy, ow, oh);
        mapCtx.clip();

        mapCtx.strokeStyle = obsType === 'PILLAR' ? '#94A3B8' : '#CBD5E1';
        mapCtx.lineWidth = 1;
        const hatchSpacing = obsType === 'PILLAR' ? 6 : 10;
        for (let h = -oh; h < ow + oh; h += hatchSpacing) {
          mapCtx.beginPath();
          mapCtx.moveTo(ox + h, oy);
          mapCtx.lineTo(ox + h + oh, oy + oh);
          mapCtx.stroke();
        }
        mapCtx.restore();

        mapCtx.strokeStyle = '#475569';
        mapCtx.lineWidth = 2;
        mapCtx.strokeRect(ox, oy, ow, oh);

        mapCtx.fillStyle = '#0F172A';
        mapCtx.font = '700 10px sans-serif';
        const icon = obsType === 'TOILET' ? '🚽 ' : (obsType === 'PILLAR' ? '🏛️ ' : (obsType === 'PARTITION' ? '🧱 ' : '📦 '));
        mapCtx.fillText(icon + (obs.label || obs.type), ox + 6, oy + oh / 2 - 2);
      }
    });
  }

  // 3. Room Perimeter Wall Outline
  mapCtx.strokeStyle = '#0F172A';
  mapCtx.lineWidth = 3.5;
  mapCtx.strokeRect(originX, originY, roomX * scale, roomY * scale);

  // Exterior Dimension Labels
  mapCtx.fillStyle = '#94A3B8';
  mapCtx.font = '700 11px JetBrains Mono, monospace';
  mapCtx.fillText(`L: ${roomX.toFixed(2)}m`, originX + (roomX * scale) / 2 - 25, originY - 10);
  mapCtx.fillText(`W: ${roomY.toFixed(2)}m`, originX - 35, originY + (roomY * scale) / 2);

  // 4. Doorway Placement
  const doorWall = ward.door?.wall || 'SOUTH';
  const doorPos = ward.door?.x ?? 2.80;
  const doorWidth = ward.door?.width || 0.90;

  let doorPx = originX;
  let doorPy = originY;
  let doorPw = doorWidth * scale;
  let doorPh = 8;

  if (doorWall === 'SOUTH') {
    doorPx = originX + doorPos * scale;
    doorPy = originY + roomY * scale - 4;
  } else if (doorWall === 'NORTH') {
    doorPx = originX + doorPos * scale;
    doorPy = originY - 4;
  } else if (doorWall === 'WEST') {
    doorPx = originX - 4;
    doorPy = originY + (roomY - (doorPos + doorWidth)) * scale;
    doorPw = 8;
    doorPh = doorWidth * scale;
  } else if (doorWall === 'EAST') {
    doorPx = originX + roomX * scale - 4;
    doorPy = originY + (roomY - (doorPos + doorWidth)) * scale;
    doorPw = 8;
    doorPh = doorWidth * scale;
  }

  mapCtx.fillStyle = '#D97706';
  mapCtx.fillRect(doorPx, doorPy, doorPw, doorPh);
  mapCtx.fillStyle = '#F59E0B';
  mapCtx.font = '700 10px sans-serif';
  if (doorWall === 'SOUTH') {
    mapCtx.fillText("🚪 Door Threshold", doorPx, doorPy + 18);
  } else if (doorWall === 'NORTH') {
    mapCtx.fillText("🚪 Door", doorPx, doorPy - 8);
  } else {
    mapCtx.fillText("🚪 Door", doorPx + 12, doorPy + doorPh / 2);
  }

  // 5. Hospital Beds Fleet
  if (Array.isArray(ward.beds)) {
    ward.beds.forEach(b => {
      const rot = parseInt(b.rotation_deg, 10) || 0;
      const isHorizontal = (rot === 90 || rot === 270);
      const spanXM = isHorizontal ? (b.length || 2.00) : (b.width || 0.90);
      const spanYM = isHorizontal ? (b.width || 0.90) : (b.length || 2.00);

      const bw = spanXM * scale;
      const bh = spanYM * scale;

      const bx = originX + b.x * scale;
      const by = originY + (roomY - (b.y + spanYM)) * scale;

      const isOccupied = b.status === 'OCCUPIED';
      const isUnavailable = b.status === 'UNAVAILABLE';

      // Colors: OCCUPIED (crimson), AVAILABLE (green/mint), UNAVAILABLE (gray)
      mapCtx.fillStyle = isOccupied ? '#FEF2F2' : (isUnavailable ? '#F8FAFC' : '#F0FDF4');
      mapCtx.strokeStyle = isOccupied ? '#EF4444' : (isUnavailable ? '#94A3B8' : '#10B981');
      mapCtx.lineWidth = 1.8;

      mapCtx.fillRect(bx, by, bw, bh);
      if (isUnavailable) {
        mapCtx.setLineDash([4, 3]);
      }
      mapCtx.strokeRect(bx, by, bw, bh);
      mapCtx.setLineDash([]);

      // Pillow at headboard according to rotation
      mapCtx.fillStyle = isOccupied ? '#FECACA' : (isUnavailable ? '#E2E8F0' : '#BBF7D0');
      mapCtx.strokeStyle = isOccupied ? '#FCA5A5' : (isUnavailable ? '#CBD5E1' : '#86EFAC');
      mapCtx.lineWidth = 1;

      if (rot === 0) {
        // Headboard North (top)
        const pilH = bh * 0.22;
        mapCtx.fillRect(bx + 3, by + 3, bw - 6, pilH);
        mapCtx.strokeRect(bx + 3, by + 3, bw - 6, pilH);
      } else if (rot === 180) {
        // Headboard South (bottom)
        const pilH = bh * 0.22;
        mapCtx.fillRect(bx + 3, by + bh - 3 - pilH, bw - 6, pilH);
        mapCtx.strokeRect(bx + 3, by + bh - 3 - pilH, bw - 6, pilH);
      } else if (rot === 90) {
        // Headboard East (right)
        const pilW = bw * 0.22;
        mapCtx.fillRect(bx + bw - 3 - pilW, by + 3, pilW, bh - 6);
        mapCtx.strokeRect(bx + bw - 3 - pilW, by + 3, pilW, bh - 6);
      } else if (rot === 270) {
        // Headboard West (left)
        const pilW = bw * 0.22;
        mapCtx.fillRect(bx + 3, by + 3, pilW, bh - 6);
        mapCtx.strokeRect(bx + 3, by + 3, pilW, bh - 6);
      }

      // Bed label & status centered
      mapCtx.save();
      mapCtx.textAlign = 'center';
      mapCtx.textBaseline = 'middle';
      mapCtx.fillStyle = isOccupied ? '#DC2626' : (isUnavailable ? '#64748B' : '#047857');
      mapCtx.font = '700 9px sans-serif';
      mapCtx.fillText(b.bed_code, bx + bw / 2, by + bh * 0.48);
      mapCtx.font = '600 8px sans-serif';
      mapCtx.fillText(b.status || 'AVAILABLE', bx + bw / 2, by + bh * 0.72);
      mapCtx.restore();
    });
  }

  // 5b. 3D Line-of-Sight Rays & Coverage Geometry (for Auto-Suggest Preview)
  if (options.show3dLosRays && Array.isArray(ward.anchors) && ward.anchors.length >= 3) {
    // Draw baseline trilateration triangle / coverage polygon
    mapCtx.save();
    mapCtx.fillStyle = 'rgba(14, 165, 233, 0.08)';
    mapCtx.strokeStyle = 'rgba(14, 165, 233, 0.45)';
    mapCtx.lineWidth = 1.5;
    mapCtx.setLineDash([4, 4]);
    mapCtx.beginPath();

    // Sort vertices angularly around centroid to ensure clean non-self-intersecting perimeter
    const pts = ward.anchors.map(a => ({
      x: originX + a.x * scale,
      y: originY + (roomY - a.y) * scale
    }));
    const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
    const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
    pts.sort((p1, p2) => Math.atan2(p1.y - cy, p1.x - cx) - Math.atan2(p2.y - cy, p2.x - cx));

    pts.forEach((p, i) => {
      if (i === 0) mapCtx.moveTo(p.x, p.y);
      else mapCtx.lineTo(p.x, p.y);
    });
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.stroke();
    mapCtx.setLineDash([]);
    mapCtx.restore();

    // Draw 3D Line-of-Sight rays connecting anchors to patient bed targets
    if (Array.isArray(ward.beds)) {
      const roomH = ward.height_z || 2.80;
      ward.anchors.forEach(a => {
        const ax = originX + a.x * scale;
        const ay = originY + (roomY - a.y) * scale;
        const anchorObj = { x: a.x, y: a.y, z: a.z || roomH };

        ward.beds.forEach(b => {
          const rot = parseInt(b.rotation_deg, 10) || 0;
          const isH = (rot === 90 || rot === 270);
          const spanX = isH ? (b.length || 2.00) : (b.width || 0.90);
          const spanY = isH ? (b.width || 0.90) : (b.length || 2.00);
          const bedCenterX = b.x + spanX / 2;
          const bedCenterY = b.y + spanY / 2;
          const targetObj = { x: bedCenterX, y: bedCenterY, z: 0.85 };

          const los = check3dRayLos(anchorObj, targetObj, ward.obstacles || [], roomH, a.mountedOnObsId);

          const bx = originX + bedCenterX * scale;
          const by = originY + (roomY - bedCenterY) * scale;

          mapCtx.save();
          mapCtx.beginPath();
          mapCtx.moveTo(ax, ay);
          mapCtx.lineTo(bx, by);
          if (los.clear) {
            mapCtx.strokeStyle = '#10B981'; // Green: clear 3D LOS over furniture
            mapCtx.lineWidth = 1.5;
            mapCtx.setLineDash([4, 3]);
          } else {
            mapCtx.strokeStyle = '#EF4444'; // Red: obstructed NLOS
            mapCtx.lineWidth = 2;
            mapCtx.setLineDash([2, 3]);
          }
          mapCtx.stroke();
          mapCtx.restore();
        });
      });
    }
  }

  // 6. Stationary BLE Anchors
  if (Array.isArray(ward.anchors)) {
    ward.anchors.forEach(a => {
      const px = originX + a.x * scale;
      const py = originY + (roomY - a.y) * scale;

      // 1m range ring
      mapCtx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
      mapCtx.lineWidth = 1;
      mapCtx.setLineDash([3, 3]);
      mapCtx.beginPath();
      mapCtx.arc(px, py, 1.0 * scale, 0, Math.PI * 2);
      mapCtx.stroke();
      mapCtx.setLineDash([]);

      // Anchor node dot
      mapCtx.fillStyle = options.show3dLosRays ? '#0284C7' : '#0284C7';
      mapCtx.beginPath();
      mapCtx.arc(px, py, 6, 0, Math.PI * 2);
      mapCtx.fill();
      mapCtx.strokeStyle = '#FFFFFF';
      mapCtx.lineWidth = 2;
      mapCtx.stroke();

      // Label
      mapCtx.fillStyle = '#0284C7';
      mapCtx.font = '700 10px sans-serif';
      const labelText = a.device_id ? `${a.anchor_id} (${a.device_id})` : `${a.anchor_id}`;
      mapCtx.fillText(labelText, px + 8, py + 4);

      if (options.show3dLosRays) {
        mapCtx.fillStyle = '#0369A1';
        mapCtx.font = '600 8.5px monospace';
        mapCtx.fillText(`(${a.x.toFixed(2)}m, ${a.y.toFixed(2)}m, ${Number(a.z || 2.8).toFixed(2)}m)`, px + 8, py + 14);
      }
    });
  }
}

function redrawWardMap() {
  const mapCanvas = document.getElementById('wardMapCanvas');
  if (!mapCanvas || !mapCanvas.parentElement) return;

  const parentW = mapCanvas.parentElement.clientWidth;
  const parentH = mapCanvas.parentElement.clientHeight;

  if (parentW < 100 || parentH < 100) return;

  mapCanvas.width = parentW;
  mapCanvas.height = parentH;

  renderWardToCanvas(mapCanvas, window.currentWard, { bgColor: '#FFFFFF' });

  const scaleText = document.getElementById('canvas-scale-text');
  if (scaleText && window.currentWard) {
    const roomX = window.currentWard.length_x || 6.40;
    const roomY = window.currentWard.width_y || 4.80;
    const padding = 38;
    const scale = Math.min((parentW - padding * 2) / roomX, (parentH - padding * 2) / roomY);
    scaleText.innerText = `Metric Scale: 1m = ${Math.round(scale)}px`;
  }
}

/**
 * 3D Line-of-Sight Ray-Casting & Obstacle Clearance Checker
 * Determines whether a line-of-sight ray between an anchor (at Az) and target (at Tz = 0.85m)
 * is clear or physically obstructed by 3D obstacles (considering their height).
 */
function check3dRayLos(A, T, obstacles, roomH = 2.80, ignoreObsId = null) {
  const dx = T.x - A.x;
  const dy = T.y - A.y;
  let isBlocked = false;
  let blockingObs = null;
  let minRayH = 999;
  const effectiveIgnoreId = ignoreObsId || A.mountedOnObsId;

  for (const obs of obstacles) {
    if (effectiveIgnoreId && (obs.id === effectiveIgnoreId || obs.label === effectiveIgnoreId)) continue;
    const xMin = obs.x;
    const xMax = obs.x + obs.width;
    const yMin = obs.y;
    const yMax = obs.y + obs.length;
    const obsH = obs.height !== undefined ? parseFloat(obs.height) : (obs.type === 'TABLE' ? 0.75 : roomH);

    let tMin = 0.01;
    let tMax = 1;

    // Liang-Barsky / Slab box clipping in 2D
    if (Math.abs(dx) < 1e-9) {
      if (A.x < xMin || A.x > xMax) continue;
    } else {
      let t1 = (xMin - A.x) / dx;
      let t2 = (xMax - A.x) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) continue;
    }

    if (Math.abs(dy) < 1e-9) {
      if (A.y < yMin || A.y > yMax) continue;
    } else {
      let t1 = (yMin - A.y) / dy;
      let t2 = (yMax - A.y) / dy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) continue;
    }

    if (tMax >= 0.01 && tMin <= 0.99) {
      // 2D segment intersects obstacle footprint
      const tPenetrationEnd = Math.min(1, Math.max(0, tMax));
      const rayH = A.z + tPenetrationEnd * (T.z - A.z);
      if (rayH < minRayH) minRayH = rayH;

      // If obstacle height exceeds ray height at penetration, ray is obstructed in 3D
      if (obsH >= rayH) {
        isBlocked = true;
        blockingObs = obs;
        break;
      }
    }
  }

  return {
    clear: !isBlocked,
    blockingObs: blockingObs ? (blockingObs.label || blockingObs.type) : null,
    minRayH: isFinite(minRayH) ? minRayH : null
  };
}

window.check3dRayLos = check3dRayLos;
window.renderWardToCanvas = renderWardToCanvas;
window.redrawWardMap = redrawWardMap;
