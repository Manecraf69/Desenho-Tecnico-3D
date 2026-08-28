import type { LineType, Mask, Point, Segment, Tool, ViewState } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MASK_SCALE = 2;

interface EditorOptions {
  svg: SVGSVGElement;
  cols: number;
  rows: number;
  getTool: () => Tool;
  onBeforeChange: () => void;
  onChange: () => void;
}

export class ProjectionEditor {
  readonly cols: number;
  readonly rows: number;
  private readonly svg: SVGSVGElement;
  private readonly getTool: () => Tool;
  private readonly onBeforeChange: () => void;
  private readonly onChange: () => void;
  private segments: Segment[] = [];
  private start: Point | null = null;
  private current: Point | null = null;
  private pointerId: number | null = null;
  private showFill = true;
  private showCoordinates = true;
  private halfStep = false;
  private mask: Mask;

  constructor(options: EditorOptions) {
    this.svg = options.svg;
    this.cols = options.cols;
    this.rows = options.rows;
    this.getTool = options.getTool;
    this.onBeforeChange = options.onBeforeChange;
    this.onChange = options.onChange;
    this.mask = emptyMask(this.cols, this.rows);
    this.svg.setAttribute('viewBox', `-0.8 -0.8 ${this.cols + 1.6} ${this.rows + 1.6}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.bindEvents();
    this.render();
  }

  getState(): ViewState {
    return { cols: this.cols, rows: this.rows, segments: this.segments.map((s) => ({ ...s })) };
  }

  setState(state: ViewState, notify = false): void {
    this.segments = state.segments
      .filter((segment) => isValidSegment(segment) &&
        segment.x1 >= 0 && segment.x1 <= this.cols && segment.x2 >= 0 && segment.x2 <= this.cols &&
        segment.y1 >= 0 && segment.y1 <= this.rows && segment.y2 >= 0 && segment.y2 <= this.rows)
      .map((segment) => ({ ...segment, id: segment.id || crypto.randomUUID() }));
    this.recompute();
    if (notify) this.onChange();
  }

  clear(): void {
    this.segments = [];
    this.recompute();
  }

  getMask(): Mask {
    return this.mask.map((row) => [...row]);
  }

  setShowFill(value: boolean): void {
    this.showFill = value;
    this.render();
  }

  setShowCoordinates(value: boolean): void {
    this.showCoordinates = value;
    this.render();
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Shift' || this.halfStep) return;
      this.halfStep = true;
      this.render();
    });
    window.addEventListener('keyup', (event) => {
      if (event.key !== 'Shift' || !this.halfStep) return;
      this.halfStep = false;
      this.render();
    });
    window.addEventListener('blur', () => {
      if (!this.halfStep) return;
      this.halfStep = false;
      this.render();
    });

    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.getTool() === 'erase') return;
      event.preventDefault();
      this.pointerId = event.pointerId;
      this.svg.setPointerCapture(event.pointerId);
      this.start = this.snap(event);
      this.current = this.start;
      this.render();
    });

    this.svg.addEventListener('pointermove', (event) => {
      if (this.pointerId !== event.pointerId || !this.start) return;
      this.current = this.snap(event);
      this.render();
    });

    const finish = (event: PointerEvent) => {
      if (this.pointerId !== event.pointerId || !this.start) return;
      const end = this.snap(event);
      if (end.x !== this.start.x || end.y !== this.start.y) {
        this.onBeforeChange();
        this.addSegment(this.start, end, this.getTool() as LineType);
        this.recompute();
        this.onChange();
      }
      this.start = null;
      this.current = null;
      this.pointerId = null;
      this.render();
    };

    this.svg.addEventListener('pointerup', finish);
    this.svg.addEventListener('pointercancel', (event) => {
      if (this.pointerId !== event.pointerId) return;
      this.start = null;
      this.current = null;
      this.pointerId = null;
      this.render();
    });
  }

  private snap(event: PointerEvent): Point {
    const point = this.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const local = point.matrixTransform(matrix.inverse());
    const step = event.shiftKey ? 0.5 : 1;
    return {
      x: clamp(Math.round(local.x / step) * step, 0, this.cols),
      y: clamp(Math.round(local.y / step) * step, 0, this.rows),
    };
  }

  private addSegment(start: Point, end: Point, type: LineType): void {
    const normalized = normalizeSegment({
      id: crypto.randomUUID(),
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      type,
    });

    this.segments = this.segments.filter((segment) => !sameGeometry(segment, normalized));
    this.segments.push(normalized);
  }

  private removeSegment(id: string): void {
    this.onBeforeChange();
    this.segments = this.segments.filter((segment) => segment.id !== id);
    this.recompute();
    this.onChange();
  }

  private recompute(): void {
    this.mask = segmentsToMask(this.cols, this.rows, this.segments);
    this.render();
  }

  private render(): void {
    this.svg.replaceChildren();
    this.svg.append(this.createRect('grid-background', 0, 0, this.cols, this.rows));

    if (this.showFill) {
      const fillGroup = svgElement('g');
      fillGroup.setAttribute('aria-hidden', 'true');
      for (let row = 0; row < this.mask.length; row += 1) {
        for (let col = 0; col < (this.mask[row]?.length ?? 0); col += 1) {
          if (this.mask[row][col]) fillGroup.append(this.createRect('solid-cell', col / MASK_SCALE, row / MASK_SCALE, 1 / MASK_SCALE, 1 / MASK_SCALE));
        }
      }
      this.svg.append(fillGroup);
    }

    const grid = svgElement('g');
    grid.setAttribute('aria-hidden', 'true');
    if (this.halfStep) {
      for (let x = 0.5; x < this.cols; x += 1) grid.append(this.createLine('grid-half', x, 0, x, this.rows));
      for (let y = 0.5; y < this.rows; y += 1) grid.append(this.createLine('grid-half', 0, y, this.cols, y));
    }
    for (let x = 0; x <= this.cols; x += 1) {
      grid.append(this.createLine(x % 5 === 0 ? 'grid-major' : 'grid-minor', x, 0, x, this.rows));
    }
    for (let y = 0; y <= this.rows; y += 1) {
      grid.append(this.createLine(y % 5 === 0 ? 'grid-major' : 'grid-minor', 0, y, this.cols, y));
    }
    grid.append(this.createRect('grid-border', 0, 0, this.cols, this.rows));
    this.svg.append(grid);

    if (this.showCoordinates) this.renderCoordinates();

    const segmentGroup = svgElement('g');
    for (const segment of this.segments) {
      const group = svgElement('g');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', `Linha ${segment.type === 'visible' ? 'visível' : 'oculta'}`);
      const hit = this.createLine('line-hit', segment.x1, segment.y1, segment.x2, segment.y2);
      const line = this.createLine(`technical-line ${segment.type}`, segment.x1, segment.y1, segment.x2, segment.y2);
      const erase = (event: Event) => {
        if (this.getTool() !== 'erase') return;
        event.stopPropagation();
        this.removeSegment(segment.id);
      };
      hit.addEventListener('pointerdown', erase);
      line.addEventListener('pointerdown', erase);
      group.append(hit, line);
      segmentGroup.append(group);
    }
    this.svg.append(segmentGroup);

    if (this.start && this.current) {
      this.svg.append(this.createLine('preview-line', this.start.x, this.start.y, this.current.x, this.current.y));
      const point = svgElement('circle');
      point.setAttribute('class', 'snap-point');
      point.setAttribute('cx', String(this.current.x));
      point.setAttribute('cy', String(this.current.y));
      point.setAttribute('r', '0.14');
      this.svg.append(point);
    }

    if (this.segments.length === 0) {
      const text = svgElement('text');
      text.setAttribute('class', 'empty-note');
      text.setAttribute('x', String(this.cols / 2));
      text.setAttribute('y', String(this.rows / 2));
      text.textContent = 'ARRASTE PARA DESENHAR';
      this.svg.append(text);
    }
  }

  private renderCoordinates(): void {
    const group = svgElement('g');
    group.setAttribute('aria-hidden', 'true');
    for (let x = 0; x <= this.cols; x += 1) {
      const text = svgElement('text');
      text.setAttribute('class', 'coordinate-label');
      text.setAttribute('x', String(x));
      text.setAttribute('y', '-0.24');
      text.setAttribute('text-anchor', 'middle');
      text.textContent = String(x);
      group.append(text);
    }
    for (let y = 0; y <= this.rows; y += 1) {
      const text = svgElement('text');
      text.setAttribute('class', 'coordinate-label');
      text.setAttribute('x', '-0.25');
      text.setAttribute('y', String(y + 0.08));
      text.setAttribute('text-anchor', 'end');
      text.textContent = String(y);
      group.append(text);
    }
    this.svg.append(group);
  }

  private createLine(className: string, x1: number, y1: number, x2: number, y2: number): SVGLineElement {
    const line = svgElement('line');
    line.setAttribute('class', className);
    line.setAttribute('x1', String(x1));
    line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2));
    line.setAttribute('y2', String(y2));
    return line;
  }

  private createRect(className: string, x: number, y: number, width: number, height: number): SVGRectElement {
    const rect = svgElement('rect');
    rect.setAttribute('class', className);
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    return rect;
  }
}

export function segmentsToMask(cols: number, rows: number, segments: Segment[]): Mask {
  const scaledCols = cols * MASK_SCALE;
  const scaledRows = rows * MASK_SCALE;
  const scaledSegments = segments.map((segment) => ({
    ...segment,
    x1: Math.round(segment.x1 * MASK_SCALE),
    y1: Math.round(segment.y1 * MASK_SCALE),
    x2: Math.round(segment.x2 * MASK_SCALE),
    y2: Math.round(segment.y2 * MASK_SCALE),
  }));
  const vertical = Array.from({ length: scaledRows }, () => Array(scaledCols + 1).fill(false));
  const horizontal = Array.from({ length: scaledRows + 1 }, () => Array(scaledCols).fill(false));

  for (const segment of scaledSegments.filter((item) => item.type === 'visible')) {
    const line = normalizeSegment(segment);
    if (line.x1 === line.x2) {
      for (let y = line.y1; y < line.y2; y += 1) {
        if (y >= 0 && y < scaledRows && line.x1 >= 0 && line.x1 <= scaledCols) vertical[y][line.x1] = true;
      }
    } else if (line.y1 === line.y2) {
      for (let x = line.x1; x < line.x2; x += 1) {
        if (x >= 0 && x < scaledCols && line.y1 >= 0 && line.y1 <= scaledRows) horizontal[line.y1][x] = true;
      }
    }
  }

  const outside = Array.from({ length: scaledRows }, () => Array(scaledCols).fill(false));
  const queue: Point[] = [];
  const enqueue = (x: number, y: number) => {
    if (x < 0 || x >= scaledCols || y < 0 || y >= scaledRows || outside[y][x]) return;
    outside[y][x] = true;
    queue.push({ x, y });
  };

  for (let x = 0; x < scaledCols; x += 1) {
    if (!horizontal[0][x]) enqueue(x, 0);
    if (!horizontal[scaledRows][x]) enqueue(x, scaledRows - 1);
  }
  for (let y = 0; y < scaledRows; y += 1) {
    if (!vertical[y][0]) enqueue(0, y);
    if (!vertical[y][scaledCols]) enqueue(scaledCols - 1, y);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const { x, y } = queue[index];
    if (x > 0 && !vertical[y][x]) enqueue(x - 1, y);
    if (x < scaledCols - 1 && !vertical[y][x + 1]) enqueue(x + 1, y);
    if (y > 0 && !horizontal[y][x]) enqueue(x, y - 1);
    if (y < scaledRows - 1 && !horizontal[y + 1][x]) enqueue(x, y + 1);
  }

  const mask = outside.map((row) => row.map((cell) => !cell));

  // O flood fill acima resolve contornos ortogonais. Para triângulos,
  // trapézios e outros polígonos, detectamos ciclos fechados e testamos
  // o centro de cada célula pelo método par/ímpar.
  for (const polygon of findClosedPolygons(scaledSegments.filter((item) => item.type === 'visible'))) {
    for (let row = 0; row < scaledRows; row += 1) {
      for (let col = 0; col < scaledCols; col += 1) {
        if (pointInPolygon({ x: col + 0.5, y: row + 0.5 }, polygon)) mask[row][col] = true;
      }
    }
  }

  return mask;
}

function normalizeSegment<T extends Segment>(segment: T): T {
  if (segment.x1 > segment.x2 || (segment.x1 === segment.x2 && segment.y1 > segment.y2)) {
    return { ...segment, x1: segment.x2, y1: segment.y2, x2: segment.x1, y2: segment.y1 };
  }
  return segment;
}

function sameGeometry(a: Segment, b: Segment): boolean {
  const first = normalizeSegment(a);
  const second = normalizeSegment(b);
  return first.x1 === second.x1 && first.y1 === second.y1 && first.x2 === second.x2 && first.y2 === second.y2;
}

function isValidSegment(value: Segment): boolean {
  return Boolean(value) && ['visible', 'hidden'].includes(value.type) &&
    isHalfStep(value.x1) && isHalfStep(value.y1) &&
    isHalfStep(value.x2) && isHalfStep(value.y2) &&
    (value.x1 !== value.x2 || value.y1 !== value.y2);
}

function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value * MASK_SCALE);
}

function findClosedPolygons(segments: Segment[]): Point[][] {
  const adjacency = new Map<string, Array<{ point: Point; segment: Segment }>>();
  const pointOf = (segment: Segment, first: boolean): Point => first
    ? { x: segment.x1, y: segment.y1 }
    : { x: segment.x2, y: segment.y2 };
  const keyOf = (point: Point) => `${point.x},${point.y}`;

  for (const segment of segments) {
    const a = pointOf(segment, true);
    const b = pointOf(segment, false);
    adjacency.set(keyOf(a), [...(adjacency.get(keyOf(a)) ?? []), { point: b, segment }]);
    adjacency.set(keyOf(b), [...(adjacency.get(keyOf(b)) ?? []), { point: a, segment }]);
  }

  const visited = new Set<string>();
  const polygons: Point[][] = [];

  for (const segment of segments) {
    if (visited.has(segment.id)) continue;
    const component: Segment[] = [];
    const pending = [segment];
    const componentIds = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (componentIds.has(current.id)) continue;
      componentIds.add(current.id);
      component.push(current);
      for (const endpoint of [pointOf(current, true), pointOf(current, false)]) {
        for (const neighbor of adjacency.get(keyOf(endpoint)) ?? []) pending.push(neighbor.segment);
      }
    }
    componentIds.forEach((id) => visited.add(id));

    const vertices = new Set(component.flatMap((item) => [keyOf(pointOf(item, true)), keyOf(pointOf(item, false))]));
    const isSimpleCycle = component.length >= 3 && [...vertices].every((key) =>
      (adjacency.get(key) ?? []).filter((entry) => componentIds.has(entry.segment.id)).length === 2,
    );
    if (!isSimpleCycle) continue;

    const start = pointOf(component[0], true);
    const polygon = [start];
    let current = start;
    let previousSegmentId = '';
    for (let guard = 0; guard <= component.length; guard += 1) {
      const next = (adjacency.get(keyOf(current)) ?? []).find((entry) =>
        componentIds.has(entry.segment.id) && entry.segment.id !== previousSegmentId,
      );
      if (!next) break;
      previousSegmentId = next.segment.id;
      current = next.point;
      if (keyOf(current) === keyOf(start)) break;
      polygon.push(current);
    }
    if (polygon.length >= 3 && keyOf(current) === keyOf(start)) polygons.push(polygon);
  }
  return polygons;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function emptyMask(cols: number, rows: number): Mask {
  return Array.from({ length: rows }, () => Array(cols).fill(false));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}
