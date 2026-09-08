import './style.css';
import { buildChamferedChannelGeometry, buildExtrudedProfileGeometry, buildGeometry, buildGeometryWithInclinedEdges, buildHipRoofGeometry, createExampleViews, reconstruct, reconstructFromViews, SIZE } from './geometry';
import { ProjectionEditor } from './projection-editor';
import { exportTechnicalPdf, projectFromPdf } from './pdf-export';
import type { Mask, ProjectState, Tool, ViewName, ViewState } from './types';
import { ModelViewer } from './viewer';

const STORAGE_KEY = 'traco-3d-project-v2';
const DISPLAY_MODE_KEY = 'traco-3d-display-mode-v1';
const MAX_HISTORY = 80;

let activeTool: Tool = 'visible';
let undoStack: ProjectState[] = [];
let redoStack: ProjectState[] = [];
let saveTimer = 0;
let pdfAvailable = false;
let currentMobileView = 'front';

const projectName = requiredElement<HTMLInputElement>('project-name');
const undoButton = requiredElement<HTMLButtonElement>('undo');
const redoButton = requiredElement<HTMLButtonElement>('redo');
const fileInput = requiredElement<HTMLInputElement>('file-input');
const showFill = requiredElement<HTMLInputElement>('show-fill');
const showCoordinates = requiredElement<HTMLInputElement>('show-coordinates');
const showProjectors = requiredElement<HTMLInputElement>('show-projectors');
const modelStatus = requiredElement<HTMLElement>('model-status');
const projectionGuides = requiredElement<SVGSVGElement>('projection-guides');
const allViewsScroll = requiredElement<HTMLElement>('all-views-scroll');
const allViewsContent = requiredElement<HTMLElement>('all-views-content');

const editors = {
  front: createEditor('front-view', SIZE.x, SIZE.z),
  side: createEditor('side-view', SIZE.y, SIZE.z),
  top: createEditor('top-view', SIZE.x, SIZE.y),
};

const isoViewer = new ModelViewer(requiredElement('iso-viewer'), 'isometric');
const modelViewer = new ModelViewer(requiredElement('model-viewer'), 'interactive');

bindInterface();
initializeDisplayMode();
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
  requiredElement('clear-all-desktop').addEventListener('click', clearAll);
  requiredElement('clear-menu-trigger').addEventListener('click', toggleClearMenu);
  document.querySelectorAll<HTMLButtonElement>('[data-clear-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.clearAction === 'all') clearAll();
      else clearCurrentView();
      closeClearMenu();
    });
  });
  requiredElement('workspace-undo').addEventListener('click', undo);
  requiredElement('workspace-redo').addEventListener('click', redo);
  requiredElement('new-project').addEventListener('click', clearAll);
  requiredElement('save-project').addEventListener('click', exportProject);
  requiredElement('export-pdf').addEventListener('click', exportPdf);
  requiredElement('open-project').addEventListener('click', () => fileInput.click());
  requiredElement('reset-iso').addEventListener('click', () => isoViewer.resetCamera());
  requiredElement('reset-camera').addEventListener('click', () => modelViewer.resetCamera());
  requiredElement('switch-mobile').addEventListener('click', () => setDisplayMode('mobile', true));

  document.querySelectorAll<HTMLButtonElement>('[data-mobile-tool]').forEach((button) => {
    button.addEventListener('click', () => setTool(button.dataset.mobileTool as Tool));
  });
  document.querySelectorAll<HTMLButtonElement>('.mobile-menu-trigger').forEach((button) => {
    button.addEventListener('click', () => {
      const menu = button.closest<HTMLElement>('.mobile-menu');
      const open = menu?.classList.toggle('open') ?? false;
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        document.querySelectorAll<HTMLElement>('.mobile-menu.open').forEach((other) => {
          if (other !== menu) {
            other.classList.remove('open');
            other.querySelector('.mobile-menu-trigger')?.setAttribute('aria-expanded', 'false');
          }
        });
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.mobile-menu-panel button').forEach((button) => {
    button.addEventListener('click', closeMobileMenus);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('.mobile-menu')) closeMobileMenus();
    if (!event.target.closest('.clear-menu')) closeClearMenu();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-view]').forEach((button) => {
    button.addEventListener('click', () => setMobileView(button.dataset.mobileView ?? 'front'));
  });
  bindAllViewsZoom();
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-action]').forEach((button) => {
    button.addEventListener('click', () => runMobileAction(button.dataset.mobileAction ?? ''));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    button.addEventListener('click', () => toggleMobileSetting(button.dataset.toggle ?? ''));
  });

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
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-tool]').forEach((button) => {
    const active = button.dataset.mobileTool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function initializeDisplayMode(): void {
  const saved = localStorage.getItem(DISPLAY_MODE_KEY);
  setDisplayMode(saved === 'desktop' || saved === 'mobile' ? saved : detectDeviceMode(), false);
}

function detectDeviceMode(): 'desktop' | 'mobile' {
  const browser = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof browser.userAgentData?.mobile === 'boolean') {
    return browser.userAgentData.mobile ? 'mobile' : 'desktop';
  }
  if (/Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry/i.test(navigator.userAgent)) return 'mobile';
  if (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return 'mobile';
  return 'mobile';
}

function setDisplayMode(mode: 'desktop' | 'mobile', persist: boolean): void {
  document.documentElement.classList.toggle('mobile-mode', mode === 'mobile');
  document.documentElement.classList.toggle('desktop-mode', mode === 'desktop');
  if (persist) localStorage.setItem(DISPLAY_MODE_KEY, mode);
  if (mode === 'mobile') setMobileView('front');
}

function setMobileView(view: string): void {
  currentMobileView = view;
  document.querySelectorAll<HTMLElement>('.drawing-card').forEach((card) => {
    card.classList.toggle('mobile-active', card.classList.contains(`${view}-card`));
  });
  document.querySelectorAll<HTMLElement>('.viewer-card').forEach((card) => {
    const active = Boolean((view === 'iso' && card.querySelector('#iso-viewer')) || (view === 'model' && card.querySelector('#model-viewer')));
    card.classList.toggle('mobile-active', active);
  });
  document.querySelector('.all-views-card')?.classList.toggle('mobile-active', view === 'all');
  if (view === 'all') renderAllViews();
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-view]').forEach((button) => {
    const active = button.dataset.mobileView === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  requestAnimationFrame(renderProjectionGuides);
}

function renderAllViews(): void {
  allViewsContent.replaceChildren();
  for (const [sourceId, className] of [['front-view', 'all-view-front'], ['side-view', 'all-view-side'], ['top-view', 'all-view-top']]) {
    const clone = requiredElement<SVGSVGElement>(sourceId).cloneNode(true) as SVGSVGElement;
    clone.removeAttribute('id');
    clone.setAttribute('class', `all-view-svg ${className}`);
    clone.setAttribute('aria-hidden', 'true');
    clone.style.pointerEvents = 'none';
    allViewsContent.append(clone);
  }
}

function bindAllViewsZoom(): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let startDistance = 1;
  let startScale = 1;
  let scale = 1;
  allViewsScroll.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const points = [...pointers.values()];
      startDistance = Math.max(Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), 1);
      startScale = scale;
    }
  });
  allViewsScroll.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size !== 2) return;
    const points = [...pointers.values()];
    const distance = Math.max(Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), 1);
    scale = Math.min(2.5, Math.max(.7, startScale * distance / startDistance));
    allViewsContent.style.width = `${620 * scale}px`;
    allViewsContent.style.height = `${420 * scale}px`;
    event.preventDefault();
  });
  const release = (event: PointerEvent) => pointers.delete(event.pointerId);
  allViewsScroll.addEventListener('pointerup', release);
  allViewsScroll.addEventListener('pointercancel', release);
}

function runMobileAction(action: string): void {
  const actions: Record<string, () => void> = {
    new: clearAll,
    open: () => fileInput.click(),
    save: exportProject,
    pdf: exportPdf,
    desktop: () => setDisplayMode('desktop', true),
  };
  actions[action]?.();
}

function closeMobileMenus(): void {
  document.querySelectorAll<HTMLElement>('.mobile-menu.open').forEach((menu) => {
    menu.classList.remove('open');
    menu.querySelector('.mobile-menu-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function toggleClearMenu(): void {
  const menu = requiredElement<HTMLElement>('clear-menu');
  const trigger = requiredElement<HTMLButtonElement>('clear-menu-trigger');
  const panel = menu.querySelector<HTMLElement>('.clear-menu-panel');
  const open = menu.classList.toggle('open');
  trigger.setAttribute('aria-expanded', String(open));
  if (open && panel && document.documentElement.classList.contains('mobile-mode')) {
    const bounds = trigger.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${bounds.bottom + 5}px`;
    panel.style.left = `${Math.max(5, bounds.right - 180)}px`;
    panel.style.right = 'auto';
  }
}

function closeClearMenu(): void {
  const menu = document.querySelector<HTMLElement>('.clear-menu.open');
  if (!menu) return;
  menu.classList.remove('open');
  requiredElement('clear-menu-trigger').setAttribute('aria-expanded', 'false');
  const panel = menu.querySelector<HTMLElement>('.clear-menu-panel');
  if (panel) {
    panel.style.position = '';
    panel.style.top = '';
    panel.style.left = '';
    panel.style.right = '';
  }
}

function toggleMobileSetting(setting: string): void {
  const controls: Record<string, HTMLInputElement> = { fill: showFill, coordinates: showCoordinates, projectors: showProjectors };
  const control = controls[setting];
  if (!control) return;
  control.checked = !control.checked;
  control.dispatchEvent(new Event('change'));
  document.querySelectorAll<HTMLButtonElement>(`[data-toggle="${setting}"]`).forEach((button) => {
    button.classList.toggle('active', control.checked);
    button.setAttribute('aria-pressed', String(control.checked));
  });
}

function updateProject(): void {
  setPdfAvailable(false);
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
    const chamfer = buildChamferedChannelGeometry(viewStates);
    const extrudedProfile = chamfer ? null : buildExtrudedProfileGeometry(viewStates);
    const roof = chamfer || extrudedProfile ? null : buildHipRoofGeometry(viewStates);
    if (chamfer) {
      setPdfAvailable(true);
      isoViewer.setGeometry(chamfer.geometry);
      modelViewer.setGeometry(chamfer.geometry);
      updateContinuousStats(chamfer.stats.vertices ?? 0, chamfer.stats.faces);
      setStatus('ready', 'Canal chanfrado reconstruído');
      chamfer.geometry.dispose();
    } else if (extrudedProfile) {
      setPdfAvailable(true);
      isoViewer.setGeometry(extrudedProfile.geometry);
      modelViewer.setGeometry(extrudedProfile.geometry);
      updateContinuousStats(extrudedProfile.stats.vertices ?? 0, extrudedProfile.stats.faces);
      setStatus('ready', 'Prisma de perfil reconstruído');
      extrudedProfile.geometry.dispose();
    } else if (roof) {
      setPdfAvailable(true);
      isoViewer.setGeometry(roof.geometry);
      modelViewer.setGeometry(roof.geometry);
      updateSurfaceStats(roof.stats.vertices ?? 0, roof.stats.faces);
      setStatus('ready', 'Telhado de quatro águas reconstruído');
      roof.geometry.dispose();
    } else {
      const occupancy = reconstructFromViews(viewStates, masks.front, masks.top, masks.side);
      const result = buildGeometryWithInclinedEdges(occupancy, viewStates);
      setPdfAvailable(result.stats.voxels > 0 && (hasInclinedEdges(viewStates) || projectionsMatch(occupancy, masks)));
      isoViewer.setGeometry(result.geometry);
      modelViewer.setGeometry(result.geometry);
      updateStats(result.stats.voxels, result.stats.faces);

      if (result.stats.voxels === 0) {
        setStatus('error', 'Vistas incompatíveis');
      } else if (!hasInclinedEdges(viewStates) && !projectionsMatch(occupancy, masks)) {
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
  if (document.querySelector('.all-views-card.mobile-active')) renderAllViews();
}

function hasInclinedEdges(views: Record<ViewName, ViewState>): boolean {
  return (['front', 'side'] as ViewName[]).some((name) => views[name].segments.some((segment) =>
    segment.type === 'visible' && segment.x1 !== segment.x2 && segment.y1 !== segment.y2,
  ));
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
  if (!pdfAvailable) {
    toast('Complete as vistas antes de exportar o PDF');
    return;
  }
  exportTechnicalPdf({
    project: getProjectState(),
    perspective: isoViewer.captureJpeg(),
    showProjectors: showProjectors.checked,
  });
  toast('PDF técnico exportado com os dados editáveis');
}

function clearCurrentView(): void {
  const editor = currentMobileView === 'front' ? editors.front : currentMobileView === 'side' ? editors.side : currentMobileView === 'top' ? editors.top : null;
  if (!editor) {
    toast('Selecione uma vista ortográfica para limpar');
    return;
  }
  captureHistory();
  editor.clear();
  updateProject();
  toast('Vista atual limpa. Use Ctrl+Z para recuperar.');
}

function setPdfAvailable(value: boolean): void {
  pdfAvailable = value;
  requiredElement<HTMLButtonElement>('export-pdf').disabled = !value;
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-action="pdf"]').forEach((button) => {
    button.disabled = !value;
    button.setAttribute('aria-disabled', String(!value));
  });
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

function updateContinuousStats(vertices: number, faces: number): void {
  requiredElement('voxel-count').textContent = `${vertices} vértices estruturais`;
  requiredElement('face-count').textContent = `${faces} triângulos de superfície`;
}

function updateHistoryButtons(): void {
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
  requiredElement<HTMLButtonElement>('workspace-undo').disabled = undoStack.length === 0;
  requiredElement<HTMLButtonElement>('workspace-redo').disabled = redoStack.length === 0;
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
  const states = { front: editors.front.getState(), top: editors.top.getState(), side: editors.side.getState() };

  for (const x of commonCoordinates(states.front, 'x', states.top, 'x')) {
    addGuide(
      svgToLayout(frontSvg, x, bottommostPointAtX(states.front, x), bounds),
      svgToLayout(topSvg, x, topmostPointAtX(states.top, x), bounds),
    );
  }
  for (const z of commonCoordinates(states.front, 'y', states.side, 'y')) {
    addGuide(
      svgToLayout(frontSvg, rightmostPointAtY(states.front, z), z, bounds),
      svgToLayout(sideSvg, leftmostPointAtY(states.side, z), z, bounds),
    );
  }
  const transfers: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = [];
  for (const depth of commonCoordinates(states.top, 'y', states.side, 'x')) {
    const start = svgToLayout(topSvg, rightmostPointAtY(states.top, depth), depth, bounds);
    const end = svgToLayout(sideSvg, depth, bottommostPointAtX(states.side, depth), bounds);
    if (!start || !end) continue;
    transfers.push({ start, end });
  }

  if (transfers.length === 0) return;
  const fixedRadius = 72;
  for (const { start, end } of transfers) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'projection-guide transfer');
    const radius = fixedRadius;
    const arcStartX = end.x - radius;
    const arcEndY = start.y - radius;
    path.setAttribute('d', `M ${start.x} ${start.y} H ${arcStartX} A ${radius} ${radius} 0 0 0 ${end.x} ${arcEndY} V ${end.y}`);
    projectionGuides.append(path);
  }
}

function rightmostPointAtY(view: ViewState, y: number): number {
  const points: number[] = [];
  for (const segment of view.segments) {
    if (segment.y1 === segment.y2 && segment.y1 === y) {
      points.push(segment.x1, segment.x2);
    } else if (segment.x1 === segment.x2 && between(y, segment.y1, segment.y2)) {
      points.push(segment.x1);
    }
  }
  return points.length > 0 ? Math.max(...points) : view.cols;
}

function leftmostPointAtY(view: ViewState, y: number): number {
  const points: number[] = [];
  for (const segment of view.segments) {
    if (segment.y1 === segment.y2 && segment.y1 === y) {
      points.push(segment.x1, segment.x2);
    } else if (segment.x1 === segment.x2 && between(y, segment.y1, segment.y2)) {
      points.push(segment.x1);
    }
  }
  return points.length > 0 ? Math.min(...points) : 0;
}

function topmostPointAtX(view: ViewState, x: number): number {
  const points: number[] = [];
  for (const segment of view.segments) {
    if (segment.x1 === segment.x2 && segment.x1 === x) {
      points.push(segment.y1, segment.y2);
    } else if (segment.y1 === segment.y2 && between(x, segment.x1, segment.x2)) {
      points.push(segment.y1);
    }
  }
  return points.length > 0 ? Math.min(...points) : 0;
}

function bottommostPointAtX(view: ViewState, x: number): number {
  const points: number[] = [];
  for (const segment of view.segments) {
    if (segment.x1 === segment.x2 && segment.x1 === x) {
      points.push(segment.y1, segment.y2);
    } else if (segment.y1 === segment.y2 && between(x, segment.x1, segment.x2)) {
      points.push(segment.y1);
    }
  }
  return points.length > 0 ? Math.max(...points) : view.rows;
}

function between(value: number, first: number, second: number): boolean {
  return value >= Math.min(first, second) && value <= Math.max(first, second);
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
