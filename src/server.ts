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
let lastSearchRequest = 0;
let lastFetchRequest = 0;
const MIN_DELAY = 5000; // 5초

// 요청 카운터
let searchRequestCount = 0;

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
      searchRequests: searchRequestCount,
    },
    endpoints: {
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
  console.log(`🔍 PoE1 Search: POST /api/poe/search`);
  console.log(`🔍 PoE2 Search: POST /api/poe2/search`);
});