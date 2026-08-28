import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Mask, MeshStats, Occupancy, Segment, ViewName, ViewState } from './types';

export const SIZE = { x: 12, y: 10, z: 10 } as const;

export function reconstruct(front: Mask, top: Mask, side: Mask): Occupancy {
  return Array.from({ length: SIZE.x }, (_, x) =>
    Array.from({ length: SIZE.y }, (_, y) =>
      Array.from({ length: SIZE.z }, (_, z) =>
        Boolean(front[SIZE.z - 1 - z]?.[x] && top[y]?.[x] && side[SIZE.z - 1 - z]?.[y]),
      ),
    ),
  );
}

export function buildGeometry(occupancy: Occupancy): { geometry: THREE.BufferGeometry; stats: MeshStats } {
  const positions: number[] = [];
  const normals: number[] = [];
  let voxels = 0;
  let faces = 0;

  const directions = [
    { delta: [1, 0, 0], normal: [1, 0, 0], corners: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]] },
    { delta: [-1, 0, 0], normal: [-1, 0, 0], corners: [[0,1,0],[0,0,0],[0,0,1],[0,1,1]] },
    { delta: [0, 1, 0], normal: [0, 0, -1], corners: [[1,1,0],[0,1,0],[0,1,1],[1,1,1]] },
    { delta: [0, -1, 0], normal: [0, 0, 1], corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
    { delta: [0, 0, 1], normal: [0, 1, 0], corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
    { delta: [0, 0, -1], normal: [0, -1, 0], corners: [[0,1,0],[1,1,0],[1,0,0],[0,0,0]] },
  ] as const;
  const order = [0, 1, 2, 0, 2, 3];

  for (let x = 0; x < SIZE.x; x += 1) {
    for (let y = 0; y < SIZE.y; y += 1) {
      for (let z = 0; z < SIZE.z; z += 1) {
        if (!occupancy[x]?.[y]?.[z]) continue;
        voxels += 1;
        for (const direction of directions) {
          const nx = x + direction.delta[0];
          const ny = y + direction.delta[1];
          const nz = z + direction.delta[2];
          if (getVoxel(occupancy, nx, ny, nz)) continue;
          faces += 1;
          for (const index of order) {
            const corner = direction.corners[index];
            positions.push(
              x + corner[0] - SIZE.x / 2,
              z + corner[2],
              SIZE.y / 2 - (y + corner[1]),
            );
            normals.push(...direction.normal);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  const merged = positions.length > 0 ? mergeVertices(geometry, 1e-4) : geometry;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return { geometry: merged, stats: { voxels, faces } };
}

/**
 * Reconhece a convenção clássica de um telhado de quatro águas:
 * - retângulo e cumeeira/espigões na vista superior;
 * - trapézio na frontal;
 * - triângulo na lateral.
 *
 * Ao contrário do reconstrutor voxelizado, preserva as coordenadas exatas
 * das linhas e cria quatro planos inclinados contínuos.
 */
export function buildHipRoofGeometry(
  views: Record<ViewName, ViewState>,
): { geometry: THREE.BufferGeometry; stats: MeshStats } | null {
  const top = views.top.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const front = views.front.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const side = views.side.segments.filter((segment) => segment.type === 'visible').map(normalized);
  if (top.length < 9 || front.length < 4 || side.length < 3) return null;

  const topPoints = top.flatMap((segment) => [
    { x: segment.x1, y: segment.y1 },
    { x: segment.x2, y: segment.y2 },
  ]);
  const minX = Math.min(...topPoints.map((point) => point.x));
  const maxX = Math.max(...topPoints.map((point) => point.x));
  const minY = Math.min(...topPoints.map((point) => point.y));
  const maxY = Math.max(...topPoints.map((point) => point.y));
  if (minX === maxX || minY === maxY) return null;

  const boundary = [
    [minX, minY, maxX, minY],
    [minX, maxY, maxX, maxY],
    [minX, minY, minX, maxY],
    [maxX, minY, maxX, maxY],
  ] as const;
  if (!boundary.every(([x1, y1, x2, y2]) => hasSegment(top, x1, y1, x2, y2))) return null;

  const ridge = top
    .filter((segment) => segment.y1 === segment.y2 && segment.x1 > minX && segment.x2 < maxX && segment.y1 > minY && segment.y1 < maxY)
    .sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1))[0];
  if (!ridge) return null;
  const ridgeY = ridge.y1;

  const hipEdges = [
    [minX, minY, ridge.x1, ridgeY],
    [minX, maxY, ridge.x1, ridgeY],
    [maxX, minY, ridge.x2, ridgeY],
    [maxX, maxY, ridge.x2, ridgeY],
  ] as const;
  if (!hipEdges.every(([x1, y1, x2, y2]) => hasSegment(top, x1, y1, x2, y2))) return null;

  const frontBase = front.find((segment) =>
    segment.y1 === segment.y2 && segment.x1 === minX && segment.x2 === maxX,
  );
  const frontRidge = front.find((segment) =>
    segment.y1 === segment.y2 && segment.x1 === ridge.x1 && segment.x2 === ridge.x2,
  );
  if (!frontBase || !frontRidge || frontRidge.y1 >= frontBase.y1) return null;
  if (!hasSegment(front, minX, frontBase.y1, ridge.x1, frontRidge.y1) ||
      !hasSegment(front, ridge.x2, frontRidge.y1, maxX, frontBase.y1)) return null;

  const sideBase = side.find((segment) =>
    segment.y1 === segment.y2 && segment.x1 === minY && segment.x2 === maxY,
  );
  if (!sideBase) return null;
  if (!hasSegment(side, minY, sideBase.y1, ridgeY, frontRidge.y1) ||
      !hasSegment(side, ridgeY, frontRidge.y1, maxY, sideBase.y1)) return null;

  // Alturas de frontal e lateral precisam representar o mesmo beiral.
  if (sideBase.y1 !== frontBase.y1) return null;

  const eaveHeight = views.front.rows - frontBase.y1;
  const ridgeHeight = views.front.rows - frontRidge.y1;
  const world = (x: number, y: number, height: number) => new THREE.Vector3(
    x - SIZE.x / 2,
    height,
    SIZE.y / 2 - y,
  );

  const nearLeft = world(minX, minY, eaveHeight);
  const nearRight = world(maxX, minY, eaveHeight);
  const farRight = world(maxX, maxY, eaveHeight);
  const farLeft = world(minX, maxY, eaveHeight);
  const ridgeLeft = world(ridge.x1, ridgeY, ridgeHeight);
  const ridgeRight = world(ridge.x2, ridgeY, ridgeHeight);

  const positions: number[] = [];
  const addTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const addQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    addTriangle(a, b, c);
    addTriangle(a, c, d);
  };

  // Ordem anti-horária vista pelo lado externo/superior de cada água.
  addQuad(nearLeft, nearRight, ridgeRight, ridgeLeft);
  addQuad(farRight, farLeft, ridgeLeft, ridgeRight);
  addTriangle(farLeft, nearLeft, ridgeLeft);
  addTriangle(nearRight, farRight, ridgeRight);
  // Fecha a parte inferior na altura do beiral. A ordem produz normal
  // voltada para baixo, deixando o fundo visível quando o modelo é girado.
  addQuad(nearLeft, farLeft, farRight, nearRight);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.modelKind = 'hip-roof';
  return { geometry, stats: { voxels: 0, faces: 4, vertices: 6 } };
}

export function createExampleViews(): Record<ViewName, ViewState> {
  const occupancy = createExampleOccupancy();
  const masks = projectOccupancy(occupancy);
  const views: Record<ViewName, ViewState> = {
    front: { cols: SIZE.x, rows: SIZE.z, segments: maskToSegments(masks.front) },
    top: { cols: SIZE.x, rows: SIZE.y, segments: maskToSegments(masks.top) },
    side: { cols: SIZE.y, rows: SIZE.z, segments: maskToSegments(masks.side) },
  };

  views.side.segments.push({ id: crypto.randomUUID(), x1: 0, y1: 8, x2: 7, y2: 8, type: 'hidden' });
  views.top.segments.push({ id: crypto.randomUUID(), x1: 7, y1: 0, x2: 7, y2: 4, type: 'hidden' });
  return views;
}

function createExampleOccupancy(): Occupancy {
  const occupancy = Array.from({ length: SIZE.x }, () =>
    Array.from({ length: SIZE.y }, () => Array(SIZE.z).fill(false)),
  );

  // Base com rasgo inferior frontal.
  fillBox(occupancy, 1, 10, 2, 8, 0, 2);
  clearBox(occupancy, 7, 9, 2, 4, 0, 1);

  // Parede posterior alta e ressalto à esquerda, inspirados no exercício.
  fillBox(occupancy, 4, 10, 6, 8, 2, 8);
  fillBox(occupancy, 1, 3, 6, 8, 2, 5);
  return occupancy;
}

function fillBox(occupancy: Occupancy, x1: number, x2: number, y1: number, y2: number, z1: number, z2: number): void {
  for (let x = x1; x < x2; x += 1) for (let y = y1; y < y2; y += 1) for (let z = z1; z < z2; z += 1) occupancy[x][y][z] = true;
}

function clearBox(occupancy: Occupancy, x1: number, x2: number, y1: number, y2: number, z1: number, z2: number): void {
  for (let x = x1; x < x2; x += 1) for (let y = y1; y < y2; y += 1) for (let z = z1; z < z2; z += 1) occupancy[x][y][z] = false;
}

function projectOccupancy(occupancy: Occupancy): Record<ViewName, Mask> {
  const front = Array.from({ length: SIZE.z }, () => Array(SIZE.x).fill(false));
  const top = Array.from({ length: SIZE.y }, () => Array(SIZE.x).fill(false));
  const side = Array.from({ length: SIZE.z }, () => Array(SIZE.y).fill(false));

  for (let x = 0; x < SIZE.x; x += 1) {
    for (let y = 0; y < SIZE.y; y += 1) {
      for (let z = 0; z < SIZE.z; z += 1) {
        if (!occupancy[x][y][z]) continue;
        front[SIZE.z - 1 - z][x] = true;
        top[y][x] = true;
        side[SIZE.z - 1 - z][y] = true;
      }
    }
  }
  return { front, top, side };
}

function maskToSegments(mask: Mask): Segment[] {
  const rows = mask.length;
  const cols = mask[0]?.length ?? 0;
  const unit: Segment[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number) => unit.push({
    id: crypto.randomUUID(), x1, y1, x2, y2, type: 'visible',
  });

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (!mask[y][x]) continue;
      if (!mask[y - 1]?.[x]) add(x, y, x + 1, y);
      if (!mask[y + 1]?.[x]) add(x, y + 1, x + 1, y + 1);
      if (!mask[y]?.[x - 1]) add(x, y, x, y + 1);
      if (!mask[y]?.[x + 1]) add(x + 1, y, x + 1, y + 1);
    }
  }
  return mergeCollinear(unit);
}

function mergeCollinear(segments: Segment[]): Segment[] {
  const horizontal = new Map<number, Array<[number, number]>>();
  const vertical = new Map<number, Array<[number, number]>>();
  for (const segment of segments) {
    if (segment.y1 === segment.y2) {
      const list = horizontal.get(segment.y1) ?? [];
      list.push([Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2)]);
      horizontal.set(segment.y1, list);
    } else {
      const list = vertical.get(segment.x1) ?? [];
      list.push([Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2)]);
      vertical.set(segment.x1, list);
    }
  }

  const result: Segment[] = [];
  for (const [y, ranges] of horizontal) {
    for (const [start, end] of mergeRanges(ranges)) result.push({ id: crypto.randomUUID(), x1: start, y1: y, x2: end, y2: y, type: 'visible' });
  }
  for (const [x, ranges] of vertical) {
    for (const [start, end] of mergeRanges(ranges)) result.push({ id: crypto.randomUUID(), x1: x, y1: start, x2: x, y2: end, type: 'visible' });
  }
  return result;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function getVoxel(occupancy: Occupancy, x: number, y: number, z: number): boolean {
  return Boolean(occupancy[x]?.[y]?.[z]);
}

function normalized(segment: Segment): Segment {
  return segment.x1 > segment.x2 || (segment.x1 === segment.x2 && segment.y1 > segment.y2)
    ? { ...segment, x1: segment.x2, y1: segment.y2, x2: segment.x1, y2: segment.y1 }
    : segment;
}

function hasSegment(segments: Segment[], x1: number, y1: number, x2: number, y2: number): boolean {
  const target = normalized({ id: '', type: 'visible', x1, y1, x2, y2 });
  return segments.some((segment) => {
    const line = normalized(segment);
    return line.x1 === target.x1 && line.y1 === target.y1 && line.x2 === target.x2 && line.y2 === target.y2;
  });
}
