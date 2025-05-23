const axios = require('axios');
const Cache = require('../cache');

// Create a cache instance for posters with 1 week TTL
const posterCache = new Cache({ defaultTTL: 7 * 24 * 3600 * 1000 });

/**
 * Generate a cache key that includes the API key
 * @param {string} imdbId - IMDb ID
 * @param {string} rpdbApiKey - RPDB API key
 * @returns {string} Cache key
 */
function getPosterCacheKey(imdbId, rpdbApiKey) {
  // If no API key, use a special prefix to prevent mixing with authenticated requests
  const keyPrefix = rpdbApiKey ? rpdbApiKey.substring(0, 8) : 'no_key';
  return `poster_${keyPrefix}_${imdbId}`;
}

/**
 * Clear all cached posters
 */
function clearPosterCache() {
  posterCache.clear();
}

/**
 * Test RPDB key with a validation endpoint
 * @param {string} rpdbApiKey - RPDB API key
 * @returns {Promise<boolean>} Whether the key is valid
 */
async function validateRPDBKey(rpdbApiKey) {
  if (!rpdbApiKey) return false;
  
  try {
    const response = await axios.get(`https://api.ratingposterdb.com/${rpdbApiKey}/isValid`, {
      timeout: 10000 // 5 second timeout
    });
    
    return response.status === 200 && response.data && response.data.valid === true;
  } catch (error) {
    console.error('RPDB key validation error:', error.message);
    return false;
  }
}

/**
 * Batch fetch posters from RatingPosterDB
 * @param {string[]} imdbIds - Array of IMDb IDs
 * @param {string} rpdbApiKey - RPDB API key
 * @returns {Promise<Object>} Map of IMDb IDs to poster URLs
 */
async function batchFetchPosters(imdbIds, rpdbApiKey) {
  if (!rpdbApiKey || !imdbIds?.length) return {};
  
  const results = {};
  const uncachedIds = [];
  
  // Check cache first for all IDs
  for (const imdbId of imdbIds) {
    const cacheKey = getPosterCacheKey(imdbId, rpdbApiKey);
    const cachedPoster = posterCache.get(cacheKey);
    if (cachedPoster) {
      results[imdbId] = cachedPoster === 'null' ? null : cachedPoster;
    } else {
      uncachedIds.push(imdbId);
    }
  }
  
  // If all posters were cached, return early
  if (!uncachedIds.length) return results;
  
  // Fetch uncached posters in parallel
  const fetchPromises = uncachedIds.map(async (imdbId) => {
    try {
      const poster = await fetchPosterFromRPDB(imdbId, rpdbApiKey);
      results[imdbId] = poster;
    } catch (error) {
      console.error(`Error fetching poster for ${imdbId}:`, error.message);
      results[imdbId] = null;
    }
  });
  
  await Promise.all(fetchPromises);
  return results;
}

/**
 * Fetch poster from RatingPosterDB
 * @param {string} imdbId - IMDb ID
 * @param {string} rpdbApiKey - RPDB API key
 * @returns {Promise<string|null>} Poster URL or null
 */
async function fetchPosterFromRPDB(imdbId, rpdbApiKey) {
  if (!rpdbApiKey || !imdbId) {
    console.log(`Skipping RPDB fetch - missing ${!rpdbApiKey ? 'API key' : 'IMDb ID'}`);
    return null;
  }
  
  // Only process valid IMDb IDs
  if (!imdbId.match(/^tt\d+$/)) {
    console.log(`Invalid IMDb ID format: ${imdbId}`);
    return null;
  }
  
  // Check cache first
  const cacheKey = getPosterCacheKey(imdbId, rpdbApiKey);
  const cachedPoster = posterCache.get(cacheKey);
  if (cachedPoster) {
    return cachedPoster === 'null' ? null : cachedPoster; // Handle cached null values
  }
  
  try {
    const url = `https://api.ratingposterdb.com/${rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`;
    
    // First try a HEAD request to check if poster exists
    try {
      await axios.head(url, { 
        timeout: 5000, // Increased timeout to 5 seconds
        validateStatus: status => status === 200 // Only accept 200 status
      });
      
      // If HEAD request succeeds, cache and return the URL
      posterCache.set(cacheKey, url);
      return url;
    } catch (headError) {
      // If HEAD request fails with 404, try the medium size
      if (headError.response?.status === 404) {
        const mediumUrl = url.replace('poster-default', 'poster-medium');
        try {
          await axios.head(mediumUrl, {
            timeout: 5000,
            validateStatus: status => status === 200
          });
          
          posterCache.set(cacheKey, mediumUrl);
          return mediumUrl;
        } catch (mediumError) {
          // If medium size also fails, throw the original error
          throw headError;
        }
      } else {
        throw headError;
      }
    }
  } catch (error) {
    // Cache negative results to avoid repeated requests
    if (error.response?.status === 404) {
      posterCache.set(cacheKey, 'null', 3600 * 1000); // Cache 404s for 1 hour
    } else if (!error.response || error.code === 'ECONNABORTED') {
      // For network errors or timeouts, cache for a shorter time
      posterCache.set(cacheKey, 'null', 300 * 1000); // Cache for 5 minutes
    } else {
      console.error(`RPDB error for ${imdbId}:`, error.message, error.response?.status);
    }
    return null;
  }
}

module.exports = {
  validateRPDBKey,
  fetchPosterFromRPDB,
  batchFetchPosters,
  clearPosterCache
}; 