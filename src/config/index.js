// src/config/index.js
const ITEMS_PER_PAGE = 100;
const PORT = process.env.PORT || 7000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TRAKT_CLIENT_ID = '490414ec03fe9a33b2d0c16d58261ebbbd9cf0eee23f213fa0e3eb1d6126d05c';

const staticGenres = [
  "Action", "Adventure", "Animation", "Anime", "Biography", "Comedy", "Crime",
  "Documentary", "Drama", "Family", "Fantasy", "History", "Horror",
  "Music", "Musical", "Mystery", "Romance", "Sci-Fi", "Short", "Sport",
  "Thriller", "War", "Western", "Game-Show"
];

const defaultConfig = {
  apiKey: '',
  rpdbApiKey: '',
  traktAccessToken: '',
  traktRefreshToken: '',
  traktExpiresAt: null,
  listOrder: [],
  lastUpdated: null,
  listsMetadata: {},
  hiddenLists: [],
  removedLists: [],
  customListNames: {},
  mergedLists: {},
  importedAddons: {},
  sortPreferences: {},
  connectedProfiles: [],
  disableGenreFilter: false,
  enableRandomListFeature: false,
  randomMDBListUsernames: ['showtime416', 'garycrawfordgc', 'linaspurinis', 'hdlists'], 
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
    { value: 'votes', label: 'Trakt Votes' },
    { value: 'my_rating', label: 'My Trakt Rating' },
  ]
};

module.exports = {
  defaultConfig,
  ITEMS_PER_PAGE,
  TRAKT_CLIENT_ID,
  PORT,
  IS_PRODUCTION,
  staticGenres
};