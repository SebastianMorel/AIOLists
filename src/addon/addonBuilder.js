// src/addon/addonBuilder.js
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchTraktListItems, fetchTraktLists, initTraktApi } = require('../integrations/trakt');
const { fetchListItems: fetchMDBListItems, fetchAllLists: fetchAllMDBLists, fetchAllListsForUser } = require('../integrations/mdblist');
const { fetchExternalAddonItems } = require('../integrations/externalAddons');
const { convertToStremioFormat } = require('./converters');
const { isWatchlist } = require('../utils/common');
const { staticGenres, MANIFEST_GENERATION_CONCURRENCY, ENABLE_MANIFEST_CACHE } = require('../config');
const axios = require('axios');

// Cache for manifest generation to avoid re-processing unchanged lists
const manifestCache = new Map();
const MANIFEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getManifestCacheKey(userConfig) {
  // Create a hash-like key from user configuration that affects manifest generation
  const cacheableConfig = {
    apiKey: !!userConfig.apiKey,
    traktAccessToken: !!userConfig.traktAccessToken,
    tmdbSessionId: !!userConfig.tmdbSessionId,
    listOrder: userConfig.listOrder,
    hiddenLists: userConfig.hiddenLists,
    removedLists: userConfig.removedLists,
    customListNames: userConfig.customListNames,
    customMediaTypeNames: userConfig.customMediaTypeNames,
    mergedLists: userConfig.mergedLists,
    importedAddons: Object.keys(userConfig.importedAddons || {}),
    enableRandomListFeature: userConfig.enableRandomListFeature,
    metadataSource: userConfig.metadataSource,
    tmdbLanguage: userConfig.tmdbLanguage, // Include language in cache key
    tmdbBearerToken: !!userConfig.tmdbBearerToken // Include token presence in cache key
  };
  return JSON.stringify(cacheableConfig);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const METADATA_FETCH_RETRY_DELAY_MS = 5000;
const MAX_METADATA_FETCH_RETRIES = 2;
const DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS = 500;

// Lightweight metadata checking without full enrichment
async function getLightweightListMetadata(listId, userConfig, type = 'all') {
  console.log(`[METADATA LIGHT] Starting lightweight check for ${listId} (type: ${type})`);
  const startTime = Date.now();
  
  try {
    // Create a minimal config for metadata checking only
    const lightweightConfig = {
      ...userConfig,
      rpdbApiKey: null, // Skip RPDB during manifest
      metadataSource: 'none', // Skip metadata enrichment
      customMediaTypeNames: {}
    };
    
    // Fetch just the raw list data without enrichment
    const content = await fetchListContent(listId, lightweightConfig, 0, null, type);
    
    const endTime = Date.now();
    console.log(`[METADATA LIGHT] Lightweight check completed in ${endTime - startTime}ms for ${listId}: movies=${content?.hasMovies || false}, shows=${content?.hasShows || false}`);
    
    return {
      hasMovies: content?.hasMovies || false,
      hasShows: content?.hasShows || false,
      itemCount: content?.allItems?.length || 0
    };
  } catch (error) {
    const endTime = Date.now();
    console.error(`[METADATA LIGHT] Lightweight check failed in ${endTime - startTime}ms for ${listId}:`, error.message);
    return {
      hasMovies: false,
      hasShows: false,
      itemCount: 0,
      error: error.message
    };
  }
}

const getManifestCatalogName = (listId, originalName, customListNames) => {
  const customPencilName = customListNames?.[listId]?.trim();
  if (customPencilName) {
    return customPencilName;
  }
  return originalName;
};

async function fetchListContent(listId, userConfig, skip = 0, genre = null, stremioCatalogType = 'all') {
  const fetchContentStartTime = Date.now();
  console.log(`[FETCH PERF] Starting fetchListContent for ${listId} (skip: ${skip}, type: ${stremioCatalogType})`);
  
  const catalogIdFromRequest = String(listId);

  if (catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_')) {
    const initTraktStartTime = Date.now();
    await initTraktApi(userConfig);
    console.log(`[FETCH PERF] Trakt API init took ${Date.now() - initTraktStartTime}ms for ${listId}`);
  }

  const { apiKey, traktAccessToken, listsMetadata = {}, sortPreferences = {}, importedAddons = {}, rpdbApiKey, randomMDBListUsernames, enableRandomListFeature, customMediaTypeNames = {} } = userConfig;
  
  let itemTypeHintForFetching = (stremioCatalogType === 'movie' || stremioCatalogType === 'series') ? stremioCatalogType : 'all';

  let originalListIdForSortLookup = catalogIdFromRequest;
  const addonDetails = importedAddons?.[catalogIdFromRequest];
  const isUrlImport = addonDetails && (addonDetails.isMDBListUrlImport || addonDetails.isTraktPublicList);

  if (catalogIdFromRequest.startsWith('aiolists-') && (catalogIdFromRequest.includes('-L') || catalogIdFromRequest.includes('-E') || catalogIdFromRequest.includes('-W'))) {
    const parts = catalogIdFromRequest.split('-');
    if (parts.length >= 2) originalListIdForSortLookup = parts[1] === 'watchlist' ? 'watchlist' : parts[1];
  } else if (isUrlImport) {
    if (addonDetails.isMDBListUrlImport) originalListIdForSortLookup = addonDetails.mdblistId;
    else if (addonDetails.isTraktPublicList) originalListIdForSortLookup = addonDetails.id; 
    else originalListIdForSortLookup = addonDetails.id;
  } else if (catalogIdFromRequest === 'random_mdblist_catalog') {
    originalListIdForSortLookup = 'random_mdblist_catalog';
  } else if (importedAddons) {
      let found = false;
      for (const addon of Object.values(importedAddons)) {
          if (addon.isMDBListUrlImport || addon.isTraktPublicList) continue;
          const foundCatalog = addon.catalogs?.find(c => c.id === catalogIdFromRequest);
          if (foundCatalog) {
              originalListIdForSortLookup = foundCatalog.originalId;
              found = true;
              break;
          }
      }
      if (!found && !originalListIdForSortLookup.startsWith('trakt_') && originalListIdForSortLookup !== 'random_mdblist_catalog') {
        originalListIdForSortLookup = catalogIdFromRequest;
      }
  }

  const sortPrefsForImportedOrRandom = userConfig.sortPreferences?.[originalListIdForSortLookup] ||
                               ( (catalogIdFromRequest.startsWith('traktpublic_') || (addonDetails?.isTraktPublicList && originalListIdForSortLookup?.startsWith('traktpublic_'))) ?
                                 { sort: 'rank', order: 'asc' } : { sort: 'default', order: 'desc' } );

  let itemsResult;

  if (catalogIdFromRequest === 'random_mdblist_catalog' && enableRandomListFeature && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    const randomUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
    
    if (apiKey) {
      // Use API-based approach when API key is available
      const userLists = await fetchAllListsForUser(apiKey, randomUsername);
      if (userLists && userLists.length > 0) {
        const randomUserList = userLists[Math.floor(Math.random() * userLists.length)];
        const listIdentifierToFetch = randomUserList.slug || String(randomUserList.id);
        const randomCatalogSortPrefs = sortPreferences?.['random_mdblist_catalog'] || { sort: 'default', order: 'desc' };
        itemsResult = await fetchMDBListItems( listIdentifierToFetch, apiKey, {}, skip, randomCatalogSortPrefs.sort, randomCatalogSortPrefs.order, false, genre, randomUsername, false, userConfig );
      } else {
        itemsResult = { allItems: [], hasMovies: false, hasShows: false };
      }
    } else {
      // Fallback to public JSON approach when no API key is available
      console.log(`[Random MDBList] No API key available, using public JSON approach for user: ${randomUsername}`);
      
      // For public JSON, we'll use a predefined list of popular/well-known lists
      // This is a simplified approach since we can't discover lists without an API key
      const popularListSlugs = [
        'latest-tv-shows', 'top-rated-movies-2024', 'latest-movies', 'popular-series', 
        'trending-movies', 'best-sci-fi-movies', 'top-horror-movies', 'classic-movies',
        'marvel-movies', 'disney-movies', 'netflix-series', 'hbo-series'
      ];
      
      const randomListSlug = popularListSlugs[Math.floor(Math.random() * popularListSlugs.length)];
      const randomCatalogSortPrefs = sortPreferences?.['random_mdblist_catalog'] || { sort: 'rank', order: 'asc' };
      
      console.log(`[Random MDBList] Attempting to fetch ${randomUsername}/${randomListSlug} via public JSON`);
      
      // Try to fetch using public JSON
      const { fetchListItemsFromPublicJson } = require('../integrations/mdblist');
      itemsResult = await fetchListItemsFromPublicJson(randomUsername, randomListSlug, skip, randomCatalogSortPrefs.sort, randomCatalogSortPrefs.order, genre, userConfig, false);
      
      if (!itemsResult) {
        console.log(`[Random MDBList] Public JSON failed for ${randomUsername}/${randomListSlug}, trying alternative`);
        // Try another random combination
        const altUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
        const altListSlug = popularListSlugs[Math.floor(Math.random() * popularListSlugs.length)];
        itemsResult = await fetchListItemsFromPublicJson(altUsername, altListSlug, skip, randomCatalogSortPrefs.sort, randomCatalogSortPrefs.order, genre, userConfig, false);
      }
      
      if (!itemsResult) {
        console.log(`[Random MDBList] All public JSON attempts failed, returning empty result`);
        itemsResult = { allItems: [], hasMovies: false, hasShows: false };
      }
    }
  }

  if (!itemsResult && isUrlImport) {
    const addonConfig = importedAddons[catalogIdFromRequest];
    if (addonConfig.isTraktPublicList) {
      itemsResult = await fetchTraktListItems( addonConfig.id, userConfig, skip, sortPrefsForImportedOrRandom.sort, sortPrefsForImportedOrRandom.order, true, addonConfig.traktUser, itemTypeHintForFetching, genre );
    } else if (addonConfig.isMDBListUrlImport) {
      if (apiKey) {
        // Use API approach when available
        const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
        itemsResult = await fetchMDBListItems( addonConfig.mdblistId, apiKey, listsMetadata, skip, sortPrefsForImportedOrRandom.sort, sortPrefsForImportedOrRandom.order, true, genre, null, isListUserMerged, userConfig );
      } else if (addonConfig.mdblistUsername && addonConfig.mdblistSlug) {
        // Use public JSON fallback when no API key is available
        console.log(`[MDBList URL Import] No API key, using public JSON for ${addonConfig.mdblistUsername}/${addonConfig.mdblistSlug}`);
        const { fetchListItemsFromPublicJson } = require('../integrations/mdblist');
        const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
        itemsResult = await fetchListItemsFromPublicJson(
          addonConfig.mdblistUsername, 
          addonConfig.mdblistSlug, 
          skip, 
          sortPrefsForImportedOrRandom.sort, 
          sortPrefsForImportedOrRandom.order, 
          genre, 
          userConfig,
          isListUserMerged
        );
      }
    }
  }

  if (!itemsResult && importedAddons) {
    for (const parentAddon of Object.values(importedAddons)) {
      if (parentAddon.isMDBListUrlImport || parentAddon.isTraktPublicList) continue;
      const catalogEntry = parentAddon.catalogs?.find(c => String(c.id) === String(catalogIdFromRequest));
      if (catalogEntry) {
        const externalResult = await fetchExternalAddonItems( catalogEntry.originalId, catalogEntry.originalType, parentAddon, skip, rpdbApiKey, genre, userConfig );
        // Convert external addon format to standard format for enrichment
        if (externalResult && externalResult.metas) {
          itemsResult = {
            allItems: externalResult.metas,
            hasMovies: externalResult.hasMovies,
            hasShows: externalResult.hasShows,
            hasChannels: externalResult.hasChannels,
            hasContent: externalResult.hasContent
          };
        }
        break;
      }
    }
  }

  if (!itemsResult && catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_') && traktAccessToken) {
    let sortPrefs = sortPreferences?.[originalListIdForSortLookup] || (catalogIdFromRequest.startsWith('trakt_watchlist') ? { sort: 'added', order: 'desc'} : { sort: 'rank', order: 'asc' });
    if (catalogIdFromRequest === 'trakt_watchlist' && itemTypeHintForFetching === 'all') { sortPrefs.sort = 'added'; } 
    
    let actualTraktItemTypeHint = itemTypeHintForFetching;
    if (itemTypeHintForFetching === 'all') {
        if (catalogIdFromRequest.includes("_movies")) actualTraktItemTypeHint = 'movie';
        else if (catalogIdFromRequest.includes("_shows")) actualTraktItemTypeHint = 'series';
    }
    itemsResult = await fetchTraktListItems( catalogIdFromRequest, userConfig, skip, sortPrefs.sort, sortPrefs.order, false, null, actualTraktItemTypeHint, genre );
  }

  if (!itemsResult && catalogIdFromRequest.startsWith('tmdb_') && userConfig.tmdbSessionId) {
    const { fetchTmdbListItems } = require('../integrations/tmdb');
    let sortPrefs = sortPreferences?.[originalListIdForSortLookup] || { sort: 'created_at', order: 'desc' };
    itemsResult = await fetchTmdbListItems(catalogIdFromRequest, userConfig, skip, sortPrefs.sort, sortPrefs.order, genre);
  }

  if (!itemsResult && apiKey && catalogIdFromRequest.startsWith('aiolists-')) {
    const match = catalogIdFromRequest.match(/^aiolists-([^-]+(?:-[^-]+)*)-([ELW])$/);
    let mdbListOriginalIdFromCatalog = match ? match[1] : catalogIdFromRequest.replace(/^aiolists-/, '').replace(/-[ELW]$/, '');
    if (catalogIdFromRequest === 'aiolists-watchlist-W') { mdbListOriginalIdFromCatalog = 'watchlist'; }
    const mdbListSortPrefs = sortPreferences?.[mdbListOriginalIdFromCatalog] || { sort: 'default', order: 'desc' };
    let sortForMdbList = mdbListSortPrefs.sort;
    if (mdbListOriginalIdFromCatalog === 'watchlist' && itemTypeHintForFetching === 'all') { sortForMdbList = 'added'; }
    const isListUserMerged = userConfig.mergedLists?.[catalogIdFromRequest] !== false;
    itemsResult = await fetchMDBListItems( mdbListOriginalIdFromCatalog, apiKey, listsMetadata, skip, sortForMdbList, mdbListSortPrefs.order, false, genre, null, isListUserMerged, userConfig );
  }
  const finalResult = itemsResult || null;
  const fetchContentEndTime = Date.now();
  console.log(`[FETCH PERF] fetchListContent completed in ${fetchContentEndTime - fetchContentStartTime}ms for ${listId}`);
  if (finalResult) {
    console.log(`[FETCH PERF] Returned ${finalResult.allItems?.length || 0} items for ${listId}`);
  }
  return finalResult;
}


async function createAddon(userConfig) {
  console.log('[ADDON BUILDER] Starting addon creation - this involves fetching all lists');
  const startTime = Date.now();
  
  // Check manifest cache first (if enabled)
  if (ENABLE_MANIFEST_CACHE) {
    const cacheKey = getManifestCacheKey(userConfig);
    const cachedManifest = manifestCache.get(cacheKey);
    
    if (cachedManifest && (Date.now() - cachedManifest.timestamp) < MANIFEST_CACHE_TTL) {
      const cacheAge = Math.round((Date.now() - cachedManifest.timestamp) / 1000);
      console.log(`[ADDON BUILDER] Using cached manifest (${cacheAge}s old) - skipping list processing`);
      return cachedManifest.addon;
    }
  }
  
  await initTraktApi(userConfig);
  
  // Detect if any imported addons provide stream resources
  let hasExternalStreamProviders = false;
  let externalIdPrefixes = new Set(['tt', 'tmdb:']);
  
  if (userConfig.importedAddons) {
    Object.values(userConfig.importedAddons).forEach(addon => {
      if (addon.resources && addon.resources.includes('stream')) {
        hasExternalStreamProviders = true;
        console.log(`[AddonBuilder] External addon ${addon.name} provides stream resources`);
      }
      // Add ID prefixes from external addons
      if (addon.idPrefixes && Array.isArray(addon.idPrefixes)) {
        addon.idPrefixes.forEach(prefix => externalIdPrefixes.add(prefix));
      }
    });
  }
  
  const manifest = {
    id: 'org.stremio.aiolists',
    version: `1.2.4-${Date.now()}`,
    name: 'AIOLists',
    description: 'Manage all your lists in one place.',
    resources: hasExternalStreamProviders ? ['catalog', 'meta', 'stream'] : ['catalog', 'meta'],
    types: [], // Will be populated dynamically
    idPrefixes: Array.from(externalIdPrefixes),
    catalogs: [],
    logo: `https://i.imgur.com/DigFuAQ.png`,
    behaviorHints: { configurable: true, configurationRequired: false }
  };

  const {
    apiKey, traktAccessToken, listOrder = [], hiddenLists = [], removedLists = [],
    customListNames = {}, customMediaTypeNames = {}, mergedLists = {}, importedAddons = {}, listsMetadata = {},
    disableGenreFilter, enableRandomListFeature, randomMDBListUsernames
  } = userConfig;

  const allKnownTypes = new Set(['movie', 'series', 'tv', 'channel', 'all']);

  // Add search type if search functionality is enabled
  const searchSources = userConfig.searchSources || ['cinemeta'];
  const mergedSearchSources = userConfig.mergedSearchSources || [];
  
  // Add search types based on configuration
  if (searchSources.length > 0) {
    // Traditional search is enabled, no additional type needed (uses movie/series)
  }
  
  const mergedSearchSourcesForTypes = userConfig.mergedSearchSources || [];
  if (mergedSearchSourcesForTypes.includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)) {
    allKnownTypes.add('search'); // For merged search
    console.log(`[AddonBuilder] Added 'search' type to manifest for merged search`);
  }
  
  if (userConfig.animeSearchEnabled) {
    allKnownTypes.add('anime'); // For anime search
    console.log(`[AddonBuilder] Added 'anime' type to manifest for anime search`);
  }

  // Add types from customMediaTypeNames (user overrides)
  Object.values(userConfig.customMediaTypeNames || {}).forEach(type => {
      if (type && typeof type === 'string') {
          allKnownTypes.add(type);
      }
  });

  // Add types from imported addon catalogs themselves and their declared types
  if (userConfig.importedAddons) {
      Object.values(userConfig.importedAddons).forEach(addon => {
          // Types from the catalogs within the addon
          if (addon.catalogs && Array.isArray(addon.catalogs)) {
              addon.catalogs.forEach(catalog => {
                  if (catalog.type && typeof catalog.type === 'string') {
                      allKnownTypes.add(catalog.type.toLowerCase());
                  }
              });
          }
          // Types declared in the imported addon's manifest.types array
          if (addon.types && Array.isArray(addon.types)) {
              addon.types.forEach(type => {
                   if (type && typeof type === 'string') {
                      allKnownTypes.add(type.toLowerCase());
                  }
              });
          }
      });
  }
  manifest.types = Array.from(allKnownTypes);

  const includeGenresInManifest = !disableGenreFilter;
  const hiddenListsSet = new Set(hiddenLists.map(String));
  const removedListsSet = new Set(removedLists.map(String));
  
  // Determine which genres to use based on metadata source and language
  const shouldUseTmdbGenres = userConfig.metadataSource === 'tmdb' && userConfig.tmdbLanguage && userConfig.tmdbBearerToken;
  const shouldUseTmdbLanguageGenres = userConfig.tmdbLanguage && userConfig.tmdbLanguage !== 'en-US' && userConfig.tmdbBearerToken;
  let availableGenres = staticGenres;
  
  if (shouldUseTmdbGenres || shouldUseTmdbLanguageGenres) {
    try {
      const { fetchTmdbGenres } = require('../integrations/tmdb');
      const genreLanguage = userConfig.tmdbLanguage || 'en-US';
      console.log(`[ADDON BUILDER] Fetching TMDB genres for language: ${genreLanguage}`);
      
      const tmdbGenres = await Promise.race([
        fetchTmdbGenres(genreLanguage, userConfig.tmdbBearerToken),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB genres timeout')), 5000))
      ]);
      if (tmdbGenres.length > 0) {
        availableGenres = tmdbGenres;
        console.log(`[ADDON BUILDER] Using ${tmdbGenres.length} TMDB genres in ${genreLanguage}`);
      }
    } catch (error) {
      console.warn('Failed to fetch TMDB genres, falling back to static genres:', error.message);
    }
  }
  
  let tempGeneratedCatalogs = [];

  if (enableRandomListFeature && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    const randomCatalogId = 'random_mdblist_catalog';
    let randomCatalogDisplayName = getManifestCatalogName(randomCatalogId, "Discovery", customListNames);
     if (customMediaTypeNames?.[randomCatalogId]){
        randomCatalogDisplayName = customMediaTypeNames[randomCatalogId];
     }
    
    // Add note to name if no API key is available (will use public JSON)
    if (!apiKey) {
      randomCatalogDisplayName += " (Public)";
    }
    
    const randomCatalogExtra = [{ name: "skip" }];
    if (includeGenresInManifest) {
        randomCatalogExtra.push({ name: "genre", options: availableGenres, isRequired: false });
    }
    tempGeneratedCatalogs.push({
        id: randomCatalogId,
        type: customMediaTypeNames?.[randomCatalogId] || 'all',
        name: randomCatalogDisplayName,
        extra: randomCatalogExtra,
        extraSupported: randomCatalogExtra.map(e => e.name)
    });
  }

  let activeListsInfo = [];
  if (apiKey) {
    console.log('[ADDON BUILDER] Fetching MDBList lists...');
    const mdbLists = await fetchAllMDBLists(apiKey);
    activeListsInfo.push(...mdbLists.map(l => ({ ...l, source: 'mdblist', originalId: String(l.id) })));
    console.log(`[ADDON BUILDER] Fetched ${mdbLists.length} MDBList lists`);
  }
  if (traktAccessToken) {
    console.log('[ADDON BUILDER] Fetching Trakt lists...');
    const traktFetchedLists = await fetchTraktLists(userConfig); // This might modify userConfig (token refresh)
    activeListsInfo.push(...traktFetchedLists.map(l => ({ ...l, source: 'trakt', originalId: String(l.id) })));
    console.log(`[ADDON BUILDER] Fetched ${traktFetchedLists.length} Trakt lists`);
  }
  
  if (userConfig.tmdbSessionId && userConfig.tmdbAccountId) {
    try {
      const { fetchTmdbLists } = require('../integrations/tmdb');
      const tmdbResult = await Promise.race([
        fetchTmdbLists(userConfig),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB lists timeout')), 5000))
      ]);
      if (tmdbResult.isConnected && tmdbResult.lists && tmdbResult.lists.length > 0) {
        activeListsInfo.push(...tmdbResult.lists.map(l => ({ ...l, source: 'tmdb', originalId: String(l.id) })));
      }
    } catch (error) {
      console.warn('Failed to fetch TMDB lists:', error.message);
    }
  }
  
  const processListForManifest = async (listSourceInfo, currentListId, isImportedSubCatalog = false, parentAddon = null) => {
    if (removedListsSet.has(currentListId)) {
        return;
    }

    const isHidden = hiddenListsSet.has(currentListId);
    let originalName = listSourceInfo.name;
    let displayName = getManifestCatalogName(currentListId, originalName, customListNames);

    const catalogExtraForThisList = [{ name: "skip" }];
            if (includeGenresInManifest) {
            let genreOpts = availableGenres;
            
            // For imported catalogs (both sub-catalogs and direct addon imports), try to use genres from the addon manifest
            if (isImportedSubCatalog && listSourceInfo.extraSupported && Array.isArray(listSourceInfo.extraSupported)) {
                const genreExtraDef = listSourceInfo.extraSupported.find(e => typeof e === 'object' && e.name === 'genre');
                if (genreExtraDef && Array.isArray(genreExtraDef.options) && genreExtraDef.options.length > 0) {
                    genreOpts = genreExtraDef.options;
                    console.log(`[AddonBuilder] Using external addon genres for ${currentListId}:`, genreOpts);
                }
            }
            // For direct external addon imports, check the parent addon for genres
            else if (parentAddon && parentAddon.catalogs) {
                const catalogWithGenres = parentAddon.catalogs.find(cat => 
                    cat.extraSupported && cat.extraSupported.some(extra => 
                        extra.name === 'genre' && extra.options && extra.options.length > 0
                    )
                );
                if (catalogWithGenres) {
                    const genreExtra = catalogWithGenres.extraSupported.find(e => e.name === 'genre');
                    if (genreExtra.options && genreExtra.options.length > 0) {
                        genreOpts = genreExtra.options;
                        console.log(`[AddonBuilder] Using external addon genres from parent for ${currentListId}:`, genreOpts);
                    }
                }
            }
            
            catalogExtraForThisList.push({
                name: "genre",
                options: genreOpts,
                isRequired: isHidden
            });
        }

    const baseCatalogProps = {
        extra: catalogExtraForThisList,
        extraSupported: catalogExtraForThisList.map(e => e.name),
    };

    if (isImportedSubCatalog) {
        const manifestCatalogType = customMediaTypeNames?.[currentListId] || listSourceInfo.type;
        
        console.log(`[AddonBuilder] ===== IMPORTED SUB-CATALOG DEBUG =====`);
        console.log(`[AddonBuilder] Processing imported sub-catalog ${currentListId}`);
        console.log(`[AddonBuilder] listSourceInfo.type: "${listSourceInfo.type}"`);
        console.log(`[AddonBuilder] customMediaTypeNames[${currentListId}]: "${customMediaTypeNames?.[currentListId]}"`);
        console.log(`[AddonBuilder] manifestCatalogType (final): "${manifestCatalogType}"`);
        console.log(`[AddonBuilder] Creating catalog with type: "${manifestCatalogType}"`);
        console.log(`[AddonBuilder] ===================================`);

        if (!manifestCatalogType) {
          console.warn(`[AIOLists AddonBuilder] Manifest catalog type for imported sub-catalog ${currentListId} is undefined (source type: ${listSourceInfo.type}). Skipping.`);
          return;
        }
        if (!displayName) {
          console.warn(`[AIOLists AddonBuilder] Display name for imported sub-catalog ${currentListId} is undefined. Skipping.`);
          return;
        }

        const finalCatalog = {
            id: currentListId,
            type: manifestCatalogType,
            name: displayName,
            ...baseCatalogProps
        };
        
        console.log(`[AddonBuilder] ===== FINAL CATALOG CREATED =====`);
        console.log(`[AddonBuilder] Final catalog object:`, JSON.stringify(finalCatalog, null, 2));
        console.log(`[AddonBuilder] ===============================`);
        
        tempGeneratedCatalogs.push(finalCatalog);
        return; 
    }

    let sourceHasMovies, sourceHasShows;
    if (listSourceInfo.source === 'mdblist' || listSourceInfo.source === 'mdblist_url') {
      // Check both the list info and stored metadata for MDBList lists
      let metadata = userConfig.listsMetadata[currentListId] || userConfig.listsMetadata[listSourceInfo.originalId] || {};
      sourceHasMovies = listSourceInfo.hasMovies || metadata.hasMovies === true;
      sourceHasShows = listSourceInfo.hasShows || metadata.hasShows === true;
      

  } else if (listSourceInfo.source === 'trakt_public') {
      sourceHasMovies = listSourceInfo.hasMovies;
      sourceHasShows = listSourceInfo.hasShows;
  } else if (listSourceInfo.source === 'trakt') { // This now only handles private trakt
      let metadata = userConfig.listsMetadata[currentListId] || userConfig.listsMetadata[listSourceInfo.originalId] || {};
      sourceHasMovies = metadata.hasMovies === true;
      sourceHasShows = metadata.hasShows === true;

        if (listSourceInfo.source === 'trakt' && (typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean' || metadata.errorFetching) && traktAccessToken) {
            let success = false; let fetchRetries = 0; if(metadata.errorFetching) delete metadata.errorFetching;
            while (!success && fetchRetries < MAX_METADATA_FETCH_RETRIES) {
                try {
                    const tempUserConfigForMetadata = { ...userConfig, listsMetadata: {}, rpdbApiKey: null, customMediaTypeNames: {} }; // Pass a clean config for fetching
                    let typeForMetaCheck = 'all';
                     if (currentListId.startsWith('trakt_recommendations_') || currentListId.startsWith('trakt_trending_') || currentListId.startsWith('trakt_popular_')) {
                        if (currentListId.includes("_shows")) typeForMetaCheck = 'series'; else if (currentListId.includes("_movies")) typeForMetaCheck = 'movie';
                    }
                    if (currentListId === 'trakt_watchlist') typeForMetaCheck = 'all'; // Watchlist can have mixed types

                    const content = await fetchListContent(currentListId, tempUserConfigForMetadata, 0, null, typeForMetaCheck);
                    sourceHasMovies = content?.hasMovies || false;
                    sourceHasShows = content?.hasShows || false;
                    
                    const currentMetaForUpdate = userConfig.listsMetadata[currentListId] || {}; // Ensure listsMetadata exists
                    userConfig.listsMetadata[currentListId] = {
                        ...currentMetaForUpdate, hasMovies: sourceHasMovies, hasShows: sourceHasShows, lastChecked: new Date().toISOString()
                    };
                    delete userConfig.listsMetadata[currentListId].errorFetching;
                    success = true;
                } catch (error) {
                    fetchRetries++;
                    console.error(`Metadata fetch attempt ${fetchRetries} for Trakt list ${currentListId} failed:`, error.message);
                    if (fetchRetries >= MAX_METADATA_FETCH_RETRIES) {
                        const fallbackMeta = userConfig.listsMetadata[currentListId] || {};
                        sourceHasMovies = fallbackMeta.hasMovies || false;
                        sourceHasShows = fallbackMeta.hasShows || false;
                        userConfig.listsMetadata[currentListId] = { ...fallbackMeta, errorFetching: true, lastChecked: new Date().toISOString() };
                         console.error(`Failed to fetch metadata for ${currentListId} after ${MAX_METADATA_FETCH_RETRIES} retries. Using potentially stale data.`);
                    } else { 
                        await delay(METADATA_FETCH_RETRY_DELAY_MS * Math.pow(2, fetchRetries - 1)); 
                    }
                }
            }
            if (traktAccessToken && activeListsInfo.length > 1 && activeListsInfo.some(l => l.source === 'trakt')) { // Ensure there's a next Trakt list
                 await delay(DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS);
            }
        }
    } else if (listSourceInfo.source === 'tmdb') {
      // Handle TMDB lists - use the hasMovies/hasShows values that were determined earlier
      sourceHasMovies = listSourceInfo.hasMovies || false;
      sourceHasShows = listSourceInfo.hasShows || false;
    } else { // Fallback if source type is unknown or properties missing
        sourceHasMovies = listSourceInfo.hasMovies || false;
        sourceHasShows = listSourceInfo.hasShows || false;
        // For external addons with TV/channel content, check for those types
        const sourceHasChannels = listSourceInfo.hasChannels || false;
        const sourceHasTv = listSourceInfo.hasTv || false;
        const sourceHasContent = listSourceInfo.hasContent || false;
        
        // If this is a TV/channel addon, we don't treat it as movies/shows
        if (sourceHasChannels || sourceHasTv || (sourceHasContent && !sourceHasMovies && !sourceHasShows)) {
            // This appears to be a TV channel addon - don't force it into movie/series categorization
            console.log(`[AddonBuilder] Detected TV/channel content for ${currentListId}: hasChannels=${sourceHasChannels}, hasTv=${sourceHasTv}, hasContent=${sourceHasContent}`);
        }
    }

    const sourceIsStructurallyMergeable = sourceHasMovies && sourceHasShows;
    const customUserDefinedType = customMediaTypeNames?.[currentListId];
    
    // Check for any content (including TV/channel content)
    const sourceHasChannels = listSourceInfo.hasChannels || false;
    const sourceHasTv = listSourceInfo.hasTv || false;
    const sourceHasContent = listSourceInfo.hasContent || false;
    
    if (!sourceHasMovies && !sourceHasShows && !sourceHasChannels && !sourceHasTv && !sourceHasContent && !customUserDefinedType) {
        // If no content and no custom type, don't add catalog (unless it's explicitly an 'all' type list with no content yet)
        if (listSourceInfo.type !== 'all' || (listSourceInfo.type === 'all' && (listSourceInfo.hasMovies === false && listSourceInfo.hasShows === false))) {
             console.warn(`[AIOLists AddonBuilder] List ${currentListId} ('${displayName}') has no content and no custom type. Skipping manifest entry.`);
             return;
        }
    }
    
    const isUserMerged = sourceIsStructurallyMergeable ? (mergedLists[currentListId] !== false) : false;

    if (isUserMerged && sourceIsStructurallyMergeable) {
        const catalogType = customUserDefinedType || 'all';
        tempGeneratedCatalogs.push({ id: currentListId, type: catalogType, name: displayName, ...baseCatalogProps });
    } else if (!isUserMerged && sourceIsStructurallyMergeable) {
        let movieCatalogName = displayName;
        let seriesCatalogName = displayName;
        if (customUserDefinedType) {
            movieCatalogName = `${displayName}`;
            seriesCatalogName = `${displayName}`;
        }
        if (sourceHasMovies) {
            tempGeneratedCatalogs.push({ id: currentListId, type: 'movie', name: movieCatalogName, ...baseCatalogProps });
        }
        if (sourceHasShows) {
            tempGeneratedCatalogs.push({ id: currentListId, type: 'series', name: seriesCatalogName, ...baseCatalogProps });
        }
    } else {
        if (customUserDefinedType) {
             tempGeneratedCatalogs.push({ id: currentListId, type: customUserDefinedType, name: displayName, ...baseCatalogProps });
        } else {
            // For external addon catalogs, always preserve the original type from the addon manifest
            // Check if this is an external addon catalog by looking for the type in listSourceInfo
            const isExternalAddonCatalog = listSourceInfo.type && !['movie', 'series'].includes(listSourceInfo.type);
            
            if (isExternalAddonCatalog) {
                // Use the original type declared in the external addon (tv, channel, etc.)
                console.log(`[AddonBuilder] Preserving original external addon type: ${listSourceInfo.type} for ${currentListId}`);
                tempGeneratedCatalogs.push({ id: currentListId, type: listSourceInfo.type, name: displayName, ...baseCatalogProps });
            } else if (sourceHasMovies) {
                tempGeneratedCatalogs.push({ id: currentListId, type: 'movie', name: displayName, ...baseCatalogProps });
            } else if (sourceHasShows) {
                tempGeneratedCatalogs.push({ id: currentListId, type: 'series', name: displayName, ...baseCatalogProps });
            } else if (sourceHasChannels || sourceHasTv) {
                // Use the original type from the external addon (tv, channel, etc.)
                const originalType = listSourceInfo.type || 'tv';
                console.log(`[AddonBuilder] Creating catalog with original TV/channel type: ${originalType} for ${currentListId}`);
                tempGeneratedCatalogs.push({ id: currentListId, type: originalType, name: displayName, ...baseCatalogProps });
            } else if (sourceHasContent && listSourceInfo.type && !['movie', 'series'].includes(listSourceInfo.type)) {
                // For other content types (tv, channel, etc.), use the original type
                console.log(`[AddonBuilder] Creating catalog with original content type: ${listSourceInfo.type} for ${currentListId}`);
                tempGeneratedCatalogs.push({ id: currentListId, type: listSourceInfo.type, name: displayName, ...baseCatalogProps });
            } else if (listSourceInfo.type === 'all' && !customUserDefinedType) {
                tempGeneratedCatalogs.push({ id: currentListId, type: 'all', name: displayName, ...baseCatalogProps });
            }
        }
    }
  };
  
  console.log(`[AddonBuilder] Processing ${activeListsInfo.length} lists in parallel...`);
  const listProcessingStartTime = Date.now();
  
  // Process lists in parallel with controlled concurrency
  const MANIFEST_CONCURRENCY = MANIFEST_GENERATION_CONCURRENCY; // Use config value
  const MANIFEST_TIMEOUT = 15000; // 15 second timeout per list to prevent getting stuck
  const listProcessingPromises = [];
  
  // Group lists into chunks for parallel processing
  const chunks = [];
  for (let i = 0; i < activeListsInfo.length; i += MANIFEST_CONCURRENCY) {
    chunks.push(activeListsInfo.slice(i, i + MANIFEST_CONCURRENCY));
  }
  
  for (const chunk of chunks) {
    const chunkPromises = chunk.map(async (listInfo) => {
      const listStartTime = Date.now();
      
      try {
        if (listInfo.source === 'mdblist') {
            const originalMdbListId = String(listInfo.id); 
            const listTypeSuffix = listInfo.listType || 'L';
            const fullManifestListId = originalMdbListId === 'watchlist' ? 
                `aiolists-watchlist-W` : 
                `aiolists-${originalMdbListId}-${listTypeSuffix}`; 

            let listDataForProcessing = { 
                ...listInfo, 
                id: fullManifestListId,        
                originalId: originalMdbListId  
            };

            let determinedHasMovies, determinedHasShows;
            if (originalMdbListId === 'watchlist') {
                determinedHasMovies = true;
                determinedHasShows = true;
            } else {
                // First check if we have stored metadata for this list
                const existingMetadata = userConfig.listsMetadata[fullManifestListId];
                if (existingMetadata && typeof existingMetadata.hasMovies === 'boolean' && typeof existingMetadata.hasShows === 'boolean') {
                    determinedHasMovies = existingMetadata.hasMovies;
                    determinedHasShows = existingMetadata.hasShows;
                    console.log(`[AddonBuilder] Using cached metadata for ${fullManifestListId}: movies=${determinedHasMovies}, shows=${determinedHasShows}`);
                } else {
                    // Fall back to API response data
                    const moviesCount = parseInt(listInfo.movies) || 0;
                    const showsCount = parseInt(listInfo.shows) || 0;
                    determinedHasMovies = moviesCount > 0;
                    determinedHasShows = showsCount > 0;

                    if (moviesCount === 0 && showsCount === 0) {
                        const mediatype = listInfo.mediatype;
                        if (mediatype === 'movie') {
                            determinedHasMovies = true;
                        } else if (mediatype === 'show' || mediatype === 'series') {
                            determinedHasShows = true;
                        }
                    }
                    console.log(`[AddonBuilder] Determined from API data for ${fullManifestListId}: movies=${determinedHasMovies}, shows=${determinedHasShows}`);
                }
            }

            listDataForProcessing.hasMovies = determinedHasMovies;
            listDataForProcessing.hasShows = determinedHasShows;
            
            if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
            userConfig.listsMetadata[fullManifestListId] = {
                ...(userConfig.listsMetadata[fullManifestListId] || {}),
                hasMovies: determinedHasMovies,
                hasShows: determinedHasShows,
                lastChecked: new Date().toISOString()
            };
            
            await processListForManifest(listDataForProcessing, fullManifestListId, false, null);

        } else if (listInfo.source === 'trakt') {
            const currentListId = String(listInfo.id);
            let listDataForProcessing = { ...listInfo, originalId: currentListId, source: 'trakt' }; 
            await processListForManifest(listDataForProcessing, currentListId, false, null);
        } else if (listInfo.source === 'tmdb') {
            const currentListId = String(listInfo.id);
            
            // Check if we have stored metadata for this TMDB list
            let metadata = userConfig.listsMetadata[currentListId] || {};
            let determinedHasMovies = metadata.hasMovies;
            let determinedHasShows = metadata.hasShows;
            
            // If we don't have metadata, try to determine from list type
            if (typeof determinedHasMovies !== 'boolean' || typeof determinedHasShows !== 'boolean') {
                if (currentListId === 'tmdb_watchlist' || currentListId === 'tmdb_favorites') {
                    // Watchlist and favorites can contain both movies and shows
                    determinedHasMovies = true;
                    determinedHasShows = true;
                    console.log(`[AddonBuilder] Using defaults for ${currentListId}: movies=true, shows=true`);
                } else if (currentListId.startsWith('tmdb_list_')) {
                    // For custom TMDB lists, use lightweight check instead of full fetch
                    console.log(`[AddonBuilder] Using defaults for custom TMDB list ${currentListId}: movies=true, shows=true`);
                    determinedHasMovies = true;
                    determinedHasShows = true;
                } else {
                    // Default for unknown TMDB list types
                    determinedHasMovies = true;
                    determinedHasShows = true;
                }
                
                // Update metadata
                if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
                userConfig.listsMetadata[currentListId] = {
                    ...(userConfig.listsMetadata[currentListId] || {}),
                    hasMovies: determinedHasMovies,
                    hasShows: determinedHasShows,
                    lastChecked: new Date().toISOString()
                };
            } else {
                console.log(`[AddonBuilder] Using cached metadata for ${currentListId}: movies=${determinedHasMovies}, shows=${determinedHasShows}`);
            }
            
            let listDataForProcessing = { 
                ...listInfo, 
                originalId: currentListId, 
                source: 'tmdb',
                hasMovies: determinedHasMovies,
                hasShows: determinedHasShows
            };
            await processListForManifest(listDataForProcessing, currentListId, false, null);
        }
        
        const listEndTime = Date.now();
        console.log(`[AddonBuilder] Processed list ${listInfo.id || listInfo.name} in ${listEndTime - listStartTime}ms`);
        
      } catch (error) {
        console.error(`[AddonBuilder] Error processing list ${listInfo.id || listInfo.name}:`, error.message);
      }
    });
    
    // Process chunk in parallel
    await Promise.all(chunkPromises);
    
    // Small delay between chunks to avoid overwhelming APIs
    if (chunk !== chunks[chunks.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  const listProcessingEndTime = Date.now();
  console.log(`[AddonBuilder] Completed processing ${activeListsInfo.length} lists in ${listProcessingEndTime - listProcessingStartTime}ms (parallel)`);
  
  // Only process Trakt lists that need metadata checking in a separate, optimized pass
  console.log(`[AddonBuilder] Starting optimized Trakt metadata checking...`);
  const traktMetadataStartTime = Date.now();
  
  const traktListsNeedingMetadata = activeListsInfo.filter(listInfo => {
    if (listInfo.source !== 'trakt') return false;
    
    const currentListId = String(listInfo.id);
    const metadata = userConfig.listsMetadata[currentListId] || userConfig.listsMetadata[listInfo.originalId] || {};
    
    // Only check lists that don't have metadata or have error fetching
    return (typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean' || metadata.errorFetching) && traktAccessToken;
  });
  
  if (traktListsNeedingMetadata.length > 0) {
    console.log(`[AddonBuilder] Found ${traktListsNeedingMetadata.length} Trakt lists needing metadata check`);
    
    // Process these in smaller parallel batches to avoid rate limiting
    const TRAKT_METADATA_CONCURRENCY = 2; // Only 2 at a time for Trakt
    const traktChunks = [];
    for (let i = 0; i < traktListsNeedingMetadata.length; i += TRAKT_METADATA_CONCURRENCY) {
      traktChunks.push(traktListsNeedingMetadata.slice(i, i + TRAKT_METADATA_CONCURRENCY));
    }
    
    for (const traktChunk of traktChunks) {
      const traktPromises = traktChunk.map(async (listInfo) => {
        const currentListId = String(listInfo.id);
        let metadata = userConfig.listsMetadata[currentListId] || userConfig.listsMetadata[listInfo.originalId] || {};
        
        if (metadata.errorFetching) delete metadata.errorFetching;
        
        let success = false;
        let fetchRetries = 0;
        
        while (!success && fetchRetries < MAX_METADATA_FETCH_RETRIES) {
          try {
            const tempUserConfigForMetadata = { ...userConfig, listsMetadata: {}, rpdbApiKey: null, customMediaTypeNames: {} };
            let typeForMetaCheck = 'all';
            
            if (currentListId.startsWith('trakt_recommendations_') || currentListId.startsWith('trakt_trending_') || currentListId.startsWith('trakt_popular_')) {
              if (currentListId.includes("_shows")) typeForMetaCheck = 'series';
              else if (currentListId.includes("_movies")) typeForMetaCheck = 'movie';
            }
            if (currentListId === 'trakt_watchlist') typeForMetaCheck = 'all';

                         console.log(`[AddonBuilder] Checking metadata for Trakt list ${currentListId}...`);
             const lightweightMetadata = await getLightweightListMetadata(currentListId, tempUserConfigForMetadata, typeForMetaCheck);
             const sourceHasMovies = lightweightMetadata.hasMovies;
             const sourceHasShows = lightweightMetadata.hasShows;
            
            const currentMetaForUpdate = userConfig.listsMetadata[currentListId] || {};
            userConfig.listsMetadata[currentListId] = {
              ...currentMetaForUpdate,
              hasMovies: sourceHasMovies,
              hasShows: sourceHasShows,
              lastChecked: new Date().toISOString()
            };
            delete userConfig.listsMetadata[currentListId].errorFetching;
            
            console.log(`[AddonBuilder] Metadata check completed for ${currentListId}: movies=${sourceHasMovies}, shows=${sourceHasShows}`);
            success = true;
          } catch (error) {
            fetchRetries++;
            console.error(`Metadata fetch attempt ${fetchRetries} for Trakt list ${currentListId} failed:`, error.message);
            if (fetchRetries >= MAX_METADATA_FETCH_RETRIES) {
              const fallbackMeta = userConfig.listsMetadata[currentListId] || {};
              userConfig.listsMetadata[currentListId] = { 
                ...fallbackMeta, 
                hasMovies: fallbackMeta.hasMovies || false,
                hasShows: fallbackMeta.hasShows || false,
                errorFetching: true, 
                lastChecked: new Date().toISOString() 
              };
              console.error(`Failed to fetch metadata for ${currentListId} after ${MAX_METADATA_FETCH_RETRIES} retries. Using fallback data.`);
            } else { 
              await new Promise(resolve => setTimeout(resolve, METADATA_FETCH_RETRY_DELAY_MS * Math.pow(2, fetchRetries - 1)));
            }
          }
        }
      });
      
      await Promise.all(traktPromises);
      
      // Delay between Trakt chunks to respect rate limits
      if (traktChunk !== traktChunks[traktChunks.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS));
      }
    }
  }
  
  const traktMetadataEndTime = Date.now();
  console.log(`[AddonBuilder] Trakt metadata checking completed in ${traktMetadataEndTime - traktMetadataStartTime}ms`);
  

  console.log(`[AddonBuilder] Processing ${Object.keys(importedAddons || {}).length} imported addons...`);
  for (const addon of Object.values(importedAddons || {})) {
    const addonGroupId = String(addon.id);
    if (removedListsSet.has(addonGroupId) || hiddenListsSet.has(addonGroupId)) {
        continue;
    }

    const isMDBListUrlImport = !!addon.isMDBListUrlImport;
    const isTraktPublicList = !!addon.isTraktPublicList;

    if (isMDBListUrlImport || isTraktPublicList) {
      let listDataForUrlImport = {
          id: addonGroupId, // The AIOLists unique ID for this imported URL list
          name: addon.name,
          hasMovies: addon.hasMovies, // From initial import scan
          hasShows: addon.hasShows,   // From initial import scan
          source: isMDBListUrlImport ? 'mdblist_url' : 'trakt_public' // Corrected source
      };
      await processListForManifest(listDataForUrlImport, addonGroupId, false, null);

    } else if (addon.catalogs && addon.catalogs.length > 0) { 
      for (const catalog_from_imported_addon of addon.catalogs) {
        const catalogIdForManifest = String(catalog_from_imported_addon.id); 
        
        console.log(`[AddonBuilder] Processing external addon catalog: ${catalogIdForManifest}, originalType: ${catalog_from_imported_addon.type}`);
        
        if (removedListsSet.has(catalogIdForManifest) || hiddenListsSet.has(catalogIdForManifest)) {
            continue;
        }

        let subCatalogData = {
          name: catalog_from_imported_addon.name,
          type: catalog_from_imported_addon.type, 
          extraSupported: catalog_from_imported_addon.extraSupported,
          extraRequired: catalog_from_imported_addon.extraRequired,
          // No source needed here, isImportedSubCatalog=true implies it
        };
        
        console.log(`[AddonBuilder] ===== TV TYPE DEBUG =====`);
        console.log(`[AddonBuilder] Raw catalog from addon:`, JSON.stringify(catalog_from_imported_addon, null, 2));
        console.log(`[AddonBuilder] subCatalogData.type: "${subCatalogData.type}"`);
        console.log(`[AddonBuilder] catalogIdForManifest: "${catalogIdForManifest}"`);
        console.log(`[AddonBuilder] isImportedSubCatalog: true`);
        console.log(`[AddonBuilder] customMediaTypeNames for this catalog:`, userConfig.customMediaTypeNames?.[catalogIdForManifest]);
        console.log(`[AddonBuilder] ===========================`);
        await processListForManifest(subCatalogData, catalogIdForManifest, true, addon);
      }
    }
  }
  
  // Only apply custom sorting if user has explicitly reordered lists
  const hasCustomOrder = userConfig.listOrder && Array.isArray(userConfig.listOrder) && userConfig.listOrder.length > 0;
  
  if (hasCustomOrder) {
    const orderMap = new Map();
    userConfig.listOrder.forEach((id, index) => {
        orderMap.set(String(id), index);
    });

    // Create a stable sort by using the original index as a tie-breaker
    const catalogsWithIndex = tempGeneratedCatalogs.map((catalog, index) => ({ catalog, originalIndex: index }));
    
    catalogsWithIndex.sort((a, b) => {
        const idA_base = String(a.catalog.id); 
        const idB_base = String(b.catalog.id);
        const indexA = orderMap.get(idA_base);
        const indexB = orderMap.get(idB_base);

        if (indexA !== undefined && indexB !== undefined) {
            if (indexA === indexB) { 
                const typeOrder = { 'movie': 1, 'series': 2 }; // Prioritize movie then series if IDs are same
                let priorityA = typeOrder[a.catalog.type];
                let priorityB = typeOrder[b.catalog.type];
                if (customMediaTypeNames?.[idA_base] === a.catalog.type || a.catalog.type === 'all' || !priorityA ) priorityA = 0;
                if (customMediaTypeNames?.[idB_base] === b.catalog.type || b.catalog.type === 'all' || !priorityB ) priorityB = 0;
                
                if (priorityA !== priorityB) return priorityA - priorityB;
                // Final tie-breaker: maintain original order
                return a.originalIndex - b.originalIndex;
            }
            return indexA - indexB; 
        }
        if (indexA !== undefined) return -1; 
        if (indexB !== undefined) return 1;  
        // For items not in listOrder, maintain original order (stable sort)
        return a.originalIndex - b.originalIndex;
    });
    
    // Extract the sorted catalogs
    tempGeneratedCatalogs = catalogsWithIndex.map(item => item.catalog);
    
    console.log(`[AddonBuilder] Applied custom list ordering (${userConfig.listOrder.length} items in order)`);
  } else {
    console.log(`[AddonBuilder] No custom list ordering - preserving natural order (append to bottom)`);
    // No sorting whatsoever - catalogs remain in the exact order they were added
  }

  // Add search catalogs - now with three different types
  console.log(`[AddonBuilder] ========== SEARCH CATALOG DEBUG ==========`);
  console.log(`[AddonBuilder] userConfig.searchSources:`, userConfig.searchSources);
  console.log(`[AddonBuilder] userConfig.mergedSearchSources:`, userConfig.mergedSearchSources);
  console.log(`[AddonBuilder] userConfig.animeSearchEnabled:`, userConfig.animeSearchEnabled);
  console.log(`[AddonBuilder] userConfig.tmdbBearerToken:`, !!userConfig.tmdbBearerToken);
  console.log(`[AddonBuilder] process.env.TMDB_BEARER_TOKEN:`, !!process.env.TMDB_BEARER_TOKEN);
  console.log(`[AddonBuilder] require('../config').TMDB_BEARER_TOKEN:`, !!require('../config').TMDB_BEARER_TOKEN);
  console.log(`[AddonBuilder] ================================================`);
  
  // 1. Traditional Movie/Series Search
  const userSearchSources = userConfig.searchSources || [];  // Don't default to cinemeta
  let hasValidSearchSources = false;
  
  // Check if any valid search sources are enabled
  if (userSearchSources.includes('cinemeta')) {
    hasValidSearchSources = true;
  }
  if (userSearchSources.includes('trakt')) {
    hasValidSearchSources = true;
  }
  if (userSearchSources.includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)) {
    hasValidSearchSources = true;
  }
  
  // Only add traditional search catalogs if there are valid search sources
  if (hasValidSearchSources) {
    const searchCatalogExtra = [
      { name: "search", isRequired: true },
      { name: "genre", isRequired: false, options: availableGenres }
    ];
    
    // Create separate movie/series catalogs for traditional search with unique IDs
    tempGeneratedCatalogs.push({
      id: 'aiolists_search_movies',
      type: 'movie',
      name: 'Search Movies',
      extra: searchCatalogExtra,
      extraSupported: searchCatalogExtra.map(e => e.name)
    });
    
    tempGeneratedCatalogs.push({
      id: 'aiolists_search_series',
      type: 'series', 
      name: 'Search Series',
      extra: searchCatalogExtra,
      extraSupported: searchCatalogExtra.map(e => e.name)
    });
    
    console.log(`[AddonBuilder] Added traditional search catalogs with sources: ${userSearchSources.join(', ')}`);
  } else {
    console.log(`[AddonBuilder] No valid search sources configured - traditional search catalogs disabled`);
    console.log(`[AddonBuilder] Available sources: ${userSearchSources.join(', ')}`);
    console.log(`[AddonBuilder] TMDB available for traditional search: ${!!(userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)}`);
  }

  // 2. Merged Search (TMDB Multi Search)
  const userMergedSearchSources = userConfig.mergedSearchSources || [];
  let hasValidMergedSearchSources = false;
  
  // Debug logging
  console.log(`[AddonBuilder] Merged search config check - mergedSearchSources:`, userMergedSearchSources);
  console.log(`[AddonBuilder] TMDB Bearer Token available:`, !!(userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN));
  
  // Check if TMDB is available for merged search
  if (userMergedSearchSources.includes('tmdb') && (userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN)) {
    hasValidMergedSearchSources = true;
  }
  
  if (hasValidMergedSearchSources) {
    const mergedSearchCatalogExtra = [
      { name: "search", isRequired: true },
      { name: "genre", isRequired: false, options: availableGenres }
    ];
    
    // Create merged search catalog (combines movies and series)
    tempGeneratedCatalogs.push({
      id: 'aiolists_merged_search',
      type: 'search', // Custom type for merged search
      name: 'Merged Search',
      extra: mergedSearchCatalogExtra,
      extraSupported: mergedSearchCatalogExtra.map(e => e.name)
    });
    
    console.log(`[AddonBuilder] Added merged search catalog with TMDB multi search`);
  } else {
    console.log(`[AddonBuilder] TMDB not available or merged search disabled - merged search catalog disabled`);
    console.log(`[AddonBuilder] Debug: mergedSearchSources includes tmdb:`, userMergedSearchSources.includes('tmdb'));
    console.log(`[AddonBuilder] Debug: TMDB token available:`, !!(userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN));
    console.log(`[AddonBuilder] Fix: Set mergedSearchSources to ['tmdb'] and ensure TMDB Bearer Token is configured`);
  }

  // 3. Anime Search
  const animeSearchEnabled = userConfig.animeSearchEnabled || false;
  
  // Debug logging
  console.log(`[AddonBuilder] Anime search config check - animeSearchEnabled:`, animeSearchEnabled);
  
  if (animeSearchEnabled) {
    const animeSearchCatalogExtra = [
      { name: "search", isRequired: true },
      { name: "genre", isRequired: false, options: availableGenres }
    ];
    
    // Create anime search catalog
    tempGeneratedCatalogs.push({
      id: 'aiolists_anime_search',
      type: 'anime', // Custom type for anime search
      name: 'Anime Search',
      extra: animeSearchCatalogExtra,
      extraSupported: animeSearchCatalogExtra.map(e => e.name)
    });
    
    console.log(`[AddonBuilder] Added anime search catalog`);
  } else {
    console.log(`[AddonBuilder] Anime search disabled`);
    console.log(`[AddonBuilder] Fix: Set animeSearchEnabled to true in user configuration`);
  }
  
  manifest.catalogs = tempGeneratedCatalogs;
  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const catalogStartTime = Date.now();
    console.log(`[CATALOG PERF] Starting catalog request for ${id} (type: ${type})`);
    
    const skip = parseInt(extra?.skip) || 0;
    const genre = extra?.genre || null;
    const searchQuery = extra?.search || null;
    
    // Handle search catalogs
    if ((id === 'aiolists_search_movies' || id === 'aiolists_search_series' || id === 'aiolists_merged_search' || id === 'aiolists_anime_search') && searchQuery) {      
      if (!searchQuery || searchQuery.trim().length < 2) {
        return Promise.resolve({ metas: [] });
      }

      try {
        const { searchContent } = require('../utils/searchEngine');
        let searchResults;

        if (id === 'aiolists_merged_search') {
          // Merged search using TMDB multi search
          console.log(`[Search] Handling merged search for "${searchQuery}"`);
          
          searchResults = await searchContent({
            query: searchQuery.trim(),
            type: 'search', // Use search type for merged search
            sources: ['multi'], // Use multi source for merged search
            limit: 50,
            userConfig: userConfig
          });
        } else if (id === 'aiolists_anime_search') {
          // Anime search using Kitsu API
          console.log(`[Search] Handling anime search for "${searchQuery}"`);
          
          searchResults = await searchContent({
            query: searchQuery.trim(),
            type: 'anime', // Use anime type for anime search
            sources: ['anime'], // Use anime source for anime search
            limit: 50,
            userConfig: userConfig
          });
        } else {
          // Traditional movie/series search
          console.log(`[Search] Handling traditional search for "${searchQuery}" (catalog: ${id})`);
          
          // Determine search sources based on user configuration
          const userSearchSources = userConfig.searchSources || [];
          let sources = [];
          
          // Individual search sources mode (multi search is disabled)
          if (userSearchSources.includes('cinemeta')) {
            sources.push('cinemeta');
          }
          if (userSearchSources.includes('trakt')) {
            sources.push('trakt');
          }
          if (userSearchSources.includes('tmdb') && (userConfig.tmdbBearerToken || userConfig.tmdbSessionId)) {
            sources.push('tmdb');
          }
          
          // If no valid sources are configured, return empty results
          if (sources.length === 0) {
            console.log(`[Search] No valid search sources configured, returning empty results`);
            return Promise.resolve({ metas: [] });
          }

          // Use the type for search
          const searchType = type || 'all';
          
          searchResults = await searchContent({
            query: searchQuery.trim(),
            type: searchType,
            sources: sources,
            limit: 50,
            userConfig: userConfig
          });
        }

        // Filter results by type and genre if specified
        let filteredMetas = searchResults.results || [];
        
        // Filter by type if specified (only for traditional search)
        if ((id === 'aiolists_search_movies' || id === 'aiolists_search_series') && type && type !== 'all' && type !== 'search') {
          filteredMetas = filteredMetas.filter(result => result.type === type);
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
          console.log(`[Search] Genre filter "${genre}": ${beforeFilter} -> ${filteredMetas.length} results`);
        }

        return Promise.resolve({ 
          metas: filteredMetas,
          cacheMaxAge: 300 // 5 minutes cache for search results
        });

      } catch (error) {
        console.error(`[Search] Error in search catalog "${id}" for "${searchQuery}":`, error);
        return Promise.resolve({ metas: [] });
      }
    }
    
    // Handle regular list catalogs
    const fetchStartTime = Date.now();
    console.log(`[CATALOG PERF] Fetching list content for ${id}...`);
    const itemsResult = await fetchListContent(id, userConfig, skip, genre, type); 
    const fetchEndTime = Date.now();
    console.log(`[CATALOG PERF] List content fetch completed in ${fetchEndTime - fetchStartTime}ms for ${id}`);
    
    if (!itemsResult || !itemsResult.allItems) {
      console.log(`[CATALOG PERF] No items found for ${id}, returning empty`);
      return Promise.resolve({ metas: [] });
    }
    console.log(`[CATALOG PERF] Found ${itemsResult.allItems.length} items for ${id}`);

    // Enrich items with metadata based on user's metadata source preference
    const enrichStartTime = Date.now();
    console.log(`[CATALOG PERF] Starting metadata enrichment for ${itemsResult.allItems.length} items...`);
    const metadataSource = userConfig.metadataSource || 'cinemeta';
    const hasTmdbOAuth = !!(userConfig.tmdbSessionId && userConfig.tmdbAccountId);
    const tmdbLanguage = userConfig.tmdbLanguage || 'en-US';
    
    // Debug the environment variable loading
    const envToken = require('../config').TMDB_BEARER_TOKEN;
    console.log(`[DEBUG] AddonBuilder - Raw env TMDB_BEARER_TOKEN: "${envToken}"`);
    console.log(`[DEBUG] AddonBuilder - Raw env TMDB_BEARER_TOKEN length: ${envToken ? envToken.length : 'null/undefined'}`);
    console.log(`[DEBUG] AddonBuilder - process.env.TMDB_BEARER_TOKEN exists: ${!!process.env.TMDB_BEARER_TOKEN}`);
    console.log(`[DEBUG] AddonBuilder - process.env.TMDB_BEARER_TOKEN length: ${process.env.TMDB_BEARER_TOKEN ? process.env.TMDB_BEARER_TOKEN.length : 'null/undefined'}`);
    
    const tmdbBearerToken = userConfig.tmdbBearerToken || envToken;
    
    console.log(`[DEBUG] AddonBuilder - metadataSource: ${metadataSource}, hasTmdbOAuth: ${hasTmdbOAuth}, tmdbBearerToken: ${tmdbBearerToken ? 'SET' : 'NULL/UNDEFINED'}`);
    console.log(`[DEBUG] AddonBuilder - userConfig.tmdbBearerToken: ${userConfig.tmdbBearerToken ? 'SET' : 'NULL/UNDEFINED'}`);
    console.log(`[DEBUG] AddonBuilder - userConfig.tmdbBearerToken exact value: "${userConfig.tmdbBearerToken}"`);
    console.log(`[DEBUG] AddonBuilder - environment TMDB_BEARER_TOKEN: ${envToken ? 'SET' : 'NULL/UNDEFINED'}`);
    console.log(`[DEBUG] AddonBuilder - final tmdbBearerToken: ${tmdbBearerToken ? 'SET' : 'NULL/UNDEFINED'}`);
    console.log(`[DEBUG] AddonBuilder - final tmdbBearerToken length: ${tmdbBearerToken ? tmdbBearerToken.length : 'null/undefined'}`);
    
    const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');
    const enrichedItems = await enrichItemsWithMetadata(
      itemsResult.allItems, 
      metadataSource, 
      hasTmdbOAuth, 
      tmdbLanguage, 
      tmdbBearerToken
    );
    const enrichEndTime = Date.now();
    console.log(`[CATALOG PERF] Metadata enrichment completed in ${enrichEndTime - enrichStartTime}ms`);
    
    // Log conversion results for debugging
    const tmdbFormatItems = enrichedItems.filter(i => i.id && i.id.startsWith('tmdb:')).length;
    if (tmdbFormatItems > 0) {
      console.log(`[DEBUG] Catalog contains ${tmdbFormatItems} items with tmdb: format IDs`);
    }
    
    // Update the items result with enriched items
    const enrichedResult = {
      ...itemsResult,
      allItems: enrichedItems
    };

    // Create metadata config for converter
    const metadataConfig = {
      metadataSource: userConfig.metadataSource || 'cinemeta',
      tmdbLanguage: userConfig.tmdbLanguage || 'en-US'
    };

    const convertStartTime = Date.now();
    console.log(`[CATALOG PERF] Converting ${enrichedResult.allItems.length} items to Stremio format...`);
    let metas = await convertToStremioFormat(enrichedResult, userConfig.rpdbApiKey, metadataConfig);
    const convertEndTime = Date.now();
    console.log(`[CATALOG PERF] Stremio format conversion completed in ${convertEndTime - convertStartTime}ms`);

    // Apply type filtering
    if (type === 'movie' || type === 'series' || type === 'tv' || type === 'channel') {
        const beforeFilter = metas.length;
        metas = metas.filter(meta => meta.type === type);
        console.log(`[CATALOG PERF] Type filter (${type}): ${beforeFilter} -> ${metas.length} items`);
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
        console.log(`[AddonBuilder] Genre filter "${genre}": ${beforeFilterCount} -> ${metas.length} items after enrichment`);
    }
    
    const cacheMaxAge = (id === 'random_mdblist_catalog' || isWatchlist(id)) ? 0 : (5 * 60);
    const totalTime = Date.now() - catalogStartTime;
    console.log(`[CATALOG PERF] Total catalog request completed in ${totalTime}ms for ${id} (${metas.length} items returned)`);
    return Promise.resolve({ metas, cacheMaxAge });
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    console.log(`[MetaHandler] ===== META REQUEST DEBUG =====`);
    console.log(`[MetaHandler] Request for type: "${type}", id: "${id}"`);
    console.log(`[MetaHandler] Available imported addons: ${Object.keys(userConfig.importedAddons || {}).length}`);
    
    // Support IMDB IDs (tt), TMDB IDs (tmdb:), and other IDs for TV channels
    // TV channels often have custom ID formats that don't follow tt/tmdb patterns
    const isTraditionalContent = id.startsWith('tt') || id.startsWith('tmdb:');
    const isTvChannelContent = type === 'tv' || type === 'channel';
    
    console.log(`[MetaHandler] isTraditionalContent: ${isTraditionalContent}, isTvChannelContent: ${isTvChannelContent}`);
    
    // Allow all TV/channel content through, regardless of ID format
    // Also allow traditional content through
    if (!isTraditionalContent && !isTvChannelContent) {
      console.log(`[MetaHandler] Rejecting request - not traditional content and not TV/channel`);
      return Promise.resolve({ meta: null });
    }
    
    try {
      // For TV/channel content, we need a different approach since they don't use IMDB/TMDB metadata
      if (isTvChannelContent && !isTraditionalContent) {
        // For TV channels, try to find the meta from the original external addon response
        console.log(`[MetaHandler] Processing TV/channel content: ${id} (type: ${type})`);
        
        // Look for this content in imported addons
        for (const addon of Object.values(userConfig.importedAddons || {})) {
          console.log(`[MetaHandler] Checking addon: ${addon.name}, types: [${addon.types?.join(', ') || 'none'}], resources: [${addon.resources?.join(', ') || 'none'}]`);
          
          // Skip addons that don't support the requested type
          if (addon.types && addon.types.length > 0 && !addon.types.includes(type)) {
            console.log(`[MetaHandler] Addon ${addon.name} doesn't support type ${type}, skipping`);
            continue;
          }
          
          if (addon.catalogs) {
            for (const catalog of addon.catalogs) {
              try {
                // First check if the addon provides meta resources, if so use direct API call
                if (addon.resources && addon.resources.includes('meta')) {
                  const metaUrl = `${addon.apiBaseUrl}meta/${type}/${encodeURIComponent(id)}.json`;
                  console.log(`[MetaHandler] Requesting metadata from: ${metaUrl}`);
                  
                  const axios = require('axios');
                  const metaResponse = await axios.get(metaUrl, { 
                    timeout: 10000,
                    headers: {
                      'User-Agent': 'AIOLists-Stremio-Addon/1.0'
                    }
                  });
                  
                  if (metaResponse.data && metaResponse.data.meta) {
                    console.log(`[MetaHandler] Found metadata for ${id} from ${addon.name} API`);
                    return Promise.resolve({
                      meta: {
                        ...metaResponse.data.meta,
                        // Ensure required Stremio fields
                        behaviorHints: metaResponse.data.meta.behaviorHints || {
                          hasScheduledVideos: false,
                          defaultVideoId: null
                        }
                      },
                      cacheMaxAge: 12 * 60 * 60 // 12 hours cache
                    });
                  }
                } else {
                  // Fallback: Search through catalog data
                  const externalResult = await fetchExternalAddonItems(
                    catalog.originalId, 
                    catalog.originalType, 
                    addon, 
                    0, 
                    null, 
                    null, 
                    userConfig
                  );
                  
                  if (externalResult && externalResult.metas) {
                    const foundMeta = externalResult.metas.find(meta => meta.id === id);
                    if (foundMeta) {
                      console.log(`[MetaHandler] Found TV/channel meta for ${id} from catalog data`);
                      return Promise.resolve({ 
                        meta: {
                          ...foundMeta,
                          // Ensure required Stremio fields
                          behaviorHints: foundMeta.behaviorHints || {
                            hasScheduledVideos: false,
                            defaultVideoId: null
                          }
                        },
                        cacheMaxAge: 12 * 60 * 60 // 12 hours cache
                      });
                    }
                  }
                }
              } catch (error) {
                console.warn(`[MetaHandler] Error searching for TV/channel meta in addon ${addon.name}:`, error.message);
                continue;
              }
            }
          }
        }
        
        // If not found in any addon, return basic meta
        return Promise.resolve({ 
          meta: { 
            id, 
            type, 
            name: "Channel Details",
            description: "TV Channel",
            behaviorHints: {
              hasScheduledVideos: false,
              defaultVideoId: null
            }
          }
        });
      }
      
      // Extract metadata config from userConfig for traditional content
      const metadataSource = userConfig.metadataSource || 'cinemeta';
      const hasTmdbOAuth = !!(userConfig.tmdbSessionId && userConfig.tmdbAccountId);
      const tmdbLanguage = userConfig.tmdbLanguage || 'en-US';
      const tmdbBearerToken = userConfig.tmdbBearerToken || require('../config').TMDB_BEARER_TOKEN;
      
      console.log(`[MetaHandler] Processing ${id} with source: ${metadataSource}`);
      console.log(`[MetaHandler] tmdbBearerToken available: ${!!tmdbBearerToken}`);
      console.log(`[MetaHandler] hasTmdbOAuth: ${hasTmdbOAuth}`);
      
      // Use user's preferred language for episode names and metadata
      const metaLanguage = tmdbLanguage;
      
      // Handle TMDB IDs differently based on source preference or language settings
      // Use TMDB if: 1) Direct TMDB ID, 2) User prefers TMDB source, 3) User has non-English TMDB language set
      const shouldUseTmdb = id.startsWith('tmdb:') || 
                           (metadataSource === 'tmdb' && tmdbBearerToken) ||
                           (tmdbBearerToken && tmdbLanguage && tmdbLanguage !== 'en-US');
      
      if (shouldUseTmdb) {
        let tmdbId, tmdbType, originalImdbId;
        
        if (id.startsWith('tmdb:')) {
          // Direct TMDB ID
          tmdbId = id.replace('tmdb:', '');
          tmdbType = type;
          
          // Try to get IMDB ID for this TMDB item for cross-referencing
          try {
            const { fetchTmdbMetadata } = require('../integrations/tmdb');
            const tmdbData = await fetchTmdbMetadata(tmdbId, tmdbType, metaLanguage, tmdbBearerToken);
            if (tmdbData?.imdb_id) {
              originalImdbId = tmdbData.imdb_id;
            }
          } catch (error) {
            console.warn(`[MetaHandler] Could not fetch IMDB ID for TMDB:${tmdbId}:`, error.message);
          }
        } else if (id.startsWith('tt')) {
          // Convert IMDB ID to TMDB ID and get TMDB metadata using tmdb: format
          originalImdbId = id;
          const { convertImdbToTmdbId } = require('../integrations/tmdb');
          const tmdbResult = await convertImdbToTmdbId(id, tmdbBearerToken);
          if (tmdbResult && tmdbResult.tmdbId) {
            tmdbId = tmdbResult.tmdbId;
            tmdbType = tmdbResult.type;
          }
        }
        
        if (tmdbId) {
          try {
            console.log(`[MetaHandler] Attempting to fetch TMDB metadata for ID: ${tmdbId}, type: ${tmdbType}`);
            // Fetch comprehensive TMDB metadata
            const { fetchTmdbMetadata } = require('../integrations/tmdb');
            const tmdbMeta = await fetchTmdbMetadata(tmdbId, tmdbType, metaLanguage, tmdbBearerToken);
            
            if (tmdbMeta) {
              // Always preserve the original request ID format
              tmdbMeta.id = id;
              tmdbMeta.imdb_id = originalImdbId || tmdbMeta.imdb_id;
              
              // Supplement with IMDB rating and missing fields from Cinemeta
              const imdbIdForCinemeta = tmdbMeta.imdb_id;
              if (imdbIdForCinemeta && imdbIdForCinemeta.startsWith('tt')) {
                try {
                  const cinemetaResponse = await axios.get(`https://v3-cinemeta.strem.io/meta/${tmdbType}/${imdbIdForCinemeta}.json`, { 
                    timeout: 3000 
                  });
                  
                  const cinemetaMeta = cinemetaResponse.data?.meta;
                  if (cinemetaMeta) {
                    // Use Cinemeta's IMDB rating as it's more authoritative
                    if (cinemetaMeta.imdbRating) {
                      tmdbMeta.imdbRating = cinemetaMeta.imdbRating;
                    }
                    
                    // Fill missing essential Cinemeta fields
                    if (cinemetaMeta.awards && !tmdbMeta.awards) {
                      tmdbMeta.awards = cinemetaMeta.awards;
                    }
                    if (cinemetaMeta.dvdRelease && !tmdbMeta.dvdRelease) {
                      tmdbMeta.dvdRelease = cinemetaMeta.dvdRelease;
                    }
                    if (cinemetaMeta.country && !tmdbMeta.country) {
                      tmdbMeta.country = cinemetaMeta.country;
                    }
                    // Prefer Cinemeta logo if TMDB doesn't have one
                    if (cinemetaMeta.logo && !tmdbMeta.logo) {
                      tmdbMeta.logo = cinemetaMeta.logo;
                    }
                    
                    console.log(`[MetaHandler] Enhanced TMDB metadata with Cinemeta data for ${imdbIdForCinemeta}`);
                  }
                } catch (cinemetaError) {
                  console.warn(`[MetaHandler] Could not fetch Cinemeta data for ${imdbIdForCinemeta}:`, cinemetaError.message);
                }
              }
              
              // Format fields to match Stremio's expected format
              
              // Format runtime for series (convert minutes to proper format)
              if (tmdbType === 'series' && tmdbMeta.runtime) {
                const runtimeMinutes = parseInt(tmdbMeta.runtime);
                if (runtimeMinutes && !isNaN(runtimeMinutes)) {
                  const hours = Math.floor(runtimeMinutes / 60);
                  const minutes = runtimeMinutes % 60;
                  if (hours > 0) {
                    // Format as "hh:mm" for durations over an hour
                    const paddedMinutes = minutes.toString().padStart(2, '0');
                    tmdbMeta.runtime = `${hours}:${paddedMinutes}`;
                  } else {
                    // Format as "XX min" for durations under an hour
                    tmdbMeta.runtime = `${minutes} min`;
                  }
                }
              }
              
              // Episode ratings should already be properly formatted by TMDB integration
              // No additional processing needed here
              
              // Format slug to match expected pattern
              if (tmdbMeta.name && tmdbMeta.imdb_id) {
                const imdbNumber = tmdbMeta.imdb_id.replace('tt', '');
                tmdbMeta.slug = `${tmdbType}/${tmdbMeta.name}-${imdbNumber}`;
              }
              
              // Writer field should already be available from TMDB conversion
              // No need to extract again if it's already present
              
              // Clean up extra TMDB-specific fields that shouldn't be in Stremio format
              const fieldsToRemove = [
                'tmdbId', 'moviedb_id', 'tmdbRating', 'tmdbVotes', 
                'popularity', 'popularities', 'credits'
              ];
              fieldsToRemove.forEach(field => {
                if (tmdbMeta.hasOwnProperty(field)) {
                  delete tmdbMeta[field];
                }
              });
              
              // Enhance behavioral hints for better Stremio integration
              tmdbMeta.behaviorHints = {
                defaultVideoId: null, // Set to null for series as per expected format
                hasScheduledVideos: tmdbType === 'series',
                p2p: false,
                configurable: false,
                configurationRequired: false
              };
              
              console.log(`[MetaHandler] Successfully fetched comprehensive TMDB metadata for ${id} -> ${tmdbMeta.id}`);
              
              return Promise.resolve({ 
                meta: tmdbMeta,
                cacheMaxAge: 24 * 60 * 60 // Cache for 24 hours
              });
            }
          } catch (tmdbError) {
            console.error(`[MetaHandler] TMDB metadata fetch failed for ${id}:`, tmdbError.message);
            console.error(`[MetaHandler] TMDB error stack:`, tmdbError.stack);
          }
        } else {
          console.warn(`[MetaHandler] No TMDB ID found for ${id}`);
        }
      }
      
      // Fallback to standard enrichment process for non-TMDB sources or failures
      const itemForEnrichment = [{
        id: id,
        imdb_id: id.startsWith('tt') ? id : undefined,
        type: type,
        title: "Loading...",
        name: "Loading..."
      }];
      
      const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');
      const enrichedItems = await enrichItemsWithMetadata(itemForEnrichment, metadataSource, hasTmdbOAuth, tmdbLanguage, tmdbBearerToken);
      
      if (enrichedItems && enrichedItems.length > 0) {
        const enrichedItem = enrichedItems[0];
        
        // Create a comprehensive meta object
        const meta = {
          id: id,
          imdb_id: id.startsWith('tt') ? id : enrichedItem.imdb_id,
          type: type,
          name: enrichedItem.name || enrichedItem.title || "Unknown Title",
          poster: enrichedItem.poster,
          background: enrichedItem.background || enrichedItem.backdrop,
          description: enrichedItem.description || enrichedItem.overview,
          releaseInfo: enrichedItem.releaseInfo || enrichedItem.year || 
                       (enrichedItem.release_date ? enrichedItem.release_date.split('-')[0] : 
                       (enrichedItem.first_air_date ? enrichedItem.first_air_date.split('-')[0] : undefined)),
          year: enrichedItem.year,
          released: enrichedItem.released,
          imdbRating: enrichedItem.imdbRating,
          runtime: enrichedItem.runtime,
          genres: enrichedItem.genres,
          genre: enrichedItem.genres, // Cinemeta compatibility
          cast: enrichedItem.cast,
          director: enrichedItem.director,
          writer: enrichedItem.writer,
          country: enrichedItem.country,
          trailers: enrichedItem.trailers,
          trailerStreams: enrichedItem.trailerStreams,
          videos: enrichedItem.videos || [],
          links: enrichedItem.links || [],
          awards: enrichedItem.awards,
          dvdRelease: enrichedItem.dvdRelease,
          logo: enrichedItem.logo,
          slug: enrichedItem.slug,
          popularity: enrichedItem.popularity,
          popularities: enrichedItem.popularities,
          status: type === 'series' ? enrichedItem.status : undefined,
          behaviorHints: {
            defaultVideoId: id,
            hasScheduledVideos: type === 'series',
            p2p: false,
            configurable: false,
            configurationRequired: false
          }
        };
        
        // Clean up undefined values
        Object.keys(meta).forEach(key => {
          if (meta[key] === undefined) {
            delete meta[key];
          }
        });
        
        console.log(`[MetaHandler] Returning enriched metadata for ${id} with ${Object.keys(meta).length} fields`);
        
        return Promise.resolve({ 
          meta,
          cacheMaxAge: 12 * 60 * 60 // 12 hours cache
        });
      }
      
      // Final fallback - but first log what went wrong
      console.error(`[MetaHandler] All metadata sources failed for ${id}, returning fallback`);
      return Promise.resolve({ 
        meta: { 
          id, 
          type, 
          name: "Details unavailable",
          behaviorHints: {
            hasScheduledVideos: type === 'series'
          }
        }
      });
      
    } catch (error) {
      console.error(`Error in meta handler for ${id}:`, error);
      return Promise.resolve({ 
        meta: { 
          id, 
          type, 
          name: "Error loading details",
          behaviorHints: {
            hasScheduledVideos: type === 'series'
          }
        }
      });
    }
  });

  // Add stream handler if external addons provide stream resources
  if (hasExternalStreamProviders) {
    builder.defineStreamHandler(async ({ type, id }) => {
      console.log(`[StreamHandler] ===== STREAM REQUEST DEBUG =====`);
      console.log(`[StreamHandler] Stream request for type: "${type}", id: "${id}"`);
      console.log(`[StreamHandler] Available imported addons: ${Object.keys(userConfig.importedAddons || {}).length}`);
      
      try {
        // Look for this content in imported addons that provide stream resources
        for (const addon of Object.values(userConfig.importedAddons || {})) {
          console.log(`[StreamHandler] Checking addon: ${addon.name}, types: [${addon.types?.join(', ') || 'none'}], resources: [${addon.resources?.join(', ') || 'none'}]`);
          
          if (!addon.resources || !addon.resources.includes('stream')) {
            console.log(`[StreamHandler] Addon ${addon.name} doesn't provide stream resources, skipping`);
            continue; // Skip addons that don't provide streams
          }
          
          // Skip addons that don't support the requested type
          if (addon.types && addon.types.length > 0 && !addon.types.includes(type)) {
            console.log(`[StreamHandler] Addon ${addon.name} doesn't support type ${type}, skipping`);
            continue;
          }
          
          try {
            // Check if this addon handles this ID prefix
            // For TV/channel content, be more permissive since they often have custom ID formats
            const isTvChannelRequest = type === 'tv' || type === 'channel';
            const handlesThisId = isTvChannelRequest || 
                                 !addon.idPrefixes || 
                                 addon.idPrefixes.length === 0 || 
                                 addon.idPrefixes.some(prefix => id.startsWith(prefix));
            
            if (!handlesThisId) {
              console.log(`[StreamHandler] Addon ${addon.name} doesn't handle ID prefix for ${id} (type: ${type})`);
              continue;
            }
            
            // Directly request streams from the addon
            const streamUrl = `${addon.apiBaseUrl}stream/${type}/${encodeURIComponent(id)}.json`;
            console.log(`[StreamHandler] Requesting streams from: ${streamUrl}`);
            
            const axios = require('axios');
            const streamResponse = await axios.get(streamUrl, { 
              timeout: 15000,
              headers: {
                'User-Agent': 'AIOLists-Stremio-Addon/1.0'
              }
            });
            
            if (streamResponse.data && streamResponse.data.streams) {
              console.log(`[StreamHandler] Found ${streamResponse.data.streams.length} streams for ${id} from ${addon.name}`);
              return Promise.resolve({
                streams: streamResponse.data.streams,
                cacheMaxAge: 60 * 60 // 1 hour cache for streams
              });
            }
          } catch (error) {
            console.warn(`[StreamHandler] Error getting streams from addon ${addon.name} for ${id}:`, error.message);
            continue;
          }
        }
        
        // No streams found
        console.log(`[StreamHandler] No streams found for ${type}/${id}`);
        return Promise.resolve({ streams: [] });
        
      } catch (error) {
        console.error(`[StreamHandler] Error in stream handler for ${id}:`, error);
        return Promise.resolve({ streams: [] });
      }
    });
    
    console.log(`[ADDON BUILDER] Added stream handler for external addon integration`);
  }

  const endTime = Date.now();
  console.log(`[ADDON BUILDER] Addon creation completed in ${endTime - startTime}ms`);
  console.log(`[ADDON BUILDER] Generated ${manifest.catalogs.length} catalogs`);
  
  const addonInterface = builder.getInterface();
  
  // Cache the generated addon interface (if enabled)
  if (ENABLE_MANIFEST_CACHE) {
    const cacheKey = getManifestCacheKey(userConfig);
    manifestCache.set(cacheKey, {
      addon: addonInterface,
      timestamp: Date.now()
    });
    console.log(`[ADDON BUILDER] Cached manifest for future requests (TTL: ${MANIFEST_CACHE_TTL / 1000}s)`);
    
    // Clean up old cache entries (keep only last 5)
    if (manifestCache.size > 5) {
      const oldestKey = manifestCache.keys().next().value;
      manifestCache.delete(oldestKey);
      console.log(`[ADDON BUILDER] Cleaned up old cache entry`);
    }
  }
  
  return addonInterface;
}

module.exports = { createAddon, fetchListContent };