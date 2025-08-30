# Docker Deployment Guide

This guide covers various ways to deploy AIOLists using Docker.

## Quick Start with Docker Compose (Recommended)

The easiest way to get started is with Docker Compose, which sets up everything you need.

### Full Setup with Redis
```bash
# Download the docker-compose file
curl -O https://raw.githubusercontent.com/VoltStorm/AIOLists/main/docker-compose.yml

# Optional: Set up environment variables
curl -O https://raw.githubusercontent.com/VoltStorm/AIOLists/main/.env.docker-compose
cp .env.docker-compose .env
# Edit .env with your preferences

# Start the services
docker compose up -d

# Check the logs
docker compose logs -f aiolists
```

### Simple Setup (AIOLists only)
```bash
# Download the simple docker-compose file
curl -O https://raw.githubusercontent.com/VoltStorm/AIOLists/main/docker-compose.simple.yml
mv docker-compose.simple.yml docker-compose.yml

# Start the service
docker compose up -d
```

## Manual Docker Commands

### Using Pre-built Image
```bash
# Basic setup
docker run -d \
  --name aiolists \
  -p 7000:7000 \
  -e NODE_ENV=production \
  --restart unless-stopped \
  ghcr.io/voltstorm/aiolists:latest

# With environment variables
docker run -d \
  --name aiolists \
  -p 7000:7000 \
  -e NODE_ENV=production \
  -e TMDB_BEARER_TOKEN="your_token_here" \
  -e TMDB_REDIRECT_URI="https://your-domain.com/" \
  --restart unless-stopped \
  ghcr.io/voltstorm/aiolists:latest

# With Redis
docker network create aiolists-network

docker run -d \
  --name aiolists-redis \
  --network aiolists-network \
  -v aiolists-redis-data:/data \
  --restart unless-stopped \
  redis:7-alpine redis-server --appendonly yes

docker run -d \
  --name aiolists \
  --network aiolists-network \
  -p 7000:7000 \
  -e NODE_ENV=production \
  -e REDIS_HOST=aiolists-redis \
  --restart unless-stopped \
  ghcr.io/voltstorm/aiolists:latest
```

## Available Images

AIOLists images are automatically built and published to GitHub Container Registry:

- **Latest stable**: `ghcr.io/voltstorm/aiolists:latest`
- **Specific version**: `ghcr.io/voltstorm/aiolists:v1.2.7` (replace with actual version)
- **Commit-specific**: `ghcr.io/voltstorm/aiolists:sha-abc1234` (for specific commits)

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NODE_ENV` | Node.js environment | `production` | No |
| `PORT` | Application port | `7000` | No |
| `TMDB_BEARER_TOKEN` | TMDB API token | - | No |
| `TMDB_REDIRECT_URI` | TMDB OAuth redirect URI | - | No |
| `REDIS_HOST` | Redis hostname | - | No |
| `REDIS_PORT` | Redis port | `6379` | No |
| `REDIS_PASSWORD` | Redis password | - | No |
| `REDIS_DATABASE` | Redis database number | `0` | No |

## Data Persistence

### With Docker Compose
Data persistence is automatically handled with Docker volumes.

### Manual Setup
```bash
# Create a named volume for Redis data
docker volume create aiolists-redis-data

# Use the volume when running Redis
docker run -d \
  --name aiolists-redis \
  -v aiolists-redis-data:/data \
  redis:7-alpine redis-server --appendonly yes
```

## Networking

When using multiple containers, create a custom network:

```bash
# Create network
docker network create aiolists-network

# Run containers on the network
docker run --network aiolists-network ...
```

## Troubleshooting

### Check container logs
```bash
# Docker Compose
docker compose logs aiolists
docker compose logs redis

# Manual Docker
docker logs aiolists
docker logs aiolists-redis
```

### Check container status
```bash
# Docker Compose
docker compose ps

# Manual Docker
docker ps
```

### Restart services
```bash
# Docker Compose
docker compose restart aiolists

# Manual Docker
docker restart aiolists
```

### Update to latest version
```bash
# Docker Compose
docker compose pull
docker compose up -d

# Manual Docker
docker pull ghcr.io/voltstorm/aiolists:latest
docker stop aiolists
docker rm aiolists
# Run with new image...
```

## Building from Source

If you prefer to build the image yourself:

```bash
# Clone the repository
git clone https://github.com/VoltStorm/AIOLists.git
cd AIOLists

# Build the image
docker build -t aiolists-local .

# Run your local build
docker run -d \
  --name aiolists \
  -p 7000:7000 \
  -e NODE_ENV=production \
  --restart unless-stopped \
  aiolists-local
```

## Security Considerations

1. **Environment Variables**: Use Docker secrets or a `.env` file for sensitive data
2. **Network**: Consider using a reverse proxy (nginx, traefik) for HTTPS
3. **Updates**: Regularly update to the latest image for security patches
4. **Firewall**: Only expose necessary ports (7000 for AIOLists, optionally 6379 for Redis)

## Production Deployment

For production deployments, consider:

1. Using a reverse proxy with SSL termination
2. Setting up automatic backups for Redis data
3. Monitoring with tools like Prometheus/Grafana
4. Using container orchestration (Docker Swarm, Kubernetes)
5. Implementing log aggregation and monitoring