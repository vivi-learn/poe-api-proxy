import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 설정 - Vercel 도메인 허용
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));

app.use(express.json());

// ============================================
// Rate Limiting 설정
// ============================================
let lastStatsRequest = 0;
let lastSearchRequest = 0;
let lastFetchRequest = 0;
const MIN_DELAY = 2000; // 2초

// ============================================
// Stats 캐시
// ============================================
interface CacheEntry {
  data: any;
  timestamp: number;
}

let statsCache: CacheEntry | null = null;
const STATS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

// ============================================
// Utility: Rate Limited Fetch
// ============================================
async function rateLimitedFetch(
  url: string,
  options: RequestInit,
  lastRequestRef: { value: number }
): Promise<Response> {
  const now = Date.now();
  const timeSince = now - lastRequestRef.value;
  
  if (timeSince < MIN_DELAY) {
    const waitTime = MIN_DELAY - timeSince;
    console.log(`⏱️  Rate limiting: waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestRef.value = Date.now();
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
    const now = Date.now();
    
    // 캐시 확인
    if (statsCache && (now - statsCache.timestamp) < STATS_CACHE_TTL) {
      console.log('📦 [Stats] Returning cached data');
      return res.json(statsCache.data);
    }
    
    console.log('🔍 [Stats] Fetching from PoE API...');
    
    const response = await rateLimitedFetch(
      'https://www.pathofexile.com/api/trade/data/stats',
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      },
      { value: lastStatsRequest }
    );
    
    if (!response.ok) {
      console.error(`❌ [Stats] PoE API Error: ${response.status}`);
      
      // 오래된 캐시라도 반환
      if (statsCache) {
        console.log('📦 [Stats] Returning stale cache due to error');
        return res.json(statsCache.data);
      }
      
      return res.status(response.status).json({
        error: `PoE API returned ${response.status}`,
      });
    }
    
    const data = await response.json();
    
    // 캐시 저장
    statsCache = { data, timestamp: now };
    console.log('✅ [Stats] Successfully fetched and cached');
    
    return res.json(data);
    
  } catch (error: any) {
    console.error('💥 [Stats] Exception:', error.message);
    
    // 예외 발생 시 오래된 캐시라도 반환
    if (statsCache) {
      console.log('📦 [Stats] Returning stale cache after exception');
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
    const { league, query, sort, limit } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    const encodedLeague = encodeURIComponent(league || 'Standard');
    const searchUrl = `https://www.pathofexile.com/api/trade/search/${encodedLeague}`;
    
    console.log(`🔍 [Search] Searching in ${league || 'Standard'}...`);
    
    // 검색 요청
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
      { value: lastSearchRequest }
    );
    
    if (!searchResponse.ok) {
      console.error(`❌ [Search] PoE API Error: ${searchResponse.status}`);
      return res.status(searchResponse.status).json({
        error: `PoE API returned ${searchResponse.status}`,
      });
    }
    
    const searchData = await searchResponse.json();
    
    // 아이템 상세 정보 가져오기
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
        { value: lastFetchRequest }
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
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Stats API: http://localhost:${PORT}/api/poe/stats`);
  console.log(`🔍 Search API: http://localhost:${PORT}/api/poe/search`);
});

