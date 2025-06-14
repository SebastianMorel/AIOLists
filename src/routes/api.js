// src/routes/api.js
const path = require('path');
const { defaultConfig, staticGenres, TMDB_BEARER_TOKEN, TMDB_REDIRECT_URI, TRAKT_REDIRECT_URI } = require('../config');
const { compressConfig, decompressConfig, compressShareableConfig, createShareableConfig } = require('../utils/urlConfig');
const { createAddon, fetchListContent } = require('../addon/addonBuilder');
const { convertToStremioFormat } = require('../addon/converters');
const { setCacheHeaders, isWatchlist: commonIsWatchlist } = require('../utils/common');
const Cache = require('../utils/cache');
const { validateRPDBKey } = require('../utils/posters');
const { validateTMDBKey } = require('../integrations/tmdb');
const { initTraktApi, authenticateTrakt, getTraktAuthUrl, fetchTraktLists, fetchPublicTraktListDetails, validateTraktApi } = require('../integrations/trakt');
const { fetchAllLists: fetchAllMDBLists, validateMDBListKey, extractListFromUrl: extractMDBListFromUrl } = require('../integrations/mdblist');
const { importExternalAddon: importExtAddon } = require('../integrations/externalAddons');
const { saveTraktTokens } = require('../utils/remoteStorage');

const manifestCache = new Cache({ defaultTTL: 1 * 60 * 1000 });

// Helper function to create a config copy for storage that excludes sensitive Trakt tokens when using Upstash
function createConfigForStorage(userConfig) {
  console.log('[CONFIG] Creating config for storage');
  const configForStorage = { ...userConfig };
  
  // Only exclude Trakt tokens from storage if Upstash is configured and we have a traktUuid
  // This ensures tokens can be retrieved from Upstash when needed
  if (configForStorage.upstashUrl && configForStorage.traktUuid) {
    configForStorage.traktAccessToken = null;
    configForStorage.traktRefreshToken = null;
    configForStorage.traktExpiresAt = null;
  }
  
  return configForStorage;
}

// Helper function to update config without rebuilding manifest
async function updateConfigLightweight(userConfig, changes, changeDescription) {
  console.log(`[CONFIG] Lightweight update: ${changeDescription}`);
  console.log(`[CONFIG] Changes applied:`, Object.keys(changes));
  
  // Apply changes to user config
  Object.assign(userConfig, changes);
  userConfig.lastUpdated = new Date().toISOString();
  
  // Generate new config hash
  const newConfigHash = await compressConfig(userConfig);
  console.log(`[CONFIG] Generated new config hash: ${newConfigHash.substring(0, 20)}...`);
  
  return newConfigHash;
}

// Helper function to clear manifest cache and log it
function clearManifestCache(reason) {
  console.log(`[MANIFEST] Clearing manifest cache due to: ${reason}`);
  manifestCache.clear();
}

function purgeListConfigs(userConfig, listIdPrefixOrExactId, isExactId = false) {
  const idsToRemove = new Set();

  if (isExactId) {
      idsToRemove.add(String(listIdPrefixOrExactId));
  }

  if (userConfig.customListNames) {
      for (const key in userConfig.customListNames) {
          if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_') )) {
              idsToRemove.add(key);
              delete userConfig.customListNames[key];
          }
      }
  }
  // Also purge customMediaTypeNames
  if (userConfig.customMediaTypeNames) {
    for (const key in userConfig.customMediaTypeNames) {
        if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_'))) {
            idsToRemove.add(key);
            delete userConfig.customMediaTypeNames[key];
        }
    }
  }


  if (userConfig.sortPreferences) {
      for (const key in userConfig.sortPreferences) {
          if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_'))) {
              idsToRemove.add(key);
              delete userConfig.sortPreferences[key];
          }
      }
  }
  if (userConfig.mergedLists) {
      for (const key in userConfig.mergedLists) {
          if ((isExactId && key === listIdPrefixOrExactId) || (!isExactId && key.startsWith(listIdPrefixOrExactId) && !key.startsWith('traktpublic_'))) {
              idsToRemove.add(key);
              delete userConfig.mergedLists[key];
          }
      }
  }

  const filterCondition = (id) => {
      const idStr = String(id);
      if (isExactId) return idStr === listIdPrefixOrExactId;
      if (listIdPrefixOrExactId === 'trakt_') return idStr.startsWith('trakt_') && !idStr.startsWith('traktpublic_');
      if (listIdPrefixOrExactId === 'random_mdblist_catalog' && idStr === 'random_mdblist_catalog') return true;
      return idStr.startsWith(listIdPrefixOrExactId);
  };

  if (userConfig.listOrder) {
      userConfig.listOrder = userConfig.listOrder.filter(id => {
          if (filterCondition(id)) { idsToRemove.add(String(id)); return false; }
          return true;
      });
  }
  if (userConfig.hiddenLists) {
      userConfig.hiddenLists = userConfig.hiddenLists.filter(id => {
          if (filterCondition(id)) { idsToRemove.add(String(id)); return false; }
          return true;
      });
  }
  if (userConfig.removedLists) {
      userConfig.removedLists = userConfig.removedLists.filter(id => {
          if (filterCondition(id)) { idsToRemove.add(String(id)); return false; }
          return true;
      });
  }
  return idsToRemove;
}


module.exports = function(router) {
  router.param('configHash', async (req, res, next, configHash) => {
    try {
      req.userConfig = await decompressConfig(configHash);
      req.configHash = configHash;
      
      // Ensure new search features are available for existing configurations
      const { defaultConfig } = require('../config');
      if (typeof req.userConfig.mergedSearchSources === 'undefined') {
        req.userConfig.mergedSearchSources = defaultConfig.mergedSearchSources;
      }
      if (typeof req.userConfig.animeSearchEnabled === 'undefined') {
        req.userConfig.animeSearchEnabled = defaultConfig.animeSearchEnabled;
      }
      if (typeof req.userConfig.searchSources === 'undefined') {
        req.userConfig.searchSources = defaultConfig.searchSources;
      }
      
      // If Upstash is configured and we have a traktUuid, try to load Trakt tokens before determining shared status
      if (req.userConfig.upstashUrl && req.userConfig.traktUuid && !req.userConfig.traktAccessToken) {
        try {
          await initTraktApi(req.userConfig);
        } catch (error) {
          console.warn('Failed to load Trakt tokens from Upstash during config param processing:', error.message);
        }
      }
      
      req.isPotentiallySharedConfig = (!req.userConfig.apiKey && Object.values(req.userConfig.importedAddons || {}).some(addon => addon.isMDBListUrlImport)) ||
                                     (!req.userConfig.traktAccessToken && Object.values(req.userConfig.importedAddons || {}).some(addon => addon.isTraktPublicList)) ||
                                     (!req.userConfig.traktAccessToken && (req.userConfig.listOrder || []).some(id => id.startsWith('trakt_') && !id.startsWith('traktpublic_')));
      next();
    } catch (error) {
      console.error('Error decompressing configHash:', configHash, error);
      if (!res.headersSent) { return res.redirect('/configure'); }
      next(error);
    }
  });

  router.get('/:configHash/shareable-hash', async (req, res) => {
    try {
        const shareableHash = await compressShareableConfig(req.userConfig);
        res.json({ success: true, shareableHash: shareableHash });
    } catch (error) {
        console.error('Error creating shareable config hash:', error);
        res.status(500).json({ success: false, error: 'Failed to create shareable configuration hash' });
    }
  });

  router.post('/:configHash/config/genre-filter', async (req, res) => {
    try {
      const { disableGenreFilter } = req.body;
      if (typeof disableGenreFilter !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Invalid value for disableGenreFilter. Must be boolean.' });
      }

      req.userConfig.disableGenreFilter = disableGenreFilter;
      req.userConfig.lastUpdated = new Date().toISOString();

      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash });
    } catch (error) {
      console.error('Error updating genre filter setting:', error);
      res.status(500).json({ success: false, error: 'Failed to update genre filter setting' });
    }
  });

  router.post('/:configHash/config/random-list-feature', async (req, res) => {
    try {
      const { enable, randomMDBListUsernames } = req.body; // Added randomMDBListUsernames
      if (typeof enable !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Invalid value for enable. Must be boolean.' });
      }
      if (enable && !req.userConfig.apiKey) {
        return res.status(400).json({ success: false, error: 'MDBList API Key is required to enable this feature.' });
      }

      req.userConfig.enableRandomListFeature = enable;

      // Update randomMDBListUsernames if provided and valid
      if (randomMDBListUsernames !== undefined) {
        if (Array.isArray(randomMDBListUsernames) && randomMDBListUsernames.every(u => typeof u === 'string')) {
            req.userConfig.randomMDBListUsernames = randomMDBListUsernames.map(u => u.trim()).filter(u => u.length > 0);
            if (req.userConfig.randomMDBListUsernames.length === 0 && defaultConfig.randomMDBListUsernames.length > 0) {
                // If user clears all, revert to default non-empty list to prevent issues
                req.userConfig.randomMDBListUsernames = [...defaultConfig.randomMDBListUsernames];
                 console.warn("Random MDBList usernames cleared by user, reverting to internal default to ensure functionality.");
            }
        } else {
            return res.status(400).json({ success: false, error: 'Invalid format for randomMDBListUsernames. Must be an array of strings.' });
        }
      }

      req.userConfig.lastUpdated = new Date().toISOString();

      if (!enable) {
        if (req.userConfig.listOrder) {
            req.userConfig.listOrder = req.userConfig.listOrder.filter(id => id !== 'random_mdblist_catalog');
        }
        if (req.userConfig.hiddenLists) {
            req.userConfig.hiddenLists = req.userConfig.hiddenLists.filter(id => id !== 'random_mdblist_catalog');
        }
      }

      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      // Send back the potentially updated list of usernames
      res.json({ success: true, configHash: newConfigHash, randomMDBListUsernames: req.userConfig.randomMDBListUsernames });
    } catch (error)
    {
      console.error('Error updating random list feature setting:', error);
      res.status(500).json({ success: false, error: 'Failed to update random list feature setting' });
    }
  });

  router.post('/:configHash/config/metadata', async (req, res) => {
    try {
      const { metadataSource, tmdbLanguage } = req.body;
      
      if (metadataSource && !['cinemeta', 'tmdb'].includes(metadataSource)) {
        return res.status(400).json({ success: false, error: 'Invalid metadata source. Must be "cinemeta" or "tmdb".' });
      }
      
      if (metadataSource === 'tmdb' && !req.userConfig.tmdbSessionId && !req.userConfig.tmdbBearerToken && !process.env.TMDB_BEARER_TOKEN) {
        return res.status(400).json({ 
          error: 'TMDB metadata source requires either OAuth connection or a TMDB Bearer Token. Please connect your TMDB account or provide a Bearer Token.' 
        });
      }

      // Check if language is changing to clear TMDB cache
      const currentLanguage = req.userConfig.tmdbLanguage;
      const languageChanged = tmdbLanguage && currentLanguage && tmdbLanguage !== currentLanguage;

      if (metadataSource) {
        req.userConfig.metadataSource = metadataSource;
      }
      
      if (tmdbLanguage && typeof tmdbLanguage === 'string') {
        req.userConfig.tmdbLanguage = tmdbLanguage;
      }

      // Clear TMDB cache if language changed
      if (languageChanged) {
        const { clearTmdbCaches } = require('../integrations/tmdb');
        clearTmdbCaches();
        console.log(`Cleared TMDB cache due to language change from ${currentLanguage} to ${tmdbLanguage}`);
      }

      req.userConfig.lastUpdated = new Date().toISOString();

      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash });
    } catch (error) {
      console.error('Error updating metadata settings:', error);
      res.status(500).json({ success: false, error: 'Failed to update metadata settings' });
    }
  });

  router.post('/:configHash/config', async (req, res) => {
    try {
      const { searchSources, mergedSearchSources, animeSearchEnabled } = req.body;
      
      // Handle traditional search sources
      if (searchSources && Array.isArray(searchSources)) {
        // Temporarily disable 'multi' search option
        const validSources = searchSources.filter(s => ['cinemeta', 'trakt', 'tmdb'].includes(s));
        req.userConfig.searchSources = validSources;
      }

      // Handle merged search sources
      if (mergedSearchSources && Array.isArray(mergedSearchSources)) {
        const validMergedSources = mergedSearchSources.filter(s => ['tmdb'].includes(s));
        req.userConfig.mergedSearchSources = validMergedSources;
      }

      // Handle anime search enabled
      if (typeof animeSearchEnabled === 'boolean') {
        req.userConfig.animeSearchEnabled = animeSearchEnabled;
      }

      req.userConfig.lastUpdated = new Date().toISOString();

      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, newConfigHash: newConfigHash });
    } catch (error) {
      console.error('Error updating config:', error);
      res.status(500).json({ success: false, error: 'Failed to update config' });
    }
  });

  router.get('/:configHash/configure', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
  });

  // New endpoint to prepare manifest for Install/Copy actions
  router.post('/:configHash/prepare-manifest', async (req, res) => {
    try {
      console.log('[MANIFEST] Preparing manifest for Install/Copy action');
      console.log('[MANIFEST] Starting full manifest generation with list fetching');
      
      const cacheKey = `manifest_${req.configHash}`;
      manifestCache.delete(cacheKey); // Force fresh generation
      
      const startTime = Date.now();
      const addonInterface = await createAddon(req.userConfig);
      const endTime = Date.now();
      
      console.log(`[MANIFEST] Manifest generation completed in ${endTime - startTime}ms`);
      console.log(`[MANIFEST] Generated manifest with ${addonInterface.manifest.catalogs.length} catalogs`);
      
      manifestCache.set(cacheKey, addonInterface);
      
      res.json({ 
        success: true, 
        manifest: addonInterface.manifest,
        generationTime: endTime - startTime,
        catalogCount: addonInterface.manifest.catalogs.length
      });
    } catch (error) {
      console.error('[MANIFEST] Error preparing manifest:', error);
      res.status(500).json({ error: 'Failed to prepare manifest', details: error.message });
    }
  });

  router.get('/:configHash/manifest.json', async (req, res) => {
    try {
      console.log('[MANIFEST] Serving manifest.json');
      const cacheKey = `manifest_${req.configHash}`;
      let addonInterface = manifestCache.get(cacheKey);
      if (!addonInterface) {
        console.log('[MANIFEST] No cached manifest found, generating new one');
        const startTime = Date.now();
        addonInterface = await createAddon(req.userConfig);
        const endTime = Date.now();
        console.log(`[MANIFEST] Fresh manifest generated in ${endTime - startTime}ms`);
        manifestCache.set(cacheKey, addonInterface);
      } else {
        console.log('[MANIFEST] Serving cached manifest');
      }
      setCacheHeaders(res, null);
      res.json(addonInterface.manifest);
    } catch (error) {
      console.error('[MANIFEST] Error serving manifest:', error);
      res.status(500).json({ error: 'Failed to serve manifest' });
    }
  });

  router.get('/:configHash/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
      const { type: catalogType, id: catalogId } = req.params;
      const extraParamsString = req.params.extra;
      let skip = parseInt(req.query.skip);
      let genre = req.query.genre;
  
      if (isNaN(skip) && extraParamsString) {
        const skipMatch = extraParamsString.match(/skip=(\d+)/);
        if (skipMatch) skip = parseInt(skipMatch[1]);
      }
      if (!genre && extraParamsString) {
        const genreMatch = extraParamsString.match(/genre=([^&]+)/);
        if (genreMatch) genre = decodeURIComponent(genreMatch[1]);
      }

      if (genre === 'All') {
        genre = null;
      }
  
      skip = isNaN(skip) ? 0 : skip;
      genre = genre || null;
  
      // Handle search catalogs specially  
      if (catalogId === 'aiolists_search_movies' || catalogId === 'aiolists_search_series' || catalogId === 'aiolists_merged_search' || catalogId === 'aiolists_anime_search') {
        let searchQuery = req.query.search;
        
        // Extract search query from extra params if not in query string
        if (!searchQuery && extraParamsString) {
          const searchMatch = extraParamsString.match(/search=([^&]+)/);
          if (searchMatch) {
            searchQuery = decodeURIComponent(searchMatch[1]);
          }
        }
        
        if (!searchQuery || searchQuery.trim().length < 2) {
          return res.json({ metas: [] });
        }

        try {
          const { searchContent } = require('../utils/searchEngine');
          let searchResults;

          if (catalogId === 'aiolists_merged_search') {
            // Merged search using TMDB multi search
            console.log(`[API Search] Handling merged search for "${searchQuery}"`);
            
            searchResults = await searchContent({
              query: searchQuery.trim(),
              type: 'search', // Use search type for merged search
              sources: ['multi'], // Use multi source for merged search
              limit: 50,
              userConfig: req.userConfig
            });
          } else if (catalogId === 'aiolists_anime_search') {
            // Anime search using Kitsu API
            console.log(`[API Search] Handling anime search for "${searchQuery}"`);
            
            searchResults = await searchContent({
              query: searchQuery.trim(),
              type: 'anime', // Use anime type for anime search
              sources: ['anime'], // Use anime source for anime search
              limit: 50,
              userConfig: req.userConfig
            });
          } else {
            // Traditional movie/series search
            console.log(`[API Search] Handling traditional search for "${searchQuery}"`);
            
            // Determine search sources based on user configuration
            const userSearchSources = req.userConfig.searchSources || [];
            let sources = [];
            
            // Individual search sources mode (multi search is disabled)
            if (userSearchSources.includes('cinemeta')) {
              sources.push('cinemeta');
            }
            if (userSearchSources.includes('trakt')) {
              sources.push('trakt');
            }
            if (userSearchSources.includes('tmdb') && (req.userConfig.tmdbBearerToken || req.userConfig.tmdbSessionId)) {
              sources.push('tmdb');
            }
            
            // If no valid sources are configured, return empty results
            if (sources.length === 0) {
              console.log(`[API Search] No valid search sources configured, returning empty results`);
              return res.json({ metas: [] });
            }
            
            // Use the catalog type for search
            const searchType = catalogType || 'all';
            
            searchResults = await searchContent({
              query: searchQuery.trim(),
              type: searchType,
              sources: sources,
              limit: 50,
              userConfig: req.userConfig
            });
          }

          // Filter results by type and genre if specified
          let filteredMetas = searchResults.results || [];
          
          // Filter by type if specified (only for traditional search)
          if (catalogId === 'aiolists_search' && catalogType && catalogType !== 'all' && catalogType !== 'search') {
            filteredMetas = filteredMetas.filter(result => result.type === catalogType);
          }

          // Filter by genre if specified
          if (genre && genre !== 'All') {
            const beforeFilter = filteredMetas.length;
            filteredMetas = filteredMetas.filter(result => {
              if (!result.genres) return false;
              const itemGenres = Array.isArray(result.genres) ? result.genres : [result.genres];
              return itemGenres.some(g => 
                String(g).toLowerCase() === String(genre).toLowerCase()
              );
            });
            console.log(`[API Search] Genre filter "${genre}": ${beforeFilter} -> ${filteredMetas.length} results`);
          }

          return res.json({ 
            metas: filteredMetas,
            cacheMaxAge: 300 // 5 minutes cache for search results
          });

        } catch (error) {
          console.error(`[API Search] Error in search catalog "${catalogId}" for "${searchQuery}":`, error);
          return res.json({ metas: [] });
        }
      }

      const listSource = catalogId === 'random_mdblist_catalog' ? 'random_mdblist' :
                         catalogId.startsWith('aiolists-') ? 'mdblist_native' :
                         catalogId.startsWith('trakt_') && !catalogId.startsWith('traktpublic_') ? 'trakt_native' :
                         catalogId.startsWith('mdblisturl_') ? 'mdblist_url' :
                         catalogId.startsWith('traktpublic_') ? 'trakt_public' :
                         'external_addon';
  
      if (listSource === 'trakt_native') {
        await initTraktApi(req.userConfig);
      }

      // Check for MDBList API key requirements
      if ((listSource === 'mdblist_native' || listSource === 'random_mdblist') && !req.userConfig.apiKey) {
          return res.json({ metas: [] });
      }
      
      // Special handling for MDBList URL imports - allow if they have public access info
      if (listSource === 'mdblist_url' && !req.userConfig.apiKey) {
          const addonConfig = req.userConfig.importedAddons?.[catalogId];
          const hasPublicAccess = addonConfig && addonConfig.mdblistUsername && addonConfig.mdblistSlug;
          if (!hasPublicAccess) {
              return res.json({ metas: [] });
          }
      }
      if (listSource === 'trakt_native' && !req.userConfig.traktAccessToken) {
          return res.json({ metas: [] });
      }
  
      if (catalogId === 'random_mdblist_catalog' || commonIsWatchlist(catalogId)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else {
        setCacheHeaders(res, catalogId);
      }
  
      const itemsResult = await fetchListContent(catalogId, req.userConfig, skip, genre, catalogType);
  
      if (!itemsResult) {
        return res.json({ metas: [] });
      }

      // Enrich items with metadata based on user's metadata source preference
      let enrichedResult = itemsResult;
      if (itemsResult.allItems && itemsResult.allItems.length > 0) {
        const metadataSource = req.userConfig.metadataSource || 'cinemeta';
        const hasTmdbOAuth = !!(req.userConfig.tmdbSessionId && req.userConfig.tmdbAccountId);
        const tmdbLanguage = req.userConfig.tmdbLanguage || 'en-US';
        const tmdbBearerToken = req.userConfig.tmdbBearerToken;
        
        const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');
        const enrichedItems = await enrichItemsWithMetadata(
          itemsResult.allItems, 
          metadataSource, 
          hasTmdbOAuth, 
          tmdbLanguage, 
          tmdbBearerToken
        );
        
        // Update the items result with enriched items
        enrichedResult = {
          ...itemsResult,
          allItems: enrichedItems
        };
      }
  
      // Create metadata config for converter
      const metadataConfig = {
        metadataSource: req.userConfig.metadataSource || 'cinemeta',
        tmdbLanguage: req.userConfig.tmdbLanguage || 'en-US'
      };

      let metas = await convertToStremioFormat(enrichedResult, req.userConfig.rpdbApiKey, metadataConfig);  
      
      // Apply type filtering
      if (catalogType === 'movie' || catalogType === 'series') {
          metas = metas.filter(meta => meta.type === catalogType);
      }
      
      // Apply genre filtering after enrichment (since we removed it from integration layer)
      if (genre && genre !== 'All' && metas.length > 0) {
          const beforeFilterCount = metas.length;
          metas = metas.filter(meta => {
              if (!meta.genres) return false;
              const itemGenres = Array.isArray(meta.genres) ? meta.genres : [meta.genres];
              return itemGenres.some(g => 
                  String(g).toLowerCase() === String(genre).toLowerCase()
              );
          });
          console.log(`[API] Genre filter "${genre}": ${beforeFilterCount} -> ${metas.length} items after enrichment`);
      }
      
      res.json({ metas });
    } catch (error) {
      console.error(`Error in catalog endpoint (/catalog/${req.params.type}/${req.params.id}):`, error);
      res.status(500).json({ error: 'Internal server error in catalog handler' });
    }
  });

  router.get('/:configHash/meta/:type/:id.json', async (req, res) => {
    try {
      const { type, id } = req.params;
      
      // Support both IMDB IDs (tt) and TMDB IDs (tmdb:)
      if (!id.startsWith('tt') && !id.startsWith('tmdb:')) {
        return res.status(404).json({ meta: null });
      }

      // Set cache headers - meta data can be cached longer since it doesn't change often
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
      
      // Handle TMDB IDs with enhanced metadata fetching
      if (id.startsWith('tmdb:')) {
        const tmdbId = id.replace('tmdb:', '');
        const metadataSource = req.userConfig.metadataSource || 'cinemeta';
        const hasTmdbOAuth = !!(req.userConfig.tmdbSessionId && req.userConfig.tmdbAccountId);
        const tmdbLanguage = req.userConfig.tmdbLanguage || 'en-US';
        const tmdbBearerToken = req.userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN;
        
        if (metadataSource === 'tmdb' && tmdbBearerToken) {
          try {
            const { fetchTmdbMetadata } = require('../integrations/tmdb');
            const tmdbMeta = await fetchTmdbMetadata(tmdbId, type, tmdbLanguage, tmdbBearerToken);
            
            if (tmdbMeta) {
              // Ensure the ID matches the request
              tmdbMeta.id = id;
              return res.json({ meta: tmdbMeta });
            }
          } catch (tmdbError) {
            console.error(`TMDB metadata fetch failed for ${id}:`, tmdbError.message);
          }
        }
        
        // Fallback for TMDB IDs - try to convert to IMDB and use that
        try {
          const { convertImdbToTmdbId } = require('../integrations/tmdb');
          // This is a bit backwards, but we need to find the IMDB ID for this TMDB ID
          // For now, return a basic meta object
          return res.json({ 
            meta: { 
              id, 
              type, 
              name: `TMDB ID ${tmdbId}`,
              description: "TMDB metadata temporarily unavailable"
            } 
          });
        } catch (error) {
          console.error(`Error handling TMDB ID ${id}:`, error.message);
        }
      }
      
      // Handle IMDB IDs with existing enrichment
      if (id.startsWith('tt')) {
        const itemForEnrichment = [{
          id: id,
          imdb_id: id,
          type: type,
          title: "Loading...",
          name: "Loading..."
        }];
        
        const metadataSource = req.userConfig.metadataSource || 'cinemeta';
        const hasTmdbOAuth = !!(req.userConfig.tmdbSessionId && req.userConfig.tmdbAccountId);
        const tmdbLanguage = req.userConfig.tmdbLanguage || 'en-US';
        const tmdbBearerToken = req.userConfig.tmdbBearerToken;
        
        const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');
        const enrichedItems = await enrichItemsWithMetadata(itemForEnrichment, metadataSource, hasTmdbOAuth, tmdbLanguage, tmdbBearerToken);
        
        if (enrichedItems && enrichedItems.length > 0) {
          const enrichedItem = enrichedItems[0];
          
          const meta = {
            id: id,
            type: type,
            name: enrichedItem.name || enrichedItem.title || "Unknown Title",
            poster: enrichedItem.poster,
            background: enrichedItem.background || enrichedItem.backdrop,
            description: enrichedItem.description || enrichedItem.overview,
            releaseInfo: enrichedItem.releaseInfo || enrichedItem.year,
            imdbRating: enrichedItem.imdbRating,
            runtime: enrichedItem.runtime,
            genres: enrichedItem.genres,
            cast: enrichedItem.cast,
            director: enrichedItem.director,
            writer: enrichedItem.writer,
            country: enrichedItem.country,
            trailers: enrichedItem.trailers,
            status: type === 'series' ? enrichedItem.status : undefined,
            videos: enrichedItem.videos
          };
          
          Object.keys(meta).forEach(key => meta[key] === undefined && delete meta[key]);
          return res.json({ meta });
        }
      }
      
      // Fallback if addon meta handler fails
      return res.json({ 
        meta: { 
          id, 
          type, 
          name: "Details unavailable" 
        } 
      });
      
    } catch (error) {
      console.error(`Error in meta endpoint for ${req.params.id}:`, error);
      return res.status(500).json({ 
        meta: { 
          id: req.params.id, 
          type: req.params.type, 
          name: "Error loading details" 
        } 
      });
    }
  });
  
  router.get('/:configHash/config', (req, res) => {
    const configToSend = JSON.parse(JSON.stringify(req.userConfig));
    
    // Always remove tmdbBearerToken if it's available from environment
    if (TMDB_BEARER_TOKEN) {
      delete configToSend.tmdbBearerToken;
    }
    
    // Only remove sensitive data if this is a potentially shared config
    if (req.isPotentiallySharedConfig) {
      delete configToSend.apiKey;
      delete configToSend.rpdbApiKey;
      delete configToSend.tmdbBearerToken;
      delete configToSend.tmdbSessionId;
      delete configToSend.tmdbAccountId;
      delete configToSend.traktAccessToken;
      delete configToSend.traktRefreshToken;
      delete configToSend.traktExpiresAt;
      delete configToSend.traktUuid;
      delete configToSend.upstashUrl;
      delete configToSend.upstashToken;
    }
    
    // Remove internal sort options that shouldn't be exposed
    delete configToSend.availableSortOptions;
    delete configToSend.traktSortOptions;
    
    // Clean up arrays
    configToSend.hiddenLists = Array.from(new Set(configToSend.hiddenLists || []));
    configToSend.removedLists = Array.from(new Set(configToSend.removedLists || []));
    configToSend.customMediaTypeNames = configToSend.customMediaTypeNames || {};
    
    // Add connection status flags (non-sensitive)
    configToSend.isConnected = {
      mdblist: !!req.userConfig.apiKey,
      rpdb: !!req.userConfig.rpdbApiKey,
      tmdb: !!(req.userConfig.tmdbSessionId && req.userConfig.tmdbAccountId),
      trakt: !!req.userConfig.traktAccessToken,
      upstash: !!(req.userConfig.upstashUrl && req.userConfig.upstashToken)
    };
    
    res.json({ 
      success: true, 
      config: configToSend,
      isPotentiallySharedConfig: req.isPotentiallySharedConfig || false,
      isDbConnected: false,
      env: {
        hasTmdbBearerToken: !!TMDB_BEARER_TOKEN,
        hasTmdbRedirectUri: !!TMDB_REDIRECT_URI,
        hasTraktRedirectUri: !!TRAKT_REDIRECT_URI
      }
    });
  });

  router.post('/:configHash/apikey', async (req, res) => {
    try {
          const { apiKey, rpdbApiKey } = req.body;
    let configChanged = false;

    const newApiKey = apiKey || '';
    const newRpdbApiKey = rpdbApiKey || '';

    if (req.userConfig.rpdbApiKey !== newRpdbApiKey) {
      req.userConfig.rpdbApiKey = newRpdbApiKey;
      configChanged = true;
    }

      if (req.userConfig.apiKey !== newApiKey) {
        configChanged = true;
        if (newApiKey === '') {
            req.userConfig.apiKey = '';
            if (req.userConfig.mdblistUsername) delete req.userConfig.mdblistUsername;
            req.userConfig.enableRandomListFeature = false;
            purgeListConfigs(req.userConfig, 'aiolists-');
            purgeListConfigs(req.userConfig, 'random_mdblist_catalog', true);
            if (req.userConfig.importedAddons) {
                for (const addonKey in req.userConfig.importedAddons) {
                    const addon = req.userConfig.importedAddons[addonKey];
                    if (addon?.isMDBListUrlImport) {
                        // Only remove URL imports that don't have public access information
                        const hasPublicAccess = addon.mdblistUsername && addon.mdblistSlug;
                        if (!hasPublicAccess) {
                            purgeListConfigs(req.userConfig, addonKey, true);
                            delete req.userConfig.importedAddons[addonKey];
                        }
                    }
                }
            }
        } else {
            req.userConfig.apiKey = newApiKey;
        }
      }

      if (configChanged) {
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(createConfigForStorage(req.userConfig));
        manifestCache.clear();
        return res.json({ success: true, configHash: newConfigHash });
      }
      return res.json({ success: true, configHash: req.configHash, message: "API keys processed" });
    } catch (error) {
      console.error('Error in /apikey:', error);
      res.status(500).json({ error: 'Internal server error in /apikey' });
    }
  });

  router.post('/:configHash/upstash', async (req, res) => {
    try {
        const { upstashUrl, upstashToken } = req.body;

        req.userConfig.upstashUrl = upstashUrl || '';
        req.userConfig.upstashToken = upstashToken || '';

        // Save Trakt tokens to Upstash but keep them in the active session
        if (upstashUrl && upstashToken && req.userConfig.traktAccessToken && req.userConfig.traktUuid) {
            const tokensToSave = {
                accessToken: req.userConfig.traktAccessToken,
                refreshToken: req.userConfig.traktRefreshToken,
                expiresAt: req.userConfig.traktExpiresAt
            };
            await saveTraktTokens(req.userConfig, tokensToSave);
            // Don't remove Trakt tokens from the active session - they'll be removed only from storage
            
            // Immediately verify that tokens are accessible from Upstash
            await initTraktApi(req.userConfig);
        }
        
        req.userConfig.lastUpdated = new Date().toISOString();
        
        const newConfigHash = await compressConfig(createConfigForStorage(req.userConfig));
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash });
    } catch (error) {
        console.error('Error in /upstash:', error);
        res.status(500).json({ error: 'Internal server error in /upstash' });
    }
  });

  router.post('/:configHash/trakt/auth', async (req, res) => {
    try {
      const configHash = req.params.configHash;
      const { code } = req.body;
      
      console.log(`[Trakt Auth] Attempting authentication with code: ${code ? 'present' : 'missing'}`);
      
      if (!configHash) {
        return res.status(400).json({ error: 'Config hash is required' });
      }
      
      if (!code) {
        return res.status(400).json({ error: 'Authorization code is required' });
      }
      
      // Decompress and get user config
      const userConfig = await decompressConfig(configHash);
      if (!userConfig) {
        return res.status(400).json({ error: 'Invalid config hash' });
      }
      
      console.log(`[Trakt Auth] Config decompressed successfully`);
      
      // Complete Trakt authentication
      const authResult = await authenticateTrakt(code, userConfig);
      
      console.log(`[Trakt Auth] Authentication result:`, {
        hasAccessToken: !!authResult?.accessToken,
        hasRefreshToken: !!authResult?.refreshToken,
        hasUuid: !!authResult?.uuid,
        expiresAt: authResult?.expiresAt
      });
      
      // authenticateTrakt returns the auth data directly or throws an error
      if (!authResult || !authResult.accessToken) {
        console.error(`[Trakt Auth] Authentication failed - no access token received`);
        return res.status(400).json({ error: 'Trakt authentication failed - no access token received' });
      }
      
      // Update userConfig with new tokens
      userConfig.traktAccessToken = authResult.accessToken;
      userConfig.traktRefreshToken = authResult.refreshToken;
      userConfig.traktExpiresAt = authResult.expiresAt;
      if (authResult.uuid) {
        userConfig.traktUuid = authResult.uuid;
      }
      
      console.log(`[Trakt Auth] User config updated with tokens`);
      
      // Compress and return new config hash
      const newConfigHash = await compressConfig(userConfig);
      
      console.log(`[Trakt Auth] New config hash generated: ${newConfigHash ? 'success' : 'failed'}`);
      
      res.json({
        success: true,
        configHash: newConfigHash,
        message: 'Successfully connected to Trakt!',
        uuid: authResult.uuid
      });
      
    } catch (error) {
      console.error('Error in Trakt OAuth callback:', error);
      res.status(500).json({ error: `Internal server error during Trakt authentication: ${error.message}` });
    }
  });
  
  // Trakt callback redirect handler (for when user is redirected back from Trakt)
  router.get('/trakt/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      
      if (!code) {
        return res.status(400).send('Authorization code not provided');
      }
      
      if (!state) {
        return res.status(400).send('State parameter not provided');
      }
      
      // Decode state to get config hash
      let stateObject;
      try {
        stateObject = JSON.parse(Buffer.from(state, 'base64').toString());
      } catch (error) {
        return res.status(400).send('Invalid state parameter');
      }
      
      const configHash = stateObject.configHash;
      if (!configHash) {
        return res.status(400).send('Config hash not found in state');
      }
      
      // Redirect back to configure page with the code and state
      const redirectUrl = `/${configHash}/configure?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      res.redirect(redirectUrl);
      
    } catch (error) {
      console.error('Error in Trakt callback redirect:', error);
      res.status(500).send('Internal server error during Trakt callback');
    }
  });

  router.post('/:configHash/trakt/disconnect', async (req, res) => {
    try {
        req.userConfig.traktUuid = null;
        req.userConfig.traktAccessToken = null;
        req.userConfig.traktRefreshToken = null;
        req.userConfig.traktExpiresAt = null;

        // Purge Trakt-related list configurations and metadata
        purgeListConfigs(req.userConfig, 'trakt_');
        
        // Clean up list order entries for Trakt lists
        if (req.userConfig.listOrder && Array.isArray(req.userConfig.listOrder)) {
          req.userConfig.listOrder = req.userConfig.listOrder.filter(listId => !listId.startsWith('trakt_'));
        }
        
        // Clean up lists metadata for Trakt lists
        if (req.userConfig.listsMetadata) {
          Object.keys(req.userConfig.listsMetadata).forEach(key => {
            if (key.startsWith('trakt_')) {
              delete req.userConfig.listsMetadata[key];
            }
          });
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        clearManifestCache('Trakt disconnected');
        res.json({ success: true, configHash: newConfigHash, message: 'Disconnected from Trakt.' });
    } catch (error) {
        console.error('Error in /trakt/disconnect:', error);
        res.status(500).json({ error: 'Failed to disconnect from Trakt', details: error.message });
    }
  });

  // Add MDBList disconnect endpoint
  router.post('/:configHash/mdblist/disconnect', async (req, res) => {
    try {
        req.userConfig.apiKey = null;

        // Purge MDBList-related list configurations and metadata
        purgeListConfigs(req.userConfig, 'aiolists-');
        
        // Clean up list order entries for MDBList lists
        if (req.userConfig.listOrder && Array.isArray(req.userConfig.listOrder)) {
          req.userConfig.listOrder = req.userConfig.listOrder.filter(listId => 
            !listId.startsWith('aiolists-') || listId === 'aiolists_search_movies' || listId === 'aiolists_search_series' || listId === 'aiolists_merged_search' || listId === 'aiolists_anime_search'
          );
        }
        
        // Clean up lists metadata for MDBList lists
        if (req.userConfig.listsMetadata) {
          Object.keys(req.userConfig.listsMetadata).forEach(key => {
            if (key.startsWith('aiolists-')) {
              delete req.userConfig.listsMetadata[key];
            }
          });
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        clearManifestCache('MDBList disconnected');
        res.json({ success: true, configHash: newConfigHash, message: 'Disconnected from MDBList.' });
    } catch (error) {
        console.error('Error in /mdblist/disconnect:', error);
        res.status(500).json({ error: 'Failed to disconnect from MDBList', details: error.message });
    }
  });

  // Add TMDB disconnect endpoint 
  router.post('/:configHash/tmdb/disconnect', async (req, res) => {
    try {
        req.userConfig.tmdbSessionId = null;
        req.userConfig.tmdbAccountId = null;
        
        // Only clear user-provided bearer token, not environment token
        req.userConfig.tmdbBearerToken = null;
        
        // Reset metadata source if it was set to TMDB
        if (req.userConfig.metadataSource === 'tmdb') {
          req.userConfig.metadataSource = 'cinemeta';
        }

        // Purge TMDB-related list configurations and metadata
        purgeListConfigs(req.userConfig, 'tmdb_');
        
        // Clean up list order entries for TMDB lists
        if (req.userConfig.listOrder && Array.isArray(req.userConfig.listOrder)) {
          req.userConfig.listOrder = req.userConfig.listOrder.filter(listId => !listId.startsWith('tmdb_'));
        }
        
        // Clean up lists metadata for TMDB lists
        if (req.userConfig.listsMetadata) {
          Object.keys(req.userConfig.listsMetadata).forEach(key => {
            if (key.startsWith('tmdb_')) {
              delete req.userConfig.listsMetadata[key];
            }
          });
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        clearManifestCache('TMDB disconnected');
        
        // Check if environment TMDB bearer token is still available
        const hasEnvToken = !!require('../config').TMDB_BEARER_TOKEN;
        const message = hasEnvToken ? 
          'Disconnected from TMDB OAuth. TMDB features still available via environment Bearer Token.' :
          'Disconnected from TMDB. Metadata source reset to Cinemeta.';
          
        res.json({ success: true, configHash: newConfigHash, message });
    } catch (error) {
        console.error('Error in /tmdb/disconnect:', error);
        res.status(500).json({ error: 'Failed to disconnect from TMDB', details: error.message });
    }
  });

  router.post('/:configHash/import-list-url', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'List URL required' });

        let importedListDetails;
        let addonId;
        let sourceSystem;
        let listNameForDisplay;
        let addonToStore = {};

        if (url.includes('mdblist.com/lists/')) {
            importedListDetails = await extractMDBListFromUrl(url, req.userConfig.apiKey);
            addonId = `mdblisturl_${importedListDetails.listId}`;
            listNameForDisplay = importedListDetails.listName;
            sourceSystem = "MDBList";
            addonToStore = {
                id: addonId,
                name: `${listNameForDisplay}`,
                hasMovies: importedListDetails.hasMovies,
                hasShows: importedListDetails.hasShows,
                isMDBListUrlImport: true,
                mdblistId: importedListDetails.listId,
                mdblistUsername: importedListDetails.username,
                mdblistSlug: importedListDetails.listSlug,
                dynamic: importedListDetails.dynamic,
                mediatype: importedListDetails.mediatype,
                types: [
                    ...(importedListDetails.hasMovies ? ['movie'] : []),
                    ...(importedListDetails.hasShows ? ['series'] : [])
                ],
            };
        } else if (url.includes('trakt.tv/users/') && url.includes('/lists/')) {
            importedListDetails = await fetchPublicTraktListDetails(url);
            addonId = importedListDetails.listId;
            listNameForDisplay = importedListDetails.listName;
            sourceSystem = "Trakt Public";
            addonToStore = {
                id: addonId,
                name: `${listNameForDisplay}`,
                hasMovies: importedListDetails.hasMovies,
                hasShows: importedListDetails.hasShows,
                isTraktPublicList: true,
                traktUser: importedListDetails.traktUser,
                traktListSlug: importedListDetails.originalTraktSlug,
                types: [
                    ...(importedListDetails.hasMovies ? ['movie'] : []),
                    ...(importedListDetails.hasShows ? ['series'] : [])
                ],
            };
        } else {
            return res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }

        if (!req.userConfig.importedAddons) req.userConfig.importedAddons = {};
        if (req.userConfig.importedAddons[addonId]) {
             return res.status(400).json({ error: `List "${listNameForDisplay}" from ${sourceSystem} is already imported.` });
        }
        if (!addonToStore.hasMovies && !addonToStore.hasShows) {
            return res.status(400).json({ error: `List "${listNameForDisplay}" from ${sourceSystem} contains no movie or show content.` });
        }
        req.userConfig.importedAddons[addonId] = addonToStore;
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, addon: req.userConfig.importedAddons[addonId], message: `Imported ${listNameForDisplay} from ${sourceSystem}` });
    } catch (error) {
        console.error('Error in /import-list-url:', error);
        res.status(500).json({ error: error.message || `Failed to import URL` });
    }
  });

  router.post('/:configHash/import-addon', async (req, res) => {
    try {
        const { manifestUrl } = req.body;
        if (!manifestUrl) return res.status(400).json({ error: 'Manifest URL required' });

        const addonInfo = await importExtAddon(manifestUrl, req.userConfig);

        if (!req.userConfig.importedAddons) {
            req.userConfig.importedAddons = {};
        }

        if (req.userConfig.importedAddons[addonInfo.id]) {
            console.warn(`Re-importing addon with manifest ID: ${addonInfo.id}. Overwriting with new import.`);
            req.userConfig.importedAddons[addonInfo.id] = addonInfo;
        } else {
            req.userConfig.importedAddons[addonInfo.id] = addonInfo;
        }

        const finalAddonEntry = req.userConfig.importedAddons[addonInfo.id];
        if (finalAddonEntry && finalAddonEntry.catalogs) {
            finalAddonEntry.hasMovies = finalAddonEntry.catalogs.some(c => {
                const typeFromCatalog = c.type;
                const sourceManifestTypes = addonInfo.types || [];
                return typeFromCatalog === 'movie' || (typeFromCatalog === 'all' && sourceManifestTypes.includes('movie'));
            });
            finalAddonEntry.hasShows = finalAddonEntry.catalogs.some(c => {
                const typeFromCatalog = c.type;
                const sourceManifestTypes = addonInfo.types || [];
                return typeFromCatalog === 'series' || typeFromCatalog === 'tv' || (typeFromCatalog === 'all' && (sourceManifestTypes.includes('series') || sourceManifestTypes.includes('tv')));
            });
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, addon: req.userConfig.importedAddons[addonInfo.id], message: `Imported ${addonInfo.name}` });
    } catch (error) {
        console.error('Error in /import-addon:', error);
        res.status(500).json({ error: 'Failed to import addon by manifest', details: error.message });
    }
  });

  router.post('/:configHash/remove-addon', async (req, res) => {
    try {
        const { addonId } = req.body;
        if (!addonId || !req.userConfig.importedAddons || !req.userConfig.importedAddons[addonId]) {
            return res.status(400).json({ error: 'Invalid addon ID or addon not found in imports.' });
        }

        const addonToRemove = req.userConfig.importedAddons[addonId];
        delete req.userConfig.importedAddons[addonId];

        purgeListConfigs(req.userConfig, addonId, true);

        if (addonToRemove && addonToRemove.catalogs && Array.isArray(addonToRemove.catalogs)) {
            for (const subCatalog of addonToRemove.catalogs) {
                const subCatalogIdStr = String(subCatalog.id);
                purgeListConfigs(req.userConfig, subCatalogIdStr, true);
                const subCatalogOriginalId = String(subCatalog.originalId);
                if (subCatalogOriginalId && subCatalogOriginalId !== subCatalogIdStr && req.userConfig.sortPreferences?.[subCatalogOriginalId]) {
                     delete req.userConfig.sortPreferences[subCatalogOriginalId];
                }
            }
        }

        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, message: 'Addon group and its configurations removed.' });
    } catch (error) {
        console.error('Error in /remove-addon:', error);
        res.status(500).json({ error: 'Failed to remove addon group', details: error.message });
    }
  });

  router.post('/:configHash/lists/order', async (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) return res.status(400).json({ error: 'Order must be an array of strings.' });
        
        if (req.userConfig.upstashUrl) {
            await initTraktApi(req.userConfig);
        }

        req.userConfig.listOrder = order.map(String);
        req.userConfig.lastUpdated = new Date().toISOString();
        const newConfigHash = await compressConfig(req.userConfig);
        manifestCache.clear();
        res.json({ success: true, configHash: newConfigHash, message: 'List order updated' });
    } catch (error) {
        console.error('Failed to update list order:', error);
        res.status(500).json({ error: 'Failed to update list order' });
    }
  });

  router.post('/:configHash/lists/names', async (req, res) => {
    try {
      console.log('[LISTS] Updating list names (lightweight)');
      const { listId, customName } = req.body;
      if (!listId) return res.status(400).json({ error: 'List ID required' });
      if (!req.userConfig.customListNames) req.userConfig.customListNames = {};
      if (customName && customName.trim()) {
        req.userConfig.customListNames[String(listId)] = customName.trim();
        console.log(`[LISTS] Set custom name for list ${listId}: "${customName.trim()}"`);
      } else {
        delete req.userConfig.customListNames[String(listId)];
        console.log(`[LISTS] Removed custom name for list: ${listId}`);
      }
      
      const newConfigHash = await updateConfigLightweight(req.userConfig, {}, 'custom list name update');
      console.log('[LISTS] List names updated without manifest rebuild');
      res.json({ success: true, configHash: newConfigHash, message: 'List name updated' });
    } catch (error) {
        console.error('[LISTS] Failed to update list name:', error);
        res.status(500).json({ error: 'Failed to update list name' });
    }
  });

  router.post('/:configHash/lists/mediatype', async (req, res) => {
    try {
      console.log('[LISTS] Updating list media type (lightweight)');
      const { listId, customMediaType } = req.body;
      if (!listId) return res.status(400).json({ error: 'List ID required for custom media type.' });

      if (!req.userConfig.customMediaTypeNames) {
        req.userConfig.customMediaTypeNames = {};
      }

      if (customMediaType && customMediaType.trim()) {
        req.userConfig.customMediaTypeNames[String(listId)] = customMediaType.trim().toLowerCase();
        console.log(`[LISTS] Set custom media type for list ${listId}: "${customMediaType.trim().toLowerCase()}"`);
      } else {
        delete req.userConfig.customMediaTypeNames[String(listId)];
        console.log(`[LISTS] Removed custom media type for list: ${listId}`);
      }

      const newConfigHash = await updateConfigLightweight(req.userConfig, {}, 'custom media type update');
      console.log('[LISTS] List media type updated without manifest rebuild');
      res.json({ success: true, configHash: newConfigHash, message: 'Custom media type display name updated' });
    } catch (error) {
      console.error('[LISTS] Failed to update custom media type name:', error);
      res.status(500).json({ error: 'Failed to update custom media type name' });
    }
  });

  router.post('/:configHash/lists/visibility', async (req, res) => {
    try {
      console.log('[LISTS] Updating list visibility (lightweight)');
      const { hiddenLists } = req.body;
      if (!Array.isArray(hiddenLists)) return res.status(400).json({ error: 'Hidden lists must be an array of strings.' });
      
      if (req.userConfig.upstashUrl) {
          await initTraktApi(req.userConfig);
      }
      
      req.userConfig.hiddenLists = hiddenLists.map(String);
      console.log(`[LISTS] Updated hidden lists: [${hiddenLists.join(', ')}]`);
      
      const newConfigHash = await updateConfigLightweight(req.userConfig, {}, 'list visibility update');
      console.log('[LISTS] List visibility updated without manifest rebuild');
      res.json({ success: true, configHash: newConfigHash, message: 'List visibility updated' });
    } catch (error) {
        console.error('[LISTS] Failed to update list visibility:', error);
        res.status(500).json({ error: 'Failed to update list visibility' });
    }
  });

  router.post('/:configHash/upstash/check', async (req, res) => {
    const { upstashUrl, upstashToken } = req.body;
    try {
        const { Redis } = require('@upstash/redis');
        const redis = new Redis({
            url: upstashUrl,
            token: upstashToken,
        });
        // A simple command to check the connection
        await redis.ping();
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: 'Invalid Upstash credentials' });
    }
});

  router.post('/:configHash/lists/remove', async (req, res) => {
    try {
      const { listIds } = req.body;
      if (!Array.isArray(listIds)) return res.status(400).json({ error: 'List IDs must be an array of strings.' });

      const currentRemoved = new Set(req.userConfig.removedLists || []);

      for (const listIdToRemove of listIds) {
        const idStr = String(listIdToRemove);

        const addonDetails = req.userConfig.importedAddons?.[idStr];
        const isUrlImport = addonDetails && (addonDetails.isMDBListUrlImport || addonDetails.isTraktPublicList);

        const isNativeMDBList = idStr.startsWith('aiolists-');
        const isNativeTrakt = idStr.startsWith('trakt_') && !idStr.startsWith('traktpublic_');
        const isRandomCatalog = idStr === 'random_mdblist_catalog';

        let isSubCatalog = false;
        let parentAddonIdForSubCatalog = null;
        let subCatalogOriginalId = null;

        if (!isNativeMDBList && !isNativeTrakt && !isUrlImport && !isRandomCatalog) {
            for (const importedAddonId in req.userConfig.importedAddons) {
                const parentAddon = req.userConfig.importedAddons[importedAddonId];
                if (parentAddon && !(parentAddon.isMDBListUrlImport || parentAddon.isTraktPublicList) && parentAddon.catalogs) {
                    const foundCatalog = parentAddon.catalogs.find(cat => String(cat.id) === idStr);
                    if (foundCatalog) {
                        isSubCatalog = true;
                        parentAddonIdForSubCatalog = importedAddonId;
                        subCatalogOriginalId = String(foundCatalog.originalId);
                        break;
                    }
                }
            }
        }

        if (isRandomCatalog) {
            req.userConfig.enableRandomListFeature = false;
        } else if (isUrlImport) {
          if (req.userConfig.importedAddons) delete req.userConfig.importedAddons[idStr];
          purgeListConfigs(req.userConfig, idStr, true);
        } else if (isSubCatalog && parentAddonIdForSubCatalog) {
          purgeListConfigs(req.userConfig, idStr, true);
          if (subCatalogOriginalId && subCatalogOriginalId !== idStr && req.userConfig.sortPreferences?.[subCatalogOriginalId]) {
            delete req.userConfig.sortPreferences[subCatalogOriginalId];
          }
          if (req.userConfig.importedAddons[parentAddonIdForSubCatalog]?.catalogs) {
            req.userConfig.importedAddons[parentAddonIdForSubCatalog].catalogs =
              req.userConfig.importedAddons[parentAddonIdForSubCatalog].catalogs.filter(cat => String(cat.id) !== idStr);
          }
        } else if (isNativeMDBList || isNativeTrakt) {
          currentRemoved.add(idStr);
          if (req.userConfig.hiddenLists) {
            req.userConfig.hiddenLists = req.userConfig.hiddenLists.filter(id => String(id) !== idStr);
          }
        } else {
          console.warn(`Removing unclassified list ID: ${idStr}. Assuming it's a top-level manifest import being removed.`);
          if (req.userConfig.importedAddons && req.userConfig.importedAddons[idStr]) {
             delete req.userConfig.importedAddons[idStr];
          }
          purgeListConfigs(req.userConfig, idStr, true);
        }
      }

      req.userConfig.removedLists = Array.from(currentRemoved);

      req.userConfig.lastUpdated = new Date().toISOString();
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      res.json({ success: true, configHash: newConfigHash, message: 'Lists processed for removal' });
    } catch (error) {
        console.error('Failed to remove lists:', error);
        res.status(500).json({ error: 'Failed to remove lists', details: error.message });
    }
  });

  router.post('/:configHash/lists/sort', async (req, res) => {
    try {
      console.log('[LISTS] Updating sort preferences (lightweight)');
      const { listId, sort, order } = req.body;
      if (!listId || !sort) return res.status(400).json({ error: 'List ID (originalId) and sort field required' });
      if (!req.userConfig.sortPreferences) req.userConfig.sortPreferences = {};
      req.userConfig.sortPreferences[String(listId)] = { sort, order: order || 'desc' };
      console.log(`[LISTS] Set sort for list ${listId}: ${sort} ${order || 'desc'}`);
      
      const newConfigHash = await updateConfigLightweight(req.userConfig, {}, 'sort preferences update');
      console.log('[LISTS] Sort preferences updated without manifest rebuild');
      res.json({ success: true, configHash: newConfigHash, message: 'Sort preferences updated' });
    } catch (error) {
        console.error('[LISTS] Failed to update sort preferences:', error);
        res.status(500).json({ error: 'Failed to update sort preferences' });
    }
  });

  router.post('/:configHash/lists/merge', async (req, res) => {
    try {
      console.log('[LISTS] Updating list merge preference (lightweight)');

      if (req.userConfig.upstashUrl) {
        await initTraktApi(req.userConfig);
      }

      const { listId, merged } = req.body;
      if (!listId || typeof merged !== 'boolean') {
        return res.status(400).json({ error: 'List ID (manifestId) and merge preference (boolean) required' });
      }
    
      let canBeMerged = false;
      const listInfoFromMetadata = req.userConfig.listsMetadata?.[String(listId)];
      if (listInfoFromMetadata && listInfoFromMetadata.hasMovies && listInfoFromMetadata.hasShows) {
          canBeMerged = true;
      } else {
          const listInfoFromImported = req.userConfig.importedAddons?.[String(listId)];
          if (listInfoFromImported && listInfoFromImported.hasMovies && listInfoFromImported.hasShows) {
              canBeMerged = true;
          }
      }
      
      if (!canBeMerged && merged === true) {
        return res.status(400).json({ error: 'This list does not contain both movies and series, so it cannot be merged.' });
      }
      
      if (merged === true) { // User wants to merge
        if (req.userConfig.mergedLists) {
          delete req.userConfig.mergedLists[String(listId)];
          if (Object.keys(req.userConfig.mergedLists).length === 0) {
            delete req.userConfig.mergedLists;
          }
        }
        console.log(`[LISTS] Set list ${listId} to merged state`);
      } else { // User wants to split (merged === false)
        if (!req.userConfig.mergedLists) {
          req.userConfig.mergedLists = {};
        }
        req.userConfig.mergedLists[String(listId)] = false;
        console.log(`[LISTS] Set list ${listId} to split state`);
      }
      
      const newConfigHash = await updateConfigLightweight(req.userConfig, {}, 'list merge preference update');
      console.log('[LISTS] List merge preference updated without manifest rebuild');
  
      res.json({ success: true, configHash: newConfigHash, message: `List ${merged ? 'merged' : 'split'}` });
    } catch (error) {
      console.error('[LISTS] Failed to update list merge preference:', error);
      res.status(500).json({ error: 'Failed to update list merge preference' });
    }
  });
      
  router.post('/config/create', async (req, res) => {
    try {
      let newConfig = { 
        ...defaultConfig, 
        listOrder: [], 
        hiddenLists: [], 
        removedLists: [], 
        customListNames: {}, 
        customMediaTypeNames: {}, 
        mergedLists: {}, 
        sortPreferences: {}, 
        importedAddons: {}, 
        listsMetadata: {}, 
        enableRandomListFeature: false, 
        lastUpdated: new Date().toISOString() 
      };

      if (req.body.sharedConfig) {
        const sharedSettings = await decompressConfig(req.body.sharedConfig);
        const shareablePart = createShareableConfig(sharedSettings);
        newConfig = { ...newConfig, ...shareablePart };
      }

      if (req.body.config) {
        const userConfig = req.body.config;
        newConfig = { ...newConfig, ...userConfig };
      }

      const configHash = await compressConfig(newConfig);
      res.json({ success: true, configHash });
    } catch (error) { console.error('Error in /config/create:', error); res.status(500).json({ error: 'Failed to create configuration' }); }
  });

  router.post('/validate-keys', async (req, res) => {
    try {
          const { apiKey, rpdbApiKey } = req.body;
    const results = { mdblist: null, rpdb: null };

    if (apiKey) {
      const mdblistResult = await validateMDBListKey(apiKey);
      results.mdblist = (mdblistResult && mdblistResult.username) ? { valid: true, username: mdblistResult.username } : { valid: false };
    }
    if (rpdbApiKey) {
      results.rpdb = { valid: await validateRPDBKey(rpdbApiKey) };
    }
      res.json(results);
    } catch (error) {
        console.error('Error in /validate-keys:', error);
        res.status(500).json({ error: 'Failed to validate keys' });
    }
  });

  router.post('/trakt/validate', async (req, res) => {
    try {
      const isValid = await validateTraktApi();
      res.json({ 
        success: true, 
        valid: isValid
      });
    } catch (error) {
      console.error('Error in /trakt/validate:', error);
      res.status(500).json({ error: 'Failed to validate Trakt API access', details: error.message });
    }
  });

  router.get('/trakt/login', (req, res) => {
    try { 
      // Check if this is a request that expects JSON response
      const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
      
      if (acceptsJson) {
        // Return JSON for AJAX requests
        res.json({ 
          success: true, 
          authUrl: getTraktAuthUrl(),
          requiresManualAuth: true,
          message: 'Please authorize in the opened window'
        });
      } else {
        // Direct redirect for page navigation
        res.redirect(getTraktAuthUrl());
      }
    }
    catch (error) {
        console.error('Error in /trakt/login redirect:', error);
        res.status(500).json({ error: 'Internal server error for Trakt login' });
    }
  });

  // Config-specific Trakt login endpoint that includes config hash as state
  router.get('/:configHash/trakt/login', (req, res) => {
    try { 
      const configHash = req.params.configHash;
      const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
      
      if (!configHash) {
        return res.status(400).json({ error: 'Config hash is required' });
      }
      
      // Create state object with config hash for the callback
      const stateObject = {
        configHash: configHash,
        timestamp: Date.now()
      };
      
      // Convert state to base64 string
      const stateString = Buffer.from(JSON.stringify(stateObject)).toString('base64');
      const authUrl = getTraktAuthUrl(stateString);
      
      if (acceptsJson) {
        // Check if we're using PIN flow (out-of-band) or proper redirect
        const isPinFlow = !TRAKT_REDIRECT_URI || TRAKT_REDIRECT_URI === 'urn:ietf:wg:oauth:2.0:oob';
        
        // Return JSON for AJAX requests  
        res.json({ 
          success: true, 
          authUrl: authUrl,
          requiresManualAuth: isPinFlow, // Manual auth needed for PIN flow
          message: isPinFlow ? 'Please authorize in the opened window' : 'Redirecting to Trakt...'
        });
      } else {
        // Direct redirect for page navigation
        res.redirect(authUrl);
      }
    }
    catch (error) {
        console.error('Error in config-specific /trakt/login:', error);
        res.status(500).json({ error: 'Internal server error for Trakt login' });
    }
  });

  // Lightweight lists endpoint - doesn't fetch lists from external APIs
  router.get('/:configHash/lists-lightweight', async (req, res) => {
    try {
      console.log('[LISTS] Loading lists (lightweight - no API calls)');
      
      // Initialize Trakt API if needed (this is fast)
      if (req.userConfig.traktUuid || req.userConfig.traktAccessToken) {
        await initTraktApi(req.userConfig);
      }

      // Return cached/stored list information without fetching from external APIs
      console.log('[LISTS] Returning cached list configuration without external API calls');
      
      res.json({
        success: true,
        lists: [], // Empty for lightweight mode
        importedAddons: req.userConfig.importedAddons || {},
        listsMetadata: req.userConfig.listsMetadata || {},
        customMediaTypeNames: req.userConfig.customMediaTypeNames || {},
        isPotentiallySharedConfig: req.isPotentiallySharedConfig || false,
        randomMDBListUsernames: req.userConfig.randomMDBListUsernames || [],
        message: 'Lightweight mode - use /lists-full for complete list data'
      });
    } catch (error) {
      console.error('[LISTS] Error in lightweight lists endpoint:', error);
      res.status(500).json({ success: false, error: 'Failed to load lists configuration' });
    }
  });

  router.get('/:configHash/lists', async (req, res) => {
    try {
      console.log('[LISTS] Loading lists (full - with external API calls)');
      const initialListsMetadataJson = JSON.stringify(req.userConfig.listsMetadata || {});
      const initialTraktAccessToken = req.userConfig.traktAccessToken;
      let configChangedByThisRequest = false;
        
      if (req.userConfig.traktUuid || req.userConfig.traktAccessToken) {
        console.log('[LISTS] Initializing Trakt API');
        await initTraktApi(req.userConfig); // This is the key change
  
        if (req.userConfig.traktAccessToken !== initialTraktAccessToken) {
            configChangedByThisRequest = true;
        }
    }

    let allUserLists = [];
    if (req.userConfig.apiKey) {
        console.log('[LISTS] Fetching MDBList lists');
        const mdbLists = await fetchAllMDBLists(req.userConfig.apiKey);
        allUserLists.push(...mdbLists.map(l => ({...l, source: 'mdblist'})));
        console.log(`[LISTS] Fetched ${mdbLists.length} MDBList lists`);
    }

    if (req.userConfig.traktAccessToken) {
      console.log('[LISTS] Fetching Trakt lists');
      const traktLists = await fetchTraktLists(req.userConfig); 
      allUserLists.push(...traktLists.map(l => ({...l, source: 'trakt'})));
      console.log(`[LISTS] Fetched ${traktLists.length} Trakt lists`);
  }

    // Fetch from TMDB
    console.log('[LISTS] Fetching TMDB lists');
    const { fetchTmdbLists } = require('../integrations/tmdb');
    const tmdbResult = await fetchTmdbLists(req.userConfig);
    
    // Add TMDB lists to the main lists if OAuth is connected
    if (tmdbResult.isConnected && tmdbResult.lists && tmdbResult.lists.length > 0) {
      allUserLists.push(...tmdbResult.lists.map(l => ({...l, source: 'tmdb'})));
      console.log(`[LISTS] Fetched ${tmdbResult.lists.length} TMDB lists`);
    }


  
      const removedListsSet = new Set(req.userConfig.removedLists || []);
      if (!req.userConfig.listsMetadata) req.userConfig.listsMetadata = {};
      if (!req.userConfig.customMediaTypeNames) req.userConfig.customMediaTypeNames = {};
    
      let processedLists = [];
    
      // This block is correct and does not need changes
      if (req.userConfig.enableRandomListFeature && req.userConfig.apiKey) {
        const manifestListId = 'random_mdblist_catalog';
        const customTypeName = req.userConfig.customMediaTypeNames?.[manifestListId];
        let effectiveMediaTypeDisplay = customTypeName ? 
            customTypeName.charAt(0).toUpperCase() + customTypeName.slice(1) : 'All';

        const randomCatalogUIEntry = {
            id: manifestListId,
            originalId: manifestListId,
            name: 'Random MDBList Catalog',
            customName: req.userConfig.customListNames?.[manifestListId] || null,
            effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
            isHidden: (req.userConfig.hiddenLists || []).includes(manifestListId),
            hasMovies: true,
            hasShows: true,
            isRandomCatalog: true, 
            tag: '🎲', 
            tagImage: null,
            sortPreferences: req.userConfig.sortPreferences?.[manifestListId] || { sort: 'default', order: 'desc' },
            isMerged: false,
            source: 'random_mdblist'
        };
        if (randomCatalogUIEntry.customName) randomCatalogUIEntry.name = randomCatalogUIEntry.customName;
        processedLists.push(randomCatalogUIEntry);
      }

      // This block for processing native lists is complex but correct
      const activeListsProcessingPromises = allUserLists.map(async list => {
        const originalListIdStr = String(list.id);
        let manifestListId = originalListIdStr;
        let tagType = 'L'; 
        let determinedHasMovies, determinedHasShows;
    
        if (list.source === 'mdblist') {
          const listTypeSuffix = list.listType || 'L';
          manifestListId = list.id === 'watchlist' ? `aiolists-watchlist-W` : `aiolists-${list.id}-${listTypeSuffix}`;
          tagType = listTypeSuffix;
          
          let metadata = req.userConfig.listsMetadata[manifestListId] || {};
          determinedHasMovies = metadata.hasMovies;
          determinedHasShows = metadata.hasShows;

          if (typeof determinedHasMovies !== 'boolean' || typeof determinedHasShows !== 'boolean') {
            const tempContent = await fetchListContent(manifestListId, req.userConfig, 0, null, 'all');
            determinedHasMovies = tempContent?.hasMovies || false;
            determinedHasShows = tempContent?.hasShows || false;
          }

          req.userConfig.listsMetadata[manifestListId] = {
              hasMovies: determinedHasMovies,
              hasShows: determinedHasShows,
              lastChecked: new Date().toISOString()
          };
  
      } else if (list.source === 'trakt'){
          manifestListId = list.id;
          tagType = 'T';
          let metadata = req.userConfig.listsMetadata[manifestListId] || {};
          determinedHasMovies = metadata.hasMovies === true;
          determinedHasShows = metadata.hasShows === true;
  
          if ((typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean' || metadata.errorFetching) && req.userConfig.traktAccessToken) {
                const tempUserConfigForFetch = { ...req.userConfig, rpdbApiKey: null };
                const tempContent = await fetchListContent(manifestListId, tempUserConfigForFetch, 0, null, 'all');
                
                if (tempUserConfigForFetch.traktAccessToken !== req.userConfig.traktAccessToken) {
                    req.userConfig.traktAccessToken = tempUserConfigForFetch.traktAccessToken;
                    configChangedByThisRequest = true; 
                }
  
                determinedHasMovies = tempContent?.hasMovies || false;
                determinedHasShows = tempContent?.hasShows || false;
                if (!metadata.hasMovies && !metadata.hasShows && (determinedHasMovies || determinedHasShows)) {
                    configChangedByThisRequest = true;
                }
                req.userConfig.listsMetadata[manifestListId] = { 
                    ...metadata, 
                    hasMovies: determinedHasMovies, 
                    hasShows: determinedHasShows, 
                    lastChecked: new Date().toISOString(),
                    errorFetching: false
                };
          } else { 
               req.userConfig.listsMetadata[manifestListId] = { 
                  ...metadata, 
                  hasMovies: determinedHasMovies, 
                  hasShows: determinedHasShows,
                  lastChecked: new Date().toISOString() 
              };
          }
      } else if (list.source === 'tmdb') {
          manifestListId = list.id;
          tagType = 'M'; // M for TMDB
          let metadata = req.userConfig.listsMetadata[manifestListId] || {};
          determinedHasMovies = metadata.hasMovies;
          determinedHasShows = metadata.hasShows;

          // If we don't have metadata, try to fetch or use default assumptions
          if (typeof determinedHasMovies !== 'boolean' || typeof determinedHasShows !== 'boolean') {
              if (req.userConfig.tmdbSessionId) {
                  try {
                      const tempUserConfigForFetch = { ...req.userConfig, rpdbApiKey: null };
                      const tempContent = await fetchListContent(manifestListId, tempUserConfigForFetch, 0, null, 'all');
                      determinedHasMovies = tempContent?.hasMovies || false;
                      determinedHasShows = tempContent?.hasShows || false;
                  } catch (error) {
                      console.error(`Error fetching TMDB list metadata for ${manifestListId}:`, error.message);
                      // Default assumptions for TMDB lists
                      if (manifestListId === 'tmdb_watchlist' || manifestListId === 'tmdb_favorites') {
                          determinedHasMovies = true;
                          determinedHasShows = true;
                      } else {
                          determinedHasMovies = true;
                          determinedHasShows = true;
                      }
                  }
              } else {
                  // Default for TMDB lists when not connected
                  determinedHasMovies = true;
                  determinedHasShows = true;
              }
              
              req.userConfig.listsMetadata[manifestListId] = {
                  ...metadata,
                  hasMovies: determinedHasMovies,
                  hasShows: determinedHasShows,
                  lastChecked: new Date().toISOString()
              };
          }
      } else { 
          determinedHasMovies = false;
          determinedHasShows = false;
      }
  
      if (list.isWatchlist && list.source === 'mdblist') tagType = 'W';
      if (list.isTraktWatchlist) tagType = 'W';
      if (removedListsSet.has(manifestListId)) return null;
      const actualCanBeMerged = determinedHasMovies && determinedHasShows;
      const isUserMerged = actualCanBeMerged ? (req.userConfig.mergedLists?.[manifestListId] !== false) : false;
      let defaultSort = { sort: (list.source === 'trakt') ? 'rank' : 'default', order: (list.source === 'trakt') ? 'asc' : 'desc' };
      if (list.source === 'trakt' && list.isTraktWatchlist) { defaultSort = { sort: 'added', order: 'desc' }; }
                      const customTypeName = req.userConfig.customMediaTypeNames?.[manifestListId];
                let effectiveMediaTypeDisplay;
                if (customTypeName) {
                    // Capitalize first letter for display while keeping storage lowercase
                    effectiveMediaTypeDisplay = customTypeName.charAt(0).toUpperCase() + customTypeName.slice(1);
                } else {
                    if (determinedHasMovies && determinedHasShows) effectiveMediaTypeDisplay = 'All';
                    else if (determinedHasMovies) effectiveMediaTypeDisplay = 'Movie';
                    else if (determinedHasShows) effectiveMediaTypeDisplay = 'Series';
                    else effectiveMediaTypeDisplay = 'N/A';
                }
      // Set tag image based on source
      let tagImage = null;
      if (list.source === 'trakt') {
          tagImage = 'https://walter.trakt.tv/hotlink-ok/public/favicon.ico';
      } else if (list.source === 'tmdb') {
          tagImage = 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg';
      }

      return { id: manifestListId, originalId: originalListIdStr, name: list.name, customName: req.userConfig.customListNames?.[manifestListId] || null, effectiveMediaTypeDisplay: effectiveMediaTypeDisplay, isHidden: (req.userConfig.hiddenLists || []).includes(manifestListId), hasMovies: determinedHasMovies, hasShows: determinedHasShows, canBeMerged: actualCanBeMerged, isMerged: isUserMerged, isTraktList: list.source === 'trakt' && list.isTraktList, isTraktWatchlist: list.source === 'trakt' && list.isTraktWatchlist, isTraktRecommendations: list.isTraktRecommendations, isTraktTrending: list.isTraktTrending, isTraktPopular: list.isTraktPopular, isWatchlist: !!list.isWatchlist || !!list.isTraktWatchlist || (list.source === 'tmdb' && (list.isTmdbWatchlist || list.id === 'tmdb_watchlist')), tag: tagType, listType: list.listType, tagImage: tagImage, sortPreferences: req.userConfig.sortPreferences?.[originalListIdStr] || defaultSort, source: list.source, dynamic: list.dynamic, mediatype: list.mediatype };
      });
      const activeListsResults = (await Promise.all(activeListsProcessingPromises)).filter(p => p !== null);
      processedLists.push(...activeListsResults);

      if (req.userConfig.importedAddons) {
        for (const addonKey in req.userConfig.importedAddons) {
            const addon = req.userConfig.importedAddons[addonKey];
            const addonGroupId = String(addon.id); // This is the key from importedAddons

            if (removedListsSet.has(addonGroupId)) continue; // Skip if entire addon group is "removed"

            const isMDBListUrlImport = !!addon.isMDBListUrlImport;
            const isTraktPublicList = !!addon.isTraktPublicList;

            if (isMDBListUrlImport || isTraktPublicList) {
                // These are treated as single, manageable list entries in the UI
                if ((req.userConfig.hiddenLists || []).includes(addonGroupId)) continue; // Skip if hidden

                let urlImportHasMovies = addon.hasMovies;
                let urlImportHasShows = addon.hasShows;
                let actualCanBeMergedForUrl = urlImportHasMovies && urlImportHasShows;
                const isUserMergedForUrl = actualCanBeMergedForUrl ? (req.userConfig.mergedLists?.[addonGroupId] !== false) : false;
                
                let tagType = 'A'; // Default for addon
                let tagImage = addon.logo || null; // Use addon logo if available
                if(isMDBListUrlImport) { tagType = 'L'; tagImage = null; }
                else if (isTraktPublicList) { tagType = 'T'; tagImage = 'https://walter.trakt.tv/hotlink-ok/public/favicon.ico'; }

                // Sort preferences for URL imports should ideally use a stable original ID
                // For MDBList URL, mdblistId is good. For Trakt Public, the addonGroupId itself is fine as it's unique.
                const sortOriginalIdForUrl = addon.mdblistId || addonGroupId;

                const customTypeName = req.userConfig.customMediaTypeNames?.[addonGroupId];
                let effectiveMediaTypeDisplay;
                if (customTypeName) {
                    // Capitalize first letter for display while keeping storage lowercase
                    effectiveMediaTypeDisplay = customTypeName.charAt(0).toUpperCase() + customTypeName.slice(1);
                } else {
                    if (urlImportHasMovies && urlImportHasShows) effectiveMediaTypeDisplay = 'All';
                    else if (urlImportHasMovies) effectiveMediaTypeDisplay = 'Movie';
                    else if (urlImportHasShows) effectiveMediaTypeDisplay = 'Series';
                    else effectiveMediaTypeDisplay = 'N/A';
                }

                processedLists.push({
                    id: addonGroupId,
                    originalId: sortOriginalIdForUrl, 
                    name: addon.name,
                    customName: req.userConfig.customListNames?.[addonGroupId] || null,
                    effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
                    isHidden: (req.userConfig.hiddenLists || []).includes(addonGroupId),
                    hasMovies: urlImportHasMovies,
                    hasShows: urlImportHasShows,
                    canBeMerged: actualCanBeMergedForUrl,
                    isMerged: isUserMergedForUrl,
                    addonId: addonGroupId,
                    addonName: addon.name,
                    tag: tagType,
                    tagImage: tagImage,
                    sortPreferences: req.userConfig.sortPreferences?.[sortOriginalIdForUrl] ||
                                     { sort: (isTraktPublicList ? 'rank' : 'default'),
                                       order: (isTraktPublicList ? 'asc' : 'desc') },
                    source: isMDBListUrlImport ? 'mdblist_url' : (isTraktPublicList ? 'trakt_public' : 'addon_url_import'),
                    isUrlImportedType: true,
                    dynamic: isMDBListUrlImport ? addon.dynamic : undefined,
                    mediatype: isMDBListUrlImport ? addon.mediatype : undefined,
                    traktUser: isTraktPublicList ? addon.traktUser : undefined,
                    traktListSlug: isTraktPublicList ? addon.traktListSlug : undefined,
                });

            } else if (addon.catalogs && addon.catalogs.length > 0) {
                (addon.catalogs || []).forEach(catalog => {
                  const catalogIdStr = String(catalog.id);
                  if (removedListsSet.has(catalogIdStr) || (req.userConfig.hiddenLists || []).includes(catalogIdStr)) return;

                  let catalogHasMovies = false;
                  let catalogHasShows = false;
                  const catTypeLower = catalog.type ? String(catalog.type).toLowerCase() : 'unknown';
                  if (catTypeLower === 'movie') {
                    catalogHasMovies = true;
                } else if (catTypeLower === 'series' || catTypeLower === 'tv') {
                    catalogHasShows = true;
                } else { 
                    const parentAddonTypes = (addon.types || []).map(t => String(t).toLowerCase());
                    if (parentAddonTypes.includes('movie')) {
                        catalogHasMovies = true;
                    }
                    if (parentAddonTypes.includes('series') || parentAddonTypes.includes('tv')) {
                        catalogHasShows = true;
                    }
                }
                const subCatalogCanBeMerged = catalogHasMovies && catalogHasShows; // Merging based on inferred movie/series content
                const subCatalogIsUserMerged = subCatalogCanBeMerged ? (req.userConfig.mergedLists?.[catalogIdStr] !== false) : false;
                
                const customTypeName = req.userConfig.customMediaTypeNames?.[catalogIdStr];
                let effectiveMediaTypeDisplay;

                if (customTypeName) {
                    // Capitalize first letter for display while keeping storage lowercase
                    effectiveMediaTypeDisplay = customTypeName.charAt(0).toUpperCase() + customTypeName.slice(1);
                } else {
                    if (catTypeLower && !['movie', 'series', 'tv', 'all'].includes(catTypeLower)) {
                         effectiveMediaTypeDisplay = catTypeLower.charAt(0).toUpperCase() + catTypeLower.slice(1);
                    } else if (catalogHasMovies && catalogHasShows) {
                        effectiveMediaTypeDisplay = 'All';
                    } else if (catalogHasMovies) {
                        effectiveMediaTypeDisplay = 'Movie';
                    } else if (catalogHasShows) {
                        // Check if this is specifically a TV catalog to display as "TV" instead of "Series"
                        if (catTypeLower === 'tv') {
                            effectiveMediaTypeDisplay = 'TV';
                        } else {
                            effectiveMediaTypeDisplay = 'Series';
                        }
                    } else {
                         effectiveMediaTypeDisplay = catTypeLower.charAt(0).toUpperCase() + catTypeLower.slice(1);
                    }
                }

                processedLists.push({
                    id: catalogIdStr,
                    originalId: catalog.originalId || catalogIdStr, 
                    name: catalog.name,
                    customName: req.userConfig.customListNames?.[catalogIdStr] || null,
                    effectiveMediaTypeDisplay: effectiveMediaTypeDisplay,
                    isHidden: (req.userConfig.hiddenLists || []).includes(catalogIdStr),
                    hasMovies: catalogHasMovies,
                    hasShows: catalogHasShows,
                    canBeMerged: subCatalogCanBeMerged,
                    isMerged: subCatalogIsUserMerged,
                    addonId: addon.id, 
                    addonName: addon.name, 
                    tag: 'A', 
                    tagImage: addon.logo, 
                    sortPreferences: req.userConfig.sortPreferences?.[catalog.originalId || catalogIdStr] || { sort: 'default', order: 'desc' },
                    source: 'addon_manifest', 
                    isUrlImportedType: false,
                });
              });
            }
        }
      }

      // Auto-populate listOrder if empty to preserve natural order and allow appending new lists
      if ((!req.userConfig.listOrder || req.userConfig.listOrder.length === 0) && processedLists.length > 0) {
          // Create initial order with random catalog first (if exists), then natural order
          const randomCatalogList = processedLists.filter(list => list.id === 'random_mdblist_catalog');
          const otherLists = processedLists.filter(list => list.id !== 'random_mdblist_catalog');
          
          // Preserve natural order from API responses (no sorting)
          req.userConfig.listOrder = [
              ...randomCatalogList.map(list => list.id),
              ...otherLists.map(list => list.id)
          ];
          
          configChangedByThisRequest = true;
          console.log(`[API] Auto-populated listOrder with ${req.userConfig.listOrder.length} items in natural order`);
      } else if (req.userConfig.listOrder && req.userConfig.listOrder.length > 0) {
          // Check for new lists that aren't in the current order and append them
          const currentOrderSet = new Set(req.userConfig.listOrder.map(String));
          const newLists = processedLists.filter(list => !currentOrderSet.has(String(list.id)));
          
          if (newLists.length > 0) {
              // Append new lists to the end of the current order
              req.userConfig.listOrder = [
                  ...req.userConfig.listOrder,
                  ...newLists.map(list => list.id)
              ];
              configChangedByThisRequest = true;
              console.log(`[API] Appended ${newLists.length} new lists to existing order: ${newLists.map(l => l.id).join(', ')}`);
          }
      }

      // Sort processedLists based on userConfig.listOrder
      if (req.userConfig.listOrder && req.userConfig.listOrder.length > 0) {
          const orderMap = new Map(req.userConfig.listOrder.map((id, index) => [String(id), index]));
          processedLists.sort((a, b) => {
              const indexA = orderMap.get(String(a.id));
              const indexB = orderMap.get(String(b.id));
              if (indexA !== undefined && indexB !== undefined) return indexA - indexB;
              if (indexA !== undefined) return -1;
              if (indexB !== undefined) return 1; 
              if (a.id === 'random_mdblist_catalog' && b.id !== 'random_mdblist_catalog') return -1;
              if (b.id === 'random_mdblist_catalog' && a.id !== 'random_mdblist_catalog') return 1;
              return (a.name || '').localeCompare(b.name || '');
          });
      } else { // Default sort if no listOrder specified (fallback - should rarely happen now)
          processedLists.sort((a, b) => {
              if (a.id === 'random_mdblist_catalog' && b.id !== 'random_mdblist_catalog') return -1;
              if (b.id === 'random_mdblist_catalog' && a.id !== 'random_mdblist_catalog') return 1;
              return (a.name || '').localeCompare(b.name || '');
          });
      }

      // Check if listsMetadata was changed during this request processing
      const finalListsMetadataJson = JSON.stringify(req.userConfig.listsMetadata || {});
      if (initialListsMetadataJson !== finalListsMetadataJson) {
          configChangedByThisRequest = true; // Set if metadata content itself changed
      }
      
      let responsePayload = {
        success: true,
        lists: processedLists,
        importedAddons: req.userConfig.importedAddons || {},
        listsMetadata: req.userConfig.listsMetadata,
        isPotentiallySharedConfig: req.isPotentiallySharedConfig,
        randomMDBListUsernames: (req.userConfig.randomMDBListUsernames && req.userConfig.randomMDBListUsernames.length > 0) 
                                ? req.userConfig.randomMDBListUsernames 
                                : defaultConfig.randomMDBListUsernames,
        tmdbStatus: tmdbResult
      };
    
      if (configChangedByThisRequest) {
        // Update the lastUpdated timestamp on the active config
        req.userConfig.lastUpdated = new Date().toISOString();
        
                 const newConfigHash = await compressConfig(createConfigForStorage(req.userConfig));
        responsePayload.newConfigHash = newConfigHash;
        
        if (req.configHash !== newConfigHash) {
            manifestCache.clear();
        }
      }
    
      res.json(responsePayload);
    
    } catch (error) {
        console.error('Error fetching /lists:', error);
        res.status(500).json({ error: 'Failed to fetch lists', details: error.message });
    }
    });

  router.get('/:configHash/genres', async (req, res) => {
    try {
      let genres = staticGenres;
      
      // Use TMDB genres if TMDB is selected and Bearer Token is available
      if (req.userConfig.metadataSource === 'tmdb' && req.userConfig.tmdbLanguage) {
        const tmdbBearerToken = req.userConfig.tmdbBearerToken || TMDB_BEARER_TOKEN;
        if (tmdbBearerToken) {
          try {
            const { fetchTmdbGenres } = require('../integrations/tmdb');
            const tmdbGenres = await fetchTmdbGenres(req.userConfig.tmdbLanguage, tmdbBearerToken);
            if (tmdbGenres.length > 0) {
              genres = tmdbGenres;
            }
          } catch (error) {
            console.warn('Failed to fetch TMDB genres for API response:', error.message);
          }
        }
      }
      
      res.json({ success: true, genres });
    } catch (error) {
      console.error('Error fetching genres:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch genres' });
    }
  });

  router.post('/:configHash/tmdb/auth', async (req, res) => {
    try {
      const { requestToken, tmdbBearerToken } = req.body;
      if (!requestToken) return res.status(400).json({ error: 'Request token required' });
      
      const bearerTokenToUse = tmdbBearerToken || TMDB_BEARER_TOKEN;
      if (!bearerTokenToUse) return res.status(400).json({ error: 'TMDB Bearer Token required' });

      const { authenticateTmdb } = require('../integrations/tmdb');
      const tmdbAuthResult = await authenticateTmdb(requestToken, bearerTokenToUse);
      
      // Only store bearer token in config if it's not from environment
      if (!TMDB_BEARER_TOKEN) {
        req.userConfig.tmdbBearerToken = bearerTokenToUse;
      } else {
        // Set to null (not empty string) so fallback logic works properly
        req.userConfig.tmdbBearerToken = null;
      }
      
      req.userConfig.tmdbSessionId = tmdbAuthResult.sessionId;
      req.userConfig.tmdbAccountId = tmdbAuthResult.accountId;
      req.userConfig.lastUpdated = new Date().toISOString();
      
      const newConfigHash = await compressConfig(req.userConfig);
      manifestCache.clear();
      
      res.json({
        success: true,
        configHash: newConfigHash,
        message: 'Authenticated with TMDB',
        username: tmdbAuthResult.username,
        usingEnvToken: !!TMDB_BEARER_TOKEN
      });
    } catch (error) {
      console.error('Error in /tmdb/auth:', error);
      res.status(500).json({ error: 'Failed to authenticate with TMDB', details: error.message });
    }
  });



  router.post('/tmdb/validate', async (req, res) => {
    try {
      const { tmdbBearerToken } = req.body;
      const bearerTokenToUse = tmdbBearerToken || TMDB_BEARER_TOKEN;
      
      if (!bearerTokenToUse) {
        return res.status(400).json({ error: 'TMDB Bearer Token is required' });
      }
      
      const { validateTMDBKey } = require('../integrations/tmdb');
      const isValid = await validateTMDBKey(bearerTokenToUse);
      res.json({ 
        success: true, 
        valid: isValid
      });
    } catch (error) {
      console.error('Error in /tmdb/validate:', error);
      res.status(500).json({ error: 'Failed to validate TMDB Bearer Token', details: error.message });
    }
  });

  // Legacy GET endpoint for backwards compatibility
  router.get('/tmdb/login', async (req, res) => {
    res.status(400).json({ 
      error: 'TMDB Bearer Token is required. Please use the updated interface to provide your TMDB Bearer Token.',
      details: 'The TMDB connection flow now requires users to provide their own Bearer Token for security and API compliance reasons.'
    });
  });

  // New POST endpoint that requires user's bearer token
  router.post('/tmdb/login', async (req, res) => {
    try {
      const { tmdbBearerToken } = req.body;
      const bearerTokenToUse = tmdbBearerToken || TMDB_BEARER_TOKEN;
      
      if (!bearerTokenToUse) {
        return res.status(400).json({ error: 'TMDB Bearer Token is required' });
      }
      
      const { getTmdbAuthUrl } = require('../integrations/tmdb');
      const authData = await getTmdbAuthUrl(bearerTokenToUse);
      
      res.json({ 
        success: true, 
        requestToken: authData.requestToken,
        authUrl: authData.authUrl,
        canDirectRedirect: !!(TMDB_BEARER_TOKEN && TMDB_REDIRECT_URI),
        tmdbRedirectUri: TMDB_REDIRECT_URI // Add the redirect URI for frontend to construct full redirect URL
      });
    } catch (error) {
      console.error('Error in /tmdb/login:', error);
      res.status(500).json({ error: 'Failed to get TMDB auth URL', details: error.message });
    }
  });

  router.post('/:configHash/search', async (req, res) => {
    try {
      const { query, type = 'all', sources = ['cinemeta'], limit = 50 } = req.body;
      
      if (!query || query.trim().length < 2) {
        return res.status(400).json({ error: 'Search query must be at least 2 characters long' });
      }

      const trimmedQuery = query.trim();
      const validSources = sources.filter(s => ['cinemeta', 'trakt', 'tmdb'].includes(s));
      
      if (validSources.length === 0) {
        return res.status(400).json({ error: 'At least one valid search source must be specified' });
      }

      // Check if TMDB search is requested but user doesn't have TMDB configured
      if (validSources.includes('tmdb') && !req.userConfig.tmdbBearerToken && !TMDB_BEARER_TOKEN) {
        return res.status(400).json({ 
          error: 'TMDB search requires TMDB Bearer Token configuration' 
        });
      }

      const { searchContent } = require('../utils/searchEngine');
      
      const searchResults = await searchContent({
        query: trimmedQuery,
        type: type,
        sources: validSources,
        limit: limit,
        userConfig: req.userConfig
      });

      // Set cache headers - search results can be cached for a short time
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes cache
      
      res.json({
        success: true,
        query: trimmedQuery,
        results: searchResults.results,
        totalResults: searchResults.totalResults,
        sources: searchResults.sources
      });

    } catch (error) {
      console.error('Error in search endpoint:', error);
      res.status(500).json({ 
        error: 'Search failed', 
        details: error.message 
      });
    }
  });

  router.get('/custom-blurb', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const customHtmlBlurb = process.env.CUSTOM_HTML_BLURB || '';
    res.json({ 
      success: true, 
      htmlContent: customHtmlBlurb 
    });
  });

  router.get('/:configHash/debug/config', async (req, res) => {
    try {
      const debugInfo = {
        hasTmdbSessionId: !!req.userConfig.tmdbSessionId,
        hasTmdbAccountId: !!req.userConfig.tmdbAccountId,
        hasTmdbBearerToken: !!req.userConfig.tmdbBearerToken,
        hasEnvBearerToken: !!TMDB_BEARER_TOKEN,
        metadataSource: req.userConfig.metadataSource,
        tmdbLanguage: req.userConfig.tmdbLanguage,
        tmdbSessionIdValue: req.userConfig.tmdbSessionId ? 'SET' : 'NOT_SET',
        tmdbAccountIdValue: req.userConfig.tmdbAccountId ? 'SET' : 'NOT_SET',
        effectiveBearerToken: req.userConfig.tmdbBearerToken || TMDB_BEARER_TOKEN ? 'AVAILABLE' : 'NOT_AVAILABLE'
      };
      
      res.json({ success: true, debug: debugInfo });
    } catch (error) {
      console.error('Error in debug config endpoint:', error);
      res.status(500).json({ error: 'Failed to get debug info', details: error.message });
    }
  });

  // Debug endpoint for search configuration
  router.get('/debug/search-config', (req, res) => {
    const userConfig = req.userConfig || {};
    
    const debugInfo = {
      searchSources: userConfig.searchSources || [],
      mergedSearchSources: userConfig.mergedSearchSources || [],
      animeSearchEnabled: userConfig.animeSearchEnabled || false,
      hasTmdbBearerToken: !!(userConfig.tmdbBearerToken || TMDB_BEARER_TOKEN),
      hasEnvBearerToken: !!TMDB_BEARER_TOKEN,
      hasUserBearerToken: !!userConfig.tmdbBearerToken,
      
      // Configuration validation
      validation: {
        traditionalSearchValid: (userConfig.searchSources || []).length > 0,
        mergedSearchValid: (userConfig.mergedSearchSources || []).includes('tmdb') && 
                            !!(userConfig.tmdbBearerToken || TMDB_BEARER_TOKEN),
        animeSearchValid: !!userConfig.animeSearchEnabled,
      },
      
      // Expected manifest types
      expectedTypes: {
        base: ['movie', 'series', 'all'],
        search: (userConfig.mergedSearchSources || []).includes('tmdb') && 
                !!(userConfig.tmdbBearerToken || TMDB_BEARER_TOKEN) ? ['search'] : [],
        anime: userConfig.animeSearchEnabled ? ['anime'] : []
      }
    };
    
    res.json({
      success: true,
      debug: debugInfo,
      recommendations: {
        forTmdbMultiSearch: !debugInfo.validation.mergedSearchValid ? 
          'Set mergedSearchSources to ["tmdb"] and ensure TMDB Bearer Token is configured' : 'Configuration OK',
        forAnimeSearch: !debugInfo.validation.animeSearchValid ? 
          'Set animeSearchEnabled to true' : 'Configuration OK'
      }
    });
  });

  // Temporary endpoint to fix search configuration
  router.post('/debug/fix-search-config', (req, res) => {
    const userConfig = req.userConfig || {};
    
    // Enable all search features with TMDB bearer token available
    userConfig.searchSources = ['cinemeta', 'tmdb'];  // Enable traditional search
    userConfig.mergedSearchSources = ['tmdb'];        // Enable TMDB Multi Search  
    userConfig.animeSearchEnabled = true;             // Enable Anime Search
    
    // Save the updated configuration
    req.userConfig = userConfig;
    
    res.json({
      success: true,
      message: 'Search configuration has been fixed!',
      updated: {
        searchSources: userConfig.searchSources,
        mergedSearchSources: userConfig.mergedSearchSources,
        animeSearchEnabled: userConfig.animeSearchEnabled
      },
      instructions: 'Now refresh your addon manifest to see all search catalogs.'
    });
  });

  return router;
};