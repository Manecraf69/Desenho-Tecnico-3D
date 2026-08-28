import './style.css';
import { buildGeometry, buildHipRoofGeometry, createExampleViews, reconstruct, SIZE } from './geometry';
import { ProjectionEditor } from './projection-editor';
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
const modelStatus = requiredElement<HTMLElement>('model-status');

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
  requiredElement('open-project').addEventListener('click', () => fileInput.click());
  requiredElement('reset-iso').addEventListener('click', () => isoViewer.resetCamera());
  requiredElement('reset-camera').addEventListener('click', () => modelViewer.resetCamera());

  showFill.addEventListener('change', () => Object.values(editors).forEach((editor) => editor.setShowFill(showFill.checked)));
  showCoordinates.addEventListener('change', () => Object.values(editors).forEach((editor) => editor.setShowCoordinates(showCoordinates.checked)));

  projectName.addEventListener('input', () => scheduleSave());
  fileInput.addEventListener('change', importProject);

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
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!isProjectState(parsed)) throw new Error('Formato inválido');
    captureHistory();
    applyProjectState(parsed);
    toast('Projeto aberto com sucesso');
  } catch {
    toast('Não foi possível abrir este arquivo');
  }
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
    front: Array.from({ length: SIZE.z }, () => Array(SIZE.x).fill(false)),
    top: Array.from({ length: SIZE.y }, () => Array(SIZE.x).fill(false)),
    side: Array.from({ length: SIZE.z }, () => Array(SIZE.y).fill(false)),
  };
  for (let x = 0; x < SIZE.x; x += 1) for (let y = 0; y < SIZE.y; y += 1) for (let z = 0; z < SIZE.z; z += 1) {
    if (!occupancy[x][y][z]) continue;
    projected.front[SIZE.z - 1 - z][x] = true;
    projected.top[y][x] = true;
    projected.side[SIZE.z - 1 - z][y] = true;
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
  const expected: Record<ViewName, [number, number]> = { front: [SIZE.x, SIZE.z], top: [SIZE.x, SIZE.y], side: [SIZE.y, SIZE.z] };
  return (Object.entries(expected) as Array<[ViewName, [number, number]]>).every(([name, [cols, rows]]) => {
    const view = project.views?.[name] as ViewState | undefined;
    return view?.cols === cols && view.rows === rows && Array.isArray(view.segments);
  });
}

function requiredElement<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} não encontrado`);
  return element as unknown as T;
}
