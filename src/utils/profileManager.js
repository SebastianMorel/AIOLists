// src/utils/profileManager.js

const DEFAULT_PROFILE_POSTER_URL = 'https://images.metahub.space/poster/small/tt2297757/img'; // Replace with your actual default poster URL

/**
 * Adds a new profile to the user's configuration.
 * The userConfig object is modified directly.
 * @param {object} userConfig - The current user configuration object.
 * @param {object} profileData - Data for the new profile { name, manifestUrl, customPoster }.
 * @returns {object} The newly created profile object.
 * @throws {Error} if name or manifestUrl is missing, or if manifestUrl is invalid.
 */
function addProfile(userConfig, profileData) {
  const { name, manifestUrl, customPoster } = profileData;

  if (!name || !manifestUrl) {
    throw new Error('Profile name and manifest URL are required.');
  }

  try {
    // Basic validation to ensure it's a parsable URL
    new URL(manifestUrl);
  } catch (e) {
    throw new Error('Invalid manifest URL format.');
  }

  if (!userConfig.connectedProfiles) {
    userConfig.connectedProfiles = [];
  }

  // Generate a unique internal ID for the profile
  const internalId = `profile_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const newProfile = {
    internalId,
    name: name.trim(),
    manifestUrl: manifestUrl.trim(),
    customPoster: customPoster ? customPoster.trim() : null,
  };

  userConfig.connectedProfiles.push(newProfile);
  userConfig.lastUpdated = new Date().toISOString(); // Mark config as updated

  return newProfile; // Return the profile that was added
}

/**
 * Removes a profile from the user's configuration by its internal ID.
 * The userConfig object is modified directly.
 * @param {object} userConfig - The current user configuration object.
 * @param {string} internalId - The internal ID of the profile to remove.
 * @returns {boolean} True if a profile was found and removed, false otherwise.
 */
function removeProfile(userConfig, internalId) {
  if (!userConfig.connectedProfiles || userConfig.connectedProfiles.length === 0) {
    return false;
  }

  const initialLength = userConfig.connectedProfiles.length;
  userConfig.connectedProfiles = userConfig.connectedProfiles.filter(
    profile => profile.internalId !== internalId
  );

  if (userConfig.connectedProfiles.length < initialLength) {
    userConfig.lastUpdated = new Date().toISOString(); // Mark config as updated
    return true;
  }
  return false;
}

/**
 * Generates Stremio meta objects for all connected profiles.
 * These are used to display profiles in a Stremio catalog.
 * @param {object} userConfig - The current user configuration.
 * @param {string} [serverUrl] - Optional. The base URL of the addon server, if default posters are served locally.
 * @returns {Array<object>} An array of Stremio meta item objects.
 */
function getProfileMetas(userConfig, serverUrl) {
  if (!userConfig.connectedProfiles || userConfig.connectedProfiles.length === 0) {
    return [];
  }

  return userConfig.connectedProfiles.map(profile => {
    let poster = profile.customPoster || DEFAULT_PROFILE_POSTER_URL;
    // If DEFAULT_PROFILE_POSTER_URL was relative and serverUrl is provided:
    // if (poster === DEFAULT_PROFILE_POSTER_URL && serverUrl && !poster.startsWith('http')) {
    //   poster = `${serverUrl}${poster.startsWith('/') ? '' : '/'}${poster}`;
    // }

    return {
      id: profile.internalId,
      type: 'channel', // This type should match the catalog type and stream handler expectations
      name: profile.name,
      poster: poster,
      description: `Switch to ${profile.name}'s profile.`,
      // behaviorHints can be added if needed, e.g., { notWebReady: true }
    };
  });
}

/**
 * Generates a Stremio stream object for a specific profile.
 * This stream object uses an 'externalUrl' to trigger Stremio to open the target profile's manifest.
 * @param {object} userConfig - The current user configuration.
 * @param {string} internalId - The internal ID of the profile to get the stream for.
 * @returns {object|null} A Stremio stream object, or null if the profile isn't found or manifestUrl is invalid.
 */
function getProfileStream(userConfig, internalId) {
  if (!userConfig.connectedProfiles) {
    return null;
  }

  const profile = userConfig.connectedProfiles.find(p => p.internalId === internalId);

  if (profile && profile.manifestUrl) {
    try {
      const targetManifestUrl = new URL(profile.manifestUrl);
      // Construct the Stremio protocol URL: stremio://<host>/<path_to_manifest>
      const stremioInstallUrl = `stremio://${targetManifestUrl.host}${targetManifestUrl.pathname}${targetManifestUrl.search}${targetManifestUrl.hash}`;

      return {
        title: `Open Profile: ${profile.name}`,
        externalUrl: stremioInstallUrl,
        behaviorHints: {
          notWebReady: true, // Crucial for Stremio to handle this as an external action
        },
      };
    } catch (e) {
      console.error(
        `Invalid manifestUrl for profile ${internalId} ("${profile.name}"): ${profile.manifestUrl}`,
        e
      );
      return null; // Invalid URL, cannot create stream
    }
  }
  return null; // Profile not found
}

module.exports = {
  addProfile,
  removeProfile,
  getProfileMetas,
  getProfileStream,
  DEFAULT_PROFILE_POSTER_URL, // Export if needed by other modules (e.g., frontend for display)
};