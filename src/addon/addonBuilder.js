// src/addon/addonBuilder.js
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchTraktListItems, fetchTraktLists } = require('../integrations/trakt');
const { fetchListItems: fetchMDBListItems, fetchAllLists: fetchAllMDBLists, fetchAllListsForUser } = require('../integrations/mdblist');
const { fetchExternalAddonItems } = require('../integrations/externalAddons');
const { convertToStremioFormat } = require('./converters');
const { isWatchlist: commonIsWatchlist } = require('../utils/common');
const { staticGenres } = require('../config');
const { decompressConfig } = require('../utils/urlConfig');
const { getProfileMetas, getProfileStream, DEFAULT_PROFILE_POSTER_URL } = require('../utils/profileManager');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const METADATA_FETCH_RETRY_DELAY_MS = 5000;
const MAX_METADATA_FETCH_RETRIES = 2;
const DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS = 500;


async function fetchListContent(listId, userConfig, skip = 0, genre = null, stremioCatalogType = 'all', isMetadataCheck = false) {
  const { apiKey, traktAccessToken, listsMetadata = {}, sortPreferences = {}, importedAddons = {}, rpdbApiKey, randomMDBListUsernames, enableRandomListFeature } = userConfig;
  const catalogIdFromRequest = listId;
  const itemTypeHintForFetching = (stremioCatalogType === 'all') ? null : stremioCatalogType;

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
    originalListIdForSortLookup = null;
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

  const sortPrefsForImported = userConfig.sortPreferences?.[originalListIdForSortLookup] ||
                               ( (catalogIdFromRequest.startsWith('traktpublic_') || (addonDetails?.isTraktPublicList && originalListIdForSortLookup?.startsWith('traktpublic_'))) ?
                                 { sort: 'rank', order: 'asc' } : { sort: 'default', order: 'desc' } );

  let itemsResult;
  
  if (catalogIdFromRequest === 'random_mdblist_catalog' && enableRandomListFeature && apiKey && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    const randomUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
    const userLists = await fetchAllListsForUser(apiKey, randomUsername);
    if (userLists && userLists.length > 0) {
      const randomUserList = userLists[Math.floor(Math.random() * userLists.length)];
      console.log(`[AIOLists RandomCatalog] Selected user: ${randomUsername}, list: ${randomUserList.name} (ID: ${randomUserList.id}, Slug: ${randomUserList.slug})`);
      
      const listIdentifierToFetch = randomUserList.slug || String(randomUserList.id);

      itemsResult = await fetchMDBListItems(
        listIdentifierToFetch, 
        apiKey,
        {}, 
        skip,
        'default', 
        'desc',      
        false,       
        genre,
        randomUsername, 
        isMetadataCheck 
      );
    } else {
      console.log(`[AIOLists RandomCatalog] User ${randomUsername} has no public lists with items or failed to fetch their lists.`);
      itemsResult = { allItems: [], hasMovies: false, hasShows: false };
    }
  }


  if (!itemsResult && isUrlImport) {
    const addonConfig = importedAddons[catalogIdFromRequest];
    if (addonConfig.isTraktPublicList) {
      itemsResult = await fetchTraktListItems(
        addonConfig.id, userConfig, skip, sortPrefsForImported.sort, sortPrefsForImported.order,
        true, addonConfig.traktUser, itemTypeHintForFetching, genre, isMetadataCheck
      );
    } else if (addonConfig.isMDBListUrlImport && apiKey) {
      itemsResult = await fetchMDBListItems(
        addonConfig.mdblistId, apiKey, listsMetadata, skip, sortPrefsForImported.sort, sortPrefsForImported.order,
        true, genre, null, isMetadataCheck
      );
    }
  }


  if (!itemsResult && importedAddons) {
    for (const parentAddon of Object.values(importedAddons)) {
      if (parentAddon.isMDBListUrlImport || parentAddon.isTraktPublicList) continue;
      const catalogEntry = parentAddon.catalogs?.find(c => String(c.id) === String(catalogIdFromRequest));
      if (catalogEntry) {
        itemsResult = await fetchExternalAddonItems(
          catalogEntry.originalId, catalogEntry.originalType, parentAddon, skip, rpdbApiKey, genre
        );
        break;
      }
    }
  }

  if (!itemsResult && catalogIdFromRequest.startsWith('trakt_') && !catalogIdFromRequest.startsWith('traktpublic_') && traktAccessToken) {
    let sortPrefs = sortPreferences?.[originalListIdForSortLookup] ||
                      (catalogIdFromRequest.startsWith('trakt_watchlist') ? { sort: 'added', order: 'desc'} : { sort: 'rank', order: 'asc' });
    
    if (catalogIdFromRequest === 'trakt_watchlist' && itemTypeHintForFetching === null) {
        sortPrefs.sort = 'added';
    }

    let actualItemTypeHint = itemTypeHintForFetching;
    if (catalogIdFromRequest.includes("_movies")) actualItemTypeHint = 'movie';
    if (catalogIdFromRequest.includes("_shows")) actualItemTypeHint = 'series';
    if (catalogIdFromRequest === 'trakt_watchlist' && itemTypeHintForFetching === null) {
      actualItemTypeHint = 'all';
    }

    itemsResult = await fetchTraktListItems(
      catalogIdFromRequest, userConfig, skip, sortPrefs.sort, sortPrefs.order,
      false, null, actualItemTypeHint, genre, isMetadataCheck
    );
  }

  if (!itemsResult && apiKey && catalogIdFromRequest.startsWith('aiolists-')) {
    const match = catalogIdFromRequest.match(/^aiolists-([^-]+(?:-[^-]+)*)-([ELW])$/);
    let mdbListOriginalIdFromCatalog = match ? match[1] : catalogIdFromRequest.replace(/^aiolists-/, '').replace(/-[ELW]$/, '');
    if (catalogIdFromRequest === 'aiolists-watchlist-W') {
      mdbListOriginalIdFromCatalog = 'watchlist';
    }
    const mdbListSortPrefs = sortPreferences?.[mdbListOriginalIdFromCatalog] || { sort: 'default', order: 'desc' };
    
    let sortForMdbList = mdbListSortPrefs.sort;
    if (mdbListOriginalIdFromCatalog === 'watchlist' && itemTypeHintForFetching === null) {
        sortForMdbList = 'added';
    }

    itemsResult = await fetchMDBListItems(
      mdbListOriginalIdFromCatalog, apiKey, listsMetadata, skip, sortForMdbList, mdbListSortPrefs.order,
      false, genre, null, isMetadataCheck
    );
  }
  return itemsResult || null;
}


async function createAddon(userConfig, serverUrl) {
  console.log('[addonBuilder createAddon] Initializing. userConfig.connectedProfiles:', JSON.stringify(userConfig.connectedProfiles || "undefined/null"));
  const manifest = {
    id: 'org.stremio.aiolists',
    version: `1.0.${Date.now()}`,
    name: 'AIOLists',
    description: 'Manage all your lists in one place, with profile switching.',
    resources: ['catalog', 'stream', 'meta'],
    types: ['movie', 'series', 'channel', 'all'],
    idPrefixes: ['tt', 'profile_'],
    catalogs: [],
    logo: `https://i.imgur.com/DigFuAQ.png`,
    behaviorHints: { configurable: true, configurationRequired: false }
  };

  const {
    apiKey, traktAccessToken, listOrder = [], hiddenLists = [], removedLists = [],
    customListNames = {}, mergedLists = {}, importedAddons = {}, listsMetadata = {},
    disableGenreFilter, enableRandomListFeature, randomMDBListUsernames,
    connectedProfiles
  } = userConfig;

  if (connectedProfiles && connectedProfiles.length > 0) {
    console.log('[addonBuilder createAddon] Adding profiles catalog to manifest. Count:', connectedProfiles.length);
    manifest.catalogs.push({
      id: 'aiolists_profiles_catalog',
      type: 'channel',
      name: "Who's Watching?"
      // 'extra' property removed as per user request.
    });
  } else {
    console.log('[addonBuilder createAddon] No connected profiles found, profiles catalog will not be added.');
  }
  
  // ... (rest of your existing catalog population logic for MDBList, Trakt, etc.)
    if (enableRandomListFeature && apiKey && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    let randomCatalogDisplayName = "Discovery";
    const randomCatalogExtra = [{ name: "skip" }];
    if (!disableGenreFilter) { // Assuming includeGenresInManifest means !disableGenreFilter
        randomCatalogExtra.push({ name: "genre", options: staticGenres });
    }
    manifest.catalogs.push({
        id: 'random_mdblist_catalog',
        type: 'all',
        name: customListNames['random_mdblist_catalog'] || randomCatalogDisplayName,
        extra: randomCatalogExtra
    });
  }

  let activeListsInfo = [];
  if (apiKey) {
    const mdbLists = await fetchAllMDBLists(apiKey);
    activeListsInfo.push(...mdbLists.map(l => ({ ...l, source: 'mdblist', originalId: String(l.id) })));
  }
  if (traktAccessToken) {
    const traktFetchedLists = await fetchTraktLists(userConfig);
    activeListsInfo.push(...traktFetchedLists.map(l => ({ ...l, source: 'trakt', originalId: String(l.id) })));
  }

  for (const listInfo of activeListsInfo) {
    const originalId = String(listInfo.originalId);
    let manifestListIdBase = originalId;

    if (listInfo.source === 'mdblist') {
      const listTypeSuffix = listInfo.listType || 'L';
      manifestListIdBase = listInfo.id === 'watchlist' ? `aiolists-watchlist-W` : `aiolists-${listInfo.id}-${listTypeSuffix}`;
    } else if (listInfo.source === 'trakt') {
      manifestListIdBase = listInfo.id;
    }

    if (new Set(removedLists.map(String)).has(manifestListIdBase) || new Set(hiddenLists.map(String)).has(manifestListIdBase)) {
      continue;
    }

    let displayName = customListNames[manifestListIdBase] || listInfo.name;
    let hasMovies, hasShows;
    let canBeMerged = false;

    if (listInfo.source === 'mdblist') {
        const mediatype = listInfo.mediatype;
        const dynamic = listInfo.dynamic;
        hasMovies = (mediatype === 'movie' || !mediatype || mediatype === '');
        hasShows = (mediatype === 'show' || mediatype === 'series' || !mediatype || mediatype === '');
        canBeMerged = (dynamic === false || !mediatype || mediatype === '');
        if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
        userConfig.listsMetadata[manifestListIdBase] = {
            ...(userConfig.listsMetadata[manifestListIdBase] || {}),
            hasMovies, hasShows, canBeMerged, lastChecked: new Date().toISOString()
        };
        if (apiKey) await delay(100);
    } else if (listInfo.source === 'trakt') {
        let metadata = { ...(listsMetadata[manifestListIdBase] || listsMetadata[originalId] || {}) };
        hasMovies = metadata.hasMovies === true;
        hasShows = metadata.hasShows === true;
        canBeMerged = true;

        if ((typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean' || metadata.errorFetching) && traktAccessToken) {
            let success = false;
            let fetchRetries = 0;
            if(metadata.errorFetching) delete metadata.errorFetching;
            while (!success && fetchRetries < MAX_METADATA_FETCH_RETRIES) {
                 try {
                    const tempUserConfigForMetadata = { ...userConfig, listsMetadata: {}, rpdbApiKey: null };
                    let typeForMetaCheck = 'all';
                    if (manifestListIdBase.startsWith('trakt_recommendations_') || manifestListIdBase.startsWith('trakt_trending_') || manifestListIdBase.startsWith('trakt_popular_')) {
                        if (manifestListIdBase.includes("_shows")) typeForMetaCheck = 'series';
                        else if (manifestListIdBase.includes("_movies")) typeForMetaCheck = 'movie';
                    }
                    if (manifestListIdBase === 'trakt_watchlist') typeForMetaCheck = 'all';

                    const content = await fetchListContent(manifestListIdBase, tempUserConfigForMetadata, 0, null, typeForMetaCheck, true);
                    hasMovies = content?.hasMovies || false;
                    hasShows = content?.hasShows || false;
                    if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
                    userConfig.listsMetadata[manifestListIdBase] = {
                        ...(userConfig.listsMetadata[manifestListIdBase] || {}),
                        hasMovies, hasShows, canBeMerged: true,
                        lastChecked: new Date().toISOString()
                    };
                    success = true;
                } catch (error) {
                    fetchRetries++;
                    console.error(`[addonBuilder] Error fetching metadata for Trakt ${manifestListIdBase} (attempt ${fetchRetries}/${MAX_METADATA_FETCH_RETRIES}): ${error.message}`);
                    if (fetchRetries >= MAX_METADATA_FETCH_RETRIES) {
                        hasMovies = userConfig.listsMetadata[manifestListIdBase]?.hasMovies || false;
                        hasShows = userConfig.listsMetadata[manifestListIdBase]?.hasShows || false;
                         if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
                        userConfig.listsMetadata[manifestListIdBase] = {
                            ...(userConfig.listsMetadata[manifestListIdBase] || {}),
                            hasMovies, hasShows, errorFetching: true, canBeMerged: true,
                            lastChecked: new Date().toISOString()
                        };
                    } else {
                         await delay(METADATA_FETCH_RETRY_DELAY_MS * Math.pow(2, fetchRetries - 1));
                    }
                }
            }
            if (traktAccessToken) await delay(DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS);
        }
    } else { hasMovies = false; hasShows = false; canBeMerged = false; }

    if (hasMovies || hasShows) {
      const isEffectivelyMergeable = canBeMerged && hasMovies && hasShows;
      const isUserMerged = isEffectivelyMergeable ? (mergedLists[manifestListIdBase] !== false) : false;
      const catalogExtra = [{ name: "skip" }];
      if (!disableGenreFilter) catalogExtra.push({ name: "genre", options: staticGenres });
      const finalCatalogProps = { name: displayName, extra: catalogExtra };

      if (isUserMerged) {
        manifest.catalogs.push({ id: manifestListIdBase, type: 'all', ...finalCatalogProps });
      } else {
        if (hasMovies) manifest.catalogs.push({ id: manifestListIdBase, type: 'movie', ...finalCatalogProps });
        if (hasShows) manifest.catalogs.push({ id: manifestListIdBase, type: 'series', ...finalCatalogProps });
      }
    }
  }

  Object.values(importedAddons || {}).forEach(addon => {
    const addonGroupId = String(addon.id);
    if (new Set(removedLists.map(String)).has(addonGroupId) || new Set(hiddenLists.map(String)).has(addonGroupId)) return;
    const isMDBListUrlImport = !!addon.isMDBListUrlImport;
    const isTraktPublicList = !!addon.isTraktPublicList;

    if (isMDBListUrlImport || isTraktPublicList) {
      if (isMDBListUrlImport && !apiKey) return;
      let urlImportHasMovies = addon.hasMovies;
      let urlImportHasShows = addon.hasShows;
      let urlImportCanBeMerged = true;
      if (isMDBListUrlImport && typeof addon.dynamic === 'boolean' && typeof addon.mediatype !== 'undefined') {
        urlImportCanBeMerged = (addon.dynamic === false || !addon.mediatype || addon.mediatype === '');
      }

      if (urlImportHasMovies || urlImportHasShows) {
        let displayName = customListNames[addonGroupId] || addon.name;
        const isEffectivelyMergeableForUrl = urlImportCanBeMerged && urlImportHasMovies && urlImportHasShows;
        const isUserMergedForUrl = isEffectivelyMergeableForUrl ? (mergedLists?.[addonGroupId] !== false) : false;
        const catalogExtraForUrlImport = [{ name: "skip" }];
        if (!disableGenreFilter) catalogExtraForUrlImport.push({ name: "genre", options: staticGenres });
        const catalogPropsForUrlImport = { name: displayName, extra: catalogExtraForUrlImport };

        if (isUserMergedForUrl) {
          manifest.catalogs.push({ id: addonGroupId, type: 'all', ...catalogPropsForUrlImport });
        } else {
          if (urlImportHasMovies) manifest.catalogs.push({ id: addonGroupId, type: 'movie', ...catalogPropsForUrlImport });
          if (urlImportHasShows) manifest.catalogs.push({ id: addonGroupId, type: 'series', ...catalogPropsForUrlImport });
        }
      }
    } else if (addon.catalogs && addon.catalogs.length > 0) {
       (addon.catalogs || []).forEach(catalog => {
          const catalogIdForManifest = String(catalog.id);
          if (new Set(removedLists.map(String)).has(catalogIdForManifest) || new Set(hiddenLists.map(String)).has(catalogIdForManifest)) return;
          let displayName = customListNames[catalogIdForManifest] || catalog.name;
          const finalExtraForImported = [{ name: "skip" }];
          let importedGenreOptions = null;
           (catalog.extraSupported || catalog.extra || []).forEach(ext => {
              const extName = (typeof ext === 'string') ? ext : ext.name;
              const extOptions = (typeof ext === 'object' && ext.options) ? ext.options : undefined;
              if (extName === "skip") return;
              if (extName === "genre") { if (extOptions) importedGenreOptions = extOptions; return; }
              if (typeof ext === 'string') finalExtraForImported.push({ name: ext });
              else finalExtraForImported.push({ name: extName, options: extOptions, isRequired: (typeof ext === 'object' && ext.isRequired) ? ext.isRequired : false });
          });
          if (!disableGenreFilter) {
              finalExtraForImported.push({ name: "genre", options: importedGenreOptions || staticGenres });
          }
          manifest.catalogs.push({ id: catalogIdForManifest, type: catalog.type, name: displayName, extra: finalExtraForImported });
      });
    }
  });


  const profileCatalogDefinition = manifest.catalogs.find(cat => cat.id === 'aiolists_profiles_catalog');
  let otherCatalogs = manifest.catalogs.filter(cat => cat.id !== 'aiolists_profiles_catalog');

  if (listOrder && listOrder.length > 0) {
    const orderMap = new Map(listOrder.map((id, index) => [String(id), index]));
    otherCatalogs.sort((a, b) => {
        const idA = String(a.id);
        const idB = String(b.id);
        const indexA = orderMap.get(idA);
        const indexB = orderMap.get(idB);
        if (indexA !== undefined && indexB !== undefined) return indexA - indexB;
        if (indexA !== undefined) return -1;
        if (indexB !== undefined) return 1;
        if (idA === 'random_mdblist_catalog') return -1;
        if (idB === 'random_mdblist_catalog') return 1;
        return (a.name || '').localeCompare(b.name || '');
    });
  } else {
    otherCatalogs.sort((a, b) => {
        if (a.id === 'random_mdblist_catalog' && b.id !== 'random_mdblist_catalog') return -1;
        if (b.id === 'random_mdblist_catalog' && a.id !== 'random_mdblist_catalog') return 1;
        return (a.name || '').localeCompare(b.name || '');
    });
  }
  manifest.catalogs = profileCatalogDefinition ? [profileCatalogDefinition, ...otherCatalogs] : otherCatalogs;
  console.log('[addonBuilder createAddon] Final manifest.catalogs structure:', JSON.stringify(manifest.catalogs.map(c => ({id: c.id, name: c.name, type: c.type}))));


  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async (args) => {
    const { type, id, extra, config: handlerConfigOriginal, stremio_opts } = args; // stremio_opts might contain configHash

    let currentHandlerConfig = handlerConfigOriginal;
    if (stremio_opts && stremio_opts.configHash && handlerConfigOriginal.configHash !== stremio_opts.configHash) {
        try {
            console.warn(`[addonBuilder CatalogHandler] Discrepancy in configHash. stremio_opts.configHash: ${stremio_opts.configHash}, handlerConfigOriginal.configHash: ${handlerConfigOriginal.configHash}. Attempting to reload config.`);
        } catch (e) {
            console.error("[addonBuilder CatalogHandler] Error re-decompressing config from stremio_opts:", e);
        }
    }

    const skip = parseInt(extra?.skip) || 0;
    const genre = extra?.genre || null;

    console.log(`[addonBuilder CatalogHandler ENTRY] Catalog ID: ${id}, Type: ${type}, ConfigHash (from args if available, or infer): ${args.configHash || 'N/A in args, check API middleware for actual hash used by Stremio for this req'}`);

    console.log(`[addonBuilder CatalogHandler] Request for catalog id: ${id}, type: ${type}`);
    if (id === 'aiolists_profiles_catalog' && type === 'channel') {
      console.log('[addonBuilder CatalogHandler] Matched profiles catalog. Config.connectedProfiles:', JSON.stringify(currentHandlerConfig.connectedProfiles || "undefined/null"));
      const profileMetas = getProfileMetas(currentHandlerConfig, serverUrl); // serverUrl from createAddon scope
      console.log('[addonBuilder CatalogHandler] Profiles catalog metas count:', profileMetas.length);
      return Promise.resolve({ metas: profileMetas, cacheMaxAge: 5 * 60 });
    }

    const itemsResult = await fetchListContent(id, handlerConfig, skip, genre, type);
    if (!itemsResult) {
      console.log(`[addonBuilder CatalogHandler] No itemsResult for id: ${id}, type: ${type}`);
      return Promise.resolve({ metas: [] });
    }

    let metas = await convertToStremioFormat(itemsResult, handlerConfig.rpdbApiKey);
    if (type !== 'all' && (type === 'movie' || type === 'series')) {
      metas = metas.filter(meta => meta.type === type);
    }
    const cacheMaxAgeValue = (id === 'random_mdblist_catalog' || commonIsWatchlist(id)) ? 0 : (5 * 60);
    console.log(`[addonBuilder CatalogHandler] Returning ${metas.length} metas for id: ${id}, type: ${type}`);
    return Promise.resolve({ metas, cacheMaxAge: cacheMaxAgeValue });
  });

  builder.defineStreamHandler(async (args) => {
    const { type, id, config: handlerConfig } = args;
    console.log(`[addonBuilder StreamHandler] Request for stream id: ${id}, type: ${type}`);

    if (type === 'channel' && id.startsWith('profile_')) {
      const streamObject = getProfileStream(handlerConfig, id);
      if (streamObject) {
        console.log(`[addonBuilder StreamHandler] Found profile stream for ID ${id}:`, JSON.stringify(streamObject));
        return Promise.resolve({ streams: [streamObject] });
      } else {
        console.log(`[addonBuilder StreamHandler] No profile stream found for ID ${id}.`);
        return Promise.resolve({ streams: [] });
      }
    }
    console.log(`[addonBuilder StreamHandler] No specific handler for id: ${id}, type: ${type}. Returning empty streams.`);
    return Promise.resolve({ streams: [] });
  });

  builder.defineMetaHandler(async (args) => {
    const { type, id, config: handlerConfig } = args;
    console.log(`[addonBuilder MetaHandler] Request for meta id: ${id}, type: ${type}`);

    if (type === 'channel' && id.startsWith('profile_')) {
      const profile = (handlerConfig.connectedProfiles || []).find(p => p.internalId === id);
      if (profile) {
        let poster = profile.customPoster || DEFAULT_PROFILE_POSTER_URL;
        const metaItem = {
            id: profile.internalId,
            type: 'channel',
            name: profile.name,
            poster: poster,
            description: `Switch to ${profile.name}'s profile.`
        };
        console.log(`[addonBuilder MetaHandler] Found profile meta for ID ${id}:`, JSON.stringify(metaItem));
        return Promise.resolve({ meta: metaItem });
      } else {
         console.log(`[addonBuilder MetaHandler] Profile not found for meta ID ${id}.`);
      }
    }
    // console.log(`[addonBuilder MetaHandler] No specific handler for id: ${id}, type: ${type}. Returning null meta.`);
    return Promise.resolve({ meta: null });
  });

  return builder.getInterface();
}

module.exports = { createAddon, fetchListContent };
