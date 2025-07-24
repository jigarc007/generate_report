const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Starting Chrome installation check...');

const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
console.log('Cache directory:', cacheDir);

// Function to find Chrome executable
function findChrome() {
  try {
    if (!fs.existsSync(cacheDir)) {
      console.log('Cache directory does not exist');
      return null;
    }

    const chromeDir = path.join(cacheDir, 'chrome');
    if (!fs.existsSync(chromeDir)) {
      console.log('Chrome directory does not exist');
      return null;
    }

    const versions = fs.readdirSync(chromeDir);
    console.log('Available Chrome versions:', versions);

    for (const version of versions) {
      const versionDir = path.join(chromeDir, version);
      const possiblePaths = [
        path.join(versionDir, 'chrome-linux64', 'chrome'),
        path.join(versionDir, 'chrome-linux', 'chrome'),
        path.join(versionDir, 'chrome')
      ];

      for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
          console.log('Found Chrome at:', chromePath);
          return chromePath;
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding Chrome:', error);
    return null;
  }
}

// Check if Chrome exists
let chromePath = findChrome();

if (!chromePath) {
  console.log('Chrome not found, installing...');
  try {
    // Install Chrome
    execSync('npx puppeteer browsers install chrome --platform=linux', {
      stdio: 'inherit',
      timeout: 180000 // 3 minutes
    });

    // Check again after installation
    chromePath = findChrome();
    
    if (chromePath) {
      console.log('Chrome successfully installed at:', chromePath);
      // Set environment variable for the main app
      process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
    } else {
      console.error('Chrome installation failed - executable not found');
    }
  } catch (error) {
    console.error('Failed to install Chrome:', error);
  }
} else {
  console.log('Chrome already available at:', chromePath);
  process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
}

// Start the main server
console.log('Starting main server...');
require('./server.js');