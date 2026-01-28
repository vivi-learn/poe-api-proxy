// Cloudflare Workers용 엔트리 포인트

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
// CORS 헤더 설정
// ============================================
function setCorsHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  newResponse.headers.set('Access-Control-Max-Age', '86400');
  return newResponse;
}

// ============================================
// JSON 응답 헬퍼
// ============================================
function jsonResponse(data: any, status: number = 200): Response {
  return setCorsHeaders(new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  }));
}

// ============================================
// Health Check
// ============================================
function handleRoot(): Response {
  return jsonResponse({
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
}

function handleHealth(): Response {
  return jsonResponse({
    status: 'healthy',
  });
}

// ============================================
// PoE1 Search API
// ============================================
async function handlePoe1Search(request: Request): Promise<Response> {
  try {
    searchRequestCount++;
    const body = await request.json() as { league?: string; query?: any; sort?: any; limit?: number };
    const { league, query, sort, limit } = body;
    
    console.log(`🔍 [PoE1 Search #${searchRequestCount}] ${league || 'Standard'}`);
    
    if (!query) {
      return jsonResponse({ error: 'Query is required' }, 400);
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
      return jsonResponse(
        { error: `PoE API returned ${searchResponse.status}` },
        searchResponse.status
      );
    }
    
    const searchData = await searchResponse.json() as { id: string; result: string[]; total: number };
    
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
        const itemsData = await fetchResponse.json() as { result: any[] };
        
        return jsonResponse({
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
    
    return jsonResponse({
      searchId: searchData.id,
      league: league || 'Standard',
      total: searchData.total,
      items: [],
    });
    
  } catch (error: any) {
    console.error('💥 [PoE1 Search] Exception:', error.message);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ============================================
// PoE2 Search API
// ============================================
async function handlePoe2Search(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { league?: string; query?: any; sort?: any; limit?: number };
    const { league, query, sort, limit } = body;
    
    console.log(`🔍 [PoE2 Search] ${league || 'Standard'}`);
    
    if (!query) {
      return jsonResponse({ error: 'Query is required' }, 400);
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
      return jsonResponse(
        { error: `PoE2 API returned ${searchResponse.status}` },
        searchResponse.status
      );
    }
    
    const searchData = await searchResponse.json() as { id: string; result: string[]; total: number };
    
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
        const itemsData = await fetchResponse.json() as { result: any[] };
        
        return jsonResponse({
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
    
    return jsonResponse({
      searchId: searchData.id,
      league: league || 'Standard',
      total: searchData.total,
      items: [],
    });
    
  } catch (error: any) {
    console.error('💥 [PoE2 Search] Exception:', error.message);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ============================================
// Main Handler
// ============================================
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // OPTIONS 요청 처리 (CORS preflight)
    if (method === 'OPTIONS') {
      return setCorsHeaders(new Response(null, { status: 204 }));
    }

    // 라우팅
    if (path === '/' && method === 'GET') {
      return handleRoot();
    }

    if (path === '/health' && method === 'GET') {
      return handleHealth();
    }

    if (path === '/api/poe/search' && method === 'POST') {
      return handlePoe1Search(request);
    }

    if (path === '/api/poe2/search' && method === 'POST') {
      return handlePoe2Search(request);
    }

    // 404 처리
    console.log('404:', method, path);
    return jsonResponse({
      error: 'Not found',
      path: path,
    }, 404);
  },
};
