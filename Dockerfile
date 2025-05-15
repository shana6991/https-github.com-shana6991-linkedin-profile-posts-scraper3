FROM apify/actor-node-puppeteer-chrome:20

# Explicitly set WORKDIR first, although base image should do this.
WORKDIR /actor

# Switch to root to ensure directory exists and change ownership.
USER root

# Ensure the /actor directory exists, then change its ownership.
# The -p flag creates parent directories if needed and doesn't error if /actor already exists.
RUN mkdir -p /actor && chown -R myuser:myuser /actor

# Switch back to myuser. Now myuser owns /actor and is the current user in /actor.
USER myuser

# Copy package.json and package-lock.json (if it exists) first for caching.
COPY package*.json ./

# Install actor dependencies.
RUN npm install --omit=dev

# Copy the rest of your actor's source code.
COPY . ./

# Set the command to run your actor.
CMD ["npm", "start"]