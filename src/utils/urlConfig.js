const zlib = require('zlib');
const { promisify } = require('util');
const { defaultConfig } = require('../config'); // Ensures defaultConfig is from the backend

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Compress configuration object into a URL-safe string.
 * Sort options are excluded from the compressed string.
 * @param {Object} config Configuration object to compress
 * @returns {Promise<string>} URL-safe compressed string
 */
async function compressConfig(config) {
  try {
    // Create a shallow copy for serialization, excluding specific keys
    const configToSerialize = { ...config };
    delete configToSerialize.availableSortOptions;
    delete configToSerialize.traktSortOptions;

    const configString = JSON.stringify(configToSerialize);
    const compressed = await gzip(Buffer.from(configString, 'utf-8'));
    // Convert to base64 and make URL safe
    return compressed.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (error) {
    console.error('Error compressing config:', error);
    throw new Error('Failed to compress configuration');
  }
}

/**
 * Decompress URL-safe string back into configuration object.
 * Merges with defaultConfig to ensure all fields, including sort options, are present.
 * @param {string} compressed URL-safe compressed string
 * @returns {Promise<Object>} Configuration object
 */
async function decompressConfig(compressed) {
  try {
    if (compressed === 'configure') {
      return { ...defaultConfig };
    }

    if (!compressed || typeof compressed !== 'string') {
      console.warn('DecompressConfig: Invalid or empty compressed string, returning default config.');
      return { ...defaultConfig };
    }

    const cleanCompressed = compressed.trim();
    if (!cleanCompressed) {
      console.warn('DecompressConfig: Cleaned compressed string is empty, returning default config.');
      return { ...defaultConfig };
    }

    const base64 = cleanCompressed
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const pad = base64.length % 4;
    const paddedBase64 = pad ? base64 + '='.repeat(4 - pad) : base64;

    let parsedConfig = {};
    try {
      const buffer = Buffer.from(paddedBase64, 'base64');
      const decompressed = await gunzip(buffer);
      const configString = decompressed.toString('utf-8');
      if (configString) {
        parsedConfig = JSON.parse(configString);
      } else {
        console.warn('DecompressConfig: Decompressed string is empty.');
      }
    } catch (decompressOrParseError) {
      console.error('Error decompressing or parsing config:', decompressOrParseError.message, '- Hash was:', compressed.substring(0, 20) + "...");
      // Fallback to default config on error
      return { ...defaultConfig };
    }
    
    // Merge configs, but preserve environment variables when user config has null/undefined values
    const mergedConfig = { ...defaultConfig, ...parsedConfig };
    
    // If tmdbBearerToken is null/undefined in user config but we have it in environment, use environment value
    if (!parsedConfig.tmdbBearerToken && defaultConfig.tmdbBearerToken) {
      mergedConfig.tmdbBearerToken = defaultConfig.tmdbBearerToken;
    }
    
    return mergedConfig;

  } catch (error) {
    console.error('Unexpected error in decompressConfig:', error);
    return { ...defaultConfig }; // Final fallback
  }
}

/**
 * Creates a shareable version of the config by removing sensitive API keys.
 * @param {Object} config The full configuration object.
 * @returns {Object} A configuration object suitable for sharing.
 */
function createShareableConfig(config) {
  const shareableConfig = JSON.parse(JSON.stringify(config)); 

  delete shareableConfig.apiKey;
  delete shareableConfig.rpdbApiKey;
  delete shareableConfig.tmdbBearerToken;
  delete shareableConfig.tmdbSessionId;
  delete shareableConfig.tmdbAccountId;
  delete shareableConfig.traktAccessToken;
  delete shareableConfig.traktRefreshToken;
  delete shareableConfig.traktExpiresAt;
  delete shareableConfig.mdblistUsername; 
  delete shareableConfig.availableSortOptions;
  delete shareableConfig.traktSortOptions;
  delete shareableConfig.traktUuid;
  delete shareableConfig.upstashUrl;
  delete shareableConfig.upstashToken;
  delete shareableConfig.redisHost;
  delete shareableConfig.redisPort;
  delete shareableConfig.redisPassword;
  delete shareableConfig.redisDatabase;

  return shareableConfig;
}

/**
 * Compress a shareable configuration object into a URL-safe string.
 * @param {Object} config Configuration object to compress.
 * @returns {Promise<string>} URL-safe compressed string for sharing.
 */
async function compressShareableConfig(config) {
  const shareable = createShareableConfig(config); 
  // The main compressConfig already omits sort options, but createShareableConfig also ensures API keys are gone.
  return compressConfig(shareable); 
}

module.exports = {
  compressConfig,
  decompressConfig,
  createShareableConfig,
  compressShareableConfig,
};