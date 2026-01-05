import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 설정 - 모든 출처 허용 (개발 중)
app.use(cors({
  origin: '*', // 일단 모든 출처 허용
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));

// Preflight 요청 처리
app.options('*', cors());

app.use(express.json());

// ============================================
// 강화된 Rate Limiting
// ============================================
let lastStatsRequest = 0;
let lastSearchRequest = 0;
let lastFetchRequest = 0;
const MIN_DELAY = 5000; // 5초로 증가 (더 안전하게)

// 요청 카운터 (디버깅용)
let statsRequestCount = 0;
let searchRequestCount = 0;

// ============================================
// Stats 캐시 (더 긴 TTL)
// ============================================
interface CacheEntry {
  data: any;
  timestamp: number;
}

let statsCache: CacheEntry | null = null;
const STATS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7일 (Stats는 거의 안 바뀜)

// ============================================
// Rate Limited Fetch (더 안전하게)
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
    console.log(`⏱️  Rate limiting: waiting ${waitTime}ms before ${url}`);
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
      statsRequests: statsRequestCount,
      searchRequests: searchRequestCount,
      cacheAge: statsCache ? Date.now() - statsCache.timestamp : null,
    },
    endpoints: {
      stats: 'GET /api/poe/stats',
      search: 'POST /api/poe/search',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// Stats API - GET /api/poe/stats
// ============================================
app.get('/api/poe/stats', async (req, res) => {
  try {
    statsRequestCount++;
    const now = Date.now();
    
    console.log(`📊 [Stats #${statsRequestCount}] Request received`);
    
    // 캐시 확인 (우선순위)
    if (statsCache && (now - statsCache.timestamp) < STATS_CACHE_TTL) {
      const cacheAge = Math.floor((now - statsCache.timestamp) / 1000 / 60);
      console.log(`📦 [Stats] Returning cached data (age: ${cacheAge} minutes)`);
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Age', cacheAge.toString());
      return res.json(statsCache.data);
    }
    
    console.log('🔍 [Stats] Cache miss, fetching from PoE API...');
    
    // PoE API 호출
    const response = await rateLimitedFetch(
      'https://www.pathofexile.com/api/trade/data/stats',
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.pathofexile.com/trade',
        },
      },
      { value: lastStatsRequest },
      MIN_DELAY
    );
    
    if (!response.ok) {
      console.error(`❌ [Stats] PoE API Error: ${response.status} ${response.statusText}`);
      
      // 403이고 캐시가 있으면 오래된 캐시라도 반환
      if (response.status === 403 && statsCache) {
        const cacheAge = Math.floor((now - statsCache.timestamp) / 1000 / 60 / 60);
        console.log(`📦 [Stats] Returning stale cache (age: ${cacheAge} hours) due to 403`);
        res.setHeader('X-Cache', 'STALE');
        res.setHeader('X-Cache-Age', cacheAge.toString());
        return res.json(statsCache.data);
      }
      
      return res.status(response.status).json({
        error: `PoE API returned ${response.status}`,
        message: response.statusText,
      });
    }
    
    const data = await response.json();
    
    // 캐시 저장
    statsCache = { data, timestamp: now };
    console.log('✅ [Stats] Successfully fetched and cached');
    
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
    
  } catch (error: any) {
    console.error('💥 [Stats] Exception:', error.message);
    
    // 예외 발생 시에도 캐시 반환
    if (statsCache) {
      const cacheAge = Math.floor((Date.now() - statsCache.timestamp) / 1000 / 60 / 60);
      console.log(`📦 [Stats] Returning stale cache (age: ${cacheAge} hours) after exception`);
      res.setHeader('X-Cache', 'ERROR-STALE');
      return res.json(statsCache.data);
    }
    
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// ============================================
// Search API - POST /api/poe/search
// ============================================
app.post('/api/poe/search', async (req, res) => {
  try {
    searchRequestCount++;
    const { league, query, sort, limit } = req.body;
    
    console.log(`🔍 [Search #${searchRequestCount}] Request received for ${league || 'Standard'}`);
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const encodedLeague = encodeURIComponent(league || 'Standard');
    const searchUrl = `https://www.pathofexile.com/api/trade/search/${encodedLeague}`;
    
    // 검색 요청
    const searchResponse = await rateLimitedFetch(
      searchUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query, sort }),
      },
      { value: lastSearchRequest },
      MIN_DELAY
    );
    
    if (!searchResponse.ok) {
      console.error(`❌ [Search] PoE API Error: ${searchResponse.status}`);
      
      // 429 (Too Many Requests) 처리
      if (searchResponse.status === 429) {
        console.log('⚠️ [Search] Rate limited by PoE API, will retry after longer delay');
        return res.status(429).json({
          error: 'Rate limited',
          message: 'Too many requests, please try again later',
          retryAfter: 60, // 60초 후 재시도
        });
      }
      
      return res.status(searchResponse.status).json({
        error: `PoE API returned ${searchResponse.status}`,
      });
    }
    
    const searchData = await searchResponse.json();
    
    // 아이템 상세 정보
    if (searchData.result && searchData.result.length > 0) {
      const actualLimit = Math.min(Math.max(1, limit || 10), 10);
      const resultIds = searchData.result.slice(0, actualLimit);
      const fetchUrl = `https://www.pathofexile.com/api/trade/fetch/${resultIds.join(',')}?query=${searchData.id}`;
      
      console.log(`📦 [Search] Fetching ${resultIds.length} items...`);
      
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
        
        console.log(`✅ [Search] Successfully fetched ${itemsData.result.length} items`);
        
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
    
    console.log('✅ [Search] Search completed (no items)');
    
    return res.json({
      searchId: searchData.id,
      league: league || 'Standard',
      total: searchData.total,
      items: [],
    });
    
  } catch (error: any) {
    console.error('💥 [Search] Exception:', error.message);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// ============================================
// 404 Handler
// ============================================
app.use((req, res) => {
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
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/api/poe/stats`);
  console.log(`🔍 Search: http://localhost:${PORT}/api/poe/search`);
});
