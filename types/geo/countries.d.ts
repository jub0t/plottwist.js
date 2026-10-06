import type { GeoJSONFeature, GeoJSONFeatureCollection } from '../index.js';

export type CountryProperties = {
  name: string;
  iso2: string;
  iso3: string;
  isoNumeric: string;
};

export interface CountryFeature extends GeoJSONFeature {
  id: string;
  properties: CountryProperties;
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
}

/** World countries (Natural Earth 1:110m) as GeoJSON; ids are ISO alpha-3. */
export declare function worldCountries(): GeoJSONFeatureCollection & { features: CountryFeature[] };
