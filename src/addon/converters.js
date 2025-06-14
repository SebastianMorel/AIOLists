// src/addon/converters.js
const { batchFetchPosters } = require('../utils/posters');
const { enrichItemsWithMetadata } = require('../utils/metadataFetcher');

async function convertToStremioFormat(listContent, rpdbApiKey = null, metadataConfig = {}) {
  let metas = [];
  if (!listContent) return metas;

  const useRPDB = !!rpdbApiKey;
  
  let itemsToProcess = [];

  if (listContent.allItems && Array.isArray(listContent.allItems)) {
    itemsToProcess = listContent.allItems.map(item => {
        // Support IMDB IDs (tt), TMDB IDs (tmdb:), and custom IDs for TV channels
        let itemId = item.id;
        let imdbId = item.imdb_id || item.imdbid;
        
        // Handle different ID formats based on content type
        if (item.type === 'tv' || item.type === 'channel') {
          // For TV/channel content, use the ID as-is (don't require IMDB format)
          if (!itemId) {
            console.warn('[Converter] TV/channel item missing ID:', item);
            return null;
          }
          // Keep the original ID format for TV channels
        } else if (itemId && (itemId.startsWith('tt') || itemId.startsWith('tmdb:'))) {
          // Traditional content with proper ID format
        } else {
          // Fallback to IMDB ID processing for traditional content
          if (imdbId && !imdbId.startsWith('tt')) imdbId = `tt${imdbId}`;
          if (!imdbId) return null;
          itemId = imdbId;
        }

        // Create base metadata, prioritizing enriched metadata fields over fallbacks
        const baseMeta = {
            id: itemId,
            imdb_id: imdbId, // Always preserve IMDB ID for cross-referencing
            type: item.type,
            // For enriched items, the name should already be in the preferred language/source
            // Only use fallbacks if name is truly missing
            name: item.name || item.title || `Untitled ${item.type}`,
            poster: item.poster,
            background: item.background || item.backdrop,
            description: item.description || item.overview,
            releaseInfo: item.releaseInfo || item.year || item.release_year || 
                         (item.release_date ? item.release_date.split('-')[0] : 
                         (item.first_air_date ? item.first_air_date.split('-')[0] : undefined)),
            imdbRating: item.imdbRating || (item.imdbrating ? (typeof item.imdbrating === 'number' ? item.imdbrating.toFixed(1) : item.imdbrating) : undefined),
            runtime: item.runtime ? `${item.runtime}`.includes(' min') ? item.runtime : `${item.runtime} min` : undefined,
            genres: item.genres || item.genre,
            cast: item.cast,
            director: item.director,
            writer: item.writer,
            awards: item.awards,
            country: item.country,
            trailers: item.trailers,
            trailerStreams: item.trailerStreams,
            dvdRelease: item.dvdRelease,
            links: item.links,
            popularity: item.popularity,
            slug: item.slug,
            behaviorHints: item.behaviorHints || { hasScheduledVideos: false },
        };
        if (item.type === 'series') {
            baseMeta.status = item.status;
        }
        return baseMeta;
    }).filter(item => item !== null);

  } else if (listContent.metas && Array.isArray(listContent.metas)) {
    itemsToProcess = listContent.metas;
  } else {
    const movies = listContent.movies || [];
    const shows = listContent.shows || [];

    movies.forEach(movie => {
      let imdbId = movie.imdb_id || movie.imdbid;
      if (imdbId && !imdbId.startsWith('tt')) imdbId = `tt${imdbId}`;
      if (!imdbId) return;

      itemsToProcess.push({
        id: imdbId,
        type: 'movie',
        name: movie.name || movie.title || 'Untitled Movie',
        poster: movie.poster,
        background: movie.background || movie.backdrop,
        description: movie.description || movie.overview,
        releaseInfo: movie.releaseInfo || movie.year || movie.release_year || (movie.release_date ? movie.release_date.split('-')[0] : undefined),
        imdbRating: movie.imdbRating || (movie.imdbrating ? (typeof movie.imdbrating === 'number' ? movie.imdbrating.toFixed(1) : movie.imdbrating) : undefined),
        runtime: movie.runtime ? `${movie.runtime}`.includes(' min') ? movie.runtime : `${movie.runtime} min` : undefined,
        genres: movie.genres || movie.genre,
        cast: movie.cast,
        director: movie.director,
        writer: movie.writer,
        awards: movie.awards,
        country: movie.country,
        trailers: movie.trailers,
        trailerStreams: movie.trailerStreams,
        dvdRelease: movie.dvdRelease,
        links: movie.links,
        popularity: movie.popularity,
        slug: movie.slug,
        behaviorHints: movie.behaviorHints || {
          hasScheduledVideos: false
        },
      });
    });

    shows.forEach(show => {
      let imdbId = show.imdb_id || show.imdbid;
      if (imdbId && !imdbId.startsWith('tt')) imdbId = `tt${imdbId}`;
      if (!imdbId) return;

      itemsToProcess.push({
        id: imdbId,
        type: 'series',
        name: show.name || show.title || 'Untitled Series',
        poster: show.poster,
        background: show.background || show.backdrop,
        description: show.description || show.overview,
        releaseInfo: show.releaseInfo || show.year || show.release_year || (show.first_air_date ? show.first_air_date.split('-')[0] : undefined),
        imdbRating: show.imdbRating || (show.imdbrating ? (typeof show.imdbrating === 'number' ? show.imdbrating.toFixed(1) : show.imdbrating) : undefined),
        runtime: show.runtime ? `${show.runtime}`.includes(' min') ? show.runtime : `${show.runtime} min` : undefined,
        genres: show.genres || show.genre,
        cast: show.cast,
        director: show.director,
        writer: show.writer,
        awards: show.awards,
        country: show.country,
        trailers: show.trailers,
        trailerStreams: show.trailerStreams,
        dvdRelease: show.dvdRelease,
        links: show.links,
        popularity: show.popularity,
        slug: show.slug,
        status: show.status,
        behaviorHints: show.behaviorHints || {
          hasScheduledVideos: false
        },
      });
    });
  }
  
  itemsToProcess.forEach(meta => {
    Object.keys(meta).forEach(key => meta[key] === undefined && delete meta[key]);
    if (meta.genres && typeof meta.genres === 'string') {
      meta.genres = meta.genres.split(',').map(g => g.trim());
    }
  });

  // Apply RPDB posters if API key is provided - RPDB posters take priority
  if (useRPDB && itemsToProcess.length > 0) {
    // Extract IMDB IDs for RPDB poster fetching
    // Handle both direct IMDB IDs and items with separate imdb_id field
    const imdbIds = [];
    const itemImdbIdMap = new Map(); // Map to track which IMDB ID belongs to which item
    
    itemsToProcess.forEach((item, index) => {
      let imdbId = null;
      
      // Skip RPDB processing for TV/channel content as they don't have IMDB IDs
      if (item.type === 'tv' || item.type === 'channel') {
        return; // Skip RPDB poster fetching for TV channels
      }
      
      // Priority 1: Direct IMDB ID in item.id
      if (item.id && item.id.startsWith('tt')) {
        imdbId = item.id;
      }
      // Priority 2: IMDB ID in imdb_id field (common with TMDB metadata)
      else if (item.imdb_id && item.imdb_id.startsWith('tt')) {
        imdbId = item.imdb_id;
      }
      
      if (imdbId) {
        imdbIds.push(imdbId);
        // Map this IMDB ID to the item index for later reference
        if (!itemImdbIdMap.has(imdbId)) {
          itemImdbIdMap.set(imdbId, []);
        }
        itemImdbIdMap.get(imdbId).push(index);
      }
    });
    
    if (imdbIds.length > 0) {
      // Extract language from metadata config for RPDB posters
      let rpdbLanguage = null;
      if (metadataConfig.tmdbLanguage) {
        // Convert TMDB language format (e.g., 'en-US') to RPDB language format (e.g., 'en')
        rpdbLanguage = metadataConfig.tmdbLanguage.split('-')[0];
      }
      
      // Check if using free t0 key which doesn't support language parameters
      const isFreeT0Key = rpdbApiKey === 't0-free-rpdb';
      const effectiveLanguage = isFreeT0Key ? null : rpdbLanguage;
      
      console.log(`[RPDB] Fetching posters for ${imdbIds.length} items with language: ${effectiveLanguage || 'default'}${isFreeT0Key ? ' (free t0 key - no language support)' : ''}`);
      
      const posterMap = await batchFetchPosters(imdbIds, rpdbApiKey, effectiveLanguage);
      
      // Apply RPDB posters to items (RPDB takes priority over metadata source posters)
      Object.entries(posterMap).forEach(([imdbId, posterUrl]) => {
        if (posterUrl && itemImdbIdMap.has(imdbId)) {
          const itemIndices = itemImdbIdMap.get(imdbId);
          itemIndices.forEach(index => {
            if (itemsToProcess[index]) {
              itemsToProcess[index].poster = posterUrl;
            }
          });
        }
      });
      
    } else {
      console.log(`[RPDB] No valid IMDB IDs found for poster fetching from ${itemsToProcess.length} items`);
    }
    
    metas = itemsToProcess;
  } else {
    metas = itemsToProcess;
  }

  return metas;
}

module.exports = { convertToStremioFormat };