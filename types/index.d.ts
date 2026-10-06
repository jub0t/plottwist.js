// Type definitions for plottwist.
//
// Charts are generic over your record type `D`, so accessors like
// `x: 'region'` are checked against your data's fields.

// ---- shared -----------------------------------------------------------------

/** A field of `D`, or a function reading a value from a record. */
export type Accessor<D, R = unknown> = (keyof D & string) | ((d: D) => R);

/** A step of an animated dataset. */
export interface Frame<D> {
  label: string | number | null;
  data: D[];
}

export type ViewName = 'iso' | 'top' | 'front' | 'side';

export interface CameraView {
  /** Rotation around the vertical axis, radians. */
  yaw?: number;
  /** Elevation above the horizon, radians (0 = side-on, PI/2 = top-down). */
  pitch?: number;
  zoom?: number;
}

/** Theme tokens. Every field is optional when extending a preset. */
export interface Theme {
  mode: 'dark' | 'light';
  /** Canvas fill; 'transparent' (the default) lets the page show through. */
  background: string;
  /** What the chart sits on; used for gaps, rings and label halos. */
  surface: string;
  font: string;
  fontMono: string;
  text: string;
  textMuted: string;
  /** Labels drawn on top of marks (value labels, region names). */
  markText?: string;
  markHalo?: string;
  floor: string;
  wall: string;
  grid: string;
  highlight: string;
  land: string;
  tooltip: string;
  tooltipBorder: string;
  /** Categorical palette, assigned in order. */
  series: string[];
  /** Default sequential scale: a name from `scales` or an array of stops. */
  scale: ScaleName | string[];
  ambient: number;
  diffuse: number;
  /** 0..1 vertical gradient on side faces. */
  gradient: number;
  /** 0..1 highlight stroke on top edges. */
  edge: number;
  /** 0..1 bloom around marks. */
  glow: number;
  /** 0..1 coloured light pooled on the floor. */
  pool: number;
  floorThickness: number;
  gridStyle: 'lines' | 'dots' | 'none';
}

export type ThemeName = 'midnight' | 'dark' | (string & {});
export type ThemeInput = ThemeName | (Partial<Theme> & { extends?: ThemeName });
/** 'terrain' is a natural ramp from green lowlands to pale peaks and never reverses on dark themes. */
export type ScaleName = 'violet' | 'blue' | 'emerald' | 'orange' | 'magenta' | 'teal' | 'terrain';

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
  active?: boolean;
}

export interface ChartEvents<H> {
  hover: H | null;
  click: H;
  frame: { position: number; playing: boolean };
  play: undefined;
  pause: undefined;
  /** IsoRegionMap: after drill() / drillUp(). */
  drill: { depth: number };
}

export interface ChartOptions {
  theme?: ThemeInput;
  /** Starting camera preset. Default 'iso'. */
  view?: ViewName;
  camera?: CameraView;
  /** Milliseconds per frame during playback. Default 1400. */
  frameDuration?: number;
  /** Loop playback. Default true. */
  loop?: boolean;
  autoplay?: boolean;
  /** Slowly orbit when idle. */
  autoRotate?: boolean;
  ariaLabel?: string;
}

/** Base class of every chart. `H` is what hover/click events carry. */
export declare class Chart<H = unknown> {
  constructor(container: HTMLElement | string, options?: ChartOptions);
  readonly container: HTMLElement;
  readonly options: ChartOptions;
  readonly theme: Theme;
  readonly camera: Camera;
  readonly timeline: Timeline;
  readonly hovered: H | null;
  readonly playing: boolean;
  /** Subscribe to an event; returns an unsubscribe function. */
  on<E extends keyof ChartEvents<H>>(event: E, fn: (payload: ChartEvents<H>[E]) => void): () => void;
  setTheme(theme: ThemeInput): void;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Jump to a (fractional) frame position. */
  seek(position: number): void;
  /** Animate to a preset or an explicit camera. */
  setView(view: ViewName | CameraView, options?: { duration?: number }): void;
  resetView(): void;
  /** Request a redraw on the next frame. */
  invalidate(): void;
  /** The chart's clock in ms: real time, or the synthetic clock during export(). */
  now(): number;
  /**
   * Render the chart to a file. Frames are stepped on a synthetic clock, so
   * clips are frame-exact and identical between runs. Video uses WebCodecs
   * (falling back to real-time MediaRecorder); GIF and PNG are encoded here.
   */
  export(options?: ExportOptions): Promise<Blob>;
  destroy(): void;
}

export interface ExportOptions {
  /**
   * Default 'mp4' (H.264). 'webm' is VP9. 'webp' is an animated WebP with a
   * full alpha channel (transparent unless `background` is set; needs a
   * browser that encodes WebP, e.g. Chrome, Edge, Firefox). 'png' is a single
   * transparent frame.
   */
  format?: 'mp4' | 'webm' | 'gif' | 'webp' | 'png';
  /** Image quality for 'webp', 0..1. Default 0.9. */
  quality?: number;
  /** Clip length in ms. Default: one pass through the frames (plus a 1s hold when not looping), else 3s (6s with orbit). */
  duration?: number;
  /** Frames per second. Default 30 (20 for GIF and WebP). */
  fps?: number;
  /** Output size in CSS pixels. Default: the chart's current size. Height follows the aspect ratio if omitted. */
  width?: number;
  height?: number;
  /** Device pixels per CSS pixel. Default: devicePixelRatio, or 1 when width/height are given. */
  pixelRatio?: number;
  /** Fill behind the chart. Default: the theme background, or a dark/light fill for video and GIF. */
  background?: string;
  /** Timeline position to start from. Default 0. */
  from?: number;
  /** Set false to hold the timeline still (e.g. with orbit). Default true. */
  play?: boolean;
  /** Full camera turns over the clip, e.g. 1 for a complete orbit. Default 0. */
  orbit?: number;
  /**
   * Called before each frame renders, with the clip time in ms. Use it to
   * script a clip: change data, drill, move the camera. May return a promise.
   */
  onFrame?: (info: { frame: number; time: number; chart: Chart<any> }) => void | Promise<void>;
  /** Called with the fraction of frames rendered, 0..1. */
  onProgress?: (fraction: number) => void;
  /** Abort a running export. */
  signal?: AbortSignal;
}

// ---- grid charts --------------------------------------------------------------

export interface AxisOptions {
  /** Approximate number of tick intervals. Default 4. */
  ticks?: number;
  title?: string;
}

export interface GridChartOptions<D> extends ChartOptions {
  data?: D[];
  frames?: Frame<D>[];
  x?: Accessor<D, string | number>;
  y?: Accessor<D, string | number>;
  value?: Accessor<D, number>;
  /** Split each cell's value into stacked parts by this key. */
  stack?: Accessor<D, string | number>;
  /** Fixed category order (default: order of first appearance). */
  xDomain?: (string | number)[];
  yDomain?: (string | number)[];
  /** Tick label for a category, or null to skip it. */
  xTicks?: (value: string | number, index: number) => string | null;
  yTicks?: (value: string | number, index: number) => string | null;
  format?: (value: number) => string;
  /** Tooltip title from the record under the pointer. */
  label?: (d: D) => string;
  /** Name of the value (axis title, tooltip). */
  valueLabel?: string;
  /** Series colours: an array, a { key: colour } map, or a function. */
  colors?: string[] | Record<string, string> | ((key: string | number, index: number) => string | undefined);
  /** Fixed scale maximum (default: fitted to the data, rounded with an axis). */
  max?: number;
  /** Height of the maximum value, in world units. */
  height?: number;
  /** World units per category along x and y. */
  spacing?: [number, number];
  /** Value axis on back walls. */
  axis?: boolean | AxisOptions;
  /** Floor grid style; overrides the theme. */
  grid?: 'lines' | 'dots' | 'none';
}

/** One cell of a grid chart. */
export interface GridCell {
  readonly key: string;
  readonly x: string | number;
  readonly y: string | number;
  /** Current (animated) total. */
  readonly total: number;
  /** Current (animated) value of each stack part. */
  readonly value: Float64Array;
}

/** A stacked part of a cell (or the whole cell when unstacked). */
export interface GridPart {
  readonly cell: GridCell;
  readonly index: number;
  readonly stack: string | number | null;
}

export declare class GridChart<D = any, H = GridPart> extends Chart<H> {
  constructor(container: HTMLElement | string, options?: GridChartOptions<D>);
  readonly options: GridChartOptions<D>;
  readonly xs: (string | number)[];
  readonly ys: (string | number)[];
  readonly maxValue: number;
  readonly ticks: number[];
  /** Label of the frame on screen. */
  readonly frameLabel: string | number | null;
  setData(data: D[]): void;
  setFrames(frames: Frame<D>[]): void;
  /** Change options after creation and rebuild from the current data. */
  reconfigure(options: Partial<GridChartOptions<D>> & Record<string, unknown>): void;
}

export interface ReferencePlane {
  value: number;
  label?: string;
  color?: string;
}

export interface IsoBarChartOptions<D> extends GridChartOptions<D> {
  /** Footprint of each bar, 0..1 of a cell. Default 0.62. */
  barWidth?: number;
  /** Value labels: true for all (culled on collision) or N for the tallest N. */
  labels?: boolean | number;
  /** A translucent plane at a value that bars rise through. */
  reference?: number | ReferencePlane;
}

export declare class IsoBarChart<D = any> extends GridChart<D, GridPart> {
  constructor(container: HTMLElement | string, options?: IsoBarChartOptions<D>);
  readonly options: IsoBarChartOptions<D>;
  setReference(reference: number | ReferencePlane | null): void;
}

export interface IsoHeatmapOptions<D> extends GridChartOptions<D> {
  /** Tile footprint, 0..1 of a cell. Default 0.86. */
  tileWidth?: number;
  /** Raise tiles by value. Default true. */
  extrude?: boolean;
  colorScale?: ScaleName | string[];
}

export declare class IsoHeatmap<D = any> extends GridChart<D, GridCell> {
  constructor(container: HTMLElement | string, options?: IsoHeatmapOptions<D>);
  readonly options: IsoHeatmapOptions<D>;
  extrude: boolean;
}

export interface IsoRibbonChartOptions<D> extends GridChartOptions<D> {
  /** Ribbon depth in world units. Default 0.42. */
  thickness?: number;
}

export declare class IsoRibbonChart<D = any> extends GridChart<D, GridCell> {
  constructor(container: HTMLElement | string, options?: IsoRibbonChartOptions<D>);
  readonly options: IsoRibbonChartOptions<D>;
}

// ---- bar chart race -------------------------------------------------------------

export interface RaceBar {
  readonly key: string | number;
  /** Current (interpolated) value. */
  readonly value: number;
  /** 0-based rank; Infinity when the value is 0. */
  readonly rank: number;
  readonly category: string | number;
}

export interface IsoRaceChartOptions<D> extends ChartOptions {
  data?: D[];
  frames?: Frame<D>[];
  /** Entity name. Default 'name'. */
  key?: Accessor<D, string | number>;
  value?: Accessor<D, number>;
  /** Colour by this category instead of by entity. */
  color?: Accessor<D, string | number>;
  /** How many bars stand in the row. Default 10. */
  top?: number;
  barWidth?: number;
  /** Height of the leader, world units. Default 5. */
  height?: number;
  /** Fixed scale maximum (default: follows the leader). */
  max?: number;
  axis?: boolean;
  format?: (value: number) => string;
  valueLabel?: string;
}

export declare class IsoRaceChart<D = any> extends Chart<RaceBar> {
  constructor(container: HTMLElement | string, options?: IsoRaceChartOptions<D>);
  readonly options: IsoRaceChartOptions<D>;
  readonly frameLabel: string | number | null;
  /** The current top N, leader first. */
  readonly standings: { key: string | number; value: number; rank: number }[];
  setData(data: D[]): void;
  setFrames(frames: Frame<D>[]): void;
}

// ---- surface ----------------------------------------------------------------------

export interface WaterLevel {
  value: number;
  label?: string;
  color?: string;
  /** Default 0.42. */
  opacity?: number;
}

export interface IsoSurfaceOptions<D> extends IsoHeatmapOptions<D> {
  /** Contour lines: a count of levels (default 8), explicit values, or false. */
  contours?: number | number[] | false;
  contourColor?: string;
  contourWidth?: number;
  /** Draw the grid mesh over the surface. Default false. */
  mesh?: boolean;
  meshColor?: string;
  /** Bicubic subdivision factor, 1-6. Default: 3 for small grids, 2 for medium, 1 for large. */
  smooth?: number;
  /** 'smooth' averages lighting across vertices; 'flat' lights each facet. Default 'smooth'. */
  shading?: 'smooth' | 'flat';
  /** What the colour ramp follows. Default 'height'. */
  colorBy?: 'height' | 'slope';
  /** Stepped colours: true for bands between contour levels, or a number of equal bands. */
  bands?: boolean | number;
  /** 'wireframe' draws a hidden-line mesh instead of a lit surface. Default 'solid'. */
  style?: 'solid' | 'wireframe';
  /** Lift the terrain by this many world units and project a colour map onto the floor. */
  float?: number;
  /** A level that floods everything below it. */
  water?: number | WaterLevel;
  /** Label the N highest local maxima. */
  peaks?: number;
  /** Solid walls down the near edges. Default true. */
  skirt?: boolean;
  /** Aerial perspective, 0..1: lowlands lose contrast and fade toward the floor. Default 0.35. */
  haze?: number;
  /** Valley occlusion, 0..1: creases and basins darken. Default 0.5. */
  occlusion?: number;
  /** 'illuminated' (Tanaka): light on slopes facing the light, dark away, heavier index lines. Default 'illuminated'. */
  contourStyle?: 'illuminated' | 'plain';
  /** Label the index contours with their values. Default false. */
  contourLabels?: boolean;
  /** Cast shadows from the peaks: true (0.45) or a strength 0..1. Default off. */
  shadows?: boolean | number;
  /** Sun elevation for shadows, degrees. Default 24. */
  shadowAngle?: number;
}

/** A lit, coloured surface over a grid of values, with contour lines. */
export declare class IsoSurface<D = any> extends IsoHeatmap<D> {
  constructor(container: HTMLElement | string, options?: IsoSurfaceOptions<D>);
  readonly options: IsoSurfaceOptions<D>;
}

// ---- cube waffle ----------------------------------------------------------------

export interface WaffleCategory {
  readonly key: string | number;
  readonly index: number;
}

export interface IsoWaffleChartOptions<D> extends ChartOptions {
  data?: D[];
  frames?: Frame<D>[];
  /** Category of each record. Default 'name'. */
  key?: Accessor<D, string | number>;
  value?: Accessor<D, number>;
  /** Value of one cube. Default: a round number that keeps the biggest stack to about `layers` layers. */
  unit?: number;
  /** Shown after the unit in the key, e.g. 'TWh'. */
  unitLabel?: string;
  /** Target layer count for the automatic unit. Default 8. */
  layers?: number;
  /** Cubes per layer as [columns, rows]. Default [4, 4]. */
  footprint?: [number, number];
  /** Stacks per row. Default: a near-square grid. */
  perRow?: number;
  /** Colours by category: array, { key: colour } map or function. */
  colors?: string[] | Record<string, string> | ((key: string | number, index: number) => string | undefined);
  format?: (value: number) => string;
  valueLabel?: string;
}

/** Each category is a stack of cubes; between frames cubes fly from shrinking stacks to growing ones. */
export declare class IsoWaffleChart<D = any> extends Chart<WaffleCategory> {
  constructor(container: HTMLElement | string, options?: IsoWaffleChartOptions<D>);
  readonly options: IsoWaffleChartOptions<D>;
  readonly frameLabel: string | number | null;
  /** Value of one cube. */
  readonly unit: number;
  setData(data: D[]): void;
  setFrames(frames: Frame<D>[]): void;
}

// ---- seasonal helix ----------------------------------------------------------------

export interface HelixPoint<D = any> {
  readonly d: D;
  /** Timestamp, ms. */
  readonly t: number;
  readonly value: number;
  /** Which turn of the coil (0 = first cycle). */
  readonly turn: number;
  /** Position within the cycle, 0..1. */
  readonly frac: number;
}

export interface IsoHelixChartOptions<D> extends ChartOptions {
  data?: D[];
  /** Date, ISO string or ms timestamp. Default 'date'. */
  date?: Accessor<D, Date | string | number>;
  value?: Accessor<D, number>;
  /** One turn per 'year' (months around the ring), 'week' (weekdays) or 'day' (hours). Default 'year'. */
  cycle?: 'year' | 'week' | 'day';
  /** Inner radius of the coil. Default 1.8. */
  radius?: number;
  /** How far the largest value pushes out. Default 3.2. */
  reach?: number;
  /** Rise per turn. Default: fits the coil to a sensible height. */
  turnHeight?: number;
  max?: number;
  colorScale?: ScaleName | string[];
  format?: (value: number) => string;
  valueLabel?: string;
}

/** A time series coiled into a helix, one turn per cycle, so seasonality lines up vertically. */
export declare class IsoHelixChart<D = any> extends Chart<HelixPoint<D>> {
  constructor(container: HTMLElement | string, options?: IsoHelixChartOptions<D>);
  readonly options: IsoHelixChartOptions<D>;
  /** The turn label (e.g. the year) at the playhead. */
  readonly frameLabel: string | null;
  readonly points: HelixPoint<D>[];
  setData(data: D[]): void;
  /** The same point one cycle earlier (directly below), or null. */
  previousCycle(point: HelixPoint<D>): HelixPoint<D> | null;
}

// ---- liquid tanks ---------------------------------------------------------------------

export interface Tank {
  readonly key: string | number;
  readonly index: number;
  /** Current (interpolated) value. */
  readonly value: number;
  readonly capacity: number;
  readonly target: number | null;
  /** How full the liquid is right now, 0..1 (it overshoots a little while settling). */
  readonly level: number;
}

export interface IsoTankChartOptions<D> extends ChartOptions {
  data?: D[];
  frames?: Frame<D>[];
  /** Tank of each record. Default 'name'. */
  key?: Accessor<D, string | number>;
  value?: Accessor<D, number>;
  /** A number for every tank, or a field per record. Default: the largest value seen. */
  capacity?: number | Accessor<D, number>;
  /** A level to stay above, drawn as a dashed ring. */
  target?: number | Accessor<D, number>;
  /** One liquid colour for every tank (default: the series palette). */
  color?: string;
  /** Liquid colour below target, or false to keep the normal colour. Default amber. */
  alertColor?: string | false;
  /** Colours by tank when `color` isn't set. */
  colors?: string[] | Record<string, string> | ((key: string | number, index: number) => string | undefined);
  radius?: number;
  height?: number;
  perRow?: number;
  format?: (value: number) => string;
  valueLabel?: string;
  targetLabel?: string;
}

/** Values as liquid in glass tanks that pour, overshoot and slosh when the data changes. */
export declare class IsoTankChart<D = any> extends Chart<Tank> {
  constructor(container: HTMLElement | string, options?: IsoTankChartOptions<D>);
  readonly options: IsoTankChartOptions<D>;
  readonly frameLabel: string | number | null;
  readonly tanks: Tank[];
  setData(data: D[]): void;
  setFrames(frames: Frame<D>[]): void;
}

// ---- galton board ------------------------------------------------------------------

export interface GaltonBin {
  readonly kind: 'bin';
  /** 0-based bin index. */
  readonly bin: number;
}

export interface IsoGaltonChartOptions<D> extends ChartOptions {
  data?: D[];
  value?: Accessor<D, number>;
  /** Colour balls by this category. */
  color?: Accessor<D, string | number>;
  colors?: string[] | Record<string, string> | ((key: string | number, index: number) => string | undefined);
  /** Ball colour without `color`. */
  ballColor?: string;
  /** Number of bins, 3-31. Default 15. */
  bins?: number;
  /** Value range of the bins. Default: the data's min and max. */
  domain?: [number, number];
  /** At most this many balls; beyond it each ball stands for several records. Default 600. */
  maxBalls?: number;
  /** Balls abreast in each bin. Default 4. */
  perBin?: number;
  /** Height of the tallest stack, world units. Default 4.5. */
  stackHeight?: number;
  ballSize?: number;
  /** ms between balls. Default: the whole pour takes about 7 seconds. */
  interval?: number;
  /** ms from release to landing. Default 1700. */
  fall?: number;
  /** Draw a smoothed outline over the stacks. Default true. */
  curve?: boolean;
  /** Pour on creation. Default true. */
  autoplay?: boolean;
  format?: (value: number) => string;
  countLabel?: string;
}

/** A histogram that builds itself: each record is a ball dropped through pegs into its bin. */
export declare class IsoGaltonChart<D = any> extends Chart<GaltonBin> {
  constructor(container: HTMLElement | string, options?: IsoGaltonChartOptions<D>);
  readonly options: IsoGaltonChartOptions<D>;
  /** "landed / total". */
  readonly frameLabel: string;
  /** Records per bin. */
  readonly counts: number[];
  readonly domain: [number, number];
  setData(data: D[]): void;
}

// ---- balance scale -------------------------------------------------------------------

export interface BalanceSide {
  readonly kind: 'side';
  readonly side: string | number;
  /** 0 = left pan, 1 = right pan. */
  readonly index: number;
}

export interface BalanceItem {
  readonly kind: 'item';
  readonly side: string | number;
  readonly key: string | number;
}

export interface IsoBalanceChartOptions<D> extends ChartOptions {
  data?: D[];
  frames?: Frame<D>[];
  /** Which pan a record goes on: the first two distinct values. Default 'side'. */
  side?: Accessor<D, string | number>;
  /** Item (block) of each record; the same item keeps its colour on both sides. Default 'name'. */
  key?: Accessor<D, string | number>;
  value?: Accessor<D, number>;
  colors?: string[] | Record<string, string> | ((key: string | number, index: number) => string | undefined);
  /** Largest beam angle, radians. Default 0.28. */
  maxTilt?: number;
  /** How strongly a relative difference tilts the beam. Default 5. */
  sensitivity?: number;
  /** Fixed scale for stack heights. Default: the heaviest side seen. */
  max?: number;
  format?: (value: number) => string;
}

/** Two sides on a balance: stacked items on each pan, the beam tilting toward the heavier. */
export declare class IsoBalanceChart<D = any> extends Chart<BalanceSide | BalanceItem> {
  constructor(container: HTMLElement | string, options?: IsoBalanceChartOptions<D>);
  readonly options: IsoBalanceChartOptions<D>;
  readonly frameLabel: string | number | null;
  readonly sides: (string | number)[];
  /** Current (interpolated) total of a side. */
  total(side: string | number): number;
  setData(data: D[]): void;
  setFrames(frames: Frame<D>[]): void;
}

// ---- maps ---------------------------------------------------------------------

export type LonLat = [lon: number, lat: number];
/** [west, south, east, north] in degrees. */
export type Bounds = [number, number, number, number];

export interface Projection {
  forward(lon: number, lat: number): [number, number];
  invert(x: number, y: number): LonLat;
}

export type ProjectionName = 'equalEarth' | 'mercator' | 'equirectangular';

export interface Arc {
  /** A coordinate, or an item key (e.g. a region id for IsoRegionMap). */
  from: LonLat | string;
  to: LonLat | string;
  color?: string;
  colorTo?: string;
  height?: number;
}

export interface Callout {
  at: LonLat | string;
  title: string;
  value?: string;
}

export interface GeoChartOptions<D> extends ChartOptions {
  data?: D[];
  frames?: Frame<D>[];
  value?: Accessor<D, number>;
  /** How records sharing a hex/region combine. Default 'sum'. */
  aggregate?:
    | 'sum'
    | 'mean'
    | 'min'
    | 'max'
    | 'count'
    | ((bin: { sum: number; count: number; min: number; max: number; records: D[] }) => number);
  projection?: ProjectionName | Projection;
  format?: (value: number) => string;
  label?: (d: D) => string;
  valueLabel?: string;
  colorScale?: ScaleName | string[];
  extrude?: boolean;
  max?: number;
  height?: number;
  arcs?: Arc[] | null;
  /** Animate pulses along arcs. Default true. */
  flow?: boolean;
  /** Label the top N items, or specific places. */
  callouts?: number | Callout[];
  landColor?: string;
}

/** A hex or region with data. */
export interface GeoItem {
  readonly id: string;
  /** World position of the item's anchor. */
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly name?: string;
}

export declare class GeoChart<D = any, I extends GeoItem = GeoItem> extends Chart<I> {
  constructor(container: HTMLElement | string, options?: GeoChartOptions<D>);
  readonly options: GeoChartOptions<D>;
  readonly items: Map<string, I>;
  readonly mapWidth: number;
  readonly mapDepth: number;
  readonly maxValue: number;
  readonly frameLabel: string | number | null;
  setData(data: D[]): void;
  setFrames(frames: Frame<D>[]): void;
  /** Change options at runtime; layout options rebuild and re-bin the data. */
  reconfigure(options: Partial<GeoChartOptions<D>> & Record<string, unknown>): void;
  /** World [x, y] of a coordinate. */
  toWorld(lon: number, lat: number): [number, number];
  toLonLat(x: number, y: number): LonLat;
  /** Screen position of a coordinate, optionally at a height. */
  project(lon: number, lat: number, z?: number): { x: number; y: number; depth: number };
  /** Coordinate under a screen point, or null. */
  invert(px: number, py: number): LonLat | null;
}

export interface Hex extends GeoItem {
  readonly q: number;
  readonly r: number;
  readonly lon: number;
  readonly lat: number;
}

export interface IsoHexMapOptions<D> extends GeoChartOptions<D> {
  lon?: Accessor<D, number>;
  lat?: Accessor<D, number>;
  /** Hexes across the map. Default 96. */
  columns?: number;
  /** Corner rounding, 0 (sharp) to 1 (nearly round). Default 0.35. */
  rounding?: number;
  /** Space between hexes, fraction of hex size. Default 0.14. */
  gap?: number;
  /** Region to show; Antarctica is excluded by default. */
  bounds?: Bounds;
  /** Fraction of a hex that must be land to draw it. Default 0.3. */
  landThreshold?: number;
}

export declare class IsoHexMap<D = any> extends GeoChart<D, Hex> {
  constructor(container: HTMLElement | string, options?: IsoHexMapOptions<D>);
  readonly options: IsoHexMapOptions<D>;
  readonly hexes: Map<string, Hex>;
  rounding: number;
  gap: number;
  /** The hex containing a coordinate. */
  hexAt(lon: number, lat: number): Hex;
  reconfigure(options: Partial<IsoHexMapOptions<D>>): void;
}

export interface GeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry: { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] } | null;
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

export interface Region extends GeoItem {
  readonly feature: GeoJSONFeature;
}

export interface TopoJSONTopology {
  type: 'Topology';
  objects: Record<string, unknown>;
  arcs: number[][][];
  transform?: { scale: [number, number]; translate: [number, number] };
}

export interface IsoRegionMapOptions<D> extends GeoChartOptions<D> {
  /** The regions to draw, at any level: GeoJSON, or TopoJSON with `object`. */
  regions: GeoJSONFeatureCollection | TopoJSONTopology;
  /** The TopoJSON object to use (e.g. 'states', 'counties'). Default: the first. */
  object?: string;
  /** Field naming each record's region; matches feature ids or `joinOn` properties. */
  key?: Accessor<D, string | number>;
  /** Without `key`: place each record in the region containing this coordinate. */
  lon?: Accessor<D, number>;
  lat?: Accessor<D, number>;
  /** A feature's id. Default: feature.id, then properties.id, then properties.name. */
  regionId?: (feature: GeoJSONFeature, index: number) => string | number;
  /** A feature's display name. Default: properties.name, then NAME, then the id. */
  regionName?: (feature: GeoJSONFeature, id: string) => string;
  /** Which features to draw. */
  filter?: (feature: GeoJSONFeature) => boolean;
  /** Feature properties data can join on. Default name, iso2, iso3, isoNumeric. */
  joinOn?: string[];
  /** Feature ids to leave out. Default ['ATA']. */
  exclude?: string[];
  bounds?: Bounds;
  /** Shape detail, 0 (simplified) to 1 (every visible bend). Default 1. */
  detail?: number;
  /** Simplification tolerance in world units (overrides `detail`). */
  simplify?: number;
  /** Width of the borders between regions, px. Default 0.75; 0 hides them. */
  borderWidth?: number;
  /** Outline width on raised tops, px. Default 1. */
  edgeWidth?: number;
  /** Outline colour on raised tops; 'none' hides it. Default: a highlight of the fill. */
  edgeColor?: string;
  /** Map width in world units. Default 100. */
  width?: number;
  /** Region names and values on the tallest regions: true for all, or N. */
  labels?: boolean | number;
  /** Colour of the hovered region. */
  hoverColor?: string;
  borderColor?: string;
}

export declare class IsoRegionMap<D = any> extends GeoChart<D, Region> {
  constructor(container: HTMLElement | string, options: IsoRegionMapOptions<D>);
  readonly options: IsoRegionMapOptions<D>;
  /** Keys that matched no region (also warned in the console). */
  readonly unmatched: Set<unknown>;
  /** Region id for a key ('DE', 'DEU', 'Germany', 276), if any. */
  resolve(key: unknown): string | undefined;
  /** How many levels below the first we are. */
  readonly depth: number;
  /** Show deeper regions (with new data and level options); drillUp() returns. */
  drill(
    regions: GeoJSONFeatureCollection | TopoJSONTopology,
    options?: Partial<IsoRegionMapOptions<any>> & { data?: unknown[]; frames?: Frame<any>[] },
  ): void;
  /** Back to the previous level; false at the top. */
  drillUp(): boolean;
  /** The region at a coordinate. */
  regionAt(lon: number, lat: number): Region | null;
  reconfigure(options: Partial<IsoRegionMapOptions<D>>): void;
}

// ---- engine -------------------------------------------------------------------

export declare const ISO_YAW: number;
export declare const ISO_PITCH: number;
export declare const VIEWS: Record<ViewName, Required<Pick<CameraView, 'yaw' | 'pitch'>>>;

export declare class Camera {
  constructor(view?: CameraView);
  yaw: number;
  pitch: number;
  zoom: number;
  scale: number;
  update(): void;
  project(x: number, y: number, z: number): { x: number; y: number; depth: number };
  unproject(px: number, py: number): [number, number] | null;
  groundDepth(x: number, y: number): number;
  faces(nx: number, ny: number, nz: number): boolean;
  light(nx: number, ny: number, nz: number): number;
}

export type Easing = (t: number) => number;
export declare const ease: { linear: Easing; cubicOut: Easing; cubicInOut: Easing; backOut: Easing };

export declare class Tween {
  constructor(value?: number);
  value: number;
  target: number;
  to(target: number, now: number, options?: { duration?: number; delay?: number; easing?: Easing }): void;
  set(value: number): void;
  /** Advance; true while still changing. */
  tick(now: number): boolean;
}

export declare class Timeline {
  constructor(options?: { length?: number; frameDuration?: number; loop?: boolean });
  length: number;
  frameDuration: number;
  loop: boolean;
  /** Fractional frame position. */
  position: number;
  playing: boolean;
  play(): void;
  pause(): void;
  seek(position: number): void;
  tick(now: number): boolean;
}

export declare const themes: Record<string, Theme>;
export declare const scales: Record<ScaleName, string[]>;
export declare function registerTheme(name: string, theme: Partial<Theme> & { extends?: ThemeName }): Theme;
export declare function resolveTheme(theme?: ThemeInput): Theme;

export declare const projections: Record<ProjectionName, Projection>;
/** Whether a coordinate is land (0.5 degree resolution). */
export declare function isLand(lon: number, lat: number): boolean;
/** Polygon features of a TopoJSON object as GeoJSON (ids and properties kept). */
export declare function topojsonFeatures(topology: TopoJSONTopology, object?: string): GeoJSONFeatureCollection;
