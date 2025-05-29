const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const { fetchTraktListItems, fetchTraktLists } = require('../integrations/trakt');
const { fetchListItems: fetchMDBListItems, fetchAllLists: fetchAllMDBLists, fetchAllListsForUser } = require('../integrations/mdblist');
const { fetchExternalAddonItems } = require('../integrations/externalAddons');
const { convertToStremioFormat } = require('./converters');
const { isWatchlist } = require('../utils/common');
const { staticGenres } = require('../config');
const { batchFetchPosters } = require('../utils/posters');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const METADATA_FETCH_RETRY_DELAY_MS = 5000;
const MAX_METADATA_FETCH_RETRIES = 2;
const DELAY_BETWEEN_DIFFERENT_MDBLISTS_MS = 1500;
const DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS = 500;

async function getRandomMDBListDetailsForManifest(apiKey, randomMDBListUsernames) {
  if (!apiKey || !randomMDBListUsernames || randomMDBListUsernames.length === 0) {
      return null;
  }
  try {
      const randomUsername = randomMDBListUsernames[Math.floor(Math.random() * randomMDBListUsernames.length)];
      const userLists = await fetchAllListsForUser(apiKey, randomUsername);
      if (userLists && userLists.length > 0) {
          const randomUserList = userLists[Math.floor(Math.random() * userLists.length)];
          return {
              name: randomUserList.name || "Random MDBList",
              id: 'random_mdblist_catalog',
          };
      }
  } catch (error) {
      console.error("[addonBuilder] Error fetching random MDBList details for manifest:", error.message);
  }
  return null;
}

async function fetchListContent(listId, userConfig, skip = 0, genre = null, stremioCatalogType = 'all') {
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
                                 { sort: 'rank', order: 'asc' } : { sort: 'imdbvotes', order: 'desc' } );

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
        'imdbvotes',
        'desc',
        false,
        genre, 
        randomUsername
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
        true, addonConfig.traktUser, itemTypeHintForFetching, genre
      );
    } else if (addonConfig.isMDBListUrlImport && apiKey) {
      itemsResult = await fetchMDBListItems( 
        addonConfig.mdblistId, apiKey, listsMetadata, skip, sortPrefsForImported.sort, sortPrefsForImported.order,
        true, genre
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
      false, null, actualItemTypeHint, genre
    );
  }

  if (!itemsResult && apiKey && catalogIdFromRequest.startsWith('aiolists-')) { 
    const match = catalogIdFromRequest.match(/^aiolists-([^-]+(?:-[^-]+)*)-([ELW])$/);
    let mdbListOriginalIdFromCatalog = match ? match[1] : catalogIdFromRequest.replace(/^aiolists-/, '').replace(/-[ELW]$/, '');
    if (catalogIdFromRequest === 'aiolists-watchlist-W') {
      mdbListOriginalIdFromCatalog = 'watchlist';
    }
    const mdbListSortPrefs = sortPreferences?.[mdbListOriginalIdFromCatalog] || { sort: 'imdbvotes', order: 'desc' };
    let sortForMdbList = mdbListSortPrefs.sort;
    if (mdbListOriginalIdFromCatalog === 'watchlist' && itemTypeHintForFetching === null) { 
        sortForMdbList = 'added'; 
    }
    itemsResult = await fetchMDBListItems( 
      mdbListOriginalIdFromCatalog, apiKey, listsMetadata, skip, sortForMdbList, mdbListSortPrefs.order,
      false, genre
    );
  }
  return itemsResult || null;
}

async function createAddon(userConfig) {
  const manifest = {
    id: 'org.stremio.aiolists',
    version: `1.0.0-${Date.now()}`, 
    name: 'AIOLists',
    description: 'Manage all your lists in one place.',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series', 'all'],
    idPrefixes: ['tt'],
    catalogs: [],
    logo: `https://i.imgur.com/DigFuAQ.png`,
    behaviorHints: { configurable: true, configurationRequired: false }
  };

  if (!manifest.idPrefixes.includes('tun_')) {
    manifest.idPrefixes.push('tun_');
  }

  const {
    apiKey, traktAccessToken, listOrder = [], hiddenLists = [], removedLists = [],
    customListNames = {}, mergedLists = {}, importedAddons = {}, listsMetadata = {},
    disableGenreFilter, enableRandomListFeature, randomMDBListUsernames
  } = userConfig;

  const includeGenresInManifest = !disableGenreFilter;
  const hiddenListsSet = new Set(hiddenLists.map(String));
  const removedListsSet = new Set(removedLists.map(String));

  if (enableRandomListFeature && apiKey && randomMDBListUsernames && randomMDBListUsernames.length > 0) {
    let randomCatalogDisplayName = "Random MDBList Catalog"; 
    const randomListDetails = await getRandomMDBListDetailsForManifest(apiKey, randomMDBListUsernames);
    if (randomListDetails && randomListDetails.name) {
        randomCatalogDisplayName = `Discovery`;
    }
    const randomCatalogExtra = [{ name: "skip" }];
    if (includeGenresInManifest) {
        randomCatalogExtra.push({ name: "genre", options: staticGenres });
    }
    manifest.catalogs.push({
        id: 'random_mdblist_catalog', 
        type: 'all', 
        name: customListNames['random_mdblist_catalog'] || randomCatalogDisplayName,
        extra: randomCatalogExtra,
        extraSupported: randomCatalogExtra.map(e => e.name),
        extraRequired: []
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
    if (removedListsSet.has(manifestListIdBase) || hiddenListsSet.has(manifestListIdBase)) continue;
    let displayName = customListNames[manifestListIdBase] || listInfo.name;
    let metadata = { ...(listsMetadata[manifestListIdBase] || listsMetadata[originalId] || {}) };
    let hasMovies = metadata.hasMovies === true;
    let hasShows = metadata.hasShows === true;
    let shouldFetchMetadata = true;
    if (listInfo.source === 'mdblist' && !apiKey) shouldFetchMetadata = false;
    if (listInfo.source === 'trakt' && !traktAccessToken && !listInfo.id?.startsWith('traktpublic_')) shouldFetchMetadata = false;

    if ((typeof metadata.hasMovies !== 'boolean' || typeof metadata.hasShows !== 'boolean' || metadata.errorFetching) && shouldFetchMetadata) {
        let success = false; let fetchRetries = 0;
        if(metadata.errorFetching) delete metadata.errorFetching;
        console.log(`[addonBuilder] Preparing to fetch metadata for ${listInfo.source} list: ${displayName} (ID: ${manifestListIdBase})`);
        while (!success && fetchRetries < MAX_METADATA_FETCH_RETRIES) {
            try {
                const tempUserConfigForMetadata = { 
                    apiKey: userConfig.apiKey, 
                    traktAccessToken: userConfig.traktAccessToken,
                    traktRefreshToken: userConfig.traktRefreshToken, 
                    traktExpiresAt: userConfig.traktExpiresAt,       
                    listsMetadata: {}, 
                    rpdbApiKey: null,
                    randomMDBListUsernames: userConfig.randomMDBListUsernames,
                    enableRandomListFeature: userConfig.enableRandomListFeature 
                };
                let typeForMetaCheck = 'all'; 
                if (listInfo.isMovieList) typeForMetaCheck = 'movie';
                else if (listInfo.isShowList) typeForMetaCheck = 'series';
                if (manifestListIdBase.startsWith('trakt_recommendations_') || manifestListIdBase.startsWith('trakt_trending_') || manifestListIdBase.startsWith('trakt_popular_')) {
                    if (manifestListIdBase.includes("_shows")) typeForMetaCheck = 'series';
                    else if (manifestListIdBase.includes("_movies")) typeForMetaCheck = 'movie';
                }
                if (manifestListIdBase === 'trakt_watchlist') typeForMetaCheck = 'all'; 
                const content = await fetchListContent(manifestListIdBase, tempUserConfigForMetadata, 0, null, typeForMetaCheck);
                hasMovies = content?.hasMovies || false;
                hasShows = content?.hasShows || false;
                if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
                userConfig.listsMetadata[manifestListIdBase] = { 
                    ...(userConfig.listsMetadata[manifestListIdBase] || {}), 
                    hasMovies, 
                    hasShows,
                    lastChecked: new Date().toISOString()
                };
                success = true;
                console.log(`[addonBuilder] Successfully fetched metadata for ${manifestListIdBase}: Movies=${hasMovies}, Shows=${hasShows}`);
            } catch (error) {
                fetchRetries++;
                console.error(`[addonBuilder] Error fetching metadata for ${manifestListIdBase} (attempt ${fetchRetries}/${MAX_METADATA_FETCH_RETRIES}): ${error.message}`);
                if (fetchRetries < MAX_METADATA_FETCH_RETRIES) {
                    const currentRetryDelay = METADATA_FETCH_RETRY_DELAY_MS * Math.pow(2, fetchRetries - 1);
                    console.log(`[addonBuilder] Retrying metadata fetch for ${manifestListIdBase} after ${currentRetryDelay}ms`);
                    await delay(currentRetryDelay);
                } else {
                    console.error(`[addonBuilder] Failed to fetch metadata for ${manifestListIdBase} after ${MAX_METADATA_FETCH_RETRIES} attempts. Marking as no content or using stale if available.`);
                    hasMovies = userConfig.listsMetadata[manifestListIdBase]?.hasMovies || false;
                    hasShows = userConfig.listsMetadata[manifestListIdBase]?.hasShows || false;
                    if (!userConfig.listsMetadata) userConfig.listsMetadata = {};
                    userConfig.listsMetadata[manifestListIdBase] = { 
                        ...(userConfig.listsMetadata[manifestListIdBase] || {}), 
                        hasMovies, 
                        hasShows, 
                        errorFetching: true, 
                        lastChecked: new Date().toISOString()
                    };
                }
            }
        } 
        if (shouldFetchMetadata) {
            if (listInfo.source === 'mdblist') {
                console.log(`[addonBuilder] Processed MDBList ${manifestListIdBase}. Waiting ${DELAY_BETWEEN_DIFFERENT_MDBLISTS_MS}ms before next list metadata fetch.`);
                await delay(DELAY_BETWEEN_DIFFERENT_MDBLISTS_MS);
            } else if (listInfo.source === 'trakt' && !manifestListIdBase.startsWith('traktpublic_')) { 
                console.log(`[addonBuilder] Processed Trakt list ${manifestListIdBase}. Waiting ${DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS}ms.`);
                await delay(DELAY_BETWEEN_DIFFERENT_TRAKT_LISTS_MS);
            }
        }
    } 
    if (hasMovies || hasShows) {
      const isMerged = (hasMovies && hasShows) ? (mergedLists[manifestListIdBase] !== false) : false;
      const catalogExtra = [{ name: "skip" }];
      if (includeGenresInManifest) catalogExtra.push({ name: "genre", options: staticGenres });
      const finalCatalogProps = { name: displayName, extra: catalogExtra, extraSupported: catalogExtra.map(e=>e.name), extraRequired: []};
      if (hasMovies && hasShows && isMerged) manifest.catalogs.push({ id: manifestListIdBase, type: 'all', ...finalCatalogProps });
      else {
        if (hasMovies) manifest.catalogs.push({ id: manifestListIdBase, type: 'movie', ...finalCatalogProps });
        if (hasShows) manifest.catalogs.push({ id: manifestListIdBase, type: 'series', ...finalCatalogProps });
      }
    }
  }
    Object.values(importedAddons || {}).forEach(addon => {
        const addonGroupId = String(addon.id);
        if (removedListsSet.has(addonGroupId) || hiddenListsSet.has(addonGroupId)) return;
        const isMDBListUrlImport = !!addon.isMDBListUrlImport;
        const isTraktPublicList = !!addon.isTraktPublicList;
        if (isMDBListUrlImport || isTraktPublicList) { 
          if (isMDBListUrlImport && !apiKey) return;
          if (addon.hasMovies || addon.hasShows) { 
            let displayName = customListNames[addonGroupId] || addon.name;
            const canBeMerged = addon.hasMovies && addon.hasShows;
            const isMerged = canBeMerged ? (mergedLists?.[addonGroupId] !== false) : false;
            const catalogExtraForUrlImport = [{ name: "skip" }];
            if (includeGenresInManifest) catalogExtraForUrlImport.push({ name: "genre", options: staticGenres });
            const catalogPropsForUrlImport = { name: displayName, extra: catalogExtraForUrlImport, extraSupported: catalogExtraForUrlImport.map(e=>e.name), extraRequired: []};
            if (isMerged) manifest.catalogs.push({ id: addonGroupId, type: 'all', ...catalogPropsForUrlImport });
            else {
              if (addon.hasMovies) manifest.catalogs.push({ id: addonGroupId, type: 'movie', ...catalogPropsForUrlImport });
              if (addon.hasShows) manifest.catalogs.push({ id: addonGroupId, type: 'series', ...catalogPropsForUrlImport });
            }
          }
        } else if (addon.catalogs && addon.catalogs.length > 0) { 
          (addon.catalogs || []).forEach(catalog => {
              const catalogIdForManifest = String(catalog.id);
              if (removedListsSet.has(catalogIdForManifest) || hiddenListsSet.has(catalogIdForManifest)) return;
              let displayName = customListNames[catalogIdForManifest] || catalog.name;
              const finalExtraForImported = [{ name: "skip" }];
              const finalExtraSupportedForImported = ["skip"];
              const originalExtras = (catalog.extraSupported || catalog.extra || []);
              let importedGenreOptions = null;
              originalExtras.forEach(ext => {
                  const extName = (typeof ext === 'string') ? ext : ext.name;
                  const extOptions = (typeof ext === 'object' && ext.options) ? ext.options : undefined;
                  if (extName === "skip") return; 
                  if (extName === "genre") { if (extOptions) importedGenreOptions = extOptions; return; }
                  if (typeof ext === 'string') finalExtraForImported.push({ name: ext });
                  else finalExtraForImported.push({ name: extName, options: extOptions, isRequired: (typeof ext === 'object' && ext.isRequired) ? ext.isRequired : false });
                  finalExtraSupportedForImported.push(extName);
              });
              if (includeGenresInManifest) {
                  finalExtraForImported.push({ name: "genre", options: importedGenreOptions || staticGenres });
                  if (!finalExtraSupportedForImported.includes("genre")) finalExtraSupportedForImported.push("genre");
              }
              manifest.catalogs.push({ id: catalogIdForManifest, type: catalog.type, name: displayName, extra: finalExtraForImported, extraSupported: [...new Set(finalExtraSupportedForImported)], extraRequired: catalog.extraRequired || [] });
          });
        }
      });

    if (listOrder && listOrder.length > 0) {
        const orderMap = new Map(listOrder.map((id, index) => [String(id), index]));
        manifest.catalogs.sort((a, b) => {
            const idA = String(a.id);
            const idB = String(b.id);
            const indexA = orderMap.get(idA);
            const indexB = orderMap.get(idB);
            if (indexA !== undefined && indexB !== undefined) {
                return indexA - indexB;
            } else if (indexA !== undefined) {
                return -1;
            } else if (indexB !== undefined) {
                return 1;
            } else {
                if (idA === 'random_mdblist_catalog') return -1;
                if (idB === 'random_mdblist_catalog') return 1;
                return (a.name || '').localeCompare(b.name || '');
            }
        });
    } else {
        manifest.catalogs.sort((a, b) => {
            const idA = String(a.id);
            const idB = String(b.id);
            if (idA === 'random_mdblist_catalog' && idB !== 'random_mdblist_catalog') return -1;
            if (idB === 'random_mdblist_catalog' && idA !== 'random_mdblist_catalog') return 1;
            return (a.name || '').localeCompare(b.name || '');
        });
    }

  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    const skip = parseInt(extra?.skip) || 0;
    const genre = extra?.genre || null;
    const itemsResult = await fetchListContent(id, userConfig, skip, genre, type);
    if (!itemsResult) return Promise.resolve({ metas: [] });
    let metas = await convertToStremioFormat(itemsResult, userConfig.rpdbApiKey);
    if (type !== 'all' && (type === 'movie' || type === 'series')) {
      metas = metas.filter(meta => meta.type === type);
    } 
    const cacheMaxAge = (id === 'random_mdblist_catalog' || isWatchlist(id)) ? 0 : (5 * 60);
    return Promise.resolve({ metas, cacheMaxAge }); 
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    if (id && typeof id === 'string' && id.startsWith('tun_')) {
      for (const addonKey in userConfig.importedAddons) {
        const addonConfig = userConfig.importedAddons[addonKey];
        if (addonConfig.isTraktUpNext && addonConfig.traktUpNextDynamicPath) {
          try {
            const metaUrl = `https://up-next.dontwanttos.top/${addonConfig.traktUpNextDynamicPath}/meta/${type}/${id}.json`;
            console.log(`[AIOLists TraktUpNext] Fetching meta from: ${metaUrl}`);
            const response = await axios.get(metaUrl, { timeout: 10000 });
            if (response.data && response.data.meta) {
              let fetchedMeta = response.data.meta;
              if (fetchedMeta.id !== id) {
                  if (id.endsWith(fetchedMeta.id) && fetchedMeta.id.startsWith('tt')) {
                       fetchedMeta.id = id;
                  }
              }
              if (userConfig.rpdbApiKey && fetchedMeta.id && typeof fetchedMeta.id === 'string') {
                let imdbIdForPoster = fetchedMeta.id;
                if (imdbIdForPoster.startsWith('tun_')) {
                  imdbIdForPoster = imdbIdForPoster.substring(4);
                }
                if (imdbIdForPoster.startsWith('tt')) {
                  const posterMap = await batchFetchPosters([imdbIdForPoster], userConfig.rpdbApiKey);
                  if (posterMap && posterMap[imdbIdForPoster]) {
                    fetchedMeta.poster = posterMap[imdbIdForPoster];
                  }
                }
              }
              return Promise.resolve({ meta: fetchedMeta });
            } else {
              console.error(`[AIOLists TraktUpNext] Meta or data missing in response for ${id} from ${metaUrl}`);
            }
          } catch (error) {
            console.error(`[AIOLists TraktUpNext] Error fetching meta for ${id}: ${error.message}`);
          }
          return Promise.resolve({ meta: null }); 
        }
      }
    }
    
    if (id.startsWith('tt') || id.startsWith('kitsu') || id.startsWith('tmdb')) {
         return Promise.resolve({ meta: { id: id, type: type, name: "Loading details..." } });
    }

    return Promise.resolve({ meta: null });
  });

  return builder.getInterface();
}

module.exports = { createAddon, fetchListContent };