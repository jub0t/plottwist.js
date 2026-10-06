// World countries as a GeoJSON FeatureCollection, decoded lazily from the
// compact module built by scripts/build-countries.js. Import this only when
// you need it; the rest of the library doesn't depend on it.
//
//   import { worldCountries } from 'plottwist/geo/countries';
//   new IsoRegionMap(el, { regions: worldCountries(), ... });
//
// 1:110m outlines (67 KB). For zoomed-in regional maps, plottwist/geo/countries-50m
// has 1:50m outlines (471 KB).
//
// Feature ids are ISO 3166 alpha-3 codes; properties carry name, iso2, iso3
// and isoNumeric, so data can join on any of them.

import * as data from './countries-data.js';
import { decodeCountries } from './decode-countries.js';

let cache = null;

export function worldCountries() {
  return (cache ??= decodeCountries(data));
}
