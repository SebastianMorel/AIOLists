// src/utils/remoteStorage.js
const { Redis } = require('@upstash/redis');
const { createClient } = require('redis');

// Helper function to create appropriate Redis client
async function createRedisClient(userConfig) {
    // Check if using standard Redis
    if (userConfig.redisHost) {
        console.log(`[REDIS] Creating standard Redis client - Host: ${userConfig.redisHost}, Port: ${userConfig.redisPort || 6379}, DB: ${userConfig.redisDatabase || 0}`);
        const client = createClient({
            socket: {
                host: userConfig.redisHost,
                port: userConfig.redisPort || 6379
            },
            password: userConfig.redisPassword || undefined,
            database: userConfig.redisDatabase || 0
        });
        await client.connect();
        console.log(`[REDIS] Successfully connected to Redis`);
        return { client, type: 'standard' };
    }
    
    // Use Upstash Redis
    if (userConfig.upstashUrl && userConfig.upstashToken) {
        console.log(`[UPSTASH] Creating Upstash Redis client - URL: ${userConfig.upstashUrl}`);
        const client = new Redis({
            url: userConfig.upstashUrl,
            token: userConfig.upstashToken,
        });
        console.log(`[UPSTASH] Successfully created Upstash client`);
        return { client, type: 'upstash' };
    }
    
    throw new Error('No Redis configuration provided');
}

// Helper function to get value from Redis client
async function getFromRedis(client, type, key) {
    if (type === 'standard') {
        const data = await client.get(key);
        if (data === null || data === undefined) {
            console.log(`[REDIS] Key '${key}' not found in Redis`);
            return null;
        }
        try {
            const parsed = JSON.parse(data);
            console.log(`[REDIS] Successfully parsed data for key '${key}'`);
            return parsed;
        } catch (error) {
            console.error(`[REDIS] Failed to parse JSON data for key '${key}':`, error.message);
            console.error(`[REDIS] Raw data:`, data);
            return null;
        }
    } else {
        const data = await client.get(key);
        if (data === null || data === undefined) {
            console.log(`[UPSTASH] Key '${key}' not found in Redis`);
            return null;
        }
        console.log(`[UPSTASH] Successfully retrieved data for key '${key}'`);
        return data;
    }
}

// Helper function to set value in Redis client
async function setToRedis(client, type, key, value) {
    if (type === 'standard') {
        const jsonData = JSON.stringify(value);
        console.log(`[REDIS] Setting key '${key}' with JSON data length: ${jsonData.length}`);
        await client.set(key, jsonData);
        console.log(`[REDIS] Successfully set key '${key}'`);
    } else {
        console.log(`[UPSTASH] Setting key '${key}' with object data`);
        await client.set(key, value);
        console.log(`[UPSTASH] Successfully set key '${key}'`);
    }
}

// Helper function to cleanup Redis client
async function closeRedisClient(client, type) {
    if (type === 'standard') {
        await client.disconnect();
    }
    // Upstash client doesn't need explicit cleanup
}

async function getTraktTokens(userConfig) {
    const hasUpstash = userConfig.upstashUrl && userConfig.upstashToken;
    const hasRedis = userConfig.redisHost;
    
    if (!hasUpstash && !hasRedis) {
        console.log('[REDIS] getTraktTokens: No Redis configuration provided');
        return null;
    }
    
    if (!userConfig.traktUuid) {
        console.log('[REDIS] getTraktTokens: Missing traktUuid');
        return null;
    }

    let client, type;
    try {
        console.log('[REDIS] Creating Redis connection...');
        const redisConnection = await createRedisClient(userConfig);
        client = redisConnection.client;
        type = redisConnection.type;

        const redisKey = `trakt:${userConfig.traktUuid}`;
        const logPrefix = type === 'upstash' ? '[UPSTASH]' : '[REDIS]';
        console.log(`${logPrefix} Attempting to get tokens from Redis key: ${redisKey}`);
        console.log(`${logPrefix} Redis config - Host: ${userConfig.redisHost}, Port: ${userConfig.redisPort}, DB: ${userConfig.redisDatabase}`);
        
        const data = await getFromRedis(client, type, redisKey);
        console.log(`${logPrefix} Retrieved tokens:`, {
            found: !!data,
            hasAccessToken: !!data?.accessToken,
            hasRefreshToken: !!data?.refreshToken,
            expiresAt: data?.expiresAt,
            dataType: typeof data,
            dataKeys: data ? Object.keys(data) : 'null'
        });
        
        // If no data found, run debug to understand why
        if (!data) {
            console.log(`${logPrefix} No tokens found, running debug analysis...`);
            await closeRedisClient(client, type);
            client = null; // Prevent double-close in finally block
            await debugTraktTokens(userConfig);
        }
        
        return data;
    } catch (error) {
        const logPrefix = type === 'upstash' ? 'Upstash' : 'Redis';
        console.error(`${logPrefix} Error: Failed to get Trakt tokens:`, error.message);
        console.error(`${logPrefix} Error stack:`, error.stack);
        return null;
    } finally {
        if (client && type) {
            try {
                await closeRedisClient(client, type);
                console.log(`[REDIS] Closed Redis connection`);
            } catch (err) {
                console.error('Error closing Redis client:', err.message);
            }
        }
    }
}

async function saveTraktTokens(userConfig, tokens) {
    const hasUpstash = userConfig.upstashUrl && userConfig.upstashToken;
    const hasRedis = userConfig.redisHost;
    
    if (!hasUpstash && !hasRedis) {
        console.log('[REDIS] saveTraktTokens: No Redis configuration provided');
        return;
    }
    
    if (!userConfig.traktUuid) {
        console.log('[REDIS] saveTraktTokens: Missing traktUuid');
        return;
    }

    // Don't save if all token values are null/undefined
    if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) {
        console.log('[REDIS] saveTraktTokens: No valid tokens to save, skipping');
        return;
    }

    let client, type;
    try {
        console.log('[REDIS] Creating Redis connection for save...');
        const redisConnection = await createRedisClient(userConfig);
        client = redisConnection.client;
        type = redisConnection.type;

        const redisKey = `trakt:${userConfig.traktUuid}`;
        const logPrefix = type === 'upstash' ? '[UPSTASH]' : '[REDIS]';
        console.log(`${logPrefix} Saving tokens to Redis key: ${redisKey}`);
        console.log(`${logPrefix} Redis config - Host: ${userConfig.redisHost}, Port: ${userConfig.redisPort}, DB: ${userConfig.redisDatabase}`);
        console.log(`${logPrefix} Tokens being saved:`, {
            hasAccessToken: !!tokens.accessToken,
            hasRefreshToken: !!tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            expiresAtType: typeof tokens.expiresAt,
            tokenKeys: tokens ? Object.keys(tokens) : 'null'
        });
        
        await setToRedis(client, type, redisKey, tokens);
        console.log(`${logPrefix} Successfully saved tokens to Redis`);
        
        // Close the current connection before verification to ensure fresh connection
        await closeRedisClient(client, type);
        console.log(`${logPrefix} Closed save connection, creating fresh connection for verification`);
        
        // Verify the save by reading back with a fresh connection
        const verifyConnection = await createRedisClient(userConfig);
        const verifyClient = verifyConnection.client;
        const verifyType = verifyConnection.type;
        
        const verification = await getFromRedis(verifyClient, verifyType, redisKey);
        console.log(`${logPrefix} Verification read back:`, {
            hasAccessToken: !!verification?.accessToken,
            hasRefreshToken: !!verification?.refreshToken,
            expiresAt: verification?.expiresAt,
            expiresAtType: typeof verification?.expiresAt,
            verificationSuccess: !!(verification?.accessToken && verification?.refreshToken)
        });
        
        await closeRedisClient(verifyClient, verifyType);
        console.log(`${logPrefix} Closed verification connection`);
        
        // Clear client reference so finally block doesn't try to close it again
        client = null;
        
    } catch (error) {
        const logPrefix = type === 'upstash' ? 'Upstash' : 'Redis';
        console.error(`${logPrefix} Error: Failed to save Trakt tokens:`, error.message);
        console.error(`${logPrefix} Error stack:`, error.stack);
        throw error; // Re-throw to ensure calling code knows it failed
    } finally {
        if (client && type) {
            try {
                await closeRedisClient(client, type);
                console.log(`[REDIS] Closed Redis connection after save`);
            } catch (err) {
                console.error('Error closing Redis client:', err.message);
            }
        }
    }
}

async function debugTraktTokens(userConfig) {
    const hasUpstash = userConfig.upstashUrl && userConfig.upstashToken;
    const hasRedis = userConfig.redisHost;
    
    if (!hasUpstash && !hasRedis) {
        console.log('[REDIS DEBUG] No Redis configuration provided');
        return null;
    }
    
    if (!userConfig.traktUuid) {
        console.log('[REDIS DEBUG] Missing traktUuid');
        return null;
    }

    let client, type;
    try {
        console.log('[REDIS DEBUG] Creating Redis connection for debugging...');
        const redisConnection = await createRedisClient(userConfig);
        client = redisConnection.client;
        type = redisConnection.type;

        const redisKey = `trakt:${userConfig.traktUuid}`;
        const logPrefix = type === 'upstash' ? '[UPSTASH DEBUG]' : '[REDIS DEBUG]';
        console.log(`${logPrefix} Debugging Redis key: ${redisKey}`);
        
        // Get raw data without parsing
        if (type === 'standard') {
            const rawData = await client.get(redisKey);
            console.log(`${logPrefix} Raw Redis data:`, rawData);
            console.log(`${logPrefix} Raw data type:`, typeof rawData);
            console.log(`${logPrefix} Raw data length:`, rawData ? rawData.length : 'null');
            
            // Try to list all keys that match the pattern
            const keys = await client.keys('trakt:*');
            console.log(`${logPrefix} All trakt keys in Redis:`, keys);
            
            if (rawData) {
                try {
                    const parsed = JSON.parse(rawData);
                    console.log(`${logPrefix} Parsed data:`, parsed);
                } catch (parseError) {
                    console.error(`${logPrefix} Failed to parse raw data:`, parseError.message);
                }
            }
        } else {
            const upstashData = await client.get(redisKey);
            console.log(`${logPrefix} Upstash data:`, upstashData);
            console.log(`${logPrefix} Upstash data type:`, typeof upstashData);
        }
        
    } catch (error) {
        const logPrefix = type === 'upstash' ? 'Upstash DEBUG' : 'Redis DEBUG';
        console.error(`${logPrefix} Error during debug:`, error.message);
        console.error(`${logPrefix} Error stack:`, error.stack);
    } finally {
        if (client && type) {
            try {
                await closeRedisClient(client, type);
                console.log(`[REDIS DEBUG] Closed Redis connection after debug`);
            } catch (err) {
                console.error('Error closing Redis client during debug:', err.message);
            }
        }
    }
}

async function clearTraktTokens(userConfig) {
    const hasUpstash = userConfig.upstashUrl && userConfig.upstashToken;
    const hasRedis = userConfig.redisHost;
    
    if (!hasUpstash && !hasRedis) {
        console.log('[REDIS] clearTraktTokens: No Redis configuration provided');
        return;
    }
    
    if (!userConfig.traktUuid) {
        console.log('[REDIS] clearTraktTokens: Missing traktUuid');
        return;
    }

    let client, type;
    try {
        console.log('[REDIS] Creating Redis connection for clear...');
        const redisConnection = await createRedisClient(userConfig);
        client = redisConnection.client;
        type = redisConnection.type;

        const redisKey = `trakt:${userConfig.traktUuid}`;
        const logPrefix = type === 'upstash' ? '[UPSTASH]' : '[REDIS]';
        console.log(`${logPrefix} Clearing tokens from Redis key: ${redisKey}`);
        
        if (type === 'standard') {
            await client.del(redisKey);
        } else {
            await client.del(redisKey);
        }
        
        console.log(`${logPrefix} Successfully cleared tokens from Redis`);
        
    } catch (error) {
        const logPrefix = type === 'upstash' ? 'Upstash' : 'Redis';
        console.error(`${logPrefix} Error: Failed to clear Trakt tokens:`, error.message);
        console.error(`${logPrefix} Error stack:`, error.stack);
    } finally {
        if (client && type) {
            try {
                await closeRedisClient(client, type);
                console.log(`[REDIS] Closed Redis connection after clear`);
            } catch (err) {
                console.error('Error closing Redis client:', err.message);
            }
        }
    }
}

module.exports = { getTraktTokens, saveTraktTokens, clearTraktTokens, debugTraktTokens };