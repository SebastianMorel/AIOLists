# Environment Variables Setup Guide

This guide explains how to configure AIOLists using environment variables for advanced setups.

## Quick Setup

Create a `.env` file in the root directory:

```bash
# TMDB Configuration  
TMDB_REDIRECT_URI=https://aiolists.elfhosted.com/
TMDB_BEARER_TOKEN=eyJhbGciOiJIUzI1NiJ9...

# Redis Configuration (optional - can be set via UI as well)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
REDIS_DATABASE=0
```

## Environment Variables Explained

### TMDB_REDIRECT_URI
- **Purpose**: Where users are redirected after TMDB authentication
- **Default**: None (manual process)
- **Required**: No
- **Example**: `https://aiolists.elfhosted.com/`

### TMDB_BEARER_TOKEN
- **Purpose**: Your TMDB Read Access Token
- **Default**: None (enter it in the UI)
- **Required**: No
- **Example**: `eyJhbGciOiJIUzI1NiJ9...`

### REDIS_HOST
- **Purpose**: Redis server hostname or IP address
- **Default**: None (enter it in the UI)
- **Required**: No
- **Example**: `localhost`, `redis.example.com`

### REDIS_PORT
- **Purpose**: Redis server port number
- **Default**: 6379
- **Required**: No
- **Example**: `6379`

### REDIS_PASSWORD
- **Purpose**: Redis server password for authentication
- **Default**: None (no password)
- **Required**: No
- **Example**: `your_redis_password`

### REDIS_DATABASE
- **Purpose**: Redis database number to use
- **Default**: 0
- **Required**: No
- **Example**: `0`, `1`, `2`

## Behavior Changes with Environment Variables

### When TMDB_BEARER_TOKEN is set:
- The TMDB Bearer Token field is hidden in the UI
- Users don't need to provide their own token
- TMDB features work automatically

### When redirect URIs are configured:
- "Connect to TMDB" button redirects directly to TMDB
- No manual code copying required

### When both TMDB_BEARER_TOKEN and redirect URIs are set:
- Fully automated OAuth flow
- Users get redirected back to your app after authentication

### When Redis environment variables are set:
- Individual Redis configuration fields are hidden in the UI when the corresponding environment variable is set
- Helper text is displayed indicating that Redis configuration is using environment variables
- Users don't need to manually enter Redis credentials for fields with environment variables
- Redis configuration is automatically available on startup

## Getting Your Tokens

### TMDB Bearer Token
1. Go to https://www.themoviedb.org/settings/api
2. Create an API key if you don't have one
3. Copy the "Read Access Token" (starts with `eyJ`)

## Production Deployment

For production deployments, set these environment variables in your hosting platform:

**Heroku:**
```bash
heroku config:set TMDB_BEARER_TOKEN=your_token_here
heroku config:set TMDB_REDIRECT_URI=https://yourapp.herokuapp.com/
heroku config:set REDIS_HOST=your_redis_host
heroku config:set REDIS_PASSWORD=your_redis_password
```

**Docker:**
```bash
docker run -e TMDB_BEARER_TOKEN=your_token_here -e TMDB_REDIRECT_URI=https://yourapp.com/ -e REDIS_HOST=redis_host -e REDIS_PASSWORD=redis_password aiolists
```

**Railway/Render:**
Add environment variables in your platform's dashboard.

## Security Notes

- Never commit `.env` files to version control
- Use secure HTTPS URLs for redirect URIs in production
- Keep your bearer tokens private
- Rotate tokens periodically for security