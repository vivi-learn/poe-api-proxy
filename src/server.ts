import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 설정
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));

app.options('*', cors());
app.use(express.json());

// ============================================
// Rate Limiting
// ============================================
let lastPoe1StatsRequest = 0;
let lastPoe2StatsRequest = 0;
let lastSearchRequest = 0;
let lastFetchRequest = 0;
const MIN_DELAY = 5000; // 5초

// 요청 카운터
let poe1StatsRequestCount = 0;
let poe2StatsRequestCount = 0;
let searchRequestCount = 0;

// ============================================
// 캐시
// ============================================
interface CacheEntry {
  data: any;
  timestamp: number;
}

let poe1StatsCache: CacheEntry | null = null;
let poe2StatsCache: CacheEntry | null = null;
const STATS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7일

// ============================================
// Rate Limited Fetch
// ============================================
async function rateLimitedFetch(
  url: string,
  options: RequestInit,
  lastRequestRef: { value: number },
  minDelay: number = MIN_DELAY
): Promise<Response> {
  const now = Date.now();
  const timeSince = now - lastRequestRef.value;
  
  if (timeSince < minDelay) {
    const waitTime = minDelay - timeSince;
    console.log(`⏱️  Waiting ${waitTime}ms...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestRef.value = Date.now();
  console.log(`🌐 Fetching: ${url}`);
  
  return fetch(url, options);
}

// ============================================
// Health Check
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PoE Trade API Proxy',
    timestamp: new Date().toISOString(),
    stats: {
      poe1StatsRequests: poe1StatsRequestCount,
      poe2StatsRequests: poe2StatsRequestCount,
      searchRequests: searchRequestCount,
      poe1CacheAge: poe1StatsCache ? Date.now() - poe1StatsCache.timestamp : null,
      poe2CacheAge: poe2StatsCache ? Date.now() - poe2StatsCache.timestamp : null,
    },
    endpoints: {
      poe1Stats: 'GET /api/poe/stats',
      poe2Stats: 'GET /api/poe2/stats',
      search: 'POST /api/poe/search (PoE1)',
      searchPoe2: 'POST /api/poe2/search',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
  });
});

// ============================================
// PoE1 Stats API
// ============================================
app.get('/api/poe/stats', async (req, res) => {
  try {
    poe1StatsRequestCount++;
    const now = Date.now();
    
    console.log(`📊 [PoE1 Stats #${poe1StatsRequestCount}] Request received`);
    
    // 캐시 확인
    if (poe1StatsCache && (now - poe1StatsCache.timestamp) < STATS_CACHE_TTL) {
      const cacheAge = Math.floor((now - poe1StatsCache.timestamp) / 1000 / 60);
      console.log(`📦 [PoE1 Stats] Returning cache (age: ${cacheAge} min)`);
      res.setHeader('X-Cache', 'HIT');
      return res.json(poe1StatsCache.data);
    }
    
    console.log('🔍 [PoE1 Stats] Fetching from API...');
    
    const response = await rateLimitedFetch(
      'https://www.pathofexile.com/api/trade/data/stats',
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      },
      { value: lastPoe1StatsRequest },
      MIN_DELAY
    );
    
    if (!response.ok) {
      console.error(`❌ [PoE1 Stats] Error: ${response.status}`);
      
      if (response.status === 403 && poe1StatsCache) {
        console.log('📦 [PoE1 Stats] Returning stale cache due to 403');
        res.setHeader('X-Cache', 'STALE');
        return res.json(poe1StatsCache.data);
      }
      
      return res.status(response.status).json({
        error: `PoE API returned ${response.status}`,
      });
    }
    
    const data = await response.json();
    poe1StatsCache = { data, timestamp: now };
    console.log('✅ [PoE1 Stats] Cached successfully');
    
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
    
  } catch (error: any) {
    console.error('💥 [PoE1 Stats] Exception:', error.message);
    
    if (poe1StatsCache) {
      res.setHeader('X-Cache', 'ERROR-STALE');
      return res.json(poe1StatsCache.data);
    }
    
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// PoE2 Stats API
// ============================================
app.get('/api/poe2/stats', async (req, res) => {
  try {
    poe2StatsRequestCount++;
    const now = Date.now();
    
    console.log(`📊 [PoE2 Stats #${poe2StatsRequestCount}] Request received`);
    
    // 캐시 확인
    if (poe2StatsCache && (now - poe2StatsCache.timestamp) < STATS_CACHE_TTL) {
      const cacheAge = Math.floor((now - poe2StatsCache.timestamp) / 1000 / 60);
      console.log(`📦 [PoE2 Stats] Returning cache (age: ${cacheAge} min)`);
      res.setHeader('X-Cache', 'HIT');
      return res.json(poe2StatsCache.data);
    }
    
    console.log('🔍 [PoE2 Stats] Fetching from API...');
    
    // PoE2는 다른 도메인 사용
    const response = await rateLimitedFetch(
      'https://www.pathofexile.com/api/trade2/data/stats',
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      },
      { value: lastPoe2StatsRequest },
      MIN_DELAY
    );
    
    if (!response.ok) {
      console.error(`❌ [PoE2 Stats] Error: ${response.status}`);
      
      if (response.status === 403 && poe2StatsCache) {
        console.log('📦 [PoE2 Stats] Returning stale cache due to 403');
        res.setHeader('X-Cache', 'STALE');
        return res.json(poe2StatsCache.data);
      }
      
      return res.status(response.status).json({
        error: `PoE2 API returned ${response.status}`,
      });
    }
    
    const data = await response.json();
    poe2StatsCache = { data, timestamp: now };
    console.log('✅ [PoE2 Stats] Cached successfully');
    
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
    
  } catch (error: any) {
    console.error('💥 [PoE2 Stats] Exception:', error.message);
    
    if (poe2StatsCache) {
      res.setHeader('X-Cache', 'ERROR-STALE');
      return res.json(poe2StatsCache.data);
    }
    
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// PoE1 Search API
// ============================================
app.post('/api/poe/search', async (req, res) => {
  try {
    searchRequestCount++;
    const { league, query, sort, limit } = req.body;
    
    console.log(`🔍 [PoE1 Search #${searchRequestCount}] ${league || 'Standard'}`);
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const encodedLeague = encodeURIComponent(league || 'Standard');
    const searchUrl = `https://www.pathofexile.com/api/trade/search/${encodedLeague}`;
    
    const searchResponse = await rateLimitedFetch(
      searchUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ query, sort }),
      },
      { value: lastSearchRequest },
      MIN_DELAY
    );
    
    if (!searchResponse.ok) {
      console.error(`❌ [PoE1 Search] Error: ${searchResponse.status}`);
      return res.status(searchResponse.status).json({
        error: `PoE API returned ${searchResponse.status}`,
      });
    }
    
    const searchData = await searchResponse.json();
    
    if (searchData.result && searchData.result.length > 0) {
      const actualLimit = Math.min(Math.max(1, limit || 10), 10);
      const resultIds = searchData.result.slice(0, actualLimit);
      const fetchUrl = `https://www.pathofexile.com/api/trade/fetch/${resultIds.join(',')}?query=${searchData.id}`;
      
      const fetchResponse = await rateLimitedFetch(
        fetchUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
        { value: lastFetchRequest },
        MIN_DELAY
      );
      
      if (fetchResponse.ok) {
        const itemsData = await fetchResponse.json();
        
        return res.json({
          searchId: searchData.id,
          league: league || 'Standard',
          total: searchData.total,
          items: itemsData.result.map((item: any, index: number) => ({
            name: item.item.name || item.item.typeLine,
            price: item.listing.price
              ? `${item.listing.price.amount} ${item.listing.price.currency}`
              : '가격 정보 없음',
            item: item.item,
            listing: item.listing,
            index,
          })),
        });
      }
    }
    
    return res.json({
      searchId: searchData.id,
      league: league || 'Standard',
      total: searchData.total,
      items: [],
    });
    
  } catch (error: any) {
    console.error('💥 [PoE1 Search] Exception:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// PoE2 Search API
// ============================================
app.post('/api/poe2/search', async (req, res) => {
  try {
    const { league, query, sort, limit } = req.body;
    
    console.log(`🔍 [PoE2 Search] ${league || 'Standard'}`);
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const encodedLeague = encodeURIComponent(league || 'Standard');
    const searchUrl = `https://www.pathofexile.com/api/trade2/search/${encodedLeague}`;
    
    const searchResponse = await rateLimitedFetch(
      searchUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ query, sort }),
      },
      { value: lastSearchRequest },
      MIN_DELAY
    );
    
    if (!searchResponse.ok) {
      console.error(`❌ [PoE2 Search] Error: ${searchResponse.status}`);
      return res.status(searchResponse.status).json({
        error: `PoE2 API returned ${searchResponse.status}`,
      });
    }
    
    const searchData = await searchResponse.json();
    
    if (searchData.result && searchData.result.length > 0) {
      const actualLimit = Math.min(Math.max(1, limit || 10), 10);
      const resultIds = searchData.result.slice(0, actualLimit);
      const fetchUrl = `https://www.pathofexile.com/api/trade2/fetch/${resultIds.join(',')}?query=${searchData.id}`;
      
      const fetchResponse = await rateLimitedFetch(
        fetchUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        },
        { value: lastFetchRequest },
        MIN_DELAY
      );
      
      if (fetchResponse.ok) {
        const itemsData = await fetchResponse.json();
        
        return res.json({
          searchId: searchData.id,
          league: league || 'Standard',
          total: searchData.total,
          items: itemsData.result.map((item: any, index: number) => ({
            name: item.item.name || item.item.typeLine,
            price: item.listing.price
              ? `${item.listing.price.amount} ${item.listing.price.currency}`
              : '가격 정보 없음',
            item: item.item,
            listing: item.listing,
            index,
          })),
        });
      }
    }
    
    return res.json({
      searchId: searchData.id,
      league: league || 'Standard',
      total: searchData.total,
      items: [],
    });
    
  } catch (error: any) {
    console.error('💥 [PoE2 Search] Exception:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// 404 Handler
// ============================================
app.use((req, res) => {
  console.log('404:', req.method, req.path);
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// ============================================
// Start Server
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 PoE API Proxy running on port ${PORT}`);
  console.log(`📡 PoE1 Stats: /api/poe/stats`);
  console.log(`📡 PoE2 Stats: /api/poe2/stats`);
  console.log(`🔍 PoE1 Search: POST /api/poe/search`);
  console.log(`🔍 PoE2 Search: POST /api/poe2/search`);
});