// The demo charts, shared by the gallery (index.html) and the README showcase
// (showcase.html). All data is synthetic; city coordinates are real.
//
// Each demo's create(el, options) builds its chart and returns
// { chart, shuffle } where shuffle() swaps in a fresh random dataset.

import {
  IsoBarChart, IsoHeatmap, IsoHexMap, IsoRaceChart, IsoRegionMap, IsoRibbonChart, IsoSurface, IsoWaffleChart, IsoHelixChart, IsoTankChart, IsoGaltonChart,
} from '../src/index.js';
import { worldCountries } from '../src/geo/countries.js';

const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- hex world map ------------------------------------------------------------

// [name, lon, lat, weight]: real coordinates; weights are made up.
export const cities = [
  ['New York', -74.0, 40.71, 10], ['Los Angeles', -118.24, 34.05, 7], ['Chicago', -87.63, 41.88, 6],
  ['Toronto', -79.38, 43.65, 4], ['Vancouver', -123.12, 49.28, 2], ['San Francisco', -122.42, 37.77, 7],
  ['Miami', -80.19, 25.76, 3], ['Mexico City', -99.13, 19.43, 5], ['Bogotá', -74.07, 4.71, 3],
  ['Lima', -77.04, -12.05, 2], ['Manaus', -60.02, -3.12, 1], ['São Paulo', -46.63, -23.55, 7],
  ['Buenos Aires', -58.38, -34.6, 4], ['London', -0.13, 51.51, 9], ['Paris', 2.35, 48.86, 7],
  ['Berlin', 13.4, 52.52, 6], ['Madrid', -3.7, 40.42, 4], ['Rome', 12.5, 41.9, 3],
  ['Stockholm', 18.07, 59.33, 2], ['Moscow', 37.62, 55.76, 5], ['Istanbul', 28.98, 41.01, 4],
  ['Casablanca', -7.59, 33.57, 2], ['Cairo', 31.24, 30.04, 4], ['Lagos', 3.38, 6.52, 4],
  ['Nairobi', 36.82, -1.29, 2], ['Johannesburg', 28.05, -26.2, 3], ['Riyadh', 46.68, 24.71, 3],
  ['Dubai', 55.27, 25.2, 4], ['Karachi', 67.0, 24.86, 3], ['Delhi', 77.1, 28.7, 7],
  ['Mumbai', 72.88, 19.08, 7], ['Bangalore', 77.59, 12.97, 6], ['Bangkok', 100.5, 13.76, 4],
  ['Ho Chi Minh City', 106.63, 10.82, 3], ['Singapore', 103.82, 1.35, 5], ['Jakarta', 106.85, -6.21, 5],
  ['Manila', 120.98, 14.6, 4], ['Shenzhen', 114.06, 22.54, 7], ['Shanghai', 121.47, 31.23, 9],
  ['Beijing', 116.41, 39.9, 8], ['Seoul', 126.98, 37.57, 6], ['Tokyo', 139.69, 35.69, 9],
  ['Sydney', 151.21, -33.87, 4], ['Melbourne', 144.96, -37.81, 3], ['Auckland', 174.76, -36.85, 1],
];

const cityAt = (name) => cities.find((c) => c[0] === name).slice(1, 3);

export const mapArcs = [
  ['New York', 'London'], ['London', 'Mumbai'], ['Shanghai', 'Tokyo'], ['New York', 'São Paulo'],
  ['London', 'Lagos'], ['Shanghai', 'Sydney'], ['Mumbai', 'Shanghai'],
].map(([a, b]) => ({ from: cityAt(a), to: cityAt(b) }));

function worldActivity(seed) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
  const growth = cities.map(() => 0.05 + r() * 0.35);
  // Fixed scatter per city so hexes persist across years and morph smoothly.
  const points = cities.flatMap(([city, lon, lat, w], ci) =>
    Array.from({ length: 6 + w * 3 }, () => ({
      city,
      lon: lon + gauss() * (0.6 + w * 0.12),
      lat: lat + gauss() * (0.5 + w * 0.1),
      share: r() * r(),
      ci,
    })),
  );
  return [2020, 2021, 2022, 2023, 2024, 2025].map((year, t) => ({
    label: year,
    data: points.map((p) => ({ ...p, users: cities[p.ci][3] * p.share * 40 * (1 + growth[p.ci]) ** t })),
  }));
}

// ---- bars over time -----------------------------------------------------------

function activeUsers(seed) {
  const r = rng(seed);
  const regions = ['N. America', 'Europe', 'Asia Pacific', 'LatAm', 'MEA'];
  const platforms = ['Web', 'iOS', 'Android', 'Desktop'];
  const curves = regions.flatMap((region) =>
    platforms.map((platform) => ({
      region,
      platform,
      base: 4 + r() * 30,
      growth: (platform === 'Desktop' ? -0.06 : 0.04) + r() * 0.22,
    })),
  );
  return [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map((year, t) => ({
    label: year,
    data: curves.map((c) => ({
      region: c.region,
      platform: c.platform,
      users: c.base * (1 + c.growth) ** t * (0.92 + r() * 0.16),
    })),
  }));
}

// ---- stacked city blocks ---------------------------------------------------------

function revenue(seed) {
  const r = rng(seed);
  const regions = ['North', 'Central', 'South'];
  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
  const channels = ['Online', 'Retail', 'Partner'];
  const base = regions.map(() => channels.map(() => 6 + r() * 14));
  return [2022, 2023, 2024, 2025].map((year, t) => ({
    label: year,
    data: regions.flatMap((region, ri) =>
      quarters.flatMap((quarter, qi) =>
        channels.map((channel, ci) => ({
          region,
          quarter,
          channel,
          // Online grows, retail shrinks, Q4 is seasonal.
          revenue: base[ri][ci] * (1 + [0.25, -0.08, 0.1][ci] * t) * (qi === 3 ? 1.35 : 1) * (0.9 + r() * 0.2),
        })),
      ),
    ),
  }));
}

// ---- calendar heatmap -------------------------------------------------------------

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const YEAR = 2025;
const JAN1 = new Date(Date.UTC(YEAR, 0, 1));
const OFFSET = (JAN1.getUTCDay() + 6) % 7; // Monday = 0

// The week containing the 1st of each month gets that month's label.
const monthAt = new Map(
  MONTHS.map((m, i) => [Math.floor((Math.round((Date.UTC(YEAR, i, 1) - JAN1) / 864e5) + OFFSET) / 7), m]),
);

function commits(seed) {
  const r = rng(seed);
  const data = [];
  let streak = 0;
  for (let d = 0; d < 365; d++) {
    const date = new Date(JAN1.getTime() + d * 864e5);
    const wd = (date.getUTCDay() + 6) % 7;
    if (r() < 0.04) streak = 4 + Math.floor(r() * 8);
    const busy = streak-- > 0 ? 2.2 : 1;
    const weekend = wd >= 5 ? 0.25 : 1;
    const v = r() < 0.12 ? 0 : Math.round(r() * 9 * busy * weekend);
    data.push({ week: Math.floor((d + OFFSET) / 7), day: DAYS[wd], date, commits: v });
  }
  return data;
}

// ---- ribbons --------------------------------------------------------------------

function visits(seed) {
  const r = rng(seed);
  const periods = Array.from({ length: 36 }, (_, i) => `${MONTHS[i % 12]} ${23 + Math.floor(i / 12)}`);
  return ['Search', 'Social', 'Email', 'Direct'].flatMap((channel, c) => {
    const base = 20 + r() * 40;
    const trend = -0.4 + r() * 1.6;
    const phase = r() * Math.PI * 2;
    return periods.map((month, i) => ({
      month,
      channel,
      visits: Math.max(2, base + trend * i + Math.sin(i / 1.9 + phase) * (6 + c * 2) + (r() - 0.5) * 6),
    }));
  });
}

// ---- region map ------------------------------------------------------------------

// ISO alpha-3 codes with made-up base weights.
const markets = {
  USA: 10, CAN: 4, MEX: 3, BRA: 5, ARG: 2, COL: 2, CHL: 1.5, GBR: 6, FRA: 5, DEU: 7, ESP: 3, ITA: 3,
  NLD: 2.5, SWE: 2, POL: 2, TUR: 2, RUS: 4, EGY: 1.5, NGA: 2, ZAF: 2, KEN: 1, SAU: 2.5, ARE: 2, IND: 7,
  PAK: 1.5, CHN: 9, JPN: 6, KOR: 4, IDN: 3, THA: 2, VNM: 2, PHL: 1.5, MYS: 1.5, AUS: 4, NZL: 1,
};

function revenueByCountry(seed) {
  const r = rng(seed);
  const growth = Object.fromEntries(Object.keys(markets).map((k) => [k, 0.02 + r() * 0.3]));
  return [2021, 2022, 2023, 2024, 2025].map((year, t) => ({
    label: year,
    data: Object.entries(markets).map(([country, w]) => ({
      country,
      revenue: w * 12 * (1 + growth[country]) ** t * (0.9 + r() * 0.2),
    })),
  }));
}

export const regionArcs = [
  ['USA', 'GBR'], ['GBR', 'IND'], ['CHN', 'JPN'], ['USA', 'BRA'], ['DEU', 'ZAF'], ['CHN', 'AUS'],
].map(([from, to]) => ({ from, to }));

// ---- bar chart race --------------------------------------------------------------

// Fictional apps; each grows on its own S-curve so the standings keep changing.
const apps = [
  ['Nimbus', 'Social'], ['Quill', 'Productivity'], ['Orbit', 'Social'], ['Pixel Forge', 'Games'],
  ['Tandem', 'Productivity'], ['Echo', 'Social'], ['Lumen', 'Productivity'], ['Rift', 'Games'],
  ['Harbor', 'Productivity'], ['Kite', 'Social'], ['Vault', 'Games'], ['Prism', 'Social'],
  ['Atlas', 'Productivity'], ['Glyph', 'Games'],
];

function appUsers(seed) {
  const r = rng(seed);
  const curves = apps.map(([name, genre]) => ({
    name,
    genre,
    peak: 40 + r() * 160,
    mid: 2012 + r() * 12,
    speed: 0.5 + r() * 0.9,
    fade: r() < 0.3 ? 0.06 + r() * 0.1 : 0,
  }));
  return Array.from({ length: 16 }, (_, t) => {
    const year = 2010 + t;
    return {
      label: year,
      data: curves.map((c) => {
        const s = 1 / (1 + Math.exp(-c.speed * (year - c.mid)));
        const decline = c.fade ? Math.max(0.25, 1 - c.fade * Math.max(0, year - c.mid - 4)) : 1;
        return { name: c.name, genre: c.genre, users: c.peak * s * decline * (0.95 + r() * 0.1) };
      }),
    };
  });
}

// ---- energy mix (cube waffle) ------------------------------------------------------

// [source, TWh in 2000, TWh in 2025]: a synthetic country shifting from coal
// to wind and solar. Years in between ease along an S-curve, with noise.
const SOURCES = [
  ['Coal', 124, 18], ['Gas', 58, 74], ['Nuclear', 52, 44], ['Hydro', 30, 33], ['Wind', 1, 72], ['Solar', 0, 66],
];

function energyMix(seed) {
  const r = rng(seed);
  return [2000, 2005, 2010, 2015, 2020, 2025].map((year, t) => {
    const s = 1 / (1 + Math.exp(-(t - 3) * 1.4));
    return {
      label: year,
      data: SOURCES.map(([source, a, b]) => ({ source, twh: Math.max(0, (a + (b - a) * s) * (0.94 + r() * 0.12)) })),
    };
  });
}

// ---- office signal (surface) -------------------------------------------------------

// Wi-Fi signal quality over a 36 x 24 m office floor: five access points,
// with crowds soaking up signal as the day goes on.
const ACCESS_POINTS = [[6, 5], [18, 4], [30, 7], [10, 18], [26, 19]];

function officeSignal(seed) {
  const r = rng(seed);
  const strength = ACCESS_POINTS.map(() => 0.75 + r() * 0.25);
  const crowds = Array.from({ length: 4 }, () => [4 + r() * 28, 3 + r() * 18, 3 + r() * 4]);
  return ['08:00', '11:00', '14:00', '17:00'].map((label, t) => {
    const busy = [0.15, 0.85, 1, 0.45][t];
    const data = [];
    for (let x = 0; x < 36; x++) {
      for (let y = 0; y < 24; y++) {
        // Smooth union of the access points' coverage (no creases).
        let miss = 1;
        ACCESS_POINTS.forEach(([ax, ay], k) => {
          const d2 = (x - ax) ** 2 + (y - ay) ** 2;
          miss *= 1 - strength[k] * Math.exp(-d2 / 30);
        });
        let q = 100 * (1 - miss);
        for (const [cx, cy, rad] of crowds) q *= 1 - busy * 0.45 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (rad * rad));
        data.push({ x, y, quality: Math.max(4, q) });
      }
    }
    return { label, data };
  });
}

// ---- bike share (helix) ------------------------------------------------------------

// Weekly rides on a city bike share, 2021-2025: a summer peak, steady growth,
// and the odd washed-out week.
function bikeRides(seed) {
  const r = rng(seed);
  const start = Date.UTC(2021, 0, 4);
  return Array.from({ length: 260 }, (_, w) => {
    const t = start + w * 7 * 86400000;
    const year = new Date(t).getUTCFullYear() - 2021;
    const frac = (t - Date.UTC(2021 + year, 0, 1)) / (365.25 * 86400000);
    const season = 0.35 + 0.65 * Math.max(0, Math.sin(Math.PI * (frac - 0.12) / 0.8)) ** 1.4;
    const rain = r() < 0.08 ? 0.55 : 1;
    const holiday = frac > 0.96 || frac < 0.02 ? 0.6 : 1;
    return { week: new Date(t), rides: 18 * 1.16 ** year * season * rain * holiday * (0.92 + r() * 0.16) };
  });
}

// ---- reservoirs (tanks) --------------------------------------------------------------

// Stored water in six reservoirs, GL, through a dry year: [name, capacity,
// minimum safe level, how hard the dry season hits].
const RESERVOIRS = [
  ['Harlow', 420, 120, 0.5], ['Kestrel', 300, 90, 1.05], ['Mere', 510, 140, 0.35],
  ['Ashby', 260, 80, 1.25], ['Tarn', 380, 110, 0.6], ['Wych', 220, 70, 0.8],
];

function reservoirLevels(seed) {
  const r = rng(seed);
  const start = RESERVOIRS.map(() => 0.78 + r() * 0.18);
  return ['Mar', 'May', 'Jul', 'Sep', 'Nov', 'Jan'].map((label, t) => {
    const dry = [0, 0.35, 0.8, 1, 0.55, 0.15][t];
    return {
      label,
      data: RESERVOIRS.map(([name, capacity, minimum, hit], k) => ({
        name,
        capacity,
        minimum,
        stored: capacity * Math.max(0.08, start[k] - dry * hit * 0.62) * (0.96 + r() * 0.08),
      })),
    };
  });
}

// ---- commute times (galton) ----------------------------------------------------------

// Minutes to work for 600 people, by mode: bikes cluster short, trains
// tight around their timetable, cars spread wide with a long tail.
function commutes(seed) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
  const modes = [['Bike', 0.3, 18, 5], ['Train', 0.35, 38, 6], ['Car', 0.35, 31, 11]];
  return Array.from({ length: 600 }, () => {
    let u = r();
    const [mode, , mean, sd] = modes.find(([, share]) => (u -= share) < 0) ?? modes[2];
    const tail = mode === 'Car' && r() < 0.15 ? 18 * r() : 0;
    return { mode, minutes: Math.max(4, Math.min(74, mean + gauss() * sd + tail)) };
  });
}

// ---- demos ------------------------------------------------------------------------

// Builds a demo: `make(seed)` produces data, `build(el, data, extra)` the chart.
function demo(seed, reseed, make, build) {
  return (el, extra = {}) => {
    let s = seed;
    const chart = build(el, make(s), extra);
    const apply = (data) => (Array.isArray(data) && data[0]?.label !== undefined ? chart.setFrames(data) : chart.setData(data));
    return { chart, shuffle: () => apply(make(++s * reseed)) };
  };
}

export const demos = {
  map: {
    title: 'Hex world map',
    type: 'IsoHexMap',
    create: demo(21, 7177, worldActivity, (el, frames, extra) =>
      new IsoHexMap(el, {
        frames,
        lon: 'lon',
        lat: 'lat',
        value: 'users',
        columns: 110,
        rounding: 0.45,
        gap: 0.16,
        callouts: 5,
        label: (d) => d.city,
        valueLabel: 'Users',
        format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
        ariaLabel: 'Hexagonal world map of active users by location',
        ...extra,
      }),
    ),
  },
  regions: {
    title: 'Region map',
    type: 'IsoRegionMap',
    create: demo(5, 3301, revenueByCountry, (el, frames, extra) =>
      new IsoRegionMap(el, {
        regions: worldCountries(),
        frames,
        key: 'country',
        value: 'revenue',
        valueLabel: 'Revenue',
        labels: 6,
        format: (v) => `$${v >= 100 ? v.toFixed(0) : v.toFixed(1)}M`,
        ariaLabel: 'Extruded world map of revenue by country',
        ...extra,
      }),
    ),
  },
  race: {
    title: 'Bar chart race',
    type: 'IsoRaceChart',
    create: demo(9, 6151, appUsers, (el, frames, extra) =>
      new IsoRaceChart(el, {
        frames,
        key: 'name',
        value: 'users',
        color: 'genre',
        top: 8,
        valueLabel: 'Users',
        format: (v) => `${v.toFixed(0)}M`,
        frameDuration: 900,
        ariaLabel: 'Bar chart race of monthly active users by app over time',
        ...extra,
      }),
    ),
  },
  waffle: {
    title: 'Cube waffle',
    type: 'IsoWaffleChart',
    create: demo(4, 8191, energyMix, (el, frames, extra) =>
      new IsoWaffleChart(el, {
        frames,
        key: 'source',
        value: 'twh',
        footprint: [3, 3],
        unit: 2,
        unitLabel: 'TWh',
        valueLabel: 'Generation',
        format: (v) => `${v.toFixed(0)}`,
        colors: { Coal: '#64748b', Gas: '#d97706', Nuclear: '#8b5cf6', Hydro: '#3b82f6', Wind: '#0891b2', Solar: '#ec4899' },
        ariaLabel: 'Cube waffle of electricity generation by source over time; each cube is 2 TWh',
        ...extra,
      }),
    ),
  },
  surface: {
    title: 'Terrain surface',
    type: 'IsoSurface',
    create: demo(8, 6007, officeSignal, (el, frames, extra) =>
      new IsoSurface(el, {
        frames,
        x: 'x',
        y: 'y',
        value: 'quality',
        valueLabel: 'Signal',
        xTicks: (v) => (v % 6 === 0 ? `${v} m` : null),
        yTicks: (v) => (v % 6 === 0 ? `${v} m` : null),
        format: (v) => `${v.toFixed(0)}%`,
        frameDuration: 2000,
        ariaLabel: 'Surface of Wi-Fi signal quality across an office floor at four times of day',
        ...extra,
      }),
    ),
  },
  helix: {
    title: 'Seasonal helix',
    type: 'IsoHelixChart',
    create: demo(12, 9241, bikeRides, (el, data, extra) =>
      new IsoHelixChart(el, {
        data,
        date: 'week',
        value: 'rides',
        valueLabel: 'Rides',
        format: (v) => `${v.toFixed(1)}k`,
        ariaLabel: 'Helix of weekly bike-share rides 2021 to 2025, one turn per year',
        ...extra,
      }),
    ),
  },
  tanks: {
    title: 'Liquid tanks',
    type: 'IsoTankChart',
    create: demo(13, 5521, reservoirLevels, (el, frames, extra) =>
      new IsoTankChart(el, {
        frames,
        key: 'name',
        value: 'stored',
        capacity: 'capacity',
        target: 'minimum',
        color: '#38bdf8',
        valueLabel: 'Stored',
        targetLabel: 'Safe minimum',
        format: (v) => `${v.toFixed(0)} GL`,
        ariaLabel: 'Six reservoirs as glass tanks through a dry year, with safe minimum levels',
        ...extra,
      }),
    ),
  },
  galton: {
    title: 'Galton board',
    type: 'IsoGaltonChart',
    create: demo(14, 7741, commutes, (el, data, extra) =>
      new IsoGaltonChart(el, {
        data,
        value: 'minutes',
        color: 'mode',
        bins: 15,
        domain: [0, 75],
        format: (v) => `${Math.round(v)}`,
        countLabel: 'People',
        ariaLabel: 'Galton board: 600 commute times fall into a histogram of minutes, coloured by mode',
        ...extra,
      }),
    ),
  },
  bars: {
    title: 'Bars over time',
    type: 'IsoBarChart',
    create: demo(42, 7919, activeUsers, (el, frames, extra) =>
      new IsoBarChart(el, {
        frames,
        x: 'region',
        y: 'platform',
        value: 'users',
        valueLabel: 'Users',
        format: (v) => `${+v.toFixed(1)}M`,
        labels: 5,
        reference: { value: 40, label: 'Target' },
        frameDuration: 1200,
        ariaLabel: 'Isometric bar chart of monthly active users by region and platform over time',
        ...extra,
      }),
    ),
  },
  stack: {
    title: 'Stacked city blocks',
    type: 'IsoBarChart · stack',
    create: demo(7, 104729, revenue, (el, frames, extra) =>
      new IsoBarChart(el, {
        frames,
        x: 'quarter',
        y: 'region',
        stack: 'channel',
        value: 'revenue',
        valueLabel: 'Revenue',
        labels: true,
        barWidth: 0.56,
        format: (v) => `$${+v.toFixed(1)}M`,
        ariaLabel: 'Stacked isometric bars of quarterly revenue by region and channel',
        ...extra,
      }),
    ),
  },
  calendar: {
    title: 'Calendar heatmap',
    type: 'IsoHeatmap',
    create: demo(3, 31337, commits, (el, data, extra) =>
      new IsoHeatmap(el, {
        data,
        x: 'week',
        y: 'day',
        value: 'commits',
        xDomain: Array.from({ length: 53 }, (_, i) => i),
        yDomain: DAYS,
        xTicks: (week) => monthAt.get(week) ?? null,
        yTicks: (day, i) => (i % 2 === 0 ? day : null),
        label: (d) =>
          d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
        valueLabel: 'Commits',
        format: (v) => String(Math.round(v)),
        camera: { yaw: 0.38, pitch: 0.82 },
        ariaLabel: 'Isometric calendar heatmap of daily commits',
        ...extra,
      }),
    ),
  },
  ribbon: {
    title: 'Ribbon lines',
    type: 'IsoRibbonChart',
    create: demo(11, 2477, visits, (el, data, extra) =>
      new IsoRibbonChart(el, {
        data,
        x: 'month',
        y: 'channel',
        value: 'visits',
        valueLabel: 'Visits',
        xTicks: (m) => (m.startsWith('Jan') || m.startsWith('Jul') ? m : null),
        format: (v) => `${+v.toFixed(1)}k`,
        camera: { yaw: 0.32, pitch: 0.62 },
        ariaLabel: 'Ribbon chart of monthly site visits by channel',
        ...extra,
      }),
    ),
  },
};
