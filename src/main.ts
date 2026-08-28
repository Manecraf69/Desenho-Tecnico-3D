import './style.css';
import { buildGeometry, buildHipRoofGeometry, createExampleViews, reconstruct, SIZE } from './geometry';
import { ProjectionEditor } from './projection-editor';
import { exportTechnicalPdf, projectFromPdf } from './pdf-export';
import type { Mask, ProjectState, Tool, ViewName, ViewState } from './types';
import { ModelViewer } from './viewer';

const STORAGE_KEY = 'traco-3d-project-v1';
const MAX_HISTORY = 80;

let activeTool: Tool = 'visible';
let undoStack: ProjectState[] = [];
let redoStack: ProjectState[] = [];
let saveTimer = 0;

const projectName = requiredElement<HTMLInputElement>('project-name');
const undoButton = requiredElement<HTMLButtonElement>('undo');
const redoButton = requiredElement<HTMLButtonElement>('redo');
const fileInput = requiredElement<HTMLInputElement>('file-input');
const showFill = requiredElement<HTMLInputElement>('show-fill');
const showCoordinates = requiredElement<HTMLInputElement>('show-coordinates');
const showProjectors = requiredElement<HTMLInputElement>('show-projectors');
const modelStatus = requiredElement<HTMLElement>('model-status');
const projectionGuides = requiredElement<SVGSVGElement>('projection-guides');

const editors = {
  front: createEditor('front-view', SIZE.x, SIZE.z),
  side: createEditor('side-view', SIZE.y, SIZE.z),
  top: createEditor('top-view', SIZE.x, SIZE.y),
};

const isoViewer = new ModelViewer(requiredElement('iso-viewer'), 'isometric');
const modelViewer = new ModelViewer(requiredElement('model-viewer'), 'interactive');

bindInterface();
loadInitialProject();
updateProject();

function createEditor(id: string, cols: number, rows: number): ProjectionEditor {
  return new ProjectionEditor({
    svg: requiredElement<SVGSVGElement>(id),
    cols,
    rows,
    getTool: () => activeTool,
    onBeforeChange: captureHistory,
    onChange: updateProject,
  });
}

function bindInterface(): void {
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach((button) => {
    button.addEventListener('click', () => setTool(button.dataset.tool as Tool));
  });

  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  requiredElement('load-example').addEventListener('click', loadExample);
  requiredElement('clear-all').addEventListener('click', clearAll);
  requiredElement('new-project').addEventListener('click', clearAll);
  requiredElement('save-project').addEventListener('click', exportProject);
  requiredElement('export-pdf').addEventListener('click', exportPdf);
  requiredElement('open-project').addEventListener('click', () => fileInput.click());
  requiredElement('reset-iso').addEventListener('click', () => isoViewer.resetCamera());
  requiredElement('reset-camera').addEventListener('click', () => modelViewer.resetCamera());

  showFill.addEventListener('change', () => Object.values(editors).forEach((editor) => editor.setShowFill(showFill.checked)));
  showCoordinates.addEventListener('change', () => Object.values(editors).forEach((editor) => editor.setShowCoordinates(showCoordinates.checked)));
  showProjectors.addEventListener('change', renderProjectionGuides);

  projectName.addEventListener('input', () => scheduleSave());
  fileInput.addEventListener('change', importProject);
  window.addEventListener('resize', () => requestAnimationFrame(renderProjectionGuides));
  new ResizeObserver(() => requestAnimationFrame(renderProjectionGuides)).observe(requiredElement('front-view'));

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement && event.target !== fileInput) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const shortcut: Record<string, Tool> = { v: 'visible', o: 'hidden', e: 'erase' };
      const tool = shortcut[event.key.toLowerCase()];
      if (tool) setTool(tool);
    }
  });
}

function setTool(tool: Tool): void {
  activeTool = tool;
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach((button) => {
    const active = button.dataset.tool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateProject(): void {
  const masks = {
    front: editors.front.getMask(),
    top: editors.top.getMask(),
    side: editors.side.getMask(),
  };
  const missing = (Object.entries(masks) as Array<[ViewName, Mask]>).filter(([, mask]) => countMask(mask) === 0).map(([name]) => name);

  if (missing.length > 0) {
    const empty = buildGeometry(reconstruct(masks.front, masks.top, masks.side));
    isoViewer.setGeometry(empty.geometry);
    modelViewer.setGeometry(empty.geometry);
    updateStats(0, 0);
    setStatus('waiting', `Complete ${missing.length === 3 ? 'as três vistas' : missing.length === 2 ? 'duas vistas' : viewLabel(missing[0])}`);
  } else {
    const viewStates = {
      front: editors.front.getState(),
      top: editors.top.getState(),
      side: editors.side.getState(),
    };
    const roof = buildHipRoofGeometry(viewStates);
    if (roof) {
      isoViewer.setGeometry(roof.geometry);
      modelViewer.setGeometry(roof.geometry);
      updateSurfaceStats(roof.stats.vertices ?? 0, roof.stats.faces);
      setStatus('ready', 'Telhado de quatro águas reconstruído');
      roof.geometry.dispose();
    } else {
      const occupancy = reconstruct(masks.front, masks.top, masks.side);
      const result = buildGeometry(occupancy);
      isoViewer.setGeometry(result.geometry);
      modelViewer.setGeometry(result.geometry);
      updateStats(result.stats.voxels, result.stats.faces);

      if (result.stats.voxels === 0) {
        setStatus('error', 'Vistas incompatíveis');
      } else if (!projectionsMatch(occupancy, masks)) {
        setStatus('error', 'Há regiões sem correspondência entre as vistas');
      } else {
        setStatus('ready', 'Modelo reconstruído');
      }
      result.geometry.dispose();
    }
  }

  updateHistoryButtons();
  scheduleSave();
  requestAnimationFrame(renderProjectionGuides);
}

function captureHistory(): void {
  undoStack.push(getProjectState());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function undo(): void {
  const state = undoStack.pop();
  if (!state) return;
  redoStack.push(getProjectState());
  applyProjectState(state);
  toast('Alteração desfeita');
}

function redo(): void {
  const state = redoStack.pop();
  if (!state) return;
  undoStack.push(getProjectState());
  applyProjectState(state);
  toast('Alteração refeita');
}

function loadExample(): void {
  captureHistory();
  projectName.value = 'Peça ortogonal — exemplo';
  const views = createExampleViews();
  editors.front.setState(views.front);
  editors.top.setState(views.top);
  editors.side.setState(views.side);
  updateProject();
  toast('Exemplo carregado. Você pode editar qualquer linha.');
}

function clearAll(): void {
  captureHistory();
  projectName.value = 'Peça sem título';
  Object.values(editors).forEach((editor) => editor.clear());
  updateProject();
  toast('Vistas limpas. Use Ctrl+Z para recuperar.');
}

function getProjectState(): ProjectState {
  return {
    version: 1,
    name: projectName.value.trim() || 'Peça sem título',
    views: {
      front: editors.front.getState(),
      top: editors.top.getState(),
      side: editors.side.getState(),
    },
  };
}

function applyProjectState(project: ProjectState): void {
  projectName.value = repairMojibake(project.name);
  editors.front.setState(project.views.front);
  editors.top.setState(project.views.top);
  editors.side.setState(project.views.side);
  updateProject();
}

function exportProject(): void {
  const project = getProjectState();
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFilename(project.name)}.traco3d.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast('Arquivo JSON salvo');
}

async function importProject(): Promise<void> {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const parsed = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      ? await projectFromPdf(file)
      : JSON.parse(await file.text()) as unknown;
    if (!isProjectState(parsed)) throw new Error('Formato inválido');
    captureHistory();
    applyProjectState(parsed);
    toast('Projeto aberto com sucesso');
  } catch {
    toast('Não foi possível abrir este arquivo');
  }
}

function exportPdf(): void {
  exportTechnicalPdf({
    project: getProjectState(),
    perspective: isoViewer.captureJpeg(),
    showProjectors: showProjectors.checked,
  });
  toast('PDF técnico exportado com os dados editáveis');
}

function loadInitialProject(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const project = JSON.parse(saved) as unknown;
      if (isProjectState(project)) {
        applyProjectState(project);
        return;
      }
    } catch { /* carrega o exemplo abaixo */ }
  }
  projectName.value = 'Peça ortogonal — exemplo';
  const views = createExampleViews();
  editors.front.setState(views.front);
  editors.top.setState(views.top);
  editors.side.setState(views.side);
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  requiredElement('save-state').textContent = 'Salvando…';
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getProjectState()));
    requiredElement('save-state').textContent = 'Salvo localmente';
  }, 220);
}

function projectionsMatch(occupancy: boolean[][][], masks: Record<ViewName, Mask>): boolean {
  const projected: Record<ViewName, Mask> = {
    front: masks.front.map((row) => row.map(() => false)),
    top: masks.top.map((row) => row.map(() => false)),
    side: masks.side.map((row) => row.map(() => false)),
  };
  for (let x = 0; x < occupancy.length; x += 1)
    for (let y = 0; y < (occupancy[x]?.length ?? 0); y += 1)
      for (let z = 0; z < (occupancy[x]?.[y]?.length ?? 0); z += 1) {
    if (!occupancy[x][y][z]) continue;
    projected.front[projected.front.length - 1 - z][x] = true;
    projected.top[y][x] = true;
    projected.side[projected.side.length - 1 - z][y] = true;
  }
  return (Object.keys(masks) as ViewName[]).every((name) => masksEqual(masks[name], projected[name]));
}

function setStatus(kind: 'waiting' | 'ready' | 'error', message: string): void {
  modelStatus.className = `status ${kind}`;
  const text = modelStatus.querySelector('span');
  if (text) text.textContent = message;
}

function updateStats(voxels: number, faces: number): void {
  requiredElement('voxel-count').textContent = `${voxels} ${voxels === 1 ? 'célula sólida' : 'células sólidas'}`;
  requiredElement('face-count').textContent = `${faces} ${faces === 1 ? 'face externa' : 'faces externas'}`;
}

function updateSurfaceStats(vertices: number, faces: number): void {
  requiredElement('voxel-count').textContent = `${vertices} vértices estruturais`;
  requiredElement('face-count').textContent = `${faces} águas inclinadas`;
}

function updateHistoryButtons(): void {
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
}

function toast(message: string): void {
  const region = requiredElement('toast-region');
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), 3200);
}

function countMask(mask: Mask): number {
  return mask.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

function masksEqual(a: Mask, b: Mask): boolean {
  return a.length === b.length && a.every((row, y) => row.length === b[y].length && row.every((cell, x) => cell === b[y][x]));
}

function viewLabel(name: ViewName): string {
  return name === 'front' ? 'a vista frontal' : name === 'top' ? 'a vista superior' : 'a vista lateral';
}

function safeFilename(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'projeto';
}

function repairMojibake(value: string): string {
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function isProjectState(value: unknown): value is ProjectState {
  if (!value || typeof value !== 'object') return false;
  const project = value as Partial<ProjectState>;
  if (project.version !== 1 || typeof project.name !== 'string' || !project.views) return false;
  return (['front', 'top', 'side'] as ViewName[]).every((name) => {
    const view = project.views?.[name] as ViewState | undefined;
    return Boolean(view && Number.isInteger(view.cols) && Number.isInteger(view.rows) && Array.isArray(view.segments));
  });
}

function renderProjectionGuides(): void {
  projectionGuides.replaceChildren();
  if (!showProjectors.checked) return;
  const layout = projectionGuides.parentElement;
  if (!layout) return;
  const bounds = layout.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return;
  projectionGuides.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);

  const frontSvg = requiredElement<SVGSVGElement>('front-view');
  const topSvg = requiredElement<SVGSVGElement>('top-view');
  const sideSvg = requiredElement<SVGSVGElement>('side-view');
  const frontCard = frontSvg.closest('.drawing-card')!.getBoundingClientRect();
  const topCard = topSvg.closest('.drawing-card')!.getBoundingClientRect();
  const sideCard = sideSvg.closest('.drawing-card')!.getBoundingClientRect();
  const transferX = (frontCard.right + sideCard.left) / 2 - bounds.left;
  const transferY = (frontCard.bottom + topCard.top) / 2 - bounds.top;
  const states = { front: editors.front.getState(), top: editors.top.getState(), side: editors.side.getState() };

  for (const x of commonCoordinates(states.front, 'x', states.top, 'x')) {
    addGuide(svgToLayout(frontSvg, x, states.front.rows, bounds), svgToLayout(topSvg, x, 0, bounds));
  }
  for (const z of commonCoordinates(states.front, 'y', states.side, 'y')) {
    addGuide(svgToLayout(frontSvg, states.front.cols, z, bounds), svgToLayout(sideSvg, 0, z, bounds));
  }
  for (const depth of commonCoordinates(states.top, 'y', states.side, 'x')) {
    const start = svgToLayout(topSvg, states.top.cols, depth, bounds);
    const end = svgToLayout(sideSvg, depth, states.side.rows, bounds);
    if (!start || !end) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'projection-guide transfer');
    path.setAttribute('d', `M ${start.x} ${start.y} C ${transferX} ${start.y}, ${transferX} ${transferY}, ${transferX} ${transferY} C ${transferX} ${transferY}, ${end.x} ${transferY}, ${end.x} ${end.y}`);
    projectionGuides.append(path);
  }
}

function addGuide(start: { x: number; y: number } | null, end: { x: number; y: number } | null): void {
  if (!start || !end) return;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('class', 'projection-guide');
  line.setAttribute('x1', String(start.x));
  line.setAttribute('y1', String(start.y));
  line.setAttribute('x2', String(end.x));
  line.setAttribute('y2', String(end.y));
  projectionGuides.append(line);
}

function svgToLayout(
  svg: SVGSVGElement, x: number, y: number, layoutBounds: DOMRect,
): { x: number; y: number } | null {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(x, y).matrixTransform(matrix);
  return { x: point.x - layoutBounds.left, y: point.y - layoutBounds.top };
}

function commonCoordinates(a: ViewState, axisA: 'x' | 'y', b: ViewState, axisB: 'x' | 'y'): number[] {
  const values = (view: ViewState, axis: 'x' | 'y') => new Set(view.segments.flatMap((segment) =>
    axis === 'x' ? [segment.x1, segment.x2] : [segment.y1, segment.y2],
  ));
  const first = values(a, axisA);
  return [...values(b, axisB)].filter((value) => first.has(value)).sort((x, y) => x - y);
}

function requiredElement<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} não encontrado`);
  return element as unknown as T;
}
