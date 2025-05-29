// src/integrations/externalAddons.js
const axios = require('axios');
const { enrichItemsWithCinemeta } = require('../utils/metadataFetcher');

class ExternalAddon {
  constructor(manifestUrl) {
    this.originalManifestUrl = this.normalizeUrl(manifestUrl);
    this.manifest = null;
    this.apiBaseUrl = ''; // Base URL for API calls, derived from manifest URL
  }

  normalizeUrl(url) {
    if (url.startsWith('stremio://')) {
      return 'https://' + url.substring(10);
    }
    return url;
  }

  setApiBaseUrlFromManifestUrl() {
    const fullUrl = this.originalManifestUrl;
    const manifestPathSegment = "/manifest.json";

    if (fullUrl.endsWith(manifestPathSegment)) {
      this.apiBaseUrl = fullUrl.substring(0, fullUrl.length - manifestPathSegment.length + 1); 
    } else {
      this.apiBaseUrl = fullUrl.endsWith('/') ? fullUrl : fullUrl + '/';
    }
  }

  async import() {
    try {
      const response = await axios.get(this.originalManifestUrl);
      this.manifest = response.data;

      if (!this.manifest || !this.manifest.id || !this.manifest.catalogs) {
        throw new Error('Invalid external manifest format: missing id or catalogs');
      }
      
      this.setApiBaseUrlFromManifestUrl();

      // --- New logic to detect "Trakt up next" and store its dynamic path ---
      let isTraktUpNext = false;
      let traktUpNextDynamicPath = null;
      const traktUpNextHost = "up-next.dontwanttos.top"; // Host for the special addon

      if (this.originalManifestUrl.includes(traktUpNextHost)) {
        // Example manifest URL: https://up-next.dontwanttos.top/DYNAMIC_PART/manifest.json
        const urlPathParts = new URL(this.originalManifestUrl).pathname.split('/').filter(p => p); // Get path parts
        // Expected: [DYNAMIC_PART, "manifest.json"]
        if (urlPathParts.length === 2 && urlPathParts[1] === "manifest.json") {
          traktUpNextDynamicPath = urlPathParts[0];
          isTraktUpNext = true;
          console.log(`[AIOLists ExternalAddon] Detected TraktUpNext addon with dynamic path: ${traktUpNextDynamicPath}`);
        }
      }
      // --- End of new logic ---

      const idUsageMap = new Map();
      const processedCatalogs = this.manifest.catalogs.map(catalog => {
        if (!catalog.id || !catalog.type) {
            return null; 
        }
        const originalCatalogId = catalog.id;
        const originalCatalogType = catalog.type;
        let stremioFinalCatalogType = originalCatalogType;
        if (originalCatalogType === 'tv') stremioFinalCatalogType = 'series';
        if (originalCatalogType !== 'movie' && originalCatalogType !== 'series' && originalCatalogType !== 'all') {
            stremioFinalCatalogType = 'all';
        }
        const uniquenessTrackingKey = `${originalCatalogId}|${originalCatalogType}`;
        const instanceCount = (idUsageMap.get(uniquenessTrackingKey) || 0) + 1;
        idUsageMap.set(uniquenessTrackingKey, instanceCount);
        let aiolistsUniqueCatalogId = `${this.manifest.id}_${originalCatalogId}_${originalCatalogType}`;
        if (instanceCount > 1) {
          aiolistsUniqueCatalogId += `_${instanceCount}`;
        }
        const hasSearchRequirement = (catalog.extra || []).some(e => e.name === 'search' && e.isRequired);
        if (hasSearchRequirement) {
            return null;
        }
        let processedExtraSupported = [];
        const originalExtra = catalog.extraSupported || catalog.extra || [];
        originalExtra.forEach(extraItem => {
            if (extraItem.name === "genre") {
                processedExtraSupported.push({ name: "genre" });
            } else {
                processedExtraSupported.push(extraItem);
            }
        });
        return {
          id: aiolistsUniqueCatalogId,
          originalId: originalCatalogId,
          originalType: originalCatalogType,
          name: catalog.name || 'Unnamed Catalog',
          type: stremioFinalCatalogType,
          extraSupported: processedExtraSupported,
          extraRequired: catalog.extraRequired || (catalog.extra || []).filter(e => e.isRequired)
        };
      }).filter(catalog => catalog !== null);

      let resolvedLogo = this.manifest.logo;
      if (resolvedLogo && !resolvedLogo.startsWith('http://') && !resolvedLogo.startsWith('https://') && !resolvedLogo.startsWith('data:')) {
        try { resolvedLogo = new URL(resolvedLogo, this.apiBaseUrl).href; } catch (e) { resolvedLogo = this.manifest.logo; }
      }

      return {
        id: this.manifest.id,
        name: this.manifest.name || 'Unknown Addon',
        version: this.manifest.version || '0.0.0',
        logo: resolvedLogo,
        apiBaseUrl: this.apiBaseUrl,
        catalogs: processedCatalogs,
        types: this.manifest.types || [],
        resources: this.manifest.resources || [],
        isAnime: this.detectAnimeCatalogs(),
        isTraktUpNext: isTraktUpNext, // Store the flag
        traktUpNextDynamicPath: traktUpNextDynamicPath // Store the dynamic path
      };
    } catch (error) {
      console.error(`[AIOLists ExternalAddon] Error importing addon from ${this.originalManifestUrl}:`, error.message, error.stack);
      let specificError = error.message;
      if (error.response) {
        specificError += ` (Status: ${error.response.status})`;
      }
      throw new Error(`Failed to import addon: ${specificError}`);
    }
  }

  detectAnimeCatalogs() {
    const nameIncludesAnime = this.manifest?.name?.toLowerCase().includes('anime');
    const urlIncludesAnimeSource = ['myanimelist', 'anilist', 'anidb', 'kitsu', 'livechart', 'notify.moe'].some(src => this.originalManifestUrl.toLowerCase().includes(src));
    const hasAnimeTypeInManifestTypes = this.manifest?.types?.includes('anime');
    const hasAnimeTypeCatalog = this.manifest?.catalogs?.some(cat => cat.type === 'anime');
    return !!(nameIncludesAnime || urlIncludesAnimeSource || hasAnimeTypeInManifestTypes || hasAnimeTypeCatalog);
  }

  buildCatalogUrl(catalogOriginalId, catalogOriginalType, skip = 0, genre = null) {
    let urlPath = `catalog/${catalogOriginalType}/${encodeURIComponent(catalogOriginalId)}`;
    const extraParams = [];
    if (skip > 0) extraParams.push(`skip=${skip}`);
    if (genre) extraParams.push(`genre=${encodeURIComponent(genre)}`); 
    if (extraParams.length > 0) {
      urlPath += `/${extraParams.join('&')}`;
    }
    urlPath += '.json';
    return this.apiBaseUrl + urlPath;
  }
}

async function importExternalAddon(manifestUrl) {
  const addon = new ExternalAddon(manifestUrl);
  return await addon.import();
}

// Reverted fetchExternalAddonItems to its state before the previous "tun_" stripping attempt.
// Enrichment and genre filtering order is maintained as it was.
async function fetchExternalAddonItems(targetOriginalId, targetOriginalType, sourceAddonConfig, skip = 0, rpdbApiKey = null, genre = null) {
  let attemptedUrl = "Unknown (URL could not be constructed before error)";
  try {
    if (!sourceAddonConfig || !sourceAddonConfig.apiBaseUrl || !sourceAddonConfig.catalogs) {
      console.error('[AIOLists ExternalAddon] Invalid source addon configuration for fetching items. Config:', sourceAddonConfig);
      return { metas: [], hasMovies: false, hasShows: false };
    }

    const catalogEntry = sourceAddonConfig.catalogs.find(
      c => c.originalId === targetOriginalId && c.originalType === targetOriginalType
    );

    if (!catalogEntry) {
      return { metas: [], hasMovies: false, hasShows: false };
    }
    
    const tempExternalAddon = new ExternalAddon(sourceAddonConfig.apiBaseUrl);
    tempExternalAddon.apiBaseUrl = sourceAddonConfig.apiBaseUrl;

    attemptedUrl = tempExternalAddon.buildCatalogUrl(catalogEntry.originalId, catalogEntry.originalType, skip, genre);
        
    const response = await axios.get(attemptedUrl, { timeout: 20000 });
    
    if (!response.data || !Array.isArray(response.data.metas)) {
      console.error(`[AIOLists ExternalAddon] Invalid metadata response from ${attemptedUrl}: Data or metas array missing. Response:`, response.data);
      return { metas: [], hasMovies: false, hasShows: false };
    }

    let metas = response.data.metas; // Raw metas from the external addon

    let enrichedMetas = [];
    if (metas.length > 0) {
        enrichedMetas = await enrichItemsWithCinemeta(metas.filter(m => m.id && !m.id.startsWith('tun_'))); // Example: only enrich non-tun items
         metas.forEach(metaItem => { // Add back tun_ items if they were filtered out for enrichment
            if(metaItem.id && metaItem.id.startsWith('tun_') && !enrichedMetas.find(em => em.id === metaItem.id)){
                enrichedMetas.push(metaItem);
            }
        });
    }
    
    let finalMetas = enrichedMetas;
    if (genre && finalMetas.length > 0) {
        finalMetas = finalMetas.filter(meta => 
            meta.genres && 
            Array.isArray(meta.genres) && 
            meta.genres.map(g => String(g).toLowerCase()).includes(String(genre).toLowerCase())
        );
    }
    
    const hasMovies = finalMetas.some(m => m.type === 'movie');
    const hasShows = finalMetas.some(m => m.type === 'series');

    return { metas: finalMetas, hasMovies, hasShows };

  } catch (error) {
    console.error(`[AIOLists ExternalAddon] Error fetching items for external catalog ID '${targetOriginalId}' (type: '${targetOriginalType}', from addon '${sourceAddonConfig?.name}'). Attempted URL: ${attemptedUrl}. Error:`, error.message);
    if (error.response) {
        console.error("[AIOLists ExternalAddon] Error response status:", error.response.status);
    } else {
        console.error("[AIOLists ExternalAddon] Error stack:", error.stack);
    }
    return { metas: [], hasMovies: false, hasShows: false };
  }
}

module.exports = {
  importExternalAddon,
  fetchExternalAddonItems,
  ExternalAddon
};