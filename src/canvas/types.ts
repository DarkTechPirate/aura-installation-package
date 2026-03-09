export type ChartData = {
  labels: string[];
  datasets: Array<{ label: string; data: number[] }>;
};

export type CanvasBlock =
  | { id: string; type: 'text';  content: string }
  | { id: string; type: 'code';  language: string; content: string }
  | { id: string; type: 'table'; headers: string[]; rows: string[][] }
  | { id: string; type: 'image'; url: string; alt: string }
  | { id: string; type: 'chart'; chart_type: 'bar'|'line'|'pie'; data: ChartData }
  | { id: string; type: 'embed'; url: string; title: string };

export type CanvasState = {
  blocks: CanvasBlock[];
  updated_at: number;
};

export type CanvasEvent =
  | { event: 'state';  blocks: CanvasBlock[] }
  | { event: 'append'; block:  CanvasBlock }
  | { event: 'update'; id: string; block: CanvasBlock }
  | { event: 'delete'; id: string }
  | { event: 'clear' };
