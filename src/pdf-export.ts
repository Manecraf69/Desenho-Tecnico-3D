import type { ProjectState, Segment, ViewName, ViewState } from './types';

interface JpegSnapshot {
  bytes: Uint8Array;
  width: number;
  height: number;
}

interface PdfOptions {
  project: ProjectState;
  perspective: JpegSnapshot;
  showProjectors: boolean;
}

interface Panel {
  x: number;
  y: number;
  width: number;
  height: number;
  gridX: number;
  gridY: number;
  gridSize: number;
  view?: ViewState;
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
}

const PAGE = { width: 842, height: 595 } as const;
const encoder = new TextEncoder();

export function exportTechnicalPdf(options: PdfOptions): void {
  const pdf = createTechnicalPdf(options);
  const blob = new Blob([pdf as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFilename(options.project.name)}.pdf`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function projectFromPdf(file: File): Promise<ProjectState> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let source = '';
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    source += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  const match = source.match(/\/Traco3D\s*\(([A-Za-z0-9+/=]+)\)/);
  if (!match) throw new Error('Este PDF não contém um projeto Traço 3D');
  const binary = atob(match[1]);
  const jsonBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as ProjectState;
}

export function createTechnicalPdf({ project, perspective, showProjectors }: PdfOptions): Uint8Array {
  const commands: string[] = [];
  const panels = {
    front: createPanel(24, 310, 382, 240, project.views.front),
    side: createPanel(418, 310, 400, 240, project.views.side),
    top: createPanel(24, 42, 382, 240, project.views.top),
    iso: createPanel(418, 42, 400, 240),
  };

  commands.push('1 1 1 rg 0 0 842 595 re f');
  text(commands, 24, 574, 15, 'TRAÇO 3D', true, [0.05, 0.22, 0.34]);
  text(commands, 118, 574, 10, project.name, true, [0.14, 0.22, 0.27]);
  text(commands, 818, 574, 6, 'PRIMEIRO DIEDRO', false, [0.42, 0.5, 0.55], 'right');

  drawView(commands, panels.front, 'VF  VISTA FRONTAL');
  drawView(commands, panels.side, 'VLE  VISTA LATERAL ESQUERDA');
  drawView(commands, panels.top, 'VS  VISTA SUPERIOR');
  drawImagePanel(commands, panels.iso, '30  PERSPECTIVA ISOMETRICA', perspective);

  if (showProjectors) drawProjectors(commands, panels, project.views);

  text(commands, 24, 19, 5.5, 'Arquivo editavel: dados Traço 3D incorporados ao PDF', false, [0.45, 0.51, 0.55]);
  text(commands, 818, 19, 5.5, new Date().toLocaleDateString('pt-BR'), false, [0.45, 0.51, 0.55], 'right');

  const content = encoder.encode(commands.join('\n'));
  const data = toBase64(encoder.encode(JSON.stringify(project)));
  const objects: Uint8Array[] = [
    asciiBytes('<< /Type /Catalog /Pages 2 0 R >>'),
    asciiBytes('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    asciiBytes('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 4 0 R >>'),
    streamObject(`<< /Length ${content.length} >>`, content),
    asciiBytes('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    asciiBytes('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    streamObject(
      `<< /Type /XObject /Subtype /Image /Width ${perspective.width} /Height ${perspective.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${perspective.bytes.length} >>`,
      perspective.bytes,
    ),
    asciiBytes(`<< /Title (${pdfString(ascii(project.name))}) /Creator (Traco 3D) /Traco3D (${data}) >>`),
  ];

  return assemblePdf(objects, 8);
}

function createPanel(x: number, y: number, width: number, height: number, view?: ViewState): Panel {
  const gridSize = Math.min(width - 34, height - 43);
  return {
    x, y, width, height, view, gridSize,
    gridX: x + (width - gridSize) / 2,
    gridY: y + 10,
  };
}

function drawView(commands: string[], panel: Panel, title: string): void {
  drawPanel(commands, panel, title);
  const view = panel.view!;
  const visibleSegments = view.segments.length > 0 ? view.segments : [{ x1: 0, y1: 0, x2: view.cols, y2: view.rows } as Segment];
  const xs = visibleSegments.flatMap((segment) => [segment.x1, segment.x2]);
  const ys = visibleSegments.flatMap((segment) => [segment.y1, segment.y2]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  panel.minX = minX;
  panel.maxX = maxX;
  panel.minY = minY;
  panel.maxY = maxY;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const availableWidth = panel.width - 30;
  const availableHeight = panel.height - 42;
  const scale = Math.min(availableWidth / spanX, availableHeight / spanY) * 0.92;
  const centerX = panel.x + panel.width / 2;
  const centerY = panel.y + (panel.height - 24) / 2 - 2;
  panel.gridX = centerX - ((minX + maxX) / 2) * scale;
  panel.gridY = centerY - (view.rows - (minY + maxY) / 2) * scale;
  panel.gridSize = scale;

  for (const segment of view.segments) drawSegment(commands, panel, segment);
}

function drawSegment(commands: string[], panel: Panel, segment: Segment): void {
  const a = panelPoint(panel, segment.x1, segment.y1);
  const b = panelPoint(panel, segment.x2, segment.y2);
  commands.push(segment.type === 'hidden' ? '[5 3] 0 d' : '[] 0 d');
  commands.push(`0.07 0.19 0.27 RG ${segment.type === 'hidden' ? '1' : '1.7'} w`);
  commands.push(`${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S`);
  commands.push('[] 0 d');
}

function drawPanel(commands: string[], panel: Panel, title: string): void {
  commands.push('0.985 0.99 0.992 rg 0.78 0.84 0.87 RG 0.7 w');
  commands.push(`${panel.x} ${panel.y} ${panel.width} ${panel.height} re B`);
  commands.push(`0.88 0.92 0.94 RG 0.5 w ${panel.x} ${panel.y + panel.height - 24} m ${panel.x + panel.width} ${panel.y + panel.height - 24} l S`);
  text(commands, panel.x + 10, panel.y + panel.height - 16, 7, title, true, [0.09, 0.22, 0.3]);
}

function drawImagePanel(commands: string[], panel: Panel, title: string, image: JpegSnapshot): void {
  drawPanel(commands, panel, title);
  const area = { x: panel.x + 10, y: panel.y + 10, width: panel.width - 20, height: panel.height - 42 };
  const scale = Math.min(area.width / image.width, area.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = area.x + (area.width - width) / 2;
  const y = area.y + (area.height - height) / 2;
  commands.push(`q ${n(width)} 0 0 ${n(height)} ${n(x)} ${n(y)} cm /Im1 Do Q`);
}

function drawProjectors(
  commands: string[],
  panels: { front: Panel; side: Panel; top: Panel; iso: Panel },
  views: Record<ViewName, ViewState>,
): void {
  commands.push('[3 3] 0 d 0.9 0.55 0.08 RG 0.45 w');
  for (const x of commonCoordinates(views.front, 'x', views.top, 'x')) {
    const a = panelPoint(panels.front, x, panels.front.maxY!);
    const b = panelPoint(panels.top, x, panels.top.minY!);
    commands.push(`${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S`);
  }
  for (const z of commonCoordinates(views.front, 'y', views.side, 'y')) {
    const a = panelPoint(panels.front, panels.front.maxX!, z);
    const b = panelPoint(panels.side, panels.side.minX!, z);
    commands.push(`${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S`);
  }
  commands.push('[2 3] 0 d 0.08 0.48 0.65 RG 0.45 w');
  for (const depth of commonCoordinates(views.top, 'y', views.side, 'x')) {
    const a = panelPoint(panels.top, panels.top.maxX!, depth);
    const b = panelPoint(panels.side, depth, panels.side.maxY!);
    const transferX = (panels.top.x + panels.top.width + panels.side.x) / 2;
    const transferY = (panels.top.y + panels.top.height + panels.side.y) / 2;
    commands.push(`${n(a.x)} ${n(a.y)} m ${n(transferX)} ${n(a.y)} ${n(transferX)} ${n(transferY)} ${n(transferX)} ${n(transferY)} c ${n(transferX)} ${n(transferY)} ${n(b.x)} ${n(transferY)} ${n(b.x)} ${n(b.y)} c S`);
  }
  commands.push('[] 0 d');
}

function panelPoint(panel: Panel, x: number, y: number): { x: number; y: number } {
  return { x: panel.gridX + x * panel.gridSize, y: panel.gridY + (panel.view!.rows - y) * panel.gridSize };
}

function commonCoordinates(a: ViewState, axisA: 'x' | 'y', b: ViewState, axisB: 'x' | 'y'): number[] {
  const values = (view: ViewState, axis: 'x' | 'y') => new Set(view.segments.flatMap((segment) =>
    axis === 'x' ? [segment.x1, segment.x2] : [segment.y1, segment.y2],
  ));
  const first = values(a, axisA);
  return [...values(b, axisB)].filter((value) => first.has(value)).sort((x, y) => x - y);
}

function text(
  commands: string[], x: number, y: number, size: number, value: string, bold: boolean,
  color: [number, number, number], align: 'left' | 'center' | 'right' = 'left',
): void {
  const estimatedWidth = value.length * size * 0.52;
  const adjustedX = align === 'center' ? x - estimatedWidth / 2 : align === 'right' ? x - estimatedWidth : x;
  commands.push(`${color.join(' ')} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${n(adjustedX)} ${n(y)} Td (${pdfString(value)}) Tj ET`);
}

function streamObject(dictionary: string, stream: Uint8Array): Uint8Array {
  return concatBytes(asciiBytes(`${dictionary}\nstream\n`), stream, asciiBytes('\nendstream'));
}

function assemblePdf(objects: Uint8Array[], infoObject: number): Uint8Array {
  const header = concatBytes(
    asciiBytes('%PDF-1.7\n%'),
    new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]),
    asciiBytes('\n'),
  );
  const chunks: Uint8Array[] = [header];
  const offsets = [0];
  let length = header.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = concatBytes(asciiBytes(`${index + 1} 0 obj\n`), body, asciiBytes('\nendobj\n'));
    chunks.push(object);
    length += object.length;
  });
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  chunks.push(asciiBytes(xref));
  return concatBytes(...chunks);
}

function ascii(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
}

function pdfString(value: string): string {
  let result = '';
  for (const character of value) {
    if (/[\\()]/.test(character)) {
      result += `\\${character}`;
      continue;
    }
    const code = character.codePointAt(0) ?? 63;
    if (code >= 32 && code <= 126) result += character;
    else if (code <= 255) result += `\\${code.toString(8).padStart(3, '0')}`;
    else result += '?';
  }
  return result;
}

function asciiBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 16_384));
  }
  return btoa(binary);
}

function safeFilename(value: string): string {
  return ascii(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'projeto';
}

function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}
