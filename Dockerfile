FROM apify/actor-node-puppeteer-chrome:20

# The base image typically sets WORKDIR /actor and USER myuser.
# However, if /actor was created by root in the base image's layers,
# myuser might not have write permissions. Let's ensure it.

USER root
RUN chown -R myuser:myuser /actor
USER myuser

# Now, myuser owns /actor and we are running as myuser in /actor.

# Copy package.json and package-lock.json (if it exists) first for caching.
COPY package*.json ./

# Install actor dependencies. This should now work.
RUN npm install --omit=dev

# Copy the rest of your actor's source code.
COPY . ./

# Set the command to run your actor.
CMD ["npm", "start"]