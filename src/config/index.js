// src/config/index.js
const ITEMS_PER_PAGE = 20;
const PORT = process.env.PORT || 7000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Performance optimization constants
const METADATA_BATCH_SIZE = 20; // Increased from default 10
const POSTER_BATCH_SIZE = 20; // Increased from default 25
const TRAKT_CONCURRENT_REQUESTS = 8; // Increased concurrency
const TMDB_CONCURRENT_REQUESTS = 20; // Increased concurrency for better performance
const MDB_LIST_CONCURRENT_REQUESTS = 5; // New batch setting
const MANIFEST_GENERATION_CONCURRENCY = 5; // Parallel list processing during manifest generation
const ENABLE_MANIFEST_CACHE = true; // Cache manifest to avoid repeated processing

// Environment variable configuration with defaults
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c';
const TRAKT_REDIRECT_URI = process.env.TRAKT_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';
const TMDB_REDIRECT_URI = process.env.TMDB_REDIRECT_URI || '';
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || '';
const CUSTOM_HTML_BLURB = process.env.CUSTOM_HTML_BLURB || '';

// Redis configuration from environment variables
const REDIS_HOST = process.env.REDIS_HOST || '';
const REDIS_PORT = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
const REDIS_DATABASE = process.env.REDIS_DATABASE ? parseInt(process.env.REDIS_DATABASE) : 0;

const staticGenres = [
  "All","Action", "Adventure", "Animation", "Anime", "Biography", "Comedy", "Crime",
  "Documentary", "Drama", "Family", "Fantasy", "History", "Horror",
  "Music", "Musical", "Mystery", "Romance", "Sci-Fi", "Short", "Sport",
  "Thriller", "War", "Western", "Game-Show"
];

const defaultConfig = {
  apiKey: '',
  rpdbApiKey: '',
  tmdbBearerToken: TMDB_BEARER_TOKEN, // Use env var if set
  tmdbSessionId: '',
  tmdbAccountId: '',
  tmdbUsername: '',
  metadataSource: 'cinemeta',
  tmdbLanguage: '',
  traktAccessToken: '',
  traktRefreshToken: '',
  traktExpiresAt: null,
  traktUsername: '',
  traktUuid: '',
  // Redis configuration (use env vars as defaults)
  redisHost: REDIS_HOST,
  redisPort: REDIS_PORT,
  redisPassword: REDIS_PASSWORD,
  redisDatabase: REDIS_DATABASE,
  // Upstash Redis configuration
  upstashUrl: '',
  upstashToken: '',
  listOrder: [],
  lastUpdated: null,
  listsMetadata: {},
  hiddenLists: [],
  removedLists: [],
  customListNames: {},
  mergedLists: {},
  customMediaTypeNames: {},
  importedAddons: {},
  sortPreferences: {},
  disableGenreFilter: false,
  enableRandomListFeature: false,
  randomMDBListUsernames: ['showtime416', 'garycrawfordgc', 'linaspurinis', 'hdlists'],
  searchSources: ['cinemeta'], // Traditional movie/series search sources
  mergedSearchSources: ['tmdb'], // New merged search sources - enabled by default with TMDB
  animeSearchEnabled: true, // Enable anime search - enabled by default 
  availableSortOptions: [
    { value: 'default', label: 'Default' },
    { value: 'rank', label: 'Rank' },
    { value: 'score', label: 'Score' },
    { value: 'score_average', label: 'Average Score' },
    { value: 'released', label: 'Release Date' },
    { value: 'releasedigital', label: 'Digital Release' },
    { value: 'imdbrating', label: 'IMDb Rating' },
    { value: 'imdbvotes', label: 'IMDb Votes' },
    { value: 'last_air_date', label: 'Last Air Date' },
    { value: 'imdbpopular', label: 'IMDb Popularity' },
    { value: 'tmdbpopular', label: 'TMDB Popularity' },
    { value: 'rogerebert', label: 'Roger Ebert Rating' },
    { value: 'rtomatoes', label: 'Rotten Tomatoes' },
    { value: 'rtaudience', label: 'RT Audience Score' },
    { value: 'metacritic', label: 'Metacritic' },
    { value: 'myanimelist', label: 'MyAnimeList' },
    { value: 'letterrating', label: 'Letterboxd Rating' },
    { value: 'lettervotes', label: 'Letterboxd Votes' },
    { value: 'budget', label: 'Budget' },
    { value: 'revenue', label: 'Revenue' },
    { value: 'runtime', label: 'Runtime' },
    { value: 'title', label: 'Title' },
    { value: 'random', label: 'Random' }
  ],
  traktSortOptions: [
    { value: 'rank', label: 'Trakt Rank' },
    { value: 'added', label: 'Date Added' },
    { value: 'title', label: 'Title' },
    { value: 'released', label: 'Release Date' },
    { value: 'runtime', label: 'Runtime' },
    { value: 'popularity', label: 'Trakt Popularity' },
    { value: 'random', label: 'Random' },
    { value: 'percentage', label: 'Percentage Watched' },
    { value: 'my_rating', label: 'My Trakt Rating' },
    { value: 'watched ', label: 'Watched' },
    { value: 'collected', label: 'Collected' },
  ]
};

module.exports = {
  defaultConfig,
  ITEMS_PER_PAGE,
  TRAKT_CLIENT_ID,
  TRAKT_REDIRECT_URI,
  TMDB_REDIRECT_URI,
  TMDB_BEARER_TOKEN,
  CUSTOM_HTML_BLURB,
  // Redis environment variables
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_DATABASE,
  PORT,
  IS_PRODUCTION,
  staticGenres,
  // Performance constants
  METADATA_BATCH_SIZE,
  POSTER_BATCH_SIZE,
  TRAKT_CONCURRENT_REQUESTS,
  TMDB_CONCURRENT_REQUESTS,
  MDB_LIST_CONCURRENT_REQUESTS,
  MANIFEST_GENERATION_CONCURRENCY,
  ENABLE_MANIFEST_CACHE
};
