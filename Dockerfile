FROM apify/actor-node-puppeteer-chrome:20

# Set the working directory. The base image usually sets this to /actor.
WORKDIR /actor

# Copy package.json and package-lock.json (if it exists) first.
# This helps Docker cache the npm install step if dependencies don't change.
COPY package*.json ./

# Install actor dependencies using npm.
# The --omit=dev flag avoids installing development dependencies.
RUN npm install --omit=dev

# Copy the rest of your actor's source code into the working directory.
COPY . ./

# Explicitly set the command to run your actor's start script defined in package.json.
# This ensures your main.js is executed.
CMD ["npm", "start"]