// World countries at Natural Earth 1:50m as GeoJSON: crisper coastlines for
// regional maps (pair with IsoRegionMap's `bounds`). Heavier than the 1:110m
// default (471 KB vs 67 KB), so it's a separate import.
//
//   import { worldCountries50m } from 'plottwist/geo/countries-50m';

import * as data from './countries-50m-data.js';
import { decodeCountries } from './decode-countries.js';

let cache = null;

export function worldCountries50m() {
  return (cache ??= decodeCountries(data));
}
