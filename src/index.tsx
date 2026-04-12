import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';
import type { Bindings, AppVariables } from './types';
import { searchProperties, getPropertyById, getStats, logSearch } from './db/queries';
import { aggregateSearch } from './scrapers/aggregator';
import { PREFECTURES, SITES } from './types';

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

// =====================
// Middleware
// =====================
app.use('*', logger());
app.use('*', timing());
app.use('*', secureHeaders());
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Request ID
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

// =====================
// API Routes
// =====================

// Search properties
app.get('/api/search', async (c) => {
  const q = c.req.query();
  const startTime = Date.now();

  const params = {
    query: q.q,
    prefecture: q.prefecture as any,
    city: q.city,
    propertyType: q.type as any,
    priceMin: q.price_min ? parseInt(q.price_min) : undefined,
    priceMax: q.price_max ? parseInt(q.price_max) : undefined,
    areaMin: q.area_min ? parseFloat(q.area_min) : undefined,
    areaMax: q.area_max ? parseFloat(q.area_max) : undefined,
    rooms: q.rooms,
    ageMax: q.age_max ? parseInt(q.age_max) : undefined,
    stationMinutes: q.station_min ? parseInt(q.station_min) : undefined,
    sites: q.sites ? (q.sites.split(',') as any) : undefined,
    sortBy: q.sort as any,
    page: q.page ? parseInt(q.page) : 1,
    limit: q.limit ? parseInt(q.limit) : 20,
  };

  try {
    const cacheKey = `search:${new URLSearchParams(q).toString()}`;
    const cached = await c.env.MAL_CACHE.get(cacheKey, 'json').catch(() => null);
    if (cached) return c.json({ ...(cached as object), cacheHit: true });

    const dbResult = await searchProperties(c.env.MAL_DB, params).catch(() => null);

    if (dbResult && dbResult.total > 0) {
      await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(dbResult), { expirationTtl: 3600 }).catch(() => {});
      return c.json(dbResult);
    }

    const { properties, siteResults } = await aggregateSearch(params, c.env);
    const page = params.page;
    const limit = params.limit;
    const start = (page - 1) * limit;
    const result = {
      properties: properties.slice(start, start + limit),
      total: properties.length,
      page,
      limit,
      totalPages: Math.ceil(properties.length / limit),
      sites: siteResults,
      executionTimeMs: Date.now() - startTime,
      cacheHit: false,
    };

    await c.env.MAL_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }).catch(() => {});
    // Log search for analytics (fire-and-forget)
    logSearch(c.env.MAL_DB, params, result.total, result.executionTimeMs).catch(() => {});
    return c.json(result);
  } catch (error) {
    return c.json({ error: 'Search failed', message: String(error) }, 500);
  }
});

// Property detail
app.get('/api/properties/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const property = await getPropertyById(c.env.MAL_DB, id);
    if (!property) return c.json({ error: 'Property not found' }, 404);
    return c.json(property);
  } catch (error) {
    return c.json({ error: 'Failed to fetch property', message: String(error) }, 500);
  }
});

// Stats
app.get('/api/stats', async (c) => {
  try {
    const stats = await getStats(c.env.MAL_DB);
    return c.json(stats);
  } catch {
    return c.json({ totalProperties: 0, bysite: [], byPrefecture: [], recentJobs: [] });
  }
});

// Health check
app.get('/api/health', (c) => c.json({
  status: 'ok',
  version: c.env.APP_VERSION ?? '5.0.0',
  timestamp: new Date().toISOString(),
}));

// Search suggestions
app.get('/api/suggest', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q) return c.json({ suggestions: [] });
  try {
    const rows = await c.env.MAL_DB
      .prepare('SELECT DISTINCT city FROM properties WHERE city LIKE ? LIMIT 10')
      .bind(`%${q}%`)
      .all<{ city: string }>();
    return c.json({ suggestions: rows.results?.map(r => r.city) ?? [] });
  } catch {
    return c.json({ suggestions: [] });
  }
});

// =====================
// Frontend
// =====================
app.get('*', (c) => {
  const html = getHTML();
  return c.html(html);
});

function getHTML(): string {
  const prefectureOptions = Object.entries(PREFECTURES)
    .map(([code, name]) => `<option value="${code}">${name}</option>`)
    .join('\n');

  const siteCheckboxes = Object.entries(SITES)
    .map(([id, site]) => `
          <label class="site-filter flex items-center gap-2 px-3 py-1.5 rounded-full border cursor-pointer transition-all"
            style="border-color: var(--border); background: var(--bg)"
            data-site="${id}" data-color="${site.color}">
            <input type="checkbox" value="${id}" class="site-cb" checked style="accent-color: ${site.color}">
            <span>${site.logo} ${site.name}</span>
          </label>`)
    .join('\n');

  const siteCardsInitial = Object.entries(SITES)
    .map(([, site]) => `
          <div class="card px-4 py-3 flex items-center gap-2 text-sm">
            <span class="text-xl">${site.logo}</span>
            <span style="color: ${site.color}; font-weight: 600">${site.name}</span>
          </div>`)
    .join('\n');

  const skeletonCards = Array(6).fill(0).map(() => `
        <div class="card p-4">
          <div class="skeleton h-48 mb-3"></div>
          <div class="skeleton h-4 mb-2"></div>
          <div class="skeleton h-4 w-2/3 mb-2"></div>
          <div class="skeleton h-6 w-1/3"></div>
        </div>`).join('\n');

  const sitesDataJson = JSON.stringify(
    Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, { logo: v.logo, name: v.name, color: v.color }]))
  );

  const prefecturesDataJson = JSON.stringify(PREFECTURES);

  return `<!DOCTYPE html>
<html lang="ja" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🌎 MAL検索システム - My Agent Locator v5.0</title>
  <meta name="description" content="47都道府県・7サイト横断 不動産情報統合検索システム">
  <meta name="theme-color" content="#0ea5e9">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌎</text></svg>">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --primary: #0ea5e9;
      --primary-dark: #0284c7;
      --bg: #f0f9ff;
      --card-bg: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
    }
    [data-theme="dark"] {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #334155;
    }
    * { transition: background-color 0.2s, border-color 0.2s, color 0.2s; }
    body { background: var(--bg); color: var(--text); font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; }
    .site-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; }
    .skeleton { background: linear-gradient(90deg, var(--border) 25%, var(--bg) 50%, var(--border) 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 8px; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 1rem; backdrop-filter: blur(4px); }
    .modal-content { background: var(--card-bg); border-radius: 16px; max-width: 900px; width: 100%; max-height: 90vh; overflow-y: auto; }
    .property-card { transition: transform 0.2s, box-shadow 0.2s; }
    .property-card:hover { transform: translateY(-3px); box-shadow: 0 12px 40px rgba(0,0,0,0.15); }
    .tab-active { border-bottom: 2px solid var(--primary); color: var(--primary); }
    .fade-in { animation: fadeIn 0.3s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .gradient-text { background: linear-gradient(135deg, var(--primary) 0%, #7c3aed 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .search-btn-gradient { background: linear-gradient(135deg, #0ea5e9 0%, #7c3aed 100%); }
    .header-blur { background: rgba(240, 249, 255, 0.85); }
    [data-theme="dark"] .header-blur { background: rgba(15, 23, 42, 0.85); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    input, select { outline: none; }
    input:focus, select:focus { box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.3); }
    .price-tag { font-size: 1.25rem; font-weight: 900; }
    .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    @media (max-width: 640px) {
      .modal-content { border-radius: 12px 12px 0 0; align-self: flex-end; max-height: 85vh; }
      .modal-overlay { align-items: flex-end; }
    }
  </style>
</head>
<body class="min-h-screen">

<!-- Header -->
<header class="sticky top-0 z-50 backdrop-blur-xl border-b header-blur" style="border-color: var(--border)">
  <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="text-2xl">🌎</span>
      <div>
        <h1 class="text-xl font-bold gradient-text">MAL検索システム</h1>
        <p class="text-xs" style="color: var(--text-muted)">My Agent Locator v5.0 | 47都道府県・7サイト横断</p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <div id="statsBar" class="hidden md:flex items-center gap-4 text-sm" style="color: var(--text-muted)">
        <span id="totalCount">読込中...</span>
      </div>
      <button onclick="toggleTheme()" class="p-2 rounded-lg border" style="background: var(--bg); border-color: var(--border)" title="テーマ切替">
        <i class="fas fa-moon" id="themeIcon"></i>
      </button>
      <button onclick="showStatsModal()" class="px-3 py-1.5 rounded-lg text-sm font-medium text-white search-btn-gradient">
        <i class="fas fa-chart-bar mr-1"></i>統計
      </button>
    </div>
  </div>
</header>

<!-- Main -->
<main class="max-w-7xl mx-auto px-4 py-6">

  <!-- Search Panel -->
  <div class="card p-6 mb-6 shadow-sm">

    <!-- Row 1: Query + Prefecture + Type -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      <div class="lg:col-span-2">
        <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">フリーワード検索</label>
        <div class="relative">
          <input type="text" id="searchQuery" placeholder="物件名・住所・駅名で検索..."
            class="w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)"
            onkeydown="if(event.key==='Enter') doSearch()">
          <i class="fas fa-search absolute left-3 top-3 text-sm" style="color: var(--text-muted)"></i>
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">都道府県</label>
        <select id="prefecture" class="w-full py-2.5 px-3 rounded-lg border text-sm"
          style="background: var(--bg); border-color: var(--border); color: var(--text)">
          <option value="">全国</option>
          ${prefectureOptions}
        </select>
      </div>

      <div>
        <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">物件種別</label>
        <select id="propertyType" class="w-full py-2.5 px-3 rounded-lg border text-sm"
          style="background: var(--bg); border-color: var(--border); color: var(--text)">
          <option value="">すべて</option>
          <option value="mansion">マンション</option>
          <option value="kodate">一戸建て</option>
          <option value="tochi">土地</option>
          <option value="chintai_mansion">賃貸マンション</option>
          <option value="chintai_ikkodate">賃貸一戸建て</option>
          <option value="jimusho">事務所・店舗</option>
        </select>
      </div>
    </div>

    <!-- Row 2: Price + Area + Rooms/Station -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
      <div>
        <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">
          価格: <span id="priceLabel" class="font-normal">指定なし</span>
        </label>
        <div class="flex items-center gap-2">
          <input type="number" id="priceMin" placeholder="下限(万円)" min="0"
            class="w-full py-2 px-3 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)"
            oninput="updatePriceLabel()">
          <span class="text-xs whitespace-nowrap" style="color: var(--text-muted)">〜</span>
          <input type="number" id="priceMax" placeholder="上限(万円)" min="0"
            class="w-full py-2 px-3 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)"
            oninput="updatePriceLabel()">
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">
          面積: <span id="areaLabel" class="font-normal">指定なし</span>
        </label>
        <div class="flex items-center gap-2">
          <input type="number" id="areaMin" placeholder="下限(m²)" min="0"
            class="w-full py-2 px-3 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)"
            oninput="updateAreaLabel()">
          <span class="text-xs whitespace-nowrap" style="color: var(--text-muted)">〜</span>
          <input type="number" id="areaMax" placeholder="上限(m²)" min="0"
            class="w-full py-2 px-3 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)"
            oninput="updateAreaLabel()">
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div>
          <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">間取り</label>
          <select id="rooms" class="w-full py-2 px-2 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)">
            <option value="">すべて</option>
            <option value="1R">1R</option>
            <option value="1K">1K</option>
            <option value="1DK">1DK</option>
            <option value="1LDK">1LDK</option>
            <option value="2K">2K</option>
            <option value="2DK">2DK</option>
            <option value="2LDK">2LDK</option>
            <option value="3LDK">3LDK</option>
            <option value="4LDK">4LDK</option>
            <option value="5LDK以上">5LDK+</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold mb-1" style="color: var(--text-muted)">駅徒歩(分以内)</label>
          <select id="stationMin" class="w-full py-2 px-2 rounded-lg border text-sm"
            style="background: var(--bg); border-color: var(--border); color: var(--text)">
            <option value="">制限なし</option>
            <option value="3">3分</option>
            <option value="5">5分</option>
            <option value="10">10分</option>
            <option value="15">15分</option>
            <option value="20">20分</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Sites -->
    <div class="mb-4">
      <label class="block text-xs font-semibold mb-2" style="color: var(--text-muted)">
        対象サイト
        <button onclick="toggleAllSites(true)" class="ml-3 text-xs font-normal underline" style="color: var(--primary)">全選択</button>
        <button onclick="toggleAllSites(false)" class="ml-2 text-xs font-normal underline" style="color: var(--text-muted)">全解除</button>
      </label>
      <div class="flex flex-wrap gap-2" id="siteCheckboxes">
        ${siteCheckboxes}
      </div>
    </div>

    <!-- Sort & Actions -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2">
        <label class="text-xs font-semibold whitespace-nowrap" style="color: var(--text-muted)">並び順:</label>
        <select id="sortBy" class="py-2 px-3 rounded-lg border text-sm"
          style="background: var(--bg); border-color: var(--border); color: var(--text)">
          <option value="newest">新着順</option>
          <option value="price_asc">価格安い順</option>
          <option value="price_desc">価格高い順</option>
          <option value="area_desc">面積広い順</option>
          <option value="area_asc">面積狭い順</option>
          <option value="relevance">関連度順</option>
        </select>
      </div>
      <div class="ml-auto flex gap-2">
        <button onclick="clearSearch()" class="px-4 py-2.5 rounded-xl border text-sm"
          style="border-color: var(--border); color: var(--text-muted); background: var(--bg)">
          <i class="fas fa-times mr-1"></i>クリア
        </button>
        <button onclick="doSearch()" id="searchBtn"
          class="px-8 py-2.5 rounded-xl font-bold text-white flex items-center gap-2 search-btn-gradient">
          <i class="fas fa-search"></i>
          <span>検索する</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Results Header -->
  <div class="flex items-center justify-between mb-4" id="resultsHeader" style="display:none!important">
    <div>
      <span id="resultCount" class="font-bold text-lg"></span>
      <span class="text-sm ml-2" id="executionTime" style="color: var(--text-muted)"></span>
    </div>
    <div class="flex gap-1">
      <button onclick="setView('grid')" id="gridBtn" class="p-2 rounded-lg border tab-active" style="border-color: var(--border)" title="グリッド表示">
        <i class="fas fa-th-large"></i>
      </button>
      <button onclick="setView('list')" id="listBtn" class="p-2 rounded-lg border" style="border-color: var(--border)" title="リスト表示">
        <i class="fas fa-list"></i>
      </button>
    </div>
  </div>

  <!-- Site Summary -->
  <div id="siteSummary" class="flex flex-wrap gap-2 mb-4"></div>

  <!-- Loading Skeleton -->
  <div id="loadingState" class="hidden">
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      ${skeletonCards}
    </div>
  </div>

  <!-- Results Grid -->
  <div id="resultsContainer" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div>

  <!-- Pagination -->
  <div id="pagination" class="flex justify-center flex-wrap gap-2 mt-8"></div>

  <!-- Empty State -->
  <div id="emptyState" class="hidden text-center py-20">
    <div class="text-6xl mb-4">🔍</div>
    <h3 class="text-xl font-bold mb-2">物件が見つかりませんでした</h3>
    <p style="color: var(--text-muted)" class="mb-4">検索条件を変更してお試しください</p>
    <button onclick="clearSearch()" class="px-6 py-2.5 rounded-xl text-white search-btn-gradient">
      <i class="fas fa-redo mr-2"></i>条件をリセット
    </button>
  </div>

  <!-- Initial State -->
  <div id="initialState" class="text-center py-16">
    <div class="text-8xl mb-6">🌎</div>
    <h2 class="text-3xl font-bold mb-4 gradient-text">MAL検索システム</h2>
    <p class="text-lg mb-2" style="color: var(--text-muted)">47都道府県・7サイト横断 不動産情報統合検索</p>
    <p class="text-sm mb-8" style="color: var(--text-muted)">SUUMO / HOME'S / AtHome / 不動産Japan / CHINTAI / Smaity / REINS</p>
    <div class="flex justify-center gap-3 flex-wrap max-w-2xl mx-auto">
      ${siteCardsInitial}
    </div>
    <div class="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto text-sm">
      <div class="card p-4 text-center">
        <div class="text-2xl mb-2">🔍</div>
        <p class="font-semibold mb-1">7サイト一括検索</p>
        <p style="color: var(--text-muted)">主要不動産サイトを横断検索</p>
      </div>
      <div class="card p-4 text-center">
        <div class="text-2xl mb-2">🗾</div>
        <p class="font-semibold mb-1">47都道府県対応</p>
        <p style="color: var(--text-muted)">全国の物件情報を網羅</p>
      </div>
      <div class="card p-4 text-center">
        <div class="text-2xl mb-2">⚡</div>
        <p class="font-semibold mb-1">リアルタイム取得</p>
        <p style="color: var(--text-muted)">最新の物件情報をお届け</p>
      </div>
    </div>
  </div>

</main>

<!-- Property Detail Modal -->
<div id="propertyModal" class="modal-overlay hidden" onclick="if(event.target===this) closeModal()">
  <div class="modal-content fade-in">
    <div class="p-6" id="modalContent">
      <div class="flex justify-center py-10">
        <i class="fas fa-spinner fa-spin text-4xl" style="color: var(--primary)"></i>
      </div>
    </div>
  </div>
</div>

<!-- Stats Modal -->
<div id="statsModal" class="modal-overlay hidden" onclick="if(event.target===this) closeStatsModal()">
  <div class="modal-content fade-in" style="max-width: 640px">
    <div class="p-6">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold">📊 システム統計</h2>
        <button onclick="closeStatsModal()" class="w-8 h-8 flex items-center justify-center rounded-full text-xl font-bold"
          style="color: var(--text-muted); background: var(--bg)">&times;</button>
      </div>
      <div id="statsContent">
        <div class="flex justify-center py-10">
          <i class="fas fa-spinner fa-spin text-4xl" style="color: var(--primary)"></i>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
// =====================
// Constants
// =====================
const SITES_DATA = ${sitesDataJson};
const PREFECTURES_DATA = ${prefecturesDataJson};

// =====================
// State
// =====================
let currentPage = 1;
let currentResults = null;
let viewMode = 'grid';

// =====================
// Theme
// =====================
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', newTheme);
  document.getElementById('themeIcon').className = newTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  localStorage.setItem('mal_theme', newTheme);
}

(function initTheme() {
  const saved = localStorage.getItem('mal_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeIcon').className = saved === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
})();

// =====================
// Search
// =====================
async function doSearch(page) {
  page = page || 1;
  currentPage = page;

  const params = new URLSearchParams();
  const q = document.getElementById('searchQuery').value.trim();
  const prefecture = document.getElementById('prefecture').value;
  const type = document.getElementById('propertyType').value;
  const priceMin = document.getElementById('priceMin').value;
  const priceMax = document.getElementById('priceMax').value;
  const areaMin = document.getElementById('areaMin').value;
  const areaMax = document.getElementById('areaMax').value;
  const rooms = document.getElementById('rooms').value;
  const stationMin = document.getElementById('stationMin').value;
  const sortBy = document.getElementById('sortBy').value;
  const checkedSites = [...document.querySelectorAll('.site-cb:checked')].map(cb => cb.value);

  if (q) params.set('q', q);
  if (prefecture) params.set('prefecture', prefecture);
  if (type) params.set('type', type);
  if (priceMin) params.set('price_min', priceMin);
  if (priceMax) params.set('price_max', priceMax);
  if (areaMin) params.set('area_min', areaMin);
  if (areaMax) params.set('area_max', areaMax);
  if (rooms) params.set('rooms', rooms);
  if (stationMin) params.set('station_min', stationMin);
  if (checkedSites.length > 0 && checkedSites.length < 7) params.set('sites', checkedSites.join(','));
  params.set('sort', sortBy);
  params.set('page', String(page));
  params.set('limit', '18');

  setLoading(true);

  try {
    const response = await fetch('/api/search?' + params.toString());
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    currentResults = data;
    renderResults(data);
  } catch (error) {
    showError(error.message || '検索に失敗しました');
  } finally {
    setLoading(false);
  }
}

function setLoading(loading) {
  document.getElementById('loadingState').classList.toggle('hidden', !loading);
  document.getElementById('resultsContainer').classList.toggle('hidden', loading);
  if (loading) {
    document.getElementById('initialState').classList.add('hidden');
    document.getElementById('emptyState').classList.add('hidden');
  }
  const btn = document.getElementById('searchBtn');
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<i class="fas fa-spinner fa-spin"></i><span>検索中...</span>'
    : '<i class="fas fa-search"></i><span>検索する</span>';
}

function renderResults(data) {
  const header = document.getElementById('resultsHeader');
  header.style.display = 'flex';

  document.getElementById('resultCount').textContent = (data.total || 0).toLocaleString() + '件の物件';
  const cacheInfo = data.cacheHit ? ' (キャッシュ)' : '';
  document.getElementById('executionTime').textContent = '(' + (data.executionTimeMs || 0) + 'ms' + cacheInfo + ')';

  // Site badges
  const siteSummary = document.getElementById('siteSummary');
  siteSummary.innerHTML = (data.sites || []).map(function(s) {
    const site = SITES_DATA[s.siteId] || {};
    const color = site.color || '#64748b';
    const errIcon = s.status === 'error' ? ' <i class="fas fa-exclamation-circle" style="color:#ef4444"></i>' : '';
    return '<span class="site-badge" style="background:' + color + '20; color:' + color + '; border:1px solid ' + color + '40">'
      + (site.logo || '') + ' ' + (site.name || s.siteId) + ': ' + s.count + '件' + errIcon
      + '</span>';
  }).join('');

  const container = document.getElementById('resultsContainer');
  container.className = viewMode === 'grid'
    ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
    : 'flex flex-col gap-3';

  if (!data.properties || data.properties.length === 0) {
    document.getElementById('emptyState').classList.remove('hidden');
    container.innerHTML = '';
    renderPagination(data);
    return;
  }

  document.getElementById('emptyState').classList.add('hidden');
  container.innerHTML = data.properties.map(renderPropertyCard).join('');
  renderPagination(data);
}

function renderPropertyCard(p) {
  const site = SITES_DATA[p.siteId] || {};
  const color = site.color || '#64748b';
  const priceStr = p.price ? p.price.toLocaleString() + '万円' : (p.priceText || '価格要相談');
  const areaStr = p.area ? p.area + 'm\u00B2' : '-';
  const prefName = PREFECTURES_DATA[p.prefecture] || '';

  const imgHtml = p.thumbnailUrl
    ? '<img src="' + escAttr(p.thumbnailUrl) + '" alt="' + escHtml(p.title) + '" class="w-full h-full object-cover" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=\\'w-full h-full flex items-center justify-center text-5xl\\'>&#x1F3E0;</div>\'">'
    : '<div class="w-full h-full flex items-center justify-center text-5xl">' + (site.logo || '🏠') + '</div>';

  const stationHtml = p.station
    ? '<span class="ml-2"><i class="fas fa-train mr-1"></i>' + escHtml(p.station) + (p.stationMinutes ? ' 徒歩' + p.stationMinutes + '分' : '') + '</span>'
    : '';

  const typeLabel = formatPropertyType(p.propertyType);

  return '<div class="card property-card cursor-pointer overflow-hidden" onclick="showPropertyDetail(\'' + p.id + '\')">'
    + '<div class="relative overflow-hidden" style="height: 192px; background: var(--bg)">'
    + imgHtml
    + '<span class="absolute top-2 left-2 site-badge text-white" style="background:' + color + '">' + (site.logo || '') + ' ' + (site.name || p.siteId) + '</span>'
    + (typeLabel ? '<span class="absolute top-2 right-2 site-badge" style="background:rgba(0,0,0,0.65); color:white">' + typeLabel + '</span>' : '')
    + '</div>'
    + '<div class="p-4">'
    + '<h3 class="font-bold text-sm mb-1 line-clamp-2">' + escHtml(p.title) + '</h3>'
    + '<p class="text-xs mb-2" style="color:var(--text-muted)">'
    + '<i class="fas fa-map-marker-alt mr-1"></i>' + escHtml(prefName) + ' ' + escHtml(p.city || '')
    + stationHtml
    + '</p>'
    + '<div class="flex items-end justify-between">'
    + '<div>'
    + '<p class="price-tag" style="color:' + color + '">' + escHtml(priceStr) + '</p>'
    + '<p class="text-xs mt-0.5" style="color:var(--text-muted)">'
    + (p.rooms ? escHtml(p.rooms) + ' ' : '')
    + escHtml(areaStr)
    + (p.age !== null && p.age !== undefined ? ' 築' + p.age + '年' : '')
    + '</p>'
    + '</div>'
    + '<a href="' + escAttr(p.detailUrl) + '" target="_blank" rel="noopener noreferrer" '
    + 'onclick="event.stopPropagation()" '
    + 'class="text-xs px-2 py-1 rounded-lg font-medium" style="background:' + color + '20; color:' + color + '">'
    + '詳細 <i class="fas fa-external-link-alt"></i>'
    + '</a>'
    + '</div>'
    + '</div>'
    + '</div>';
}

function formatPropertyType(type) {
  const map = {
    mansion: 'マンション', kodate: '一戸建', tochi: '土地',
    chintai_mansion: '賃貸', chintai_ikkodate: '賃貸一戸建', jimusho: '事務所', other: 'その他'
  };
  return map[type] || type || '';
}

function renderPagination(data) {
  const container = document.getElementById('pagination');
  if (!data.totalPages || data.totalPages <= 1) { container.innerHTML = ''; return; }

  const current = data.page;
  const total = data.totalPages;
  const pages = [];
  for (let i = Math.max(1, current - 2); i <= Math.min(total, current + 2); i++) pages.push(i);

  let html = '';
  if (current > 1) html += '<button onclick="doSearch(' + (current - 1) + ')" class="px-4 py-2 rounded-lg border text-sm" style="border-color:var(--border); background:var(--card-bg)"><i class="fas fa-chevron-left"></i></button>';
  pages.forEach(function(p) {
    const active = p === current;
    html += '<button onclick="doSearch(' + p + ')" class="px-4 py-2 rounded-lg border text-sm font-medium" style="'
      + (active ? 'background:var(--primary); border-color:var(--primary); color:white'
                : 'border-color:var(--border); background:var(--card-bg); color:var(--text)')
      + '">' + p + '</button>';
  });
  if (current < total) html += '<button onclick="doSearch(' + (current + 1) + ')" class="px-4 py-2 rounded-lg border text-sm" style="border-color:var(--border); background:var(--card-bg)"><i class="fas fa-chevron-right"></i></button>';

  container.innerHTML = html;
}

// =====================
// Property Modal
// =====================
async function showPropertyDetail(id) {
  document.getElementById('propertyModal').classList.remove('hidden');
  document.getElementById('modalContent').innerHTML =
    '<div class="flex justify-center py-10"><i class="fas fa-spinner fa-spin text-4xl" style="color:var(--primary)"></i></div>';

  let property = null;

  try {
    const response = await fetch('/api/properties/' + encodeURIComponent(id));
    if (response.ok) property = await response.json();
  } catch {}

  if (!property && currentResults) {
    property = (currentResults.properties || []).find(function(p) { return p.id === id; });
  }

  if (property) {
    renderPropertyModal(property);
  } else {
    document.getElementById('modalContent').innerHTML =
      '<div class="p-6 text-center"><p class="text-lg">物件情報の取得に失敗しました</p>' +
      '<button onclick="closeModal()" class="mt-4 px-6 py-2 rounded-lg text-white search-btn-gradient">閉じる</button></div>';
  }
}

function renderPropertyModal(p) {
  const site = SITES_DATA[p.siteId] || {};
  const color = site.color || '#64748b';
  const priceStr = p.price ? p.price.toLocaleString() + '万円' : (p.priceText || '価格要相談');
  const prefName = PREFECTURES_DATA[p.prefecture] || '';

  let imgHtml = '';
  if (p.images && p.images.length > 0) {
    imgHtml = '<div class="grid grid-cols-3 gap-2 mb-4">'
      + p.images.slice(0, 3).map(function(img) {
          return '<img src="' + escAttr(img) + '" alt="物件画像" class="w-full h-32 object-cover rounded-lg" loading="lazy" onerror="this.style.display=\'none\'">';
        }).join('')
      + '</div>';
  }

  let featuresHtml = '';
  if (p.features && p.features.length > 0) {
    featuresHtml = '<div class="mb-4">'
      + '<p class="text-xs font-semibold mb-2" style="color:var(--text-muted)">設備・特徴</p>'
      + '<div class="flex flex-wrap gap-1">'
      + p.features.map(function(f) {
          return '<span class="px-2 py-0.5 rounded-full text-xs border" style="background:var(--bg); border-color:var(--border)">' + escHtml(f) + '</span>';
        }).join('')
      + '</div></div>';
  }

  let descHtml = '';
  if (p.description) {
    descHtml = '<div class="mb-4">'
      + '<p class="text-xs font-semibold mb-1" style="color:var(--text-muted)">物件説明</p>'
      + '<p class="text-sm" style="color:var(--text-muted)">' + escHtml(p.description) + '</p>'
      + '</div>';
  }

  const detailGrid = [
    { label: '所在地', value: escHtml(prefName + ' ' + (p.city || '')), sub: p.address ? escHtml(p.address) : null },
    { label: 'アクセス', value: p.station ? escHtml(p.station) : '情報なし', sub: p.stationMinutes ? '徒歩' + p.stationMinutes + '分' : null },
    p.area ? { label: '面積', value: p.area + 'm\u00B2', sub: p.buildingArea && p.buildingArea !== p.area ? '建物: ' + p.buildingArea + 'm\u00B2' : null } : null,
    { label: '物件詳細', value: p.rooms || '-', sub: (p.age !== null && p.age !== undefined ? '築' + p.age + '年' : '') + (p.floor ? ' ' + p.floor + '階/' + (p.totalFloors || '?') + '階建' : '') || null },
  ].filter(Boolean);

  const detailGridHtml = '<div class="grid grid-cols-2 gap-3 mb-4">'
    + detailGrid.map(function(d) {
        return '<div class="card p-3">'
          + '<p class="text-xs mb-1" style="color:var(--text-muted)">' + d.label + '</p>'
          + '<p class="font-semibold text-sm">' + d.value + '</p>'
          + (d.sub ? '<p class="text-xs mt-0.5" style="color:var(--text-muted)">' + d.sub + '</p>' : '')
          + '</div>';
      }).join('')
    + '</div>';

  document.getElementById('modalContent').innerHTML =
    '<div class="flex items-center justify-between mb-4">'
    + '<span class="site-badge text-white" style="background:' + color + '">' + (site.logo || '') + ' ' + (site.name || p.siteId) + '</span>'
    + '<button onclick="closeModal()" class="w-8 h-8 flex items-center justify-center rounded-full text-xl font-bold" style="color:var(--text-muted); background:var(--bg)">&times;</button>'
    + '</div>'
    + imgHtml
    + '<h2 class="text-xl font-bold mb-2">' + escHtml(p.title) + '</h2>'
    + '<p class="text-3xl font-black mb-4" style="color:' + color + '">' + escHtml(priceStr) + '</p>'
    + detailGridHtml
    + featuresHtml
    + descHtml
    + '<a href="' + escAttr(p.detailUrl) + '" target="_blank" rel="noopener noreferrer" '
    + 'class="block w-full text-center py-3 rounded-xl font-bold text-white mt-2 search-btn-gradient">'
    + '<i class="fas fa-external-link-alt mr-2"></i>' + (site.name || 'サイト') + 'で詳細を見る'
    + '</a>';
}

function closeModal() {
  document.getElementById('propertyModal').classList.add('hidden');
}

// =====================
// Stats Modal
// =====================
async function showStatsModal() {
  document.getElementById('statsModal').classList.remove('hidden');
  document.getElementById('statsContent').innerHTML =
    '<div class="flex justify-center py-10"><i class="fas fa-spinner fa-spin text-4xl" style="color:var(--primary)"></i></div>';

  try {
    const resp = await fetch('/api/stats');
    if (!resp.ok) throw new Error('Failed');
    const stats = await resp.json();
    renderStats(stats);
  } catch {
    document.getElementById('statsContent').innerHTML =
      '<p class="text-center py-4" style="color:var(--text-muted)">統計情報の取得に失敗しました</p>';
  }
}

function renderStats(stats) {
  const total = stats.totalProperties || 0;

  const bySiteHtml = (stats.bysite || []).map(function(s) {
    const site = SITES_DATA[s.site_id] || {};
    const color = site.color || '#64748b';
    return '<div class="card p-3 flex items-center justify-between">'
      + '<span style="color:' + color + '">' + (site.logo || '') + ' ' + (site.name || s.site_id) + '</span>'
      + '<span class="font-bold">' + (s.cnt || 0).toLocaleString() + '件</span>'
      + '</div>';
  }).join('');

  let prefHtml = '';
  if (stats.byPrefecture && stats.byPrefecture.length > 0) {
    prefHtml = '<div class="mt-4">'
      + '<p class="text-xs font-semibold mb-2" style="color:var(--text-muted)">都道府県別 TOP10</p>'
      + stats.byPrefecture.map(function(p) {
          return '<div class="flex justify-between text-sm py-1.5 border-b" style="border-color:var(--border)">'
            + '<span>' + (PREFECTURES_DATA[p.prefecture] || p.prefecture) + '</span>'
            + '<span class="font-bold">' + (p.cnt || 0).toLocaleString() + '件</span>'
            + '</div>';
        }).join('')
      + '</div>';
  }

  document.getElementById('statsContent').innerHTML =
    '<div class="text-center mb-6">'
    + '<p class="text-5xl font-black" style="color:var(--primary)">' + total.toLocaleString() + '</p>'
    + '<p style="color:var(--text-muted)">登録物件数</p>'
    + '</div>'
    + '<div class="grid grid-cols-2 gap-3 mb-2">' + bySiteHtml + '</div>'
    + prefHtml;
}

function closeStatsModal() {
  document.getElementById('statsModal').classList.add('hidden');
}

// =====================
// View & Filters
// =====================
function setView(mode) {
  viewMode = mode;
  document.getElementById('gridBtn').classList.toggle('tab-active', mode === 'grid');
  document.getElementById('listBtn').classList.toggle('tab-active', mode === 'list');
  if (currentResults) renderResults(currentResults);
}

function toggleAllSites(checked) {
  document.querySelectorAll('.site-cb').forEach(function(cb) { cb.checked = checked; });
  updateSiteStyles();
}

function updateSiteStyles() {
  document.querySelectorAll('.site-filter').forEach(function(label) {
    const cb = label.querySelector('input');
    const color = label.dataset.color;
    if (cb.checked) {
      label.style.borderColor = color;
      label.style.background = color + '20';
    } else {
      label.style.borderColor = 'var(--border)';
      label.style.background = 'var(--bg)';
    }
  });
}

function updatePriceLabel() {
  const min = document.getElementById('priceMin').value;
  const max = document.getElementById('priceMax').value;
  document.getElementById('priceLabel').textContent =
    (min || max) ? (min || '-') + '\u301C' + (max || '-') + '\u4E07\u5186' : '\u6307\u5B9A\u306A\u3057';
}

function updateAreaLabel() {
  const min = document.getElementById('areaMin').value;
  const max = document.getElementById('areaMax').value;
  document.getElementById('areaLabel').textContent =
    (min || max) ? (min || '-') + '\u301C' + (max || '-') + 'm\u00B2' : '\u6307\u5B9A\u306A\u3057';
}

function clearSearch() {
  document.getElementById('searchQuery').value = '';
  document.getElementById('priceMin').value = '';
  document.getElementById('priceMax').value = '';
  document.getElementById('areaMin').value = '';
  document.getElementById('areaMax').value = '';
  document.querySelectorAll('select').forEach(function(el) { el.selectedIndex = 0; });
  toggleAllSites(true);
  updatePriceLabel();
  updateAreaLabel();
  document.getElementById('resultsContainer').innerHTML = '';
  document.getElementById('pagination').innerHTML = '';
  document.getElementById('siteSummary').innerHTML = '';
  document.getElementById('resultsHeader').style.display = 'none';
  document.getElementById('initialState').classList.remove('hidden');
  document.getElementById('emptyState').classList.add('hidden');
  currentResults = null;
}

function showError(msg) {
  const container = document.getElementById('resultsContainer');
  container.classList.remove('hidden');
  container.innerHTML =
    '<div class="col-span-3 text-center py-12">'
    + '<i class="fas fa-exclamation-triangle text-4xl mb-4" style="color:#ef4444"></i>'
    + '<p class="font-bold text-lg mb-2">エラーが発生しました</p>'
    + '<p class="text-sm mb-4" style="color:var(--text-muted)">' + escHtml(msg) + '</p>'
    + '<button onclick="doSearch()" class="px-6 py-2.5 rounded-xl text-white search-btn-gradient">'
    + '<i class="fas fa-redo mr-2"></i>再試行</button>'
    + '</div>';
  document.getElementById('resultsHeader').style.display = 'flex';
  document.getElementById('resultCount').textContent = 'エラー';
  document.getElementById('executionTime').textContent = '';
}

// =====================
// Security helpers
// =====================
function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  if (!str) return '#';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =====================
// Init
// =====================
(function init() {
  // Initialize site filter styles
  document.querySelectorAll('.site-filter').forEach(function(label) {
    const cb = label.querySelector('input');
    const color = label.dataset.color;
    if (color) {
      label.style.borderColor = color;
      label.style.background = color + '20';
    }
    cb.addEventListener('change', updateSiteStyles);
  });

  // Load stats for header
  fetch('/api/stats').then(function(r) { return r.json(); }).then(function(stats) {
    const total = stats.totalProperties || 0;
    document.getElementById('totalCount').textContent = '📊 ' + total.toLocaleString() + '件登録済';
    document.getElementById('statsBar').classList.remove('hidden');
  }).catch(function() {});
})();
</script>
</body>
</html>`;
}

export default app;
