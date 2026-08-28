export type Tool = 'visible' | 'hidden' | 'erase';
export type LineType = Exclude<Tool, 'erase'>;
export type ViewName = 'front' | 'top' | 'side';

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type: LineType;
}

export interface ViewState {
  cols: number;
  rows: number;
  segments: Segment[];
}

export interface ProjectState {
  version: 1;
  name: string;
  views: Record<ViewName, ViewState>;
}

export type Mask = boolean[][];
export type Occupancy = boolean[][][];

export interface MeshStats {
  voxels: number;
  faces: number;
  vertices?: number;
}
