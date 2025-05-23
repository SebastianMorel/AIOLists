// Main entry point for the application
const express = require('express');
const cors = require('cors');
const path = require('path');

// Load modules
const Cache = require('./cache');
const { defaultConfig } = require('./config');
const { createAddon } = require('./addon');
const setupApiRoutes = require('./routes/api');
const setupAddonRoutes = require('./routes/addon');

// Constants
const PORT = process.env.PORT || 7000;
const isProduction = process.env.NODE_ENV === 'production';

// Initialize application
async function initializeApp() {
  try {
    // Initialize Express app
    const app = express();
    
    // Add root URL redirect before any other middleware
    app.get('/', (req, res) => {
      return res.status(301).redirect('/configure');
    });
    
    // Configure middleware
    app.use((req, res, next) => {
      // Only apply no-cache to configuration/admin routes
      if (req.path.includes('/configure') || req.path.includes('/config/') || req.path.includes('/api/')) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.header('Pragma', 'no-cache');
        res.header('Expires', '0');
      }
      next();
    });
    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '..', 'public')));
    
    // Initialize with default configuration
    const userConfig = { ...defaultConfig };
    
    // Initialize cache
    const cache = new Cache();
    
    // Create addon
    const addonInterface = await createAddon(userConfig, cache);
    
    // Setup routes
    setupApiRoutes(app, userConfig, cache, addonInterface);
    setupAddonRoutes(app, userConfig, cache, addonInterface);
    
    // Start server
    app.listen(PORT, () => {
      if (!isProduction) {
        console.log(`AIOLists Stremio Addon running on port ${PORT}`);
        console.log(`Addon URL: http://localhost:${PORT}/manifest.json`);
        console.log(`Admin panel: http://localhost:${PORT}/configure`);
      }
    });
    
    return app;
  } catch (err) {
    if (!isProduction) {
      console.error("Failed to initialize application:", err);
    }
    throw err;
  }
}

// Export function for testing, or run if this is the main module
if (require.main === module) {
  initializeApp().catch(err => {
    console.error('Application failed to start:', err);
    process.exit(1);
  });
} else {
  module.exports = { initializeApp };
} 