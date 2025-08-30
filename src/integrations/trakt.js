// src/integrations/trakt.js
const axios = require('axios');
const { ITEMS_PER_PAGE, TRAKT_CLIENT_ID, TRAKT_REDIRECT_URI, TRAKT_CONCURRENT_REQUESTS } = require('../config');
const { getTraktTokens, saveTraktTokens, clearTraktTokens, debugTraktTokens } = require('../utils/remoteStorage');

const TRAKT_API_URL = 'https://api.trakt.tv';

async function getTraktUserUuid(accessToken) {
  const response = await axios.get(`${TRAKT_API_URL}/users/settings`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    }
  });
  return response.data.user.ids.uuid;
}

async function getTraktUserSettings(accessToken) {
  const response = await axios.get(`${TRAKT_API_URL}/users/settings`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    }
  });
  return {
    uuid: response.data.user.ids.uuid,
    username: response.data.user.username
  };
}

async function refreshTraktToken(userConfig) {
  const refreshToken = userConfig.traktRefreshToken;
  if (!refreshToken) return false;

  try {
    const response = await axios.post(`${TRAKT_API_URL}/oauth/token`, {
      refresh_token: refreshToken,
      client_id: TRAKT_CLIENT_ID,
      redirect_uri: TRAKT_REDIRECT_URI,
      grant_type: 'refresh_token'
    });

    if (response.status === 200 && response.data) {
      const newTokens = {
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token,
          expiresAt: Date.now() + (response.data.expires_in * 1000)
      };

      userConfig.traktAccessToken = newTokens.accessToken;
      userConfig.traktRefreshToken = newTokens.refreshToken;
      userConfig.traktExpiresAt = newTokens.expiresAt;

      // Save tokens if Redis is configured
      if (hasRedisConfig(userConfig) && userConfig.traktUuid) {
        await saveTraktTokens(userConfig, newTokens);
      }
      return true;
    }
    return false;
    } catch (error) {
        if (error.response?.status === 401) {
            userConfig.traktAccessToken = null;
            userConfig.traktRefreshToken = null;
            userConfig.traktExpiresAt = null;
            // Clear tokens from Redis instead of saving null values
            if (hasRedisConfig(userConfig) && userConfig.traktUuid) {
                await clearTraktTokens(userConfig);
            }
        }
        return false;
    }
}

// Helper function to check if Redis (either type) is configured
function hasRedisConfig(userConfig) {
  const hasUpstash = userConfig.upstashUrl && userConfig.upstashToken;
  const hasStandardRedis = userConfig.redisHost;
  return hasUpstash || hasStandardRedis;
}

async function initTraktApi(userConfig) {
  console.log('[TRAKT] initTraktApi called with config:', {
    hasRedisHost: !!userConfig.redisHost,
    hasUpstashUrl: !!userConfig.upstashUrl,
    hasTraktUuid: !!userConfig.traktUuid,
    hasLocalAccessToken: !!userConfig.traktAccessToken,
    hasLocalRefreshToken: !!userConfig.traktRefreshToken,
    localExpiresAt: userConfig.traktExpiresAt
  });

  
  // If Redis credentials are provided, use them as the source of truth
  if (hasRedisConfig(userConfig) && userConfig.traktUuid) {
    console.log('[TRAKT] Redis config available, attempting to load tokens from Redis');
    const tokens = await getTraktTokens(userConfig);
    if (tokens && tokens.accessToken && tokens.refreshToken) {
      console.log('[TRAKT] Valid tokens loaded from Redis');
      userConfig.traktAccessToken = tokens.accessToken;
      userConfig.traktRefreshToken = tokens.refreshToken;
      userConfig.traktExpiresAt = tokens.expiresAt;

      // Check if tokens are expired - be more defensive with date handling
      if (tokens.expiresAt && typeof tokens.expiresAt === 'number' && Date.now() >= tokens.expiresAt) {
        console.log('[TRAKT] Tokens retrieved from Redis are expired, attempting refresh');
        return await refreshTraktToken(userConfig);
      }
      console.log('[TRAKT] Valid tokens retrieved from Redis');
      return true;
    } else {
      console.log('[TRAKT] No valid tokens found in Redis');
    }
  } else {
    console.log('[TRAKT] No Redis config or traktUuid available, checking local tokens');
  }

  // Fallback for non-persistent flow (token is in the config hash)
  if (userConfig.traktAccessToken && userConfig.traktExpiresAt) {
    console.log('[TRAKT] Local tokens available, checking expiration');
    // Check if tokens are expired - be more defensive with date handling  
    const expiresAt = typeof userConfig.traktExpiresAt === 'number' ? 
      userConfig.traktExpiresAt : 
      new Date(userConfig.traktExpiresAt).getTime();
      
    if (Date.now() >= expiresAt) {
      console.log('[TRAKT] Local tokens are expired, attempting refresh');
      return await refreshTraktToken(userConfig);
    }
    console.log('[TRAKT] Valid local tokens found');
    return true;
  }

  console.log('[TRAKT] No authentication available');
  return false;
}

function getTraktAuthUrl(state = null) {
  let url = `${TRAKT_API_URL}/oauth/authorize?response_type=code&client_id=${TRAKT_CLIENT_ID}&redirect_uri=${encodeURIComponent(TRAKT_REDIRECT_URI)}`;
  
  // Add state parameter if provided (e.g., config hash)
  if (state) {
    url += `&state=${encodeURIComponent(state)}`;
  }
  
  return url;
}

async function authenticateTrakt(code, userConfig) {
  const response = await axios.post(`${TRAKT_API_URL}/oauth/token`, {
    code,
    client_id: TRAKT_CLIENT_ID,
    grant_type: 'authorization_code',
    redirect_uri: TRAKT_REDIRECT_URI
  });

  if (response.status === 200 && response.data) {
    const tokens = {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: Date.now() + (response.data.expires_in * 1000)
    };

    const userSettings = await getTraktUserSettings(tokens.accessToken);
    
    return {
      uuid: userSettings.uuid,
      username: userSettings.username,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
  }
  throw new Error('Failed to authenticate with Trakt');
}

// ... the rest of the file (fetchTraktLists, etc.) remains unchanged ...
async function fetchTraktLists(userConfig) {
    const fetchStartTime = Date.now();
    
    // Always include special lists that don't require authentication
    const specialLists = [
      { id: 'trakt_trending_movies', name: 'Trending Movies', isTraktTrending: true, listType: 'T', hasMovies: true, hasShows: false },
      { id: 'trakt_trending_shows', name: 'Trending Shows', isTraktTrending: true, listType: 'T', hasMovies: false, hasShows: true },
      { id: 'trakt_popular_movies', name: 'Popular Movies', isTraktPopular: true, listType: 'T', hasMovies: true, hasShows: false },
      { id: 'trakt_popular_shows', name: 'Popular Shows', isTraktPopular: true, listType: 'T', hasMovies: false, hasShows: true }
    ];
    
    // Check if user is authenticated for accessing personal lists
    const isAuthenticated = await initTraktApi(userConfig);
    
    if (!isAuthenticated) {
      // Return only public lists if not authenticated
      return specialLists.map(sl => ({ ...sl, updated: new Date().toISOString() }));
    }
    
    try {
      const response = await axios.get(`${TRAKT_API_URL}/users/me/lists`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID,
          'Authorization': `Bearer ${userConfig.traktAccessToken}`
        }
      });
      const lists = response.data.map(list => ({
        id: `trakt_${list.ids.slug}`, name: list.name, updated: list.updated_at, listType: 'T', isTraktList: true, hasMovies: true, hasShows: true
      }));
      
      // Add authenticated-only lists
      const authenticatedLists = [
        { id: 'trakt_watchlist', name: 'Trakt Watchlist', isTraktWatchlist: true, listType: 'T', hasMovies: true, hasShows: true },
        { id: 'trakt_recommendations_movies', name: 'Recommended Movies', isTraktRecommendations: true, listType: 'T', hasMovies: true, hasShows: false },
        { id: 'trakt_recommendations_shows', name: 'Recommended Shows', isTraktRecommendations: true, listType: 'T', hasMovies: false, hasShows: true }
      ];
      
      const allLists = [...lists, ...specialLists, ...authenticatedLists].map(sl => ({ ...sl, updated: new Date().toISOString() }));
      const fetchEndTime = Date.now();
      return allLists;
    } catch (error) {
      console.error("[TraktIntegration] Exception fetching Trakt lists:", error.message);
      // Return only public lists if API call fails
      return specialLists.map(sl => ({ ...sl, updated: new Date().toISOString() }));
    }
  }
  
  async function fetchPublicTraktListDetails(traktListUrl) {
    try {
      const cleanedUrl = traktListUrl.split('?')[0];
      const urlMatch = cleanedUrl.match(/^https?:\/\/trakt\.tv\/users\/([\w-]+)\/lists\/([\w-]+)\/?$/);
      if (!urlMatch) {
          throw new Error('Invalid Trakt list URL format.');
      }
      const [, username, listSlugOrId] = urlMatch;
      const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };
      
      const listDetailsResponse = await axios.get(`${TRAKT_API_URL}/users/${username}/lists/${listSlugOrId}`, { headers });
      
      if (!listDetailsResponse.data) {
          throw new Error('Could not fetch Trakt list details.');
      }
      const listData = listDetailsResponse.data;
  
      let hasMovies = false, hasShows = false;
      if (listData.item_count > 0) {
        const sampleLimit = Math.min(listData.item_count, 10);
        const itemsResp = await axios.get(`${TRAKT_API_URL}/users/${username}/lists/${listData.ids.slug}/items?limit=${sampleLimit}&extended=full`, { headers });
        if (itemsResp.data && Array.isArray(itemsResp.data)) {
          for (const item of itemsResp.data) {
            if (item.type === 'movie' && item.movie) hasMovies = true;
            if (item.type === 'show' && item.show) hasShows = true;
            if (hasMovies && hasShows) break;
          }
        }
      }
      const result = {
        listId: `traktpublic_${username}_${listData.ids.slug}`, originalTraktId: String(listData.ids.trakt),
        originalTraktSlug: listData.ids.slug, traktUser: username, listName: listData.name,
        isTraktPublicList: true, hasMovies: hasMovies, hasShows: hasShows, itemCount: listData.item_count
      };
      return result;
    } catch (error) {
      console.error("[TraktIntegration] Exception fetching public Trakt list details:", error.response?.data || error.message);
      throw new Error(`Failed to fetch Trakt list: ${error.response?.data?.error_description || error.message}`);
    }
  }
  
  async function fetchTraktListItems(
    listId, userConfig, skip = 0, sortBy = 'rank', sortOrder = 'asc',
    isPublicImport = false, publicUsername = null, itemTypeHint = null, genre = null,
    isMetadataCheck = false
  ) {
  
  if (!listId) {
    console.error(`[TraktIntegration] Critical error - listId is undefined.`);
    return null;
  }
  
  const limit = isMetadataCheck ? 1 : ITEMS_PER_PAGE;
  const page = isMetadataCheck ? 1 : Math.floor(skip / limit) + 1;
  const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID };
  
  if (!isPublicImport) {
    const isReady = await initTraktApi(userConfig);
    if (!isReady) {
      console.error(`[TraktIntegration] Trakt API not initialized or token refresh failed for listId: ${listId}`);
      return null;
    }
    headers['Authorization'] = `Bearer ${userConfig.traktAccessToken}`;
  }
  
  let requestUrl;
  let params = { limit, page, extended: 'full' };
  let rawTraktEntries = [];
  let effectiveItemTypeForEndpoint = itemTypeHint;
  
  try {
    if (isPublicImport && publicUsername) {
        const actualSlug = listId.replace(/^traktpublic_[^_]+_/, '');
        let basePath = `${TRAKT_API_URL}/users/${publicUsername}/lists/${actualSlug}/items`;
        if (itemTypeHint === 'movie') requestUrl = `${basePath}/movies`;
        else if (itemTypeHint === 'series') requestUrl = `${basePath}/shows`;
        else requestUrl = basePath; 
        effectiveItemTypeForEndpoint = itemTypeHint;
        if (['rank', 'added', 'title', 'released', 'runtime', 'popularity', 'votes', 'random'].includes(sortBy) && !isMetadataCheck) {
            params.sort_by = sortBy; if (sortOrder) params.sort_how = sortOrder;
        }
    } else if (listId === 'trakt_watchlist') {
        let typeForEndpoint = itemTypeHint || 'all'; 
        if (itemTypeHint === 'series') typeForEndpoint = 'shows';
        if (itemTypeHint === 'movie') typeForEndpoint = 'movies';
        let sortForEndpoint = sortBy;
        requestUrl = `${TRAKT_API_URL}/sync/watchlist/${typeForEndpoint}/${sortForEndpoint}/${sortOrder}`;
        params = { limit, page, extended: 'full' };
        effectiveItemTypeForEndpoint = null; 
    } else if (listId.startsWith('trakt_recommendations_')) {
        effectiveItemTypeForEndpoint = listId.endsWith('_movies') ? 'movie' : (listId.endsWith('_shows') ? 'series' : null);
        if (!effectiveItemTypeForEndpoint) { 
            console.error(`[TraktIntegration] Invalid recommendations list ID: ${listId}`);
            return null; 
        }
        requestUrl = `${TRAKT_API_URL}/recommendations/${effectiveItemTypeForEndpoint === 'series' ? 'shows' : 'movies'}`;
        if (genre && !isMetadataCheck) params.genres = genre.toLowerCase().replace(/\s+/g, '-');
    } else if (listId.startsWith('trakt_trending_') || listId.startsWith('trakt_popular_')) {
        effectiveItemTypeForEndpoint = listId.includes('_movies') ? 'movie' : (listId.includes('_shows') ? 'series' : null);
        if (!effectiveItemTypeForEndpoint) { 
            console.error(`[TraktIntegration] Invalid trending/popular list ID: ${listId}`);
            return null; 
        }
        const endpointType = listId.startsWith('trakt_trending_') ? 'trending' : 'popular';
        if (headers.Authorization) { 
          delete headers.Authorization;
        }
        requestUrl = `${TRAKT_API_URL}/${effectiveItemTypeForEndpoint === 'series' ? 'shows' : 'movies'}/${endpointType}`;
        if (genre && !isMetadataCheck) params.genres = genre.toLowerCase().replace(/\s+/g, '-');
  
    } else if (listId.startsWith('trakt_')) { 
        const listSlug = listId.replace('trakt_', '');
        let basePath = `${TRAKT_API_URL}/users/me/lists/${listSlug}/items`;
        if (itemTypeHint === 'movie') { requestUrl = `${basePath}/movies`; effectiveItemTypeForEndpoint = 'movie'; }
        else if (itemTypeHint === 'series') { requestUrl = `${basePath}/shows`; effectiveItemTypeForEndpoint = 'series'; }
        else { requestUrl = basePath; effectiveItemTypeForEndpoint = null; } 
        if (sortBy && !isMetadataCheck) params.sort_by = sortBy; 
        if (sortOrder && !isMetadataCheck) params.sort_how = sortOrder;
    } else {
      console.warn(`[TraktIntegration] Unknown Trakt list ID format or type: ${listId}`);
      return null;
    }
  
    if (requestUrl) { 
        const response = await axios.get(requestUrl, { headers, params });
        if (Array.isArray(response.data)) {
            rawTraktEntries = response.data;
        }
    }
  
      const initialItems = rawTraktEntries.map(entry => {
        let itemDataForDetails;
        let resolvedStremioType;
        let listedAt = entry.listed_at; 
        const itemTypeFromEntry = entry.type;
  
        if (itemTypeFromEntry === 'movie' && entry.movie) {
          resolvedStremioType = 'movie';
          itemDataForDetails = entry.movie;
        } else if (itemTypeFromEntry === 'show' && entry.show) {
          resolvedStremioType = 'series';
          itemDataForDetails = entry.show;
        } else if (itemTypeFromEntry === 'episode' && entry.episode && entry.show) {
           resolvedStremioType = 'series'; 
           itemDataForDetails = entry.show; 
        } else if (itemTypeFromEntry === 'season' && entry.season && entry.show) {
           resolvedStremioType = 'series';
           itemDataForDetails = entry.show;
        } else { 
           if (listId.startsWith('trakt_trending_')) {
              if (effectiveItemTypeForEndpoint === 'movie' && entry.movie && entry.movie.ids && entry.movie.title && typeof entry.movie.year === 'number') {
                  resolvedStremioType = 'movie';
                  itemDataForDetails = entry.movie;
              } else if (effectiveItemTypeForEndpoint === 'series' && entry.show && entry.show.ids && entry.show.title && typeof entry.show.year === 'number') {
                  resolvedStremioType = 'series';
                  itemDataForDetails = entry.show;
              } else {
                  return null;
              }
           } else if (listId.startsWith('trakt_recommendations_') || listId.startsWith('trakt_popular_')) {
              if (effectiveItemTypeForEndpoint === 'movie' && entry.ids && entry.title && typeof entry.year === 'number') {
                  resolvedStremioType = 'movie';
                  itemDataForDetails = entry;
              } else if (effectiveItemTypeForEndpoint === 'series' && entry.ids && entry.title && typeof entry.year === 'number') {
                  resolvedStremioType = 'series';
                  itemDataForDetails = entry;
              } else {
                  return null;
              }
           } else {
               return null;
           }
        }
        
        if (!itemDataForDetails) return null;
        if (itemTypeHint && itemTypeHint !== 'all' && resolvedStremioType !== itemTypeHint) return null; 
        
        const imdbId = itemDataForDetails.ids?.imdb;
        if (!imdbId) return null; 
  
        return {
          imdb_id: imdbId, tmdb_id: itemDataForDetails.ids?.tmdb, title: itemDataForDetails.title,
          year: itemDataForDetails.year, overview: itemDataForDetails.overview, genres: itemDataForDetails.genres,
          runtime: itemDataForDetails.runtime, type: resolvedStremioType,
          listed_at: listedAt 
        };
      }).filter(item => item !== null);
      
      if (listId === 'trakt_watchlist' && sortBy === 'added' && initialItems.length > 0) {
          initialItems.sort((a, b) => {
              const dateA = a.listed_at ? new Date(a.listed_at) : 0;
              const dateB = b.listed_at ? new Date(b.listed_at) : 0;
              return (sortOrder === 'asc' ? dateA - dateB : dateB - dateA);
          });
      }
  
      const finalResult = { allItems: initialItems, hasMovies: false, hasShows: false };
      initialItems.forEach(item => {
        if (item.type === 'movie') finalResult.hasMovies = true;
        else if (item.type === 'series') finalResult.hasShows = true;
      });
          
      return finalResult;
  
    } catch (error) {
      console.error(`[TraktIntegration] Critical exception in fetchTraktListItems for list ${listId}: ${error.message}`, error.stack); 
      if (error.response) {
          console.error(`[TraktIntegration] Trakt API Error Response: Status ${error.response.status}`, JSON.stringify(error.response.data, null, 2)); 
      }
      return null;
    }
  }

/**
 * Fetch metadata for a single item from Trakt
 * @param {string} imdbId - IMDb ID (with or without 'tt' prefix)
 * @param {string} type - 'movie' or 'series'
 * @returns {Object|null} Trakt metadata object or null if not found
 */
async function fetchTraktMetadata(imdbId, type) {
  try {
    const cleanImdbId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
    const traktType = type === 'series' ? 'shows' : 'movies';
    
    const headers = {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID
    };

    const response = await axios.get(`${TRAKT_API_URL}/${traktType}/${cleanImdbId}?extended=full`, {
      headers,
      timeout: 10000
    });

    if (response.data) {
      return convertTraktToStremioFormat(response.data, type);
    }
    return null;
  } catch (error) {
    console.warn(`Failed to fetch Trakt metadata for ${imdbId}:`, error.message);
    return null;
  }
}

/**
 * Convert Trakt API response to Stremio format
 * @param {Object} traktData - Raw data from Trakt API
 * @param {string} type - 'movie' or 'series'
 * @returns {Object} Converted metadata object
 */
function convertTraktToStremioFormat(traktData, type) {
  const baseData = {
    id: traktData.ids?.imdb || null,
    type: type,
    name: traktData.title || 'Unknown Title',
    description: traktData.overview || undefined,
    year: traktData.year || undefined,
    released: traktData.released || undefined,
    genres: traktData.genres || undefined,
    runtime: traktData.runtime ? `${traktData.runtime} min` : undefined,
    country: traktData.country || undefined,
    language: traktData.language || undefined,
    certification: traktData.certification || undefined,
    rating: traktData.rating || undefined,
    votes: traktData.votes || undefined,
    comment_count: traktData.comment_count || undefined,
    popularity: traktData.popularity || undefined,
    updated_at: traktData.updated_at || undefined,
    available_translations: traktData.available_translations || undefined
  };

  // Add type-specific data
  if (type === 'series') {
    baseData.status = traktData.status;
    baseData.first_aired = traktData.first_aired;
    baseData.airs = traktData.airs;
    baseData.network = traktData.network;
    baseData.aired_episodes = traktData.aired_episodes;
  } else if (type === 'movie') {
    baseData.tagline = traktData.tagline;
    baseData.homepage = traktData.homepage;
  }

  // Clean up undefined values
  Object.keys(baseData).forEach(key => baseData[key] === undefined && delete baseData[key]);

  return baseData;
}

/**
 * Batch fetch metadata for multiple items from Trakt
 * @param {Array} items - Array of items with imdb_id and type
 * @returns {Array} Array of enriched items
 */
async function batchFetchTraktMetadata(items) {
  if (!items || items.length === 0) return [];

  // More conservative settings for Trakt API to avoid rate limiting
  const BATCH_SIZE = 5; // Reduced from 10 to 5
  const DELAY_BETWEEN_BATCHES = 2500; // Increased from 1000ms to 2.5 seconds
  const DELAY_BETWEEN_REQUESTS = 500; // 500ms delay between individual requests in a batch

  const results = [];
  
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    
    // Process batch items sequentially instead of in parallel to be more gentle on the API
    const batchResults = [];
    for (const item of batch) {
      if (!item.imdb_id || !item.type) {
        batchResults.push(item);
        continue;
      }
      
      try {
        const traktMetadata = await fetchTraktMetadata(item.imdb_id, item.type);
        if (traktMetadata) {
          batchResults.push({ ...item, ...traktMetadata });
        } else {
          batchResults.push(item);
        }
      } catch (error) {
        if (error.response && error.response.status === 429) {
          console.warn(`Rate limited by Trakt API for ${item.imdb_id}, waiting longer before retry...`);
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds on rate limit
          // Try once more
          try {
            const traktMetadata = await fetchTraktMetadata(item.imdb_id, item.type);
            if (traktMetadata) {
              batchResults.push({ ...item, ...traktMetadata });
            } else {
              batchResults.push(item);
            }
          } catch (retryError) {
            console.warn(`Failed to enrich item ${item.imdb_id} with Trakt metadata after retry:`, retryError.message);
            batchResults.push(item);
          }
        } else {
          console.warn(`Failed to enrich item ${item.imdb_id} with Trakt metadata:`, error.message);
          batchResults.push(item);
        }
      }
      
      // Add delay between individual requests within the batch
      if (batch.indexOf(item) < batch.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
      }
    }

    results.push(...batchResults);

    // Add delay between batches to respect rate limits
    if (i + BATCH_SIZE < items.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }

  return results;
}
  
  /**
 * Fetch available genres from Trakt API
 * @returns {Array} Array of genre names
 */
async function fetchTraktGenres() {
  try {
    const headers = {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': TRAKT_CLIENT_ID
    };

    // Fetch movie and show genres
    const [movieGenresResponse, showGenresResponse] = await Promise.all([
      axios.get(`${TRAKT_API_URL}/genres/movies`, { headers, timeout: 10000 }),
      axios.get(`${TRAKT_API_URL}/genres/shows`, { headers, timeout: 10000 })
    ]);

    // Combine and deduplicate genres
    const movieGenres = movieGenresResponse.data?.map(g => g.name) || [];
    const showGenres = showGenresResponse.data?.map(g => g.name) || [];
    const allGenres = [...new Set([...movieGenres, ...showGenres])];
    
    // Sort alphabetically and add "All" at the beginning
    allGenres.sort();
    return ['All', ...allGenres];
  } catch (error) {
    console.error('Failed to fetch Trakt genres:', error.message);
    // Return default genres if API fails
    return [
      'All', 'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
      'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery',
      'Romance', 'Science Fiction', 'Thriller', 'War', 'Western'
    ];
  }
}

/**
 * Validate Trakt API access (no authentication required for basic access)
 * @returns {boolean} True if Trakt API is accessible
 */
async function validateTraktApi() {
  try {
    const response = await axios.get(`${TRAKT_API_URL}/stats`, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID
      },
      timeout: 5000
    });
    return response.status === 200;
  } catch (error) {
    console.error('Failed to validate Trakt API access:', error.message);
    return false;
  }
}
  
  module.exports = {
  initTraktApi,
  getTraktAuthUrl,
  getTraktUserSettings,
  authenticateTrakt,
  fetchTraktLists,
  fetchTraktListItems,
  fetchPublicTraktListDetails,
  fetchTraktMetadata,
  batchFetchTraktMetadata,
  fetchTraktGenres,
  validateTraktApi
};