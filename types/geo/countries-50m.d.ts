import type { CountryFeature } from './countries.js';
import type { GeoJSONFeatureCollection } from '../index.js';

/** World countries at Natural Earth 1:50m as GeoJSON; ids are ISO alpha-3. */
export declare function worldCountries50m(): GeoJSONFeatureCollection & { features: CountryFeature[] };
