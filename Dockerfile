# Use a Node.js base image with a specific version
FROM node:18-slim

# Set working directory
WORKDIR /app

# Install necessary packages for Puppeteer and for adding GPG keys
# Revised list of dependencies for modern Debian (Bookworm)
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libu2f-udev \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxtst6 \
    xdg-utils \
    lsb-release \
    # Ensure all recommended fonts are available
    # These are often critical for PDF generation with varying characters
    fontconfig \
    libfontconfig1 \
    ttf-dejavu \
    # Optional but sometimes helpful for certain rendering
    libevent-2.1-7 \
    libharfbuzz0b \
    libjpeg62-turbo \
    libwebp6 \
    libpng16-16 \
    # Clean up apt cache to keep image size down
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Add Google Chrome repository and install Google Chrome Stable using new method
# This method is more robust for GPG key management
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list > /dev/null \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3001

# Command to run your application
CMD ["node", "server.js"]