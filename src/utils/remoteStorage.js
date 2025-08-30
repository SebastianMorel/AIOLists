// src/utils/remoteStorage.js
const { Redis } = require('@upstash/redis');
const { createClient } = require('redis');

// Helper function to create appropriate Redis client
async function createRedisClient(userConfig) {
    // Check if using standard Redis
    if (userConfig.redisHost) {
        const client = createClient({
            socket: {
                host: userConfig.redisHost,
                port: userConfig.redisPort || 6379
            },
            password: userConfig.redisPassword || undefined,
            database: userConfig.redisDatabase || 0
        });
        await client.connect();
        return { client, type: 'standard' };
    }
    
    // Use Upstash Redis
    if (userConfig.upstashUrl && userConfig.upstashToken) {
        const client = new Redis({
            url: userConfig.upstashUrl,
            token: userConfig.upstashToken,
        });
        return { client, type: 'upstash' };
    }
    
    throw new Error('No Redis configuration provided');
}

// Helper function to get value from Redis client
async function getFromRedis(client, type, key) {
    if (type === 'standard') {
        const data = await client.get(key);
        return data ? JSON.parse(data) : null;
    } else {
        return await client.get(key);
    }
}

// Helper function to set value in Redis client
async function setToRedis(client, type, key, value) {
    if (type === 'standard') {
        await client.set(key, JSON.stringify(value));
    } else {
        await client.set(key, value);
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
        const redisConnection = await createRedisClient(userConfig);
        client = redisConnection.client;
        type = redisConnection.type;

        const redisKey = `trakt:${userConfig.traktUuid}`;
        const logPrefix = type === 'upstash' ? '[UPSTASH]' : '[REDIS]';
        console.log(`${logPrefix} Attempting to get tokens from Redis key: ${redisKey}`);
        
        const data = await getFromRedis(client, type, redisKey);
        console.log(`${logPrefix} Retrieved tokens:`, {
            found: !!data,
            hasAccessToken: !!data?.accessToken,
            hasRefreshToken: !!data?.refreshToken,
            expiresAt: data?.expiresAt
        });
        
        return data;
    } catch (error) {
        const logPrefix = type === 'upstash' ? 'Upstash' : 'Redis';
        console.error(`${logPrefix} Error: Failed to get Trakt tokens:`, error.message);
        return null;
    } finally {
        if (client && type) {
            try {
                await closeRedisClient(client, type);
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

    let client, type;
    try {
        const redisConnection = await createRedisClient(userConfig);
        client = redisConnection.client;
        type = redisConnection.type;

        const redisKey = `trakt:${userConfig.traktUuid}`;
        const logPrefix = type === 'upstash' ? '[UPSTASH]' : '[REDIS]';
        console.log(`${logPrefix} Saving tokens to Redis key: ${redisKey}`);
        console.log(`${logPrefix} Tokens being saved:`, {
            hasAccessToken: !!tokens.accessToken,
            hasRefreshToken: !!tokens.refreshToken,
            expiresAt: tokens.expiresAt
        });
        
        await setToRedis(client, type, redisKey, tokens);
        console.log(`${logPrefix} Successfully saved tokens to Redis`);
        
        // Verify the save by reading back immediately
        const verification = await getFromRedis(client, type, redisKey);
        console.log(`${logPrefix} Verification read back:`, {
            hasAccessToken: !!verification?.accessToken,
            hasRefreshToken: !!verification?.refreshToken,
            expiresAt: verification?.expiresAt
        });
        
    } catch (error) {
        const logPrefix = type === 'upstash' ? 'Upstash' : 'Redis';
        console.error(`${logPrefix} Error: Failed to save Trakt tokens:`, error.message);
        throw error; // Re-throw to ensure calling code knows it failed
    } finally {
        if (client && type) {
            try {
                await closeRedisClient(client, type);
            } catch (err) {
                console.error('Error closing Redis client:', err.message);
            }
        }
    }
}

module.exports = { getTraktTokens, saveTraktTokens };