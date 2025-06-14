// src/integrations/externalAddons.js
const axios = require('axios');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');

class ExternalAddon {
  constructor(manifestUrl) {
    this.originalManifestUrl = this.normalizeUrl(manifestUrl);
    this.manifest = null;
    this.apiBaseUrl = '';
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

  async import(userConfig) {
    try {
      const response = await axios.get(this.originalManifestUrl);
      this.manifest = response.data;

      if (!this.manifest || !this.manifest.id || !this.manifest.catalogs) {
        throw new Error('Invalid external manifest format: missing id or catalogs');
      }
      
      this.setApiBaseUrlFromManifestUrl();

      const letterboxdStaticPrefix = "github.megadrive.stremio.letterboxd";
      let isSourceManifestALetterboxdList = false;
      if (typeof this.manifest.id === 'string') {
          isSourceManifestALetterboxdList = this.manifest.id.trim().startsWith(letterboxdStaticPrefix + ":");
      }

      if (isSourceManifestALetterboxdList && userConfig && typeof userConfig.letterboxdImportCounter === 'undefined') {
          userConfig.letterboxdImportCounter = 0;
      }

      const idUsageMap = new Map();

      const processedCatalogs = this.manifest.catalogs.map(catalog => {
        if (!catalog.id || !catalog.type) {
            return null;
        }
        const originalCatalogIdFromSource = catalog.id;
        const originalCatalogType = catalog.type;
        
        // For external addons, trust the original type declaration from the addon manifest
        // External addon authors know what type their content is
        let stremioFinalCatalogType = originalCatalogType;

        const hasSearchRequirement = (catalog.extra || []).some(e => e.name === 'search' && e.isRequired);
        if (hasSearchRequirement) {
            return null;
        }
        let aiolistsUniqueCatalogId;
        if (isSourceManifestALetterboxdList && userConfig) {
            userConfig.letterboxdImportCounter++;
            aiolistsUniqueCatalogId = `${letterboxdStaticPrefix}:${userConfig.letterboxdImportCounter}`;
        } else {
            const uniquenessTrackingKey = `${originalCatalogIdFromSource}|${originalCatalogType}`;
            const instanceCount = (idUsageMap.get(uniquenessTrackingKey) || 0) + 1;
            idUsageMap.set(uniquenessTrackingKey, instanceCount);
            aiolistsUniqueCatalogId = `${this.manifest.id.trim()}_${originalCatalogIdFromSource}_${originalCatalogType}`;
            if (instanceCount > 1) {
              aiolistsUniqueCatalogId += `_${instanceCount}`;
            }
        }
        let processedExtraSupported = [];
        const originalExtra = catalog.extraSupported || catalog.extra || [];
        originalExtra.forEach(extraItem => {
            if (extraItem.name === "genre") {
                // Preserve genre options from the external addon manifest
                processedExtraSupported.push({ 
                    name: "genre", 
                    options: extraItem.options || [] 
                });
            } else {
                processedExtraSupported.push(extraItem);
            }
        });
        console.log(`[ExternalAddon] ===== CATALOG PROCESSING DEBUG =====`);
        console.log(`[ExternalAddon] Original catalog from manifest:`, JSON.stringify(catalog, null, 2));
        console.log(`[ExternalAddon] originalCatalogType: "${originalCatalogType}"`);
        console.log(`[ExternalAddon] stremioFinalCatalogType: "${stremioFinalCatalogType}"`);
        console.log(`[ExternalAddon] aiolistsUniqueCatalogId: "${aiolistsUniqueCatalogId}"`);
        console.log(`[ExternalAddon] ===================================`);
        
        const processedCatalog = {
          id: aiolistsUniqueCatalogId,
          originalId: originalCatalogIdFromSource,
          originalManifestId: this.manifest.id.trim(),
          originalType: originalCatalogType,
          name: catalog.name || 'Unnamed Catalog',
          type: stremioFinalCatalogType,
          extraSupported: processedExtraSupported,
          extraRequired: catalog.extraRequired || (catalog.extra || []).filter(e => e.isRequired)
        };
        
        console.log(`[ExternalAddon] ===== FINAL PROCESSED CATALOG =====`);
        console.log(`[ExternalAddon] Processed catalog:`, JSON.stringify(processedCatalog, null, 2));
        console.log(`[ExternalAddon] ===============================`);
        
        return processedCatalog;
      }).filter(catalog => catalog !== null);

      let tentativeLogo = this.manifest.logo;
      const defaultLogoUrl = "https://cdn-icons-png.flaticon.com/512/32/32465.png";

      if (tentativeLogo && typeof tentativeLogo === 'string') {
        tentativeLogo = tentativeLogo.trim();
        if (!tentativeLogo.startsWith('http://') && !tentativeLogo.startsWith('https://') && !tentativeLogo.startsWith('data:')) {
          try { 
            tentativeLogo = new URL(tentativeLogo, this.apiBaseUrl).href; 
          } catch (e) {
            console.warn(`[ExternalAddon] Malformed logo URL or base URL for: ${this.manifest.logo}, base: ${this.apiBaseUrl}. Using default logo.`);
            tentativeLogo = defaultLogoUrl;
          }
        }
      } else {
        // No logo URL provided or it's not a string
        if (this.manifest.hasOwnProperty('logo') && this.manifest.logo !== null && typeof this.manifest.logo !== 'undefined') { // if 'logo' key exists but value is weird
          console.warn(`[ExternalAddon] Invalid logo value specified for addon ${this.manifest.id}: ${this.manifest.logo}. Using default logo.`);
        }
        tentativeLogo = defaultLogoUrl;
      }

      let finalLogo = tentativeLogo;

      // If the tentativeLogo is an HTTP/HTTPS URL, try to verify its accessibility
      if (finalLogo && finalLogo.startsWith('http')) {
        try {
          await axios.head(finalLogo, { timeout: 3500 }); // Short timeout for HEAD request
        } catch (error) {
          console.warn(`[ExternalAddon] Logo URL ${finalLogo} for addon ${this.manifest.id.trim()} appears broken or inaccessible. Error: ${error.message}. Falling back to default logo.`);
          finalLogo = defaultLogoUrl;
        }
      } else if (!finalLogo || typeof finalLogo !== 'string' || (!finalLogo.startsWith('data:') && !finalLogo.startsWith('http'))) {
        if (finalLogo !== defaultLogoUrl) { // Avoid redundant console log if it was already set to default
            console.warn(`[ExternalAddon] Final logo for ${this.manifest.id.trim()} is invalid (${finalLogo}). Using default logo.`);
        }
        finalLogo = defaultLogoUrl;
      }

      return {
        id: this.manifest.id.trim(),
        name: this.manifest.name || 'Unknown Addon',
        version: this.manifest.version || '0.0.0',
        logo: finalLogo, // Use the validated or default logo
        apiBaseUrl: this.apiBaseUrl,
        catalogs: processedCatalogs,
        types: this.manifest.types || [],
        resources: this.manifest.resources || [],
        idPrefixes: this.manifest.idPrefixes || [],
        isAnime: this.detectAnimeCatalogs()
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
    // ... (detectAnimeCatalogs method remains the same)
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

async function importExternalAddon(manifestUrl, userConfig) {
  const addon = new ExternalAddon(manifestUrl);
  return await addon.import(userConfig);
}

async function fetchExternalAddonItems(targetOriginalId, targetOriginalType, sourceAddonConfig, skip = 0, rpdbApiKey = null, genre = null, userConfig = null) {
  let attemptedUrl = "Unknown (URL could not be constructed before error)";
  try {
    if (!sourceAddonConfig || !sourceAddonConfig.apiBaseUrl || !sourceAddonConfig.catalogs) {
      console.error('[AIOLists ExternalAddon] Invalid source addon configuration for fetching items. Config:', sourceAddonConfig);
      return { metas: [], hasMovies: false, hasShows: false, hasChannels: false, hasContent: false };
    }
    const catalogEntry = sourceAddonConfig.catalogs.find(
      c => c.originalId === targetOriginalId && c.originalType === targetOriginalType
    );
    if (!catalogEntry) {
      const fallbackCatalogEntry = sourceAddonConfig.catalogs.find(c => c.id === targetOriginalId && c.originalType === targetOriginalType);
      if (!fallbackCatalogEntry) {
        console.warn(`[AIOLists ExternalAddon] Catalog not found for originalId: ${targetOriginalId}, type: ${targetOriginalType} in addon ${sourceAddonConfig.name}`);
        return { metas: [], hasMovies: false, hasShows: false, hasChannels: false, hasContent: false };
      }
    }
    const tempExternalAddon = new ExternalAddon(sourceAddonConfig.apiBaseUrl); 
    tempExternalAddon.apiBaseUrl = sourceAddonConfig.apiBaseUrl;
    attemptedUrl = tempExternalAddon.buildCatalogUrl(catalogEntry.originalId, catalogEntry.originalType, skip, genre);
    const response = await axios.get(attemptedUrl, { timeout: 20000 });
    if (!response.data || !Array.isArray(response.data.metas)) {
      console.error(`[AIOLists ExternalAddon] Invalid metadata response from ${attemptedUrl}: Data or metas array missing. Response:`, response.data);
      return { metas: [], hasMovies: false, hasShows: false, hasChannels: false, hasContent: false };
    }
    let metasFromExternal = response.data.metas;
    if (sourceAddonConfig && typeof sourceAddonConfig.name === 'string' && sourceAddonConfig.name.toLowerCase().includes('trakt up next')) {
        metasFromExternal = metasFromExternal.map(meta => {
            if (meta && typeof meta.id === 'string' && meta.id.startsWith('tun_')) {
                const correctedId = meta.id.substring(4);
                if (/^tt\d+$/.test(correctedId)) {
                    return { ...meta, id: correctedId };
                }
            }
            return meta;
        });
    }
    // No metadata enrichment here - this will be done in the addon builder when serving to Stremio
    let enrichedMetas = metasFromExternal;
    let finalMetas = enrichedMetas;
    if (genre && finalMetas.length > 0) {
        // Basic genre filtering - comprehensive filtering will happen after enrichment in addon builder
        finalMetas = finalMetas.filter(meta => {
            // Most external addon items may not have detailed genre data at this stage
            // This filtering will be more comprehensive after enrichment in the addon builder
            return true; // For now, include all items - genre filtering will happen after enrichment
        });
    }
    const hasMovies = finalMetas.some(m => m.type === 'movie');
    const hasShows = finalMetas.some(m => m.type === 'series');
    const hasChannels = finalMetas.some(m => m.type === 'tv' || m.type === 'channel');
    const hasTv = finalMetas.some(m => m.type === 'tv');
    
    return { 
        metas: finalMetas, 
        hasMovies, 
        hasShows, 
        hasChannels,
        hasTv,
        // For compatibility with existing code that checks hasMovies/hasShows
        // Also return true for hasContent if we have any type of content
        hasContent: finalMetas.length > 0
    };
  } catch (error) {
    console.error(`[AIOLists ExternalAddon] Error fetching items for external catalog ID '${targetOriginalId}' (type: '${targetOriginalType}', from addon '${sourceAddonConfig?.name}'). Attempted URL: ${attemptedUrl}. Error:`, error.message);
    if (error.response) {
        console.error("[AIOLists ExternalAddon] Error response status:", error.response.status);
    } else {
        console.error("[AIOLists ExternalAddon] Error stack:", error.stack);
    }
    return { metas: [], hasMovies: false, hasShows: false, hasChannels: false, hasContent: false };
  }
}

module.exports = {
  importExternalAddon,
  fetchExternalAddonItems,
  ExternalAddon 
};