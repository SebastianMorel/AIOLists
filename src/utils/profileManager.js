// src/utils/profileManager.js

const DEFAULT_PROFILE_POSTER_URL = 'https://i.imgur.com/ZgGYfad.jpeg';

function addProfile(userConfig, profileData) {
  const { name, manifestUrl, customPoster } = profileData;
  console.log('[profileManager addProfile] Attempting to add profile:', profileData);

  if (!name || !manifestUrl) {
    console.error('[profileManager addProfile] Validation failed: Name or Manifest URL missing.');
    throw new Error('Profile name and manifest URL are required.');
  }

  try {
    new URL(manifestUrl);
  } catch (e) {
    console.error('[profileManager addProfile] Validation failed: Invalid Manifest URL format.', manifestUrl);
    throw new Error('Invalid manifest URL format.');
  }

  if (!userConfig.connectedProfiles) {
    userConfig.connectedProfiles = [];
    console.log('[profileManager addProfile] Initialized userConfig.connectedProfiles as empty array.');
  }

  const internalId = `profile_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const newProfile = {
    internalId,
    name: name.trim(),
    manifestUrl: manifestUrl.trim(),
    customPoster: customPoster ? customPoster.trim() : null,
  };
  userConfig.connectedProfiles.push(newProfile);
  userConfig.lastUpdated = new Date().toISOString();
  console.log('[profileManager addProfile] Profile added successfully. ID:', internalId, 'Total profiles:', userConfig.connectedProfiles.length);
  return newProfile;
}

function removeProfile(userConfig, internalId) {
  console.log('[profileManager removeProfile] Attempting to remove profile ID:', internalId);
  if (!userConfig.connectedProfiles) {
    console.warn('[profileManager removeProfile] No connectedProfiles array in userConfig.');
    return false;
  }
  const initialLength = userConfig.connectedProfiles.length;
  userConfig.connectedProfiles = userConfig.connectedProfiles.filter(
    profile => profile.internalId !== internalId
  );

  if (userConfig.connectedProfiles.length < initialLength) {
    userConfig.lastUpdated = new Date().toISOString();
    console.log('[profileManager removeProfile] Profile removed. Total profiles:', userConfig.connectedProfiles.length);
    return true;
  }
  console.log('[profileManager removeProfile] Profile not found or no change in length. ID:', internalId);
  return false;
}

function getProfileMetas(userConfig, serverUrl) {
  console.log('[profileManager getProfileMetas] Generating metas. Received userConfig.connectedProfiles:', JSON.stringify(userConfig.connectedProfiles || "undefined/null"));
  if (!userConfig.connectedProfiles || userConfig.connectedProfiles.length === 0) {
    console.log('[profileManager getProfileMetas] No profiles found or empty array, returning [].');
    return []; // This is what happens if the condition is met
  }
  const metas = userConfig.connectedProfiles.map(profile => {
    const posterUrl = profile.customPoster || DEFAULT_PROFILE_POSTER_URL;
    return {
      id: profile.internalId,
      type: 'channel',
      name: profile.name,
      poster: posterUrl,
      description: `Switch to ${profile.name}'s profile.`,
    };
  });
  console.log(`[profileManager getProfileMetas] Mapped ${metas.length} metas.`);
  return metas; // This should return the populated array
}

function getProfileStream(userConfig, internalId, addonBaseUrl) {
  console.log('[profileManager getProfileStream] Generating stream for profile ID:', internalId, 'with addonBaseUrl:', addonBaseUrl);
  const profile = (userConfig.connectedProfiles || []).find(p => p.internalId === internalId);

  if (!addonBaseUrl) {
    console.error("[profileManager getProfileStream] addonBaseUrl is required to create redirect link but was not provided.");
    return null;
  }

  if (profile && profile.manifestUrl) {
    let actualStremioManifestLink;
    const trimmedManifestUrl = profile.manifestUrl.trim();

    if (trimmedManifestUrl.startsWith('stremio://')) {
      try {
        new URL(trimmedManifestUrl);
        actualStremioManifestLink = trimmedManifestUrl;
      } catch (e) {
        console.error("[profileManager getProfileStream] Invalid existing stremio:// URL provided:", trimmedManifestUrl, e.message);
        return null;
      }
    } else if (trimmedManifestUrl.startsWith('http://') || trimmedManifestUrl.startsWith('https://')) {
      try {
        const targetUrl = new URL(trimmedManifestUrl);
        let path = targetUrl.pathname || '/';
        if (targetUrl.search) path += targetUrl.search;
        if (targetUrl.hash) path += targetUrl.hash;
        actualStremioManifestLink = `stremio://${targetUrl.host}${path.startsWith('/') ? path : '/' + path}`;
        
        if (actualStremioManifestLink.startsWith('stremio:////')) {
            actualStremioManifestLink = actualStremioManifestLink.replace('stremio:////', 'stremio://');
        } else if (actualStremioManifestLink.match(/^stremio:\/\/[^/]+\/\//)) {
            actualStremioManifestLink = actualStremioManifestLink.replace(/\/\//, '/');
        }

      } catch (e) {
        console.error("[profileManager getProfileStream] Error parsing HTTP/S profile manifest URL:", trimmedManifestUrl, e.message);
        return null;
      }
    } else {
      console.error("[profileManager getProfileStream] Manifest URL has unknown protocol or is invalid:", trimmedManifestUrl);
      return null;
    }

    // Construct the HTTPS redirector URL
    const redirectorUrl = `${addonBaseUrl}/api/redirect?target=${encodeURIComponent(actualStremioManifestLink)}`;

    console.log('[profileManager getProfileStream] Target Stremio Manifest Link:', actualStremioManifestLink);
    console.log('[profileManager getProfileStream] Generated HTTPS Redirector URL for externalUrl:', redirectorUrl);
    
    return {
      title: `Open Profile: ${profile.name}`,
      externalUrl: redirectorUrl, // Use the HTTPS redirector link
      behaviorHints: { notWebReady: true }
    };
  }

  console.log('[profileManager getProfileStream] Profile not found or manifestUrl missing for ID:', internalId);
  return null;
}

module.exports = {
  addProfile,
  removeProfile,
  getProfileMetas,
  getProfileStream,
  DEFAULT_PROFILE_POSTER_URL
};