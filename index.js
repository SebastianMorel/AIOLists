// index.js
const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 7000;
const CACHE_TTL = 60 * 60 * 1000;
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.json');
const TRAKT_API_URL = 'https://api.trakt.tv';
const TMDB_IMAGE_URL = 'https://image.tmdb.org/t/p/w500';
const isProduction = process.env.NODE_ENV === 'production';

// Initialize environment variables
const ENV_MDBLIST_API_KEY = process.env.MDBLIST_API_KEY;
const ENV_RPDB_API_KEY = process.env.RPDB_API_KEY;
const ENV_TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;

// Global variables
// Replace simple object with a proper cache implementation
class Cache {
  constructor() {
    this.cache = new Map();
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    
    const item = this.cache.get(key);
    const now = Date.now();
    
    // Check if the cached item has expired
    if (item.expiry < now) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  get(key) {
    if (!this.has(key)) return null;
    return this.cache.get(key).value;
  }

  set(key, value, ttl) {
    const expiry = Date.now() + ttl;
    this.cache.set(key, { value, expiry });
    return true;
  }

  clear() {
    this.cache.clear();
  }
}

let cache = new Cache();
let addonInterface = null;
let userConfig = {
  apiKey: '',            // MDBList API key
  rpdbApiKey: '',        // RPDB API key for posters
  traktClientId: '',     // Trakt Client ID
  traktClientSecret: '', // Trakt Client Secret
  traktAccessToken: '',  // Trakt Access Token
  traktRefreshToken: '', // Trakt Refresh Token
  traktExpiresAt: null,  // Trakt token expiration date
  listOrder: [],
  lastUpdated: null,
  listsMetadata: {},
  hiddenLists: [],
  customListNames: {}    // Store custom names for lists
};

// ==================== CONFIG MANAGEMENT ====================

// When loading config, prioritize environment variables if available
function loadConfig() {
  try {
    let loadedConfig = {
      apiKey: '',
      rpdbApiKey: '',
      traktClientId: '',
      traktClientSecret: '',
      traktAccessToken: '',
      traktRefreshToken: '',
      traktExpiresAt: null,
      listOrder: [],
      hiddenLists: [],
      listsMetadata: {},
      lastUpdated: new Date().toISOString()
    };
    
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      const data = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
      loadedConfig = JSON.parse(data);
    }
    
    // Override with environment variables if available
    if (ENV_MDBLIST_API_KEY) loadedConfig.apiKey = ENV_MDBLIST_API_KEY;
    if (ENV_RPDB_API_KEY) loadedConfig.rpdbApiKey = ENV_RPDB_API_KEY;
    if (ENV_TRAKT_CLIENT_SECRET) loadedConfig.traktClientSecret = ENV_TRAKT_CLIENT_SECRET;
    
    userConfig = loadedConfig;
  } catch (err) {
    if (!isProduction) {
      console.error('Failed to load config:', err);
    }
    
    userConfig = {
      apiKey: ENV_MDBLIST_API_KEY || '',
      rpdbApiKey: ENV_RPDB_API_KEY || '',
      traktClientId: '11f925f671c0541ddc547717523f9a180cd6af992f9169e7b6b091d0912a856d' || '',
      traktClientSecret: ENV_TRAKT_CLIENT_SECRET || '',
      traktAccessToken: '',
      traktRefreshToken: '',
      traktExpiresAt: null,
      listOrder: [],
      hiddenLists: [],
      listsMetadata: {},
      lastUpdated: new Date().toISOString()
    };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  } catch (err) {
    if (!isProduction) {
      console.error('Failed to save config:', err);
    }
  }
}

// ==================== API FUNCTIONS ====================

// Fetch all user lists from MDBList API
async function fetchAllLists(apiKey) {
  try {
    let allLists = [];
    
    // Fetch MDBList lists if API key is provided
    if (apiKey) {
    try {
        // Fetch user's regular internal lists from MDBList
      const userListsResponse = await axios.get(`https://api.mdblist.com/lists/user?apikey=${apiKey}`);
      const userLists = (userListsResponse.data || []).map(list => ({
        ...list, 
        listType: 'L',
          isInternalList: true
      }));
      allLists = [...allLists, ...userLists];
    
    // Fetch user's external lists from MDBList
      const externalListsResponse = await axios.get(`https://api.mdblist.com/external/lists/user?apikey=${apiKey}`);
      const externalLists = (externalListsResponse.data || []).map(list => ({
        ...list, 
        listType: 'E',
          isExternalList: true
      }));
      allLists = [...allLists, ...externalLists];
    
    // Add the MDBList watchlist
    allLists.push({
      id: 'watchlist',
      user_id: 'current',
      name: 'My Watchlist',
      updated: new Date().toISOString(),
      isWatchlist: true,
      listType: 'W'
    });
      } catch (err) {
        console.error('Error fetching MDBList lists:', err.message);
      }
    }
    
    // Try to fetch Trakt lists if configured
    if (userConfig.traktAccessToken) {
      try {
        const traktLists = await fetchTraktLists();
        if (traktLists && traktLists.length > 0) {
          allLists = [...allLists, ...traktLists];
        }
      } catch (err) {
        console.error('Error fetching Trakt lists:', err.message);
      }
    }
    
    // Create a map of all available lists
    const listMap = {};
    allLists.forEach(list => {
      listMap[list.id] = list;
    });
    
    // Apply list ordering from config if available
    const orderedLists = [];
    
    // First, add lists in the saved order
    if (userConfig.listOrder && userConfig.listOrder.length > 0) {
      userConfig.listOrder.forEach(id => {
        if (listMap[id]) {
          orderedLists.push(listMap[id]);
          delete listMap[id];
        }
      });
    }
      
    // Then add any remaining lists
    Object.values(listMap).forEach(list => {
      orderedLists.push(list);
    });
    
    return orderedLists;
  } catch (error) {
    console.error('Error fetching lists:', error);
    return [];
  }
}

// Fetch items in a specific list
async function fetchListItems(listId, apiKey) {
  try {
    // Check if this is an imported addon catalog
    if (userConfig.importedAddons) {
      for (const addon of Object.values(userConfig.importedAddons)) {
        const catalog = addon.catalogs.find(c => c.id === listId);
        if (catalog) {
          try {
            // For anime catalogs, maintain the full URL structure
            if (addon.id === 'anime-catalogs') {
              // The catalog URL needs to maintain the configuration from the manifest URL
              const catalogUrl = `${addon.url}/catalog/anime/${catalog.id}.json`;
              
              const response = await axios.get(catalogUrl);
              if (response.data && response.data.metas) {
                // Convert anime catalog format to our internal format
                return {
                  movies: response.data.metas.filter(item => item.type === 'movie').map(item => ({
                    imdb_id: item.id,
                    title: item.name,
                    year: item.releaseInfo ? parseInt(item.releaseInfo) : null,
                    type: 'movie',
                    poster: item.poster,
                    background: item.background,
                    description: item.description,
                    runtime: item.runtime,
                    genres: item.genres,
                    imdbRating: item.imdbRating
                  })),
                  shows: response.data.metas.filter(item => item.type === 'series').map(item => ({
                    imdb_id: item.id,
                    title: item.name,
                    year: item.releaseInfo ? parseInt(item.releaseInfo) : null,
                    type: 'show',
                    poster: item.poster,
                    background: item.background,
                    description: item.description,
                    runtime: item.runtime,
                    genres: item.genres,
                    imdbRating: item.imdbRating
                  }))
                };
              }
            } else {
              // Regular Stremio addon catalog URL format
              const manifestUrl = new URL(addon.url);
              const baseUrl = `${manifestUrl.protocol}//${manifestUrl.host}`;
              const catalogUrl = `${baseUrl}/catalog/${catalog.type}/${catalog.originalId}/skip=0.json`;
              
              const response = await axios.get(catalogUrl);
              if (response.data && response.data.metas) {
                return {
                  movies: response.data.metas.filter(item => item.type === 'movie').map(item => ({
                    imdb_id: item.imdb_id || item.id,
                    title: item.name || item.title,
                    year: item.year,
                    type: 'movie'
                  })),
                  shows: response.data.metas.filter(item => item.type === 'series').map(item => ({
                    imdb_id: item.imdb_id || item.id,
                    title: item.name || item.title,
                    year: item.year,
                    type: 'show'
                  }))
                };
              }
            }
          } catch (error) {
            console.error(`Error fetching from imported addon: ${error.message}`);
            if (error.response) {
              console.error('Addon API Error Response:', error.response.data);
            }
          }
          return null;
        }
      }
    }
    
    // Check if this is a Trakt list
    if (listId.startsWith('trakt_')) {
      // Handle special Trakt lists
      if (listId === 'trakt_watchlist') {
        const movies = await axios.get(`${TRAKT_API_URL}/users/me/watchlist/movies`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
            'Authorization': `Bearer ${userConfig.traktAccessToken}`
          }
        });
        
        const shows = await axios.get(`${TRAKT_API_URL}/users/me/watchlist/shows`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
            'Authorization': `Bearer ${userConfig.traktAccessToken}`
          }
        });
        
        return {
          movies: movies.data.map(item => ({
            imdb_id: item.movie.ids.imdb,
            title: item.movie.title,
            year: item.movie.year,
            type: 'movie'
          })),
          shows: shows.data.map(item => ({
            imdb_id: item.show.ids.imdb,
            title: item.show.title,
            year: item.show.year,
            type: 'show'
          }))
        };
      }
      
      if (listId === 'trakt_trending_movies') {
        const response = await axios.get(`${TRAKT_API_URL}/movies/trending`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
          }
        });
        
        return {
          movies: response.data.map(item => ({
            imdb_id: item.movie.ids.imdb,
            title: item.movie.title,
            year: item.movie.year,
            type: 'movie'
          })),
          shows: []
        };
      }
      
      if (listId === 'trakt_trending_shows') {
        const response = await axios.get(`${TRAKT_API_URL}/shows/trending`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
          }
        });
        
        return {
          movies: [],
          shows: response.data.map(item => ({
            imdb_id: item.show.ids.imdb,
            title: item.show.title,
            year: item.show.year,
            type: 'show'
          }))
        };
      }
      
      if (listId === 'trakt_popular_movies') {
        const response = await axios.get(`${TRAKT_API_URL}/movies/popular`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
          }
        });
        
        return {
          movies: response.data.map(item => ({
            imdb_id: item.ids.imdb,
            title: item.title,
            year: item.year,
            type: 'movie'
          })),
          shows: []
        };
      }
      
      if (listId === 'trakt_popular_shows') {
        const response = await axios.get(`${TRAKT_API_URL}/shows/popular`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
          }
        });
        
        return {
          movies: [],
          shows: response.data.map(item => ({
            imdb_id: item.ids.imdb,
            title: item.title,
            year: item.year,
            type: 'show'
          }))
        };
      }
      
      if (listId === 'trakt_recommendations_movies') {
        const response = await axios.get(`${TRAKT_API_URL}/recommendations/movies`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
            'Authorization': `Bearer ${userConfig.traktAccessToken}`
          }
        });
        
        return {
          movies: response.data.map(item => ({
            imdb_id: item.ids.imdb,
            title: item.title,
            year: item.year,
            overview: item.overview,
            release_date: item.released,
            runtime: item.runtime,
            type: 'movie'
          })),
          shows: []
        };
      }
      
      if (listId === 'trakt_recommendations_shows') {
        const response = await axios.get(`${TRAKT_API_URL}/recommendations/shows`, {
          headers: {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
            'Authorization': `Bearer ${userConfig.traktAccessToken}`
          }
        });
        
        return {
          movies: [],
          shows: response.data.map(item => ({
            imdb_id: item.ids.imdb,
            title: item.title,
            year: item.year,
            overview: item.overview,
            first_air_date: item.first_aired,
            type: 'show'
          }))
        };
      }
      
      // For regular Trakt lists
      const listSlug = listId.replace('trakt_', '');
      const response = await axios.get(`${TRAKT_API_URL}/users/me/lists/${listSlug}/items`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
          'Authorization': `Bearer ${userConfig.traktAccessToken}`
        }
      });
      
      return {
        movies: response.data
          .filter(item => item.type === 'movie')
          .map(item => ({
            imdb_id: item.movie.ids.imdb,
            title: item.movie.title,
            year: item.movie.year,
            type: 'movie'
          })),
        shows: response.data
          .filter(item => item.type === 'show')
          .map(item => ({
            imdb_id: item.show.ids.imdb,
            title: item.show.title,
            year: item.show.year,
            type: 'show'
          }))
      };
    }
    
    // Otherwise, assume it's an MDBList list
    // Determine the appropriate URL based on list type
    let url;
    let listType = 'unknown';
    
    // Check if we have list metadata in the config
    const listMetadata = userConfig.listsMetadata ? userConfig.listsMetadata[listId] : null;
    
    if (listId === 'watchlist') {
      url = `https://api.mdblist.com/watchlist/items?apikey=${apiKey}`;
      listType = 'watchlist';
    } else if (listMetadata && listMetadata.isExternalList) {
      url = `https://api.mdblist.com/external/lists/${listId}/items?apikey=${apiKey}`;
      listType = 'external';
    } else {
      url = `https://api.mdblist.com/lists/${listId}/items?apikey=${apiKey}`;
      listType = 'internal';
    }
    
    const response = await axios.get(url);
    
    if (response.status !== 200) {
      console.error(`Failed to fetch list ${listId}: ${response.status}`);
      return null;
    }
    
    return processApiResponse(response.data, listId);
  } catch (error) {
    console.error(`Error fetching list ${listId}:`, error);
    if (error.response) {
      console.error('API Error Response:', error.response.data);
    }
    return null;
  }
}

// Helper function to process API responses
function processApiResponse(data, listId) {
  if (data.error) {
    console.error(`API error for list ${listId}: ${data.error}`);
    return null;
  }
  
  // MDBList API might directly return movies and shows properties
  if (data.movies !== undefined || data.shows !== undefined) {
    return {
      movies: Array.isArray(data.movies) ? data.movies : [],
      shows: Array.isArray(data.shows) ? data.shows : []
    };
  }
  
  // Attempt to find items in the response - different API endpoints might have different structures
  let itemsArray = [];
  
  // Check standard format
  if (data.items && Array.isArray(data.items)) {
    itemsArray = data.items;
  } 
  // Check if data itself is an array (some APIs directly return an array)
  else if (Array.isArray(data)) {
    itemsArray = data;
  }
  // Check if data has a 'results' field (common in many APIs)
  else if (data.results && Array.isArray(data.results)) {
    itemsArray = data.results;
  }
  
  // If we still don't have items, return empty arrays
  if (itemsArray.length === 0) {
    return {
      movies: [],
      shows: []
    };
  }
  
  // Now we have items, filter by type (if type property exists)
  // Some APIs use mediatype instead of type
  return {
    movies: itemsArray.filter(item => item && (item.type === 'movie' || item.mediatype === 'movie')),
    shows: itemsArray.filter(item => item && (item.type === 'show' || item.mediatype === 'show'))
  };
}

// Test RPDB key with known IMDb IDs
async function validateRPDBKey(rpdbApiKey) {
  if (!rpdbApiKey) return false;
  
  try {
    const response = await axios.get(`https://api.ratingposterdb.com/${rpdbApiKey}/isValid`, {
      timeout: 5000 // 5 second timeout
    });
    
    return response.status === 200 && response.data && response.data.valid === true;
  } catch (error) {
    console.error('RPDB key validation error:', error.message);
    return false;
  }
}

// Fetch poster from RatingPosterDB
async function fetchPosterFromRPDB(imdbId, rpdbApiKey) {
  if (!rpdbApiKey || !imdbId) return null;
  
  // Only process valid IMDb IDs
  if (!imdbId.match(/^tt\d+$/)) {
    return null;
  }
  
  try {
    const url = `https://api.ratingposterdb.com/${rpdbApiKey}/imdb/poster-default/${imdbId}.jpg`;
    
    const response = await axios.head(url, { 
      timeout: 3000 // 3 second timeout
    });
    
    if (response.status === 200) {
      return url;
    }
    return null;
  } catch (error) {
    // Don't log 404s as they're expected
    if (error.response && error.response.status !== 404) {
      console.error(`RPDB error for ${imdbId}:`, error.message);
    }
    return null;
  }
}

// Test RPDB key with known IMDb IDs
function testRPDBKey(rpdbApiKey) {
  if (!rpdbApiKey) return;
  
  const testIds = ['tt0111161', 'tt0068646', 'tt0468569'];
  
  testIds.forEach(id => {
    fetchPosterFromRPDB(id, rpdbApiKey)
      .then(url => {
        // Do nothing with result
      })
      .catch(err => {
        console.error(`RPDB test error for ${id}: ${err.message}`);
      });
  });
}

// ==================== STREMIO ADDON CREATION ====================

// Convert MDBList items to Stremio format
async function convertToStremioFormat(items, skip = 0, limit = 10) {
  const metas = [];
  
  // Check if we have a valid RPDB API key
  const useRPDB = !!userConfig.rpdbApiKey;
  
  // Prepare all items first without posters
  let allItems = [];
  
  // Process movies
  if (items.movies && items.movies.length > 0) {
    for (const movie of items.movies) {
      // Check which IMDB ID format is used
      let imdbId = movie.imdb_id || movie.imdbid;
      
      // Ensure the IMDb ID has the 'tt' prefix
      if (imdbId && !imdbId.startsWith('tt')) {
        imdbId = `tt${imdbId}`;
      }
      
      // Skip items without IMDB ID
      if (!imdbId) {
        continue;
      }
      
      allItems.push({
        id: imdbId,
        type: 'movie',
        name: movie.title,
        poster: movie.poster,
        background: movie.backdrop,
        description: movie.overview,
        releaseInfo: movie.release_year || (movie.release_date ? movie.release_date.split('-')[0] : undefined),
        imdbRating: movie.imdbrating ? movie.imdbrating.toFixed(1) : undefined,
        runtime: movie.runtime ? `${movie.runtime} min` : undefined,
        genres: movie.genres ? (typeof movie.genres === 'string' ? movie.genres.split(',').map(g => g.trim()) : movie.genres) : undefined,
        originalItem: movie // Store original item for reference
      });
    }
  }
  
  // Process shows
  if (items.shows && items.shows.length > 0) {
    for (const show of items.shows) {
      // Check which IMDB ID format is used
      let imdbId = show.imdb_id || show.imdbid;
      
      // Ensure the IMDb ID has the 'tt' prefix
      if (imdbId && !imdbId.startsWith('tt')) {
        imdbId = `tt${imdbId}`;
      }
      
      // Skip items without IMDB ID
      if (!imdbId) {
        continue;
      }
      
      allItems.push({
        id: imdbId,
        type: 'series',
        name: show.title,
        poster: show.poster,
        background: show.backdrop,
        description: show.overview,
        releaseInfo: show.release_year || (show.first_air_date ? show.first_air_date.split('-')[0] : undefined),
        imdbRating: show.imdbrating ? show.imdbrating.toFixed(1) : undefined,
        runtime: show.runtime ? `${show.runtime} min` : undefined,
        genres: show.genres ? (typeof show.genres === 'string' ? show.genres.split(',').map(g => g.trim()) : show.genres) : undefined,
        status: show.status,
        videos: [],
        originalItem: show // Store original item for reference
      });
    }
  }
  
  // Only attempt to fetch RPDB posters for the items that will be displayed
  const pageItems = allItems.slice(skip, skip + limit);
  
  // Process RPDB posters only for the current page of items
  if (useRPDB && pageItems.length > 0) {
    for (const item of pageItems) {
      // Try to get RPDB poster if we have a valid API key
      const rpdbPoster = await fetchPosterFromRPDB(item.id, userConfig.rpdbApiKey);
      if (rpdbPoster) {
        item.poster = rpdbPoster;
      }
      
      // Add to metas without the originalItem property
      const { originalItem, ...meta } = item;
      metas.push(meta);
    }
  } else {
    // If not using RPDB, just add items without fetching posters
    for (const item of pageItems) {
      const { originalItem, ...meta } = item;
      metas.push(meta);
    }
  }
  
  return metas;
}

// Force rebuild the addon
async function rebuildAddon() {
  // Clear all caches to ensure fresh data
  cache.clear();
  
  // Completely rebuild the addon interface
  addonInterface = await createAddon();
  
  return addonInterface;
}

// Create the Stremio addon
async function createAddon() {
  const manifest = {
    id: 'org.stremio.aiolists',
    version: '1.0.0-' + Date.now(),
    name: 'AIOLists',
    description: 'Browse AIOLists and Trakt lists in Stremio',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
  };

  try {
    // Convert hiddenLists to a Set for more efficient lookups
    const hiddenLists = new Set(userConfig.hiddenLists || []);
    
    // Add regular lists
    if (userConfig.apiKey || userConfig.traktAccessToken) {
      const allLists = await fetchAllLists(userConfig.apiKey);
      // Use Set's has() method for efficient filtering
      const visibleLists = allLists.filter(list => !hiddenLists.has(String(list.id)));
      
      storeListsMetadata(allLists);
      
      visibleLists.forEach(list => {
        const listId = String(list.id);
        let displayName = list.name;
        if (userConfig.customListNames && userConfig.customListNames[listId]) {
          displayName = userConfig.customListNames[listId];
        }
        
        const safeName = displayName.replace(/[^\w\s-]/g, '');
        const catalogId = listId.startsWith('trakt_') ? listId : `aiolists-${listId}`;
        let types = ['movie', 'series'];
        
        if (list.isMovieList) {
          types = ['movie'];
        } else if (list.isShowList) {
          types = ['series'];
        }
        
        types.forEach(type => {
        manifest.catalogs.push({
            type: type,
            id: catalogId,
          name: `${safeName}`,
          extra: [{ name: 'skip' }]
        });
        });
      });
    }

    // Add imported lists
    if (userConfig.importedAddons) {
      for (const addon of Object.values(userConfig.importedAddons)) {
        addon.catalogs
          .filter(catalog => {
            // Ensure consistent handling of string IDs
            const catalogId = String(catalog.id);
            return !hiddenLists.has(catalogId);
          })
          .forEach(catalog => {
            // Apply custom names if available
            const catalogId = String(catalog.id);
            let displayName = catalog.name;
            
            if (userConfig.customListNames && userConfig.customListNames[catalogId]) {
              displayName = userConfig.customListNames[catalogId];
            }
            
        manifest.catalogs.push({
              type: catalog.type,
              id: catalogId,
              name: displayName,
          extra: [{ name: 'skip' }]
        });
      });
      }
    }
    
    // Apply list ordering from config if available
    if (userConfig.listOrder && userConfig.listOrder.length > 0) {
      const orderMap = new Map(userConfig.listOrder.map((id, index) => [String(id), index]));
      
      // Sort catalogs based on list order
      manifest.catalogs.sort((a, b) => {
        // Extract the list ID from the catalog ID for aiolists prefixed catalogs
        const aId = a.id.startsWith('aiolists-') ? a.id.replace('aiolists-', '') : a.id;
        const bId = b.id.startsWith('aiolists-') ? b.id.replace('aiolists-', '') : b.id;
        
        const aOrder = orderMap.has(aId) ? orderMap.get(aId) : Number.MAX_SAFE_INTEGER;
        const bOrder = orderMap.has(bId) ? orderMap.get(bId) : Number.MAX_SAFE_INTEGER;
        
        return aOrder - bOrder;
      });
    }

    const builder = new addonBuilder(manifest);
    
    builder.defineCatalogHandler(async ({ type, id, extra }) => {
      if (!userConfig.apiKey && !userConfig.traktAccessToken && !userConfig.importedAddons) {
        return { metas: [] };
      }
      
      try {
        const skip = extra?.skip ? parseInt(extra.skip) : 0;
        const cacheKey = `${id}_${type}_${skip}`;
        
        if (cache.has(cacheKey)) {
          return cache.get(cacheKey);
        }
        
        const items = await fetchListItems(id, userConfig.apiKey);
        if (!items) {
          return { metas: [] };
        }
        
        const allMetas = await convertToStremioFormat(items, skip, 5000);
        
        let filteredMetas = allMetas;
        if (type === 'movie') {
          filteredMetas = allMetas.filter(item => item.type === 'movie');
        } else if (type === 'series') {
          filteredMetas = allMetas.filter(item => item.type === 'series');
        }
        
        const response = {
          metas: filteredMetas,
          cacheMaxAge: 3600 * 24
        };
        
        cache.set(cacheKey, response, 3600 * 24 * 1000);
        
        return response;
      } catch (error) {
        return { metas: [] };
      }
    });
    
    return builder.getInterface();
  } catch (error) {
    throw error;
  }
}

// ==================== EXPRESS SETUP ====================

// Initialize Express app at the top level so all routes can access it
const app = express();

// Configure middleware
app.use((req, res, next) => {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== API ROUTES ====================

// Manifest endpoint
app.get('/manifest.json', async (req, res) => {
  try {
    // Force clear all caches
    cache = new Cache();
    
    // Create a fresh addon interface
    let freshAddonInterface = await createAddon();
    
    // Verify the addon interface was created
    if (!freshAddonInterface || !freshAddonInterface.manifest) {
      return res.status(500).json({ error: 'Invalid addon interface created' });
    }
    
    // Final safety check: ensure hidden lists are properly excluded
    // Convert all IDs to strings for consistent comparison
    const hiddenListsSet = new Set(Array.from(userConfig.hiddenLists || []).map(String));
    if (hiddenListsSet.size > 0) {
      freshAddonInterface.manifest.catalogs = freshAddonInterface.manifest.catalogs.filter(catalog => {
        // Extract the list ID from the catalog ID and ensure it's a string
        let listId = catalog.id;
        if (catalog.id.startsWith('aiolists-')) {
          listId = catalog.id.replace('aiolists-', '');
        }
        listId = String(listId);
        
        // Keep only catalogs that aren't in the hidden lists
        return !hiddenListsSet.has(listId);
      });
    }
    
    // Return a deep copy to avoid modification
    const manifestCopy = JSON.parse(JSON.stringify(freshAddonInterface.manifest));
    
    // Set cache control headers
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Add a unique timestamp to prevent caching
    manifestCopy.version = manifestCopy.version + '-' + Date.now();
    
    // Update the global addonInterface
    addonInterface = freshAddonInterface;
    
    res.json(manifestCopy);
  } catch (error) {
    res.status(500).json({ error: 'Failed to serve manifest: ' + error.message });
  }
});

// API key endpoints
app.post('/api/config/apikey', async (req, res) => {
  try {
    const { apiKey, rpdbApiKey } = req.body;
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }
  
    userConfig.apiKey = apiKey;
    if (rpdbApiKey !== undefined) {
      userConfig.rpdbApiKey = rpdbApiKey;
    }
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();
  
    // Rebuild addon with new API key
    await rebuildAddon();
    
    res.json({ success: true });
  } catch (error) {
    if (!isProduction) {
      console.error("Error saving API key:", error);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/config/apikey', (req, res) => {
  res.json({ apiKey: userConfig.apiKey || '' });
});

app.post('/api/config/rpdbkey', async (req, res) => {
  try {
    const { rpdbApiKey } = req.body;
    
    // Validate the RPDB API key if one was provided
    let isValid = true;
    if (rpdbApiKey) {
      isValid = await validateRPDBKey(rpdbApiKey);
      if (!isValid) {
        return res.status(400).json({ 
          error: 'Invalid RPDB API key',
          success: false
        });
      }
    }
    
    userConfig.rpdbApiKey = rpdbApiKey || '';
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();
    
    // Test the key
    if (rpdbApiKey) {
      testRPDBKey(rpdbApiKey);
    }
    
    // Clear cache
    cache.clear();
    
    res.json({ 
      success: true,
      valid: isValid 
    });
  } catch (error) {
    if (!isProduction) {
      console.error("Error saving RPDB key:", error);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/config/rpdbkey', (req, res) => {
  res.json({ rpdbApiKey: userConfig.rpdbApiKey || '' });
});

// Get all configuration
app.get('/api/config/all', (req, res) => {
  // Return a sanitized version of the config (omit sensitive data)
  const safeConfig = {
    listOrder: userConfig.listOrder || [],
    hiddenLists: userConfig.hiddenLists || [],
    listsMetadata: userConfig.listsMetadata || {},
    lastUpdated: userConfig.lastUpdated,
    customListNames: userConfig.customListNames || {}
  };
  
  res.json(safeConfig);
});

// Lists endpoints
app.get('/api/lists', async (req, res) => {
  try {
    const allLists = await fetchAllLists(userConfig.apiKey);
    const lists = allLists.map(list => ({
      id: String(list.id),
      name: list.name,
      customName: userConfig.customListNames?.[list.id] || null,
      isHidden: (userConfig.hiddenLists || []).includes(list.id),
      isMovieList: list.isMovieList,
      isShowList: list.isShowList,
      isExternalList: list.isExternalList,
      listType: list.listType || 'L', // Default to 'L' for regular lists
      isTraktList: list.isTraktList,
      isWatchlist: list.isWatchlist,
      tag: list.listType || 'L'
    }));

    // Add imported addon lists
    if (userConfig.importedAddons) {
      for (const addon of Object.values(userConfig.importedAddons)) {
        const addonLists = addon.catalogs.map(catalog => {
          // Use the exact catalog.id as the ID to ensure consistent ID handling
          const catalogId = String(catalog.id);
          
          return {
            id: catalogId,
            originalId: catalog.id,
            name: catalog.name,
            customName: userConfig.customListNames?.[catalogId] || null,
            isHidden: (userConfig.hiddenLists || []).includes(catalogId),
            isMovieList: catalog.type === 'movie',
            isShowList: catalog.type === 'series',
            isExternalList: true,
            listType: 'A', // 'A' for External Addon
            addonId: addon.id,
            addonName: addon.name,
            addonLogo: addon.logo || null,
            tag: 'A',
            tagImage: addon.logo
          };
        });
        lists.push(...addonLists);
      }
    }

    // Apply list ordering
    if (userConfig.listOrder && userConfig.listOrder.length > 0) {
      // Convert to Map for faster lookup
      const orderMap = new Map(userConfig.listOrder.map((id, index) => [String(id), index]));
      lists.sort((a, b) => {
        const aId = String(a.id);
        const bId = String(b.id);
        const orderA = orderMap.has(aId) ? orderMap.get(aId) : Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.has(bId) ? orderMap.get(bId) : Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
      });
    }

    res.json({
      success: true,
      lists: lists,
      importedAddons: userConfig.importedAddons || {}
    });
  } catch (error) {
    if (!isProduction) {
      console.error('Error fetching lists:', error);
    }
    res.status(500).json({ error: 'Failed to fetch lists' });
  }
});

// List order endpoint
app.post('/api/lists/order', async (req, res) => {
  try {
    const { order } = req.body;
    
    if (!order || !Array.isArray(order)) {
      return res.status(400).json({ error: 'Order must be an array of list IDs' });
    }
    
    // Save the previous order for comparison
    const previousOrder = userConfig.listOrder || [];
    
    // Check if there are actual changes
    const hasChanges = (
      previousOrder.length !== order.length ||
      order.some((id, index) => previousOrder[index] !== id)
    );
    
    if (!hasChanges) {
      return res.json({ 
        success: true, 
        message: "No changes to list order"
      });
    }
    
    // Update list order
    userConfig.listOrder = order.map(String);
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();
    
    // Clear cache
    cache = new Cache();
    
    // Rebuild addon with new order
    if (!isProduction) {
      console.log("🔄 Rebuilding addon with updated order...");
    }
    await rebuildAddon();
    
    // Send success response
    res.json({ 
      success: true, 
      message: "List order updated successfully"
    });
  } catch (error) {
    if (!isProduction) {
      console.error("❌ Error updating list order:", error);
    }
    res.status(500).json({ error: 'Failed to update list order' });
  }
});

// List visibility endpoint
app.post('/api/lists/visibility', async (req, res) => {
  try {
    const { hiddenLists } = req.body;
    
    if (!Array.isArray(hiddenLists)) {
      return res.status(400).json({ error: 'Hidden lists must be an array of list IDs' });
    }
    
    // Convert arrays to Sets for efficient comparison
    const newHiddenSet = new Set(hiddenLists.map(String));
    const oldHiddenSet = new Set((userConfig.hiddenLists || []).map(String));
    
    // Check if there are actual changes
    if (newHiddenSet.size === oldHiddenSet.size && 
        [...newHiddenSet].every(id => oldHiddenSet.has(id))) {
      return res.json({ 
        success: true, 
        message: "No changes to list visibility"
      });
    }
    
    // Update hidden lists in userConfig
    userConfig.hiddenLists = [...newHiddenSet];
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();
    
    // Clear cache
    cache = new Cache();
    
    // Rebuild addon with new visibility settings
    await rebuildAddon();
    
    // Send success response
    res.json({ 
      success: true, 
      message: "List visibility updated successfully"
    });
  } catch (error) {
    if (!isProduction) {
      console.error("Error updating list visibility:", error);
    }
    res.status(500).json({ error: 'Failed to update list visibility' });
  }
});

// Force rebuild endpoint
app.post('/api/rebuild-addon', async (req, res) => {
  try {
    // Clear all caches
    cache.clear();
    
    // Create fresh addon interface directly
    const freshAddonInterface = await createAddon();
    
    if (!freshAddonInterface) {
      return res.status(500).json({ error: 'Failed to create addon interface' });
    }
    
    // Update the global addonInterface
    addonInterface = freshAddonInterface;
    
    res.json({ 
      success: true, 
      message: "Addon rebuilt successfully"
    });
  } catch (error) {
    if (!isProduction) {
      console.error("Error rebuilding addon:", error);
    }
    res.status(500).json({ error: 'Failed to rebuild addon' });
  }
});

// Add endpoint to refresh manifest after changes
app.post('/api/refresh-manifest', async (req, res) => {
  try {
    // Clear all caches
    cache.clear();
    
    // Rebuild the addon
    await rebuildAddon();
    
    res.json({ 
      success: true, 
      message: "Manifest refreshed successfully"
    });
  } catch (error) {
    if (!isProduction) {
      console.error("Error refreshing manifest:", error);
    }
    res.status(500).json({ error: 'Failed to refresh manifest' });
  }
});

// Trakt API endpoints
app.get('/api/config/trakt', (req, res) => {
  const authUrl = getTraktAuthUrl() || `${TRAKT_API_URL}/oauth/authorize?response_type=code&client_id=490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob`;
  
  const traktInfo = {
    hasAccessToken: !!userConfig.traktAccessToken,
    expiresAt: userConfig.traktExpiresAt || null,
    authUrl: authUrl
  };
  
  res.json(traktInfo);
});

// Add a simplified endpoint for direct Trakt login
app.get('/api/trakt/login', (req, res) => {
  try {
    // Use hardcoded client ID
    const clientId = '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c';
    
    // Generate the auth URL
    const authUrl = `${TRAKT_API_URL}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob`;
    
    // Redirect the user to the Trakt authorization page
    res.redirect(authUrl);
  } catch (error) {
    if (!isProduction) {
      console.error("Error in Trakt login:", error);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/config/trakt/auth', async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }
    
    // Exchange the code for access token using device code flow
    const response = await axios.post(`${TRAKT_API_URL}/oauth/token`, {
      code: code,
      client_id: '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
      grant_type: 'authorization_code',
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob'
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 200 && response.data) {
      // Save the tokens
      userConfig.traktAccessToken = response.data.access_token;
      userConfig.traktRefreshToken = response.data.refresh_token;
      
      // Calculate expiration date
      const expiresInMs = response.data.expires_in * 1000;
      const expiresAt = new Date(Date.now() + expiresInMs);
      userConfig.traktExpiresAt = expiresAt.toISOString();
      
      // Save config
      userConfig.lastUpdated = new Date().toISOString();
      saveConfig();
      
      // Rebuild addon to include Trakt lists
      await rebuildAddon();
      
      res.json({
        success: true,
        message: 'Successfully authenticated with Trakt'
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to authenticate with Trakt'
      });
    }
  } catch (error) {
    if (!isProduction) {
      console.error("Error authenticating with Trakt:", error.message);
      if (error.response) {
        console.error("Trakt API Error Response:", error.response.data);
      }
    }
    res.status(500).json({ 
      error: 'Failed to authenticate with Trakt',
      details: error.response?.data?.error_description || error.message
    });
  }
});

// Add new endpoint for updating list names
app.post('/api/lists/names', async (req, res) => {
  try {
    const { listId, customName } = req.body;
    
    if (!listId || typeof customName !== 'string') {
      return res.status(400).json({ error: 'List ID and custom name are required' });
    }
    
    // Initialize customListNames if it doesn't exist
    if (!userConfig.customListNames) {
      userConfig.customListNames = {};
    }
    
    // Update or remove custom name
    if (customName.trim()) {
      userConfig.customListNames[listId] = customName.trim();
    } else {
      // If empty name provided, remove custom name
      delete userConfig.customListNames[listId];
    }
    
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();
    
    // Clear cache and rebuild addon
    cache.clear();
    await rebuildAddon();
    
    res.json({ 
      success: true, 
      message: "List name updated successfully"
    });
  } catch (error) {
    if (!isProduction) {
      console.error("❌ Error updating list name:", error);
    }
    res.status(500).json({ error: 'Failed to update list name' });
  }
});

// Import lists from external addon
app.post('/api/import-addon', async (req, res) => {
  try {
    const { manifestUrl } = req.body;
    
    if (!manifestUrl) {
      return res.status(400).json({ error: 'Manifest URL is required' });
    }

    // Parse the URL to handle both regular URLs and stremio:// protocol
    let cleanUrl = manifestUrl;
    if (manifestUrl.startsWith('stremio://')) {
      cleanUrl = 'https://' + manifestUrl.substring(10);
    }

    if (!isProduction) {
      console.log('Fetching manifest from:', cleanUrl);
    }

    // For anime catalogs, we need to parse the URL differently
    if (cleanUrl.includes('anime-catalogs')) {
      try {
        // First fetch the manifest to get the logo
        const manifestResponse = await axios.get(cleanUrl);
        const manifestData = manifestResponse.data;
        
        // The URL itself contains the configuration as JSON
        const urlParts = cleanUrl.split('/');
        const configPart = urlParts[urlParts.length - 2]; // Second to last part
        const config = JSON.parse(decodeURIComponent(configPart));
        
        // Get the base URL
        const baseUrl = urlParts.slice(0, -2).join('/');
        
        // Create addon metadata
        const addonInfo = {
          id: 'anime-catalogs',
          name: 'Anime Catalogs',
          version: '1.0.0',
          logo: manifestData.logo || `${baseUrl}/addon-logo.png`, // Use logo from manifest or fallback
          url: cleanUrl,
          catalogs: []
        };

        // Add enabled catalogs from the config
        for (const [key, value] of Object.entries(config)) {
          if (value === 'on' && key.startsWith('myanimelist_')) {
            const name = key.split('_')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ')
              .replace('Myanimelist', 'MyAnimeList');
            
            addonInfo.catalogs.push({
              id: key,
              originalId: key,
              name: name,
              type: 'anime',
              addonLogo: addonInfo.logo // Add logo to each catalog
            });
          }
        }

        // Initialize importedAddons if needed
        if (!userConfig.importedAddons) {
          userConfig.importedAddons = {};
        }
        
        // Store addon info
        userConfig.importedAddons[addonInfo.id] = addonInfo;
        userConfig.lastUpdated = new Date().toISOString();
        saveConfig();

        // Rebuild addon
        await rebuildAddon();

        return res.json({
          success: true,
          message: `Successfully imported ${addonInfo.catalogs.length} anime catalogs`,
          addon: addonInfo
        });
      } catch (error) {
        if (!isProduction) {
          console.error('Error parsing anime catalog URL:', error);
        }
        return res.status(400).json({ 
          error: 'Invalid anime catalog URL format',
          details: error.message
        });
      }
    }

    // Regular Stremio addon manifest handling
    const response = await axios.get(cleanUrl);
    const manifest = response.data;

    if (!manifest || !manifest.catalogs) {
      return res.status(400).json({ error: 'Invalid manifest format - missing catalogs' });
    }

    // Create addon metadata
    const addonId = manifest.id || `imported_${Date.now()}`;
    const addonInfo = {
      id: addonId,
      name: manifest.name || 'Unknown Addon',
      version: manifest.version || '0.0.0',
      logo: manifest.logo || null,
      url: cleanUrl,
      catalogs: manifest.catalogs.map(catalog => ({
        id: `${addonId}_${catalog.id}`,
        originalId: catalog.id,
        name: catalog.name,
        type: catalog.type,
        addonLogo: manifest.logo // Add logo to each catalog
      }))
    };

    // Initialize importedAddons if needed
    if (!userConfig.importedAddons) {
      userConfig.importedAddons = {};
    }
    
    // Store addon info
    userConfig.importedAddons[addonId] = addonInfo;
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();

    // Rebuild addon
    await rebuildAddon();

    res.json({
      success: true,
      message: `Successfully imported ${addonInfo.catalogs.length} lists from ${addonInfo.name}`,
      addon: addonInfo
    });
  } catch (error) {
    if (!isProduction) {
      console.error('Error importing addon:', error);
    }
    res.status(500).json({ 
      error: 'Failed to import addon',
      details: error.message
    });
  }
});

// Add endpoint to remove imported addon
app.post('/api/remove-addon', async (req, res) => {
  try {
    const { addonId } = req.body;
    
    if (!addonId || !userConfig.importedAddons?.[addonId]) {
      return res.status(400).json({ error: 'Invalid addon ID' });
    }

    // Remove addon info
    delete userConfig.importedAddons[addonId];

    // Remove all lists from this addon
    userConfig.importedLists = (userConfig.importedLists || []).filter(
      list => list.addonId !== addonId
    );

    // Save config and rebuild addon
    userConfig.lastUpdated = new Date().toISOString();
    saveConfig();
    await rebuildAddon();

    res.json({
      success: true,
      message: 'Addon removed successfully'
    });
  } catch (error) {
    if (!isProduction) {
      console.error('Error removing addon:', error);
    }
    res.status(500).json({ error: 'Failed to remove addon' });
  }
});

// ==================== STREMIO ENDPOINTS ====================

app.get('/', (req, res) => {
  // Check if API key is configured
  if (!userConfig.apiKey) {
    // Redirect to configuration page with a setup parameter
    res.redirect('/configure?setup=true');
  } else {
    res.redirect('/configure');
  }
});

app.get('/configure', (req, res) => {
  // Pass setup parameter to the frontend if needed
  const setupMode = req.query.setup === 'true';
  
  // Add a small script to set a setup flag for the frontend
  if (setupMode) {
    const configPage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const configPageWithSetup = configPage.replace(
      '</head>',
      '<script>window.isFirstTimeSetup = true;</script></head>'
    );
    res.send(configPageWithSetup);
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Manual handler for catalog requests
app.get('/catalog/:catalogId/:type.json', async (req, res) => {
  const { catalogId, type } = req.params;
  const { skip = 0 } = req.query;

  try {
    // Check if this is an anime catalog request
    if (catalogId === 'anime' && userConfig.importedAddons?.['anime-catalogs']) {
      const animeAddon = userConfig.importedAddons['anime-catalogs'];
      const catalog = animeAddon.catalogs.find(c => c.id === type);
      
      if (catalog) {
        // Check if this catalog is hidden
        const catalogId = String(catalog.id);
        const hiddenLists = new Set(userConfig.hiddenLists || []);
        if (hiddenLists.has(catalogId)) {
          return res.json({ metas: [] });
        }
        
        try {
          // Remove '/manifest.json' from the URL if present
          const baseUrl = animeAddon.url.replace('/manifest.json', '');
          const catalogUrl = `${baseUrl}/catalog/anime/${catalog.id}.json`;
          
          const response = await axios.get(catalogUrl);
          if (response.data && response.data.metas) {
            // Apply pagination to the results
            const skipInt = parseInt(skip);
            const metas = response.data.metas.slice(skipInt, skipInt + 100);
            
            return res.json({
              metas: metas,
              cacheMaxAge: 3600
            });
          }
  } catch (error) {
          console.error(`Error fetching anime catalog: ${error.message}`);
          return res.status(500).json({ error: 'Failed to fetch anime catalog' });
        }
      }
    }

    // Extract the list ID - handle both aiolists and trakt prefixes
    let listId = type;
    if (type.startsWith('aiolists_') || type.startsWith('aiolists-')) {
    listId = type.substring(9);
  }
  
  // Validate the list ID format
    if (!listId.match(/^[a-zA-Z0-9_-]+$/)) {
    return res.status(400).json({ error: 'Invalid catalog ID format' });
  }

    // Check if this list is hidden - use Set for efficient lookup
    const hiddenLists = new Set((userConfig.hiddenLists || []).map(String));
    if (hiddenLists.has(String(listId))) {
    return res.json({ metas: [] });
  }

  // Check cache first
    const cacheKey = `${type}_${catalogId}_${skip}`;
  if (cache.has(cacheKey)) {
    const cachedResponse = cache.get(cacheKey);
    return res.json(cachedResponse);
  }

    // Fetch the list items
    let items;
    if (listId.startsWith('trakt_')) {
      // Only check Trakt access token for Trakt lists
      if (!userConfig.traktAccessToken) {
        return res.status(500).json({ error: 'No Trakt access token configured' });
      }
      items = await fetchTraktListItems(listId);
    } else {
      // For MDBList items, check API key
      if (!userConfig.apiKey) {
        return res.status(500).json({ error: 'No AIOLists API key configured' });
      }
      items = await fetchListItems(listId, userConfig.apiKey);
    }
    
    if (!items) {
      return res.status(500).json({ error: 'Failed to fetch list items' });
    }

    // Convert to Stremio format with pagination
    const skipInt = parseInt(skip);
    const metas = await convertToStremioFormat(items, skipInt, 5000);
    
    // Filter by type
    let filteredMetas = metas;
    if (catalogId === 'movie') {
      filteredMetas = metas.filter(item => item.type === 'movie');
    } else if (catalogId === 'series') {
      filteredMetas = metas.filter(item => item.type === 'series');
    }

    // Prepare response
    const response = {
      metas: filteredMetas,
      cacheMaxAge: 3600 * 24
    };
    
    // Set cache
    cache.set(cacheKey, response, 3600 * 24 * 1000); // Cache for 24 hours
    
    // Set cache headers
    res.setHeader('Cache-Control', `max-age=${3600 * 24}`);
    
    return res.json(response);
  } catch (error) {
    console.error(`Error processing catalog request: ${error}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// During addon initialization, we'll store list metadata for later use
function storeListsMetadata(lists) {
  if (!userConfig.listsMetadata) {
    userConfig.listsMetadata = {};
  }
  
  lists.forEach(list => {
    userConfig.listsMetadata[list.id] = {
      isExternalList: !!list.isExternalList,
      isInternalList: !!list.isInternalList,
      isWatchlist: !!list.isWatchlist,
      name: list.name
    };
  });
  
  // Save the updated config
  saveConfig();
}

// ==================== TRAKT API FUNCTIONS ====================

// Initialize Trakt API client and handle authentication
async function initTraktApi() {
  // Check if we have a valid token that's not expired
  if (userConfig.traktAccessToken && userConfig.traktExpiresAt) {
    const now = new Date();
    const expiresAt = new Date(userConfig.traktExpiresAt);
    
    if (now < expiresAt) {
      return true;
    }
    
    // Token expired, try to refresh
    if (userConfig.traktRefreshToken) {
      return refreshTraktToken();
    }
  }
  
  // No tokens or failed to refresh
  return false;
}

// Refresh a Trakt access token using the refresh token
async function refreshTraktToken() {
  try {
    // Use hardcoded client ID and secret
    const clientId = '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c';
    const clientSecret = 'your_client_secret_here'; // Replace with your actual client secret
    
    const response = await axios.post(
      `${TRAKT_API_URL}/oauth/token`,
      {
        refresh_token: userConfig.traktRefreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token'
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.status === 200 && response.data) {
      // Save the new tokens
      userConfig.traktAccessToken = response.data.access_token;
      userConfig.traktRefreshToken = response.data.refresh_token;
      
      // Calculate expiration date
      const expiresInMs = response.data.expires_in * 1000;
      const expiresAt = new Date(Date.now() + expiresInMs);
      userConfig.traktExpiresAt = expiresAt.toISOString();
      
      // Save config
      userConfig.lastUpdated = new Date().toISOString();
      saveConfig();
      
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error("Error refreshing Trakt token:", error.message);
    return false;
  }
}

// Get authentication URL for Trakt
function getTraktAuthUrl() {
  if (!userConfig.traktClientId) {
    return null;
  }
  
  return `${TRAKT_API_URL}/oauth/authorize?response_type=code&client_id=${userConfig.traktClientId}&redirect_uri=urn:ietf:wg:oauth:2.0:oob`;
}

// Fetch Trakt user lists
async function fetchTraktLists() {
  try {
    if (!userConfig.traktAccessToken) {
      return [];
    }
    
    // Ensure token is valid
    const isValid = await initTraktApi();
    if (!isValid) {
      return [];
    }
    
    // Fetch user's lists from Trakt
    const response = await axios.get(`${TRAKT_API_URL}/users/me/lists`, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
        'Authorization': `Bearer ${userConfig.traktAccessToken}`
      }
    });
    
    if (response.status !== 200) {
      return [];
    }
    
    // Transform the lists into our format
    const lists = response.data.map(list => ({
      id: `trakt_${list.ids.slug}`,
      user_id: 'trakt_user',
      name: list.name,
      updated: list.updated_at,
      listType: 'T', // T for Trakt
      isTraktList: true
    }));
    
    // Also add watchlist
    lists.push({
      id: 'trakt_watchlist',
      user_id: 'trakt_user',
      name: 'Trakt Watchlist',
      updated: new Date().toISOString(),
      isTraktWatchlist: true,
      listType: 'T'
    });
    
    // Add recommendations lists
    lists.push({
      id: 'trakt_recommendations_movies',
      user_id: 'trakt_user',
      name: 'Trakt Recommended Movies',
      updated: new Date().toISOString(),
      isTraktRecommendations: true,
      isMovieList: true,
      listType: 'T'
    });
    
    lists.push({
      id: 'trakt_recommendations_shows',
      user_id: 'trakt_user',
      name: 'Trakt Recommended Shows',
      updated: new Date().toISOString(),
      isTraktRecommendations: true,
      isShowList: true,
      listType: 'T'
    });
    
    // Add popular and trending lists
    lists.push({
      id: 'trakt_trending_movies',
      user_id: 'trakt_user',
      name: 'Trending Movies',
      updated: new Date().toISOString(),
      isTraktTrending: true,
      isMovieList: true,
      listType: 'T'
    });
    
    lists.push({
      id: 'trakt_trending_shows',
      user_id: 'trakt_user',
      name: 'Trending Shows',
      updated: new Date().toISOString(),
      isTraktTrending: true,
      isShowList: true,
      listType: 'T'
    });
    
    lists.push({
      id: 'trakt_popular_movies',
      user_id: 'trakt_user',
      name: 'Popular Movies',
      updated: new Date().toISOString(),
      isTraktPopular: true,
      isMovieList: true,
      listType: 'T'
    });
    
    lists.push({
      id: 'trakt_popular_shows',
      user_id: 'trakt_user',
      name: 'Popular Shows',
      updated: new Date().toISOString(),
      isTraktPopular: true,
      isShowList: true,
      listType: 'T'
    });
    
    return lists;
  } catch (error) {
    console.error("Error fetching Trakt lists:", error.message);
    return [];
  }
}

// Fetch items from a Trakt list
async function fetchTraktListItems(listId) {
  try {
    if (!userConfig.traktAccessToken) {
      return null;
    }
    
    // Ensure token is valid
    const isValid = await initTraktApi();
    if (!isValid) {
      return null;
    }
    
    // Handle special Trakt lists
    if (listId === 'trakt_watchlist') {
      const movies = await axios.get(`${TRAKT_API_URL}/users/me/watchlist/movies`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
          'Authorization': `Bearer ${userConfig.traktAccessToken}`
        }
      });
      
      const shows = await axios.get(`${TRAKT_API_URL}/users/me/watchlist/shows`, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
        'Authorization': `Bearer ${userConfig.traktAccessToken}`
        }
      });
      
      return {
        movies: movies.data.map(item => ({
          imdb_id: item.movie.ids.imdb,
          title: item.movie.title,
          year: item.movie.year,
          type: 'movie'
        })),
        shows: shows.data.map(item => ({
          imdb_id: item.show.ids.imdb,
          title: item.show.title,
          year: item.show.year,
          type: 'show'
        }))
      };
    }
    
    if (listId === 'trakt_trending_movies') {
      const response = await axios.get(`${TRAKT_API_URL}/movies/trending`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
        }
      });
      
      return {
        movies: response.data.map(item => ({
          imdb_id: item.movie.ids.imdb,
          title: item.movie.title,
          year: item.movie.year,
          type: 'movie'
        })),
        shows: []
      };
    }
    
    if (listId === 'trakt_trending_shows') {
      const response = await axios.get(`${TRAKT_API_URL}/shows/trending`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
        }
      });
      
      return {
        movies: [],
        shows: response.data.map(item => ({
          imdb_id: item.show.ids.imdb,
          title: item.show.title,
          year: item.show.year,
          type: 'show'
        }))
      };
    }
    
    if (listId === 'trakt_popular_movies') {
      const response = await axios.get(`${TRAKT_API_URL}/movies/popular`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
        }
      });
      
      return {
        movies: response.data.map(item => ({
          imdb_id: item.ids.imdb,
          title: item.title,
          year: item.year,
          type: 'movie'
        })),
        shows: []
      };
    }
    
    if (listId === 'trakt_popular_shows') {
      const response = await axios.get(`${TRAKT_API_URL}/shows/popular`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c'
        }
      });
      
      return {
        movies: [],
        shows: response.data.map(item => ({
          imdb_id: item.ids.imdb,
          title: item.title,
          year: item.year,
          type: 'show'
        }))
      };
    }
    
    if (listId === 'trakt_recommendations_movies') {
      const response = await axios.get(`${TRAKT_API_URL}/recommendations/movies`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
          'Authorization': `Bearer ${userConfig.traktAccessToken}`
        }
      });
      
  return {
        movies: response.data.map(item => ({
          imdb_id: item.ids.imdb,
          title: item.title,
          year: item.year,
        type: 'movie'
        })),
        shows: []
      };
    }
    
    if (listId === 'trakt_recommendations_shows') {
      const response = await axios.get(`${TRAKT_API_URL}/recommendations/shows`, {
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
          'Authorization': `Bearer ${userConfig.traktAccessToken}`
        }
      });
      
      return {
        movies: [],
        shows: response.data.map(item => ({
          imdb_id: item.ids.imdb,
          title: item.title,
          year: item.year,
        type: 'show'
        }))
      };
    }
    
    // For regular Trakt lists
    const listSlug = listId.replace('trakt_', '');
    const response = await axios.get(`${TRAKT_API_URL}/users/me/lists/${listSlug}/items`, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c',
        'Authorization': `Bearer ${userConfig.traktAccessToken}`
      }
    });
    
    return {
      movies: response.data
        .filter(item => item.type === 'movie')
        .map(item => ({
          imdb_id: item.movie.ids.imdb,
          title: item.movie.title,
          year: item.movie.year,
          type: 'movie'
        })),
      shows: response.data
        .filter(item => item.type === 'show')
        .map(item => ({
          imdb_id: item.show.ids.imdb,
          title: item.show.title,
          year: item.show.year,
          type: 'show'
        }))
    };
  } catch (error) {
    console.error(`Error fetching Trakt list ${listId}:`, error.message);
    return null;
  }
}

// ==================== START SERVER ====================

// Initialize the addon and start the server
loadConfig();
createAddon()
  .then((interface) => {
    addonInterface = interface;
    
    // No need to create a new app here since we already created it at the top
    
    app.listen(PORT, () => {
      if (!isProduction) {
        console.log(`AIOLists Stremio Addon running on port ${PORT}`);
        console.log(`Addon URL: http://localhost:${PORT}/manifest.json`);
        console.log(`Admin panel: http://localhost:${PORT}/configure`);
      }
    });
  })
  .catch(err => {
    if (!isProduction) {
      console.error("Failed to initialize addon:", err);
    }
  });