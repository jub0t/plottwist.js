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
export type ScaleName = 'violet' | 'blue' | 'emerald' | 'orange' | 'magenta' | 'teal';

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
  destroy(): void;
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

export interface IsoRegionMapOptions<D> extends GeoChartOptions<D> {
  /** The regions to draw. */
  regions: GeoJSONFeatureCollection;
  /** Field naming each record's region; matches feature ids or `joinOn` properties. */
  key?: Accessor<D, string | number>;
  /** Feature properties data can join on. Default name, iso2, iso3, isoNumeric. */
  joinOn?: string[];
  /** Feature ids to leave out. Default ['ATA']. */
  exclude?: string[];
  bounds?: Bounds;
  /** Simplification tolerance in world units. */
  simplify?: number;
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
