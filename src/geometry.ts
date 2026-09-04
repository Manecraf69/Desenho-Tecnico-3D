import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LineType, Mask, MeshStats, Occupancy, Segment, ViewName, ViewState } from './types';

export const SIZE = { x: 10, y: 10, z: 10 } as const;
export const RESOLUTION = 2;
const CELL = 1 / RESOLUTION;
const GRID = { x: SIZE.x * RESOLUTION, y: SIZE.y * RESOLUTION, z: SIZE.z * RESOLUTION } as const;

export function reconstruct(front: Mask, top: Mask, side: Mask): Occupancy {
  const occupancy = Array.from({ length: GRID.x }, (_, x) =>
    Array.from({ length: GRID.y }, (_, y) =>
      Array.from({ length: GRID.z }, (_, z) =>
        Boolean(front[GRID.z - 1 - z]?.[x] && top[y]?.[x] && side[GRID.z - 1 - z]?.[y]),
      ),
    ),
  );
  return occupancy;
}

export function reconstructFromViews(
  views: Record<ViewName, ViewState>, front: Mask, top: Mask, side: Mask,
): Occupancy {
  const occupancy = reconstruct(front, top, side);
  const diagonalFront = views.front.segments.filter((segment) => segment.type === 'visible' && segment.x1 !== segment.x2 && segment.y1 !== segment.y2);
  const diagonalSide = views.side.segments.filter((segment) => segment.type === 'visible' && segment.x1 !== segment.x2 && segment.y1 !== segment.y2);
  const topPointsForCut = views.top.segments.flatMap((segment) => [
    { x: segment.x1, y: segment.y1 },
    { x: segment.x2, y: segment.y2 },
  ]);
  const minWidth = Math.min(...topPointsForCut.map((point) => point.x));
  const maxWidth = Math.max(...topPointsForCut.map((point) => point.x));
  const innerDepthSegments = views.top.segments.filter((segment) => segment.type === 'visible' &&
    (segment.x1 !== segment.x2 || (segment.y1 !== 3 && segment.y1 !== 7)));
  const cutMinDepth = innerDepthSegments.length > 0
    ? Math.min(...innerDepthSegments.flatMap((segment) => [segment.y1, segment.y2]))
    : Math.min(...views.top.segments.flatMap((segment) => [segment.y1, segment.y2]));
  const cutMaxDepth = innerDepthSegments.length > 0
    ? Math.max(...innerDepthSegments.flatMap((segment) => [segment.y1, segment.y2]))
    : Math.max(...views.top.segments.flatMap((segment) => [segment.y1, segment.y2]));

  // A diagonal projection edge is a height boundary, not a decoration. Cut
  // the cells above that boundary while respecting the footprint in top view.
  for (const segment of diagonalFront) {
    const start = Math.min(segment.x1, segment.x2);
    const end = Math.max(segment.x1, segment.x2);
    for (let x = 0; x < GRID.x; x += 1) {
      const xCoord = (x + 0.5) / RESOLUTION;
      if (xCoord < start || xCoord > end) continue;
      const ratio = (xCoord - segment.x1) / (segment.x2 - segment.x1);
      const limitRow = segment.y1 + (segment.y2 - segment.y1) * ratio;
      for (let y = 0; y < GRID.y; y += 1) {
        const depth = (y + 0.5) / RESOLUTION;
        if (depth < cutMinDepth || depth > cutMaxDepth) continue;
        for (let z = 0; z < GRID.z; z += 1) {
          const row = (GRID.z - z - 0.5) / RESOLUTION;
          if (row < limitRow) occupancy[x][y][z] = false;
        }
      }
    }
  }

  for (const segment of diagonalSide) {
    const start = Math.min(segment.x1, segment.x2);
    const end = Math.max(segment.x1, segment.x2);
    for (let y = 0; y < GRID.y; y += 1) {
      const yCoord = (y + 0.5) / RESOLUTION;
      if (yCoord < start || yCoord > end) continue;
      const ratio = (yCoord - segment.x1) / (segment.x2 - segment.x1);
      const limitRow = segment.y1 + (segment.y2 - segment.y1) * ratio;
      for (let x = 0; x < GRID.x; x += 1) {
        const width = (x + 0.5) / RESOLUTION;
        if (width < minWidth || width > maxWidth) continue;
        for (let z = 0; z < GRID.z; z += 1) {
          const row = (GRID.z - z - 0.5) / RESOLUTION;
          if (row < limitRow) occupancy[x][y][z] = false;
        }
      }
    }
  }
  return occupancy;
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

  for (let x = 0; x < GRID.x; x += 1) {
    for (let y = 0; y < GRID.y; y += 1) {
      for (let z = 0; z < GRID.z; z += 1) {
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
              (x + corner[0]) * CELL - SIZE.x / 2,
              (z + corner[2]) * CELL,
              SIZE.y / 2 - (y + corner[1]) * CELL,
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

export function buildGeometryWithInclinedEdges(
  occupancy: Occupancy,
  views: Record<ViewName, ViewState>,
): { geometry: THREE.BufferGeometry; stats: MeshStats } {
  const base = buildGeometry(occupancy);
  const planes: THREE.BufferGeometry[] = [];
  const topPoints = views.top.segments.flatMap((segment) => [
    { x: segment.x1, y: segment.y1 },
    { x: segment.x2, y: segment.y2 },
  ]);
  const minDepth = Math.min(...topPoints.map((point) => point.y));
  const maxDepth = Math.max(...topPoints.map((point) => point.y));
  const minWidth = Math.min(...topPoints.map((point) => point.x));
  const maxWidth = Math.max(...topPoints.map((point) => point.x));

  for (const segment of views.front.segments) {
    if (segment.type !== 'visible' || segment.x1 === segment.x2 || segment.y1 === segment.y2) continue;
    planes.push(createFrontInclinedPlane(segment, minDepth, maxDepth));
  }
  for (const segment of views.side.segments) {
    if (segment.type !== 'visible' || segment.x1 === segment.x2 || segment.y1 === segment.y2) continue;
    planes.push(createSideInclinedPlane(segment, minWidth, maxWidth));
  }
  if (planes.length === 0) return base;

  const geometry = mergeGeometries([base.geometry, ...planes], false);
  if (!geometry) {
    planes.forEach((plane) => plane.dispose());
    return base;
  }
  base.geometry.dispose();
  planes.forEach((plane) => plane.dispose());
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, stats: { ...base.stats, faces: base.stats.faces + planes.length } };
}

export function buildChamferedChannelGeometry(
  views: Record<ViewName, ViewState>,
): { geometry: THREE.BufferGeometry; stats: MeshStats } | null {
  const front = views.front.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const top = views.top.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const side = views.side.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const diagonal = front
    .filter((segment) => segment.x1 !== segment.x2 && segment.y1 !== segment.y2)
    .sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1))[0];
  if (!diagonal) return null;

  const topPoints = top.flatMap((segment) => [
    { x: segment.x1, y: segment.y1 },
    { x: segment.x2, y: segment.y2 },
  ]);
  const minX = Math.min(...topPoints.map((point) => point.x));
  const maxX = Math.max(...topPoints.map((point) => point.x));
  const minY = Math.min(...topPoints.map((point) => point.y));
  const maxY = Math.max(...topPoints.map((point) => point.y));
  if (!Number.isFinite(minX) || minX === maxX || minY === maxY) return null;
  if (!hasSegment(top, minX, minY, maxX, minY) ||
      !hasSegment(top, minX, maxY, maxX, maxY) ||
      !hasSegment(top, minX, minY, minX, maxY) ||
      !hasSegment(top, maxX, minY, maxX, maxY)) return null;

  const highEnd = diagonal.y1 < diagonal.y2
    ? { x: diagonal.x1, row: diagonal.y1 }
    : { x: diagonal.x2, row: diagonal.y2 };
  const lowEnd = diagonal.y1 > diagonal.y2
    ? { x: diagonal.x1, row: diagonal.y1 }
    : { x: diagonal.x2, row: diagonal.y2 };
  const middle = front.find((segment) =>
    segment.y1 === segment.y2 && segment.y1 > highEnd.row && segment.y1 < lowEnd.row && segment.x2 === maxX,
  );
  if (!middle) return null;

  const channelStart = top.find((segment) =>
    segment.y1 === segment.y2 && segment.x1 === minX && segment.x2 === highEnd.x &&
    segment.y1 > minY && segment.y1 < maxY,
  )?.y1;
  const stepDepth = top.find((segment) =>
    segment.y1 === segment.y2 && segment.x1 === middle.x1 && segment.x2 === maxX &&
    segment.y1 > (channelStart ?? minY) && segment.y1 < maxY,
  )?.y1;
  if (channelStart === undefined || stepDepth === undefined) return null;

  // Estas cinco linhas da planta dividem o topo nas quatro superfícies
  // contínuas mostradas pelas vistas frontal e lateral.
  if (!hasSegment(top, highEnd.x, channelStart, highEnd.x, stepDepth) ||
      !hasSegment(top, middle.x1, stepDepth, middle.x1, maxY) ||
      !hasSegment(top, lowEnd.x, channelStart, lowEnd.x, maxY)) return null;
  if (!hasSegment(side, minY, highEnd.row, stepDepth, highEnd.row) ||
      !hasSegment(side, channelStart, highEnd.row, channelStart, lowEnd.row) ||
      !hasSegment(side, channelStart, lowEnd.row, maxY, lowEnd.row) ||
      !hasSegment(side, stepDepth, highEnd.row, stepDepth, middle.y1) ||
      !hasSegment(side, stepDepth, middle.y1, maxY, middle.y1)) return null;

  const baseRow = Math.max(...front.flatMap((segment) => [segment.y1, segment.y2]));
  const rowToHeight = (row: number) => views.front.rows - row;
  const baseHeight = rowToHeight(baseRow);
  const highHeight = rowToHeight(highEnd.row);
  const middleHeight = rowToHeight(middle.y1);
  const lowHeight = rowToHeight(lowEnd.row);
  if (!(baseHeight < lowHeight && lowHeight < middleHeight && middleHeight < highHeight)) return null;

  const positions: number[] = [];
  const point = (x: number, depth: number, height: number) => new THREE.Vector3(
    x - SIZE.x / 2,
    height,
    SIZE.y / 2 - depth,
  );
  const addTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const addQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    addTriangle(a, b, c);
    addTriangle(a, c, d);
  };
  const addTopQuad = (
    x1: number, x2: number, y1: number, y2: number,
    heightAt: (x: number, depth: number) => number,
  ) => addQuad(
    point(x1, y1, heightAt(x1, y1)), point(x2, y1, heightAt(x2, y1)),
    point(x2, y2, heightAt(x2, y2)), point(x1, y2, heightAt(x1, y2)),
  );

  const flatHigh = () => highHeight;
  const flatMiddle = () => middleHeight;
  const flatLow = () => lowHeight;
  const centralSlope = (x: number) => lowHeight +
    ((x - lowEnd.x) / (highEnd.x - lowEnd.x)) * (highHeight - lowHeight);

  // Mesa alta em L, piso baixo, plano central inclinado e mesa intermediária.
  // A divisão usa arestas coincidentes dos dois lados. Isso evita que o
  // EdgesGeometry interprete junções em T coplanares como arestas visíveis.
  addTopQuad(minX, highEnd.x, minY, channelStart, flatHigh);
  addTopQuad(highEnd.x, maxX, minY, channelStart, flatHigh);
  addTopQuad(highEnd.x, maxX, channelStart, stepDepth, flatHigh);
  addTopQuad(minX, lowEnd.x, channelStart, maxY, flatLow);
  addTopQuad(lowEnd.x, middle.x1, channelStart, stepDepth, centralSlope);
  addTopQuad(middle.x1, highEnd.x, channelStart, stepDepth, centralSlope);
  addTopQuad(lowEnd.x, middle.x1, stepDepth, maxY, centralSlope);
  addTopQuad(middle.x1, maxX, stepDepth, maxY, flatMiddle);

  // Paredes internas onde duas regiões da planta têm alturas distintas.
  addQuad(
    point(lowEnd.x, channelStart, lowHeight), point(minX, channelStart, lowHeight),
    point(minX, channelStart, highHeight), point(lowEnd.x, channelStart, highHeight),
  );
  addTriangle(
    point(highEnd.x, channelStart, highHeight),
    point(lowEnd.x, channelStart, lowHeight),
    point(lowEnd.x, channelStart, highHeight),
  );
  addQuad(
    point(maxX, stepDepth, middleHeight), point(highEnd.x, stepDepth, middleHeight),
    point(highEnd.x, stepDepth, highHeight), point(maxX, stepDepth, highHeight),
  );
  addTriangle(
    point(highEnd.x, stepDepth, middleHeight),
    point(middle.x1, stepDepth, middleHeight),
    point(highEnd.x, stepDepth, highHeight),
  );

  // Laterais externas e fundo fecham o sólido sem introduzir voxels.
  addQuad(
    point(minX, minY, baseHeight), point(maxX, minY, baseHeight),
    point(maxX, minY, highHeight), point(minX, minY, highHeight),
  );
  addQuad(
    point(maxX, minY, baseHeight), point(maxX, stepDepth, baseHeight),
    point(maxX, stepDepth, highHeight), point(maxX, minY, highHeight),
  );
  addQuad(
    point(maxX, stepDepth, baseHeight), point(maxX, maxY, baseHeight),
    point(maxX, maxY, middleHeight), point(maxX, stepDepth, middleHeight),
  );
  addQuad(
    point(minX, channelStart, baseHeight), point(minX, minY, baseHeight),
    point(minX, minY, lowHeight), point(minX, channelStart, lowHeight),
  );
  addQuad(
    point(minX, channelStart, lowHeight), point(minX, minY, lowHeight),
    point(minX, minY, highHeight), point(minX, channelStart, highHeight),
  );
  addQuad(
    point(minX, maxY, baseHeight), point(minX, channelStart, baseHeight),
    point(minX, channelStart, lowHeight), point(minX, maxY, lowHeight),
  );
  addQuad(
    point(lowEnd.x, maxY, baseHeight), point(minX, maxY, baseHeight),
    point(minX, maxY, lowHeight), point(lowEnd.x, maxY, lowHeight),
  );
  addQuad(
    point(middle.x1, maxY, baseHeight), point(lowEnd.x, maxY, baseHeight),
    point(lowEnd.x, maxY, lowHeight), point(middle.x1, maxY, middleHeight),
  );
  addQuad(
    point(maxX, maxY, baseHeight), point(middle.x1, maxY, baseHeight),
    point(middle.x1, maxY, middleHeight), point(maxX, maxY, middleHeight),
  );
  addQuad(
    point(minX, minY, baseHeight), point(minX, maxY, baseHeight),
    point(maxX, maxY, baseHeight), point(maxX, minY, baseHeight),
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.modelKind = 'chamfered-channel';
  const uniqueVertices = new Set<string>();
  for (let index = 0; index < positions.length; index += 3) {
    uniqueVertices.add(`${positions[index]},${positions[index + 1]},${positions[index + 2]}`);
  }
  return { geometry, stats: { voxels: 0, faces: positions.length / 9, vertices: uniqueVertices.size } };
}

/**
 * Reconhece qualquer perfil frontal fechado extrudado em profundidade.
 * Funciona com perfis convexos ou côncavos e preserva todas as diagonais
 * como faces planas contínuas, sem recorrer à grade voxelizada.
 */
export function buildExtrudedProfileGeometry(
  views: Record<ViewName, ViewState>,
): { geometry: THREE.BufferGeometry; stats: MeshStats } | null {
  const front = views.front.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const top = views.top.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const side = views.side.segments.filter((segment) => segment.type === 'visible').map(normalized);
  const initialProfile = orderedClosedProfile(front);
  if (!initialProfile || initialProfile.length < 3 || !front.some((segment) => segment.x1 !== segment.x2 && segment.y1 !== segment.y2)) return null;
  let profile = initialProfile;
  const profileMinX = Math.min(...profile.map((vertex) => vertex.x));
  const profileMaxX = Math.max(...profile.map((vertex) => vertex.x));
  const profileMinRow = Math.min(...profile.map((vertex) => vertex.row));
  const profileMaxRow = Math.max(...profile.map((vertex) => vertex.row));

  const topPoints = top.flatMap((segment) => [
    { x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 },
  ]);
  const minX = Math.min(...topPoints.map((point) => point.x));
  const maxX = Math.max(...topPoints.map((point) => point.x));
  const minDepth = Math.min(...topPoints.map((point) => point.y));
  const maxDepth = Math.max(...topPoints.map((point) => point.y));
  if (minX !== profileMinX || maxX !== profileMaxX || minDepth === maxDepth) return null;
  if (!hasSegment(top, minX, minDepth, maxX, minDepth) ||
      !hasSegment(top, minX, maxDepth, maxX, maxDepth) ||
      !hasSegment(top, minX, minDepth, minX, maxDepth) ||
      !hasSegment(top, maxX, minDepth, maxX, maxDepth)) return null;

  if (!hasSegment(side, minDepth, profileMinRow, minDepth, profileMaxRow) ||
      !hasSegment(side, maxDepth, profileMinRow, maxDepth, profileMaxRow) ||
      !coversHorizontal(side, profileMinRow, minDepth, maxDepth) ||
      !coversHorizontal(side, profileMaxRow, minDepth, maxDepth)) return null;

  const height = (row: number) => views.front.rows - row;
  const signedArea = profile.reduce((sum, vertex, index) => {
    const next = profile[(index + 1) % profile.length];
    return sum + vertex.x * height(next.row) - next.x * height(vertex.row);
  }, 0);
  if (signedArea < 0) profile = [...profile].reverse();

  const point = (x: number, depth: number, h: number) => new THREE.Vector3(
    x - SIZE.x / 2, h, SIZE.y / 2 - depth,
  );
  const crossSection = profile.map((vertex) => ({ x: vertex.x, height: height(vertex.row) }));
  const near = crossSection.map((vertex) => point(vertex.x, minDepth, vertex.height));
  const far = crossSection.map((vertex) => point(vertex.x, maxDepth, vertex.height));
  const positions: number[] = [];
  const addTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const addQuad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    addTriangle(a, b, c);
    addTriangle(a, c, d);
  };

  // O triangulador do Three.js preserva corretamente os entalhes côncavos.
  const triangles = THREE.ShapeUtils.triangulateShape(
    crossSection.map((vertex) => new THREE.Vector2(vertex.x, vertex.height)),
    [],
  );
  for (const [aIndex, bIndex, cIndex] of triangles) {
    let a = near[aIndex]; let b = near[bIndex]; let c = near[cIndex];
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (normal.z < 0) [b, c] = [c, b];
    addTriangle(a, b, c);
    addTriangle(far[aIndex], far[cIndex], far[bIndex]);
  }
  // Extrusão de cada aresta do perfil frontal.
  for (let index = 0; index < near.length; index += 1) {
    const next = (index + 1) % near.length;
    addQuad(near[index], far[index], far[next], near[next]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.modelKind = 'extruded-profile';
  return { geometry, stats: { voxels: 0, faces: positions.length / 9, vertices: near.length + far.length } };
}

// Mantém a API usada por integrações anteriores.
export function buildGabledPrismGeometry(
  views: Record<ViewName, ViewState>,
): { geometry: THREE.BufferGeometry; stats: MeshStats } | null {
  return buildExtrudedProfileGeometry(views);
}

function createFrontInclinedPlane(segment: Segment, minDepth: number, maxDepth: number): THREE.BufferGeometry {
  const point = (x: number, row: number, depth: number) => new THREE.Vector3(
    x - SIZE.x / 2,
    SIZE.z - row,
    SIZE.y / 2 - depth,
  );
  return createPlane(point(segment.x1, segment.y1, minDepth), point(segment.x2, segment.y2, minDepth),
    point(segment.x2, segment.y2, maxDepth), point(segment.x1, segment.y1, maxDepth));
}

function createSideInclinedPlane(segment: Segment, minWidth: number, maxWidth: number): THREE.BufferGeometry {
  const point = (depth: number, row: number, x: number) => new THREE.Vector3(
    x - SIZE.x / 2,
    SIZE.z - row,
    SIZE.y / 2 - depth,
  );
  return createPlane(point(segment.x1, segment.y1, minWidth), point(segment.x2, segment.y2, minWidth),
    point(segment.x2, segment.y2, maxWidth), point(segment.x1, segment.y1, maxWidth));
}

function createPlane(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z,
    a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z,
  ], 3));
  geometry.computeVertexNormals();
  return geometry;
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
  const segment = (x1: number, y1: number, x2: number, y2: number, type: LineType = 'visible'): Segment => ({
    id: crypto.randomUUID(), x1, y1, x2, y2, type,
  });
  return {
    front: {
      cols: 10,
      rows: 10,
      segments: [
        segment(2, 3, 3, 3), segment(2, 3, 2, 6), segment(3, 3, 3, 4),
        segment(3, 4, 4, 4), segment(4, 2, 4, 4), segment(4, 2, 7, 2),
        segment(7, 2, 7, 6), segment(6, 6, 7, 6), segment(6, 5.5, 6, 6),
        segment(5, 5.5, 5, 6), segment(5, 5.5, 6, 5.5), segment(2, 6, 5, 6),
        segment(2, 5, 7, 5),
      ],
    },
    top: {
      cols: 10,
      rows: 10,
      segments: [
        segment(2, 4, 2, 7), segment(7, 4, 7, 7), segment(2, 7, 7, 7),
        segment(2, 4, 7, 4), segment(3, 4, 3, 5), segment(4, 4, 4, 5),
        segment(2, 5, 7, 5), segment(5, 4, 5, 7, 'hidden'), segment(6, 4, 6, 7, 'hidden'),
      ],
    },
    side: {
      cols: 10,
      rows: 10,
      segments: [
        segment(4, 2, 4, 6), segment(4, 2, 5, 2), segment(4, 6, 7, 6),
        segment(7, 5, 7, 6), segment(5, 5, 7, 5), segment(5, 2, 5, 5),
        segment(4, 3, 5, 3), segment(4, 4, 5, 4, 'hidden'), segment(4, 5.5, 7, 5.5, 'hidden'),
      ],
    },
  };
}

function createExampleOccupancy(): Occupancy {
  const occupancy = Array.from({ length: GRID.x }, () =>
    Array.from({ length: GRID.y }, () => Array(GRID.z).fill(false)),
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
  for (let x = x1 * RESOLUTION; x < x2 * RESOLUTION; x += 1)
    for (let y = y1 * RESOLUTION; y < y2 * RESOLUTION; y += 1)
      for (let z = z1 * RESOLUTION; z < z2 * RESOLUTION; z += 1) occupancy[x][y][z] = true;
}

function clearBox(occupancy: Occupancy, x1: number, x2: number, y1: number, y2: number, z1: number, z2: number): void {
  for (let x = x1 * RESOLUTION; x < x2 * RESOLUTION; x += 1)
    for (let y = y1 * RESOLUTION; y < y2 * RESOLUTION; y += 1)
      for (let z = z1 * RESOLUTION; z < z2 * RESOLUTION; z += 1) occupancy[x][y][z] = false;
}

function projectOccupancy(occupancy: Occupancy): Record<ViewName, Mask> {
  const front = Array.from({ length: GRID.z }, () => Array(GRID.x).fill(false));
  const top = Array.from({ length: GRID.y }, () => Array(GRID.x).fill(false));
  const side = Array.from({ length: GRID.z }, () => Array(GRID.y).fill(false));

  for (let x = 0; x < GRID.x; x += 1) {
    for (let y = 0; y < GRID.y; y += 1) {
      for (let z = 0; z < GRID.z; z += 1) {
        if (!occupancy[x][y][z]) continue;
        front[GRID.z - 1 - z][x] = true;
        top[y][x] = true;
        side[GRID.z - 1 - z][y] = true;
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
    id: crypto.randomUUID(), x1: x1 * CELL, y1: y1 * CELL, x2: x2 * CELL, y2: y2 * CELL, type: 'visible',
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

function coversHorizontal(segments: Segment[], row: number, start: number, end: number): boolean {
  const intervals = segments
    .filter((segment) => segment.y1 === row && segment.y2 === row && segment.x2 > start && segment.x1 < end)
    .map((segment) => [Math.max(start, segment.x1), Math.min(end, segment.x2)] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = start;
  for (const [from, to] of intervals) {
    if (from > covered) return false;
    covered = Math.max(covered, to);
    if (covered >= end) return true;
  }
  return false;
}

function orderedClosedProfile(segments: Segment[]): Array<{ x: number; row: number }> | null {
  if (segments.length < 3) return null;
  const key = (point: { x: number; row: number }) => `${point.x},${point.row}`;
  const adjacency = new Map<string, Array<{ point: { x: number; row: number }; segment: Segment }>>();
  for (const segment of segments) {
    const a = { x: segment.x1, row: segment.y1 };
    const b = { x: segment.x2, row: segment.y2 };
    adjacency.set(key(a), [...(adjacency.get(key(a)) ?? []), { point: b, segment }]);
    adjacency.set(key(b), [...(adjacency.get(key(b)) ?? []), { point: a, segment }]);
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.length !== 2)) return null;

  const start = { x: segments[0].x1, row: segments[0].y1 };
  const profile = [start];
  const used = new Set<string>();
  let current = start;
  for (let guard = 0; guard <= segments.length; guard += 1) {
    const next = (adjacency.get(key(current)) ?? []).find((entry) => !used.has(entry.segment.id));
    if (!next) return null;
    used.add(next.segment.id);
    current = next.point;
    if (key(current) === key(start)) break;
    profile.push(current);
  }
  return used.size === segments.length && key(current) === key(start) ? profile : null;
}
